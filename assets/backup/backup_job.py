#!/usr/bin/env python3
"""Daily NAS -> S3 backup job.

One run does, in this order:

  1. read the folder selection made in the dashboard,
  2. carry out deletion markers that have reached their retention age,
  3. walk the selected folders and upload every new or modified file,
  4. set a deletion marker on everything that vanished or was deselected.

Files are encrypted with AES-256-GCM before upload (see filecrypt.py); the key
comes from a root-only key file. .kdbx files themselves are uploaded unencrypted
so they stay usable without this tooling — their own encryption is what protects
them.

Usage:
    python3 backup_job.py [--trigger cron|manual] [--dry-run] [--verbose]
"""

import argparse
import fcntl
import getpass
import os
import stat
import sys
import tempfile
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import state
from filecrypt import ENCRYPTED_SUFFIX, BackupCipher
from storage_targets import TargetError, build_target

LOCK_FILE = os.path.join(state.DATA_DIR, "backup.lock")

# Uploaded as-is: KeePass files carry their own strong encryption and must stay
# openable with a normal KeePass client straight from the bucket.
PLAIN_SUFFIXES = (".kdbx",)

MAX_LOG_CHARS = 60000
PURGE_BATCH = 1000


class JobError(Exception):
    """Fatal problem — the run is aborted and recorded as failed."""


class RunLog:
    def __init__(self, verbose):
        self.verbose = verbose
        self.lines = []
        self.truncated = False

    def __call__(self, message):
        stamp = datetime.now(timezone.utc).strftime("%H:%M:%S")
        line = f"[{stamp}] {message}"
        if self.verbose:
            print(line, flush=True)
        if not self.truncated:
            self.lines.append(line)
            if sum(len(x) + 1 for x in self.lines) > MAX_LOG_CHARS:
                self.truncated = True
                self.lines.append("… (Log gekürzt)")

    def text(self):
        return "\n".join(self.lines)


# ── Configuration checks ─────────────────────────────────────────────────────

def read_secret_file(path):
    """Read a secret from a file that only its owner may read."""
    if not path:
        raise JobError("Kein Pfad zur Passwortdatei konfiguriert.")
    if not os.path.isfile(path):
        raise JobError(f"Passwortdatei nicht gefunden: {path}")
    mode = os.stat(path).st_mode
    if mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise JobError(
            f"Passwortdatei {path} ist für Gruppe/Andere zugänglich — bitte 'chmod 600' setzen.")
    # OSError wird zu JobError: check_config sammelt Probleme und meldet sie,
    # faengt aber nur JobError. Ein durchgelassener PermissionError wird daraus
    # ein 500 in der Oberflaeche - "INTERNAL SERVER ERROR" statt der Aussage,
    # welche Datei der Dienst nicht lesen darf.
    try:
        with open(path, encoding="utf-8") as f:
            secret = f.read().strip()
    except OSError as exc:
        raise JobError(
            f"Passwortdatei {path} ist nicht lesbar: {exc.strerror}. "
            f"Der Dienst laeuft als {getpass.getuser()}; Datei und jedes "
            f"Verzeichnis darueber muessen fuer ihn erreichbar sein."
        ) from exc
    if not secret:
        raise JobError(f"Passwortdatei {path} ist leer.")
    return secret


def load_backup_passphrase(cfg):
    """Read the backup encryption key from its root-only file.

    The key is generated once during installation and its authoritative copy lives
    in the operator's credential store; this file is the materialised copy the
    unattended job is allowed to read. Limiting the job to a single key means a
    compromised Pi leaks the backup key alone, not the store holding every other
    credential as well.
    """
    key_file = cfg.get("key_file") or ""
    if not key_file:
        raise JobError("Keine Schlüsseldatei konfiguriert.")
    return read_secret_file(key_file)


