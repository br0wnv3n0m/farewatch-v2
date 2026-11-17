"""Leg checks shared by lookup and watches. Same rules run again on the server."""
import math

from .airports import country_of


def carrier_of(flight):
    """IATA carrier code from a flight number like 'AC123' or 'U21234'."""
    return flight['flight_number'][:2]


def layover_airports(leg):
    """Airports where the traveller changes planes (all arrivals except the last)."""
    return [f['arrival_airport']['id'] for f in leg.get('flights', [])[:-1]]


def blocked_stop(leg, blocked):
    """Return a reason string if any layover is in a blocked country, else None.

    Fail closed: when a block list is set and a layover airport is not in the
    bundled list, the leg is rejected because its country cannot be proven.
    """
    if not blocked:
        return None
    for code in layover_airports(leg):
        country = country_of(code)
        if country is None:
            return f'unknown layover airport {code}'
        if country in blocked:
            return f'layover in blocked country {country} ({code})'
    return None


def acceptable(leg, rules, origin, destination, date):
    """True if one direction of a trip passes every v2 rule.

    rules: maxStops, maxLayover (minutes), blockedCountries (set of ISO2),
    airlines (set of IATA carrier codes; empty = any).
    """
    flights = leg.get('flights', [])
    if not flights or len(flights) - 1 > rules['maxStops']:
        return False
    if flights[0]['departure_airport']['id'] != origin or flights[-1]['arrival_airport']['id'] != destination:
        return False
    if not flights[0]['departure_airport']['time'].startswith(date):
        return False
    layovers = leg.get('layovers', [])
    if len(layovers) != len(flights) - 1:
        return False
    for i, layover in enumerate(layovers):
        minutes = layover['duration']
        if isinstance(minutes, bool) or not isinstance(minutes, (int, float)) or not math.isfinite(minutes):
            return False
        if minutes < 0 or minutes >= rules['maxLayover']:
            return False
        if flights[i]['arrival_airport']['id'] != flights[i + 1]['departure_airport']['id']:
            return False
    airlines = rules.get('airlines') or set()
    if airlines and any(carrier_of(f) not in airlines for f in flights):
        return False
    return blocked_stop(leg, rules.get('blockedCountries') or set()) is None
