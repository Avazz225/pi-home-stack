"""Profiles, the user registry, and the todo list.

The registry lives here because this service is always installed with the
dashboard's backends and it already owned the one thing that identified a
person. It is not authentication: anyone on this network can call these
endpoints as anyone. That is the same trust model as the rest of the stack -
a flat's LAN - and it is worth saying out loud rather than implying a security
boundary that does not exist.

Users are identified by an id, never by their name. A name is a label that gets
corrected; the id is what the other services store next to their rows, and
renaming a person must not mean rewriting three databases.
"""

from flask import Flask, jsonify, request, abort, send_from_directory
from flask_cors import CORS
import json
import os
import shutil
import uuid
from datetime import datetime, timezone

app = Flask(__name__)
CORS(app)
# The id of the user a request speaks for. The dashboard sends it on every call;
# curl has to as well, and gets a 400 rather than silently writing into whatever
# happens to be first.
USER_HEADER = "X-Home-User"

DATA_DIR  = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
USERS_FILE = os.path.join(DATA_DIR, "_users.json")
TODOS_DIR = os.path.join(DATA_DIR, "todos")
# The single shared list from before there were users. Kept until it is adopted,
# never read as anybody's: that decision belongs to whoever runs the flat.
LEGACY_TODOS_FILE = os.path.join(DATA_DIR, "_todos.json")
GALLERY_FILE = os.path.join(DATA_DIR, "_gallery.json")
# Where uploaded pictures go by default. Inside the service's own data
# directory, which the installer points at the data store when there is one and
# leaves local when there is not - so this works on a Pi with a RAID and on a Pi
# with nothing but its card, without being asked.
DEFAULT_GALLERY_DIR = os.path.join(DATA_DIR, "gallery")

# What a browser can actually display, and what a picture frame has any use for.
ALLOWED_IMAGE_TYPES = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif",
}
# A photo, not a film. Generous enough for anything a phone takes, small enough
# that a mistyped upload cannot fill the card.
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(TODOS_DIR, exist_ok=True)


def read_json(path, default):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return default


def write_json(path, data):
    # Written beside the target and moved into place: a reader must never find a
    # half-written list, and on a Pi the power goes before the write finishes.
    temporary = f"{path}.tmp-{os.getpid()}"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
    os.replace(temporary, path)


# ── Gallery ──────────────────────────────────────────────────────────────────
#
# The picture frame on an old tablet, which is what the gallery is for. Two
# kinds of entry, because the two answer different needs: an upload is a picture
# that lives on this Pi and is in its backup, a link is one that lives wherever
# it already lives - a NAS share, a photo service - and costs nothing here.
#
# The pictures of the flat, not of a person: a frame in the hallway shows the
# same thing to everybody walking past.


def gallery_state():
    state = read_json(GALLERY_FILE, {})
    return {
        "dir": state.get("dir") or DEFAULT_GALLERY_DIR,
        "entries": [e for e in (state.get("entries") or []) if e.get("id")],
    }


def save_gallery(state):
    write_json(GALLERY_FILE, state)


def gallery_dir():
    directory = gallery_state()["dir"]
    os.makedirs(directory, exist_ok=True)
    return directory


@app.route("/gallery", methods=["GET"])
def list_gallery():
    state = gallery_state()
    free = None
    try:
        free = shutil.disk_usage(os.path.dirname(state["dir"].rstrip("/")) or "/").free
    except OSError:
        pass
    return jsonify({**state, "default_dir": DEFAULT_GALLERY_DIR,
                    "max_bytes": MAX_UPLOAD_BYTES, "free_bytes": free})


@app.route("/gallery/settings", methods=["PUT"])
def set_gallery_dir():
    """Moves where uploads are kept.

    Checked by writing, not by looking: a directory can exist, be on the wrong
    filesystem, and still be unwritable by this service - and the way that shows
    up otherwise is a failed upload much later.
    """
    body = request.get_json(silent=True) or {}
    directory = (body.get("dir") or "").strip() or DEFAULT_GALLERY_DIR
    if not os.path.isabs(directory):
        abort(400, "Der Pfad muss absolut sein")
    try:
        os.makedirs(directory, exist_ok=True)
        probe = os.path.join(directory, ".write-test")
        with open(probe, "w", encoding="utf-8") as handle:
            handle.write("ok")
        os.remove(probe)
    except OSError as error:
        abort(400, f"Dort kann nicht geschrieben werden: {error}")

    state = gallery_state()
    old = state["dir"]
    moved = 0
    if os.path.abspath(old) != os.path.abspath(directory):
        # The pictures go with the setting. Leaving them behind would turn a
        # change of directory into a silent loss of the gallery.
        for entry in state["entries"]:
            if entry.get("kind") != "upload":
                continue
            source = os.path.join(old, entry["file"])
            if os.path.exists(source):
                shutil.move(source, os.path.join(directory, entry["file"]))
                moved += 1
    state["dir"] = directory
    save_gallery(state)
    return jsonify({"ok": True, "dir": directory, "moved": moved})


