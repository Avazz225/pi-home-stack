"""REST API behind the dashboard's backup pane.

Serves the NAS folder tree, the per-folder backup selection, the S3/KeePass
configuration and the run history. The actual backup work happens in
backup_job.py, which this service can also start on demand.
"""

import os
import sqlite3
import subprocess
import sys

from flask import Flask, abort, g, jsonify, request
from flask_cors import CORS

import state
from backup_job import check_config

app = Flask(__name__)
CORS(app)

JOB_SCRIPT = os.path.join(state.BASE_DIR, "backup_job.py")
# A directory listing is capped so a folder with a huge number of entries cannot
# stall the dashboard. When the cap is hit the response says so, because silently
# hiding subfolders would hide backup decisions the operator still has to make.
MAX_TREE_ENTRIES = 20000


def get_db():
    if "db" not in g:
        g.db = state.connect()
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def config_or_abort():
    return state.get_config(get_db())


def rel_arg(value):
    try:
        return state.normalize_rel(value)
    except ValueError as exc:
        abort(400, str(exc))


# ── Health ───────────────────────────────────────────────────────────────────

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


# ── Configuration ────────────────────────────────────────────────────────────

def config_payload(db):
    cfg = state.get_config(db)
    payload = state.masked_config(cfg)
    payload["problems"] = check_config(cfg, state.get_targets(db))
    return payload


@app.route("/config", methods=["GET"])
def read_config():
    return jsonify(config_payload(get_db()))


@app.route("/config", methods=["PUT"])
def write_config():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        abort(400, "JSON object expected")
    db = get_db()
    state.set_config(db, state.merge_secrets(body))
    return jsonify(config_payload(db))


@app.route("/config/check", methods=["POST"])
def deep_check():
    """Verifies every enabled target and that the backup key file is readable."""
    db = get_db()
    problems = check_config(state.get_config(db), state.get_targets(db), deep=True)
    return jsonify({"ok": not problems, "problems": problems})


# ── Backup targets ───────────────────────────────────────────────────────────

def targets_payload(db):
    coverage = state.target_coverage(db)
    out = []
    for target in state.get_targets(db):
        target["enabled"] = bool(target["enabled"])
        target["coverage"] = coverage.get(target["id"], {
            "liveObjects": 0, "current": 0, "outdated": 0, "missing": 0, "bytes": 0,
        })
        out.append(target)
    return out


@app.route("/targets", methods=["GET"])
def list_targets():
    return jsonify(targets_payload(get_db()))


@app.route("/targets", methods=["POST"])
def create_target():
    body = request.get_json(silent=True) or {}
    db = get_db()
    try:
        state.create_target(db, body)
    except ValueError as exc:
        abort(400, str(exc))
    except sqlite3.IntegrityError:
        abort(409, "Für diesen Bucket und dieses Präfix gibt es bereits ein Ziel.")
    return jsonify(targets_payload(db)), 201


@app.route("/targets/<int:target_id>", methods=["PUT"])
def edit_target(target_id):
    body = request.get_json(silent=True) or {}
    db = get_db()
    try:
        if state.update_target(db, target_id, body) is None:
            abort(404)
    except ValueError as exc:
        abort(400, str(exc))
    except sqlite3.IntegrityError:
        abort(409, "Für diesen Bucket und dieses Präfix gibt es bereits ein Ziel.")
    return jsonify(targets_payload(db))


@app.route("/targets/<int:target_id>", methods=["DELETE"])
def remove_target(target_id):
    db = get_db()
    if state.get_target(db, target_id) is None:
        abort(404)
    state.delete_target(db, target_id)
    return jsonify(targets_payload(db))


# ── Folder tree ──────────────────────────────────────────────────────────────