def _s3_config(addressing="auto"):
    """botocore client config for every S3 target.

    request_checksum_calculation is the point of this function. Since botocore
    1.36 the default is "when_supported": a CRC32 is added to every upload and
    the body is wrapped in AwsChunkedWrapper, which is not seekable. The first
    retry then has to rewind the body and dies with

        Need to rewind the stream <AwsChunkedWrapper>, but stream is not seekable

    and the upload fails. Not only for large files - for all of them, which is
    why a run would report "0 files transferred" while looking otherwise
    healthy. "when_required" restores the earlier behaviour; S3 PutObject does
    not require a checksum, and the transfer is TLS-protected either way.

    Older botocore versions do not know the setting, so an unknown keyword is
    dropped rather than allowed to break the client.
    """
    from botocore.config import Config

    config_kwargs = {"request_checksum_calculation": "when_required"}
    if addressing in ("path", "virtual"):
        config_kwargs["s3"] = {"addressing_style": addressing}
    try:
        return Config(**config_kwargs)
    except TypeError:
        config_kwargs.pop("request_checksum_calculation", None)
        return Config(**config_kwargs) if config_kwargs else Config()


class S3Clients:
    """One boto3 client per region, shared across targets.

    All targets use the same IAM user; only the region differs, and a client is
    bound to its region, so they are cached by region name.
    """

    def __init__(self, cfg):
        self.cfg = cfg
        self._clients = {}

    def for_target(self, target):
        """Clients are cached per (region, endpoint): an S3-compatible store is a
        different service even when it reports the same region name."""
        endpoint = (target.get("endpoint_url") or "").strip()
        addressing = (target.get("addressing") or "auto").strip()
        return self._client(target.get("region") or "", endpoint, addressing)

    def for_region(self, region):
        return self._client(region, "", "auto")

    def _client(self, region, endpoint="", addressing="auto"):
        cache_key = (region, endpoint, addressing)
        if not region and not endpoint:
            raise JobError("Für ein Ziel ist weder Region noch Endpunkt gesetzt.")
        if cache_key not in self._clients:
            try:
                import boto3
            except ImportError as exc:
                raise JobError("boto3 ist nicht installiert (pip install boto3).") from exc
            kwargs = {"region_name": region or "us-east-1"}
            if endpoint:
                kwargs["endpoint_url"] = endpoint
            kwargs["config"] = _s3_config(addressing)
            # Empty credentials fall back to the default boto3 chain (instance
            # profile, ~/.aws/credentials, environment).
            if self.cfg.get("aws_access_key_id") and self.cfg.get("aws_secret_access_key"):
                kwargs["aws_access_key_id"] = self.cfg["aws_access_key_id"]
                kwargs["aws_secret_access_key"] = self.cfg["aws_secret_access_key"]
            self._clients[cache_key] = boto3.client("s3", **kwargs)
        return self._clients[cache_key]


def make_s3_client(cfg, region=None):
    """Single client, used by restore.py and the connection check."""
    return S3Clients(cfg).for_region(region or cfg.get("aws_region"))


def check_config(cfg, targets, deep=False):
    """Return a list of human-readable problems. `deep` also contacts S3 and KeePass."""
    problems = []
    nas_root = cfg.get("nas_root") or ""
    if not nas_root:
        problems.append("Kein NAS-Wurzelverzeichnis konfiguriert.")
    elif not os.path.isdir(nas_root):
        problems.append(f"NAS-Wurzelverzeichnis nicht gefunden: {nas_root}")

    enabled = [t for t in targets if t["enabled"]]
    if not targets:
        problems.append("Kein Backup-Ziel angelegt.")
    elif not enabled:
        problems.append("Kein Backup-Ziel aktiv.")
    for target in enabled:
        kind = (target.get("kind") or "s3").lower()
        if not target["bucket"]:
            problems.append(f"Ziel '{target['name']}': kein Bucket/Verzeichnis gesetzt.")
        if kind == "s3" and not target["region"] and not (target.get("endpoint_url") or ""):
            problems.append(f"Ziel '{target['name']}': weder Region noch Endpunkt gesetzt.")

    key_file = cfg.get("key_file") or ""
    if not key_file:
        problems.append("Keine Schlüsseldatei konfiguriert.")
    elif not os.path.isfile(key_file):
        problems.append(f"Schlüsseldatei nicht gefunden: {key_file}")

    if not deep:
        return problems

    try:
        load_backup_passphrase(cfg)
    except JobError as exc:
        problems.append(str(exc))

    clients = S3Clients(cfg)
    for target in enabled:
        if not target["bucket"]:
            continue
        try:
            build_target(target, clients).check()
        except (JobError, TargetError) as exc:
            problems.append(f"Ziel '{target['name']}': {exc}")
        except Exception as exc:  # noqa: BLE001 - any backend error is worth reporting
            problems.append(f"Ziel '{target['name']}' ({target['bucket']}) nicht erreichbar: {exc}")
    return problems