@app.route("/gallery/upload", methods=["POST"])
def upload_image():
    upload = request.files.get("file")
    if upload is None or not upload.filename:
        abort(400, "Keine Datei")
    extension = os.path.splitext(upload.filename)[1].lower()
    if extension not in ALLOWED_IMAGE_TYPES:
        abort(400, f"Nicht unterstuetzt: {extension or 'ohne Endung'}")

    # The name on disk is ours, never the one that came in: a file name from a
    # browser is user input, and this one ends up in a path.
    entry_id = uuid.uuid4().hex[:16]
    stored = f"{entry_id}{extension}"
    upload.save(os.path.join(gallery_dir(), stored))

    state = gallery_state()
    state["entries"].append({
        "id": entry_id,
        "kind": "upload",
        "file": stored,
        "name": sanitize(upload.filename) or stored,
        "type": ALLOWED_IMAGE_TYPES[extension],
        "added_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    })
    save_gallery(state)
    return jsonify(state["entries"][-1]), 201


@app.route("/gallery/url", methods=["POST"])
def add_image_url():
    body = request.get_json(silent=True) or {}
    url = (body.get("url") or "").strip()
    if not url.startswith(("http://", "https://")):
        abort(400, "Die Adresse muss mit http:// oder https:// beginnen")
    state = gallery_state()
    entry = {
        "id": uuid.uuid4().hex[:16],
        "kind": "url",
        "url": url,
        "name": sanitize(body.get("name") or "") or url.rsplit("/", 1)[-1][:80],
        "added_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    state["entries"].append(entry)
    save_gallery(state)
    return jsonify(entry), 201


@app.route("/gallery/<entry_id>", methods=["DELETE"])
def delete_image(entry_id):
    state = gallery_state()
    entry = next((e for e in state["entries"] if e["id"] == entry_id), None)
    if entry is None:
        abort(404)
    state["entries"] = [e for e in state["entries"] if e["id"] != entry_id]
    save_gallery(state)
    if entry.get("kind") == "upload":
        try:
            os.remove(os.path.join(state["dir"], entry["file"]))
        except OSError:
            # The list is what the frame reads. A file that cannot be removed is
            # a stray on disk, not a picture that keeps appearing.
            pass
    return jsonify({"ok": True})


@app.route("/gallery/file/<entry_id>", methods=["GET"])
def serve_image(entry_id):
    """Serves an uploaded picture.

    Looked up by id in the list rather than taken from the path: the file name
    is then never built from anything the caller sent, which is the only way a
    path cannot be traversed.
    """
    state = gallery_state()
    entry = next((e for e in state["entries"]
                  if e["id"] == entry_id and e.get("kind") == "upload"), None)
    if entry is None:
        abort(404)
    return send_from_directory(state["dir"], entry["file"], mimetype=entry.get("type"))


# ── Users ────────────────────────────────────────────────────────────────────

def load_users():
    users = read_json(USERS_FILE, {"users": []}).get("users") or []
    return [u for u in users if u.get("id") and u.get("name")]


def user_by_id(user_id):
    return next((u for u in load_users() if u["id"] == user_id), None)


def current_user_id():
    """The user this request speaks for, or a 400 saying so.

    No default. Falling back to the first user would mean a forgotten header
    quietly writes into somebody's todo list, and the mistake would only show up
    as items appearing in the wrong place.
    """
    user_id = request.headers.get(USER_HEADER, "").strip()
    if not user_id:
        abort(400, f"{USER_HEADER} fehlt")
    if user_by_id(user_id) is None:
        abort(404, f"Unbekannter Benutzer: {user_id}")
    return user_id


@app.route("/users", methods=["GET"])
def list_users():
    return jsonify(load_users())


@app.route("/users", methods=["POST"])
def create_user():
    body = request.get_json(silent=True) or {}
    name = sanitize(body.get("name") or "")
    if not name:
        abort(400, "name is required")
    users = load_users()
    if any(u["name"].lower() == name.lower() for u in users):
        abort(409, "Diesen Namen gibt es schon")
    user = {"id": uuid.uuid4().hex[:12], "name": name,
            "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    users.append(user)
    write_json(USERS_FILE, {"users": users})
    return jsonify(user), 201


@app.route("/users/<user_id>", methods=["PUT"])
def rename_user(user_id):
    body = request.get_json(silent=True) or {}
    name = sanitize(body.get("name") or "")
    if not name:
        abort(400, "name is required")
    users = load_users()
    if any(u["name"].lower() == name.lower() and u["id"] != user_id for u in users):
        abort(409, "Diesen Namen gibt es schon")
    for user in users:
        if user["id"] == user_id:
            user["name"] = name
            write_json(USERS_FILE, {"users": users})
            return jsonify(user)
    abort(404)


@app.route("/users/<user_id>", methods=["DELETE"])
def delete_user(user_id):
    """Removes the entry. The data stays.

    Deliberately: this service cannot delete rows in the tracking or study
    databases, and pretending otherwise would be worse than leaving them. The
    interface says so before it asks.
    """
    users = load_users()
    remaining = [u for u in users if u["id"] != user_id]
    if len(remaining) == len(users):
        abort(404)
    write_json(USERS_FILE, {"users": remaining})
    todos = os.path.join(TODOS_DIR, f"{user_id}.json")
    kept = os.path.exists(todos)
    return jsonify({"ok": True, "todos_kept": kept})


def sanitize(name: str) -> str:
    """Strip path-traversal chars, keep unicode letters/digits/spaces/hyphens."""
    return name.replace("/", "").replace("\\", "").replace("..", "").strip()[:80]


def profile_path(name: str) -> str:
    return os.path.join(DATA_DIR, f"{sanitize(name)}.json")


# ── List all profiles ────────────────────────────────────────────────────────

@app.route("/profiles", methods=["GET"])
def list_profiles():
    profiles = []
    for fname in os.listdir(DATA_DIR):
        if not fname.endswith(".json"):
            continue
        try:
            with open(os.path.join(DATA_DIR, fname), encoding="utf-8") as f:
                data = json.load(f)
            profiles.append({
                "name": data.get("name", fname[:-5]),
                "savedAt": data.get("savedAt"),
            })
        except Exception:
            pass
    profiles.sort(key=lambda p: p.get("savedAt") or "", reverse=True)
    return jsonify(profiles)


# ── Get a single profile ─────────────────────────────────────────────────────

@app.route("/profiles/<name>", methods=["GET"])
def get_profile(name):
    path = profile_path(name)
    if not os.path.exists(path):
        abort(404)
    with open(path, encoding="utf-8") as f:
        return jsonify(json.load(f))


# ── Save / overwrite a profile ───────────────────────────────────────────────

@app.route("/profiles/<name>", methods=["PUT"])
def save_profile(name):
    body = request.get_json(silent=True)
    if not body:
        abort(400)
    body["name"] = name
    body["savedAt"] = datetime.now(timezone.utc).isoformat()
    with open(profile_path(name), "w", encoding="utf-8") as f:
        json.dump(body, f, ensure_ascii=False, indent=2)
    return jsonify({"ok": True, "name": name})


# ── Delete a profile ─────────────────────────────────────────────────────────

@app.route("/profiles/<name>", methods=["DELETE"])
def delete_profile(name):
    path = profile_path(name)
    if os.path.exists(path):
        os.remove(path)
    return jsonify({"ok": True})


# ── Todos (live sync, one list per user) ─────────────────────────────────────

def todos_path(user_id):
    return os.path.join(TODOS_DIR, f"{user_id}.json")


@app.route("/todos", methods=["GET"])
def get_todos():
    return jsonify(read_json(todos_path(current_user_id()), []))


@app.route("/todos", methods=["PUT"])
def save_todos():
    user_id = current_user_id()
    body = request.get_json(silent=True)
    if body is None:
        abort(400)
    write_json(todos_path(user_id), body)
    return jsonify({"ok": True})


# ── Adopting what was there before users ─────────────────────────────────────

@app.route("/legacy", methods=["GET"])
def legacy_status():
    """What is lying around from before, so the interface can offer to adopt it
    instead of leaving it to be discovered as "my todos are gone"."""
    todos = read_json(LEGACY_TODOS_FILE, None) if os.path.exists(LEGACY_TODOS_FILE) else None
    return jsonify({"todos": len(todos) if isinstance(todos, list) else 0})


@app.route("/legacy/adopt", methods=["POST"])
def adopt_legacy():
    user_id = current_user_id()
    todos = read_json(LEGACY_TODOS_FILE, None) if os.path.exists(LEGACY_TODOS_FILE) else None
    if not isinstance(todos, list):
        return jsonify({"ok": True, "todos": 0})
    existing = read_json(todos_path(user_id), [])
    # Appended, not replaced: the user may already have written something, and
    # losing that to an adoption would be the worse of the two surprises.
    write_json(todos_path(user_id), existing + todos)
    os.replace(LEGACY_TODOS_FILE, f"{LEGACY_TODOS_FILE}.adopted")
    return jsonify({"ok": True, "todos": len(todos)})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001)
