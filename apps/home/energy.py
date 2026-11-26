"""Reading the sockets, and turning a lifetime counter into a day's use.

A Shelly plug reports how many watt-hours it has passed since it was made, and
never how much it passed today. So what is stored is the counter, and what is
shown is the difference between two of them.

Storing the counter rather than the difference is what makes a missed reading
harmless: if the Pi is off for an hour, the next reading's difference covers
the hour, and nothing is lost. The cost is that two things have to be handled
rather than one:

  a counter that goes backwards   a factory reset, or a plug swapped for
                                  another at the same address. Not negative
                                  consumption - the step is dropped and the
                                  new value becomes the baseline.
  a step that is impossible       more than a 3.7 kW socket could pass in the
                                  time since the last reading. A firmware bug
                                  or a clock jump, and counting it would put a
                                  spike in the day that never happened.

The day's totals are accumulated as the readings arrive rather than computed
from the samples on demand, so the raw samples can be thrown away after a week
while a year of daily figures stays a few hundred rows.
"""

from __future__ import annotations

import sqlite3
import threading
from datetime import datetime, timedelta, timezone

import plugs as plug_api

# How often each socket is read, and how often a reading is written down.
#
# These are deliberately different. The overview is polled every fifteen
# seconds and must never make its own call to a plug - that fan-out is what
# produced Bad Gateways from the BLU gateway - so this thread is the only
# thing that talks to a socket, and the overview reads what it last saw. That
# wants a short poll, or a lamp switched at the wall takes five minutes to
# show. Writing a sample that often would store a hundred thousand rows a year
# per socket to answer a question measured in kilowatt-hours, so the books are
# kept every five minutes and the rest of the readings only refresh the
# screen.
POLL_EVERY_S = 20
SAMPLE_EVERY_S = 300

# How long the raw readings are kept. Long enough for a few days of power
# curve; the daily totals outlive them.
KEEP_SAMPLES_DAYS = 7

# The most a single socket may plausibly have passed since the last reading.
# A German socket is fused at 16 A, so 3.7 kW is the ceiling; the allowance is
# generous because a reading can be late.
MAX_WATTS = 3700


def now():
    return datetime.now(timezone.utc)


def iso(moment):
    return moment.isoformat(timespec="seconds")


def day_of(moment):
    return moment.date().isoformat()


def plausible_step(delta_wh, seconds):
    """Whether this much energy could really have passed in this much time."""
    if delta_wh is None or delta_wh < 0:
        return False
    if seconds is None or seconds <= 0:
        # Two readings at the same second cannot carry energy between them.
        return delta_wh == 0
    return delta_wh <= MAX_WATTS * (seconds / 3600.0) + 1.0


