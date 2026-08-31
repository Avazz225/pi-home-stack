"""Storage backends: a filesystem target end to end, plus the S3-compatible
endpoint plumbing."""

import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import state  # noqa: E402

WORK = tempfile.mkdtemp(prefix="pinas-backends-")
state.DATA_DIR = os.path.join(WORK, "data")
state.DB_FILE = os.path.join(state.DATA_DIR, "backup.db")

import backup_job  # noqa: E402
import filecrypt  # noqa: E402
import restore as restore_mod  # noqa: E402
from storage_targets import FsTarget, S3Target, TargetError, build_target  # noqa: E402

failures = []


def check(name, condition, detail=""):
    print(("PASS  " if condition else "FAIL  ") + name + (f"  ({detail})" if not condition else ""))
    if not condition:
        failures.append(name)


# ── FsTarget on its own ──────────────────────────────────────────────────────
print("--- Verzeichnis-Ziel ---")
BASE = os.path.join(WORK, "nfs")
os.makedirs(BASE)
fs = FsTarget({"name": "NFS", "bucket": BASE, "kind": "fs"})

source = os.path.join(WORK, "src.bin")
with open(source, "wb") as f:
    f.write(b"payload" * 100)

fs.upload(source, "nas-backup/Fotos/a.jpg.enc")
stored = os.path.join(BASE, "nas-backup/Fotos/a.jpg.enc")
check("file written", os.path.isfile(stored))
check("content matches", open(stored, "rb").read() == b"payload" * 100)
check("no leftover .part files",
      not any(n.endswith(".part") for _, _, fs_names in os.walk(BASE) for n in fs_names))
check("describe mentions the path", BASE in fs.describe())

back = os.path.join(WORK, "back.bin")
fs.download("nas-backup/Fotos/a.jpg.enc", back)
check("download matches", open(back, "rb").read() == b"payload" * 100)

check("list finds the key",
      list(fs.list_keys("nas-backup")) == ["nas-backup/Fotos/a.jpg.enc"])
check("list with empty prefix", list(fs.list_keys("")) == ["nas-backup/Fotos/a.jpg.enc"])

failed = fs.delete(["nas-backup/Fotos/a.jpg.enc"])
check("delete reports no failures", failed == set())
check("file gone", not os.path.exists(stored))
check("empty directories pruned", not os.path.exists(os.path.join(BASE, "nas-backup")))
check("base directory kept", os.path.isdir(BASE))
check("deleting a missing key is not an error", fs.delete(["gibt/es/nicht.enc"]) == set())

# Path traversal must never escape the base directory.
for evil in ["../outside.enc", "a/../../outside.enc", "/etc/passwd"]:
    try:
        fs.upload(source, evil)
        check(f"traversal blocked {evil!r}", False)
    except TargetError:
        check(f"traversal blocked {evil!r}", True)
check("nothing written outside the base",
      not os.path.exists(os.path.join(WORK, "outside.enc")))

# require_mount catches a share that did not come up.
unmounted = FsTarget({"name": "NFS", "bucket": BASE, "kind": "fs", "require_mount": 1})
try:
    unmounted.check()
    check("require_mount rejects a plain directory", False)
except TargetError as exc:
    check("require_mount rejects a plain directory", "Einhäng" in str(exc), str(exc))
check("check passes without require_mount", fs.check() is None)

missing = FsTarget({"name": "X", "bucket": os.path.join(WORK, "nope"), "kind": "fs"})
try:
    missing.check()
    check("missing directory rejected", False)
except TargetError:
    check("missing directory rejected", True)

# ── S3-compatible endpoints ──────────────────────────────────────────────────
print("\n--- S3-kompatible Endpunkte ---")


class RecordingClients:
    """Captures how the boto3 client would have been built."""

    def __init__(self):
        self.calls = []

    def for_target(self, target):
        self.calls.append(target)
        return self


recorder = RecordingClients()
minio = {"name": "MinIO", "kind": "s3", "bucket": "backup", "region": "us-east-1",
         "endpoint_url": "https://minio.lan:9000", "addressing": "path",
         "storage_class": "STANDARD"}
adapter = build_target(minio, recorder)
check("s3 kind builds an S3Target", isinstance(adapter, S3Target))
check("describe shows the endpoint", "minio.lan" in adapter.describe())


class CapturingS3:
    def __init__(self):
        self.extra = None

    def upload_file(self, path, bucket, key, ExtraArgs=None):  # noqa: N803
        self.extra = ExtraArgs


capture = CapturingS3()
adapter.client = capture
adapter.upload(source, "k")
check("no SSE header sent to a non-AWS endpoint",
      "ServerSideEncryption" not in (capture.extra or {}), str(capture.extra))
check("STANDARD storage class omitted", "StorageClass" not in (capture.extra or {}))

aws = dict(minio, endpoint_url="", storage_class="STANDARD_IA")
aws_adapter = build_target(aws, recorder)
aws_adapter.client = capture
aws_adapter.upload(source, "k")
check("SSE header sent to AWS", capture.extra.get("ServerSideEncryption") == "AES256")
check("storage class forwarded", capture.extra.get("StorageClass") == "STANDARD_IA")

