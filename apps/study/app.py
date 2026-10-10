from flask import Flask, jsonify, request, abort, g
from flask_cors import CORS
import json
import os
import re
import sqlite3
from datetime import datetime, timezone

app = Flask(__name__)
CORS(app)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_FILE = os.path.join(DATA_DIR, "study.db")
SCHEMA_FILE = os.path.join(BASE_DIR, "schema.sql")
SEED_FILE = os.path.join(BASE_DIR, "seed.json")
os.makedirs(DATA_DIR, exist_ok=True)

DONE = "abgeschlossen"
# Everything that already occupies a slot in the study plan, not just what is finished
COMMITTED = ("abgeschlossen", "laufend", "geplant")


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


def migrate_db():
    """CREATE TABLE IF NOT EXISTS leaves an existing table untouched, so columns
    added after the first deployment have to be patched in by hand."""
    conn = sqlite3.connect(DB_FILE)
    columns = {row[1] for row in conn.execute("PRAGMA table_info(category)")}
    if "is_thesis" not in columns:
        conn.execute("ALTER TABLE category ADD COLUMN is_thesis INTEGER NOT NULL DEFAULT 0")
        conn.commit()
    conn.close()


def seed_db():
    """Imports seed.json once, into an empty database. Everything the user later
    edits in the web UI lives in the same tables, so the guard has to be strict:
    as soon as a single category or module exists, the seed is skipped."""
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    existing = conn.execute("SELECT (SELECT COUNT(*) FROM category) + (SELECT COUNT(*) FROM module) AS n").fetchone()
    if existing["n"] > 0 or not os.path.exists(SEED_FILE):
        conn.close()
        return

    with open(SEED_FILE, encoding="utf-8") as f:
        seed = json.load(f)

    for key, value in (seed.get("settings") or {}).items():
        conn.execute("INSERT OR REPLACE INTO study_setting (key, value) VALUES (?, ?)", (key, value))

    for cat_pos, cat in enumerate(seed.get("categories") or []):
        cur = conn.execute(
            "INSERT INTO category (name, cp_min, cp_max, is_thesis, position) VALUES (?, ?, ?, ?, ?)",
            (cat["name"], cat.get("cp_min"), cat.get("cp_max"), int(bool(cat.get("is_thesis"))), cat_pos),
        )
        category_id = cur.lastrowid
        for mod_pos, mod in enumerate(cat.get("modules") or []):
            insert_seed_module(conn, mod, category_id, mod_pos)

    for mod_pos, mod in enumerate(seed.get("pool") or []):
        insert_seed_module(conn, mod, None, mod_pos)

    conn.commit()
    conn.close()


