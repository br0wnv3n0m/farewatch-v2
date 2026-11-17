"""Engine errors. Kept separate so tests and the server port need no scraper libraries."""


class ScraperError(Exception):
    pass


class FlightDataUnavailable(ScraperError):
    """Google returned an explicit flight-data service error."""


class Blocked(ScraperError):
    """HTTP error, unreachable site, or consent/block page. Stop the whole run."""
