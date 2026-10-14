from flask import Flask, jsonify, request, abort, g
from flask_cors import CORS
import hashlib
import json
import os
import sqlite3
from datetime import datetime, timedelta, timezone

import hue as hue_api
import shelly as shelly_api
from vacuum import FALLBACK_CLASSES, VacuumError, bridge as vacuum_bridge

app = Flask(__name__)
CORS(app)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_FILE = os.path.join(DATA_DIR, "home.db")
SCHEMA_FILE = os.path.join(BASE_DIR, "schema.sql")
SEED_FILE = os.path.join(BASE_DIR, "seed.json")
os.makedirs(DATA_DIR, exist_ok=True)

# Settings never handed back to the client
SECRET_SETTINGS = {"hue_app_key", "yeedi_password_hash", "shelly_gateway_password"}

DEVICE_KINDS = ("hue_light", "shelly_climate", "shelly_window", "vacuum_room")


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_FILE)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    conn = sqlite3.connect(DB_FILE)
    with open(SCHEMA_FILE, encoding="utf-8") as f:
        conn.executescript(f.read())
    migrate_db(conn)
    conn.close()


# Columns added after the first release. CREATE TABLE IF NOT EXISTS leaves an
# existing table alone, so a database from before them needs this - otherwise
# the service starts and every query mentioning them fails.
ROOM_COLUMNS_ADDED = (
    ("shape_points", "TEXT"),
    ("shape_label", "TEXT"),
    ("outdoor", "INTEGER NOT NULL DEFAULT 0"),
)


def migrate_db(conn):
    existing = {row[1] for row in conn.execute("PRAGMA table_info(room)")}
    for column, definition in ROOM_COLUMNS_ADDED:
        if column not in existing:
            conn.execute(f"ALTER TABLE room ADD COLUMN {column} {definition}")
    conn.commit()


def seed_db():
    """Imports the flat's rooms once, into an empty database."""
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    if conn.execute("SELECT COUNT(*) AS n FROM room").fetchone()["n"] > 0 or not os.path.exists(SEED_FILE):
        conn.close()
        return
    with open(SEED_FILE, encoding="utf-8") as f:
        seed = json.load(f)
    for position, room in enumerate(seed.get("rooms") or []):
        # Geometry goes into the column as JSON text, exactly as it does when
        # written through the API. Without it the room appears in the lists but
        # not in the plan - a legitimate intermediate state.
        points = room.get("shape_points")
        label = room.get("shape_label")
        conn.execute(
            "INSERT INTO room (key, name, area_m2, position,"
            " shape_points, shape_label, outdoor) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (room["key"], room["name"], room.get("area_m2"), position,
             json.dumps(points) if points else None,
             json.dumps(label) if label else None,
             1 if room.get("outdoor") else 0),
        )
    conn.commit()
    conn.close()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def row_to_dict(row):
    return dict(row) if row else None


def rows_to_list(rows):
    return [dict(r) for r in rows]


def get_setting(db, key, default=None):
    row = db.execute("SELECT value FROM home_setting WHERE key = ?", (key,)).fetchone()
    return row["value"] if row and row["value"] else default


def set_setting(db, key, value):
    db.execute("INSERT OR REPLACE INTO home_setting (key, value) VALUES (?, ?)", (key, value))


# ── Heating schedule ──────────────────────────────────────────────────────────

def active_schedule_target(schedules, reference=None):
    """The setpoint a schedule asks for right now.

    A schedule entry holds until the next one, which may well be yesterday's
    late-evening entry — so the search walks backwards through up to a week of
    days rather than only looking at today.
    """
    reference = reference or datetime.now()
    enabled = [s for s in schedules if s["enabled"]]
    if not enabled:
        return None
    for days_back in range(0, 8):
        day = reference - timedelta(days=days_back)
        weekday = str(day.isoweekday())
        candidates = [s for s in enabled if weekday in s["weekdays"]]
        if days_back > 0:
            # Any entry of that earlier day qualifies; today's must already have passed.
            candidates = sorted(candidates, key=lambda s: s["time"])
        else:
            now_hm = reference.strftime("%H:%M")
            candidates = sorted([s for s in candidates if s["time"] <= now_hm], key=lambda s: s["time"])
        if candidates:
            latest = candidates[-1]
            return {"target_temp": latest["target_temp"], "schedule_id": latest["id"],
                    "since": latest["time"], "days_back": days_back}
    return None


# ── Hue helpers ───────────────────────────────────────────────────────────────

def hue_bridge(db):
    ip = get_setting(db, "hue_bridge_ip")
    key = get_setting(db, "hue_app_key")
    if not ip or not key:
        return None
    return hue_api.HueBridge(ip, key)


def hue_light_index(db):
    """All Hue lights keyed by id, or None when Hue is not set up or unreachable.
    The caller decides what an empty hand means — the overview still renders."""
    bridge = hue_bridge(db)
    if bridge is None:
        return None, "not_configured"
    try:
        return {light["id"]: light for light in bridge.lights()}, None
    except hue_api.HueError as exc:
        return None, str(exc)