# ── Run bookkeeping ──────────────────────────────────────────────────────────

@contextmanager
def job_lock():
    """Refuse to run twice at once.

    A flock is used rather than a database flag because the kernel releases it
    even when the job is killed — a crashed run must not block every night after.
    """
    os.makedirs(state.DATA_DIR, exist_ok=True)
    handle = open(LOCK_FILE, "w", encoding="utf-8")  # noqa: SIM115 - held for the run
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        raise JobError("Es läuft bereits eine Sicherung.") from None
    try:
        yield
    finally:
        fcntl.flock(handle, fcntl.LOCK_UN)
        handle.close()


def close_stale_runs(db):
    """We hold the lock, so any run still marked 'running' died without finishing."""
    db.execute(
        "UPDATE backup_run SET status = 'error', finished_at = ?, "
        "error = COALESCE(error, 'Lauf wurde abgebrochen (Prozess beendet).') "
        "WHERE status = 'running'",
        (state.now_iso(),),
    )
    db.commit()


def start_run(db, trigger):
    cur = db.execute(
        "INSERT INTO backup_run (started_at, status, trigger) VALUES (?, 'running', ?)",
        (state.now_iso(), trigger),
    )
    db.commit()
    return cur.lastrowid


def finish_run(db, run_id, status, stats, log_text, error=None):
    db.execute(
        "UPDATE backup_run SET finished_at = ?, status = ?, files_scanned = ?, "
        "files_uploaded = ?, bytes_uploaded = ?, files_marked = ?, files_purged = ?, "
        "error = ?, log = ? WHERE id = ?",
        (state.now_iso(), status, stats["scanned"], stats["uploaded"], stats["bytes"],
         stats["marked"], stats["purged"], error, log_text, run_id),
    )
    db.commit()


# ── Step 1: carry out reached deletion markers ───────────────────────────────

