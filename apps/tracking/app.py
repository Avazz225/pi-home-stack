from flask import Flask, jsonify, request, abort, g
from flask_cors import CORS
import sqlite3
import os
from datetime import datetime, timezone

app = Flask(__name__)
CORS(app)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_FILE = os.path.join(DATA_DIR, "tracking.db")
SCHEMA_FILE = os.path.join(BASE_DIR, "schema.sql")
os.makedirs(DATA_DIR, exist_ok=True)


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


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def row_to_dict(row):
    return dict(row) if row else None


def rows_to_list(rows):
    return [dict(r) for r in rows]


def cleanup_links(db, entity_type, entity_id):
    """Dependency/RiskLink sind polymorph (entity_type+entity_id) und können nicht über
    SQLite-FKs kaskadiert werden. Beim Löschen einer Entität müssen referenzierende
    Zeilen deshalb explizit entfernt werden, sonst bleiben verwaiste Verweise zurück."""
    db.execute(
        "DELETE FROM dependency WHERE entity_type = ? AND (from_id = ? OR to_id = ?)",
        (entity_type, entity_id, entity_id),
    )
    db.execute("DELETE FROM risk_link WHERE entity_type = ? AND entity_id = ?", (entity_type, entity_id))
    db.execute("DELETE FROM lesson_link WHERE entity_type = ? AND entity_id = ?", (entity_type, entity_id))


# ── Milestones ────────────────────────────────────────────────────────────────

MILESTONE_FIELDS = ["title", "description", "target_date", "status", "owner",
                     "mgmt_comment", "forecast_date", "forecast_confidence", "date_achievable"]


@app.route("/milestones", methods=["GET"])
def list_milestones():
    db = get_db()
    rows = db.execute("SELECT * FROM milestone ORDER BY target_date IS NULL, target_date").fetchall()
    return jsonify(rows_to_list(rows))