# ── Shelly BLU helpers ────────────────────────────────────────────────────────

def shelly_gateway(db):
    ip = get_setting(db, "shelly_gateway_ip")
    if not ip:
        return None
    return shelly_api.BluGateway(ip, get_setting(db, "shelly_gateway_password"))


def shelly_trv_index(db):
    """Every paired valve keyed by its gateway id, or None when the gateway is
    not set up or unreachable. Same contract as hue_light_index: an empty hand
    is the caller's problem, and the overview still renders."""
    gateway = shelly_gateway(db)
    if gateway is None:
        return None, "not_configured"
    try:
        return {str(trv["id"]): trv for trv in gateway.trvs()}, None
    except shelly_api.ShellyError as exc:
        return None, str(exc)


# ── Heating schedules on the gateway ──────────────────────────────────────────
#
# The plan belongs on the gateway, not in this service. A timer here would mean
# the heating follows its plan only while the Pi runs - and the one morning that
# matters is the morning after the Pi did not come back up. The gateway is
# powered anyway, it is the Bluetooth master, and it has a scheduler.
#
# This database stays the source of truth and the gateway is its mirror. Which
# means jobs edited in the Shelly app are overwritten on the next sync; what is
# never touched is a job this service did not create, and the ids it did create
# are remembered below.

MANAGED_JOBS_SETTING = "shelly_managed_jobs"


def _timespec(row):
    """A schedule row as the gateway's cron expression.

    Six fields, seconds first. The weekday digits need no conversion, which is
    luck worth writing down: the gateway reads 1 as Monday and both 0 and 7 as
    Sunday, so the ISO numbering already in the column fits as it is.
    """
    hour, _, minute = (row["time"] or "").partition(":")
    return f"0 {int(minute)} {int(hour)} * * {','.join(row['weekdays'])}"


def desired_schedule_jobs(db):
    """What the gateway should hold, plus whatever did not fit.

    Grouped by time rather than by room: "weekdays at 6:30" is one job however
    many rooms want something then, because each room contributes its own call.
    One job per room would run into the twenty-job limit at seven rooms with
    three entries each - this way the limit counts distinct times, of which a
    day has a handful.
    """
    rows = rows_to_list(db.execute(
        "SELECT * FROM heating_schedule WHERE enabled = 1 ORDER BY time").fetchall())
    valves_by_room = {}
    for device in db.execute(
            "SELECT room_id, external_id FROM room_device WHERE kind = 'shelly_climate'").fetchall():
        valves_by_room.setdefault(device["room_id"], []).append(device["external_id"])

    by_spec, problems = {}, []
    for row in rows:
        if not row["weekdays"] or not row["time"]:
            continue
        valves = valves_by_room.get(row["room_id"], [])
        if not valves:
            # Not an error: a room may have a plan before it has a radiator.
            continue
        for trv_id in valves:
            by_spec.setdefault(_timespec(row), []).append(
                shelly_api.target_call(trv_id, row["target_temp"]))

    jobs = []
    for timespec in sorted(by_spec):
        calls = by_spec[timespec]
        # Chunked, because a job carries five calls at most.
        for start in range(0, len(calls), shelly_api.MAX_CALLS_PER_JOB):
            jobs.append({"timespec": timespec,
                         "calls": calls[start:start + shelly_api.MAX_CALLS_PER_JOB]})

    if len(jobs) > shelly_api.MAX_JOBS:
        problems.append(
            f"{len(jobs)} Jobs noetig, das Gateway nimmt {shelly_api.MAX_JOBS}. "
            f"Die spaetesten {len(jobs) - shelly_api.MAX_JOBS} bleiben ungeschickt.")
        jobs = jobs[:shelly_api.MAX_JOBS]
    return jobs, problems


def _job_shape(job):
    """Comparable form, so a sync that changes nothing writes nothing."""
    return (job["timespec"], json.dumps(sorted(json.dumps(c, sort_keys=True)
                                               for c in job["calls"])))


def sync_gateway_schedules(db):
    """Brings the gateway's jobs in line with this database.

    Returns a report rather than raising: the rows are already saved when this
    runs, and a gateway that is briefly away must not make a saved plan look
    like a failed edit. The next sync picks it up.
    """
    gateway = shelly_gateway(db)
    desired, problems = desired_schedule_jobs(db)
    if gateway is None:
        return {"synced": False, "reason": "not_configured",
                "jobs": len(desired), "problems": problems}

    managed = [int(i) for i in (get_setting(db, MANAGED_JOBS_SETTING) or "").split(",") if i]
    try:
        present = {int(job["id"]): job for job in gateway.schedules()}
        ours = [present[i] for i in managed if i in present]

        if sorted(_job_shape(j) for j in ours) == sorted(_job_shape(j) for j in desired) \
                and all(job.get("enable") for job in ours):
            return {"synced": True, "changed": False, "jobs": len(ours),
                    "foreign": len(present) - len(ours), "problems": problems}

        for job_id in managed:
            if job_id in present:
                gateway.delete_schedule(job_id)
        created = [gateway.create_schedule(job["timespec"], job["calls"]) for job in desired]
    except shelly_api.ShellyError as exc:
        return {"synced": False, "reason": str(exc), "jobs": len(desired), "problems": problems}

    set_setting(db, MANAGED_JOBS_SETTING, ",".join(str(i) for i in created if i is not None))
    db.commit()
    return {"synced": True, "changed": True, "jobs": len(created), "problems": problems}


