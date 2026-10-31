"""Outside temperature and sunshine, from Open-Meteo.

Chosen because it needs no account and no key: a key would be one more secret to
store, to rotate and to leak, for a number that is the same for everybody within
a kilometre.

What leaves this Pi is a pair of coordinates, and only when somebody has entered
them. They are stored in the service's own database under data/, which is not in
the repository - so they cannot be committed by accident, which is the failure
that actually happens.

The forecast is a convenience, never a dependency. Every call that fails returns
the neutral values below, and the caller cannot tell the difference except by
asking. A heating plan that stops working because a weather server is down would
be a worse plan than one that never asked.
"""

from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone

import requests

API_URL = "https://api.open-meteo.com/v1/forecast"
TIMEOUT = 8
# A forecast changes slowly and the server is somebody else's. Hourly values do
# not get better by being asked for twice an hour.
CACHE_S = 1800

# What the model assumes when nobody knows. Ten degrees and no sun is a dull
# average day - deliberately not a flattering one, because the error should make
# the heating start too early rather than too late.
NEUTRAL_OUTSIDE_C = 10.0
NEUTRAL_RADIATION = 0.0


class Forecast:
    """Hourly outside temperature and direct radiation, and what it knows.

    `source` says where the numbers came from, because a model that silently
    falls back to neutral values and one that has a real forecast behave
    differently, and the person reading the heating time should be able to see
    which it was.
    """

    def __init__(self, hours=None, source="neutral", error=None):
        self.hours = hours or {}
        self.source = source
        self.error = error

    def at(self, moment):
        """The hour containing that moment, or the neutral pair."""
        key = moment.astimezone(timezone.utc).replace(
            minute=0, second=0, microsecond=0).isoformat()
        values = self.hours.get(key)
        if values is None:
            return NEUTRAL_OUTSIDE_C, NEUTRAL_RADIATION
        return values

    @property
    def available(self):
        return bool(self.hours)


_cache = {"at": None, "key": None, "forecast": Forecast()}
_lock = threading.Lock()


def _parse(payload):
    """Open-Meteo answers with parallel arrays: one of times, one per variable.

    Turned into a mapping here so a caller can ask about a moment rather than
    about an index - and so a shorter array than expected loses that hour rather
    than shifting everything after it.
    """
    hourly = payload.get("hourly") or {}
    times = hourly.get("time") or []
    temps = hourly.get("temperature_2m") or []
    radiation = hourly.get("direct_radiation") or []
    hours = {}
    for index, stamp in enumerate(times):
        if index >= len(temps):
            break
        try:
            moment = datetime.fromisoformat(stamp)
        except (TypeError, ValueError):
            continue
        if moment.tzinfo is None:
            # timezone=UTC is requested, so a naive stamp is UTC.
            moment = moment.replace(tzinfo=timezone.utc)
        temperature = temps[index]
        if temperature is None:
            continue
        sun = radiation[index] if index < len(radiation) else None
        hours[moment.astimezone(timezone.utc).isoformat()] = (
            float(temperature), float(sun or 0.0))
    return hours


def fetch(latitude, longitude, force=False):
    """The next two days of weather for one place.

    Two days rather than one: a heating plan reaches into tomorrow morning, and
    the preheat for six o'clock is computed the evening before.
    """
    if latitude is None or longitude is None:
        return Forecast(error="Keine Koordinaten hinterlegt")

    key = f"{float(latitude):.4f},{float(longitude):.4f}"
    with _lock:
        fresh = (_cache["at"] is not None
                 and (datetime.now(timezone.utc) - _cache["at"]).total_seconds() < CACHE_S)
        if fresh and _cache["key"] == key and not force:
            return _cache["forecast"]

    try:
        response = requests.get(API_URL, timeout=TIMEOUT, params={
            "latitude": latitude,
            "longitude": longitude,
            "hourly": "temperature_2m,direct_radiation",
            "forecast_days": 2,
            # UTC throughout: every timestamp in this stack is UTC, and a
            # forecast in local time would be the one place that is not.
            "timezone": "UTC",
        })
        response.raise_for_status()
        hours = _parse(response.json())
    except (requests.RequestException, ValueError) as error:
        forecast = Forecast(error=str(error)[:160])
    else:
        forecast = (Forecast(hours, source="open-meteo") if hours
                    else Forecast(error="Keine Stundenwerte in der Antwort"))

    with _lock:
        _cache.update({"at": datetime.now(timezone.utc), "key": key, "forecast": forecast})
    return forecast


def window(forecast, start, minutes):
    """The average conditions over a stretch of time.

    A heat-up lasts longer than an hour often enough that the hour it started in
    is the wrong one to judge it by.
    """
    samples = []
    moment = start
    end = start + timedelta(minutes=max(1, minutes))
    while moment < end:
        samples.append(forecast.at(moment))
        moment += timedelta(hours=1)
    if not samples:
        samples = [forecast.at(start)]
    return (sum(s[0] for s in samples) / len(samples),
            sum(s[1] for s in samples) / len(samples))
