"""The arithmetic behind the adaptive heating, and the forecast it leans on.

Worth testing on its own because this is the part that decides what time
somebody's morning starts, and because every interesting case - a flat battery,
an open window, a weather server that is down - is easier to arrange here than
in a flat.
"""

import importlib.util
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
HOME = os.path.join(HERE, "..", "apps", "home")
sys.path.insert(0, HOME)

failed = 0


def check(label, got, want):
    global failed
    if got == want:
        print(f"PASS  {label}")
    else:
        print(f"FAIL  {label}\n        expected: {want!r}\n        got:      {got!r}")
        failed = 1


def near(label, got, want, tolerance=0.001):
    global failed
    if got is not None and abs(got - want) <= tolerance:
        print(f"PASS  {label}")
    else:
        print(f"FAIL  {label}\n        expected: {want} ± {tolerance}\n        got:      {got!r}")
        failed = 1


def ok(label, condition, detail=""):
    check(label, bool(condition) or detail, True)


def load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HOME, f"{name}.py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


thermal = load("thermal")
weather = load("weather")

# ── The weather factor ───────────────────────────────────────────────────────

near("reference conditions change nothing",
     thermal.weather_factor(thermal.REFERENCE_OUTSIDE_C, 0), 1.0)
ok("cold outside means slower", thermal.weather_factor(-10, 0) < 1.0)
ok("warm outside means faster", thermal.weather_factor(20, 0) > 1.0)
ok("sun means faster", thermal.weather_factor(10, 400) > 1.0)
near("ten degrees colder costs the stated penalty",
     thermal.weather_factor(0, 0), 1.0 - thermal.COLD_PENALTY)
near("three hundred watts give the stated bonus",
     thermal.weather_factor(10, 300), 1.0 + thermal.SUN_BONUS)

# Bounded on purpose: a model that halves the preheat because the sun is out
# will be wrong on the one morning the forecast was.
ok("absurd cold is still bounded", thermal.weather_factor(-200, 0) >= thermal.FACTOR_RANGE[0])
ok("absurd sun is still bounded", thermal.weather_factor(10, 99999) <= thermal.FACTOR_RANGE[1])
near("nothing known is the reference", thermal.weather_factor(None, None), 1.0)

# ── The average ──────────────────────────────────────────────────────────────

check("the first measurement is the average", thermal.ema(None, 0.08), 0.08)
near("a later one bends it", thermal.ema(0.10, 0.05), 0.10 * 0.8 + 0.05 * 0.2)
near("and a run of them converges",
     [v := 0.10] and [v := thermal.ema(v, 0.05) for _ in range(30)][-1], 0.05, 0.001)

# ── Turning one heat-up into a rate ──────────────────────────────────────────

# Two degrees in forty minutes, in reference weather: a twentieth per minute.
near("a plain measurement",
     thermal.normalised_rate(2.0, 40, thermal.REFERENCE_OUTSIDE_C, 0), 0.05)

# The same room on a cold day looks slower, and is corrected back up, because
# the stored number means "in reference conditions".
cold = thermal.normalised_rate(2.0, 40, -10, 0)
plain = thermal.normalised_rate(2.0, 40, 10, 0)
ok("the same rise in the cold normalises higher", cold > plain, (cold, plain))
sunny = thermal.normalised_rate(2.0, 40, 10, 600)
ok("and in the sun it normalises lower", sunny < plain, (sunny, plain))

check("a rise too small to mean anything is discarded",
      thermal.normalised_rate(0.2, 40, 10, 0), None)
check("one that took five hours is a forgotten window",
      thermal.normalised_rate(2.0, 400, 10, 0), None)
check("one that took two minutes is a sensor jumping",
      thermal.normalised_rate(2.0, 2, 10, 0), None)
check("an impossible rate is discarded",
      thermal.normalised_rate(20.0, 6, 10, 0), None)
check("and nothing at all is not a measurement",
      thermal.normalised_rate(None, None, None, None), None)

# ── Predicting how early to start ────────────────────────────────────────────

check("two degrees at a twentieth per minute is forty minutes",
      thermal.preheat_minutes(0.05, 2.0, thermal.REFERENCE_OUTSIDE_C, 0), 40)
ok("colder means starting earlier",
   thermal.preheat_minutes(0.05, 2.0, -10, 0) > 40)
ok("sun means starting later",
   thermal.preheat_minutes(0.05, 2.0, 10, 600) < 40)
check("no rise needs no preheat", thermal.preheat_minutes(0.05, 0, 10, 0), 0)
check("a room already warm enough needs none either",
      thermal.preheat_minutes(0.05, -1.5, 10, 0), 0)

