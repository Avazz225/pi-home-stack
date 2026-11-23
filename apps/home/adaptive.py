"""Watching the rooms, and turning what is seen into a better heating plan.

The whole feature is one transformation of something that already exists. The
heating plan is mirrored into the BLU gateway as jobs with a time and a
setpoint; adaptive heating shifts that time earlier and lowers that setpoint.
Nothing else in the chain changes - and in particular the property that matters
most is kept: the gateway still holds the plan, so the heating runs on time with
the Pi switched off. The Pi only recomputes the numbers as it learns.

What runs here is a sampler. Every few minutes it writes down what each room
looks like, notices when a room has finished warming up, and folds that into two
averages per room. Which is all the "learning" amounts to - and all it needs to
amount to, because the thing being modelled is a straight line with two small
corrections.
"""

from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timedelta, timezone

import thermal
import weather as weather_api

# How often a room is written down. Five minutes is finer than a radiator can
# act and coarse enough that a year of it stays small - about a hundred thousand
# rows a year per room, a few megabytes.
SAMPLE_EVERY_S = 300
# How much history the quiet baseline is measured over, and how little of it
# will do. Fifty samples is about four hours - enough to have seen one quiet
# stretch, not enough to be sure, which is why the comparison is generous.
QUIET_WINDOW_DAYS = 7
MIN_QUIET_SAMPLES = 50
# The ninth decile rather than the longest silence: one outage a week ago should
# not raise the bar for the rest of it. Which also means a tenth of ordinary
# readings are older than this - hence the factor the service compares with.
QUIET_PERCENTILE = 0.9

# How long the raw samples are kept. The averages outlive them; the samples are
# only needed until the episode they belong to has been counted.
KEEP_SAMPLES_DAYS = 14


def now():
    return datetime.now(timezone.utc)


def iso(moment):
    return moment.isoformat(timespec="seconds")