# ── Overview ──────────────────────────────────────────────────────────────────

@app.route("/overview", methods=["GET"])
def overview():
    db = get_db()
    # room_out, not rows_to_list: the geometry sits in the column as JSON text
    # and has to be parsed here too. The dashboard fetches its floorplan through
    # this endpoint, not through /rooms - converting only /rooms yields an empty
    # plan and no error.
    rooms = [room_out(r) for r in
             db.execute("SELECT * FROM room ORDER BY position, id").fetchall()]
    devices = rows_to_list(db.execute("SELECT * FROM room_device").fetchall())
    schedules = rows_to_list(db.execute("SELECT * FROM heating_schedule ORDER BY time").fetchall())

    lights, hue_error = hue_light_index(db)
    trvs, shelly_error = shelly_trv_index(db)

    # Served with the rooms rather than through /settings: the plan needs them
    # for its first draw, and a second request would be a second moment at which
    # it stands there without walls.
    def wall_width(key, fallback):
        try:
            value = float(get_setting(db, key, fallback))
        except (TypeError, ValueError):
            return float(fallback)
        # Eine Wand von 0 oder einem Meter ist keine; der Plan waere unlesbar.
        return value if 0 < value <= 0.6 else float(fallback)

    walls = {"inner": wall_width("wall_inner", "0.115"),
             "outer": wall_width("wall_outer", "0.24")}

    by_room = {}
    for device in devices:
        by_room.setdefault(device["room_id"], []).append(device)
    schedules_by_room = {}
    for schedule in schedules:
        schedules_by_room.setdefault(schedule["room_id"], []).append(schedule)

    for room in rooms:
        room_devices = by_room.get(room["id"], [])
        room["devices"] = room_devices
        room["schedules"] = schedules_by_room.get(room["id"], [])
        room["scheduled"] = active_schedule_target(room["schedules"])

        light_ids = [d["external_id"] for d in room_devices if d["kind"] == "hue_light"]
        room_lights = [lights[i] for i in light_ids if lights and i in lights] if lights else []
        on_lights = [l for l in room_lights if l["on"]]
        room["lights"] = {
            "bound": len(light_ids),
            "known": len(room_lights),
            "on": len(on_lights),
            "brightness": (round(sum(l["brightness"] or 0 for l in on_lights) / len(on_lights))
                           if on_lights else None),
            "items": room_lights,
        }
        # A room may carry more than one valve - two radiators under one window
        # are one room with one wish. The temperature is then the mean of what
        # the valves measure, while the setpoint and the age are the extremes:
        # the coldest wish and the oldest reading are what somebody looking at
        # the room needs to know.
        trv_ids = [d["external_id"] for d in room_devices if d["kind"] == "shelly_climate"]
        room_trvs = [trvs[i] for i in trv_ids if trvs and i in trvs] if trvs else []
        measured = [t["current_C"] for t in room_trvs if t["current_C"] is not None]
        wanted = [t["target_C"] for t in room_trvs if t["target_C"] is not None]
        ages = [t["age_s"] for t in room_trvs if t["age_s"] is not None]
        positions = [t["position"] for t in room_trvs if t["position"] is not None]
        batteries = [t["battery"] for t in room_trvs if t["battery"] is not None]
        room["climate"] = {
            "temperature": round(sum(measured) / len(measured), 1) if measured else None,
            "humidity": None,          # a BLU TRV does not measure it
            "window_open": None,       # needs a BLU door/window sensor
            "trv_target": min(wanted) if wanted else None,
            "valve_position": max(positions) if positions else None,
            "battery": min(batteries) if batteries else None,
            "age_s": max(ages) if ages else None,
            "bound": len(trv_ids),
            "known": len(room_trvs),
            "available": bool(measured),
            "items": room_trvs,
        }
        room["vacuum_rooms"] = [{"id": d["external_id"], "name": d["name"]}
                                for d in room_devices if d["kind"] == "vacuum_room"]

    return jsonify({
        "rooms": rooms,
        "walls": walls,
        "hue": {
            "configured": bool(get_setting(db, "hue_bridge_ip") and get_setting(db, "hue_app_key")),
            "bridge_ip": get_setting(db, "hue_bridge_ip"),
            "reachable": hue_error is None and lights is not None,
            "error": None if hue_error == "not_configured" else hue_error,
        },
        "shelly": {
            "configured": bool(get_setting(db, "shelly_gateway_ip")),
            "gateway_ip": get_setting(db, "shelly_gateway_ip"),
            "reachable": shelly_error is None and trvs is not None,
            "error": None if shelly_error == "not_configured" else shelly_error,
            "trvs": len(trvs) if trvs else 0,
            # Valves the gateway knows and no room claims. Without this the
            # third valve of a three-valve flat simply never appears anywhere.
            "unbound": sorted(set((trvs or {})) - {
                d["external_id"] for d in devices if d["kind"] == "shelly_climate"}),
        },
        "vacuum": vacuum_bridge.status(),
    })


