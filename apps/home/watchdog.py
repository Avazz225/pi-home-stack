"""Watching for a valve that has lost its calibration.

A thermostatic valve knows where its stepper motor is only because it once
drove it to both ends and remembered. That memory can go - a battery change, a
jammed stem, a valve moved to another radiator - and when it does, the number
the valve reports as its position stops describing where the pin actually sits.
Nothing announces it. What happens instead is that the room quietly sits two
degrees above its setpoint while the valve insists it is barely open, or the
other way round: the valve reports itself wide open and the radiator stays
cold.

So the two symptoms are watched for, and the remedy is the one the firmware
offers: TRV.Calibrate, which drives the motor through its travel again. It
takes up to a minute, the valve answers nothing while it runs, and afterwards
the valve says in its own status whether it worked.

Three deliberate limits, because this moves hardware in somebody's flat:

  * the symptom has to hold for half an hour. Sun on a sensor, a second
    radiator, an open door between two rooms - all of those look like this for
    ten minutes.
  * at most one attempt per valve per twelve hours. If calibrating did not
    help, calibrating again will not either, and the thing to do is tell
    somebody rather than keep cycling a motor on a battery.
  * every attempt is written down and shown. An automatic action nobody can
    see afterwards is indistinguishable from a fault.

This runs on its own clock rather than inside the sampler, because it has
nothing to do with learning and must keep working when learning is switched
off.
"""

from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timedelta, timezone

# How often the symptoms are looked at. The same five minutes as the sampler:
# the condition being watched for is measured in half hours.
CHECK_EVERY_S = 300

# How far above its setpoint the valve's own reading may sit with the valve
# still open before that counts as a symptom.
OVERHEAT_K = 2.0

# The other direction: the valve says it is open this far, and the room is this
# much below its setpoint, and has been for a while.
STUCK_SHUT_POSITION = 50
UNDERHEAT_K = 2.0

# How long a symptom has to hold.
HOLD_MINUTES = 30

# How long before the same valve may be calibrated again.
RETRY_AFTER_HOURS = 12


def now():
    return datetime.now(timezone.utc)


def iso(moment):
    return moment.isoformat(timespec="seconds")


def parse(value):
    if not value:
        return None
    try:
        moment = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


# Which symptoms calibration is the answer to. Not all of them are: a valve
# that is holding its own setpoint correctly while the room is warmer than it
# thinks has nothing wrong with its motor, and driving that motor would be a
# cycle of a battery spent on the wrong problem.
CALIBRATION_SYMPTOMS = ("not_calibrated", "overheating", "underheating")


def symptom_of(room_c, valve):
    """What is wrong with this valve right now, as a (kind, detail) pair.

    Pure arithmetic on one reading, so it can be read, tested and argued with
    on its own. `None` means nothing is wrong - which is the normal answer.

    Two temperatures matter and they are not interchangeable. A valve regulates
    against the reading it has, which is its own sensor in the head, corrected
    towards an associated wall sensor by at most `max_compensation_C` - three
    degrees on these valves. So:

      * the valve's own reading against its setpoint says whether the valve is
        acting on what it can see. If it is two degrees over and still open,
        the position it reports does not describe where the pin is, and that is
        what calibration fixes.

      * the room's reading against the valve's says whether the valve can see
        the room. A head in a window niche on a cold radiator reads low - up to
        1.8 K low, measured in this flat - and if the correction is capped the
        valve holds its setpoint perfectly while the room sits above it.
        Nothing is wrong with the motor and calibrating would not help; what
        needs looking at is which sensor the valve is paired with.

    Getting these two the wrong way round would mean driving a stepper motor
    on a battery every twelve hours to fix a sensor association.
    """
    target = valve.get("target_C")
    position = valve.get("position")
    head_c = valve.get("current_C")
    if target is None or position is None:
        return None

    # The valve saying so itself beats any inference from temperatures.
    if "not_calibrated" in (valve.get("valve_errors") or []):
        return ("not_calibrated", "Das Ventil meldet selbst, dass es nicht kalibriert ist.")

    judged = head_c if head_c is not None else room_c
    if judged is None:
        return None

    if judged >= target + OVERHEAT_K and position > 0:
        return ("overheating",
                f"Das Ventil misst {judged:.1f} °C bei Sollwert {target:.1f} °C "
                f"und ist trotzdem {position} % offen.")

    if judged <= target - UNDERHEAT_K and position >= STUCK_SHUT_POSITION:
        return ("underheating",
                f"Das Ventil ist {position} % offen, misst aber nur {judged:.1f} °C "
                f"bei Sollwert {target:.1f} °C.")

    if (room_c is not None and head_c is not None
            and room_c >= target + OVERHEAT_K and position > 0):
        return ("sensor_mismatch",
                f"Der Raum hat {room_c:.1f} °C, das Ventil misst {head_c:.1f} °C "
                f"und hält damit seinen Sollwert von {target:.1f} °C ein. "
                f"Die Korrektur zum Wandfühler ist begrenzt — zu prüfen ist die "
                f"Zuordnung des Fühlers, nicht die Kalibrierung.")

    return None


