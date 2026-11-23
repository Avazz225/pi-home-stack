"""The arithmetic behind the adaptive heating, and the forecast it leans on.

Worth testing on its own because this is the part that decides what time
somebody's morning starts, and because every interesting case - a flat battery,
an open window, a weather server that is down - is easier to arrange here than
in a flat.
"""

import importlib.util
import json
import os
import sqlite3
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
adaptive = load("adaptive")

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

# ── Following one heat-up, step by step ──────────────────────────────────────
#
# Driven through the real tick(), so that what is tested is the path the service
# takes: write the room down, then move its watch on. The bug these replace was
# only visible that way - each pass on its own looked right, and it was the
# repetition that was wrong.

base = datetime(2026, 11, 1, 5, 0, tzinfo=timezone.utc)


class Clock:
    """A clock the test winds forward, in place of the wall clock."""

    def __init__(self, start):
        self.moment = start

    def __call__(self):
        return self.moment

    def advance(self, minutes):
        self.moment += timedelta(minutes=minutes)


class Flat:
    """One room, a database, and a way to say what the sensors report."""

    def __init__(self):
        handle, self.path = tempfile.mkstemp(suffix=".db")
        os.close(handle)
        connection = sqlite3.connect(self.path)
        with open(os.path.join(HOME, "schema.sql"), encoding="utf-8") as f:
            connection.executescript(f.read())
        connection.close()
        self.rooms = []
        self.clock = Clock(base)
        adaptive.now = self.clock
        self.sampler = adaptive.Adaptive(
            self.path, lambda db: self.rooms,
            lambda db: {"learning": True, "weather": False})

    def step(self, temperature, target, minutes=5, age_s=None):
        """Five minutes pass, the room reports, the service has a look."""
        self.rooms = [{"key": "schlafen", "climate": {
            "temperature": temperature, "trv_target": target, "age_s": age_s}}]
        self.sampler.tick()
        self.clock.advance(minutes)

    def query(self, sql, args=()):
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        rows = [dict(row) for row in connection.execute(sql, args).fetchall()]
        connection.close()
        return rows

    def episodes(self, kind=None):
        if kind:
            return self.query("SELECT * FROM heating_episode WHERE kind = ? "
                              "ORDER BY id", (kind,))
        return self.query("SELECT * FROM heating_episode ORDER BY id")

    def watch(self):
        rows = self.query("SELECT * FROM heating_watch")
        return rows[0] if rows else None

    def model(self):
        rows = self.query("SELECT * FROM heating_model")
        return rows[0] if rows else None

    def close(self):
        os.unlink(self.path)


# A full morning: 18.0 at five, arriving at 21.0 forty minutes later.
flat = Flat()
for temperature in (18.0, 18.4, 18.8, 19.3, 19.8, 20.2, 20.6, 20.8, 21.0):
    flat.step(temperature, 21.0)

heatups = flat.episodes("heatup")
check("one climb is one measurement", len(heatups), 1)
near("measured over the whole forty minutes", heatups[0]["minutes"], 40)
near("from where it was coldest", heatups[0]["from_c"], 18.0)
near("to where it arrived", heatups[0]["to_c"], 21.0)
near("three degrees in forty minutes, in reference weather",
     heatups[0]["value"], 3.0 / 40)
check("and the room is now settling", flat.watch()["state"], "settling")

# The bug this file exists for: the same climb stayed in the sampler's window
# for hours, and every pass found it again - shorter and slower each time,
# because the window only still held its tail. Two hundred and eighty
# "measurements" came out of a handful of mornings.
for _ in range(8):
    flat.step(21.0, 21.0)
check("standing at the target adds no second measurement",
      len(flat.episodes("heatup")), 1)
check("the model counted it once", flat.model()["heat_rate_samples"], 1)
near("so the average is the measurement", flat.model()["heat_rate"], 3.0 / 40)
flat.close()

# ── The drift after arriving ─────────────────────────────────────────────────

flat = Flat()
for temperature in (18.0, 19.5, 20.9):
    flat.step(temperature, 21.0)
check("a tenth short is close enough to have arrived",
      flat.watch()["state"], "settling")
near("and ten minutes is what it took", flat.episodes("heatup")[0]["minutes"], 10)

# The valve has shut and the radiator is still warm. Three quarters of an hour
# later, the peak it drifted to is the overshoot.
for temperature in (21.3, 21.6, 21.5, 21.2, 21.1, 21.0, 21.0, 21.0, 21.0, 21.0):
    flat.step(temperature, 21.0)
drifts = flat.episodes("overshoot")
check("the drift is measured once", len(drifts), 1)
near("and it is the peak above the target", drifts[0]["value"], 0.6)
near("against the target it was told", drifts[0]["from_c"], 21.0)
check("the model counted that once too", flat.model()["overshoot_samples"], 1)
check("and the room is idle again", flat.watch()["state"], "idle")
flat.close()

# A room that never falls below its target has nothing to teach - which is the
# honest answer for a living room the heating holds all day, not a fault.
flat = Flat()
for _ in range(20):
    flat.step(21.2, 21.0)
check("a room always at its target produces no measurements",
      flat.episodes(), [])
check("and never starts watching one", flat.watch(), None)
flat.close()

# A dip before the rise belongs to the cooling, not to the heating: counting it
# would make the room look slower than it is.
flat = Flat()
for temperature in (20.0, 19.0, 18.0, 19.0, 20.0, 21.0):
    flat.step(temperature, 21.0)
