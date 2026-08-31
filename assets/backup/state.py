"""Shared state layer for the NAS backup.

The Flask API (app.py) and the cron job (backup_job.py) both read and write the
same SQLite database, so schema bootstrap, config access and the folder-rule
resolution live here instead of being duplicated in two places.
"""

import base64
import os
import posixpath
import sqlite3
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_FILE = os.path.join(DATA_DIR, "backup.db")
SCHEMA_FILE = os.path.join(BASE_DIR, "schema.sql")

# Everything the operator can change from the dashboard. Values are stored as
# TEXT; the helpers below cast the few numeric ones.
DEFAULTS = {
    "nas_root": "/media/raid/NAS files",
    "aws_access_key_id": "",
    "aws_secret_access_key": "",
    # Path to a root-only file holding the backup encryption key. The
    # authoritative copy of that key lives in the operator's credential store
    # (KeePass or HashiCorp Vault); this file is the materialised copy the
    # unattended job is allowed to read.
    "key_file": "/etc/pi-home-stack/secrets/backup.key",
    "retention_days": "30",
    "staging_dir": "",          # empty -> system temp dir
    "crypto_salt": "",          # base64, generated on first run, never edited by hand
    "enabled": "0",
    # Superseded by the backup_target table. Kept so the one-time migration of an
    # existing single-bucket installation can still read them.
    "aws_region": "eu-central-1",
    "s3_bucket": "",
    "s3_prefix": "nas-backup",
    "storage_class": "STANDARD_IA",
    "targets_migrated": "0",
}

# Never handed out over the API in clear text.
SECRET_KEYS = {"aws_secret_access_key"}
SECRET_MASK = "********"

# Bucket settings moved into backup_target; these stay in the table only as the
# migration source and are neither editable nor exposed any more.
LEGACY_KEYS = {"aws_region", "s3_bucket", "s3_prefix", "storage_class", "targets_migrated"}

# Config keys the API refuses to change (managed by the job itself).
READONLY_KEYS = {"crypto_salt"} | LEGACY_KEYS


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ── Database ─────────────────────────────────────────────────────────────────

def connect():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_FILE, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


# Columns added after the first release. CREATE TABLE IF NOT EXISTS leaves an
# existing table alone, so they have to be added explicitly on upgrade.
ADDED_TARGET_COLUMNS = [
    ("kind", "TEXT NOT NULL DEFAULT 's3'"),
    ("endpoint_url", "TEXT NOT NULL DEFAULT ''"),
    ("addressing", "TEXT NOT NULL DEFAULT 'auto'"),
    ("require_mount", "INTEGER NOT NULL DEFAULT 0"),
]


def migrate_columns(conn):
    existing = {row["name"] for row in conn.execute("PRAGMA table_info(backup_target)")}
    for column, definition in ADDED_TARGET_COLUMNS:
        if column not in existing:
            conn.execute(f"ALTER TABLE backup_target ADD COLUMN {column} {definition}")
    conn.commit()


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_FILE, timeout=30)
    conn.row_factory = sqlite3.Row
    with open(SCHEMA_FILE, encoding="utf-8") as f:
        conn.executescript(f.read())
    conn.commit()
    migrate_columns(conn)
    migrate_legacy_target(conn)
    conn.close()


# ── Config ───────────────────────────────────────────────────────────────────

def get_config(db):
    """Full config with defaults filled in for keys that were never set."""
    cfg = dict(DEFAULTS)
    for row in db.execute("SELECT key, value FROM config"):
        if row["key"] in DEFAULTS:
            cfg[row["key"]] = row["value"] if row["value"] is not None else ""
    return cfg


def set_config(db, values):
    """Write the given subset of config keys. Unknown and read-only keys are ignored."""
    for key, value in values.items():
        if key not in DEFAULTS or key in READONLY_KEYS:
            continue
        db.execute(
            "INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            (key, "" if value is None else str(value), now_iso()),
        )
    db.commit()


def set_config_internal(db, key, value):
    """Bypasses READONLY_KEYS — only for values the job manages itself."""
    db.execute(
        "INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        (key, value, now_iso()),
    )
    db.commit()


def masked_config(cfg):
    """Config as handed to the frontend: secrets replaced by a mask, plus a flag
    telling the UI whether a secret is stored at all."""
    out = dict(cfg)
    for key in SECRET_KEYS:
        out[f"{key}_set"] = bool(cfg.get(key))
        out[key] = SECRET_MASK if cfg.get(key) else ""
    out.pop("crypto_salt", None)
    for key in LEGACY_KEYS:
        out.pop(key, None)
    return out


def merge_secrets(incoming):
    """The UI echoes back the mask for untouched secrets — drop those so the
    stored value survives."""
    merged = dict(incoming)
    for key in SECRET_KEYS:
        if key in merged and merged[key] in (SECRET_MASK, None):
            merged.pop(key)
    return merged


def retention_days(cfg):
    try:
        return max(0, int(cfg.get("retention_days") or 30))
    except (TypeError, ValueError):
        return 30


