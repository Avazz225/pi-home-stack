"""The valve calibration watchdog.

This is the one part of the stack that moves hardware in somebody's flat on its
own initiative, so the tests are mostly about restraint: not acting on a symptom
that has lasted ten minutes, not acting twice, not acting at all when told not
to, and writing down everything it does.
"""

import importlib.util
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


def ok(label, condition, detail=""):
    check(label, bool(condition) or detail, True)


def load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HOME, f"{name}.py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


watchdog = load("watchdog")

# ── The symptom, on its own ──────────────────────────────────────────────────


def valve(target=21.0, position=0, errors=None, trv_id=200, head=None):
    """One valve as the gateway reports it.

    `head` is what the valve measures itself; where the test leaves it out it
    is the same as the room, which is the case with no wall sensor.
    """
    return {"id": trv_id, "target_C": target, "position": position,
            "current_C": head, "valve_errors": errors or []}


check("a room at its setpoint is nothing to report",
      watchdog.symptom_of(21.0, valve(position=30, head=21.0)), None)

# The case the user described: the valve measures two degrees over its setpoint
# and is still open, so the position it reports is not where the pin is.
hot = watchdog.symptom_of(23.5, valve(target=21.0, position=20, head=23.5))
check("two degrees over with the valve open is a symptom", hot[0], "overheating")
ok("and the numbers are in the message", "23.5" in hot[1] and "20 %" in hot[1], hot[1])

check("two degrees over with the valve shut is not",
      watchdog.symptom_of(23.5, valve(target=21.0, position=0, head=23.5)), None)
check("nor is one degree over with it open",
      watchdog.symptom_of(22.0, valve(target=21.0, position=20, head=22.0)), None)

# The other direction: the valve reports itself wide open and the radiator
# stays cold, which is the same fault seen from the other side.
cold = watchdog.symptom_of(18.5, valve(target=21.0, position=100, head=18.5))
check("wide open and cold is a symptom too", cold[0], "underheating")
check("but not when the valve is barely open",
      watchdog.symptom_of(18.5, valve(target=21.0, position=10, head=18.5)), None)

# The valve saying so itself beats any inference from temperatures.
own = watchdog.symptom_of(21.0, valve(errors=["not_calibrated"], head=21.0))
check("the valve's own complaint is taken first", own[0], "not_calibrated")

# The distinction that decides whether a motor gets driven. A head in a window
# niche reads low; the correction towards a wall sensor is capped at three
# degrees, so the valve can hold its setpoint exactly while the room sits above
# it. Nothing is wrong with the motor, and calibrating would not help.
mismatch = watchdog.symptom_of(23.5, valve(target=21.0, position=20, head=21.0))
check("a valve holding its own setpoint in a warmer room is a different fault",
      mismatch[0], "sensor_mismatch")
ok("and the message says what to look at",
   "Zuordnung" in mismatch[1] and "nicht die Kalibrierung" in mismatch[1], mismatch[1])
ok("which is not one calibration is sent for",
   "sensor_mismatch" not in watchdog.CALIBRATION_SYMPTOMS)

check("a valve with no reading at all is not suspected",
      watchdog.symptom_of(None, valve(position=50)), None)
check("nor one with no setpoint",
      watchdog.symptom_of(23.0, valve(target=None, position=50, head=23.0)), None)
check("nor one that does not report its position",
      watchdog.symptom_of(23.0, valve(position=None, head=23.0)), None)
# With no wall sensor there is only one reading, and it is the valve's.
check("without a head reading the room's stands in",
      watchdog.symptom_of(23.5, valve(target=21.0, position=20))[0], "overheating")


# ── Following it over time ───────────────────────────────────────────────────


class Gateway:
    """A gateway that records what it was asked to calibrate."""

    def __init__(self):
        self.calibrated = []
        self.error = None

    def calibrate(self, trv_id):
        if self.error:
            raise RuntimeError(self.error)
        self.calibrated.append(trv_id)
        return "TRV.Calibrate"


class Clock:
    def __init__(self):
        self.moment = datetime(2026, 11, 20, 6, 0, tzinfo=timezone.utc)

    def __call__(self):
        return self.moment

    def advance(self, minutes):
        self.moment += timedelta(minutes=minutes)


class Flat:
    """A database, a gateway, and a room whose valve can be made to misbehave."""

    def __init__(self, auto=True):
        handle, self.path = tempfile.mkstemp(suffix=".db")
        os.close(handle)
        connection = sqlite3.connect(self.path)
        with open(os.path.join(HOME, "schema.sql"), encoding="utf-8") as f:
            connection.executescript(f.read())
        connection.close()
        self.rooms = []
        self.gateway = Gateway()
        self.clock = Clock()
        self.reports = []
        watchdog.now = self.clock
        self.watcher = watchdog.Watchdog(
            self.path, lambda db: self.rooms, lambda db: {"auto_calibrate": auto},
            lambda db: self.gateway, on_report=self.reports.append)

    def step(self, temperature, minutes=5, **valve_kwargs):
        valve_kwargs.setdefault("head", temperature)
        self.rooms = [{"key": "bad", "climate": {
            "temperature": temperature, "items": [valve(**valve_kwargs)]}}]
        self.watcher.tick()
        self.clock.advance(minutes)

    def row(self, trv_id="200"):
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        found = connection.execute("SELECT * FROM valve_watch WHERE trv_id = ?",
                                   (trv_id,)).fetchone()
        connection.close()
        return dict(found) if found else None

    def close(self):
        os.unlink(self.path)