try:
    build_target({"kind": "gopher", "bucket": "x"}, recorder)
    check("unknown kind rejected", False)
except TargetError:
    check("unknown kind rejected", True)

# ── Validation of the new fields ─────────────────────────────────────────────
print("\n--- Validierung ---")
state.init_db()
db = state.connect()
NAS = os.path.join(WORK, "nas")
os.makedirs(os.path.join(NAS, "Daten"))
for name in ("a.txt", "b.txt"):
    with open(os.path.join(NAS, "Daten", name), "w", encoding="utf-8") as f:
        f.write(f"inhalt {name}")

state.set_config(db, {"nas_root": NAS, "key_file": __file__, "enabled": "1"})
state.set_rule(db, "Daten", "include")

for bad, why in [
    ({"name": "X", "kind": "fs", "bucket": "relativ/pfad"}, "relative fs path"),
    ({"name": "X", "kind": "s3", "bucket": "b"}, "s3 without region"),
    ({"name": "", "kind": "fs", "bucket": "/tmp"}, "empty name"),
    ({"name": "X", "kind": "gopher", "bucket": "/tmp"}, "unknown kind"),
    ({"name": "X", "kind": "s3", "bucket": "b", "region": "r", "addressing": "weird"}, "bad addressing"),
]:
    try:
        state.create_target(db, bad)
        check(f"rejects {why}", False)
    except ValueError:
        check(f"rejects {why}", True)

TARGET_DIR = os.path.join(WORK, "usb")
os.makedirs(TARGET_DIR)
fs_target = state.create_target(db, {"name": "USB", "kind": "fs", "bucket": TARGET_DIR,
                                     "prefix": "nas-backup"})
check("fs target stored", fs_target["kind"] == "fs" and fs_target["bucket"] == TARGET_DIR)
check("fs target needs no region", fs_target["region"] == "")

updated = state.update_target(db, fs_target["id"], {"require_mount": True})
check("update keeps the kind", updated["kind"] == "fs")
check("update sets require_mount", updated["require_mount"] == 1)
state.update_target(db, fs_target["id"], {"require_mount": False})
db.close()

# ── A full run against a directory target ────────────────────────────────────
print("\n--- Kompletter Lauf auf ein Verzeichnis ---")
backup_job.load_backup_passphrase = lambda cfg: "testkey"

rc = backup_job.run(trigger="manual")
check("run to an fs target succeeds", rc == 0)
written = sorted(os.path.relpath(os.path.join(r, n), TARGET_DIR)
                 for r, _d, files in os.walk(TARGET_DIR) for n in files)
check("both files stored", written == ["nas-backup/Daten/a.txt.enc",
                                       "nas-backup/Daten/b.txt.enc"], str(written))
blob = open(os.path.join(TARGET_DIR, "nas-backup/Daten/a.txt.enc"), "rb").read()
check("stored file is encrypted", blob[:4] == b"PNB1")
check("plaintext absent", b"inhalt a.txt" not in blob)

before = written[:]
backup_job.run(trigger="cron")
again = sorted(os.path.relpath(os.path.join(r, n), TARGET_DIR)
               for r, _d, files in os.walk(TARGET_DIR) for n in files)
check("second run uploads nothing new", again == before)

# Restore straight from the directory, without the index.
db = state.connect()
target_row = state.get_targets(db)[0]
backend = build_target(target_row, backup_job.S3Clients(state.get_config(db)))
listed = restore_mod.objects_from_backend(backend, target_row, "")
check("listing from the target finds both",
      {o["rel_path"] for o in listed} == {"Daten/a.txt", "Daten/b.txt"}, str(listed))
db.close()

out = os.path.join(WORK, "restored.txt")
backend.download("nas-backup/Daten/a.txt.enc", os.path.join(WORK, "enc.bin"))
filecrypt.decrypt_file(os.path.join(WORK, "enc.bin"), out, "testkey")
check("restored content matches", open(out, encoding="utf-8").read() == "inhalt a.txt")

# Deletion propagates to the directory target too.
os.unlink(os.path.join(NAS, "Daten", "b.txt"))
backup_job.run(trigger="cron")
db = state.connect()
db.execute("UPDATE backup_object SET deleted_at = '2000-01-01T00:00:00+00:00' "
           "WHERE deleted_at IS NOT NULL")
db.commit()
db.close()
backup_job.run(trigger="cron")
check("expired object removed from the directory",
      not os.path.exists(os.path.join(TARGET_DIR, "nas-backup/Daten/b.txt.enc")))
check("surviving object untouched",
      os.path.exists(os.path.join(TARGET_DIR, "nas-backup/Daten/a.txt.enc")))

shutil.rmtree(WORK, ignore_errors=True)
print()
print(f"{len(failures)} Fehler: {failures}" if failures else "Alle Tests bestanden.")
sys.exit(1 if failures else 0)