def purge_expired(db, cfg, clients, targets, log, dry_run):
    """Delete objects whose deletion marker is older than the retention period.

    Every target holding a copy is cleaned, disabled ones included — retention is a
    promise about deletion, and a disabled target is still a bucket with the data in
    it. The index row is only dropped once no target holds a copy any more, so a
    bucket that was unreachable is retried on the next run instead of being orphaned.
    """
    days = state.retention_days(cfg)
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds")
    expired = db.execute(
        "SELECT id, rel_path FROM backup_object "
        "WHERE deleted_at IS NOT NULL AND deleted_at <= ? ORDER BY id",
        (cutoff,),
    ).fetchall()
    if not expired:
        log(f"Keine fälligen Löschmarker (Aufbewahrung: {days} Tage).")
        return 0

    log(f"{len(expired)} Löschmarker sind älter als {days} Tage — werden umgesetzt.")
    if dry_run:
        for row in expired[:20]:
            log(f"  [dry-run] würde löschen: {row['rel_path']}")
        return len(expired)

    expired_ids = [row["id"] for row in expired]
    by_target = {t["id"]: t for t in targets}

    for target_id, target in by_target.items():
        placeholders = ",".join("?" for _ in expired_ids)
        rows = db.execute(
            f"SELECT object_id, s3_key FROM object_target "
            f"WHERE target_id = ? AND object_id IN ({placeholders})",
            [target_id] + expired_ids,
        ).fetchall()
        if not rows:
            continue
        try:
            backend = build_target(target, clients)
        except (JobError, TargetError) as exc:
            log(f"  Ziel '{target['name']}' übersprungen: {exc}")
            continue

        for start in range(0, len(rows), PURGE_BATCH):
            batch = rows[start:start + PURGE_BATCH]
            try:
                failed_keys = backend.delete([r["s3_key"] for r in batch])
            except Exception as exc:  # noqa: BLE001 - keep the rows and retry next run
                log(f"  Löschen auf '{target['name']}' fehlgeschlagen: {exc}")
                break
            for key in failed_keys:
                log(f"  Löschen fehlgeschlagen ({target['name']}): {key}")
            done = [(r["object_id"], target_id) for r in batch if r["s3_key"] not in failed_keys]
            db.executemany(
                "DELETE FROM object_target WHERE object_id = ? AND target_id = ?", done)
            db.commit()

    # Only objects that no target holds any more may leave the index.
    placeholders = ",".join("?" for _ in expired_ids)
    cur = db.execute(
        f"DELETE FROM backup_object WHERE id IN ({placeholders}) "
        f"AND id NOT IN (SELECT object_id FROM object_target)",
        expired_ids,
    )
    db.commit()
    purged = cur.rowcount
    remaining = len(expired_ids) - purged
    log(f"{purged} Objekte endgültig gelöscht."
        + (f" {remaining} bleiben vorgemerkt (Ziel nicht erreichbar)." if remaining else ""))
    return purged


# ── Step 2: walk the selection and upload changes ────────────────────────────

def object_key(rel_path, encrypted):
    """Key of a file without any target prefix — the same in every bucket."""
    return rel_path + ENCRYPTED_SUFFIX if encrypted else rel_path


def target_key(target, key):
    prefix = (target["prefix"] or "").strip("/")
    return f"{prefix}/{key}" if prefix else key


def is_plain(rel_path):
    return rel_path.lower().endswith(PLAIN_SUFFIXES)


def iter_selected_files(nas_root, rules, log):
    """Yield (rel_path, abs_path, stat_result) for every file in an included folder.

    Excluded branches are only descended into when an include rule sits below them,
    so deselected parts of the NAS are never walked.
    """
    stack = [""]
    while stack:
        rel_dir = stack.pop()
        abs_dir = os.path.join(nas_root, rel_dir) if rel_dir else nas_root
        included = rules.mode(rel_dir) == "include"
        try:
            entries = list(os.scandir(abs_dir))
        except OSError as exc:
            log(f"  Verzeichnis übersprungen ({exc.strerror}): {rel_dir or '/'}")
            continue
        for entry in entries:
            rel_child = f"{rel_dir}/{entry.name}" if rel_dir else entry.name
            try:
                # Symlinks are never followed: they would allow escaping the NAS
                # root and can form loops.
                if entry.is_symlink():
                    continue
                if entry.is_dir(follow_symlinks=False):
                    if rules.should_descend(rel_child):
                        stack.append(rel_child)
                elif entry.is_file(follow_symlinks=False) and included:
                    yield rel_child, entry.path, entry.stat(follow_symlinks=False)
            except OSError as exc:
                log(f"  Eintrag übersprungen ({exc.strerror}): {rel_child}")