def scan_children(abs_dir):
    """Direct subdirectories of abs_dir plus a file count, sorted by name."""
    subdirs, file_count, truncated = [], 0, False
    with os.scandir(abs_dir) as it:
        for index, entry in enumerate(it):
            if index >= MAX_TREE_ENTRIES:
                truncated = True
                break
            try:
                if entry.is_symlink():
                    continue
                if entry.is_dir(follow_symlinks=False):
                    subdirs.append(entry.name)
                elif entry.is_file(follow_symlinks=False):
                    file_count += 1
            except OSError:
                continue
    subdirs.sort(key=str.lower)
    return subdirs, file_count, truncated


def has_subdirs(abs_dir):
    """Cheap check used to decide whether a node is expandable."""
    try:
        with os.scandir(abs_dir) as it:
            for entry in it:
                try:
                    if entry.is_dir(follow_symlinks=False) and not entry.is_symlink():
                        return True
                except OSError:
                    continue
    except OSError:
        return False
    return False


@app.route("/tree", methods=["GET"])
def tree():
    rel = rel_arg(request.args.get("path", ""))
    cfg = config_or_abort()
    nas_root = cfg.get("nas_root") or ""
    abs_dir = os.path.join(nas_root, rel) if rel else nas_root

    if not nas_root or not os.path.isdir(abs_dir):
        abort(404, f"Verzeichnis nicht gefunden: {abs_dir}")

    rules = state.RuleSet(state.get_rules(get_db()))
    try:
        subdirs, file_count, truncated = scan_children(abs_dir)
    except OSError as exc:
        abort(403, f"Verzeichnis nicht lesbar: {exc.strerror}")

    entries = []
    for name in subdirs:
        child_rel = f"{rel}/{name}" if rel else name
        entries.append({
            "name": name,
            "path": child_rel,
            "rule": rules.explicit(child_rel),
            "effective": rules.mode(child_rel),
            "hasChildren": has_subdirs(os.path.join(abs_dir, name)),
        })

    return jsonify({
        "path": rel,
        "name": os.path.basename(abs_dir) or nas_root,
        "rule": rules.explicit(rel),
        "effective": rules.mode(rel),
        "fileCount": file_count,
        "truncated": truncated,
        "entries": entries,
    })


# ── Folder rules ─────────────────────────────────────────────────────────────

@app.route("/rules", methods=["GET"])
def list_rules():
    rules = state.get_rules(get_db())
    return jsonify([{"path": path, "mode": mode} for path, mode in sorted(rules.items())])


@app.route("/rules", methods=["PUT"])
def put_rule():
    body = request.get_json(silent=True) or {}
    rel = rel_arg(body.get("path", ""))
    mode = body.get("mode")
    db = get_db()
    if mode == "inherit":
        state.clear_rule(db, rel)
    elif mode in ("include", "exclude"):
        state.set_rule(db, rel, mode)
    else:
        abort(400, "mode must be include, exclude or inherit")
    rules = state.RuleSet(state.get_rules(db))
    return jsonify({"path": rel, "rule": rules.explicit(rel), "effective": rules.mode(rel)})


@app.route("/rules", methods=["DELETE"])
def delete_rule():
    rel = rel_arg(request.args.get("path", ""))
    state.clear_rule(get_db(), rel)
    return jsonify({"path": rel, "rule": None})


# ── Status and runs ──────────────────────────────────────────────────────────

def run_to_dict(row, with_log=False):
    data = dict(row)
    if not with_log:
        data.pop("log", None)
    return data


