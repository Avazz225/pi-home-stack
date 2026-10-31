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
    -- Geometry of the room on the plan, in metres, as JSON.
    --
    -- It lives here and not in the frontend on purpose: a flat is data, not
    -- code. With the geometry in the bundle, every installation whose rooms
    -- differ from the shipped example had to install Node and rebuild the
    -- frontend - which defeats shipping a prebuilt one at all.
    --
    -- shape_points: [[x, y], ...], at least three corners, origin top-left,
    --               y running down to match SVG.
    -- shape_label:  [x, y] where the name is drawn; the centroid if unset.
    -- outdoor:      a balcony or terrace, drawn outside the heated envelope.
    shape_points TEXT,
    shape_label TEXT,
    outdoor INTEGER NOT NULL DEFAULT 0,
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
    -- Deliberately no CHECK list. It used to name the kinds here as well as in
    -- DEVICE_KINDS in app.py, and the day a kind was added to one and not the
    -- other, SQLite raised an IntegrityError that the API reported as "already
    -- bound to this room". One source of truth; app.py validates.
    kind TEXT NOT NULL,
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

-- Settings that belong to the flat: wall thicknesses, the Hue key, the gateway
-- address. One flat, one answer.
CREATE TABLE IF NOT EXISTS home_setting (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- Settings that belong to a person. Only the arrangement so far - which blocks
-- the room panel shows and in which order. Deliberately a second table rather
-- than a user column on the one above: almost everything here is shared, and a
-- column would invite making the next shared thing personal by accident.
CREATE TABLE IF NOT EXISTS user_setting (
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (user_id, key)
);

-- A scene: some lamps, a look, and a length. Shared, like the lamps it drives -
-- a flat has one set of lamps, and a scene that only one person could start
-- would be a worse version of switching them by hand.
CREATE TABLE IF NOT EXISTS scene (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    -- How long the lamps stay on. 0 means "no end" - a scene that only sets a
    -- look, which is worth having and is why this is not NOT NULL CHECK(>0).
    duration_s INTEGER NOT NULL DEFAULT 0,
    -- Dim down over the last stretch instead of going dark at once.
    fade_s INTEGER NOT NULL DEFAULT 0,
    -- Whether the end switches the lamps off or just stops counting.
    turn_off INTEGER NOT NULL DEFAULT 1,
    position INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scene_light (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scene_id INTEGER NOT NULL REFERENCES scene(id) ON DELETE CASCADE,
    -- The Hue resource id, as room_device stores it.
    light_id TEXT NOT NULL,
    brightness REAL,
    mirek INTEGER,
    -- CIE xy, stored as "x,y". Null where the scene does not set a colour, so
    -- a white lamp is not asked for one it cannot make.
    xy TEXT,
    UNIQUE(scene_id, light_id)
);

-- A started scene. In the database rather than only in memory: the end has to
-- survive a restart of this service, or a scene begun before an update would
-- burn until somebody noticed.
CREATE TABLE IF NOT EXISTS scene_run (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scene_id INTEGER NOT NULL REFERENCES scene(id) ON DELETE CASCADE,
    started_at TEXT NOT NULL,
    ends_at TEXT,
    -- running | done | stopped | failed
    state TEXT NOT NULL DEFAULT 'running',
    fade_started_at TEXT,
    note TEXT
);

-- What a room looked like, every few minutes. The raw material the heating
-- model is made of: nothing else in the flat remembers a temperature long
-- enough to work out how fast a room warms up.
CREATE TABLE IF NOT EXISTS room_sample (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- By key, not by id: a room deleted and recreated is the same room to
    -- anyone living in it, and its history is worth keeping.
    room_key TEXT NOT NULL,
    measured_at TEXT NOT NULL,
    temperature REAL,
    target REAL,
    valve_position INTEGER,
    outside REAL,
    radiation REAL
);

-- What has been learned about a room, as two numbers and their confidence.
CREATE TABLE IF NOT EXISTS heating_model (
    room_key TEXT PRIMARY KEY,
    -- Degrees per minute, normalised to reference weather.
    heat_rate REAL,
    heat_rate_samples INTEGER NOT NULL DEFAULT 0,
    -- Degrees the room still gains after the valve shuts.
    overshoot REAL,
    overshoot_samples INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT
);

-- The individual measurements behind those averages, kept so the interface can
-- show why it believes what it believes. An average nobody can check is a
-- number people switch off.
CREATE TABLE IF NOT EXISTS heating_episode (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_key TEXT NOT NULL,
    kind TEXT NOT NULL,                     -- heatup | overshoot
    started_at TEXT NOT NULL,
    finished_at TEXT,
    from_c REAL,
    to_c REAL,
    minutes REAL,
    value REAL,                             -- the rate, or the overshoot
    outside REAL,
    radiation REAL
);

CREATE INDEX IF NOT EXISTS idx_sample_room ON room_sample(room_key, measured_at);
CREATE INDEX IF NOT EXISTS idx_episode_room ON heating_episode(room_key, started_at);
CREATE INDEX IF NOT EXISTS idx_scenelight_scene ON scene_light(scene_id);
CREATE INDEX IF NOT EXISTS idx_scenerun_state ON scene_run(state);
CREATE INDEX IF NOT EXISTS idx_roomdevice_room ON room_device(room_id);
CREATE INDEX IF NOT EXISTS idx_roomdevice_kind ON room_device(kind);
CREATE INDEX IF NOT EXISTS idx_schedule_room ON heating_schedule(room_id);
