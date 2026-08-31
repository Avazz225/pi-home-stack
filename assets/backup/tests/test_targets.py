"""Multi-target behaviour: migration of a single-bucket install, per-target tracking,
partial failures and purging across buckets."""

import os
import shutil
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import state  # noqa: E402

WORK = tempfile.mkdtemp(prefix="pinas-targets-")
state.DATA_DIR = os.path.join(WORK, "data")
state.DB_FILE = os.path.join(state.DATA_DIR, "backup.db")

import backup_job  # noqa: E402
import restore as restore_mod  # noqa: E402

failures = []


def check(name, condition, detail=""):
    print(("PASS  " if condition else "FAIL  ") + name + (f"  ({detail})" if not condition else ""))
    if not condition:
        failures.append(name)


class FakeS3:
    """Bucket-aware stub: objects are keyed by (bucket, key) so two targets are
    genuinely distinguishable. `fail_buckets` simulates an unreachable region."""

    def __init__(self):
        self.objects = {}
        self.fail_buckets = set()

    def upload_file(self, path, bucket, key, ExtraArgs=None):  # noqa: N803 - boto3 signature
        if bucket in self.fail_buckets:
            raise RuntimeError(f"{bucket} nicht erreichbar")
        with open(path, "rb") as f:
            self.objects[(bucket, key)] = f.read()

    def download_file(self, bucket, key, path):
        with open(path, "wb") as f:
            f.write(self.objects[(bucket, key)])

    def delete_objects(self, Bucket, Delete):  # noqa: N803 - boto3 signature
        if Bucket in self.fail_buckets:
            raise RuntimeError(f"{Bucket} nicht erreichbar")
        for item in Delete["Objects"]:
            self.objects.pop((Bucket, item["Key"]), None)
        return {}

    def head_bucket(self, Bucket):  # noqa: N803 - boto3 signature
        return {}


S3 = FakeS3()
backup_job.load_backup_passphrase = lambda cfg: "key"
backup_job.S3Clients.for_region = lambda self, region: S3
backup_job.S3Clients._client = lambda self, *a, **k: S3
backup_job.S3Clients.for_target = lambda self, target: S3

NAS = os.path.join(WORK, "nas")
os.makedirs(os.path.join(NAS, "Daten"))
for name in ["a.txt", "b.txt"]:
    with open(os.path.join(NAS, "Daten", name), "w", encoding="utf-8") as f:
        f.write(f"inhalt {name}")


def keys_in(bucket):
    return {k for b, k in S3.objects if b == bucket}


# ── A legacy single-bucket installation, as it exists on the Pi today ────────
print("--- Migration einer Alt-Installation ---")
os.makedirs(state.DATA_DIR, exist_ok=True)
legacy = sqlite3.connect(state.DB_FILE)
with open(state.SCHEMA_FILE, encoding="utf-8") as f:
    legacy.executescript(f.read())
for key, value in [("nas_root", NAS), ("s3_bucket", "schweden-bucket"),
                   ("aws_region", "eu-north-1"), ("s3_prefix", "nas-backup"),
                   ("storage_class", "STANDARD_IA"), ("key_file", __file__), ("enabled", "1")]:
    legacy.execute("INSERT INTO config (key, value) VALUES (?, ?)", (key, value))
legacy.execute("INSERT INTO folder_rule (path, mode) VALUES ('Daten', 'include')")
# Two files already backed up, keys carrying the prefix, exactly like the old schema.
for rel, name in [("Daten/a.txt", "a.txt"), ("Daten/b.txt", "b.txt")]:
    st = os.stat(os.path.join(NAS, rel))
    legacy.execute(
        "INSERT INTO backup_object (rel_path, s3_key, size, mtime_ns, encrypted, "
        "uploaded_at, last_seen_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
        (rel, f"nas-backup/{rel}.enc", st.st_size, st.st_mtime_ns,
         "2026-01-01T00:00:00+00:00", "alt"))
    S3.objects[("schweden-bucket", f"nas-backup/{rel}.enc")] = b"PNB1 alt"
legacy.commit()
legacy.close()

state.init_db()
db = state.connect()
targets = state.get_targets(db)
check("migration creates one target", len(targets) == 1, str(targets))
check("target keeps bucket", targets[0]["bucket"] == "schweden-bucket")
check("target keeps region", targets[0]["region"] == "eu-north-1")
check("target keeps prefix", targets[0]["prefix"] == "nas-backup")
rows = db.execute("SELECT * FROM object_target").fetchall()
check("object_target backfilled", len(rows) == 2, str(len(rows)))
check("full key preserved per target",
      {r["s3_key"] for r in rows} == {"nas-backup/Daten/a.txt.enc", "nas-backup/Daten/b.txt.enc"})