# ── Rooms ─────────────────────────────────────────────────────────────────────

ROOM_FIELDS = ["key", "name", "area_m2", "target_temp", "position",
               "shape_points", "shape_label", "outdoor"]

# Geometry travels as JSON text in the database and as real arrays over the API.
# Storing it as text keeps the column simple; handing the frontend a string it
# has to parse itself would only move the work.
GEOMETRY_FIELDS = ("shape_points", "shape_label")


def _coord_pair(value, what):
    if (not isinstance(value, (list, tuple)) or len(value) != 2
            or not all(isinstance(n, (int, float)) and not isinstance(n, bool) for n in value)):
        abort(400, f"{what} must be two numbers [x, y]")
    return [float(value[0]), float(value[1])]


def clean_geometry(values):
    """Validates and serialises the geometry fields in place.

    Rejected rather than silently dropped: a half-written polygon would render
    as a stray triangle on the plan, and the cause would be hard to see."""
    points = values.get("shape_points")
    if points in (None, "", []):
        values["shape_points"] = None
    elif isinstance(points, str):
        pass                      # already serialised, e.g. copied from a read
    else:
        if not isinstance(points, (list, tuple)) or len(points) < 3:
            abort(400, "shape_points needs at least three corners")
        values["shape_points"] = json.dumps(
            [_coord_pair(p, "every corner") for p in points])

    label = values.get("shape_label")
    if label in (None, "", []):
        values["shape_label"] = None
    elif not isinstance(label, str):
        values["shape_label"] = json.dumps(_coord_pair(label, "shape_label"))

    if "outdoor" in values:
        values["outdoor"] = 1 if values["outdoor"] in (1, True, "1", "true") else 0
    return values


def room_out(row):
    """One room as the API hands it out, with the geometry parsed.

    EVERY path that returns a room has to go through this, not rows_to_list:
    the geometry sits in the column as JSON text, and handing the frontend a
    string where it expects an array produces an empty floorplan and no error
    at all. That is four places - /overview, GET /rooms, POST /rooms and
    PUT /rooms/<id> - and /overview is the one the dashboard actually draws
    from, which is easy to miss while testing against /rooms."""
    if row is None:
        return None
    out = dict(row)
    for field in GEOMETRY_FIELDS:
        raw = out.get(field)
        if raw:
            try:
                out[field] = json.loads(raw)
            except (TypeError, ValueError):
                # Unreadable geometry must not take the whole room list down;
                # the plan simply leaves that room out.
                out[field] = None
    out["outdoor"] = bool(out.get("outdoor"))
    return out


@app.route("/rooms", methods=["GET"])
def list_rooms():
    db = get_db()
    return jsonify([room_out(r) for r in
                    db.execute("SELECT * FROM room ORDER BY position, id").fetchall()])


@app.route("/rooms", methods=["POST"])
def create_room():
    body = request.get_json(silent=True)
    if not body or not body.get("name") or not body.get("key"):
        abort(400, "key and name are required")
    db = get_db()
    values = clean_geometry({k: body.get(k) for k in ROOM_FIELDS})
    if values["position"] is None:
        values["position"] = db.execute("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM room").fetchone()["p"]
    try:
        cur = db.execute(
            f"INSERT INTO room ({', '.join(ROOM_FIELDS)}) VALUES ({', '.join('?' for _ in ROOM_FIELDS)})",
            [values[k] for k in ROOM_FIELDS],
        )
    except sqlite3.IntegrityError:
        abort(409, "room key already exists")
    db.commit()
    return jsonify(room_out(db.execute("SELECT * FROM room WHERE id = ?", (cur.lastrowid,)).fetchone())), 201


@app.route("/rooms/<int:room_id>", methods=["PUT"])
def update_room(room_id):
    body = request.get_json(silent=True)
    if not body:
        abort(400)
    db = get_db()
    existing = db.execute("SELECT * FROM room WHERE id = ?", (room_id,)).fetchone()
    if not existing:
        abort(404)
    values = clean_geometry({k: body.get(k, existing[k]) for k in ROOM_FIELDS})
    db.execute(
        f"UPDATE room SET {', '.join(f'{k} = ?' for k in ROOM_FIELDS)}, updated_at = ? WHERE id = ?",
        [values[k] for k in ROOM_FIELDS] + [now_iso(), room_id],
    )
    db.commit()
    return jsonify(room_out(db.execute("SELECT * FROM room WHERE id = ?", (room_id,)).fetchone()))