# Whatever the arithmetic says, a model that has learned nonsense should waste
# an hour rather than a night.
check("the preheat is capped",
      thermal.preheat_minutes(0.0001, 20.0, -20, 0), thermal.MAX_PREHEAT_MIN)
check("with nothing learned, the default rate is used",
      thermal.preheat_minutes(None, 2.0, thermal.REFERENCE_OUTSIDE_C, 0),
      int(round(2.0 / thermal.DEFAULT_HEAT_RATE)))

# ── Telling the valve a lower number ─────────────────────────────────────────

check("the valve is told the target minus what the room gains after",
      thermal.compensated_target(21.0, 0.6), 20.4)
check("nothing learned means nothing deducted",
      thermal.compensated_target(21.0, None), 21.0)
check("a negative overshoot is not a bonus",
      thermal.compensated_target(21.0, -2.0), 21.0)
check("an absurd one is capped",
      thermal.compensated_target(21.0, 99), round(21.0 - thermal.MAX_OVERSHOOT_C, 1))
# A model that has learned something absurd should make the room a degree cool,
# not turn the heating off in January.
check("and never below frost protection", thermal.compensated_target(5.5, 3.0), 5.0)
check("no target, no number", thermal.compensated_target(None, 1.0), None)

# ── Reading a series of samples ──────────────────────────────────────────────

base = datetime(2026, 11, 1, 5, 0, tzinfo=timezone.utc)


def series(values, step=5):
    return [{"measured_at": (base + timedelta(minutes=i * step)).isoformat(),
             "temperature": v} for i, v in enumerate(values)]


# 18.0 at five, arriving at 21.0 forty minutes later.
climb = series([18.0, 18.4, 18.8, 19.3, 19.8, 20.2, 20.6, 20.8, 21.0])
episode = thermal.find_heatup(climb, 21.0)
near("the climb is forty minutes", episode["minutes"], 40)
near("over three degrees", episode["rise_c"], 3.0)
check("starting where it was coldest", episode["from_c"], 18.0)

# A tenth short counts as arrived: sensors report in tenths, and waiting for an
# exact match would mean a room that settles at 20.9 never finishes its episode.
near("a tenth short is close enough to have arrived",
     thermal.find_heatup(series([18.0, 19.5, 20.9]), 21.0)["minutes"], 10)

check("a room still climbing is not yet a measurement",
      thermal.find_heatup(series([18.0, 18.5, 19.0]), 21.0), None)
check("a room that was already there is not one either",
      thermal.find_heatup(series([21.2, 21.3]), 21.0), None)
check("and neither is nothing at all", thermal.find_heatup([], 21.0), None)

# A dip before the climb must not be counted as part of it - the start is the
# coldest point immediately before the rise, not the first sample of the day.
dipped = series([20.0, 19.0, 18.0, 19.0, 20.0, 21.0])
near("a dip before the rise does not stretch it",
     thermal.find_heatup(dipped, 21.0)["from_c"], 18.0)

# ── The drift after arriving ─────────────────────────────────────────────────

after = series([21.0, 21.3, 21.6, 21.5, 21.2])
near("the peak after arrival is the overshoot",
     thermal.find_overshoot(after, 21.0, base), 0.6)
# A room that is warmer three hours later is warmer because the heating is on
# again, which is a different story - so the far sample is outside the window
# and what is left is an arrival with no drift at all.
near("a sample hours later is outside the window",
     thermal.find_overshoot(series([21.0, 25.0], step=120), 21.0, base), 0.0)
check("cooling instead of drifting is no overshoot",
      thermal.find_overshoot(series([21.0, 20.5]), 21.0, base), 0.0)
check("an absurd jump is discarded",
      thermal.find_overshoot(series([21.0, 40.0]), 21.0, base), None)
check("no arrival, no measurement", thermal.find_overshoot(after, 21.0, None), None)

# ── The forecast ─────────────────────────────────────────────────────────────

check("without coordinates nothing is asked for",
      weather.fetch(None, None).available, False)
check("and the neutral pair is what comes out",
      weather.Forecast().at(base), (weather.NEUTRAL_OUTSIDE_C, weather.NEUTRAL_RADIATION))

parsed = weather._parse({"hourly": {
    "time": ["2026-11-01T05:00", "2026-11-01T06:00", "2026-11-01T07:00"],
    "temperature_2m": [3.0, 2.5, 4.0],
    "direct_radiation": [0, 0, 120],
}})
forecast = weather.Forecast(parsed, source="open-meteo")
check("an hour is found by the moment inside it",
      forecast.at(base + timedelta(minutes=37)), (3.0, 0.0))
check("the next hour is the next hour",
      forecast.at(base + timedelta(hours=2)), (4.0, 120.0))