check("object key stripped of prefix",
      {r["rel_path"]: r["s3_key"] for r in db.execute("SELECT rel_path, s3_key FROM backup_object")}
      == {"Daten/a.txt": "Daten/a.txt.enc", "Daten/b.txt": "Daten/b.txt.enc"})
db.close()

# The decisive check: after the update the next run must not re-upload anything.
before = dict(S3.objects)
rc = backup_job.run(trigger="cron")
check("first run after migration succeeds", rc == 0)
check("nothing re-uploaded after migration", S3.objects == before)
db = state.connect()
run = db.execute("SELECT * FROM backup_run ORDER BY id DESC LIMIT 1").fetchone()
check("run uploaded zero files", run["files_uploaded"] == 0, str(run["files_uploaded"]))
check("run set no markers", run["files_marked"] == 0, str(run["files_marked"]))
db.close()

# Running init again must not migrate a second time.
state.init_db()
db = state.connect()
check("migration is idempotent", len(state.get_targets(db)) == 1)
db.close()

# ── Adding Spain ─────────────────────────────────────────────────────────────
print("\n--- Zweites Ziel (Spanien) ---")
db = state.connect()
spain = state.create_target(db, {"name": "Spanien", "region": "eu-south-2",
                                 "bucket": "spanien-bucket", "prefix": "nas-backup"})
db.close()

rc = backup_job.run(trigger="manual")
check("run with two targets succeeds", rc == 0)
check("Sweden untouched", keys_in("schweden-bucket") ==
      {"nas-backup/Daten/a.txt.enc", "nas-backup/Daten/b.txt.enc"})
check("Spain received both files", keys_in("spanien-bucket") ==
      {"nas-backup/Daten/a.txt.enc", "nas-backup/Daten/b.txt.enc"})
check("Sweden objects unchanged",
      S3.objects[("schweden-bucket", "nas-backup/Daten/a.txt.enc")] == b"PNB1 alt")

db = state.connect()
cov = state.target_coverage(db)
check("Sweden fully covered", cov[1]["current"] == 2 and cov[1]["missing"] == 0, str(cov[1]))
check("Spain fully covered", cov[spain["id"]]["current"] == 2, str(cov[spain["id"]]))
run = db.execute("SELECT * FROM backup_run ORDER BY id DESC LIMIT 1").fetchone()
check("only the new target counted as upload", run["files_uploaded"] == 2, str(run["files_uploaded"]))
db.close()

# A further run has nothing left to do on either target.
before = dict(S3.objects)
backup_job.run(trigger="cron")
check("steady state uploads nothing", S3.objects == before)

# ── One region unreachable ───────────────────────────────────────────────────
print("\n--- Spanien nicht erreichbar ---")
with open(os.path.join(NAS, "Daten", "c.txt"), "w", encoding="utf-8") as f:
    f.write("neue datei")
S3.fail_buckets.add("spanien-bucket")
rc = backup_job.run(trigger="cron")
check("run reports failure", rc == 1)
check("Sweden got the new file", ("schweden-bucket", "nas-backup/Daten/c.txt.enc") in S3.objects)
check("Spain did not", ("spanien-bucket", "nas-backup/Daten/c.txt.enc") not in S3.objects)

db = state.connect()
cov = state.target_coverage(db)
check("Sweden covers 3", cov[1]["current"] == 3, str(cov[1]))
check("Spain covers 2, one missing",
      cov[spain["id"]]["current"] == 2 and cov[spain["id"]]["missing"] == 1, str(cov[spain["id"]]))
db.close()

# Recovery: only the file Spain lacks is sent, Sweden is not touched again.
S3.fail_buckets.clear()
before_sweden = dict(S3.objects)
rc = backup_job.run(trigger="cron")
check("retry run succeeds", rc == 0)
check("Spain caught up", ("spanien-bucket", "nas-backup/Daten/c.txt.enc") in S3.objects)
check("Sweden not re-uploaded",
      {k: v for k, v in S3.objects.items() if k[0] == "schweden-bucket"} ==
      {k: v for k, v in before_sweden.items() if k[0] == "schweden-bucket"})
db = state.connect()
run = db.execute("SELECT * FROM backup_run ORDER BY id DESC LIMIT 1").fetchone()
check("retry uploaded exactly one file", run["files_uploaded"] == 1, str(run["files_uploaded"]))
db.close()