@contextmanager
def prepared_upload(cipher, rel_path, abs_path, staging_dir):
    """Yield (path_to_upload, encrypted, size) for one file.

    Encryption happens once even when several targets need the file — the same
    ciphertext then goes to every bucket, which also keeps the upload cost of a
    second region to just the transfer.
    """
    encrypted = not is_plain(rel_path)
    if not encrypted:
        yield abs_path, False, os.path.getsize(abs_path)
        return

    fd, tmp_path = tempfile.mkstemp(prefix="pinas-backup-", suffix=ENCRYPTED_SUFFIX,
                                    dir=staging_dir or None)
    os.close(fd)
    try:
        size = cipher.encrypt_file(abs_path, tmp_path)
        yield tmp_path, True, size
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def record_object(db, rel_path, key, st, encrypted, run_stamp):
    """Upsert the file row and return its id. Written before any upload, so a file
    that fails on every target is still known and retried next run."""
    db.execute(
        "INSERT INTO backup_object (rel_path, s3_key, size, mtime_ns, encrypted, "
        "last_seen_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, NULL) "
        "ON CONFLICT(rel_path) DO UPDATE SET s3_key = excluded.s3_key, size = excluded.size, "
        "mtime_ns = excluded.mtime_ns, encrypted = excluded.encrypted, "
        "last_seen_at = excluded.last_seen_at, deleted_at = NULL",
        (rel_path, key, st.st_size, st.st_mtime_ns, 1 if encrypted else 0, run_stamp),
    )
    return db.execute("SELECT id FROM backup_object WHERE rel_path = ?", (rel_path,)).fetchone()["id"]


def pending_targets(db, object_id, st, targets):
    """Targets that do not hold the current version of this file.

    A target is up to date when its object_target row matches the file's size and
    mtime; a differing row means an outdated copy, a missing row means nothing was
    ever stored there. Both need an upload, and both are decided per target — a
    failure on one bucket never causes a re-upload to the other.
    """
    if object_id is None:
        return list(targets)
    stored = {
        row["target_id"]: row
        for row in db.execute(
            "SELECT target_id, size, mtime_ns FROM object_target WHERE object_id = ?",
            (object_id,),
        )
    }
    pending = []
    for target in targets:
        row = stored.get(target["id"])
        if row is None or row["size"] != st.st_size or row["mtime_ns"] != st.st_mtime_ns:
            pending.append(target)
    return pending


