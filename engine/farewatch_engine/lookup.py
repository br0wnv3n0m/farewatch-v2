"""Date-range lookup: price every leave/return combo and stream each cell.

Events (one JSON object per line on stdout, see cli.py):
  {"type":"start","total":N,"combos":[{"out":..,"back":..}]}
  {"type":"cell","out":..,"back":..,"status":"ok"|"none"|"error","options":[..],"message":..}
  {"type":"fatal","message":..}   run stopped (blocked, unreachable, too many errors)
  {"type":"done","checked":N}
"""
import re
from datetime import date, timedelta

MAX_LOOKUP_COMBOS = 49          # 7 x 7; about 8 minutes at 5 s between requests
MAX_WINDOW_DAYS = 61            # same as v1 watches
MAX_OPTIONS_PER_CELL = 10       # UI applies the airline filter locally on these
MAX_CONSECUTIVE_ERRORS = 3


class RequestError(ValueError):
    pass


def _int(req, key, lo, hi, default=None):
    value = req.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
        raise RequestError(f'{key} must be a whole number from {lo} to {hi}.')
    return value


def _date(value, key):
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError):
        raise RequestError(f'{key} must be a date like 2026-12-20.') from None


def _window(req, key):
    w = req.get(key)
    if not isinstance(w, dict):
        raise RequestError(f'{key} must have "from" and "to" dates.')
    start, end = _date(w.get('from'), key + '.from'), _date(w.get('to'), key + '.to')
    if end < start:
        raise RequestError(f'{key}: "to" is before "from".')
    if (end - start).days + 1 > MAX_WINDOW_DAYS:
        raise RequestError(f'{key} can cover at most {MAX_WINDOW_DAYS} days.')
    return start, end


def _codes(req, key, pattern, limit):
    values = req.get(key) or []
    if not isinstance(values, list) or len(values) > limit:
        raise RequestError(f'{key} must be a list of at most {limit} codes.')
    out = set()
    for v in values:
        if not isinstance(v, str) or not re.fullmatch(pattern, v.strip().upper()):
            raise RequestError(f'{key} has an invalid code: {v!r}.')
        out.add(v.strip().upper())
    return out


def validate(req, today=None):
    """Check a lookup request. Returns (config, combos). Raises RequestError."""
    if not isinstance(req, dict):
        raise RequestError('Request must be a JSON object.')
    today = today or date.today()
    origin = str(req.get('origin', '')).strip().upper()
    destination = str(req.get('destination', '')).strip().upper()
    if not re.fullmatch(r'[A-Z]{3}', origin) or not re.fullmatch(r'[A-Z]{3}', destination):
        raise RequestError('origin and destination must be 3-letter airport codes.')
    if origin == destination:
        raise RequestError('origin and destination must differ.')
    currency = str(req.get('currency', 'CAD')).strip().upper()
    if not re.fullmatch(r'[A-Z]{3}', currency):
        raise RequestError('currency must be a 3-letter code.')
    adults = _int(req, 'adults', 1, 6, 1)
    children = _int(req, 'children', 0, 5, 0)
    if adults + children > 6:
        raise RequestError('At most 6 travellers.')
    config = {
        'origin': origin, 'destination': destination, 'currency': currency,
        'adults': adults, 'children': children,
        'cabin': _int(req, 'cabin', 1, 4, 1),
        'maxStops': _int(req, 'maxStops', 0, 2, 1),
        'maxLayover': _int(req, 'maxLayover', 30, 1440, 360),
        'maxOutboundTries': _int(req, 'maxOutboundTries', 1, 3, 2),
        'blockedCountries': _codes(req, 'blockedCountries', r'[A-Z]{2}', 60),
        'airlines': _codes(req, 'airlines', r'[A-Z0-9]{2}', 20),
    }
    out_start, out_end = _window(req, 'outDates')
    if out_start < today:
        raise RequestError('Leaving dates must not be in the past.')
    outs = [out_start + timedelta(days=i) for i in range((out_end - out_start).days + 1)]
    if req.get('backDates') is None:
        combos = [{'out': d.isoformat(), 'back': None} for d in outs]
    else:
        back_start, back_end = _window(req, 'backDates')
        backs = [back_start + timedelta(days=i) for i in range((back_end - back_start).days + 1)]
        combos = [{'out': o.isoformat(), 'back': b.isoformat()} for o in outs for b in backs if b >= o]
    if not combos:
        raise RequestError('No valid date combinations (every return is before its leave date).')
    if len(combos) > MAX_LOOKUP_COMBOS:
        raise RequestError(f'{len(combos)} date combinations; the limit is {MAX_LOOKUP_COMBOS}. Narrow a range.')
    return config, combos


