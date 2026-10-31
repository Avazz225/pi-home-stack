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
# How long the raw samples are kept. The averages outlive them; the samples are
# only needed until the episode they belong to has been counted.
KEEP_SAMPLES_DAYS = 14
# A room is only considered for an episode once this much history exists.
EPISODE_LOOKBACK_MIN = 360


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
                changed = self.learn(db, room) or changed
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
            "(room_key, measured_at, temperature, target, valve_position, outside, radiation) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (room["key"], iso(now()), climate.get("temperature"), climate.get("trv_target"),
             climate.get("valve_position"), outside, radiation))

    def samples(self, db, room_key, since_minutes=EPISODE_LOOKBACK_MIN):
        since = iso(now() - timedelta(minutes=since_minutes))
        return [dict(row) for row in db.execute(
            "SELECT * FROM room_sample WHERE room_key = ? AND measured_at >= ? "
            "ORDER BY measured_at", (room_key, since)).fetchall()]

    # ── Turning samples into the two numbers ─────────────────────────────────

    def learn(self, db, room):
        """Looks for a finished heat-up this room has not been credited with.

        Returns whether anything was learned, so the caller knows when the plan
        is worth recomputing.
        """
        climate = room.get("climate") or {}
        target = climate.get("trv_target")
        if target is None:
            return False
        samples = self.samples(db, room["key"])
        if len(samples) < 3:
            return False

        episode = thermal.find_heatup(samples, target)
        if episode is None:
            return False

        # Counted once. The same climb stays visible in the samples for hours,
        # and crediting it on every pass would drag the average onto one morning.
        already = db.execute(
            "SELECT 1 FROM heating_episode WHERE room_key = ? AND kind = 'heatup' "
            "AND started_at = ?", (room["key"], iso(episode["started_at"]))).fetchone()
        if already:
            return self.learn_overshoot(db, room, target, episode, samples)

        middle = episode["started_at"] + timedelta(minutes=episode["minutes"] / 2)
        outside, radiation = self._conditions(samples, middle)
        rate = thermal.normalised_rate(episode["rise_c"], episode["minutes"],
                                       outside, radiation)
        if rate is None:
            # Recorded even when discarded: a measurement that was thrown away
            # is worth being able to look at, and recording it also stops the
            # same climb being reconsidered every five minutes.
            self._write_episode(db, room["key"], "heatup", episode, None, outside, radiation)
            return False

        self._write_episode(db, room["key"], "heatup", episode, rate, outside, radiation)
        self._fold(db, room["key"], "heat_rate", rate)
        return True

    def learn_overshoot(self, db, room, target, episode, samples):
        overshoot = thermal.find_overshoot(samples, target, episode["reached_at"])
        if overshoot is None:
            return False
        # Only once the window has closed, or the peak has not happened yet.
        if now() < episode["reached_at"] + timedelta(minutes=thermal.OVERSHOOT_WINDOW_MIN):
            return False
        already = db.execute(
            "SELECT 1 FROM heating_episode WHERE room_key = ? AND kind = 'overshoot' "
            "AND started_at = ?", (room["key"], iso(episode["reached_at"]))).fetchone()
        if already:
            return False
        outside, radiation = self._conditions(samples, episode["reached_at"])
        db.execute(
            "INSERT INTO heating_episode "
            "(room_key, kind, started_at, finished_at, from_c, to_c, minutes, value, "
            " outside, radiation) VALUES (?, 'overshoot', ?, ?, ?, ?, ?, ?, ?, ?)",
            (room["key"], iso(episode["reached_at"]),
             iso(episode["reached_at"] + timedelta(minutes=thermal.OVERSHOOT_WINDOW_MIN)),
             target, target + overshoot, thermal.OVERSHOOT_WINDOW_MIN, overshoot,
             outside, radiation))
        self._fold(db, room["key"], "overshoot", overshoot)
        return True

    def _conditions(self, samples, moment):
        """The weather as it was written down nearest that moment.

        Taken from the samples rather than asked for again: what matters is the
        weather during the climb, and by the time it is judged the forecast has
        moved on.
        """
        best, distance = (None, None), None
        for sample in samples:
            stamp = thermal.parse_stamp(sample["measured_at"])
            if stamp is None:
                continue
            gap = abs((stamp - moment).total_seconds())
            if distance is None or gap < distance:
                distance = gap
                best = (sample["outside"], sample["radiation"])
        return best

    def _write_episode(self, db, room_key, kind, episode, value, outside, radiation):
        db.execute(
            "INSERT INTO heating_episode "
            "(room_key, kind, started_at, finished_at, from_c, to_c, minutes, value, "
            " outside, radiation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (room_key, kind, iso(episode["started_at"]), iso(episode["reached_at"]),
             episode["from_c"], episode["to_c"], episode["minutes"], value,
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
