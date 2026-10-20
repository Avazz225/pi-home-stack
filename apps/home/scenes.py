"""Running a lighting scene: a look, a length, and an end that actually arrives.

The end is the whole difficulty. Switching lamps on is one call; switching them
off in forty minutes means something has to still be there in forty minutes.
Three ways to do that, and the choice matters:

  a timer in the request        dies with the worker that served the request
  a thread holding the state    dies with the service, and updates restart it
  a row that says when          survives both, and is what this uses

So a started scene is a row with an end time. One thread watches those rows; if
the service is restarted the row is still there, and a run whose end has passed
is finished on the next tick rather than burning until somebody notices.

The dimming is left to the bridge. Asking Hue for a transition is one call that
it then runs by itself, where stepping the brightness down from here would be
hundreds of calls for one fade - and would stop the moment this service did.
Only a fade longer than the bridge accepts in one go is re-issued, in pieces.
"""

from __future__ import annotations

import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone

import hue as hue_api

# How often the running scenes are looked at. Short enough that an end lands
# within a few seconds of its time, long enough to be invisible: the tick does
# nothing at all unless a run is active.
TICK_S = 2
# While a long fade is in progress, the bridge is told again this often, each
# time with the remaining duration. Only matters beyond MAX_TRANSITION_MS.
REFRESH_FADE_S = 120
# The floor a fade dims to before the end. Not zero: Hue reads 0 % as "off", and
# going dark a moment early is exactly what the fade is meant to avoid.
FADE_FLOOR = 1.0


def now():
    return datetime.now(timezone.utc)


def iso(moment):
    return moment.isoformat(timespec="seconds")


def parse(value):
    if not value:
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def parse_xy(value):
    if not value:
        return None
    try:
        x, y = (float(part) for part in str(value).split(","))
    except (TypeError, ValueError):
        return None
    return [x, y]