def sync_files(db, cfg, clients, targets, cipher, rules, run_stamp, log, dry_run):
    """Mark-and-sweep pass 1: visit every selected file, upload what is missing.

    Every visited file gets last_seen_at = run_stamp; the sweep afterwards uses
    that to find everything that disappeared.
    """
    nas_root = cfg["nas_root"]
    staging_dir = cfg.get("staging_dir") or ""
    if staging_dir:
        os.makedirs(staging_dir, exist_ok=True)

    scanned = uploaded = failed = 0
    total_bytes = 0
    per_target = {t["id"]: 0 for t in targets}
    # One adapter per target, built once: an fs target validates its mount here
    # rather than on every single file.
    backends = {}
    for target in targets:
        try:
            backends[target["id"]] = build_target(target, clients)
        except (JobError, TargetError) as exc:
            log(f"  Ziel '{target['name']}' nicht nutzbar: {exc}")
    targets = [t for t in targets if t["id"] in backends]

    for rel_path, abs_path, st in iter_selected_files(nas_root, rules, log):
        scanned += 1
        row = db.execute(
            "SELECT id, deleted_at FROM backup_object WHERE rel_path = ?", (rel_path,)
        ).fetchone()
        object_id = row["id"] if row else None
        pending = pending_targets(db, object_id, st, targets)

        if not pending:
            # Written even on a dry run: mark_missing() reads last_seen_at, so
            # without it the dry-run report would claim everything vanished. A file
            # that came back before its marker expired only needs the marker cleared.
            db.execute(
                "UPDATE backup_object SET last_seen_at = ?, deleted_at = NULL WHERE id = ?",
                (run_stamp, object_id))
            continue

        if dry_run:
            names = ", ".join(t["name"] for t in pending)
            log(f"  [dry-run] würde sichern: {rel_path} ({st.st_size} Bytes) -> {names}")
            uploaded += 1
            total_bytes += st.st_size * len(pending)
            if object_id is not None:
                db.execute("UPDATE backup_object SET last_seen_at = ? WHERE id = ?",
                           (run_stamp, object_id))
            continue

        encrypted = not is_plain(rel_path)
        key = object_key(rel_path, encrypted)
        object_id = record_object(db, rel_path, key, st, encrypted, run_stamp)

        succeeded = 0
        try:
            with prepared_upload(cipher, rel_path, abs_path, staging_dir) as (src, _enc, written):
                for target in pending:
                    full_key = target_key(target, key)
                    try:
                        backends[target["id"]].upload(src, full_key)
                    except Exception as exc:  # noqa: BLE001 - one target must not fail the rest
                        log(f"  Upload nach '{target['name']}' fehlgeschlagen: {rel_path} ({exc})")
                        continue
                    db.execute(
                        "INSERT INTO object_target (object_id, target_id, s3_key, size, "
                        "mtime_ns, uploaded_at) VALUES (?, ?, ?, ?, ?, ?) "
                        "ON CONFLICT(object_id, target_id) DO UPDATE SET s3_key = excluded.s3_key, "
                        "size = excluded.size, mtime_ns = excluded.mtime_ns, "
                        "uploaded_at = excluded.uploaded_at",
                        (object_id, target["id"], full_key, st.st_size, st.st_mtime_ns,
                         state.now_iso()),
                    )
                    per_target[target["id"]] += 1
                    succeeded += 1
                    total_bytes += written
        except Exception as exc:  # noqa: BLE001 - encryption or staging failed
            log(f"  Verschlüsselung fehlgeschlagen: {rel_path} ({exc})")

        if succeeded:
            db.execute("UPDATE backup_object SET uploaded_at = ? WHERE id = ?",
                       (state.now_iso(), object_id))
            uploaded += 1
        if succeeded < len(pending):
            failed += 1
        db.commit()
        if uploaded and uploaded % 50 == 0:
            log(f"  {uploaded} Dateien gesichert …")

    db.commit()
    for target in targets:
        log(f"  Ziel '{target['name']}': {per_target[target['id']]} Dateien übertragen.")
    return scanned, uploaded, total_bytes, failed


# ── Step 3: set deletion markers ─────────────────────────────────────────────

def guard_empty_scan(db, scanned, log):
    """Refuse to mark everything deleted when the scan came back empty.

    An unmounted NAS looks exactly like 'the user deleted every file'. Without this
    guard one bad night would put a deletion marker on the whole backup.
    """
    if scanned:
        return
    live = db.execute(
        "SELECT COUNT(*) AS n FROM backup_object WHERE deleted_at IS NULL"
    ).fetchone()["n"]
    if live:
        raise JobError(
            f"Kein einziges Dateisystem-Objekt gefunden, obwohl {live} Dateien im Index "
            f"stehen — vermutlich ist das NAS nicht eingehängt. Es wurden keine "
            f"Löschmarker gesetzt.")
    log("Keine Dateien in der Auswahl gefunden.")


def mark_missing(db, run_stamp, log, dry_run):
    """Mark-and-sweep pass 2: everything not visited this run is gone or deselected."""
    rows = db.execute(
        "SELECT id, rel_path FROM backup_object "
        "WHERE deleted_at IS NULL AND (last_seen_at IS NULL OR last_seen_at != ?)",
        (run_stamp,),
    ).fetchall()
    if not rows:
        log("Keine neuen Löschmarker.")
        return 0

    log(f"{len(rows)} Dateien nicht mehr vorhanden/ausgewählt — Löschmarker gesetzt.")
    for row in rows[:20]:
        log(f"  Marker: {row['rel_path']}")
    if len(rows) > 20:
        log(f"  … und {len(rows) - 20} weitere")
    if dry_run:
        return len(rows)

    stamp = state.now_iso()
    db.executemany("UPDATE backup_object SET deleted_at = ? WHERE id = ?",
                   [(stamp, row["id"]) for row in rows])
    db.commit()
    return len(rows)