def get_crypto_salt(db, cfg):
    """Salt for the scrypt master-key derivation. Generated once, then constant —
    it is also written into every file header so restores stay self-contained."""
    raw = cfg.get("crypto_salt") or ""
    if raw:
        return base64.b64decode(raw)
    salt = os.urandom(16)
    encoded = base64.b64encode(salt).decode()
    set_config_internal(db, "crypto_salt", encoded)
    cfg["crypto_salt"] = encoded
    return salt


# ── Backup targets ───────────────────────────────────────────────────────────

TARGET_FIELDS = ["name", "kind", "endpoint_url", "addressing", "require_mount",
                 "region", "bucket", "prefix", "storage_class", "enabled", "sort_order"]


def normalize_prefix(prefix):
    return (prefix or "").strip().strip("/")


def get_targets(db, only_enabled=False):
    query = "SELECT * FROM backup_target"
    if only_enabled:
        query += " WHERE enabled = 1"
    query += " ORDER BY sort_order, id"
    return [dict(row) for row in db.execute(query)]


def get_target(db, target_id):
    row = db.execute("SELECT * FROM backup_target WHERE id = ?", (target_id,)).fetchone()
    return dict(row) if row else None


def _validate_target(values):
    """Shared validation. An fs target needs no region, an s3 target does."""
    kind = (values.get("kind") or "s3").strip().lower()
    if kind not in ("s3", "fs"):
        raise ValueError("kind muss s3 oder fs sein.")
    name = (values.get("name") or "").strip()
    bucket = (values.get("bucket") or "").strip()
    region = (values.get("region") or "").strip()
    if not name:
        raise ValueError("Name ist Pflicht.")
    if not bucket:
        raise ValueError("Bucket bzw. Zielverzeichnis ist Pflicht.")
    if kind == "s3" and not region:
        raise ValueError("Für S3-Ziele ist eine Region Pflicht.")
    if kind == "fs" and not bucket.startswith("/"):
        raise ValueError("Für Verzeichnis-Ziele wird ein absoluter Pfad gebraucht.")
    addressing = (values.get("addressing") or "auto").strip().lower()
    if addressing not in ("auto", "path", "virtual"):
        raise ValueError("addressing muss auto, path oder virtual sein.")
    return {
        "name": name,
        "kind": kind,
        "endpoint_url": (values.get("endpoint_url") or "").strip().rstrip("/"),
        "addressing": addressing,
        "require_mount": 1 if values.get("require_mount") else 0,
        "region": region,
        "bucket": bucket if kind == "s3" else os.path.normpath(bucket),
        "prefix": normalize_prefix(values.get("prefix")),
        "storage_class": (values.get("storage_class") or "STANDARD_IA").strip(),
    }


def create_target(db, values):
    merged = _validate_target(values)
    merged["enabled"] = 1 if values.get("enabled", True) else 0
    merged["sort_order"] = db.execute(
        "SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM backup_target").fetchone()["n"]
    columns = ", ".join(TARGET_FIELDS)
    placeholders = ", ".join("?" for _ in TARGET_FIELDS)
    cur = db.execute(
        f"INSERT INTO backup_target ({columns}) VALUES ({placeholders})",
        [merged[k] for k in TARGET_FIELDS],
    )
    db.commit()
    return get_target(db, cur.lastrowid)


def update_target(db, target_id, values):
    existing = get_target(db, target_id)
    if not existing:
        return None
    # Only the keys actually supplied override the stored row.
    incoming = {key: existing[key] for key in TARGET_FIELDS if key in existing}
    incoming.update({k: v for k, v in values.items() if k in TARGET_FIELDS})
    merged = _validate_target(incoming)
    merged["enabled"] = 1 if values.get("enabled", bool(existing["enabled"])) else 0
    merged["sort_order"] = int(values.get("sort_order", existing["sort_order"]))
    db.execute(
        "UPDATE backup_target SET "
        + ", ".join(f"{k} = ?" for k in TARGET_FIELDS)
        + ", updated_at = ? WHERE id = ?",
        [merged[k] for k in TARGET_FIELDS] + [now_iso(), target_id],
    )
    db.commit()
    return get_target(db, target_id)


def delete_target(db, target_id):
    """Stops tracking a bucket. Objects already in it are left untouched — the job
    can no longer reach them, so they become orphans the operator has to clean up."""
    db.execute("DELETE FROM object_target WHERE target_id = ?", (target_id,))
    db.execute("DELETE FROM backup_target WHERE id = ?", (target_id,))
    db.commit()