class Watchdog:
    """Follows each valve's symptoms and calibrates when one has held.

    Given ways to open the database, read the rooms, read the settings and
    reach the gateway, so this file can be exercised without Flask or a valve.
    """

    def __init__(self, db_file, read_rooms, settings_of, gateway_for, on_report=None):
        self.db_file = db_file
        self.read_rooms = read_rooms
        self.settings_of = settings_of
        self.gateway_for = gateway_for
        self.on_report = on_report
        self._stop = threading.Event()
        self._thread = None

    # ── Lifecycle ────────────────────────────────────────────────────────────

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="watchdog", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _loop(self):
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception as error:                      # noqa: BLE001
                print(f"watchdog: {error}", flush=True)
            self._stop.wait(CHECK_EVERY_S)

    def _connect(self):
        connection = sqlite3.connect(self.db_file, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    # ── One pass ─────────────────────────────────────────────────────────────

    def tick(self):
        db = self._connect()
        try:
            settings = self.settings_of(db)
            seen = set()
            for room in self.read_rooms(db):
                climate = room.get("climate") or {}
                temperature = climate.get("temperature")
                for valve in climate.get("items") or []:
                    if valve.get("id") is None:
                        continue
                    seen.add(str(valve["id"]))
                    self.follow(db, room, valve, temperature, settings)
            # A valve that has been unpaired should not keep a symptom on file.
            self.forget_missing(db, seen)
            db.commit()
        finally:
            db.close()

    def follow(self, db, room, valve, temperature, settings):
        """Moves one valve's record on, and calibrates if the time has come."""
        trv_id = str(valve["id"])
        symptom = symptom_of(temperature, valve)
        row = db.execute("SELECT * FROM valve_watch WHERE trv_id = ?",
                         (trv_id,)).fetchone()

        if symptom is None:
            if row is not None and row["symptom"] is not None:
                # Recovered. The attempt history stays - it is the only record
                # that anything was done, and it is what rate-limits the next.
                db.execute("UPDATE valve_watch SET symptom = NULL, detail = NULL, "
                           "since = NULL, room_key = ?, updated_at = ? WHERE trv_id = ?",
                           (room.get("key"), iso(now()), trv_id))
            return

        kind, detail = symptom
        if row is None:
            db.execute(
                "INSERT INTO valve_watch (trv_id, room_key, symptom, detail, since, "
                " updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                (trv_id, room.get("key"), kind, detail, iso(now()), iso(now())))
            return

        if row["symptom"] != kind or row["since"] is None:
            # A different symptom is a different story and starts its own clock.
            db.execute("UPDATE valve_watch SET symptom = ?, detail = ?, since = ?, "
                       "room_key = ?, updated_at = ? WHERE trv_id = ?",
                       (kind, detail, iso(now()), room.get("key"), iso(now()), trv_id))
            return

        db.execute("UPDATE valve_watch SET detail = ?, room_key = ?, updated_at = ? "
                   "WHERE trv_id = ?", (detail, room.get("key"), iso(now()), trv_id))

        since = parse(row["since"])
        if since is None or (now() - since) < timedelta(minutes=HOLD_MINUTES):
            return
        if kind not in CALIBRATION_SYMPTOMS:
            # Reported, followed, but never acted on: calibration is not the
            # answer to this one.
            return
        if not self.may_attempt(row):
            return
        if not settings.get("auto_calibrate", True):
            # Switched off: the symptom is still followed and still reported,
            # only nothing is sent to the valve.
            return
        self.attempt(db, trv_id, room, kind, detail)

    def may_attempt(self, row):
        last = parse(row["last_attempt_at"]) if row else None
        return last is None or (now() - last) >= timedelta(hours=RETRY_AFTER_HOURS)

    def attempt(self, db, trv_id, room, kind, detail):
        """One calibration, recorded whether it worked or not."""
        gateway = self.gateway_for(db)
        stamp = iso(now())
        if gateway is None:
            result = "Kein Gateway eingerichtet"
        else:
            try:
                method = gateway.calibrate(trv_id)
                result = f"Kalibrierung angestoßen ({method})"
            except Exception as error:                      # noqa: BLE001
                result = f"Fehlgeschlagen: {error}"
        db.execute(
            "UPDATE valve_watch SET last_attempt_at = ?, attempts = attempts + 1, "
            "last_result = ?, updated_at = ? WHERE trv_id = ?",
            (stamp, result, stamp, trv_id))
        if self.on_report:
            self.on_report({"trv_id": trv_id, "room": room.get("key"),
                            "symptom": kind, "detail": detail, "result": result})

    def forget_missing(self, db, seen):
        rows = [row["trv_id"] for row in
                db.execute("SELECT trv_id FROM valve_watch").fetchall()]
        for trv_id in rows:
            if trv_id not in seen:
                db.execute("DELETE FROM valve_watch WHERE trv_id = ?", (trv_id,))

    # ── What the interface asks for ──────────────────────────────────────────

    def state(self, db):
        """Every valve's record, with whether calibrating is the answer to it.

        Shipped as a field rather than left to the reader: the screen offers a
        button and the notification service writes a sentence, and both have to
        agree with the code above about which symptoms a motor cycle fixes.
        """
        out = []
        for row in db.execute("SELECT * FROM valve_watch ORDER BY trv_id").fetchall():
            item = dict(row)
            item["calibration_helps"] = item.get("symptom") in CALIBRATION_SYMPTOMS
            out.append(item)
        return out