@app.route("/rooms/<int:room_id>", methods=["DELETE"])
def delete_room(room_id):
    db = get_db()
    db.execute("DELETE FROM room WHERE id = ?", (room_id,))
    db.commit()
    # ON DELETE CASCADE takes the room's valve bindings and schedule entries
    # with it, so jobs on the gateway would otherwise keep heating a room that
    # no longer exists here.
    return jsonify({"ok": True, "gateway": sync_gateway_schedules(db)})


# ── Device bindings ───────────────────────────────────────────────────────────

@app.route("/rooms/<int:room_id>/devices", methods=["POST"])
def bind_device(room_id):
    body = request.get_json(silent=True)
    if not body or body.get("kind") not in DEVICE_KINDS or not body.get("external_id"):
        abort(400, "kind and external_id are required")
    db = get_db()
    if not db.execute("SELECT 1 FROM room WHERE id = ?", (room_id,)).fetchone():
        abort(404)
    try:
        cur = db.execute(
            "INSERT INTO room_device (room_id, kind, external_id, name) VALUES (?, ?, ?, ?)",
            (room_id, body["kind"], str(body["external_id"]), body.get("name")),
        )
    except sqlite3.IntegrityError:
        abort(409, "already bound to this room")
    db.commit()
    bound = row_to_dict(db.execute("SELECT * FROM room_device WHERE id = ?", (cur.lastrowid,)).fetchone())
    # A new valve in a room with a plan changes which calls the jobs carry.
    # Only for valves: a Hue lamp has nothing to do with the heating schedule,
    # and a sync per lamp would call the gateway for nothing.
    if body["kind"] == "shelly_climate":
        bound["gateway"] = sync_gateway_schedules(db)
    return jsonify(bound), 201


@app.route("/devices/<int:device_id>", methods=["DELETE"])
def unbind_device(device_id):
    db = get_db()
    row = db.execute("SELECT kind FROM room_device WHERE id = ?", (device_id,)).fetchone()
    db.execute("DELETE FROM room_device WHERE id = ?", (device_id,))
    db.commit()
    result = {"ok": True}
    if row and row["kind"] == "shelly_climate":
        result["gateway"] = sync_gateway_schedules(db)
    return jsonify(result)


# ── Light control ─────────────────────────────────────────────────────────────

@app.route("/lights/<light_id>", methods=["POST"])
def set_light(light_id):
    body = request.get_json(silent=True) or {}
    db = get_db()
    bridge = hue_bridge(db)
    if bridge is None:
        abort(409, "Hue ist nicht eingerichtet")
    try:
        bridge.set_light(light_id, on=body.get("on"), brightness=body.get("brightness"),
                         mirek=body.get("mirek"))
    except hue_api.HueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 502
    return jsonify({"ok": True})


@app.route("/rooms/<int:room_id>/lights", methods=["POST"])
def set_room_lights(room_id):
    """Every Hue lamp bound to this room at once — the switch on the floor plan."""
    body = request.get_json(silent=True) or {}
    db = get_db()
    bridge = hue_bridge(db)
    if bridge is None:
        abort(409, "Hue ist nicht eingerichtet")
    light_ids = [r["external_id"] for r in db.execute(
        "SELECT external_id FROM room_device WHERE room_id = ? AND kind = 'hue_light'", (room_id,)).fetchall()]
    if not light_ids:
        return jsonify({"ok": True, "changed": 0})
    failed = bridge.set_lights(light_ids, on=body.get("on"), brightness=body.get("brightness"),
                               mirek=body.get("mirek"))
    return jsonify({"ok": not failed, "changed": len(light_ids) - len(failed), "failed": failed})


# ── Hue setup ─────────────────────────────────────────────────────────────────

@app.route("/hue/discover", methods=["GET"])
def hue_discover():
    return jsonify(hue_api.discover_bridges())


@app.route("/hue/pair", methods=["POST"])
def hue_pair():
    body = request.get_json(silent=True) or {}
    ip = body.get("ip")
    if not ip:
        abort(400, "ip is required")
    db = get_db()
    try:
        app_key = hue_api.pair(ip)
    except hue_api.LinkButtonNotPressed as exc:
        return jsonify({"ok": False, "reason": "link_button", "error": str(exc)}), 409
    except hue_api.HueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 502
    set_setting(db, "hue_bridge_ip", ip)
    set_setting(db, "hue_app_key", app_key)
    db.commit()
    return jsonify({"ok": True, "bridge_ip": ip})


@app.route("/hue", methods=["DELETE"])
def hue_forget():
    db = get_db()
    db.execute("DELETE FROM home_setting WHERE key IN ('hue_bridge_ip', 'hue_app_key')")
    db.execute("DELETE FROM room_device WHERE kind = 'hue_light'")
    db.commit()
    return jsonify({"ok": True})


@app.route("/hue/lights", methods=["GET"])
def hue_lights():
    db = get_db()
    bridge = hue_bridge(db)
    if bridge is None:
        return jsonify({"configured": False, "lights": [], "rooms": []})
    try:
        return jsonify({"configured": True, "lights": bridge.lights(), "rooms": bridge.rooms()})
    except hue_api.HueError as exc:
        return jsonify({"configured": True, "error": str(exc), "lights": [], "rooms": []}), 502