def target_coverage(db):
    """Per target: how many live objects are stored, outdated or still missing."""
    live = db.execute(
        "SELECT COUNT(*) AS n FROM backup_object WHERE deleted_at IS NULL"
    ).fetchone()["n"]
    # Driven from object_target rather than from a target x object cross join, so
    # the cost scales with what is actually stored, not with targets x files.
    rows = db.execute(
        "SELECT ot.target_id AS target_id, "
        "  SUM(CASE WHEN ot.size = o.size AND ot.mtime_ns = o.mtime_ns THEN 1 ELSE 0 END) AS current, "
        "  SUM(CASE WHEN ot.size != o.size OR ot.mtime_ns != o.mtime_ns THEN 1 ELSE 0 END) AS outdated, "
        "  COALESCE(SUM(ot.size), 0) AS bytes "
        "FROM object_target ot JOIN backup_object o ON o.id = ot.object_id "
        "WHERE o.deleted_at IS NULL GROUP BY ot.target_id"
    ).fetchall()
    stored = {r["target_id"]: r for r in rows}

    coverage = {}
    for target in db.execute("SELECT id FROM backup_target"):
        row = stored.get(target["id"])
        current = (row["current"] if row else 0) or 0
        outdated = (row["outdated"] if row else 0) or 0
        coverage[target["id"]] = {
            "liveObjects": live,
            "current": current,
            "outdated": outdated,
            "missing": max(0, live - current - outdated),
            "bytes": (row["bytes"] if row else 0) or 0,
        }
    return coverage


def migrate_legacy_target(db):
    """Turn a pre-multi-target installation into one with a single target.

    Runs once. Without it the first multi-target run would consider every file
    unstored and upload the whole NAS again.
    """
    cfg = get_config(db)
    if cfg.get("targets_migrated") == "1":
        return None
    if db.execute("SELECT COUNT(*) AS n FROM backup_target").fetchone()["n"]:
        set_config_internal(db, "targets_migrated", "1")
        return None
    bucket = (cfg.get("s3_bucket") or "").strip()
    if not bucket:
        # Nothing configured yet — a fresh install simply starts with no targets.
        set_config_internal(db, "targets_migrated", "1")
        return None

    prefix = normalize_prefix(cfg.get("s3_prefix"))
    cur = db.execute(
        "INSERT INTO backup_target (name, region, bucket, prefix, storage_class, enabled, sort_order) "
        "VALUES (?, ?, ?, ?, ?, 1, 1)",
        (f"{bucket} ({cfg.get('aws_region')})", cfg.get("aws_region") or "", bucket,
         prefix, cfg.get("storage_class") or "STANDARD_IA"),
    )
    target_id = cur.lastrowid

    # Existing rows carry the full key including the prefix; going forward
    # backup_object.s3_key holds the key without it.
    db.execute(
        "INSERT OR IGNORE INTO object_target (object_id, target_id, s3_key, size, mtime_ns, uploaded_at) "
        "SELECT id, ?, s3_key, size, mtime_ns, uploaded_at FROM backup_object WHERE uploaded_at IS NOT NULL",
        (target_id,),
    )
    if prefix:
        db.execute(
            "UPDATE backup_object SET s3_key = substr(s3_key, ?) WHERE s3_key LIKE ?",
            (len(prefix) + 2, f"{prefix}/%"),
        )
    db.commit()
    set_config_internal(db, "targets_migrated", "1")
    return target_id


# ── Path helpers ─────────────────────────────────────────────────────────────

def normalize_rel(path):
    """Normalize a NAS-relative path. Raises ValueError on traversal attempts."""
    if path is None:
        return ""
    path = str(path).replace("\\", "/").strip().strip("/")
    if not path:
        return ""
    normalized = posixpath.normpath(path)
    if normalized in (".", "/"):
        return ""
    if normalized == ".." or normalized.startswith("../") or "/../" in f"/{normalized}/":
        raise ValueError("path traversal is not allowed")
    return normalized.strip("/")


def ancestors(rel):
    """['a/b/c', 'a/b', 'a', ''] — most specific first, root last."""
    out = []
    current = rel
    while current:
        out.append(current)
        current = posixpath.dirname(current)
    out.append("")
    return out


# ── Folder rules ─────────────────────────────────────────────────────────────

def get_rules(db):
    return {row["path"]: row["mode"] for row in db.execute("SELECT path, mode FROM folder_rule")}


def set_rule(db, rel, mode):
    if mode not in ("include", "exclude"):
        raise ValueError("mode must be include or exclude")
    db.execute(
        "INSERT INTO folder_rule (path, mode, updated_at) VALUES (?, ?, ?) "
        "ON CONFLICT(path) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at",
        (rel, mode, now_iso()),
    )
    db.commit()


def clear_rule(db, rel):
    db.execute("DELETE FROM folder_rule WHERE path = ?", (rel,))
    db.commit()


class RuleSet:
    """Resolves the effective backup decision for any folder.

    A folder inherits from its nearest ancestor with an explicit rule; without any
    ancestor rule the answer is 'exclude' (the required default: nothing is backed
    up unless it was selected). `should_descend` additionally keeps excluded
    branches walkable when an include rule sits somewhere below them.
    """

    def __init__(self, rules):
        self.rules = dict(rules)
        # Every ancestor of an included folder must stay walkable.
        self.include_ancestors = set()
        for path, mode in self.rules.items():
            if mode != "include":
                continue
            for anc in ancestors(path)[1:]:
                self.include_ancestors.add(anc)

    def mode(self, rel):
        for candidate in ancestors(rel):
            if candidate in self.rules:
                return self.rules[candidate]
        return "exclude"

    def explicit(self, rel):
        return self.rules.get(rel)

    def should_descend(self, rel):
        """True if this folder is backed up or still contains an included subtree."""
        return self.mode(rel) == "include" or rel in self.include_ancestors