# Half an hour of the symptom before anything is sent. Sun on a sensor, a
# second radiator, a door left open between two rooms - all of those look
# exactly like this for ten minutes.
flat = Flat()
for _ in range(5):
    flat.step(23.5, target=21.0, position=20)
check("after twenty minutes nothing has been sent", flat.gateway.calibrated, [])
check("but the symptom is on file", flat.row()["symptom"], "overheating")

for _ in range(3):
    flat.step(23.5, target=21.0, position=20)
check("past the half hour, the valve is calibrated once",
      flat.gateway.calibrated, ["200"])
check("and it is written down", flat.row()["attempts"], 1)
ok("with what came of it", "TRV.Calibrate" in flat.row()["last_result"],
   flat.row()["last_result"])
check("and reported", [r["symptom"] for r in flat.reports], ["overheating"])

# Calibrating again would not help and costs a battery a motor cycle.
for _ in range(20):
    flat.step(23.5, target=21.0, position=20)
check("a symptom that persists is not calibrated again",
      flat.gateway.calibrated, ["200"])

flat.clock.advance(60 * watchdog.RETRY_AFTER_HOURS)
flat.step(23.5, target=21.0, position=20)
check("twelve hours later it may try again",
      flat.gateway.calibrated, ["200", "200"])
check("and the attempts are counted", flat.row()["attempts"], 2)
flat.close()

# Recovery clears the symptom. The attempt history stays, because it is the
# only record that anything was done - and it is what limits the next attempt.
flat = Flat()
for _ in range(10):
    flat.step(23.5, target=21.0, position=20)
check("calibrated once", flat.row()["attempts"], 1)
flat.step(21.0, target=21.0, position=20)
check("a room back at its setpoint clears the symptom", flat.row()["symptom"], None)
check("the history is kept", flat.row()["attempts"], 1)
flat.close()

# A different symptom is a different story and starts its own clock.
flat = Flat()
for _ in range(5):
    flat.step(23.5, target=21.0, position=20)
first_since = flat.row()["since"]
flat.step(18.0, target=21.0, position=100)
check("a new symptom replaces the old", flat.row()["symptom"], "underheating")
ok("and restarts the half hour", flat.row()["since"] != first_since, flat.row()["since"])
for _ in range(2):
    flat.step(18.0, target=21.0, position=100)
check("so nothing is sent yet", flat.gateway.calibrated, [])
flat.close()

# Switched off: the symptom is still followed and still reported, only nothing
# is sent to the valve. Somebody who does not want a motor driven at four in
# the morning should still find out that it needs driving.
flat = Flat(auto=False)
for _ in range(10):
    flat.step(23.5, target=21.0, position=20)
check("with automatic calibration off, nothing is sent",
      flat.gateway.calibrated, [])
check("but the symptom is still on file", flat.row()["symptom"], "overheating")
check("and no attempt is claimed", flat.row()["attempts"], 0)
flat.close()

# A gateway that refuses must not take the watchdog down with it - and the
# refusal is the thing worth reading afterwards.
flat = Flat()
flat.gateway.error = "Gateway nicht erreichbar"
for _ in range(10):
    flat.step(23.5, target=21.0, position=20)
ok("a refused calibration is recorded as such",
   "Gateway nicht erreichbar" in (flat.row()["last_result"] or ""),
   flat.row()["last_result"])
check("and counts as an attempt, so it is not retried at once",
      flat.row()["attempts"], 1)
flat.close()

# Followed, reported, never acted on.
flat = Flat()
for _ in range(15):
    flat.step(23.5, target=21.0, position=20, head=21.0)
check("a sensor mismatch is kept on file", flat.row()["symptom"], "sensor_mismatch")
check("and nothing is ever sent to the valve for it", flat.gateway.calibrated, [])
check("so no attempt is claimed", flat.row()["attempts"], 0)
flat.close()

# A valve complaining about itself must be seen even when nothing in the room
# reports a temperature - that is the one signal that needs no inference, and
# the sampler's "no reading, no sample" rule used to hide it.
flat = Flat()
for _ in range(10):
    flat.rooms = [{"key": "bad", "climate": {"temperature": None, "items": [
        valve(target=21.0, position=0, errors=["not_calibrated"])]}}]
    flat.watcher.tick()
    flat.clock.advance(5)
check("a valve with no reading still reports itself uncalibrated",
      flat.row()["symptom"], "not_calibrated")
check("and is calibrated for it", flat.gateway.calibrated, ["200"])
flat.close()

# A valve that has been unpaired should not keep a symptom on file for ever.
flat = Flat()
flat.step(23.5, target=21.0, position=20)
ok("a suspected valve has a row", flat.row() is not None)
flat.rooms = [{"key": "bad", "climate": {"temperature": 21.0, "items": []}}]
flat.watcher.tick()
check("an unpaired valve is forgotten", flat.row(), None)
flat.close()

print()
print("Alle Wächter-Tests bestanden." if not failed else "Fehler aufgetreten.")
sys.exit(failed)