# ── Deletion is carried out in both buckets ─────────────────────────────────
print("\n--- Löschung über beide Ziele ---")
os.unlink(os.path.join(NAS, "Daten", "c.txt"))
backup_job.run(trigger="cron")
db = state.connect()
marked = db.execute(
    "SELECT rel_path FROM backup_object WHERE deleted_at IS NOT NULL").fetchall()
check("deleted file marked once", [r["rel_path"] for r in marked] == ["Daten/c.txt"])
check("still in both buckets while marked",
      ("schweden-bucket", "nas-backup/Daten/c.txt.enc") in S3.objects
      and ("spanien-bucket", "nas-backup/Daten/c.txt.enc") in S3.objects)

old = (datetime.now(timezone.utc) - timedelta(days=31)).isoformat(timespec="seconds")
db.execute("UPDATE backup_object SET deleted_at = ? WHERE deleted_at IS NOT NULL", (old,))
db.commit()
db.close()

# Spain unreachable during the purge: the index row has to survive for a retry.
S3.fail_buckets.add("spanien-bucket")
backup_job.run(trigger="cron")
check("purged from Sweden", ("schweden-bucket", "nas-backup/Daten/c.txt.enc") not in S3.objects)
check("still in Spain", ("spanien-bucket", "nas-backup/Daten/c.txt.enc") in S3.objects)
db = state.connect()
check("index row kept for the failed target",
      db.execute("SELECT COUNT(*) c FROM backup_object WHERE rel_path = 'Daten/c.txt'"
                 ).fetchone()["c"] == 1)
db.close()

S3.fail_buckets.clear()
backup_job.run(trigger="cron")
check("purged from Spain on retry",
      ("spanien-bucket", "nas-backup/Daten/c.txt.enc") not in S3.objects)
db = state.connect()
check("index row finally removed",
      db.execute("SELECT COUNT(*) c FROM backup_object WHERE rel_path = 'Daten/c.txt'"
                 ).fetchone()["c"] == 0)
check("no orphaned object_target rows",
      db.execute("SELECT COUNT(*) c FROM object_target ot "
                 "LEFT JOIN backup_object o ON o.id = ot.object_id "
                 "WHERE o.id IS NULL").fetchone()["c"] == 0)
db.close()

# ── Disabled target stops receiving uploads ──────────────────────────────────
print("\n--- Ziel deaktivieren ---")
db = state.connect()
state.update_target(db, spain["id"], {"enabled": False})
db.close()
with open(os.path.join(NAS, "Daten", "d.txt"), "w", encoding="utf-8") as f:
    f.write("nur schweden")
rc = backup_job.run(trigger="cron")
check("run with a disabled target succeeds", rc == 0)
check("Sweden got it", ("schweden-bucket", "nas-backup/Daten/d.txt.enc") in S3.objects)
check("disabled Spain skipped", ("spanien-bucket", "nas-backup/Daten/d.txt.enc") not in S3.objects)

# ── Restore picks a target ───────────────────────────────────────────────────
print("\n--- Restore-Zielwahl ---")
db = state.connect()
check("restore defaults to the enabled target",
      restore_mod.pick_target(db, "")["bucket"] == "schweden-bucket")
check("restore honours a name", restore_mod.pick_target(db, "Spanien")["id"] == spain["id"])
check("restore honours an id", restore_mod.pick_target(db, str(spain["id"]))["name"] == "Spanien")
try:
    restore_mod.pick_target(db, "Portugal")
    check("unknown target rejected", False)
except backup_job.JobError:
    check("unknown target rejected", True)
listed = restore_mod.objects_from_index(db, {"id": spain["id"]}, "", False)
check("restore lists only what Spain holds",
      {o["rel_path"] for o in listed} == {"Daten/a.txt", "Daten/b.txt"}, str(listed))
db.close()

# ── Removing a target ────────────────────────────────────────────────────────
print("\n--- Ziel entfernen ---")
db = state.connect()
state.delete_target(db, spain["id"])
check("target gone", len(state.get_targets(db)) == 1)
check("its tracking rows gone",
      db.execute("SELECT COUNT(*) c FROM object_target WHERE target_id = ?",
                 (spain["id"],)).fetchone()["c"] == 0)
db.close()
check("objects left in the removed bucket", len(keys_in("spanien-bucket")) == 2)

shutil.rmtree(WORK, ignore_errors=True)
print()
print(f"{len(failures)} Fehler: {failures}" if failures else "Alle Tests bestanden.")
sys.exit(1 if failures else 0)