class Adaptive:
    """The sampler and the model it feeds.

    Given a way to open the database and a way to read the flat, so that this
    file can be exercised without Flask - which is what the tests do.
    """

    def __init__(self, db_file, read_rooms, settings_of, on_model_change=None):
        self.db_file = db_file
        self.read_rooms = read_rooms
        self.settings_of = settings_of
        self.on_model_change = on_model_change
        self._stop = threading.Event()
        self._thread = None

    # ── Lifecycle ────────────────────────────────────────────────────────────

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="adaptive", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _loop(self):
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception as error:                      # noqa: BLE001
                # A sampler that dies takes every future measurement with it and
                # says nothing. Whatever went wrong, the next tick tries again.
                print(f"adaptive: {error}", flush=True)
            self._stop.wait(SAMPLE_EVERY_S)

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
            if not settings.get("learning"):
                return
            forecast = self.forecast(db, settings)
            outside, radiation = forecast.at(now())
            rooms = self.read_rooms(db)
            changed = False
            for room in rooms:
                self.record(db, room, outside, radiation)
                changed = self.advance(db, room) or changed
                self.measure_quiet(db, room["key"])
            self.prune(db)
            db.commit()
            if changed and self.on_model_change:
                self.on_model_change()
        finally:
            db.close()

    def forecast(self, db, settings=None):
        settings = settings or self.settings_of(db)
        if not settings.get("weather"):
            # Switched off: the neutral pair, which the factor treats as the
            # reference, so the plan behaves as if there were no weather at all.
            return weather_api.Forecast()
        return weather_api.fetch(settings.get("latitude"), settings.get("longitude"))

    def record(self, db, room, outside, radiation):
        climate = room.get("climate") or {}
        if climate.get("temperature") is None:
            return
        db.execute(
            "INSERT INTO room_sample "
            "(room_key, measured_at, temperature, target, valve_position, outside, "
            " radiation, age_s) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (room["key"], iso(now()), climate.get("temperature"), climate.get("trv_target"),
             climate.get("valve_position"), outside, radiation, climate.get("age_s")))

    # ── Following one heat-up from beginning to end ──────────────────────────
    #
    # A climb is watched as it happens rather than looked for afterwards. The
    # room sits "idle" until it is asked for more than it has; from then it is
    # "climbing", and the beginning of the climb - the moment and the
    # temperature - is written down once and not recomputed. When it arrives,
    # that single stretch becomes one measurement. Then it "settles" for
    # three quarters of an hour, which gives the overshoot, and goes back to
    # idle.
    #
    # The point of keeping state is that an episode is closed exactly once.
    # Deriving it from the last six hours of samples instead meant finding the
    # same climb on every pass, and because the window only ever held its tail,
    # finding it shorter and slower each time.

    def watch_of(self, db, room_key):
        row = db.execute("SELECT * FROM heating_watch WHERE room_key = ?",
                         (room_key,)).fetchone()
        return dict(row) if row else {"room_key": room_key, "state": "idle"}

    def _write_watch(self, db, room_key, state, **fields):
        values = (room_key, state, fields.get("target_c"), fields.get("started_at"),
                  fields.get("from_c"), fields.get("reached_at"), fields.get("peak_c"),
                  iso(now()))
        db.execute(
            "INSERT INTO heating_watch (room_key, state, target_c, started_at, from_c, "
            " reached_at, peak_c, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(room_key) DO UPDATE SET state = excluded.state, "
            " target_c = excluded.target_c, started_at = excluded.started_at, "
            " from_c = excluded.from_c, reached_at = excluded.reached_at, "
            " peak_c = excluded.peak_c, updated_at = excluded.updated_at", values)

    def advance(self, db, room):
        """Moves this room's watch on by one observation.

        Returns whether a measurement was folded into the model, so the caller
        knows when the heating plan is worth recomputing.
        """
        climate = room.get("climate") or {}
        temperature = climate.get("temperature")
        target = climate.get("trv_target")
        watch = self.watch_of(db, room["key"])
        state = watch.get("state") or "idle"
        moment = now()

        if temperature is None:
            # Out of sight. A climb whose room cannot be read is not a
            # measurement - the minutes would keep running while the degrees
            # stopped, and the rate would come out too slow.
            if state != "idle":
                self._write_watch(db, room["key"], "idle")
            return False

        if state == "climbing":
            return self._climbing(db, room, watch, temperature, target, moment)
        if state == "settling":
            return self._settling(db, room, watch, temperature, target, moment)
        return self._maybe_start(db, room, temperature, target, moment)

    def _maybe_start(self, db, room, temperature, target, moment):
        """Idle: begin a climb once the room is asked for more than it has."""
        if target is None or target - temperature < thermal.MIN_RISE_C:
            return False
        self._write_watch(db, room["key"], "climbing", target_c=target,
                          started_at=iso(moment), from_c=temperature)
        return False

    def _climbing(self, db, room, watch, temperature, target, moment):
        started = thermal.parse_stamp(watch.get("started_at"))
        wanted = watch.get("target_c")
        if started is None or wanted is None:
            self._write_watch(db, room["key"], "idle")
            return False

        if target is None or abs(target - wanted) > 0.05:
            # The plan moved mid-climb. What was measured is no longer what was
            # asked for, so this one is dropped - and a new one may start at
            # once, because a raised target is the beginning of a climb.
            self._write_watch(db, room["key"], "idle")
            return self._maybe_start(db, room, temperature, target, moment)

        if temperature < watch.get("from_c", temperature):
            # Still falling. The climb begins at the bottom, not at the moment
            # the valve was told to open: the minutes before the room turns
            # around belong to the cooling, not to the heating.
            self._write_watch(db, room["key"], "climbing", target_c=wanted,
                              started_at=iso(moment), from_c=temperature)
            return False

        if temperature >= wanted - thermal.ARRIVED_TOLERANCE_C:
            return self._arrived(db, room, watch, started, wanted, temperature, moment)

        minutes = (moment - started).total_seconds() / 60
        if minutes > thermal.MAX_MINUTES:
            # Five hours and not there. Something is open, or the radiator is
            # cold. Written down as a discarded episode, because an hour spent
            # heating nothing is worth being able to see, and then forgotten.
            self._record_episode(db, room["key"], "heatup", started, moment,
                                 watch.get("from_c"), temperature, minutes, None)
            self._write_watch(db, room["key"], "idle")
            return False

        self._write_watch(db, room["key"], "climbing", target_c=wanted,
                          started_at=watch.get("started_at"), from_c=watch.get("from_c"))
        return False

    def _arrived(self, db, room, watch, started, wanted, temperature, moment):
        """The room has reached its target: one measurement, then settle."""
        minutes = (moment - started).total_seconds() / 60
        from_c = watch.get("from_c")
        rise = temperature - from_c if from_c is not None else None
        outside, radiation = self._mean_conditions(db, room["key"], started, moment)
        rate = thermal.normalised_rate(rise, minutes, outside, radiation)
        self._record_episode(db, room["key"], "heatup", started, moment, from_c,
                             temperature, minutes, rate, outside, radiation)
        if rate is not None:
            self._fold(db, room["key"], "heat_rate", rate)
        self._write_watch(db, room["key"], "settling", target_c=wanted,
                          reached_at=iso(moment), peak_c=temperature)
        return rate is not None

    def _settling(self, db, room, watch, temperature, target, moment):
        """After arrival: how much further the room drifts once the valve shuts."""
        reached = thermal.parse_stamp(watch.get("reached_at"))
        wanted = watch.get("target_c")
        if reached is None or wanted is None:
            self._write_watch(db, room["key"], "idle")
            return False

        if target is None or abs(target - wanted) > 0.05:
            self._write_watch(db, room["key"], "idle")
            return self._maybe_start(db, room, temperature, target, moment)

        peak = max(watch.get("peak_c") or temperature, temperature)
        if (moment - reached).total_seconds() / 60 < thermal.OVERSHOOT_WINDOW_MIN:
            self._write_watch(db, room["key"], "settling", target_c=wanted,
                              reached_at=watch.get("reached_at"), peak_c=peak)
            return False

        overshoot = peak - wanted
        outside, radiation = self._mean_conditions(db, room["key"], reached, moment)
        keep = 0 <= overshoot <= thermal.MAX_OVERSHOOT_C
        self._record_episode(db, room["key"], "overshoot", reached, moment, wanted,
                             peak, thermal.OVERSHOOT_WINDOW_MIN,
                             overshoot if keep else None, outside, radiation)
        if keep:
            self._fold(db, room["key"], "overshoot", overshoot)
        self._write_watch(db, room["key"], "idle")
        return keep

    def _mean_conditions(self, db, room_key, start, end):
        """The average weather while the episode was running.

        Taken from the samples rather than asked for again: what matters is the
        weather during the climb, and by the time it is judged the forecast has
        moved on. Averaged rather than sampled at the middle, because a climb
        often crosses the hour in which the sun came out.
        """
        row = db.execute(
            "SELECT AVG(outside) AS outside, AVG(radiation) AS radiation "
            "FROM room_sample WHERE room_key = ? AND measured_at >= ? "
            "AND measured_at <= ?", (room_key, iso(start), iso(end))).fetchone()
        return (row["outside"], row["radiation"]) if row else (None, None)

    def _record_episode(self, db, room_key, kind, started, finished, from_c, to_c,
                        minutes, value, outside=None, radiation=None):
        """One finished episode, kept whether it counted or not.

        A discarded measurement is worth keeping: "nineteen climbs, two of them
        thrown away" is a sentence somebody can act on, and an empty history
        with a suspicious average is not.
        """
        db.execute(
            "INSERT INTO heating_episode "
            "(room_key, kind, started_at, finished_at, from_c, to_c, minutes, value, "
            " outside, radiation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (room_key, kind, iso(started), iso(finished), from_c, to_c,
             round(minutes, 1) if minutes is not None else None, value,
             outside, radiation))

    def _fold(self, db, room_key, column, observed):
        row = db.execute("SELECT * FROM heating_model WHERE room_key = ?",
                         (room_key,)).fetchone()
        previous = row[column] if row else None
        count = (row[f"{column}_samples"] if row else 0) + 1
        value = thermal.ema(previous, observed)
        if row is None:
            db.execute("INSERT INTO heating_model (room_key) VALUES (?)", (room_key,))
        db.execute(
            f"UPDATE heating_model SET {column} = ?, {column}_samples = ?, updated_at = ? "
            f"WHERE room_key = ?", (value, count, iso(now()), room_key))

    def measure_quiet(self, db, room_key):
        """How old this room's readings normally get.

        Measured from the ages written down rather than from the gap between
        changes, because that is also how the age shown on screen is measured -
        comparing the two only means anything if they are the same quantity.
        """
        since = iso(now() - timedelta(days=QUIET_WINDOW_DAYS))
        count = db.execute(
            "SELECT COUNT(*) AS n FROM room_sample WHERE room_key = ? "
            "AND age_s IS NOT NULL AND measured_at >= ?", (room_key, since)).fetchone()["n"]
        if count < MIN_QUIET_SAMPLES:
            return
        offset = int(count * QUIET_PERCENTILE)
        row = db.execute(
            "SELECT age_s FROM room_sample WHERE room_key = ? AND age_s IS NOT NULL "
            "AND measured_at >= ? ORDER BY age_s LIMIT 1 OFFSET ?",
            (room_key, since, min(offset, count - 1))).fetchone()
        if row is None:
            return
        db.execute(
            "INSERT INTO room_quiet (room_key, quiet_s, samples, updated_at) "
            "VALUES (?, ?, ?, ?) ON CONFLICT(room_key) DO UPDATE SET "
            "quiet_s = excluded.quiet_s, samples = excluded.samples, "
            "updated_at = excluded.updated_at",
            (room_key, int(row["age_s"]), count, iso(now())))

    def prune(self, db):
        db.execute("DELETE FROM room_sample WHERE measured_at < ?",
                   (iso(now() - timedelta(days=KEEP_SAMPLES_DAYS)),))

    # ── What the plan asks for ───────────────────────────────────────────────

    def model(self, db, room_key=None):
        query = "SELECT * FROM heating_model"
        args = ()
        if room_key:
            query += " WHERE room_key = ?"
            args = (room_key,)
        return {row["room_key"]: dict(row)
                for row in db.execute(query, args).fetchall()}