class SceneRunner:
    """Watches the started scenes and ends them on time.

    Owns no state of its own on purpose - everything it needs is in the
    database, so this object can be thrown away and remade without a run
    noticing. It is given a way to open the database and a way to reach the
    bridge rather than importing either: the service decides where those come
    from, and this file stays testable without Flask.
    """

    def __init__(self, db_file, bridge_for):
        self.db_file = db_file
        self.bridge_for = bridge_for
        self._stop = threading.Event()
        self._thread = None

    # ── Lifecycle ────────────────────────────────────────────────────────────

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="scene-runner", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _loop(self):
        while not self._stop.is_set():
            try:
                self.tick()
            except Exception as error:                      # noqa: BLE001
                # A background thread that dies takes every future end with it,
                # and nothing would say so. Whatever went wrong, the next tick
                # tries again.
                print(f"scene runner: {error}", flush=True)
            self._stop.wait(TICK_S)

    def _connect(self):
        connection = sqlite3.connect(self.db_file, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    # ── Applying a scene ─────────────────────────────────────────────────────

    def _lights_of(self, db, scene_id):
        return db.execute(
            "SELECT * FROM scene_light WHERE scene_id = ?", (scene_id,)).fetchall()

    def _apply(self, db, scene_id, *, brightness=None, transition_ms=None, on=True):
        """Sends one scene's look to its lamps.

        Returns what failed rather than raising: one unreachable lamp must not
        cost the scene the other five, and the reason belongs in the run so it
        can be read afterwards.
        """
        bridge = self.bridge_for(db)
        if bridge is None:
            return ["Hue ist nicht eingerichtet"]

        problems = []
        for light in self._lights_of(db, scene_id):
            level = brightness if brightness is not None else light["brightness"]
            try:
                bridge.set_light(
                    light["light_id"],
                    on=on,
                    brightness=level,
                    # Colour only while turning on: re-sending it with every
                    # fade step would be noise the lamp has to act on.
                    mirek=light["mirek"] if transition_ms is None else None,
                    xy=parse_xy(light["xy"]) if transition_ms is None else None,
                    transition_ms=transition_ms,
                )
            except hue_api.HueError as error:
                problems.append(f"{light['light_id']}: {error}")
        return problems

    # ── Starting and stopping ────────────────────────────────────────────────

    def start_scene(self, db, scene_id):
        scene = db.execute("SELECT * FROM scene WHERE id = ?", (scene_id,)).fetchone()
        if scene is None:
            raise LookupError("Szene gibt es nicht")

        # One run per scene. Starting again restarts the clock, which is what
        # pressing the tile a second time plainly means.
        db.execute("UPDATE scene_run SET state = 'stopped' "
                   "WHERE scene_id = ? AND state = 'running'", (scene_id,))

        started = now()
        ends = started + timedelta(seconds=scene["duration_s"]) if scene["duration_s"] else None
        problems = self._apply(db, scene_id)
        cursor = db.execute(
            "INSERT INTO scene_run (scene_id, started_at, ends_at, state, note) "
            "VALUES (?, ?, ?, ?, ?)",
            (scene_id, iso(started), iso(ends) if ends else None,
             "failed" if problems and len(problems) else "running",
             "; ".join(problems) or None))
        db.commit()
        return cursor.lastrowid, problems

    def stop_scene(self, db, scene_id, turn_off=True):
        scene = db.execute("SELECT * FROM scene WHERE id = ?", (scene_id,)).fetchone()
        problems = []
        if scene is not None and turn_off:
            problems = self._apply(db, scene_id, on=False, brightness=None)
        db.execute("UPDATE scene_run SET state = 'stopped' "
                   "WHERE scene_id = ? AND state = 'running'", (scene_id,))
        db.commit()
        return problems

    # ── The tick ─────────────────────────────────────────────────────────────

    def tick(self):
        db = self._connect()
        try:
            runs = db.execute(
                "SELECT r.*, s.fade_s, s.turn_off FROM scene_run r "
                "JOIN scene s ON s.id = r.scene_id WHERE r.state = 'running'").fetchall()
            moment = now()
            for run in runs:
                ends = parse(run["ends_at"])
                if ends is None:
                    continue                      # a scene without an end
                if moment >= ends:
                    self._finish(db, run)
                    continue
                fade_s = run["fade_s"] or 0
                if fade_s <= 0:
                    continue
                if moment < ends - timedelta(seconds=fade_s):
                    continue
                self._fade(db, run, ends, moment)
            db.commit()
        finally:
            db.close()

    def _fade(self, db, run, ends, moment):
        started = parse(run["fade_started_at"])
        remaining_ms = int((ends - moment).total_seconds() * 1000)
        if remaining_ms <= 0:
            return
        # Told once, and again only when the bridge cannot hold the whole ramp
        # in one go.
        if started is not None and (moment - started).total_seconds() < REFRESH_FADE_S:
            return
        if started is not None and remaining_ms <= hue_api.MAX_TRANSITION_MS:
            return
        self._apply(db, run["scene_id"], brightness=FADE_FLOOR, transition_ms=remaining_ms)
        db.execute("UPDATE scene_run SET fade_started_at = ? WHERE id = ?",
                   (iso(moment), run["id"]))

    def _finish(self, db, run):
        problems = []
        if run["turn_off"]:
            problems = self._apply(db, run["scene_id"], on=False, brightness=None)
        db.execute("UPDATE scene_run SET state = ?, note = ? WHERE id = ?",
                   ("failed" if problems else "done", "; ".join(problems) or run["note"],
                    run["id"]))

    # ── What the interface shows ─────────────────────────────────────────────

    def running(self, db):
        """The active run per scene, with the seconds left.

        Computed here rather than in the browser: a tablet whose clock is off by
        a minute would otherwise count down to the wrong moment.
        """
        rows = db.execute(
            "SELECT * FROM scene_run WHERE state = 'running' ORDER BY started_at").fetchall()
        moment = now()
        out = {}
        for row in rows:
            ends = parse(row["ends_at"])
            out[row["scene_id"]] = {
                "run_id": row["id"],
                "started_at": row["started_at"],
                "ends_at": row["ends_at"],
                "remaining_s": max(0, int((ends - moment).total_seconds())) if ends else None,
                "fading": bool(row["fade_started_at"]),
            }
        return out
