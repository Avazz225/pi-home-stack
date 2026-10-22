"""Notifications: rules somebody asked for, checked on a timer, told to them.

Why a service of its own rather than each component reporting for itself: the
things worth saying are spread over three sources, and the thing they have in
common is the person who wants to hear about them. Rules in one place, the
recipient beside them; the sources only have to answer what they already answer.

It reads and never writes to the others. That keeps the dependency one-way: this
service being down costs you the bell and nothing else.
"""

from flask import Flask, jsonify, request, abort, g
from flask_cors import CORS
import json
import os
import re
import sqlite3
import threading
from datetime import datetime, timedelta, timezone

import requests

import rules as rule_api

app = Flask(__name__)
CORS(app)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_FILE = os.path.join(DATA_DIR, "notify.db")
SCHEMA_FILE = os.path.join(BASE_DIR, "schema.sql")
os.makedirs(DATA_DIR, exist_ok=True)

USER_HEADER = "X-Home-User"
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")

# Where the facts come from. Overridable because a development machine has them
# somewhere else, and because the web root is a setting on the Pi too.
HOME_API = os.environ.get("PHS_HOME_API", "http://127.0.0.1:5005")
STATUS_FILE = os.environ.get("PHS_STATUS_FILE", "/var/www/pi-home/status.json")
VERSION_FILE = os.environ.get("PHS_VERSION_FILE",
                             os.path.join(BASE_DIR, "..", "..", "VERSION"))
UPSTREAM_REPO = os.environ.get("PHS_UPSTREAM_REPO", "Avazz225/pi-home-stack")

# How often the rules are looked at. A minute is enough for a lamp left on and
# for a disk filling up; anything faster would poll the home service harder than
# the dashboard does.
TICK_S = int(os.environ.get("PHS_NOTIFY_TICK", "60"))
# The upstream check is a call to somebody else's server, and the answer changes
# a few times a year.
UPSTREAM_EVERY_S = 3600
HTTP_TIMEOUT = 8


# ── Storage ──────────────────────────────────────────────────────────────────