def insert_seed_module(conn, mod, category_id, position):
    conn.execute(
        """INSERT INTO module (category_id, title, cp, exam_form, contact, faculty, url,
                               status, grade, semester, note, position)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (category_id, mod["title"], mod.get("cp"), mod.get("exam_form"), mod.get("contact"),
         mod.get("faculty"), mod.get("url"), mod.get("status") or "offen", mod.get("grade"),
         mod.get("semester"), mod.get("note"), position),
    )


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def row_to_dict(row):
    return dict(row) if row else None


def rows_to_list(rows):
    return [dict(r) for r in rows]


def get_setting(db, key, default=None):
    row = db.execute("SELECT value FROM study_setting WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


# ── Derived values ────────────────────────────────────────────────────────────

def semester_rank(value):
    """Semester labels stay free text because the spreadsheet used things like
    "3.", "(6./7.)" and "?". Sorting therefore goes by the first number in the
    label; labels without a number sort to the end but ahead of empty ones."""
    if not value or not value.strip():
        return 999
    match = re.search(r"\d+", value)
    return int(match.group()) if match else 998


def cp_sum(modules, statuses=None):
    return round(sum(m["cp"] or 0 for m in modules if statuses is None or m["status"] in statuses), 1)


def cp_state(value, cp_min, cp_max):
    if cp_min is not None and value < cp_min:
        return "unter"
    if cp_max is not None and value > cp_max:
        return "ueber"
    return "ok"


def grade_averages(modules):
    """Weighted by CP is the average that counts for the degree; the unweighted
    one is kept because the spreadsheet showed that number."""
    graded = [m for m in modules if m["status"] == DONE and m["grade"] is not None]
    if not graded:
        return None, None
    weighted_cp = sum(m["cp"] or 0 for m in graded)
    weighted = (round(sum(m["grade"] * (m["cp"] or 0) for m in graded) / weighted_cp, 2)
                if weighted_cp else None)
    return weighted, round(sum(m["grade"] for m in graded) / len(graded), 2)


def category_stats(modules, cp_min, cp_max):
    cp_done = cp_sum(modules, (DONE,))
    cp_committed = cp_sum(modules, COMMITTED)
    return {
        "cp_done": cp_done,
        "cp_committed": cp_committed,
        "cp_open": round(cp_sum(modules) - cp_committed, 1),
        "modules_done": len([m for m in modules if m["status"] == DONE]),
        "modules_total": len(modules),
        "state": cp_state(cp_committed, cp_min, cp_max),
        "state_done": cp_state(cp_done, cp_min, cp_max),
    }


def sorted_modules(modules):
    return sorted(modules, key=lambda m: (m["position"], semester_rank(m["semester"]), m["title"].lower()))


def thesis_summary(category):
    """The thesis block as the overview draws it. Its size is the interval, not
    what happens to be entered as modules — it is a fixed slot that comes in any
    case, so it keeps its full width whether it is still open, planned or done."""
    modules = category["modules"]
    target = category["cp_min"] or category["cp_max"] or cp_sum(modules)
    cp_done = cp_sum(modules, (DONE,))
    return {
        "category_id": category["id"],
        "name": category["name"],
        "cp": target,
        "cp_done": cp_done,
        "cp_committed": cp_sum(modules, COMMITTED),
        "done": target > 0 and cp_done >= target,
    }


# ── Overview ──────────────────────────────────────────────────────────────────

@app.route("/overview", methods=["GET"])
def overview():
    db = get_db()
    categories = rows_to_list(db.execute("SELECT * FROM category ORDER BY position, id").fetchall())
    modules = rows_to_list(db.execute("SELECT * FROM module").fetchall())

    by_category = {}
    pool = []
    for m in modules:
        (pool if m["category_id"] is None else by_category.setdefault(m["category_id"], [])).append(m)

    for cat in categories:
        cat_modules = sorted_modules(by_category.get(cat["id"], []))
        cat["modules"] = cat_modules
        cat["stats"] = category_stats(cat_modules, cat["cp_min"], cat["cp_max"])

    assigned = [m for m in modules if m["category_id"] is not None]
    weighted, unweighted = grade_averages(assigned)
    target_cp = float(get_setting(db, "target_cp", "120") or 120)
    cp_done = cp_sum(assigned, (DONE,))
    cp_committed = cp_sum(assigned, COMMITTED)

    # Coursework = everything except the thesis, so the two progress figures stay
    # independent: the thesis block never inflates the "until the thesis" number.
    thesis_cat = next((c for c in categories if c["is_thesis"]), None)
    thesis = thesis_summary(thesis_cat) if thesis_cat else None
    cp_done_coursework = round(cp_done - (thesis["cp_done"] if thesis else 0), 1)
    cp_committed_coursework = round(cp_committed - (thesis["cp_committed"] if thesis else 0), 1)
    target_coursework = round(target_cp - (thesis["cp"] if thesis else 0), 1)

    active = db.execute("SELECT id, name FROM plan WHERE is_active = 1").fetchone()

    return jsonify({
        "categories": categories,
        "pool": sorted_modules(pool),
        "active_plan": row_to_dict(active),
        "totals": {
            "cp_done": cp_done,
            "cp_committed": cp_committed,
            "cp_open": round(target_cp - cp_committed, 1),
            "target_cp": target_cp,
            "cp_min": round(sum(c["cp_min"] or 0 for c in categories), 1),
            "cp_max": round(sum(c["cp_max"] or 0 for c in categories), 1),
            "grade_average": weighted,
            "grade_average_unweighted": unweighted,
            "modules_done": len([m for m in assigned if m["status"] == DONE]),
            "modules_total": len(assigned),
            "progress": round(cp_done / target_cp * 100) if target_cp else 0,
            "thesis": thesis,
            "cp_done_coursework": cp_done_coursework,
            "cp_committed_coursework": cp_committed_coursework,
            "target_coursework": target_coursework,
            "cp_to_thesis": round(max(target_coursework - cp_done_coursework, 0), 1),
            "progress_coursework": (round(cp_done_coursework / target_coursework * 100)
                                    if target_coursework else 0),
        },
    })


# ── Categories ────────────────────────────────────────────────────────────────

CATEGORY_FIELDS = ["name", "cp_min", "cp_max", "is_thesis", "position"]


def clear_other_thesis_flags(db, category_id):
    """Only one category can be the thesis; the overview would otherwise have to
    pick one arbitrarily."""
    db.execute("UPDATE category SET is_thesis = 0 WHERE id != ?", (category_id,))


@app.route("/categories", methods=["GET"])
def list_categories():
    db = get_db()
    return jsonify(rows_to_list(db.execute("SELECT * FROM category ORDER BY position, id").fetchall()))


@app.route("/categories", methods=["POST"])
def create_category():
    body = request.get_json(silent=True)
    if not body or not body.get("name"):
        abort(400, "name is required")
    db = get_db()
    values = {k: body.get(k) for k in CATEGORY_FIELDS}
    values["is_thesis"] = int(bool(values.get("is_thesis")))
    if values["position"] is None:
        values["position"] = (db.execute("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM category").fetchone())["p"]
    cur = db.execute(
        f"INSERT INTO category ({', '.join(CATEGORY_FIELDS)}) VALUES ({', '.join('?' for _ in CATEGORY_FIELDS)})",
        [values[k] for k in CATEGORY_FIELDS],
    )
    if values["is_thesis"]:
        clear_other_thesis_flags(db, cur.lastrowid)
    db.commit()
    return jsonify(row_to_dict(db.execute("SELECT * FROM category WHERE id = ?", (cur.lastrowid,)).fetchone())), 201


@app.route("/categories/<int:category_id>", methods=["PUT"])
def update_category(category_id):
    body = request.get_json(silent=True)
    if not body:
        abort(400)
    db = get_db()
    existing = db.execute("SELECT * FROM category WHERE id = ?", (category_id,)).fetchone()
    if not existing:
        abort(404)
    values = {k: body.get(k, existing[k]) for k in CATEGORY_FIELDS}
    values["is_thesis"] = int(bool(values.get("is_thesis")))
    db.execute(
        f"UPDATE category SET {', '.join(f'{k} = ?' for k in CATEGORY_FIELDS)}, updated_at = ? WHERE id = ?",
        [values[k] for k in CATEGORY_FIELDS] + [now_iso(), category_id],
    )
    if values["is_thesis"]:
        clear_other_thesis_flags(db, category_id)
    db.commit()
    return jsonify(row_to_dict(db.execute("SELECT * FROM category WHERE id = ?", (category_id,)).fetchone()))


@app.route("/categories/<int:category_id>", methods=["DELETE"])
def delete_category(category_id):
    """Modules survive their category: they fall back into the idea pool instead of
    being deleted along with it, so no recorded grade is ever lost by accident."""
    db = get_db()
    db.execute("UPDATE module SET category_id = NULL WHERE category_id = ?", (category_id,))
    db.execute("DELETE FROM category WHERE id = ?", (category_id,))
    db.commit()
    return jsonify({"ok": True})


# ── Modules ───────────────────────────────────────────────────────────────────

MODULE_FIELDS = ["category_id", "title", "cp", "exam_form", "contact", "faculty", "url",
                 "status", "grade", "semester", "note", "position"]


@app.route("/modules", methods=["GET"])
def list_modules():
    db = get_db()
    return jsonify(sorted_modules(rows_to_list(db.execute("SELECT * FROM module").fetchall())))


@app.route("/modules", methods=["POST"])
def create_module():
    body = request.get_json(silent=True)
    if not body or not body.get("title"):
        abort(400, "title is required")
    db = get_db()
    values = {k: body.get(k) for k in MODULE_FIELDS}
    values["status"] = values.get("status") or "offen"
    if values["position"] is None:
        row = db.execute(
            "SELECT COALESCE(MAX(position), -1) + 1 AS p FROM module WHERE category_id IS ?",
            (values["category_id"],),
        ).fetchone()
        values["position"] = row["p"]
    cur = db.execute(
        f"INSERT INTO module ({', '.join(MODULE_FIELDS)}) VALUES ({', '.join('?' for _ in MODULE_FIELDS)})",
        [values[k] for k in MODULE_FIELDS],
    )
    db.commit()
    return jsonify(row_to_dict(db.execute("SELECT * FROM module WHERE id = ?", (cur.lastrowid,)).fetchone())), 201


@app.route("/modules/<int:module_id>", methods=["PUT"])
def update_module(module_id):
    body = request.get_json(silent=True)
    if not body:
        abort(400)
    db = get_db()
    existing = db.execute("SELECT * FROM module WHERE id = ?", (module_id,)).fetchone()
    if not existing:
        abort(404)
    values = {k: body.get(k, existing[k]) for k in MODULE_FIELDS}
    db.execute(
        f"UPDATE module SET {', '.join(f'{k} = ?' for k in MODULE_FIELDS)}, updated_at = ? WHERE id = ?",
        [values[k] for k in MODULE_FIELDS] + [now_iso(), module_id],
    )
    db.commit()
    return jsonify(row_to_dict(db.execute("SELECT * FROM module WHERE id = ?", (module_id,)).fetchone()))


@app.route("/modules/<int:module_id>", methods=["DELETE"])
def delete_module(module_id):
    db = get_db()
    db.execute("DELETE FROM module WHERE id = ?", (module_id,))
    db.commit()
    return jsonify({"ok": True})


# ── Plans ─────────────────────────────────────────────────────────────────────

PLAN_FIELDS = ["name", "description"]


@app.route("/plans", methods=["GET"])
def list_plans():
    db = get_db()
    plans = rows_to_list(db.execute("SELECT * FROM plan ORDER BY is_active DESC, name").fetchall())
    for plan in plans:
        entries = rows_to_list(db.execute(
            """SELECT m.cp, m.status FROM plan_entry pe
               JOIN module m ON m.id = pe.module_id WHERE pe.plan_id = ?""", (plan["id"],)).fetchall())
        plan["entry_count"] = len(entries)
        plan["cp_planned"] = cp_sum(entries)
    return jsonify(plans)


@app.route("/plans", methods=["POST"])
def create_plan():
    body = request.get_json(silent=True)
    if not body or not body.get("name"):
        abort(400, "name is required")
    db = get_db()
    cur = db.execute("INSERT INTO plan (name, description) VALUES (?, ?)",
                     (body["name"], body.get("description")))
    plan_id = cur.lastrowid

    # A new plan can start from the modules already scheduled, which saves
    # rebuilding an almost identical scenario by hand.
    if body.get("copy_from_plan_id"):
        db.execute(
            """INSERT INTO plan_entry (plan_id, module_id, semester, note)
               SELECT ?, module_id, semester, note FROM plan_entry WHERE plan_id = ?""",
            (plan_id, body["copy_from_plan_id"]),
        )
    elif body.get("seed_from_current"):
        db.execute(
            """INSERT INTO plan_entry (plan_id, module_id, semester)
               SELECT ?, id, semester FROM module
               WHERE category_id IS NOT NULL AND status IN ('geplant', 'laufend', 'abgeschlossen')""",
            (plan_id,),
        )
    db.commit()
    return jsonify(row_to_dict(db.execute("SELECT * FROM plan WHERE id = ?", (plan_id,)).fetchone())), 201


@app.route("/plans/<int:plan_id>", methods=["PUT"])
def update_plan(plan_id):
    body = request.get_json(silent=True)
    if not body:
        abort(400)
    db = get_db()
    existing = db.execute("SELECT * FROM plan WHERE id = ?", (plan_id,)).fetchone()
    if not existing:
        abort(404)
    values = {k: body.get(k, existing[k]) for k in PLAN_FIELDS}
    db.execute(
        f"UPDATE plan SET {', '.join(f'{k} = ?' for k in PLAN_FIELDS)}, updated_at = ? WHERE id = ?",
        [values[k] for k in PLAN_FIELDS] + [now_iso(), plan_id],
    )
    db.commit()
    return jsonify(row_to_dict(db.execute("SELECT * FROM plan WHERE id = ?", (plan_id,)).fetchone()))


@app.route("/plans/<int:plan_id>", methods=["DELETE"])
def delete_plan(plan_id):
    db = get_db()
    db.execute("DELETE FROM plan WHERE id = ?", (plan_id,))
    db.commit()
    return jsonify({"ok": True})


@app.route("/plans/<int:plan_id>/activate", methods=["POST"])
def activate_plan(plan_id):
    """At most one plan is the one being followed; activating a second one steps
    the first one down. Posting the id of the active plan toggles it off again."""
    db = get_db()
    existing = db.execute("SELECT * FROM plan WHERE id = ?", (plan_id,)).fetchone()
    if not existing:
        abort(404)
    db.execute("UPDATE plan SET is_active = 0")
    if not existing["is_active"]:
        db.execute("UPDATE plan SET is_active = 1, updated_at = ? WHERE id = ?", (now_iso(), plan_id))
    db.commit()
    return jsonify(row_to_dict(db.execute("SELECT * FROM plan WHERE id = ?", (plan_id,)).fetchone()))


@app.route("/plans/<int:plan_id>", methods=["GET"])
def get_plan(plan_id):
    db = get_db()
    plan = db.execute("SELECT * FROM plan WHERE id = ?", (plan_id,)).fetchone()
    if not plan:
        abort(404)
    plan = dict(plan)

    entries = rows_to_list(db.execute(
        """SELECT pe.id, pe.module_id, pe.semester, pe.note, m.title, m.cp, m.exam_form, m.contact,
                  m.faculty, m.url, m.status, m.grade, m.category_id, m.semester AS module_semester
           FROM plan_entry pe JOIN module m ON m.id = pe.module_id
           WHERE pe.plan_id = ?""", (plan_id,)).fetchall())
    for e in entries:
        e["effective_semester"] = e["semester"] or e["module_semester"] or ""
    entries.sort(key=lambda e: (semester_rank(e["effective_semester"]), e["title"].lower()))
    plan["entries"] = entries

    # Semester columns for the board view
    semesters = {}
    for e in entries:
        label = e["effective_semester"] or "ohne Semester"
        bucket = semesters.setdefault(label, {"label": label, "rank": semester_rank(e["effective_semester"]),
                                              "cp": 0, "entry_ids": []})
        bucket["cp"] = round(bucket["cp"] + (e["cp"] or 0), 1)
        bucket["entry_ids"].append(e["id"])
    plan["semesters"] = sorted(semesters.values(), key=lambda s: (s["rank"], s["label"]))

    # CP check per category: everything already done counts regardless of the plan,
    # everything else only when the plan actually contains it.
    categories = rows_to_list(db.execute("SELECT * FROM category ORDER BY position, id").fetchall())
    modules = rows_to_list(db.execute("SELECT * FROM module WHERE category_id IS NOT NULL").fetchall())
    planned_ids = {e["module_id"] for e in entries}

    cp_total_all = 0
    for cat in categories:
        cat_modules = [m for m in modules if m["category_id"] == cat["id"]]
        cp_done = cp_sum(cat_modules, (DONE,))
        cp_planned = cp_sum([m for m in cat_modules if m["id"] in planned_ids and m["status"] != DONE])
        cp_total = round(cp_done + cp_planned, 1)
        cp_total_all += cp_total
        cat["cp_done"] = cp_done
        cat["cp_planned"] = cp_planned
        cat["cp_total"] = cp_total
        cat["state"] = cp_state(cp_total, cat["cp_min"], cat["cp_max"])

    target_cp = float(get_setting(db, "target_cp", "120") or 120)
    plan["categories"] = categories
    plan["totals"] = {
        "cp_total": round(cp_total_all, 1),
        "cp_done": cp_sum(modules, (DONE,)),
        "target_cp": target_cp,
        "missing": round(max(target_cp - cp_total_all, 0), 1),
        "entry_count": len(entries),
        "complete": all(c["state"] == "ok" for c in categories) and cp_total_all >= target_cp,
    }
    return jsonify(plan)


@app.route("/plans/<int:plan_id>/entries", methods=["POST"])
def create_plan_entry(plan_id):
    body = request.get_json(silent=True)
    if not body or not body.get("module_id"):
        abort(400, "module_id is required")
    db = get_db()
    if not db.execute("SELECT 1 FROM plan WHERE id = ?", (plan_id,)).fetchone():
        abort(404)
    try:
        cur = db.execute(
            "INSERT INTO plan_entry (plan_id, module_id, semester, note) VALUES (?, ?, ?, ?)",
            (plan_id, body["module_id"], body.get("semester"), body.get("note")),
        )
    except sqlite3.IntegrityError:
        abort(409, "module already in plan")
    db.commit()
    return jsonify(row_to_dict(db.execute("SELECT * FROM plan_entry WHERE id = ?", (cur.lastrowid,)).fetchone())), 201


@app.route("/plan-entries/<int:entry_id>", methods=["PUT"])
def update_plan_entry(entry_id):
    body = request.get_json(silent=True)
    if not body:
        abort(400)
    db = get_db()
    existing = db.execute("SELECT * FROM plan_entry WHERE id = ?", (entry_id,)).fetchone()
    if not existing:
        abort(404)
    db.execute("UPDATE plan_entry SET semester = ?, note = ? WHERE id = ?",
               (body.get("semester", existing["semester"]), body.get("note", existing["note"]), entry_id))
    db.commit()
    return jsonify(row_to_dict(db.execute("SELECT * FROM plan_entry WHERE id = ?", (entry_id,)).fetchone()))


@app.route("/plan-entries/<int:entry_id>", methods=["DELETE"])
def delete_plan_entry(entry_id):
    db = get_db()
    db.execute("DELETE FROM plan_entry WHERE id = ?", (entry_id,))
    db.commit()
    return jsonify({"ok": True})


@app.route("/plans/<int:plan_id>/adopt", methods=["POST"])
def adopt_plan(plan_id):
    """Writes the plan's semesters back onto the modules themselves, turning a
    scenario into the current schedule. Finished modules are left untouched so
    their recorded semester keeps saying when they were actually taken."""
    db = get_db()
    if not db.execute("SELECT 1 FROM plan WHERE id = ?", (plan_id,)).fetchone():
        abort(404)
    entries = db.execute(
        """SELECT pe.module_id, pe.semester, m.status FROM plan_entry pe
           JOIN module m ON m.id = pe.module_id WHERE pe.plan_id = ?""", (plan_id,)).fetchall()
    changed = 0
    for e in entries:
        if e["status"] == DONE:
            continue
        status = "geplant" if e["status"] == "offen" else e["status"]
        db.execute("UPDATE module SET semester = ?, status = ?, updated_at = ? WHERE id = ?",
                   (e["semester"], status, now_iso(), e["module_id"]))
        changed += 1
    db.execute("UPDATE plan SET is_active = 0")
    db.execute("UPDATE plan SET is_active = 1, updated_at = ? WHERE id = ?", (now_iso(), plan_id))
    db.commit()
    return jsonify({"ok": True, "updated_modules": changed})


# ── Settings ──────────────────────────────────────────────────────────────────

@app.route("/settings", methods=["GET"])
def read_settings():
    db = get_db()
    rows = db.execute("SELECT key, value FROM study_setting").fetchall()
    settings = {r["key"]: r["value"] for r in rows}
    settings.setdefault("target_cp", "120")
    return jsonify(settings)


@app.route("/settings", methods=["PUT"])
def write_settings():
    body = request.get_json(silent=True)
    if not body:
        abort(400)
    db = get_db()
    for key, value in body.items():
        db.execute("INSERT OR REPLACE INTO study_setting (key, value) VALUES (?, ?)", (key, str(value)))
    db.commit()
    return read_settings()


if __name__ == "__main__":
    init_db()  # CREATE TABLE IF NOT EXISTS is idempotent and picks up schema updates on restart
    migrate_db()
    seed_db()
    app.run(host="0.0.0.0", port=5004)