@app.route("/status", methods=["GET"])
def status():
    db = get_db()
    cfg = state.get_config(db)
    last = db.execute(
        "SELECT * FROM backup_run WHERE status != 'running' ORDER BY started_at DESC LIMIT 1"
    ).fetchone()
    running = db.execute(
        "SELECT * FROM backup_run WHERE status = 'running' ORDER BY started_at DESC LIMIT 1"
    ).fetchone()
    totals = db.execute(
        "SELECT COUNT(*) AS live, COALESCE(SUM(size), 0) AS bytes FROM backup_object "
        "WHERE deleted_at IS NULL"
    ).fetchone()
    pending = db.execute(
        "SELECT COUNT(*) AS marked FROM backup_object WHERE deleted_at IS NOT NULL"
    ).fetchone()
    included = db.execute(
        "SELECT COUNT(*) AS n FROM folder_rule WHERE mode = 'include'"
    ).fetchone()

    targets = targets_payload(db)
    # A file only counts as fully redundant once every active target holds the
    # current version — that is the number worth showing on the overview.
    active = [t for t in targets if t["enabled"]]
    fully_replicated = min([t["coverage"]["current"] for t in active], default=0)

    return jsonify({
        "enabled": cfg.get("enabled") == "1",
        "retentionDays": state.retention_days(cfg),
        "includedFolders": included["n"],
        "liveObjects": totals["live"],
        "liveBytes": totals["bytes"],
        "markedObjects": pending["marked"],
        "targets": targets,
        "activeTargets": len(active),
        "fullyReplicated": fully_replicated,
        "problems": check_config(cfg, state.get_targets(db)),
        "lastRun": run_to_dict(last) if last else None,
        "runningRun": run_to_dict(running) if running else None,
    })


@app.route("/runs", methods=["GET"])
def list_runs():
    limit = min(int(request.args.get("limit", 20)), 100)
    rows = get_db().execute(
        "SELECT * FROM backup_run ORDER BY started_at DESC LIMIT ?", (limit,)
    ).fetchall()
    return jsonify([run_to_dict(r) for r in rows])


@app.route("/runs/<int:run_id>", methods=["GET"])
def get_run(run_id):
    row = get_db().execute("SELECT * FROM backup_run WHERE id = ?", (run_id,)).fetchone()
    if not row:
        abort(404)
    return jsonify(run_to_dict(row, with_log=True))


@app.route("/runs", methods=["POST"])
def trigger_run():
    """Start a backup right now. Returns 409 while another run is still active."""
    body = request.get_json(silent=True) or {}
    db = get_db()
    active = db.execute("SELECT id FROM backup_run WHERE status = 'running'").fetchone()
    if active:
        return jsonify({"error": "Es läuft bereits eine Sicherung.", "runId": active["id"]}), 409

    args = [sys.executable, JOB_SCRIPT, "--trigger", "manual", "--force"]
    if body.get("dryRun"):
        args.append("--dry-run")
    try:
        subprocess.Popen(args, cwd=state.BASE_DIR, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError as exc:
        return jsonify({"error": f"Backup konnte nicht gestartet werden: {exc}"}), 500
    return jsonify({"started": True}), 202


@app.route("/objects", methods=["GET"])
def list_objects():
    """Object index, used by the UI to show what is backed up and what carries a marker.

    state=missing together with target=<id> answers 'what has this bucket not got
    (or got in an outdated version) yet'.
    """
    which = request.args.get("state", "live")
    limit = min(int(request.args.get("limit", 200)), 1000)
    path_filter = rel_arg(request.args.get("path", ""))
    target_id = request.args.get("target", type=int)

    query = "SELECT rel_path, size, encrypted, uploaded_at, deleted_at FROM backup_object o"
    conditions, params = [], []
    if which == "live":
        conditions.append("deleted_at IS NULL")
    elif which == "deleted":
        conditions.append("deleted_at IS NOT NULL")
    elif which == "missing":
        if not target_id:
            abort(400, "state=missing benötigt target=<id>")
        conditions.append("deleted_at IS NULL")
        conditions.append(
            "NOT EXISTS (SELECT 1 FROM object_target ot WHERE ot.object_id = o.id "
            "AND ot.target_id = ? AND ot.size = o.size AND ot.mtime_ns = o.mtime_ns)")
        params.append(target_id)
    if path_filter:
        conditions.append("(rel_path = ? OR rel_path LIKE ?)")
        params += [path_filter, f"{path_filter}/%"]
    if conditions:
        query += " WHERE " + " AND ".join(conditions)
    query += " ORDER BY rel_path LIMIT ?"
    params.append(limit)

    rows = get_db().execute(query, params).fetchall()
    return jsonify([dict(r) for r in rows])


if __name__ == "__main__":
    state.init_db()
    app.run(host="0.0.0.0", port=5003)