def connect():
    conn = sqlite3.connect(DB_FILE, timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def get_db():
    if "db" not in g:
        g.db = connect()
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    conn = connect()
    with open(SCHEMA_FILE, encoding="utf-8") as handle:
        conn.executescript(handle.read())
    conn.commit()
    conn.close()


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def rows(result):
    return [dict(row) for row in result]


def current_user_id():
    """Whose rules, whose bell. No default: a forgotten header would otherwise
    quietly show somebody else's notifications."""
    user_id = request.headers.get(USER_HEADER, "").strip()
    if not user_id:
        abort(400, f"{USER_HEADER} fehlt")
    if not SAFE_ID.match(user_id):
        abort(400, "Ungueltige Benutzer-ID")
    return user_id


def load_params(text):
    try:
        value = json.loads(text or "{}")
        return value if isinstance(value, dict) else {}
    except ValueError:
        return {}


# ── Gathering the facts ──────────────────────────────────────────────────────

_upstream_cache = {"checked_at": None, "data": {}}


def local_version():
    try:
        with open(VERSION_FILE, encoding="utf-8") as handle:
            return handle.read().strip() or None
    except OSError:
        return None


def upstream_release():
    """The newest release upstream, asked for at most once an hour.

    Unauthenticated, which GitHub allows sixty times an hour from one address -
    far more than needed, and asking more often would spend that budget on an
    answer that changes a few times a year.
    """
    checked = _upstream_cache["checked_at"]
    if checked and (datetime.now(timezone.utc) - checked).total_seconds() < UPSTREAM_EVERY_S:
        return _upstream_cache["data"]
    data = {"local": local_version()}
    try:
        response = requests.get(
            f"https://api.github.com/repos/{UPSTREAM_REPO}/releases/latest",
            timeout=HTTP_TIMEOUT, headers={"Accept": "application/vnd.github+json"})
        if response.ok:
            payload = response.json()
            data.update({"tag": payload.get("tag_name"),
                         "name": payload.get("name"),
                         "url": payload.get("html_url")})
    except (requests.RequestException, ValueError):
        # No upstream answer is not an event. The rule simply finds nothing.
        pass
    _upstream_cache.update({"checked_at": datetime.now(timezone.utc), "data": data})
    return data


def gather(needs):
    """Only what the enabled rules actually need.

    A flat with no notification rules about the home should not make this
    service poll the home service once a minute forever.
    """
    context = {}
    if "home" in needs:
        try:
            response = requests.get(f"{HOME_API}/overview", timeout=HTTP_TIMEOUT)
            context["home"] = response.json() if response.ok else None
        except (requests.RequestException, ValueError):
            context["home"] = None
    if "status" in needs:
        try:
            with open(STATUS_FILE, encoding="utf-8") as handle:
                context["status"] = json.load(handle)
        except (OSError, ValueError):
            context["status"] = None
    if "upstream" in needs:
        context["upstream"] = upstream_release()
    return context


# ── Watching things change ───────────────────────────────────────────────────

def record(db, key, value):
    """Writes what was seen, moving the timestamp only when the value moved.

    That is the whole trick behind "for how long": the services that hold the
    lamp know it is on, not since when, and nothing in the flat remembers for
    them.
    """
    moment = now_iso()
    row = db.execute("SELECT value, since FROM observation WHERE key = ?", (key,)).fetchone()
    if row is None:
        db.execute("INSERT INTO observation (key, value, since, seen_at) VALUES (?, ?, ?, ?)",
                   (key, value, moment, moment))
        return
    if row["value"] != value:
        db.execute("UPDATE observation SET value = ?, since = ?, seen_at = ? WHERE key = ?",
                   (value, moment, moment, key))
    else:
        db.execute("UPDATE observation SET seen_at = ? WHERE key = ?", (moment, key))


def observe(db, context):
    """Records the states worth timing, and returns how old each one is."""
    home = context.get("home")
    if home:
        for room in home.get("rooms") or []:
            lights = room.get("lights") or {}
            if lights.get("bound"):
                record(db, f"room.{room.get('key')}.lights_on",
                       "on" if lights.get("on") else "off")
    db.commit()

    ages = {}
    for row in db.execute("SELECT key, value, since FROM observation").fetchall():
        minutes = rule_api.minutes_since(row["since"])
        # Only a state that still holds has an age worth reporting. An "off"
        # that has lasted three hours is not a lamp burning for three hours.
        ages[row["key"]] = minutes if row["value"] == "on" else None
    return ages


# ── Saying it ────────────────────────────────────────────────────────────────

def deliver(db, user_id, event, rule_id=None):
    db.execute(
        "INSERT INTO notification (rule_id, user_id, created_at, level, title, body, link) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (rule_id, user_id, now_iso(), event.get("level", "info"),
         event["title"], event.get("body"), event.get("link")))
    for channel in db.execute(
            "SELECT * FROM channel WHERE user_id = ? AND enabled = 1", (user_id,)).fetchall():
        error = send_to_channel(channel, event)
        db.execute("UPDATE channel SET last_error = ? WHERE id = ?", (error, channel["id"]))


def send_to_channel(channel, event):
    """One generic webhook rather than an integration per service.

    ntfy, Gotify, Home Assistant and Discord all take a POST; what differs is
    the shape of the body, and that is what the template is for. Returns the
    trouble as a string, because a channel that keeps failing should say so in
    its own row rather than in a log nobody reads.
    """
    if channel["kind"] != "webhook":
        return None
    config = load_params(channel["config"])
    url = config.get("url")
    if not url:
        return "Keine Adresse hinterlegt"
    body = {"title": event["title"], "message": event.get("body") or "",
            "priority": event.get("level", "info")}
    if event.get("link"):
        body["link"] = event["link"]
    template = config.get("template")
    if template:
        # A service that wants its own field names gets them, without this file
        # growing a branch per service.
        try:
            body = json.loads(template
                              .replace("{{title}}", json.dumps(event["title"])[1:-1])
                              .replace("{{body}}", json.dumps(event.get("body") or "")[1:-1])
                              .replace("{{level}}", event.get("level", "info"))
                              .replace("{{link}}", event.get("link") or ""))
        except ValueError:
            return "Vorlage ist kein gültiges JSON"
    try:
        response = requests.post(url, json=body, timeout=HTTP_TIMEOUT,
                                 headers=load_params(channel["config"]).get("headers") or {})
        return None if response.ok else f"HTTP {response.status_code}"
    except requests.RequestException as error:
        return str(error)[:200]


# ── The loop ─────────────────────────────────────────────────────────────────