@app.route("/milestones", methods=["POST"])
def create_milestone():
    body = request.get_json(silent=True)
    if not body or not body.get("title"):
        abort(400, "title is required")
    db = get_db()
    values = {k: body.get(k) for k in MILESTONE_FIELDS}
    values["status"] = values.get("status") or "gruen"
    cur = db.execute(
        f"INSERT INTO milestone ({', '.join(MILESTONE_FIELDS)}) VALUES ({', '.join('?' for _ in MILESTONE_FIELDS)})",
        [values[k] for k in MILESTONE_FIELDS],
    )
    db.commit()
    row = db.execute("SELECT * FROM milestone WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(row_to_dict(row)), 201


@app.route("/milestones/<int:milestone_id>", methods=["GET"])
def get_milestone(milestone_id):
    db = get_db()
    row = db.execute("SELECT * FROM milestone WHERE id = ?", (milestone_id,)).fetchone()
    if not row:
        abort(404)
    return jsonify(row_to_dict(row))


@app.route("/milestones/<int:milestone_id>", methods=["PUT"])
def update_milestone(milestone_id):
    body = request.get_json(silent=True)
    if not body:
        abort(400)
    db = get_db()
    existing = db.execute("SELECT * FROM milestone WHERE id = ?", (milestone_id,)).fetchone()
    if not existing:
        abort(404)
    values = {k: body.get(k, existing[k]) for k in MILESTONE_FIELDS}
    db.execute(
        f"UPDATE milestone SET {', '.join(f'{k} = ?' for k in MILESTONE_FIELDS)}, updated_at = ? WHERE id = ?",
        [values[k] for k in MILESTONE_FIELDS] + [now_iso(), milestone_id],
    )
    db.commit()
    row = db.execute("SELECT * FROM milestone WHERE id = ?", (milestone_id,)).fetchone()
    return jsonify(row_to_dict(row))


@app.route("/milestones/<int:milestone_id>", methods=["DELETE"])
def delete_milestone(milestone_id):
    db = get_db()
    feature_ids = [r["id"] for r in db.execute("SELECT id FROM feature WHERE milestone_id = ?", (milestone_id,)).fetchall()]
    for feature_id in feature_ids:
        cleanup_feature_links(db, feature_id)
    cleanup_links(db, "milestone", milestone_id)
    db.execute("DELETE FROM milestone WHERE id = ?", (milestone_id,))
    db.commit()
    return jsonify({"ok": True})


@app.route("/milestones/<int:milestone_id>/features", methods=["GET"])
def list_features_for_milestone(milestone_id):
    db = get_db()
    rows = db.execute("SELECT * FROM feature WHERE milestone_id = ? ORDER BY target_date IS NULL, target_date",
                       (milestone_id,)).fetchall()
    return jsonify(rows_to_list(rows))


# ── Features ──────────────────────────────────────────────────────────────────

FEATURE_FIELDS = ["milestone_id", "title", "description", "business_value", "target_date", "owner",
                   "status", "risk_level", "progress", "done_criteria", "forecast_date",
                   "forecast_confidence", "date_achievable", "mgmt_status", "mgmt_status_reason",
                   "tech_status", "tech_status_reason"]


@app.route("/features", methods=["POST"])
def create_feature():
    body = request.get_json(silent=True)
    if not body or not body.get("title") or not body.get("milestone_id"):
        abort(400, "title and milestone_id are required")
    db = get_db()
    values = {k: body.get(k) for k in FEATURE_FIELDS}
    values["status"] = values.get("status") or "gruen"
    cur = db.execute(
        f"INSERT INTO feature ({', '.join(FEATURE_FIELDS)}) VALUES ({', '.join('?' for _ in FEATURE_FIELDS)})",
        [values[k] for k in FEATURE_FIELDS],
    )
    db.commit()
    row = db.execute("SELECT * FROM feature WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(row_to_dict(row)), 201


@app.route("/features/<int:feature_id>", methods=["GET"])
def get_feature(feature_id):
    db = get_db()
    row = db.execute("SELECT * FROM feature WHERE id = ?", (feature_id,)).fetchone()
    if not row:
        abort(404)
    return jsonify(row_to_dict(row))


@app.route("/features/<int:feature_id>", methods=["PUT"])
def update_feature(feature_id):
    body = request.get_json(silent=True)
    if not body:
        abort(400)
    db = get_db()
    existing = db.execute("SELECT * FROM feature WHERE id = ?", (feature_id,)).fetchone()
    if not existing:
        abort(404)
    values = {k: body.get(k, existing[k]) for k in FEATURE_FIELDS}
    db.execute(
        f"UPDATE feature SET {', '.join(f'{k} = ?' for k in FEATURE_FIELDS)}, updated_at = ? WHERE id = ?",
        [values[k] for k in FEATURE_FIELDS] + [now_iso(), feature_id],
    )
    db.commit()
    row = db.execute("SELECT * FROM feature WHERE id = ?", (feature_id,)).fetchone()
    return jsonify(row_to_dict(row))


def cleanup_feature_links(db, feature_id):
    wp_ids = [r["id"] for r in db.execute("SELECT id FROM work_package WHERE feature_id = ?", (feature_id,)).fetchall()]
    for wp_id in wp_ids:
        cleanup_links(db, "work_package", wp_id)
    cleanup_links(db, "feature", feature_id)


@app.route("/features/<int:feature_id>", methods=["DELETE"])
def delete_feature(feature_id):
    db = get_db()
    cleanup_feature_links(db, feature_id)
    db.execute("DELETE FROM feature WHERE id = ?", (feature_id,))
    db.commit()
    return jsonify({"ok": True})


@app.route("/features/<int:feature_id>/work-packages", methods=["GET"])
def list_work_packages_for_feature(feature_id):
    db = get_db()
    rows = db.execute("SELECT * FROM work_package WHERE feature_id = ? ORDER BY planned_start IS NULL, planned_start",
                       (feature_id,)).fetchall()
    return jsonify(rows_to_list(rows))


# ── Work packages (Arbeitspakete) ────────────────────────────────────────────

WORK_PACKAGE_FIELDS = ["feature_id", "title", "description", "owner", "status", "planned_start",
                        "planned_end", "actual_start", "actual_end", "schedule_risk",
                        "expected_completion_date"]


@app.route("/work-packages", methods=["POST"])
def create_work_package():
    body = request.get_json(silent=True)
    if not body or not body.get("title") or not body.get("feature_id"):
        abort(400, "title and feature_id are required")
    db = get_db()
    values = {k: body.get(k) for k in WORK_PACKAGE_FIELDS}
    values["status"] = values.get("status") or "offen"
    cur = db.execute(
        f"INSERT INTO work_package ({', '.join(WORK_PACKAGE_FIELDS)}) VALUES ({', '.join('?' for _ in WORK_PACKAGE_FIELDS)})",
        [values[k] for k in WORK_PACKAGE_FIELDS],
    )
    db.commit()
    row = db.execute("SELECT * FROM work_package WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(row_to_dict(row)), 201


@app.route("/work-packages/<int:wp_id>", methods=["GET"])
def get_work_package(wp_id):
    db = get_db()
    row = db.execute("SELECT * FROM work_package WHERE id = ?", (wp_id,)).fetchone()
    if not row:
        abort(404)
    return jsonify(row_to_dict(row))


@app.route("/work-packages/<int:wp_id>", methods=["PUT"])
def update_work_package(wp_id):
    body = request.get_json(silent=True)
    if not body:
        abort(400)
    db = get_db()
    existing = db.execute("SELECT * FROM work_package WHERE id = ?", (wp_id,)).fetchone()
    if not existing:
        abort(404)
    values = {k: body.get(k, existing[k]) for k in WORK_PACKAGE_FIELDS}
    db.execute(
        f"UPDATE work_package SET {', '.join(f'{k} = ?' for k in WORK_PACKAGE_FIELDS)}, updated_at = ? WHERE id = ?",
        [values[k] for k in WORK_PACKAGE_FIELDS] + [now_iso(), wp_id],
    )
    db.commit()
    row = db.execute("SELECT * FROM work_package WHERE id = ?", (wp_id,)).fetchone()
    return jsonify(row_to_dict(row))


@app.route("/work-packages/<int:wp_id>", methods=["DELETE"])
def delete_work_package(wp_id):
    db = get_db()
    cleanup_links(db, "work_package", wp_id)
    db.execute("DELETE FROM work_package WHERE id = ?", (wp_id,))
    db.commit()
    return jsonify({"ok": True})


@app.route("/work-packages/<int:wp_id>/cards", methods=["GET"])
def list_cards(wp_id):
    db = get_db()
    rows = db.execute("SELECT * FROM card_reference WHERE work_package_id = ?", (wp_id,)).fetchall()
    return jsonify(rows_to_list(rows))


@app.route("/work-packages/<int:wp_id>/cards", methods=["POST"])
def create_card(wp_id):
    body = request.get_json(silent=True)
    if not body or not body.get("card_id"):
        abort(400, "card_id is required")
    db = get_db()
    cur = db.execute(
        "INSERT INTO card_reference (work_package_id, card_id, card_name, url) VALUES (?, ?, ?, ?)",
        (wp_id, body["card_id"], body.get("card_name"), body.get("url")),
    )
    db.commit()
    row = db.execute("SELECT * FROM card_reference WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(row_to_dict(row)), 201


@app.route("/cards/<int:card_id>", methods=["DELETE"])
def delete_card(card_id):
    db = get_db()
    db.execute("DELETE FROM card_reference WHERE id = ?", (card_id,))
    db.commit()
    return jsonify({"ok": True})


# ── Hierarchy (Milestone → Feature → WorkPackage → CardReference, ein Aufruf) ─

@app.route("/hierarchy", methods=["GET"])
def hierarchy():
    db = get_db()
    milestones = rows_to_list(db.execute("SELECT * FROM milestone ORDER BY target_date IS NULL, target_date").fetchall())
    features = rows_to_list(db.execute("SELECT * FROM feature ORDER BY target_date IS NULL, target_date").fetchall())
    work_packages = rows_to_list(db.execute("SELECT * FROM work_package ORDER BY planned_start IS NULL, planned_start").fetchall())
    cards = rows_to_list(db.execute("SELECT * FROM card_reference").fetchall())

    cards_by_wp = {}
    for c in cards:
        cards_by_wp.setdefault(c["work_package_id"], []).append(c)

    wps_by_feature = {}
    for wp in work_packages:
        wp["cards"] = cards_by_wp.get(wp["id"], [])
        wps_by_feature.setdefault(wp["feature_id"], []).append(wp)

    features_by_milestone = {}
    for f in features:
        f["work_packages"] = wps_by_feature.get(f["id"], [])
        features_by_milestone.setdefault(f["milestone_id"], []).append(f)

    for m in milestones:
        m["features"] = features_by_milestone.get(m["id"], [])

    return jsonify(milestones)


# ── Dependencies ──────────────────────────────────────────────────────────────

ENTITY_TABLES = {"feature": "feature", "work_package": "work_package"}


@app.route("/dependencies", methods=["GET"])
def list_dependencies():
    entity_type = request.args.get("entity_type")
    if entity_type not in ENTITY_TABLES:
        abort(400, "entity_type must be 'feature' or 'work_package'")
    db = get_db()
    entity_id = request.args.get("entity_id")
    if entity_id:
        rows = db.execute(
            "SELECT * FROM dependency WHERE entity_type = ? AND (from_id = ? OR to_id = ?)",
            (entity_type, entity_id, entity_id),
        ).fetchall()
    else:
        rows = db.execute("SELECT * FROM dependency WHERE entity_type = ?", (entity_type,)).fetchall()
    return jsonify(rows_to_list(rows))


@app.route("/dependencies", methods=["POST"])
def create_dependency():
    body = request.get_json(silent=True)
    if not body or body.get("entity_type") not in ENTITY_TABLES or not body.get("from_id") or not body.get("to_id"):
        abort(400, "entity_type, from_id and to_id are required")
    db = get_db()
    cur = db.execute(
        "INSERT INTO dependency (entity_type, from_id, to_id, blocking, note) VALUES (?, ?, ?, ?, ?)",
        (body["entity_type"], body["from_id"], body["to_id"], 1 if body.get("blocking", True) else 0, body.get("note")),
    )
    db.commit()
    row = db.execute("SELECT * FROM dependency WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(row_to_dict(row)), 201


@app.route("/dependencies/<int:dep_id>", methods=["DELETE"])
def delete_dependency(dep_id):
    db = get_db()
    db.execute("DELETE FROM dependency WHERE id = ?", (dep_id,))
    db.commit()
    return jsonify({"ok": True})


def compute_dependency_chains(db, entity_type):
    """Für jeden Blocker: direkt abhängige Elemente + transitive Kette (wer ist alles betroffen)."""
    table = ENTITY_TABLES[entity_type]
    edges = db.execute(
        "SELECT from_id, to_id FROM dependency WHERE entity_type = ? AND blocking = 1", (entity_type,)
    ).fetchall()
    titles = {r["id"]: r["title"] for r in db.execute(f"SELECT id, title FROM {table}").fetchall()}

    adjacency = {}
    blocked_ids = set()
    for e in edges:
        adjacency.setdefault(e["to_id"], []).append(e["from_id"])
        blocked_ids.add(e["from_id"])

    def transitive_affected(start):
        seen = set()
        stack = list(adjacency.get(start, []))
        while stack:
            node = stack.pop()
            if node in seen:
                continue
            seen.add(node)
            stack.extend(adjacency.get(node, []))
        return seen

    chains = []
    for blocker_id, direct in adjacency.items():
        affected = transitive_affected(blocker_id)
        chains.append({
            "blocker_id": blocker_id,
            "blocker_title": titles.get(blocker_id, f"#{blocker_id}"),
            "direct": [{"id": i, "title": titles.get(i, f"#{i}")} for i in direct],
            "affected": [{"id": i, "title": titles.get(i, f"#{i}")} for i in affected],
            "affected_count": len(affected),
        })
    chains.sort(key=lambda c: c["affected_count"], reverse=True)
    return chains, blocked_ids


@app.route("/dependencies/chains", methods=["GET"])
def dependency_chains():
    entity_type = request.args.get("entity_type")
    if entity_type not in ENTITY_TABLES:
        abort(400, "entity_type must be 'feature' or 'work_package'")
    chains, _ = compute_dependency_chains(get_db(), entity_type)
    return jsonify(chains)


# ── Risks ─────────────────────────────────────────────────────────────────────

RISK_FIELDS = ["title", "description", "probability", "impact", "mitigation", "status",
               "escalation_required", "escalation_date"]


def attach_risk_links(db, risk):
    links = rows_to_list(db.execute("SELECT * FROM risk_link WHERE risk_id = ?", (risk["id"],)).fetchall())
    for link in links:
        table = {"milestone": "milestone", "feature": "feature", "work_package": "work_package"}[link["entity_type"]]
        row = db.execute(f"SELECT title FROM {table} WHERE id = ?", (link["entity_id"],)).fetchone()
        link["entity_title"] = row["title"] if row else None
    risk["links"] = links
    return risk


@app.route("/risks", methods=["GET"])
def list_risks():
    db = get_db()
    rows = rows_to_list(db.execute("SELECT * FROM risk ORDER BY status, impact DESC, probability DESC").fetchall())
    return jsonify([attach_risk_links(db, r) for r in rows])


@app.route("/risks", methods=["POST"])
def create_risk():
    body = request.get_json(silent=True)
    if not body or not body.get("title"):
        abort(400, "title is required")
    db = get_db()
    values = {k: body.get(k) for k in RISK_FIELDS}
    values["status"] = values.get("status") or "offen"
    values["escalation_required"] = 1 if values.get("escalation_required") else 0
    cur = db.execute(
        f"INSERT INTO risk ({', '.join(RISK_FIELDS)}) VALUES ({', '.join('?' for _ in RISK_FIELDS)})",
        [values[k] for k in RISK_FIELDS],
    )
    db.commit()
    row = row_to_dict(db.execute("SELECT * FROM risk WHERE id = ?", (cur.lastrowid,)).fetchone())
    return jsonify(attach_risk_links(db, row)), 201


@app.route("/risks/<int:risk_id>", methods=["GET"])
def get_risk(risk_id):
    db = get_db()
    row = db.execute("SELECT * FROM risk WHERE id = ?", (risk_id,)).fetchone()
    if not row:
        abort(404)
    return jsonify(attach_risk_links(db, row_to_dict(row)))


@app.route("/risks/<int:risk_id>", methods=["PUT"])
def update_risk(risk_id):
    body = request.get_json(silent=True)
    if not body:
        abort(400)
    db = get_db()
    existing = db.execute("SELECT * FROM risk WHERE id = ?", (risk_id,)).fetchone()
    if not existing:
        abort(404)
    values = {k: body.get(k, existing[k]) for k in RISK_FIELDS}
    values["escalation_required"] = 1 if values.get("escalation_required") else 0
    db.execute(
        f"UPDATE risk SET {', '.join(f'{k} = ?' for k in RISK_FIELDS)}, updated_at = ? WHERE id = ?",
        [values[k] for k in RISK_FIELDS] + [now_iso(), risk_id],
    )
    db.commit()
    row = row_to_dict(db.execute("SELECT * FROM risk WHERE id = ?", (risk_id,)).fetchone())
    return jsonify(attach_risk_links(db, row))


@app.route("/risks/<int:risk_id>", methods=["DELETE"])
def delete_risk(risk_id):
    db = get_db()
    db.execute("DELETE FROM risk WHERE id = ?", (risk_id,))
    db.commit()
    return jsonify({"ok": True})


@app.route("/risks/<int:risk_id>/links", methods=["POST"])
def create_risk_link(risk_id):
    body = request.get_json(silent=True)
    if not body or body.get("entity_type") not in ("milestone", "feature", "work_package") or not body.get("entity_id"):
        abort(400, "entity_type and entity_id are required")
    db = get_db()
    cur = db.execute(
        "INSERT INTO risk_link (risk_id, entity_type, entity_id) VALUES (?, ?, ?)",
        (risk_id, body["entity_type"], body["entity_id"]),
    )
    db.commit()
    row = db.execute("SELECT * FROM risk_link WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(row_to_dict(row)), 201


@app.route("/risk-links/<int:link_id>", methods=["DELETE"])
def delete_risk_link(link_id):
    db = get_db()
    db.execute("DELETE FROM risk_link WHERE id = ?", (link_id,))
    db.commit()
    return jsonify({"ok": True})


# ── Lessons Learned ───────────────────────────────────────────────────────────

LESSON_FIELDS = ["title", "category", "date", "description", "recommendation", "tags"]


def attach_lesson_links(db, lesson):
    links = rows_to_list(db.execute("SELECT * FROM lesson_link WHERE lesson_id = ?", (lesson["id"],)).fetchall())
    for link in links:
        table = "milestone" if link["entity_type"] == "milestone" else "feature"
        row = db.execute(f"SELECT title FROM {table} WHERE id = ?", (link["entity_id"],)).fetchone()
        link["entity_title"] = row["title"] if row else None
    lesson["links"] = links
    return lesson


@app.route("/lessons", methods=["GET"])
def list_lessons():
    db = get_db()
    search = request.args.get("search", "").strip()
    tag = request.args.get("tag", "").strip()
    query = "SELECT * FROM lesson_learned"
    clauses, params = [], []
    if search:
        clauses.append("(title LIKE ? OR description LIKE ? OR recommendation LIKE ? OR category LIKE ?)")
        params += [f"%{search}%"] * 4
    if tag:
        clauses.append("tags LIKE ?")
        params.append(f"%{tag}%")
    if clauses:
        query += " WHERE " + " AND ".join(clauses)
    query += " ORDER BY date IS NULL, date DESC"
    rows = rows_to_list(db.execute(query, params).fetchall())
    return jsonify([attach_lesson_links(db, r) for r in rows])


@app.route("/lessons", methods=["POST"])
def create_lesson():
    body = request.get_json(silent=True)
    if not body or not body.get("title"):
        abort(400, "title is required")
    db = get_db()
    values = {k: body.get(k) for k in LESSON_FIELDS}
    cur = db.execute(
        f"INSERT INTO lesson_learned ({', '.join(LESSON_FIELDS)}) VALUES ({', '.join('?' for _ in LESSON_FIELDS)})",
        [values[k] for k in LESSON_FIELDS],
    )
    db.commit()
    row = row_to_dict(db.execute("SELECT * FROM lesson_learned WHERE id = ?", (cur.lastrowid,)).fetchone())
    return jsonify(attach_lesson_links(db, row)), 201


@app.route("/lessons/<int:lesson_id>", methods=["PUT"])
def update_lesson(lesson_id):
    body = request.get_json(silent=True)
    if not body:
        abort(400)
    db = get_db()
    existing = db.execute("SELECT * FROM lesson_learned WHERE id = ?", (lesson_id,)).fetchone()
    if not existing:
        abort(404)
    values = {k: body.get(k, existing[k]) for k in LESSON_FIELDS}
    db.execute(
        f"UPDATE lesson_learned SET {', '.join(f'{k} = ?' for k in LESSON_FIELDS)}, updated_at = ? WHERE id = ?",
        [values[k] for k in LESSON_FIELDS] + [now_iso(), lesson_id],
    )
    db.commit()
    row = row_to_dict(db.execute("SELECT * FROM lesson_learned WHERE id = ?", (lesson_id,)).fetchone())
    return jsonify(attach_lesson_links(db, row))


@app.route("/lessons/<int:lesson_id>", methods=["DELETE"])
def delete_lesson(lesson_id):
    db = get_db()
    db.execute("DELETE FROM lesson_learned WHERE id = ?", (lesson_id,))
    db.commit()
    return jsonify({"ok": True})


@app.route("/lessons/<int:lesson_id>/links", methods=["POST"])
def create_lesson_link(lesson_id):
    body = request.get_json(silent=True)
    if not body or body.get("entity_type") not in ("milestone", "feature") or not body.get("entity_id"):
        abort(400, "entity_type and entity_id are required")
    db = get_db()
    cur = db.execute(
        "INSERT INTO lesson_link (lesson_id, entity_type, entity_id) VALUES (?, ?, ?)",
        (lesson_id, body["entity_type"], body["entity_id"]),
    )
    db.commit()
    row = db.execute("SELECT * FROM lesson_link WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(row_to_dict(row)), 201


@app.route("/lesson-links/<int:link_id>", methods=["DELETE"])
def delete_lesson_link(link_id):
    db = get_db()
    db.execute("DELETE FROM lesson_link WHERE id = ?", (link_id,))
    db.commit()
    return jsonify({"ok": True})


# ── Team-Gespräche (je Feature, historisiert) ─────────────────────────────────

CONVERSATION_FIELDS = ["date", "participants", "blockers_text", "deadline_realistic_text", "risks_text",
                        "support_needed_text", "assumptions_changed_text", "agreed_actions", "followup_date"]


@app.route("/features/<int:feature_id>/conversations", methods=["GET"])
def list_conversations(feature_id):
    db = get_db()
    rows = db.execute("SELECT * FROM conversation WHERE feature_id = ? ORDER BY date DESC", (feature_id,)).fetchall()
    return jsonify(rows_to_list(rows))


@app.route("/features/<int:feature_id>/conversations", methods=["POST"])
def create_conversation(feature_id):
    body = request.get_json(silent=True)
    if not body or not body.get("date"):
        abort(400, "date is required")
    db = get_db()
    values = {k: body.get(k) for k in CONVERSATION_FIELDS}
    cur = db.execute(
        f"INSERT INTO conversation (feature_id, {', '.join(CONVERSATION_FIELDS)}) "
        f"VALUES (?, {', '.join('?' for _ in CONVERSATION_FIELDS)})",
        [feature_id] + [values[k] for k in CONVERSATION_FIELDS],
    )
    db.commit()
    row = db.execute("SELECT * FROM conversation WHERE id = ?", (cur.lastrowid,)).fetchone()
    return jsonify(row_to_dict(row)), 201


@app.route("/conversations/<int:conversation_id>", methods=["DELETE"])
def delete_conversation(conversation_id):
    db = get_db()
    db.execute("DELETE FROM conversation WHERE id = ?", (conversation_id,))
    db.commit()
    return jsonify({"ok": True})


# ── Dashboard-Summary (Forecast, regelbasierte Markierung, Startseiten-Widgets) ─

def today_str():
    return datetime.now(timezone.utc).date().isoformat()


@app.route("/dashboard/summary", methods=["GET"])
def dashboard_summary():
    db = get_db()
    today = today_str()
    in_90_days = (datetime.now(timezone.utc).date().toordinal() + 90)
    in_90_days = datetime.fromordinal(in_90_days).date().isoformat()

    milestones = rows_to_list(db.execute("SELECT * FROM milestone").fetchall())
    features = rows_to_list(db.execute("SELECT * FROM feature").fetchall())
    work_packages = rows_to_list(db.execute("SELECT * FROM work_package").fetchall())
    feature_titles = {f["id"]: f["title"] for f in features}

    open_risks_by_feature = {}
    for link in db.execute(
        "SELECT rl.entity_id, r.status, r.impact FROM risk_link rl JOIN risk r ON r.id = rl.risk_id "
        "WHERE rl.entity_type = 'feature' AND r.status != 'erledigt'"
    ).fetchall():
        open_risks_by_feature.setdefault(link["entity_id"], []).append(link)

    feature_chains, blocked_feature_ids = compute_dependency_chains(db, "feature")
    wp_chains, blocked_wp_ids = compute_dependency_chains(db, "work_package")

    # ── Forecast-Flags je Feature (regelbasiert, kein Vorhersagemodell) ──
    endangered_features = []
    on_track = endangered = low_confidence = 0
    for f in features:
        reasons = []
        if f["forecast_date"] and f["target_date"] and f["forecast_date"] > f["target_date"]:
            reasons.append("Erwarteter Termin liegt nach dem Zieltermin")
        if f["forecast_confidence"] == "niedrig":
            reasons.append("Niedriges Terminvertrauen")
            low_confidence += 1
        if open_risks_by_feature.get(f["id"]):
            reasons.append(f"{len(open_risks_by_feature[f['id']])} offene Risiken verknüpft")
        if f["id"] in blocked_feature_ids:
            reasons.append("Blockierende Abhängigkeit offen")

        effective_status = f["mgmt_status"] or f["status"]
        if effective_status == "gruen":
            on_track += 1
        else:
            endangered += 1

        if effective_status in ("gelb", "rot") or reasons:
            endangered_features.append({
                "id": f["id"], "title": f["title"], "owner": f["owner"],
                "target_date": f["target_date"], "forecast_date": f["forecast_date"],
                "forecast_confidence": f["forecast_confidence"], "status": effective_status,
                "reasons": reasons,
            })

    # ── Offene Risiken, sortiert nach Auswirkung/Wahrscheinlichkeit ──
    risk_rows = rows_to_list(db.execute(
        "SELECT * FROM risk WHERE status != 'erledigt' ORDER BY impact DESC, probability DESC"
    ).fetchall())
    open_risks = [attach_risk_links(db, r) for r in risk_rows]

    # ── Blockierte Arbeitspakete ──
    wp_feature_id = {wp["id"]: wp["feature_id"] for wp in work_packages}
    blocked_work_packages = []
    for wp in work_packages:
        if wp["status"] != "blockiert":
            continue
        chain = next((c for c in wp_chains if c["blocker_id"] == wp["id"]), None)
        affected_feature_titles = sorted({
            feature_titles.get(wp_feature_id.get(a["id"]), a["title"])
            for a in (chain["affected"] if chain else [])
        })
        blocked_work_packages.append({
            "id": wp["id"], "title": wp["title"], "feature_title": feature_titles.get(wp["feature_id"]),
            "blocked_since": wp["updated_at"], "affected_features": affected_feature_titles,
        })

    # ── Milestones der nächsten 90 Tage ──
    upcoming_milestones = sorted(
        [m for m in milestones if m["target_date"] and today <= m["target_date"] <= in_90_days],
        key=lambda m: m["target_date"],
    )

    # ── Überfällige Elemente ──
    overdue_milestones = [m for m in milestones if m["target_date"] and m["target_date"] < today]
    overdue_features = [f for f in features if f["target_date"] and f["target_date"] < today]
    overdue_work_packages = [
        wp for wp in work_packages
        if wp["planned_end"] and wp["planned_end"] < today and wp["status"] != "abgeschlossen"
    ]

    # ── Kritische Abhängigkeiten (Top-Ketten über Feature- und Arbeitspaket-Ebene) ──
    critical_chains = sorted(
        [{**c, "entity_type": "feature"} for c in feature_chains if c["affected_count"] > 0] +
        [{**c, "entity_type": "work_package"} for c in wp_chains if c["affected_count"] > 0],
        key=lambda c: c["affected_count"], reverse=True,
    )[:5]

    return jsonify({
        "endangered_features": endangered_features,
        "forecast_counts": {"on_track": on_track, "endangered": endangered, "low_confidence": low_confidence},
        "open_risks": open_risks,
        "blocked_work_packages": blocked_work_packages,
        "upcoming_milestones": upcoming_milestones,
        "overdue": {
            "milestones": overdue_milestones, "features": overdue_features, "work_packages": overdue_work_packages,
        },
        "critical_chains": critical_chains,
        "recent_lessons": rows_to_list(db.execute(
            "SELECT * FROM lesson_learned ORDER BY date IS NULL, date DESC LIMIT 5"
        ).fetchall()),
    })


if __name__ == "__main__":
    if not os.path.exists(DB_FILE):
        init_db()
    else:
        init_db()  # CREATE TABLE IF NOT EXISTS ist idempotent, deckt Schema-Updates beim Start ab
    app.run(host="0.0.0.0", port=5002)