near("the climb begins at the bottom of the dip",
     flat.episodes("heatup")[0]["from_c"], 18.0)
near("and is measured from there", flat.episodes("heatup")[0]["minutes"], 15)
flat.close()

# The plan moving mid-climb ends the episode: what was measured is no longer
# what was asked for. A raised target is itself the start of a new climb.
flat = Flat()
flat.step(18.0, 21.0)
flat.step(18.5, 21.0)
flat.step(19.0, 22.0)
check("a target that moves mid-climb drops the episode", flat.episodes(), [])
near("and the new one starts from there", flat.watch()["from_c"], 19.0)
check("towards the new target", flat.watch()["target_c"], 22.0)
flat.close()

# A room that cannot be read is not a measurement: the minutes would keep
# running while the degrees stopped, and the rate would come out too slow.
flat = Flat()
flat.step(18.0, 21.0)
flat.step(None, 21.0)
check("losing sight of the room abandons the climb", flat.watch()["state"], "idle")
check("without recording anything", flat.episodes(), [])
flat.close()

# Five hours and not there: a window is open, or the radiator is cold. Written
# down as a discarded episode, because an hour spent heating nothing is worth
# being able to see.
flat = Flat()
flat.step(18.0, 21.0)
for _ in range(int(thermal.MAX_MINUTES / 30) + 1):
    flat.step(18.1, 21.0, minutes=30)
stuck = flat.episodes("heatup")
check("a climb that never arrives is recorded once", len(stuck), 1)
check("and discarded, not averaged in", stuck[0]["value"], None)
check("the model learned nothing from it", flat.model(), None)
flat.close()

# ── What was written down ────────────────────────────────────────────────────

flat = Flat()
flat.step(20.5, 21.0, age_s=2700)
samples = flat.query("SELECT * FROM room_sample")
check("the reading's age is written down with it", samples[0]["age_s"], 2700)
near("together with the weather it was taken in",
     samples[0]["outside"], weather.NEUTRAL_OUTSIDE_C)
flat.close()

# ── Quiet, and silent ───────────────────────────────────────────────────────
#
# These two were one thing and a constant of ten minutes, and it reported a
# fault every hour from a healthy wall sensor at a hundred per cent battery.

flat = Flat()
# A sensor that reports on the hour, sampled every five minutes: the ages it
# produces run 0, 5, 10 ... 55 and start again, which is exactly the sawtooth a
# BLU device makes. Three days of it, so the baseline has something to measure.
for day_step in range(3 * 24 * 12):
    flat.step(20.0 + (day_step % 7) * 0.1, 21.0, age_s=(day_step % 12) * 300)
quiet = flat.query("SELECT * FROM room_quiet")
check("the usual silence is measured, not guessed", len(quiet), 1)
near("and it is about the sensor's own hour", quiet[0]["quiet_s"], 3000, tolerance=600)
ok("measured from a useful amount of history",
   quiet[0]["samples"] >= adaptive.MIN_QUIET_SAMPLES,
   f"only {quiet[0]['samples']} samples")
flat.close()

flat = Flat()
for _ in range(adaptive.MIN_QUIET_SAMPLES - 1):
    flat.step(20.0, 21.0, age_s=120)
check("too little history and no baseline is claimed", flat.query(
    "SELECT * FROM room_quiet"), [])
flat.close()

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
# ── One rule for "this reading is too old" ───────────────────────────────────
#
# Shipped with the climate rather than applied twice, so the screen and the
# notification service cannot disagree about whether a room has gone quiet.

check("inside three times the room's own habit, nothing is remarkable",
      app.silence_of(8000, 3000)[0], False)
check("past that, it is", app.silence_of(10000, 3000)[0], True)
check("the bar is reported, so the screen can name it",
      app.silence_of(10000, 3000)[1], 9000)
# A valve reporting every two minutes would otherwise raise an alarm over one
# missed broadcast - three times two minutes is six.
check("a chatty device still gets an hour", app.silence_of(2000, 120)[0], False)
check("with no baseline yet, six hours is the bar",
      app.silence_of(app.SILENT_UNMEASURED_S + 1, None)[0], True)
check("and five and a half is not",
      app.silence_of(app.SILENT_UNMEASURED_S - 1, None)[0], False)
check("no reading at all is not a silent one - it is an unbound room",
      app.silence_of(None, 3000)[0], False)

# A hundred per cent battery and silence for hours is the case that was
# reported as "weak battery". The two are separate fields now.
quiet_room = app.climate_for(
    [{"kind": "shelly_ht", "external_id": "ht1"}], {},
    {"ht1": {"temperature": 21.0, "humidity": 48, "battery": 100, "age_s": 25000}},
    quiet_s=3000)
check("a long-silent sensor is reported as silent", quiet_room["silent"], True)
check("and its battery is reported as what it is", quiet_room["battery"], 100)
check("an ordinary quiet stretch is not flagged", app.climate_for(
    [{"kind": "shelly_ht", "external_id": "ht1"}], {},
    {"ht1": {"temperature": 21.0, "humidity": 48, "battery": 100, "age_s": 2800}},
    quiet_s=3000)["silent"], False)

db.close()

print()
print("Alle Thermik-Tests bestanden." if not failed else "Fehler aufgetreten.")
sys.exit(failed)
