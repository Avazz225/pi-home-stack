from flask import Flask, jsonify, request, abort, g
from flask_cors import CORS
import hashlib
import json
import os
import sqlite3
from datetime import datetime, timedelta, timezone

import hue as hue_api
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
SECRET_SETTINGS = {"hue_app_key", "yeedi_password_hash"}

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
    conn.close()


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
        conn.execute(
            "INSERT INTO room (key, name, area_m2, position) VALUES (?, ?, ?, ?)",
            (room["key"], room["name"], room.get("area_m2"), position),
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


# ── Overview ──────────────────────────────────────────────────────────────────

@app.route("/overview", methods=["GET"])
def overview():
    db = get_db()
    rooms = rows_to_list(db.execute("SELECT * FROM room ORDER BY position, id").fetchall())
    devices = rows_to_list(db.execute("SELECT * FROM room_device").fetchall())
    schedules = rows_to_list(db.execute("SELECT * FROM heating_schedule ORDER BY time").fetchall())

    lights, hue_error = hue_light_index(db)

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
        # Shelly is modelled but has no adapter yet, so the readings stay empty
        # and the UI can say so instead of inventing numbers.
        room["climate"] = {
            "temperature": None, "humidity": None, "window_open": None,
            "bound": len([d for d in room_devices if d["kind"].startswith("shelly")]),
            "available": False,
        }
        room["vacuum_rooms"] = [{"id": d["external_id"], "name": d["name"]}
                                for d in room_devices if d["kind"] == "vacuum_room"]

    return jsonify({
        "rooms": rooms,
        "hue": {
            "configured": bool(get_setting(db, "hue_bridge_ip") and get_setting(db, "hue_app_key")),
            "bridge_ip": get_setting(db, "hue_bridge_ip"),
            "reachable": hue_error is None and lights is not None,
            "error": None if hue_error == "not_configured" else hue_error,
        },
        "shelly": {"configured": False, "note": "Adapter folgt, sobald Geräte da sind."},
        "vacuum": vacuum_bridge.status(),
    })


# ── Rooms ─────────────────────────────────────────────────────────────────────

ROOM_FIELDS = ["key", "name", "area_m2", "target_temp", "position"]


@app.route("/rooms", methods=["GET"])
def list_rooms():
    db = get_db()
    return jsonify(rows_to_list(db.execute("SELECT * FROM room ORDER BY position, id").fetchall()))


@app.route("/rooms", methods=["POST"])
def create_room():
    body = request.get_json(silent=True)
    if not body or not body.get("name") or not body.get("key"):
        abort(400, "key and name are required")
    db = get_db()
    values = {k: body.get(k) for k in ROOM_FIELDS}
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
    return jsonify(row_to_dict(db.execute("SELECT * FROM room WHERE id = ?", (cur.lastrowid,)).fetchone())), 201


@app.route("/rooms/<int:room_id>", methods=["PUT"])
def update_room(room_id):
    body = request.get_json(silent=True)
    if not body:
        abort(400)
    db = get_db()
    existing = db.execute("SELECT * FROM room WHERE id = ?", (room_id,)).fetchone()
    if not existing:
        abort(404)
    values = {k: body.get(k, existing[k]) for k in ROOM_FIELDS}
    db.execute(
        f"UPDATE room SET {', '.join(f'{k} = ?' for k in ROOM_FIELDS)}, updated_at = ? WHERE id = ?",
        [values[k] for k in ROOM_FIELDS] + [now_iso(), room_id],
    )
    db.commit()
    return jsonify(row_to_dict(db.execute("SELECT * FROM room WHERE id = ?", (room_id,)).fetchone()))


@app.route("/rooms/<int:room_id>", methods=["DELETE"])
def delete_room(room_id):
    db = get_db()
    db.execute("DELETE FROM room WHERE id = ?", (room_id,))
    db.commit()
    return jsonify({"ok": True})


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
    return jsonify(row_to_dict(db.execute("SELECT * FROM room_device WHERE id = ?", (cur.lastrowid,)).fetchone())), 201


@app.route("/devices/<int:device_id>", methods=["DELETE"])
def unbind_device(device_id):
    db = get_db()
    db.execute("DELETE FROM room_device WHERE id = ?", (device_id,))
    db.commit()
    return jsonify({"ok": True})


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
    return jsonify(row_to_dict(db.execute("SELECT * FROM heating_schedule WHERE id = ?", (cur.lastrowid,)).fetchone())), 201


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
    return jsonify(row_to_dict(db.execute("SELECT * FROM heating_schedule WHERE id = ?", (schedule_id,)).fetchone()))


@app.route("/schedules/<int:schedule_id>", methods=["DELETE"])
def delete_schedule(schedule_id):
    db = get_db()
    db.execute("DELETE FROM heating_schedule WHERE id = ?", (schedule_id,))
    db.commit()
    return jsonify({"ok": True})


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
