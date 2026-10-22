"""Lighting scenes: the look goes out, and the end arrives.

Run against a stand-in bridge, not a real one. What is worth proving here has
nothing to do with Hue: that a started scene ends at its time, that the ramp is
handed to the bridge once rather than stepped from here, that a restart does not
lose a run, and that one unreachable lamp does not cost the scene the others.

The timings are seconds rather than minutes so the whole file runs in about ten.
"""

import importlib.util
import os
import sqlite3
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
HOME = os.path.join(HERE, "..", "apps", "home")

failed = 0


def check(label, got, want):
    global failed
    if got == want:
        print(f"PASS  {label}")
    else:
        print(f"FAIL  {label}\n        expected: {want!r}\n        got:      {got!r}")
        failed = 1


def ok(label, condition, detail=""):
    check(label, bool(condition), True) if condition else check(label, detail or False, True)


class FakeBridge:
    """Records what it was asked to do, and can be told to refuse one lamp."""

    def __init__(self, failing=()):
        self.calls = []
        self.failing = set(failing)

    def set_light(self, light_id, on=None, brightness=None, mirek=None,
                  xy=None, transition_ms=None):
        if light_id in self.failing:
            raise hue.HueError("Lampe antwortet nicht")
        self.calls.append({"id": light_id, "on": on, "brightness": brightness,
                           "mirek": mirek, "xy": xy, "transition_ms": transition_ms})

    def lights(self):
        return []


def load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HOME, f"{name}.py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


work = tempfile.mkdtemp(prefix="phs-scenes-")
os.environ["HOME_DATA_DIR"] = work
sys.path.insert(0, HOME)

hue = load("hue")
scenes = load("scenes")

# ── The colour conversion, which has one right answer ────────────────────────

check("red lands on the red primary", hue.rgb_to_xy(255, 0, 0), [0.7006, 0.2993])
check("green", hue.rgb_to_xy(0, 255, 0), [0.1724, 0.7468])
check("blue", hue.rgb_to_xy(0, 0, 255), [0.1355, 0.0399])
check("white is D65", hue.rgb_to_xy(255, 255, 255), [0.3227, 0.329])
# A colour with no light in it has no chromaticity; white beats a division by
# zero, and the lamp is being switched off in that case anyway.
check("black does not divide by zero", hue.rgb_to_xy(0, 0, 0), [0.3127, 0.329])

check("xy round trip", scenes.parse_xy("0.4500,0.4100"), [0.45, 0.41])
check("a broken xy is no xy", scenes.parse_xy("kaputt"), None)
check("no xy is no xy", scenes.parse_xy(None), None)

# ── A database with one scene ────────────────────────────────────────────────

db_file = os.path.join(work, "home.db")
with open(os.path.join(HOME, "schema.sql"), encoding="utf-8") as handle:
    schema = handle.read()

conn = sqlite3.connect(db_file)
conn.row_factory = sqlite3.Row
conn.executescript(schema)
conn.execute("INSERT INTO scene (id, name, duration_s, fade_s, turn_off) "
             "VALUES (1, 'Lesen', 6, 3, 1)")
for light, level in (("l1", 80.0), ("l2", 40.0)):
    conn.execute("INSERT INTO scene_light (scene_id, light_id, brightness, mirek, xy) "
                 "VALUES (1, ?, ?, 300, '0.4500,0.4100')", (light, level))
conn.commit()

bridge = FakeBridge()
runner = scenes.SceneRunner(db_file, lambda db: bridge)

# ── Starting ─────────────────────────────────────────────────────────────────

run_id, problems = runner.start_scene(conn, 1)
check("starting reports no trouble", problems, [])
check("both lamps were addressed", sorted(c["id"] for c in bridge.calls), ["l1", "l2"])
check("each got its own brightness",
      sorted((c["id"], c["brightness"]) for c in bridge.calls),
      [("l1", 80.0), ("l2", 40.0)])
check("colour goes out with the look", bridge.calls[0]["xy"], [0.45, 0.41])
check("and so does the colour temperature", bridge.calls[0]["mirek"], 300)
check("no transition on the way in", bridge.calls[0]["transition_ms"], None)

state = runner.running(conn)
check("the scene counts as running", 1 in state, True)
ok("and has time left", state[1]["remaining_s"] > 0, state[1]["remaining_s"])
check("nothing is fading yet", state[1]["fading"], False)

# ── The fade ─────────────────────────────────────────────────────────────────

bridge.calls.clear()
runner.tick()
check("before the fade window nothing is sent", bridge.calls, [])