@app.route("/hue/automap", methods=["POST"])
def hue_automap():
    """Binds Hue's own rooms onto this flat's rooms wherever the names match,
    case and spacing ignored. Anything that does not match is reported back so it
    can be assigned by hand."""
    db = get_db()
    bridge = hue_bridge(db)
    if bridge is None:
        abort(409, "Hue ist nicht eingerichtet")
    try:
        hue_rooms = bridge.rooms()
        lights = {l["id"]: l for l in bridge.lights()}
    except hue_api.HueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 502

    def normalise(value):
        return "".join((value or "").lower().split())

    rooms = rows_to_list(db.execute("SELECT * FROM room").fetchall())
    by_name = {normalise(r["name"]): r for r in rooms}

    bound, unmatched = 0, []
    for hue_room in hue_rooms:
        room = by_name.get(normalise(hue_room["name"]))
        if room is None:
            unmatched.append(hue_room["name"])
            continue
        for light_id in hue_room["light_ids"]:
            try:
                db.execute(
                    "INSERT INTO room_device (room_id, kind, external_id, name) VALUES (?, 'hue_light', ?, ?)",
                    (room["id"], light_id, (lights.get(light_id) or {}).get("name")),
                )
                bound += 1
            except sqlite3.IntegrityError:
                pass  # already bound — automap is safe to run twice
    db.commit()
    return jsonify({"ok": True, "bound": bound, "unmatched": unmatched})


# ── Shelly BLU gateway ────────────────────────────────────────────────────────

@app.route("/shelly/connect", methods=["POST"])
def shelly_connect():
    """Stores the gateway address, but only after it has answered.

    Probing first is the point: a typo in the address would otherwise be saved
    and then show up as "no valves" on the overview, which looks like a pairing
    problem and is not one.
    """
    body = request.get_json(silent=True) or {}
    ip = (body.get("ip") or "").strip()
    if not ip:
        abort(400, "ip is required")
    password = body.get("password") or None

    try:
        info = shelly_api.BluGateway(ip, password).info()
    except shelly_api.ShellyError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 502

    db = get_db()
    set_setting(db, "shelly_gateway_ip", ip)
    # An empty field means "no password", not "keep the old one" - otherwise a
    # password removed on the device could never be removed here.
    set_setting(db, "shelly_gateway_password", password)
    db.commit()
    # Straight away, so a reconnected gateway carries the plan again without
    # anybody having to remember a second button.
    return jsonify({"ok": True, "gateway": info, "schedules": sync_gateway_schedules(db)})


@app.route("/shelly", methods=["DELETE"])
def shelly_forget():
    db = get_db()
    # Our jobs come off the gateway first - afterwards we no longer know its
    # address, and they would fire forever with nobody left who put them there.
    # Best effort: a gateway already unplugged must not block forgetting it.
    gateway = shelly_gateway(db)
    removed = 0
    if gateway is not None:
        managed = [int(i) for i in (get_setting(db, MANAGED_JOBS_SETTING) or "").split(",") if i]
        try:
            present = {int(job["id"]) for job in gateway.schedules()}
            for job_id in managed:
                if job_id in present:
                    gateway.delete_schedule(job_id)
                    removed += 1
        except shelly_api.ShellyError:
            pass
    db.execute("DELETE FROM home_setting WHERE key IN "
               "('shelly_gateway_ip', 'shelly_gateway_password', ?)", (MANAGED_JOBS_SETTING,))
    db.execute("DELETE FROM room_device WHERE kind = 'shelly_climate'")
    db.commit()
    return jsonify({"ok": True, "jobs_removed": removed})


@app.route("/shelly/trvs", methods=["GET"])
def shelly_trvs():
    db = get_db()
    gateway = shelly_gateway(db)
    if gateway is None:
        return jsonify({"configured": False, "trvs": []})
    try:
        return jsonify({"configured": True, "trvs": gateway.trvs()})
    except shelly_api.ShellyError as exc:
        return jsonify({"configured": True, "error": str(exc), "trvs": []}), 502


@app.route("/shelly/schedules", methods=["GET"])
def shelly_schedules():
    """What the gateway holds, what it should hold, and whose jobs are whose.

    Foreign jobs are counted, not listed in our terms: somebody may run a script
    of their own on this gateway, and the interface should say that it stays
    untouched rather than pretend it does not exist.
    """
    db = get_db()
    desired, problems = desired_schedule_jobs(db)
    managed = [int(i) for i in (get_setting(db, MANAGED_JOBS_SETTING) or "").split(",") if i]
    gateway = shelly_gateway(db)
    if gateway is None:
        return jsonify({"configured": False, "desired": len(desired), "problems": problems})
    try:
        jobs = gateway.schedules()
    except shelly_api.ShellyError as exc:
        return jsonify({"configured": True, "error": str(exc),
                        "desired": len(desired), "problems": problems}), 502
    return jsonify({
        "configured": True,
        "desired": len(desired),
        "problems": problems,
        "ours": [{"id": j["id"], "timespec": j["timespec"], "enable": j.get("enable"),
                  "calls": len(j.get("calls") or [])}
                 for j in jobs if int(j["id"]) in managed],
        "foreign": len([j for j in jobs if int(j["id"]) not in managed]),
        "limit": shelly_api.MAX_JOBS,
    })


