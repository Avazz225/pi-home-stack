"""What a room does when you heat it, learned from watching it.

Two numbers per room, and both are worth having for the same reason: a radiator
is not a switch. It takes a while to warm a room, and it keeps warming it after
the valve has shut.

  heat_rate    degrees per minute, so the heating can start late enough to be
               cheap and early enough to be warm on time
  overshoot    degrees the room gains after the valve closes, so the valve can
               be told a lower number and the room still lands on the right one

Both are averages that bend towards the newest measurement - an exponential
moving average, which is one line of arithmetic and needs no history to be kept.
A week of sunshine moves them; one open window does not.

Deliberately no machine learning. The relationship being modelled is a straight
line with two corrections, the data is a handful of measurements a day, and
anything cleverer would be harder to explain to the person whose morning it
decides.
"""

from __future__ import annotations

from datetime import datetime, timezone

# How much a new measurement counts against everything before it. A fifth is
# roughly "the last five heat-ups matter": slow enough to ignore a fluke, quick
# enough to follow the change from autumn to winter.
ALPHA = 0.2

# The conditions the stored rate is normalised to. Every measurement is divided
# by the weather factor before it is averaged, so the stored number means "in
# ten degrees and no sun" rather than "on the day it happened".
REFERENCE_OUTSIDE_C = 10.0
REFERENCE_RADIATION = 0.0

# How much the weather is allowed to matter. Modest on purpose: the correction
# only has to point the right way, because normalising the measurements means a
# slightly wrong factor is absorbed by the average rather than accumulated.
COLD_PENALTY = 0.15        # per 10 K below the reference, slower
SUN_BONUS = 0.20           # per 300 W/m² of direct radiation, faster
FACTOR_RANGE = (0.5, 1.6)

# What counts as a measurement at all. A heat-up of a tenth of a degree is
# noise, one that takes five hours is a window somebody forgot.
MIN_RISE_C = 0.5
MIN_MINUTES = 5
MAX_MINUTES = 300
RATE_RANGE = (0.002, 0.2)  # °C per minute: 0.12 K/h to 12 K/h
MAX_OVERSHOOT_C = 3.0

# How long to keep watching after the room has arrived, for the overshoot.
OVERSHOOT_WINDOW_MIN = 45

# How close to the target counts as arrived. A tenth of a degree short is
# arrived: the sensor reports in tenths, and waiting for the exact number would
# mean episodes that never close on a room the valve holds just below it.
ARRIVED_TOLERANCE_C = 0.1

# Nothing may be preheated for longer than this, whatever the arithmetic says.
# A model that has learned nonsense should waste an hour, not a night.
MAX_PREHEAT_MIN = 180

# What to assume before anything has been learned. Half a degree per ten minutes
# is an ordinary radiator in an ordinary room; it is replaced by the truth after
# the first measurement.
DEFAULT_HEAT_RATE = 0.05


def clamp(value, low, high):
    return max(low, min(high, value))


def weather_factor(outside, radiation):
    """How much faster or slower the room heats in this weather.

    Cold outside means heat leaves through the walls while it is being put in;
    sun through the window puts some in for free. Both are small effects next to
    the radiator, which is why the factor is bounded tightly - a model that
    halves the preheat because the sun is out will be wrong on the one morning
    the forecast was.
    """
    if outside is None:
        outside = REFERENCE_OUTSIDE_C
    if radiation is None:
        radiation = REFERENCE_RADIATION
    cold = COLD_PENALTY * (REFERENCE_OUTSIDE_C - float(outside)) / 10.0
    sun = SUN_BONUS * float(radiation) / 300.0
    return clamp(1.0 - cold + sun, *FACTOR_RANGE)


def ema(previous, observed, alpha=ALPHA):
    """The first measurement is the average; every later one bends it."""
    if previous is None:
        return float(observed)
    return (1 - alpha) * float(previous) + alpha * float(observed)


def normalised_rate(rise_c, minutes, outside, radiation):
    """One heat-up as a rate in reference conditions, or None if it is not one.

    Dividing by the weather factor is what makes the stored number comparable
    across a year: a January measurement and a May measurement end up meaning
    the same thing.
    """
    if minutes is None or minutes < MIN_MINUTES or minutes > MAX_MINUTES:
        return None
    if rise_c is None or rise_c < MIN_RISE_C:
        return None
    rate = (rise_c / minutes) / weather_factor(outside, radiation)
    if not RATE_RANGE[0] <= rate <= RATE_RANGE[1]:
        return None
    return rate


def preheat_minutes(rate, rise_c, outside, radiation):
    """How long before the wanted time the heating has to start.

    Returns whole minutes, because the thing being computed is a cron
    expression and a schedule that moves by seconds moves for no reason.
    """
    if rise_c is None or rise_c <= 0:
        return 0
    rate = float(rate or DEFAULT_HEAT_RATE)
    if rate <= 0:
        return 0
    adjusted = rate * weather_factor(outside, radiation)
    if adjusted <= 0:
        return 0
    return int(round(clamp(rise_c / adjusted, 0, MAX_PREHEAT_MIN)))


def compensated_target(target_c, overshoot_c):
    """The number to tell the valve so the room ends up at the wanted one.

    Never more than the overshoot that was actually measured, and never below
    freezing-protection territory: a model that has learned something absurd
    should make the room a degree cool, not turn the heating off in January.
    """
    if target_c is None:
        return None
    correction = clamp(float(overshoot_c or 0.0), 0.0, MAX_OVERSHOOT_C)
    return round(max(float(target_c) - correction, 5.0), 1)


# ── Reading what was written down ────────────────────────────────────────────


def parse_stamp(value):
    if not value:
        return None
    try:
        moment = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)
