"""Tests for the concurrency lock, stale-run cleanup and the unmounted-NAS guard."""

import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import state  # noqa: E402

WORK = tempfile.mkdtemp(prefix="pinas-guard-")
state.DATA_DIR = os.path.join(WORK, "data")
state.DB_FILE = os.path.join(state.DATA_DIR, "backup.db")

import backup_job  # noqa: E402

failures = []


def check(name, condition, detail=""):
    print(("PASS  " if condition else "FAIL  ") + name + (f"  ({detail})" if not condition else ""))
    if not condition:
        failures.append(name)


class FakeS3:
    def __init__(self):
        self.objects = {}

    def upload_file(self, path, bucket, key, ExtraArgs=None):
        with open(path, "rb") as f:
            self.objects[key] = f.read()

    def delete_objects(self, Bucket, Delete):
        for i in Delete["Objects"]:
            self.objects.pop(i["Key"], None)
        return {}

    def head_bucket(self, Bucket):
        return {}


S3 = FakeS3()
backup_job.load_backup_passphrase = lambda cfg: "key"
backup_job.S3Clients.for_region = lambda self, region: S3
backup_job.S3Clients._client = lambda self, *a, **k: S3
backup_job.S3Clients.for_target = lambda self, target: S3

NAS = os.path.join(WORK, "nas")
os.makedirs(os.path.join(NAS, "Daten"))
open(os.path.join(NAS, "Daten", "a.txt"), "w").write("inhalt")

state.init_db()
db = state.connect()
state.set_config(db, {"nas_root": NAS, "key_file": __file__, "enabled": "1"})
state.create_target(db, {"name": "Ziel", "region": "eu-central-1", "bucket": "b"})
state.set_rule(db, "Daten", "include")
db.close()

check("first run works", backup_job.run(trigger="manual") == 0)
check("file uploaded", len(S3.objects) == 1)

# ── Concurrency lock ─────────────────────────────────────────────────────────
with backup_job.job_lock():
    rc = backup_job.run(trigger="cron")
check("second run blocked by lock", rc == 1)
db = state.connect()
runs = db.execute("SELECT COUNT(*) c FROM backup_run").fetchone()["c"]
check("blocked run creates no record", runs == 1, str(runs))
db.close()

# ── Stale run cleanup ────────────────────────────────────────────────────────
db = state.connect()
db.execute("INSERT INTO backup_run (started_at, status, trigger) VALUES (?, 'running', 'cron')",
           (state.now_iso(),))
db.commit()
db.close()
backup_job.run(trigger="manual")
db = state.connect()
stale = db.execute("SELECT COUNT(*) c FROM backup_run WHERE status = 'running'").fetchone()["c"]
check("stale running run closed", stale == 0, str(stale))
closed = db.execute("SELECT error FROM backup_run WHERE error LIKE '%abgebrochen%'").fetchone()
check("stale run marked abgebrochen", closed is not None)
db.close()

# ── Unmounted NAS guard ──────────────────────────────────────────────────────
# Empty the tree but keep the mount point: this is what an unmounted NAS looks like.
shutil.rmtree(os.path.join(NAS, "Daten"))
os.makedirs(os.path.join(NAS, "Daten"))
rc = backup_job.run(trigger="cron")
check("empty scan aborts", rc == 1)
db = state.connect()
last = db.execute("SELECT * FROM backup_run ORDER BY id DESC LIMIT 1").fetchone()
check("abort mentions the mount", "eingehängt" in (last["error"] or ""), last["error"])
check("no deletion markers set",
      db.execute("SELECT COUNT(*) c FROM backup_object WHERE deleted_at IS NOT NULL").fetchone()["c"] == 0)
check("object still in S3", len(S3.objects) == 1)
db.close()

# A genuine deletion (other files still present) must still set a marker.
open(os.path.join(NAS, "Daten", "b.txt"), "w").write("neu")
rc = backup_job.run(trigger="cron")
check("real deletion run succeeds", rc == 0)
db = state.connect()
marked = {r["rel_path"] for r in db.execute(
    "SELECT rel_path FROM backup_object WHERE deleted_at IS NOT NULL")}
check("deleted file marked", marked == {"Daten/a.txt"}, str(marked))
db.close()

shutil.rmtree(WORK, ignore_errors=True)
print()
print(f"{len(failures)} Fehler: {failures}" if failures else "Alle Tests bestanden.")
sys.exit(1 if failures else 0)