@app.route("/shelly/schedules/sync", methods=["POST"])
def shelly_schedules_sync():
    return jsonify(sync_gateway_schedules(get_db()))


@app.route("/trvs/<trv_id>/target", methods=["POST"])
def set_trv_target(trv_id):
    body = request.get_json(silent=True) or {}
    if body.get("target_C") is None:
        abort(400, "target_C is required")
    db = get_db()
    gateway = shelly_gateway(db)
    if gateway is None:
        abort(409, "Das BLU-Gateway ist nicht eingerichtet")
    try:
        value = gateway.set_target(trv_id, body["target_C"])
    except (TypeError, ValueError):
        abort(400, "target_C must be a number")
    except shelly_api.ShellyError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 502
    return jsonify({"ok": True, "id": trv_id, "target_C": value})


@app.route("/rooms/<int:room_id>/target_temp", methods=["POST"])
def set_room_target(room_id):
    """The room's wish, and the valves in it.

    Both, because they are two different things that have to agree: target_temp
    on the room is what the schedule and the overview reason about, and the
    valve is what actually heats. Writing only the row would leave a number on
    screen that no radiator ever heard of.

    Partial failure is reported rather than hidden - one valve out of
    Bluetooth range must not make the whole call look like it did nothing.
    """
    body = request.get_json(silent=True) or {}
    if body.get("target_temp") is None:
        abort(400, "target_temp is required")
    try:
        target = float(body["target_temp"])
    except (TypeError, ValueError):
        abort(400, "target_temp must be a number")

    db = get_db()
    room = db.execute("SELECT * FROM room WHERE id = ?", (room_id,)).fetchone()
    if room is None:
        abort(404)

    db.execute("UPDATE room SET target_temp = ?, updated_at = ? WHERE id = ?",
               (target, now_iso(), room_id))
    db.commit()

    trv_ids = [r["external_id"] for r in db.execute(
        "SELECT external_id FROM room_device WHERE room_id = ? AND kind = 'shelly_climate'",
        (room_id,)).fetchall()]

    gateway = shelly_gateway(db)
    results, failed = [], []
    if gateway is not None:
        for trv_id in trv_ids:
            try:
                gateway.set_target(trv_id, target)
                results.append({"id": trv_id, "ok": True})
            except shelly_api.ShellyError as exc:
                results.append({"id": trv_id, "ok": False, "error": str(exc)})
                failed.append(trv_id)

    return jsonify({
        "ok": not failed,
        "room_id": room_id,
        "target_temp": target,
        "valves": results,
        "note": None if gateway is not None or not trv_ids
                else "Gateway nicht eingerichtet - nur der Wunschwert wurde gespeichert.",
    }), (200 if not failed else 502)


# ── Vacuum ────────────────────────────────────────────────────────────────────

@app.route("/vacuum/status", methods=["GET"])
def vacuum_status():
    status = vacuum_bridge.status()
    status["fan_speed_levels"] = vacuum_bridge.fan_speed_levels()
    status["fallback_classes"] = FALLBACK_CLASSES
    return jsonify(status)


@app.route("/vacuum/connect", methods=["POST"])
def vacuum_connect():
    db = get_db()
    account = get_setting(db, "yeedi_account")
    password_hash = get_setting(db, "yeedi_password_hash")
    country = get_setting(db, "yeedi_country", "DE")
    fallback = get_setting(db, "yeedi_fallback_class")
    if not account or not password_hash:
        abort(409, "Es sind keine yeedi-Zugangsdaten hinterlegt")
    vacuum_bridge.start(account, password_hash, country, fallback)
    return jsonify({"ok": True, "status": vacuum_bridge.status()})


@app.route("/vacuum/disconnect", methods=["POST"])
def vacuum_disconnect():
    vacuum_bridge.stop()
    return jsonify({"ok": True})


@app.route("/vacuum/clean", methods=["POST"])
def vacuum_clean():
    body = request.get_json(silent=True) or {}
    db = get_db()
    try:
        if body.get("all"):
            vacuum_bridge.clean_all()
            return jsonify({"ok": True, "scope": "all"})
        room_ids = body.get("vacuum_room_ids")
        if room_ids is None and body.get("room_ids"):
            # Translate this service's room ids into the robot's map subsets
            placeholders = ",".join("?" for _ in body["room_ids"])
            room_ids = [r["external_id"] for r in db.execute(
                f"SELECT external_id FROM room_device WHERE kind = 'vacuum_room' AND room_id IN ({placeholders})",
                body["room_ids"]).fetchall()]
        vacuum_bridge.clean_rooms(room_ids or [], int(body.get("cleanings", 1)))
        return jsonify({"ok": True, "scope": "rooms", "vacuum_room_ids": room_ids})
    except VacuumError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 502


