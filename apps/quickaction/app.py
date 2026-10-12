from flask import Flask, jsonify, request, abort
from flask_cors import CORS
import json
import os
from datetime import datetime, timezone

app = Flask(__name__)
CORS(app)

DATA_DIR  = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
TODOS_FILE = os.path.join(DATA_DIR, "_todos.json")
os.makedirs(DATA_DIR, exist_ok=True)


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


# ── Todos (live sync) ────────────────────────────────────────────────────────

@app.route("/todos", methods=["GET"])
def get_todos():
    if not os.path.exists(TODOS_FILE):
        return jsonify([])
    with open(TODOS_FILE, encoding="utf-8") as f:
        return jsonify(json.load(f))


@app.route("/todos", methods=["PUT"])
def save_todos():
    body = request.get_json(silent=True)
    if body is None:
        abort(400)
    with open(TODOS_FILE, "w", encoding="utf-8") as f:
        json.dump(body, f, ensure_ascii=False, indent=2)
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001)
