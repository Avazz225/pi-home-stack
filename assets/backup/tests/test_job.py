"""End-to-end test of a backup run against an in-memory S3 stub."""

import os
import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import state  # noqa: E402

WORK = tempfile.mkdtemp(prefix="pinas-test-")
state.DATA_DIR = os.path.join(WORK, "data")
state.DB_FILE = os.path.join(state.DATA_DIR, "backup.db")

import backup_job  # noqa: E402
import filecrypt  # noqa: E402

failures = []


def check(name, condition, detail=""):
    print(("PASS  " if condition else "FAIL  ") + name + (f"  ({detail})" if detail and not condition else ""))
    if not condition:
        failures.append(name)


class FakeS3:
    """Minimal stand-in for the handful of boto3 calls the job makes."""

    def __init__(self):
        self.objects = {}

    def upload_file(self, path, bucket, key, ExtraArgs=None):  # noqa: N803 - boto3 signature
        with open(path, "rb") as f:
            self.objects[key] = f.read()

    def download_file(self, bucket, key, path):
        with open(path, "wb") as f:
            f.write(self.objects[key])

    def delete_objects(self, Bucket, Delete):  # noqa: N803 - boto3 signature
        for item in Delete["Objects"]:
            self.objects.pop(item["Key"], None)
        return {}

    def head_bucket(self, Bucket):  # noqa: N803 - boto3 signature
        return {}


S3 = FakeS3()
PASSPHRASE = "test-backup-key"
backup_job.load_backup_passphrase = lambda cfg: PASSPHRASE
# Every region resolves to the same stub; the bucket name in each call is what
# distinguishes the targets.
backup_job.S3Clients.for_region = lambda self, region: S3
backup_job.S3Clients._client = lambda self, *a, **k: S3
backup_job.S3Clients.for_target = lambda self, target: S3

# ── NAS fixture ──────────────────────────────────────────────────────────────
NAS = os.path.join(WORK, "nas")
for folder in ["Fotos/2024", "Fotos/RAW", "Fotos/RAW/Wichtig", "Musik", "Safe"]:
    os.makedirs(os.path.join(NAS, folder), exist_ok=True)


def write(rel, content):
    path = os.path.join(NAS, rel)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return path


write("Fotos/2024/urlaub.txt", "strandbild")
write("Fotos/RAW/gross.raw", "riesige rohdatei")
write("Fotos/RAW/Wichtig/keeper.txt", "unbedingt sichern")
write("Musik/song.mp3", "nicht sichern")
write("Safe/passwords.kdbx", "KDBX-BINAERINHALT")
write("Safe/notiz.txt", "geheime notiz")

# ── Config + selection ───────────────────────────────────────────────────────
state.init_db()
db = state.connect()
state.set_config(db, {
    "nas_root": NAS, "key_file": __file__,
    "retention_days": "30", "enabled": "1",
})
state.create_target(db, {"name": "Schweden", "region": "eu-north-1",
                         "bucket": "test-bucket", "prefix": "nas-backup"})
state.set_rule(db, "Fotos", "include")
state.set_rule(db, "Fotos/RAW", "exclude")
state.set_rule(db, "Fotos/RAW/Wichtig", "include")
state.set_rule(db, "Safe", "include")
db.close()

# ── Run 1: initial backup ────────────────────────────────────────────────────
print("\n--- Lauf 1: Erstsicherung ---")
rc = backup_job.run(trigger="manual", verbose=False)
check("run 1 succeeds", rc == 0)

keys = set(S3.objects)
check("selected file uploaded", "nas-backup/Fotos/2024/urlaub.txt.enc" in keys)
check("re-included subfolder uploaded", "nas-backup/Fotos/RAW/Wichtig/keeper.txt.enc" in keys)
check("excluded subfolder skipped", "nas-backup/Fotos/RAW/gross.raw.enc" not in keys)
check("unselected top folder skipped",
      not any(k.startswith("nas-backup/Musik") for k in keys))
check("kdbx uploaded unencrypted", "nas-backup/Safe/passwords.kdbx" in keys)
check("kdbx content is verbatim", S3.objects["nas-backup/Safe/passwords.kdbx"] == b"KDBX-BINAERINHALT")
check("normal file is encrypted",
      S3.objects["nas-backup/Safe/notiz.txt.enc"][:4] == b"PNB1")
check("plaintext not in object",
      b"geheime notiz" not in S3.objects["nas-backup/Safe/notiz.txt.enc"])
check("object count", len(keys) == 4, f"{sorted(keys)}")

db = state.connect()
run1 = db.execute("SELECT * FROM backup_run ORDER BY id DESC LIMIT 1").fetchone()
check("run 1 status ok", run1["status"] == "ok", run1["error"])
check("run 1 uploaded 4", run1["files_uploaded"] == 4, str(run1["files_uploaded"]))
check("run 1 marked none", run1["files_marked"] == 0)
db.close()

# ── Run 2: nothing changed ───────────────────────────────────────────────────
print("\n--- Lauf 2: keine Änderungen ---")
before = dict(S3.objects)
rc = backup_job.run(trigger="manual")
check("run 2 succeeds", rc == 0)
db = state.connect()
run2 = db.execute("SELECT * FROM backup_run ORDER BY id DESC LIMIT 1").fetchone()
check("run 2 uploads nothing", run2["files_uploaded"] == 0, str(run2["files_uploaded"]))
check("run 2 marks nothing", run2["files_marked"] == 0, str(run2["files_marked"]))
check("run 2 scanned all", run2["files_scanned"] == 4, str(run2["files_scanned"]))
check("objects untouched", S3.objects == before)
db.close()

