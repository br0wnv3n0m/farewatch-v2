"""Offline runner tests: fake server and fake flight client, no network."""
import io
import os
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

from farewatch_engine import runner
from farewatch_engine.errors import Blocked, ScraperError
from tests.test_engine import FakeClient

JOB = {
    'runId': 'job-1', 'watchId': 7,
    'config': {'origin': 'YVR', 'destination': 'DEL', 'currency': 'CAD', 'adults': 1, 'children': 0, 'cabin': 1,
               'maxStops': 1, 'maxLayover': 360, 'maxOutboundTries': 2, 'blockedCountries': ['US'], 'airlines': []},
    'pairs': [{'out': '2026-12-20', 'back': '2027-01-05'}, {'out': '2026-12-21', 'back': '2027-01-05'},
              {'out': '2026-12-22', 'back': '2027-01-05'}, {'out': '2026-12-23', 'back': '2027-01-05'}],
}
GOOD = FakeClient([(400, ('YVR', 'SEA', 'DEL')), (700, ('YVR', 'LHR', 'DEL'))], {700: [(1100, ('DEL', 'FRA', 'YVR'))]})


def quiet(fn, *args):
    with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
        return fn(*args)


class ProcessJob(unittest.TestCase):
    def test_all_pairs_searched_and_us_layover_removed(self):
        report = quiet(runner.process_job, JOB, GOOD)
        self.assertEqual(report['runId'], 'job-1')
        self.assertEqual([c['status'] for c in report['cells']], ['ok'] * 4)
        self.assertEqual(report['cells'][0]['options'][0]['price'], 1100)
        self.assertEqual(report['cells'][0]['options'][0]['out']['flights'][0]['arrival_airport']['id'], 'LHR')
        self.assertIsNone(report['fatal'])

    def test_block_stops_at_once(self):
        report = quiet(runner.process_job, JOB, FakeClient([], {}, fail=Blocked('HTTP 429')))
        self.assertEqual(len(report['cells']), 1)
        self.assertEqual(report['cells'][0]['status'], 'error')
        self.assertIn('429', report['fatal'])

    def test_three_errors_in_a_row_stop(self):
        report = quiet(runner.process_job, JOB, FakeClient([], {}, fail=ScraperError('format changed')))
        self.assertEqual(len(report['cells']), 3)
        self.assertEqual(report['errorCount'], 3)
        self.assertIn('in a row', report['fatal'])


class FakeServer:
    def __init__(self, jobs):
        self.jobs, self.calls = list(jobs), []

    def __call__(self, base, token, path, payload):
        self.calls.append((path, payload))
        if path == 'job':
            return self.jobs.pop(0) if self.jobs else {'skip': 'No watch is due right now.'}
        if path == 'report':
            return {'message': 'stored'}
        if path == 'due':
            return {'due': True}
        raise AssertionError(path)


ENV = {'FAREWATCH_URL': 'https://fw.example.workers.dev', 'FAREWATCH_RUNNER_TOKEN': 't' * 40}


class RunServer(unittest.TestCase):
    def test_leases_until_skip_and_excludes_done_watches(self):
        server = FakeServer([JOB, {**JOB, 'runId': 'job-2', 'watchId': 8}])
        with mock.patch.dict(os.environ, ENV), mock.patch.object(runner, 'api', server):
            code = quiet(runner.run_server, lambda: GOOD)
        self.assertEqual(code, 0)
        self.assertEqual([p for p, _ in server.calls], ['job', 'report', 'job', 'report', 'job'])
        self.assertEqual(server.calls[-1][1], {'exclude': [7, 8]})

    def test_block_ends_the_whole_run(self):
        server = FakeServer([JOB, {**JOB, 'watchId': 8}])
        with mock.patch.dict(os.environ, ENV), mock.patch.object(runner, 'api', server):
            code = quiet(runner.run_server, lambda: FakeClient([], {}, fail=Blocked('HTTP 429')))
        self.assertEqual(code, 1)
        self.assertEqual([p for p, _ in server.calls], ['job', 'report'])

    def test_bad_settings_are_refused(self):
        with mock.patch.dict(os.environ, {'FAREWATCH_URL': 'http://plain.example', 'FAREWATCH_RUNNER_TOKEN': 't' * 40}):
            self.assertEqual(quiet(runner.main, []), 1)
        with mock.patch.dict(os.environ, {**ENV, 'FAREWATCH_RUNNER_TOKEN': 'short'}):
            self.assertEqual(quiet(runner.main, []), 1)

    def test_due_writes_github_output(self):
        import tempfile
        with tempfile.NamedTemporaryFile('r', suffix='.txt', delete=False) as fh:
            path = fh.name
        with mock.patch.dict(os.environ, {**ENV, 'GITHUB_OUTPUT': path}), mock.patch.object(runner, 'api', FakeServer([])):
            self.assertEqual(quiet(runner.main, ['--due']), 0)
        with open(path, encoding='utf-8') as fh:
            self.assertEqual(fh.read(), 'due=true\n')
        os.unlink(path)


if __name__ == '__main__':
    unittest.main()