time.sleep(3.5)                      # inside the last three seconds
runner.tick()
check("the fade is one call per lamp", len(bridge.calls), 2)
check("down to the floor, not to nothing", bridge.calls[0]["brightness"], scenes.FADE_FLOOR)
ok("the bridge is given the remaining time",
   0 < (bridge.calls[0]["transition_ms"] or 0) <= 3000, bridge.calls[0]["transition_ms"])
check("the ramp carries no colour", bridge.calls[0]["mirek"], None)
check("it is marked as fading", runner.running(conn)[1]["fading"], True)

before = len(bridge.calls)
runner.tick()
check("and is not sent again on the next tick", len(bridge.calls), before)

# ── The end ──────────────────────────────────────────────────────────────────

time.sleep(3)
bridge.calls.clear()
runner.tick()
check("the end switches the lamps off", sorted(c["on"] for c in bridge.calls), [False, False])
check("the run is done", runner.running(conn), {})
check("and recorded as done",
      conn.execute("SELECT state FROM scene_run WHERE id = ?", (run_id,)).fetchone()["state"],
      "done")

# ── A run that outlived the service ──────────────────────────────────────────

past = datetime.now(timezone.utc) - timedelta(seconds=30)
conn.execute("INSERT INTO scene_run (scene_id, started_at, ends_at, state) "
             "VALUES (1, ?, ?, 'running')",
             (scenes.iso(past), scenes.iso(past + timedelta(seconds=10))))
conn.commit()
bridge.calls.clear()
runner.tick()
check("a run whose end has passed is finished at once",
      sorted(c["on"] for c in bridge.calls), [False, False])
check("and leaves nothing running", runner.running(conn), {})

# ── Restarting, stopping, and a lamp that refuses ────────────────────────────

runner.start_scene(conn, 1)
first = runner.running(conn)[1]["run_id"]
runner.start_scene(conn, 1)
second = runner.running(conn)[1]["run_id"]
ok("starting again replaces the run rather than adding one", second != first)
check("and only one is running", len(runner.running(conn)), 1)

bridge.calls.clear()
runner.stop_scene(conn, 1)
check("stopping ends it", runner.running(conn), {})
# Switching off says only that. Sending the scene's brightness alongside is at
# best noise for the lamp and at worst a refusal that leaves it on.
check("the off call carries no brightness",
      [c["brightness"] for c in bridge.calls], [None, None])
check("and no colour", [c["xy"] for c in bridge.calls], [None, None])

# The worst case this guards against: a lamp refuses, the run is marked failed,
# the tile shows the scene as off, the tick skips it - and the lamps that did
# take the look stay on with nothing left to switch them off. The state tracks
# the timer, not the lamps.
broken = FakeBridge(failing=["l1"])
runner.bridge_for = lambda db: broken
run_id, problems = runner.start_scene(conn, 1)
check("one refusing lamp is reported", len(problems), 1)
ok("by name", "l1" in problems[0], problems)
check("the run still counts as running", 1 in runner.running(conn), True)
check("and the trouble is written down, not swallowed",
      "l1" in (conn.execute("SELECT note FROM scene_run WHERE id = ?",
                            (run_id,)).fetchone()["note"] or ""), True)
check("the other lamp got its look", [c["id"] for c in broken.calls], ["l2"])

# And the end still arrives for it.
conn.execute("UPDATE scene_run SET ends_at = ? WHERE id = ?",
             (scenes.iso(datetime.now(timezone.utc) - timedelta(seconds=1)), run_id))
conn.commit()
broken.calls.clear()
runner.tick()
check("a troubled run is still ended on time", [c["on"] for c in broken.calls], [False])
check("and nothing is left running", runner.running(conn), {})

runner.bridge_for = lambda db: None
run_id, problems = runner.start_scene(conn, 1)
check("without a bridge the reason is plain", problems, ["Hue ist nicht eingerichtet"])

# ── A scene with no end ──────────────────────────────────────────────────────

runner.bridge_for = lambda db: bridge
conn.execute("INSERT INTO scene (id, name, duration_s, fade_s) VALUES (2, 'Dauerlicht', 0, 0)")
conn.execute("INSERT INTO scene_light (scene_id, light_id, brightness) VALUES (2, 'l3', 60)")
conn.commit()
runner.start_scene(conn, 2)
check("it has no end time", runner.running(conn)[2]["remaining_s"], None)
bridge.calls.clear()
runner.tick()
check("and the tick leaves it alone", bridge.calls, [])

conn.close()
print()
print("Alle Szenen-Tests bestanden." if not failed else "Fehler aufgetreten.")
sys.exit(failed)
