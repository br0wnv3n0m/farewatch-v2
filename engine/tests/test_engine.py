"""Offline tests: no network, no scraper libraries needed."""
import unittest
from datetime import date

from farewatch_engine.airports import country_of
from farewatch_engine.errors import Blocked, ScraperError
from farewatch_engine.filters import acceptable, blocked_stop
from farewatch_engine.lookup import MAX_LOOKUP_COMBOS, RequestError, run_lookup, validate

TODAY = date(2026, 11, 16)


def flight(a, b, day, number='AC1'):
    return {'departure_airport': {'id': a, 'time': f'{day} 08:00'},
            'arrival_airport': {'id': b, 'time': f'{day} 12:00'},
            'flight_number': number, 'airline': number[:2]}


def leg(price, *airports, day='2026-12-20', number='AC1', layover=90):
    flights = [flight(airports[i], airports[i + 1], day, number) for i in range(len(airports) - 1)]
    return {'price': price, 'flights': flights,
            'layovers': [{'id': a, 'duration': layover} for a in airports[1:-1]]}


RULES = {'maxStops': 2, 'maxLayover': 360, 'blockedCountries': {'US'}, 'airlines': set()}


class Airports(unittest.TestCase):
    def test_known_codes(self):
        self.assertEqual(country_of('YVR'), 'CA')
        self.assertEqual(country_of('sea'), 'US')
        self.assertIsNone(country_of('QQQ'))


class Filters(unittest.TestCase):
    def test_blocks_us_layover(self):
        self.assertFalse(acceptable(leg(500, 'YVR', 'SEA', 'DEL'), RULES, 'YVR', 'DEL', '2026-12-20'))

    def test_allows_non_blocked_layover(self):
        self.assertTrue(acceptable(leg(500, 'YVR', 'LHR', 'DEL'), RULES, 'YVR', 'DEL', '2026-12-20'))

    def test_direct_flight_ok_even_to_blocked_country(self):
        self.assertTrue(acceptable(leg(300, 'YVR', 'SEA'), RULES, 'YVR', 'SEA', '2026-12-20'))

    def test_unknown_layover_fails_closed(self):
        self.assertIn('unknown', blocked_stop(leg(1, 'YVR', 'QQQ', 'DEL'), {'US'}))

    def test_unknown_layover_ok_when_no_block_list(self):
        self.assertIsNone(blocked_stop(leg(1, 'YVR', 'QQQ', 'DEL'), set()))

    def test_airline_filter(self):
        rules = {**RULES, 'airlines': {'AC'}}
        self.assertTrue(acceptable(leg(1, 'YVR', 'LHR', 'DEL', number='AC5'), rules, 'YVR', 'DEL', '2026-12-20'))
        self.assertFalse(acceptable(leg(1, 'YVR', 'LHR', 'DEL', number='BA5'), rules, 'YVR', 'DEL', '2026-12-20'))

    def test_layover_limit_and_stops(self):
        self.assertFalse(acceptable(leg(1, 'YVR', 'LHR', 'DEL', layover=400), RULES, 'YVR', 'DEL', '2026-12-20'))
        self.assertFalse(acceptable(leg(1, 'YVR', 'LHR', 'DEL'), {**RULES, 'maxStops': 0}, 'YVR', 'DEL', '2026-12-20'))


def request(**kw):
    base = {'origin': 'YVR', 'destination': 'DEL', 'outDates': {'from': '2026-12-20', 'to': '2026-12-22'},
            'backDates': {'from': '2027-01-05', 'to': '2027-01-07'}, 'blockedCountries': ['US']}
    base.update(kw)
    return base


