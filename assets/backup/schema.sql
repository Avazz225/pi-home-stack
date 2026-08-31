-- pinas S3 backup: folder selection, S3 object index and run history.
-- The Flask API (app.py) and the cron job (backup_job.py) share this database.

CREATE TABLE IF NOT EXISTS config (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Explicit per-folder decision. A folder without a row inherits from its nearest
-- ancestor that has one; the top level defaults to 'exclude' (no backup).
CREATE TABLE IF NOT EXISTS folder_rule (
    path       TEXT PRIMARY KEY,   -- relative to nas_root, '' is the top level itself
    mode       TEXT NOT NULL CHECK(mode IN ('include','exclude')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- One bucket to replicate into. Several targets in different regions give
-- geo-redundancy without S3 replication: the job uploads to each of them itself.
-- Credentials are shared (one IAM user), only region/bucket/prefix differ.
CREATE TABLE IF NOT EXISTS backup_target (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    -- 's3' for Amazon and every S3-compatible store, 'fs' for a directory
    -- (an NFS or SMB mount, a USB disk, a second local drive).
    kind          TEXT NOT NULL DEFAULT 's3' CHECK(kind IN ('s3','fs')),
    -- Empty for AWS; the endpoint of MinIO, Backblaze, Wasabi, Ceph and friends.
    endpoint_url  TEXT NOT NULL DEFAULT '',
    -- Some compatible stores only accept path-style addressing.
    addressing    TEXT NOT NULL DEFAULT 'auto' CHECK(addressing IN ('auto','path','virtual')),
    -- Refuse to write when the directory is not a mount point (fs targets).
    require_mount INTEGER NOT NULL DEFAULT 0,
    region        TEXT NOT NULL,
    -- The bucket name for s3 targets, the base directory for fs targets.
    bucket        TEXT NOT NULL,
    prefix        TEXT NOT NULL DEFAULT '',
    storage_class TEXT NOT NULL DEFAULT 'STANDARD_IA',
    enabled       INTEGER NOT NULL DEFAULT 1,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now')),
    UNIQUE(bucket, prefix)
);

-- One row per file that exists (or existed) in the backup. deleted_at is the
-- deletion marker: the object stays in S3 until retention_days have passed.
-- size/mtime_ns describe what was last seen on disk; what actually sits in each
-- bucket is tracked per target in object_target.
CREATE TABLE IF NOT EXISTS backup_object (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    rel_path     TEXT NOT NULL UNIQUE,
    s3_key       TEXT NOT NULL,   -- key without any target prefix
    size         INTEGER NOT NULL DEFAULT 0,
    mtime_ns     INTEGER NOT NULL DEFAULT 0,
    encrypted    INTEGER NOT NULL DEFAULT 1,
    uploaded_at  TEXT,            -- last successful upload to any target
    last_seen_at TEXT,
    deleted_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_object_deleted ON backup_object(deleted_at);

-- What each bucket actually holds. A missing row means the target has nothing;
-- a row whose size/mtime_ns differ from backup_object means it holds an outdated
-- copy — which still has to be purged when the file is deleted, so the key is
-- kept here rather than derived.
CREATE TABLE IF NOT EXISTS object_target (
    object_id   INTEGER NOT NULL REFERENCES backup_object(id) ON DELETE CASCADE,
    target_id   INTEGER NOT NULL REFERENCES backup_target(id) ON DELETE CASCADE,
    s3_key      TEXT NOT NULL,
    size        INTEGER NOT NULL DEFAULT 0,
    mtime_ns    INTEGER NOT NULL DEFAULT 0,
    uploaded_at TEXT,
    PRIMARY KEY (object_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_object_target_target ON object_target(target_id);

CREATE TABLE IF NOT EXISTS backup_run (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at     TEXT NOT NULL,
    finished_at    TEXT,
    status         TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','ok','error')),
    trigger        TEXT NOT NULL DEFAULT 'cron',
    files_scanned  INTEGER NOT NULL DEFAULT 0,
    files_uploaded INTEGER NOT NULL DEFAULT 0,
    bytes_uploaded INTEGER NOT NULL DEFAULT 0,
    files_marked   INTEGER NOT NULL DEFAULT 0,
    files_purged   INTEGER NOT NULL DEFAULT 0,
    error          TEXT,
    log            TEXT
);

CREATE INDEX IF NOT EXISTS idx_run_started ON backup_run(started_at DESC);
