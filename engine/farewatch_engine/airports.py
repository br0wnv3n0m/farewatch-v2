"""Offline IATA airport -> country lookup (bundled data, works on PC and server)."""
import json
from functools import lru_cache
from pathlib import Path

_DATA = Path(__file__).parent / 'data' / 'airports.json'


@lru_cache(maxsize=1)
def _table():
    return json.loads(_DATA.read_text(encoding='utf-8'))


def country_of(iata):
    """Return the ISO2 country for an airport code, or None if unknown."""
    if not isinstance(iata, str):
        return None
    return _table().get(iata.strip().upper())


def airport_count():
    return len(_table())