# ── Run 3: modification, deletion, deselection ───────────────────────────────
print("\n--- Lauf 3: Änderung + Löschung + Abwahl ---")
write("Fotos/2024/urlaub.txt", "strandbild v2 deutlich laenger")
os.utime(os.path.join(NAS, "Fotos/2024/urlaub.txt"), (2_000_000_000, 2_000_000_000))
os.unlink(os.path.join(NAS, "Safe/notiz.txt"))
db = state.connect()
state.set_rule(db, "Fotos/RAW/Wichtig", "exclude")   # deselect the re-included folder
db.close()

old_blob = S3.objects["nas-backup/Fotos/2024/urlaub.txt.enc"]
rc = backup_job.run(trigger="manual")
check("run 3 succeeds", rc == 0)
db = state.connect()
run3 = db.execute("SELECT * FROM backup_run ORDER BY id DESC LIMIT 1").fetchone()
check("run 3 uploaded the changed file", run3["files_uploaded"] == 1, str(run3["files_uploaded"]))
check("changed object replaced", S3.objects["nas-backup/Fotos/2024/urlaub.txt.enc"] != old_blob)
check("run 3 set two markers", run3["files_marked"] == 2, str(run3["files_marked"]))

marked = {r["rel_path"] for r in db.execute(
    "SELECT rel_path FROM backup_object WHERE deleted_at IS NOT NULL")}
check("deleted file marked", "Safe/notiz.txt" in marked)
check("deselected file marked", "Fotos/RAW/Wichtig/keeper.txt" in marked)
check("marked objects still in S3", "nas-backup/Safe/notiz.txt.enc" in S3.objects)
db.close()

# ── Run 4: markers age out and are carried out ───────────────────────────────
print("\n--- Lauf 4: Löschmarker abgelaufen ---")
old_stamp = (datetime.now(timezone.utc) - timedelta(days=31)).isoformat(timespec="seconds")
db = state.connect()
db.execute("UPDATE backup_object SET deleted_at = ? WHERE deleted_at IS NOT NULL", (old_stamp,))
db.commit()
db.close()

rc = backup_job.run(trigger="cron")
check("run 4 succeeds", rc == 0)
check("expired object purged from S3", "nas-backup/Safe/notiz.txt.enc" not in S3.objects)
check("expired deselected object purged",
      "nas-backup/Fotos/RAW/Wichtig/keeper.txt.enc" not in S3.objects)
db = state.connect()
run4 = db.execute("SELECT * FROM backup_run ORDER BY id DESC LIMIT 1").fetchone()
check("run 4 purged two", run4["files_purged"] == 2, str(run4["files_purged"]))
check("purged rows gone from index",
      db.execute("SELECT COUNT(*) c FROM backup_object WHERE deleted_at IS NOT NULL").fetchone()["c"] == 0)
db.close()

# ── Run 5: a marked file comes back before expiry ────────────────────────────
print("\n--- Lauf 5: abgewählter Ordner wieder ausgewählt ---")
db = state.connect()
state.set_rule(db, "Fotos/RAW/Wichtig", "include")
db.close()
rc = backup_job.run(trigger="manual")
check("run 5 succeeds", rc == 0)
check("revived file re-uploaded", "nas-backup/Fotos/RAW/Wichtig/keeper.txt.enc" in S3.objects)

# ── Restore round-trip through the stub ──────────────────────────────────────
print("\n--- Restore ---")
dest = os.path.join(WORK, "restore")
blob = S3.objects["nas-backup/Fotos/2024/urlaub.txt.enc"]
tmp_enc = os.path.join(WORK, "one.enc")
with open(tmp_enc, "wb") as f:
    f.write(blob)
out = os.path.join(WORK, "one.txt")
filecrypt.decrypt_file(tmp_enc, out, PASSPHRASE)
with open(out, encoding="utf-8") as f:
    check("restored content matches", f.read() == "strandbild v2 deutlich laenger")

# ── Guard rails ──────────────────────────────────────────────────────────────
print("\n--- Schutzmechanismen ---")
db = state.connect()
state.set_config(db, {"enabled": "0"})
db.close()
rc = backup_job.run(trigger="cron")
check("disabled backup aborts", rc == 1)
db = state.connect()
last = db.execute("SELECT * FROM backup_run ORDER BY id DESC LIMIT 1").fetchone()
check("abort recorded as error", last["status"] == "error" and "deaktiviert" in (last["error"] or ""))
db.close()

db = state.connect()
state.set_config(db, {"enabled": "1"})
for path in list(state.get_rules(db)):
    state.clear_rule(db, path)
db.close()
rc = backup_job.run(trigger="cron")
check("empty selection aborts", rc == 1)
db = state.connect()
last = db.execute("SELECT * FROM backup_run ORDER BY id DESC LIMIT 1").fetchone()
check("empty selection does not purge", last["files_purged"] == 0)
check("no run left hanging",
      db.execute("SELECT COUNT(*) c FROM backup_run WHERE status = 'running'").fetchone()["c"] == 0)
db.close()

shutil.rmtree(WORK, ignore_errors=True)
print()
print(f"{len(failures)} Fehler: {failures}" if failures else "Alle Tests bestanden.")
sys.exit(1 if failures else 0)