def evaluate(db):
    """One pass over every enabled rule."""
    active = rows(db.execute("SELECT * FROM rule WHERE enabled = 1").fetchall())
    if not active:
        return 0
    needs = {rule_api.KINDS[r["kind"]]["needs"] for r in active if r["kind"] in rule_api.KINDS}
    context = gather(needs)
    ages = observe(db, context)

    moment = datetime.now(timezone.utc)
    sent = 0
    for rule in active:
        spec = rule_api.KINDS.get(rule["kind"])
        if spec is None:
            continue
        last = rule_api.parse(rule["last_fired_at"])
        if last and (moment - last).total_seconds() < rule["cooldown_s"]:
            continue
        try:
            events = spec["check"](context, load_params(rule["params"]), ages)
        except Exception as error:                       # noqa: BLE001
            # A broken rule must not stop the others, and must not kill the
            # thread that would have checked them tomorrow.
            print(f"rule {rule['id']} ({rule['kind']}): {error}", flush=True)
            continue
        if not events:
            continue
        for event in events:
            deliver(db, rule["user_id"], event, rule["id"])
            sent += 1
        db.execute("UPDATE rule SET last_fired_at = ? WHERE id = ?", (now_iso(), rule["id"]))
    db.commit()
    return sent


class Watcher:
    def __init__(self):
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="notify-watcher", daemon=True)
        self._thread.start()

    def _loop(self):
        while not self._stop.is_set():
            db = connect()
            try:
                evaluate(db)
            except Exception as error:                   # noqa: BLE001
                print(f"notify watcher: {error}", flush=True)
            finally:
                db.close()
            self._stop.wait(TICK_S)


watcher = Watcher()


# ── Rules ────────────────────────────────────────────────────────────────────

RULE_FIELDS = ["kind", "name", "enabled", "params", "cooldown_s"]


def rule_out(row):
    rule = dict(row)
    rule["params"] = load_params(rule["params"])
    spec = rule_api.KINDS.get(rule["kind"])
    rule["label"] = spec["label"] if spec else rule["kind"]
    return rule


@app.route("/kinds", methods=["GET"])
def list_kinds():
    return jsonify(rule_api.describe())


@app.route("/rules", methods=["GET"])
def list_rules():
    db = get_db()
    return jsonify([rule_out(r) for r in db.execute(
        "SELECT * FROM rule WHERE user_id = ? ORDER BY id", (current_user_id(),)).fetchall()])


@app.route("/rules", methods=["POST"])
def create_rule():
    body = request.get_json(silent=True) or {}
    kind = body.get("kind")
    if kind not in rule_api.KINDS:
        abort(400, f"Unbekannte Regel: {kind}")
    user_id = current_user_id()
    db = get_db()
    cursor = db.execute(
        "INSERT INTO rule (user_id, kind, name, enabled, params, cooldown_s) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (user_id, kind, body.get("name") or rule_api.KINDS[kind]["label"],
         int(bool(body.get("enabled", True))),
         json.dumps(body.get("params") or {}),
         int(body.get("cooldown_s") or 3600)))
    db.commit()
    return jsonify(rule_out(db.execute(
        "SELECT * FROM rule WHERE id = ?", (cursor.lastrowid,)).fetchone())), 201


@app.route("/rules/<int:rule_id>", methods=["PUT"])
def update_rule(rule_id):
    body = request.get_json(silent=True) or {}
    user_id = current_user_id()
    db = get_db()
    # Scoped by user as well as by id: an id is guessable, and a rule is
    # somebody's.
    existing = db.execute("SELECT * FROM rule WHERE id = ? AND user_id = ?",
                          (rule_id, user_id)).fetchone()
    if existing is None:
        abort(404)
    values = {
        "kind": body.get("kind", existing["kind"]),
        "name": body.get("name", existing["name"]),
        "enabled": int(bool(body.get("enabled", existing["enabled"]))),
        "params": json.dumps(body["params"]) if "params" in body else existing["params"],
        "cooldown_s": int(body.get("cooldown_s", existing["cooldown_s"])),
    }
    if values["kind"] not in rule_api.KINDS:
        abort(400, f"Unbekannte Regel: {values['kind']}")
    db.execute(
        f"UPDATE rule SET {', '.join(f'{k} = ?' for k in RULE_FIELDS)}, updated_at = ? "
        f"WHERE id = ?", [values[k] for k in RULE_FIELDS] + [now_iso(), rule_id])
    db.commit()
    return jsonify(rule_out(db.execute("SELECT * FROM rule WHERE id = ?", (rule_id,)).fetchone()))


