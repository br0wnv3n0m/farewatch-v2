"""Watch runner for GitHub Actions (replaces v1 hourly/runner.py).

  python -m farewatch_engine.runner --due      write due=true|false to $GITHUB_OUTPUT (stdlib only)
  python -m farewatch_engine.runner            lease watches from the server, search, report
  python -m farewatch_engine.runner --probe job.json [--output out.json]   local test, no server

Env: FAREWATCH_URL (https origin of the v2 server), FAREWATCH_RUNNER_TOKEN (32+ chars).

The server leases one watch at a time and sends only search rules and dates.
Logs are public on a public repo: never print routes, dates, prices or tokens.
Every price is checked again on the server before it is stored.
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

MAX_JOBS_PER_RUN = 10           # one job per watch; server holds at most 10 watches
MAX_CONSECUTIVE_ERRORS = 3      # same rule as lookup


class RunnerError(RuntimeError):
    pass


def server_settings():
    base = os.environ.get('FAREWATCH_URL', '').strip().rstrip('/')
    token = os.environ.get('FAREWATCH_RUNNER_TOKEN', '').strip()
    url = urllib.parse.urlparse(base)
    if url.scheme != 'https' or not url.netloc or url.username or url.password or url.path or url.query or url.fragment:
        raise RunnerError('Set the FAREWATCH_URL secret to the server origin, like https://farewatch-v2.NAME.workers.dev')
    if len(token) < 32:
        raise RunnerError('Set the FAREWATCH_RUNNER_TOKEN secret (32+ characters, same as the server RUNNER_TOKEN).')
    return base, token


def api(base, token, path, payload):
    """POST JSON to /api/runner/<path>. Raises RunnerError with a safe message."""
    request = urllib.request.Request(
        f'{base}/api/runner/{path}', data=json.dumps(payload).encode(), method='POST',
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
                 'Accept': 'application/json', 'User-Agent': 'FarewatchRunner/2.0'})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        raw = exc.read(20000).decode('utf-8', errors='replace')
        try:
            reason = json.loads(raw).get('error', 'Request rejected.')
        except ValueError:
            match = re.search(r'error\s*(?:code\s*[:=]?\s*)?(1\d{3})', raw, re.I)
            reason = 'Rejected before reaching the server.' + (f' Cloudflare error {match[1]}.' if match else '')
        raise RunnerError(f'Server returned HTTP {exc.code}: {reason}') from None
    except (urllib.error.URLError, ValueError, TimeoutError):
        raise RunnerError('Could not reach the Farewatch server.') from None


def process_job(job, client):
    """Search every leased date pair in order. Returns the report body.

    Stops early on a block (HTTP error / consent page) or 3 failures in a row;
    the server accepts a report for the first N leased pairs.
    """
    from .errors import Blocked, ScraperError
    from .lookup import search_cell

    config = {**job['config'],
              'blockedCountries': set(job['config'].get('blockedCountries') or []),
              'airlines': set(job['config'].get('airlines') or [])}
    cells, errors, in_row, fatal = [], 0, 0, None
    for pair in job['pairs']:
        base = {'out': pair['out'], 'back': pair['back']}
        try:
            options = search_cell(client, config, pair)
            cells.append({**base, 'status': 'ok' if options else 'none', 'options': options})
            in_row = 0
            continue
        except Blocked as exc:
            message, stop = str(exc), True
        except ScraperError as exc:
            message, stop = str(exc), False
        except Exception:
            message, stop = 'Unexpected flight response. No uncertain prices were accepted.', False
        errors += 1
        in_row += 1
        cells.append({**base, 'status': 'error', 'options': [], 'message': message})
        print('Search failed: ' + message, file=sys.stderr)
        if stop:
            fatal = message
            break
        if in_row >= MAX_CONSECUTIVE_ERRORS:
            fatal = f'{in_row} searches failed in a row; stopped to avoid being blocked.'
            break
    return {'runId': job.get('runId'), 'cells': cells, 'errorCount': errors, 'fatal': fatal}


def commit_time():
    """Unix seconds of the checked-out commit (FAREWATCH_COMMIT_AT, set by the workflow), or None.

    The server uses it to warn before GitHub pauses the schedule (60 days without commits)."""
    try:
        value = int(os.environ.get('FAREWATCH_COMMIT_AT', ''))
    except ValueError:
        return None
    return value if value > 0 else None


def run_due():
    base, token = server_settings()
    payload = {}
    commit_at = commit_time()
    if commit_at:
        payload['commitAt'] = commit_at
    due = bool(api(base, token, 'due', payload).get('due'))
    out = os.environ.get('GITHUB_OUTPUT')
    if out:
        with open(out, 'a', encoding='utf-8') as fh:
            fh.write(f'due={str(due).lower()}\n')
    print('A watch is due.' if due else 'No watch is due; skipping the search job.')
    return 0


def run_server(client_factory):
    base, token = server_settings()
    excluded, failed, client = [], False, None
    for _ in range(MAX_JOBS_PER_RUN):
        job = api(base, token, 'job', {'exclude': excluded})
        if job.get('skip'):
            print(job['skip'])
            break
        client = client or client_factory()
        report = process_job(job, client)
        print(api(base, token, 'report', report).get('message', 'Reported.'))
        failed = failed or report['errorCount'] > 0
        excluded.append(job['watchId'])
        if report['fatal']:
            print('Stopping this run early: ' + report['fatal'], file=sys.stderr)
            break
    return 1 if failed else 0


def default_client():
    from .lookup import GoogleLookupClient
    return GoogleLookupClient()


def main(argv=None, client_factory=default_client):
    parser = argparse.ArgumentParser(prog='farewatch_engine.runner')
    parser.add_argument('--due', action='store_true', help='Only ask the server whether a watch is due.')
    parser.add_argument('--probe', help='Local job JSON {config, pairs}; does not contact the server.')
    parser.add_argument('--output', help='Where to save probe results.')
    args = parser.parse_args(argv)
    try:
        if args.due:
            return run_due()
        if args.probe:
            report = process_job(json.loads(Path(args.probe).read_text(encoding='utf-8')), client_factory())
            if args.output:
                Path(args.output).write_text(json.dumps(report, indent=2), encoding='utf-8')
            print(f"Probe: {len(report['cells'])} cells, {report['errorCount']} failed.")
            return 1 if report['errorCount'] else 0
        return run_server(client_factory)
    except RunnerError as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