class Meter:
    """Reads every socket on a timer and keeps the books.

    Given a way to open the database and a way to build a client for a row, so
    this file can be exercised without a plug on the network.
    """

    def __init__(self, db_file, plug_for=None):
        self.db_file = db_file
        self.plug_for = plug_for or self.default_client
        self._stop = threading.Event()
        self._thread = None
        # The last reading of each socket, by plug id, for whoever is drawing
        # the screen. Replaced wholesale on each poll, so a reader never sees
        # half of one pass and half of the next.
        self._lock = threading.Lock()
        self._latest = {}
        self._sampled_at = None

    @staticmethod
    def default_client(row):
        return plug_api.Plug(row["address"], row["password"], row["gen"])

    # ── Lifecycle ────────────────────────────────────────────────────────────

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="energy", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _loop(self):
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception as error:                      # noqa: BLE001
                # A meter that dies takes every future reading with it and
                # says nothing. Whatever went wrong, the next tick tries again.
                print(f"energy: {error}", flush=True)
            self._stop.wait(POLL_EVERY_S)

    def _connect(self):
        connection = sqlite3.connect(self.db_file, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    # ── One pass ─────────────────────────────────────────────────────────────

    def tick(self):
        """One pass over every socket: read them all, book them now and then."""
        db = self._connect()
        try:
            rows = db.execute("SELECT * FROM plug ORDER BY id").fetchall()
            moment = now()
            keep = self._sampled_at is None or (
                (moment - self._sampled_at).total_seconds() >= SAMPLE_EVERY_S)
            seen = {}
            for row in rows:
                try:
                    status = self.plug_for(row).status()
                except plug_api.PlugError as error:
                    # One socket behind a sleeping access point must not cost
                    # the other four their reading, and the reason belongs on
                    # screen beside that socket rather than in a log nobody
                    # opens.
                    seen[row["id"]] = {"error": str(error), "read_at": iso(moment)}
                    continue
                seen[row["id"]] = {**status, "error": None, "read_at": iso(moment)}
                if keep:
                    self.record(db, row["id"], status)
            if keep:
                self._sampled_at = moment
                self.prune(db)
                db.commit()
            with self._lock:
                self._latest = seen
        finally:
            db.close()

    def latest(self):
        """The last reading of every socket, for the screen."""
        with self._lock:
            return dict(self._latest)

    def refresh(self, db, plug_id):
        """Reads one socket now, because somebody just switched it.

        Without this the toggle would snap back to the old state on the next
        refresh and only correct itself twenty seconds later.
        """
        row = db.execute("SELECT * FROM plug WHERE id = ?", (plug_id,)).fetchone()
        if row is None:
            return None
        try:
            status = self.plug_for(row).status()
        except plug_api.PlugError as error:
            reading = {"error": str(error), "read_at": iso(now())}
        else:
            reading = {**status, "error": None, "read_at": iso(now())}
        with self._lock:
            self._latest = {**self._latest, plug_id: reading}
        return reading

    def record(self, db, plug_id, status):
        """One reading, and what it adds to today."""
        moment = now()
        previous = db.execute(
            "SELECT measured_at, energy_wh FROM plug_sample WHERE plug_id = ? "
            "ORDER BY measured_at DESC LIMIT 1", (plug_id,)).fetchone()

        db.execute(
            "INSERT INTO plug_sample (plug_id, measured_at, power_w, energy_wh, on_state) "
            "VALUES (?, ?, ?, ?, ?)",
            (plug_id, iso(moment), status.get("power_w"), status.get("energy_wh"),
             1 if status.get("on") else 0))

        counter = status.get("energy_wh")
        if counter is None or previous is None or previous["energy_wh"] is None:
            # Nothing to compare against yet. The first reading of a socket is
            # a baseline, not a consumption.
            return 0.0

        delta = float(counter) - float(previous["energy_wh"])
        seconds = _seconds_between(previous["measured_at"], moment)
        if not plausible_step(delta, seconds):
            return 0.0
        self.add_to_day(db, plug_id, day_of(moment), delta)
        return delta

    def add_to_day(self, db, plug_id, day, delta_wh):
        db.execute(
            "INSERT INTO plug_day (plug_id, day, energy_wh, updated_at) "
            "VALUES (?, ?, ?, ?) ON CONFLICT(plug_id, day) DO UPDATE SET "
            "energy_wh = energy_wh + excluded.energy_wh, updated_at = excluded.updated_at",
            (plug_id, day, float(delta_wh), iso(now())))

    def prune(self, db):
        db.execute("DELETE FROM plug_sample WHERE measured_at < ?",
                   (iso(now() - timedelta(days=KEEP_SAMPLES_DAYS)),))

    # ── What the interface asks for ──────────────────────────────────────────

    def days(self, db, since_days=7):
        """Each socket's use per day, newest day last."""
        first = (now() - timedelta(days=since_days - 1)).date().isoformat()
        return [dict(row) for row in db.execute(
            "SELECT plug_id, day, energy_wh FROM plug_day WHERE day >= ? "
            "ORDER BY day", (first,)).fetchall()]

    def today(self, db):
        """Watt-hours per socket so far today."""
        return {row["plug_id"]: row["energy_wh"] for row in db.execute(
            "SELECT plug_id, energy_wh FROM plug_day WHERE day = ?",
            (day_of(now()),)).fetchall()}


def _seconds_between(stamp, moment):
    try:
        before = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if before.tzinfo is None:
        before = before.replace(tzinfo=timezone.utc)
    return (moment - before).total_seconds()