@app.route("/rules/<int:rule_id>", methods=["DELETE"])
def delete_rule(rule_id):
    db = get_db()
    db.execute("DELETE FROM rule WHERE id = ? AND user_id = ?", (rule_id, current_user_id()))
    db.commit()
    return jsonify({"ok": True})


@app.route("/rules/check", methods=["POST"])
def check_now():
    """Runs the rules immediately instead of waiting for the next minute.

    Mostly for the moment after writing one: a rule that does nothing is hard to
    tell from a rule that has not been looked at yet.
    """
    db = get_db()
    return jsonify({"ok": True, "sent": evaluate(db)})


# ── Notifications ────────────────────────────────────────────────────────────

@app.route("/notifications", methods=["GET"])
def list_notifications():
    db = get_db()
    limit = min(int(request.args.get("limit", 50)), 200)
    unread_only = request.args.get("unread") == "1"
    query = "SELECT * FROM notification WHERE user_id = ?"
    if unread_only:
        query += " AND read_at IS NULL"
    query += " ORDER BY created_at DESC, id DESC LIMIT ?"
    user_id = current_user_id()
    items = rows(db.execute(query, (user_id, limit)).fetchall())
    unread = db.execute(
        "SELECT COUNT(*) AS n FROM notification WHERE user_id = ? AND read_at IS NULL",
        (user_id,)).fetchone()["n"]
    return jsonify({"items": items, "unread": unread})


@app.route("/notifications/read", methods=["POST"])
def mark_read():
    body = request.get_json(silent=True) or {}
    db = get_db()
    user_id = current_user_id()
    if body.get("id"):
        db.execute("UPDATE notification SET read_at = ? WHERE id = ? AND user_id = ?",
                   (now_iso(), int(body["id"]), user_id))
    else:
        db.execute("UPDATE notification SET read_at = ? WHERE user_id = ? AND read_at IS NULL",
                   (now_iso(), user_id))
    db.commit()
    return jsonify({"ok": True})


@app.route("/notifications", methods=["DELETE"])
def clear_notifications():
    db = get_db()
    db.execute("DELETE FROM notification WHERE user_id = ? AND read_at IS NOT NULL",
               (current_user_id(),))
    db.commit()
    return jsonify({"ok": True})


# ── Channels ─────────────────────────────────────────────────────────────────

@app.route("/channels", methods=["GET"])
def list_channels():
    db = get_db()
    return jsonify([{**dict(c), "config": load_params(c["config"])} for c in db.execute(
        "SELECT * FROM channel WHERE user_id = ? ORDER BY id", (current_user_id(),)).fetchall()])


@app.route("/channels", methods=["POST"])
def create_channel():
    body = request.get_json(silent=True) or {}
    if body.get("kind") != "webhook":
        abort(400, "Nur webhook wird unterstuetzt")
    config = body.get("config") or {}
    if not str(config.get("url") or "").startswith(("http://", "https://")):
        abort(400, "Die Adresse muss mit http:// oder https:// beginnen")
    db = get_db()
    cursor = db.execute(
        "INSERT INTO channel (user_id, kind, config, enabled) VALUES (?, 'webhook', ?, ?)",
        (current_user_id(), json.dumps(config), int(bool(body.get("enabled", True)))))
    db.commit()
    row = db.execute("SELECT * FROM channel WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return jsonify({**dict(row), "config": load_params(row["config"])}), 201


@app.route("/channels/<int:channel_id>", methods=["DELETE"])
def delete_channel(channel_id):
    db = get_db()
    db.execute("DELETE FROM channel WHERE id = ? AND user_id = ?",
               (channel_id, current_user_id()))
    db.commit()
    return jsonify({"ok": True})


@app.route("/channels/<int:channel_id>/test", methods=["POST"])
def test_channel(channel_id):
    db = get_db()
    channel = db.execute("SELECT * FROM channel WHERE id = ? AND user_id = ?",
                         (channel_id, current_user_id())).fetchone()
    if channel is None:
        abort(404)
    error = send_to_channel(channel, {
        "level": "info", "title": "Testnachricht",
        "body": "Wenn das ankommt, ist der Kanal richtig eingerichtet."})
    db.execute("UPDATE channel SET last_error = ? WHERE id = ?", (error, channel_id))
    db.commit()
    return jsonify({"ok": error is None, "error": error}), (200 if error is None else 502)


@app.route("/version", methods=["GET"])
def version():
    return jsonify(upstream_release())


if __name__ == "__main__":
    init_db()
    watcher.start()
    app.run(host="0.0.0.0", port=5006, threaded=True)
