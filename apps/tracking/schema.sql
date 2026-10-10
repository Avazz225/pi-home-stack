-- Phase 1: Milestone, Feature, WorkPackage, CardReference.
-- Phase 2: Dependency, Risk, RiskLink.
-- Phase 4: LessonLearned, LessonLink, Conversation.
-- (effectiveness_rating bewusst nicht in v1, siehe Konzept-Kritik Abschnitt 3.4)

CREATE TABLE IF NOT EXISTS milestone (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    target_date TEXT,
    status TEXT NOT NULL DEFAULT 'gruen' CHECK(status IN ('gruen','gelb','rot')),
    owner TEXT,
    mgmt_comment TEXT,
    forecast_date TEXT,
    forecast_confidence TEXT CHECK(forecast_confidence IN ('hoch','mittel','niedrig') OR forecast_confidence IS NULL),
    date_achievable INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS feature (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    milestone_id INTEGER NOT NULL REFERENCES milestone(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    business_value TEXT,
    target_date TEXT,
    owner TEXT,
    status TEXT NOT NULL DEFAULT 'gruen' CHECK(status IN ('gruen','gelb','rot')),
    risk_level TEXT CHECK(risk_level IN ('niedrig','mittel','hoch') OR risk_level IS NULL),
    progress INTEGER,
    done_criteria TEXT,
    forecast_date TEXT,
    forecast_confidence TEXT CHECK(forecast_confidence IN ('hoch','mittel','niedrig') OR forecast_confidence IS NULL),
    date_achievable INTEGER,
    forecast_updated_at TEXT,
    mgmt_status TEXT CHECK(mgmt_status IN ('gruen','gelb','rot') OR mgmt_status IS NULL),
    mgmt_status_reason TEXT,
    tech_status TEXT CHECK(tech_status IN ('gruen','gelb','rot') OR tech_status IS NULL),
    tech_status_reason TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS work_package (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feature_id INTEGER NOT NULL REFERENCES feature(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    owner TEXT,
    status TEXT NOT NULL DEFAULT 'offen' CHECK(status IN ('offen','in_arbeit','blockiert','abgeschlossen')),
    planned_start TEXT,
    planned_end TEXT,
    actual_start TEXT,
    actual_end TEXT,
    schedule_risk TEXT,
    expected_completion_date TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS card_reference (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_package_id INTEGER NOT NULL REFERENCES work_package(id) ON DELETE CASCADE,
    card_id TEXT NOT NULL,
    card_name TEXT,
    url TEXT
);

CREATE TABLE IF NOT EXISTS dependency (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL CHECK(entity_type IN ('feature','work_package')),
    from_id INTEGER NOT NULL,
    to_id INTEGER NOT NULL,
    blocking INTEGER NOT NULL DEFAULT 1,
    note TEXT
);

CREATE TABLE IF NOT EXISTS risk (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    probability TEXT CHECK(probability IN ('niedrig','mittel','hoch') OR probability IS NULL),
    impact TEXT CHECK(impact IN ('niedrig','mittel','hoch') OR impact IS NULL),
    mitigation TEXT,
    status TEXT NOT NULL DEFAULT 'offen' CHECK(status IN ('offen','beobachtet','erledigt')),
    escalation_required INTEGER DEFAULT 0,
    escalation_date TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS risk_link (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    risk_id INTEGER NOT NULL REFERENCES risk(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL CHECK(entity_type IN ('milestone','feature','work_package')),
    entity_id INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lesson_learned (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    category TEXT,
    date TEXT,
    description TEXT,
    recommendation TEXT,
    tags TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lesson_link (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lesson_id INTEGER NOT NULL REFERENCES lesson_learned(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL CHECK(entity_type IN ('milestone','feature')),
    entity_id INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feature_id INTEGER NOT NULL REFERENCES feature(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    participants TEXT,
    blockers_text TEXT,
    deadline_realistic_text TEXT,
    risks_text TEXT,
    support_needed_text TEXT,
    assumptions_changed_text TEXT,
    agreed_actions TEXT,
    followup_date TEXT
);

CREATE INDEX IF NOT EXISTS idx_feature_milestone ON feature(milestone_id);
CREATE INDEX IF NOT EXISTS idx_workpackage_feature ON work_package(feature_id);
CREATE INDEX IF NOT EXISTS idx_cardref_workpackage ON card_reference(work_package_id);
CREATE INDEX IF NOT EXISTS idx_dependency_lookup ON dependency(entity_type, from_id, to_id);
CREATE INDEX IF NOT EXISTS idx_risklink_entity ON risk_link(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_risklink_risk ON risk_link(risk_id);
CREATE INDEX IF NOT EXISTS idx_lessonlink_entity ON lesson_link(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_lessonlink_lesson ON lesson_link(lesson_id);
CREATE INDEX IF NOT EXISTS idx_conversation_feature ON conversation(feature_id);
