-- Study module planning.
--
-- Two layers, deliberately kept apart:
--   * category + module  = the current state ("Ist"): what exists, what is done,
--     which grade it earned. Edited whenever something actually happens.
--   * plan + plan_entry  = planning scenarios laid over that module pool. A plan
--     never copies module data, it only says "this module, in that semester", so
--     master data stays in one place and plans remain comparable.

CREATE TABLE IF NOT EXISTS category (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    cp_min REAL,
    cp_max REAL,
    -- The thesis is a fixed block that comes in any case, so it is shown apart
    -- from the coursework rather than mixed into the same progress. At most one
    -- category carries the flag; the API enforces that.
    is_thesis INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS module (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- NULL means the module sits in the idea pool and counts towards no category yet
    category_id INTEGER REFERENCES category(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    cp REAL,
    exam_form TEXT,
    contact TEXT,
    faculty TEXT,
    url TEXT,
    status TEXT NOT NULL DEFAULT 'offen' CHECK(status IN ('offen','geplant','laufend','abgeschlossen')),
    grade REAL,
    semester TEXT,
    note TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plan (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    is_active INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plan_entry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL REFERENCES plan(id) ON DELETE CASCADE,
    module_id INTEGER NOT NULL REFERENCES module(id) ON DELETE CASCADE,
    semester TEXT,
    note TEXT,
    UNIQUE(plan_id, module_id)
);

CREATE TABLE IF NOT EXISTS study_setting (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE INDEX IF NOT EXISTS idx_module_category ON module(category_id);
CREATE INDEX IF NOT EXISTS idx_planentry_plan ON plan_entry(plan_id);
CREATE INDEX IF NOT EXISTS idx_planentry_module ON plan_entry(module_id);