# ── Entry point ──────────────────────────────────────────────────────────────

def run(trigger="cron", dry_run=False, verbose=False, force=False):
    state.init_db()
    try:
        with job_lock():
            return _run_locked(trigger, dry_run, verbose, force)
    except JobError as exc:
        # Only the lock itself can fail out here — _run_locked records its own errors.
        print(f"Abbruch: {exc}", file=sys.stderr)
        return 1


def _run_locked(trigger, dry_run, verbose, force):
    db = state.connect()
    log = RunLog(verbose)
    stats = {"scanned": 0, "uploaded": 0, "bytes": 0, "marked": 0, "purged": 0}
    close_stale_runs(db)
    run_id = start_run(db, trigger)
    # A single timestamp identifies this run for the mark-and-sweep.
    run_stamp = f"run-{run_id}-{state.now_iso()}"

    try:
        cfg = state.get_config(db)
        if cfg.get("enabled") != "1" and not force:
            raise JobError("Backup ist im Dashboard deaktiviert.")

        all_targets = state.get_targets(db)
        active = [t for t in all_targets if t["enabled"]]
        problems = check_config(cfg, all_targets)
        if problems:
            raise JobError("Konfiguration unvollständig: " + " ".join(problems))

        rules = state.RuleSet(state.get_rules(db))
        included = sorted(p for p, m in rules.rules.items() if m == "include")
        if not included:
            raise JobError("Es ist kein Ordner zur Sicherung ausgewählt.")
        log(f"{len(included)} ausgewählte Ordner: " + ", ".join(f"/{p}" for p in included[:10])
            + (" …" if len(included) > 10 else ""))
        log(f"{len(active)} aktive Ziele: "
            + ", ".join(f"{t['name']} ({t['region']}/{t['bucket']})" for t in active))

        clients = S3Clients(cfg)
        passphrase = load_backup_passphrase(cfg)
        cipher = BackupCipher(passphrase, state.get_crypto_salt(db, cfg))
        log("Backup-Schlüssel geladen.")

        # Purging covers every target, including disabled ones — see purge_expired.
        stats["purged"] = purge_expired(db, cfg, clients, all_targets, log, dry_run)

        scanned, uploaded, total_bytes, failed = sync_files(
            db, cfg, clients, active, cipher, rules, run_stamp, log, dry_run)
        stats.update(scanned=scanned, uploaded=uploaded, bytes=total_bytes)
        log(f"{scanned} Dateien geprüft, {uploaded} gesichert ({total_bytes} Bytes).")

        guard_empty_scan(db, scanned, log)
        stats["marked"] = mark_missing(db, run_stamp, log, dry_run)

        if failed:
            finish_run(db, run_id, "error", stats, log.text(),
                       f"{failed} Datei(en) fehlen noch auf mindestens einem Ziel.")
            return 1
        finish_run(db, run_id, "ok", stats, log.text())
        return 0

    except JobError as exc:
        log(f"Abbruch: {exc}")
        finish_run(db, run_id, "error", stats, log.text(), str(exc))
        return 1
    except Exception as exc:  # noqa: BLE001 - the run record must never be left 'running'
        log(f"Unerwarteter Fehler: {exc}")
        finish_run(db, run_id, "error", stats, log.text(), repr(exc))
        return 1
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description="Sichert ausgewählte NAS-Ordner verschlüsselt nach S3.")
    parser.add_argument("--trigger", default="cron", choices=["cron", "manual"])
    parser.add_argument("--dry-run", action="store_true", help="Nichts hochladen oder löschen, nur berichten")
    parser.add_argument("--verbose", action="store_true", help="Log zusätzlich auf stdout")
    parser.add_argument("--force", action="store_true", help="Auch laufen, wenn im Dashboard deaktiviert")
    args = parser.parse_args()
    sys.exit(run(trigger=args.trigger, dry_run=args.dry_run, verbose=args.verbose, force=args.force))


if __name__ == "__main__":
    main()