check("an hour outside the forecast falls back",
      forecast.at(base + timedelta(days=3)),
      (weather.NEUTRAL_OUTSIDE_C, weather.NEUTRAL_RADIATION))

# A heat-up that crosses hours should be judged by all of them, not by the one
# it happened to start in.
average = weather.window(forecast, base, 180)
near("the window averages the hours it spans", average[0], (3.0 + 2.5 + 4.0) / 3)
near("radiation too", average[1], 120.0 / 3)
near("a short window is just its hour", weather.window(forecast, base, 10)[0], 3.0)

# Arrays that do not line up must lose an hour, never shift the rest.
short = weather._parse({"hourly": {
    "time": ["2026-11-01T05:00", "2026-11-01T06:00"],
    "temperature_2m": [3.0],
    "direct_radiation": [],
}})
check("a short array loses its hour and no other", len(short), 1)
check("and a missing radiation array is no sun",
      weather.Forecast(short).at(base), (3.0, 0.0))
check("a null temperature is skipped", len(weather._parse({"hourly": {
    "time": ["2026-11-01T05:00"], "temperature_2m": [None]}})), 0)
check("rubbish is not a forecast", weather._parse({}), {})

# ── What the gateway is actually told ────────────────────────────────────────
#
# The whole feature is this transformation: the time moves earlier, the setpoint
# moves lower, and nothing else in the chain changes. Both mistakes checked here
# were found by running it rather than by reading it.

import sqlite3

work_dir = tempfile.mkdtemp(prefix="phs-adaptive-")
os.environ["HOME_DATA_DIR"] = work_dir
app = load("app")
app.DB_FILE = os.path.join(work_dir, "home.db")
app.init_db()

db = sqlite3.connect(app.DB_FILE)
db.row_factory = sqlite3.Row
db.execute("INSERT OR IGNORE INTO room (id, key, name, position) VALUES (1,'wohnen','Wohnen',0)")
db.execute("INSERT INTO room_device (room_id, kind, external_id) VALUES (1,'shelly_climate','200')")
for clock, degrees in (("06:00", 18.0), ("07:00", 21.0), ("22:00", 17.0)):
    db.execute("INSERT INTO heating_schedule (room_id, weekdays, time, target_temp, enabled) "
               "VALUES (1,'12345',?,?,1)", (clock, degrees))
db.commit()


def mirrored():
    jobs, _ = app.desired_schedule_jobs(db)
    return {job["timespec"]: [c["params"]["params"]["target_C"] for c in job["calls"]]
            for job in jobs}


def setting(key, value):
    db.execute("INSERT OR REPLACE INTO home_setting (key, value) VALUES (?, ?)", (key, value))
    db.commit()


setting("adaptive_learning", "0")
check("switched off, the plan is mirrored as written",
      mirrored(), {"0 0 6 * * 1,2,3,4,5": [18.0],
                   "0 0 7 * * 1,2,3,4,5": [21.0],
                   "0 0 22 * * 1,2,3,4,5": [17.0]})

setting("adaptive_learning", "1")
db.execute("INSERT INTO heating_model (room_key, heat_rate, heat_rate_samples, "
           "overshoot, overshoot_samples) VALUES ('wohnen', 0.075, 4, 0.6, 3)")
db.commit()
jobs = mirrored()

# Three degrees at 0.075 a minute is forty minutes.
check("the morning step starts forty minutes early", "0 20 6 * * 1,2,3,4,5" in jobs, True)
check("and the valve is told the target minus the overshoot",
      jobs["0 20 6 * * 1,2,3,4,5"], [20.4])

# The first mistake: without a bound on the shift, this entry moved onto the
# six o'clock setback, both setpoints went out in the same second, and which
# one the room ended up with was decided by the order of two calls in a list.
ok("no entry is moved onto the one before it",
   "0 0 6 * * 1,2,3,4,5" not in jobs or len(jobs["0 0 6 * * 1,2,3,4,5"]) == 1, jobs)

# The second: the overshoot is heat still arriving from a radiator that was
# just on. A setback has none, and deducting there made the night colder than
# anybody asked for.
check("a setback keeps the number it was given",
      jobs["0 0 22 * * 1,2,3,4,5"], [17.0])

setting("adaptive_learning", "0")
check("switching it off puts the plan back exactly as it was",
      mirrored(), {"0 0 6 * * 1,2,3,4,5": [18.0],
                   "0 0 7 * * 1,2,3,4,5": [21.0],
                   "0 0 22 * * 1,2,3,4,5": [17.0]})
db.close()

print()
print("Alle Thermik-Tests bestanden." if not failed else "Fehler aufgetreten.")
sys.exit(failed)
