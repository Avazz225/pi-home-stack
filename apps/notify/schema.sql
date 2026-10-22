-- Notifications: rules a person asked for, and what they produced.
--
-- Rules belong to a person, because the whole point is that two people in one
-- flat want to be told different things. The things being watched belong to the
-- flat, so the observations below are shared.

CREATE TABLE IF NOT EXISTS rule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Whose rule, and therefore who gets told. The id from the registry in the
    -- profile service; this service never sees a name.
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    -- The rule's own settings, shaped by its kind. JSON because a threshold, a
    -- room and a duration have nothing in common across kinds, and a column per
    -- kind would be a table that grows with every idea.
    params TEXT NOT NULL DEFAULT '{}',
    -- How long before the same rule may speak again. Without it a lamp left on
    -- produces one message a minute until somebody switches it off, which
    -- teaches people to ignore the bell.
    cooldown_s INTEGER NOT NULL DEFAULT 3600,
    last_fired_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notification (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER REFERENCES rule(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    -- info | warn | alert. Three, because a list that sorts by five levels is
    -- a list nobody sorts.
    level TEXT NOT NULL DEFAULT 'info',
    title TEXT NOT NULL,
    body TEXT,
    link TEXT,
    read_at TEXT
);

-- Where a message goes besides the bell in the dashboard. One generic webhook
-- rather than one integration per service: ntfy, Gotify, Home Assistant and
-- Discord all take a POST, and the one that does not is not worth a dependency.
CREATE TABLE IF NOT EXISTS channel (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- What something looked like, and since when.
--
-- The question "has this lamp been on for three hours" cannot be answered from
-- a snapshot, and the services that hold the lamp do not remember. So each poll
-- writes what it saw; the timestamp only moves when the value does, and the age
-- of a state is then a subtraction.
CREATE TABLE IF NOT EXISTS observation (
    key TEXT PRIMARY KEY,
    value TEXT,
    since TEXT NOT NULL,
    seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rule_user ON rule(user_id);
CREATE INDEX IF NOT EXISTS idx_notification_user ON notification(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_channel_user ON channel(user_id);
