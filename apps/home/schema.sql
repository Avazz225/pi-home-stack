-- Flat as a set of rooms, with whatever hardware happens to sit in each of them.
--
-- The floor plan geometry is NOT in here: it is the fixed shape of one flat and
-- lives in the frontend, keyed by room.key. This table holds what can change —
-- names, which devices belong where, and the heating wishes.

CREATE TABLE IF NOT EXISTS room (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Stable handle used by the frontend to find the room's shape on the plan
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    area_m2 REAL,
    -- Manual setpoint; a schedule entry overwrites this when it fires
    target_temp REAL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- One row per piece of hardware assigned to a room. external_id is whatever the
-- vendor calls the thing: a Hue resource id, a Shelly address, a yeedi map
-- subset number. Keeping them in one table means a room never has to know which
-- systems exist — it just lists what is bound to it.
CREATE TABLE IF NOT EXISTS room_device (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES room(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('hue_light', 'shelly_climate', 'shelly_window', 'vacuum_room')),
    external_id TEXT NOT NULL,
    name TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(room_id, kind, external_id)
);

CREATE TABLE IF NOT EXISTS heating_schedule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES room(id) ON DELETE CASCADE,
    -- ISO weekdays as digits, "12345" = Mon–Fri. A string keeps the API readable
    -- and the set is never longer than seven characters.
    weekdays TEXT NOT NULL DEFAULT '1234567',
    time TEXT NOT NULL,
    target_temp REAL NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS home_setting (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE INDEX IF NOT EXISTS idx_roomdevice_room ON room_device(room_id);
CREATE INDEX IF NOT EXISTS idx_roomdevice_kind ON room_device(kind);
CREATE INDEX IF NOT EXISTS idx_schedule_room ON heating_schedule(room_id);