@app.route("/vacuum/control", methods=["POST"])
def vacuum_control():
    body = request.get_json(silent=True) or {}
    try:
        vacuum_bridge.control(body.get("action", ""))
    except VacuumError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 502
    return jsonify({"ok": True})


@app.route("/vacuum/fan-speed", methods=["POST"])
def vacuum_fan_speed():
    body = request.get_json(silent=True) or {}
    try:
        vacuum_bridge.set_fan_speed(body.get("level", ""))
    except VacuumError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 502
    return jsonify({"ok": True})


# ── Heating schedules ─────────────────────────────────────────────────────────

SCHEDULE_FIELDS = ["weekdays", "time", "target_temp", "enabled"]


@app.route("/rooms/<int:room_id>/schedules", methods=["POST"])
def create_schedule(room_id):
    body = request.get_json(silent=True)
    if not body or not body.get("time") or body.get("target_temp") is None:
        abort(400, "time and target_temp are required")
    db = get_db()
    if not db.execute("SELECT 1 FROM room WHERE id = ?", (room_id,)).fetchone():
        abort(404)
    cur = db.execute(
        "INSERT INTO heating_schedule (room_id, weekdays, time, target_temp, enabled) VALUES (?, ?, ?, ?, ?)",
        (room_id, body.get("weekdays") or "1234567", body["time"],
         float(body["target_temp"]), int(bool(body.get("enabled", True)))),
    )
    db.commit()
    created = row_to_dict(db.execute("SELECT * FROM heating_schedule WHERE id = ?", (cur.lastrowid,)).fetchone())
    # The row is saved either way; the mirror reports separately whether the
    # gateway took it. Conflating the two would make a saved plan look failed.
    created["gateway"] = sync_gateway_schedules(db)
    return jsonify(created), 201


@app.route("/schedules/<int:schedule_id>", methods=["PUT"])
def update_schedule(schedule_id):
    body = request.get_json(silent=True)
    if not body:
        abort(400)
    db = get_db()
    existing = db.execute("SELECT * FROM heating_schedule WHERE id = ?", (schedule_id,)).fetchone()
    if not existing:
        abort(404)
    values = {k: body.get(k, existing[k]) for k in SCHEDULE_FIELDS}
    values["enabled"] = int(bool(values["enabled"]))
    db.execute(
        f"UPDATE heating_schedule SET {', '.join(f'{k} = ?' for k in SCHEDULE_FIELDS)}, updated_at = ? WHERE id = ?",
        [values[k] for k in SCHEDULE_FIELDS] + [now_iso(), schedule_id],
    )
    db.commit()
    updated = row_to_dict(db.execute("SELECT * FROM heating_schedule WHERE id = ?", (schedule_id,)).fetchone())
    updated["gateway"] = sync_gateway_schedules(db)
    return jsonify(updated)


@app.route("/schedules/<int:schedule_id>", methods=["DELETE"])
def delete_schedule(schedule_id):
    db = get_db()
    db.execute("DELETE FROM heating_schedule WHERE id = ?", (schedule_id,))
    db.commit()
    return jsonify({"ok": True, "gateway": sync_gateway_schedules(db)})


# ── Settings ──────────────────────────────────────────────────────────────────

@app.route("/settings", methods=["GET"])
def read_settings():
    db = get_db()
    rows = db.execute("SELECT key, value FROM home_setting").fetchall()
    settings = {r["key"]: r["value"] for r in rows if r["key"] not in SECRET_SETTINGS}
    # Secrets are reported as present or absent, never echoed
    for key in SECRET_SETTINGS:
        settings[f"{key}_set"] = bool(get_setting(db, key))
    settings.setdefault("yeedi_country", "DE")
    # Wall thicknesses in metres, for drawing only: the rooms tile the flat and
    # a wall is a shared edge. 11.5 cm is a common partition, 24 cm an exterior
    # wall.
    settings.setdefault("wall_inner", "0.115")
    settings.setdefault("wall_outer", "0.24")
    settings["fallback_classes"] = FALLBACK_CLASSES
    return jsonify(settings)


@app.route("/settings", methods=["PUT"])
def write_settings():
    body = request.get_json(silent=True)
    if not body:
        abort(400)
    db = get_db()
    for key, value in body.items():
        if key == "yeedi_password":
            # deebot-client authenticates with the md5 of the password, so the
            # plaintext is never stored.
            if value:
                set_setting(db, "yeedi_password_hash", hashlib.md5(value.encode()).hexdigest())
            continue
        if key in SECRET_SETTINGS or key.endswith("_set") or key == "fallback_classes":
            continue
        set_setting(db, key, None if value is None else str(value))
    db.commit()
    return read_settings()


if __name__ == "__main__":
    init_db()  # CREATE TABLE IF NOT EXISTS is idempotent and picks up schema updates on restart
    seed_db()
    app.run(host="0.0.0.0", port=5005, threaded=True)