def _annotate(leg):
    """Copy of a leg with each layover's country (for display only)."""
    from .airports import country_of
    if leg is None:
        return None
    return {**leg, 'layovers': [{**l, 'country': country_of(l['id'])} for l in leg['layovers']]}


def _carriers(*legs):
    from .filters import carrier_of
    return sorted({carrier_of(f) for leg in legs if leg for f in leg['flights']})


def search_cell(client, config, pair):
    """Allowed options for one combo, cheapest first. The filter runs BEFORE the pick."""
    from .filters import acceptable
    o, d = config['origin'], config['destination']
    outbound = [x for x in client.search_options(config, pair) if acceptable(x, config, o, d, pair['out'])]
    if not pair['back']:
        return [{'price': x['price'], 'out': x, 'back': None, 'airlines': _carriers(x)}
                for x in outbound[:MAX_OPTIONS_PER_CELL]]
    # Round trip: try the cheapest allowed outbounds in order; stop at the first
    # one that has an allowed return. Return prices are full round-trip totals.
    for selected in outbound[:config['maxOutboundTries']]:
        returns = client.return_options(config, pair, selected)
        allowed = [r for r in returns if acceptable(r, config, d, o, pair['back'])]
        if allowed:
            return [{'price': r['price'], 'out': selected, 'back': r, 'airlines': _carriers(selected, r)}
                    for r in allowed[:MAX_OPTIONS_PER_CELL]]
    return []


def run_lookup(req, emit, client=None, today=None):
    """Validate, then search every combo, emitting events. Returns exit code."""
    try:
        config, combos = validate(req, today)
    except RequestError as exc:
        emit({'type': 'fatal', 'message': str(exc)})
        return 2
    from .errors import Blocked, ScraperError
    client = client or GoogleLookupClient()
    emit({'type': 'start', 'total': len(combos), 'combos': combos})
    checked, errors_in_row = 0, 0
    for pair in combos:
        base = {'type': 'cell', 'out': pair['out'], 'back': pair['back']}
        try:
            options = search_cell(client, config, pair)
            errors_in_row = 0
            options = [{**x, 'out': _annotate(x['out']), 'back': _annotate(x['back'])} for x in options]
            emit({**base, 'status': 'ok' if options else 'none', 'options': options})
        except Blocked as exc:
            emit({**base, 'status': 'error', 'options': [], 'message': str(exc)})
            emit({'type': 'fatal', 'message': str(exc)})
            return 1
        except ScraperError as exc:
            errors_in_row += 1
            emit({**base, 'status': 'error', 'options': [], 'message': str(exc)})
        except Exception:
            errors_in_row += 1
            emit({**base, 'status': 'error', 'options': [],
                  'message': 'Unexpected flight response. No uncertain prices were accepted.'})
        checked += 1
        if errors_in_row >= MAX_CONSECUTIVE_ERRORS:
            emit({'type': 'fatal', 'message': f'{errors_in_row} searches failed in a row; stopped to avoid being blocked.'})
            return 1
    emit({'type': 'done', 'checked': checked})
    return 0


class GoogleLookupClient:
    """Real client: wraps the v1-proven Google adapter."""

    def __init__(self):
        from .google import GoogleFlights
        self.gf = GoogleFlights()

    def _query(self, config, pair):
        from .google import make_query
        return make_query(config, {'out': pair['out'], 'back': pair['back']})

    def search_options(self, config, pair):
        return self.gf.options(self._query(config, pair), config['currency'])

    def return_options(self, config, pair, outbound):
        from .errors import ScraperError
        from .google import select_outbound
        returns = self.gf.options(select_outbound(self._query(config, pair), outbound), config['currency'])
        if returns and not any(r['flights'][0]['departure_airport']['id'] == config['destination'] for r in returns):
            raise ScraperError('Google did not select the outbound flight; refusing an unverified round trip.')
        return returns