class Validate(unittest.TestCase):
    def test_grid_size(self):
        _, combos = validate(request(), TODAY)
        self.assertEqual(len(combos), 9)

    def test_return_before_leave_is_dropped(self):
        _, combos = validate(request(backDates={'from': '2026-12-20', 'to': '2026-12-21'}), TODAY)
        self.assertEqual(len(combos), 3)  # (20,20) (20,21) (21,21)

    def test_one_way(self):
        _, combos = validate(request(backDates=None), TODAY)
        self.assertEqual([c['back'] for c in combos], [None] * 3)

    def test_limits(self):
        bad = [request(origin='YV'), request(destination='YVR'), request(adults=7), request(cabin=5),
               request(maxStops=3), request(maxLayover=20), request(blockedCountries=['USA']),
               request(outDates={'from': '2026-11-01', 'to': '2026-11-02'}),
               request(outDates={'from': '2026-12-01', 'to': '2026-12-08'},
                       backDates={'from': '2027-01-01', 'to': '2027-01-08'})]  # 64 combos
        for r in bad:
            with self.assertRaises(RequestError):
                validate(r, TODAY)
        self.assertEqual(MAX_LOOKUP_COMBOS, 49)


class FakeClient:
    def __init__(self, outbound, returns, fail=None):
        self.outbound, self.returns, self.fail, self.return_calls = outbound, returns, fail, 0

    def search_options(self, config, pair):
        if self.fail:
            raise self.fail
        return [leg(p, *a, day=pair['out']) for p, a in self.outbound]

    def return_options(self, config, pair, outbound):
        self.return_calls += 1
        return [leg(p, *a, day=pair['back']) for p, a in self.returns.get(outbound['price'], [])]


def collect(req, client):
    events = []
    code = run_lookup(req, events.append, client=client, today=TODAY)
    return code, events


class Lookup(unittest.TestCase):
    def one_combo(self, **kw):
        return request(outDates={'from': '2026-12-20', 'to': '2026-12-20'},
                       backDates={'from': '2027-01-05', 'to': '2027-01-05'}, **kw)

    def test_cheapest_is_picked_after_filter(self):
        # Cheapest outbound goes via SEA (blocked) -> must use LHR one.
        client = FakeClient([(400, ('YVR', 'SEA', 'DEL')), (700, ('YVR', 'LHR', 'DEL'))],
                            {700: [(900, ('DEL', 'JFK', 'YVR')), (1100, ('DEL', 'FRA', 'YVR'))]})
        code, events = collect(self.one_combo(), client)
        cell = [e for e in events if e['type'] == 'cell'][0]
        self.assertEqual(code, 0)
        self.assertEqual(cell['status'], 'ok')
        self.assertEqual(cell['options'][0]['price'], 1100)  # JFK return was removed
        self.assertEqual(cell['options'][0]['out']['price'], 700)

    def test_tries_next_outbound_when_no_allowed_return(self):
        client = FakeClient([(600, ('YVR', 'LHR', 'DEL')), (650, ('YVR', 'FRA', 'DEL'))],
                            {600: [(800, ('DEL', 'ORD', 'YVR'))], 650: [(950, ('DEL', 'LHR', 'YVR'))]})
        _, events = collect(self.one_combo(), client)
        cell = [e for e in events if e['type'] == 'cell'][0]
        self.assertEqual(cell['options'][0]['price'], 950)
        self.assertEqual(client.return_calls, 2)

    def test_blocked_stops_run(self):
        code, events = collect(request(), FakeClient([], {}, fail=Blocked('HTTP 429')))
        self.assertEqual(code, 1)
        self.assertEqual(events[-1]['type'], 'fatal')
        self.assertEqual(len([e for e in events if e['type'] == 'cell']), 1)

    def test_repeated_errors_stop_run(self):
        code, events = collect(request(), FakeClient([], {}, fail=ScraperError('format changed')))
        self.assertEqual(code, 1)
        self.assertEqual(len([e for e in events if e['type'] == 'cell']), 3)

    def test_bad_request_is_fatal_without_search(self):
        code, events = collect(request(origin='X'), FakeClient([], {}))
        self.assertEqual((code, events[0]['type']), (2, 'fatal'))


if __name__ == '__main__':
    unittest.main()
