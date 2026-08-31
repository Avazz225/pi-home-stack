"""Exercises the Flask API against a temporary NAS tree and database."""

import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import state  # noqa: E402

WORK = tempfile.mkdtemp(prefix="pinas-api-")
state.DATA_DIR = os.path.join(WORK, "data")
state.DB_FILE = os.path.join(state.DATA_DIR, "backup.db")

import app as api  # noqa: E402

failures = []


def check(name, condition, detail=""):
    print(("PASS  " if condition else "FAIL  ") + name + (f"  ({detail})" if not condition else ""))
    if not condition:
        failures.append(name)


NAS = os.path.join(WORK, "nas")
for folder in ["Fotos/2024/Urlaub", "Fotos/RAW", "Dokumente", "Musik"]:
    os.makedirs(os.path.join(NAS, folder), exist_ok=True)
for f in ["Fotos/a.jpg", "Fotos/2024/b.jpg", "Dokumente/x.pdf"]:
    open(os.path.join(NAS, f), "w").write("x")
os.symlink("/etc", os.path.join(NAS, "linkfalle"))

state.init_db()
db = state.connect()
state.set_config(db, {"nas_root": NAS})
db.close()

client = api.app.test_client()

# ── Health and config ────────────────────────────────────────────────────────
check("health ok", client.get("/health").get_json()["status"] == "ok")

cfg = client.get("/config").get_json()
check("config returns defaults", cfg["retention_days"] == "30")
check("secret empty initially", cfg["aws_secret_access_key"] == "")
check("secret flag false", cfg["aws_secret_access_key_set"] is False)
check("crypto salt hidden", "crypto_salt" not in cfg)
check("problems reported", any("Ziel" in p for p in cfg["problems"]), str(cfg["problems"]))
check("legacy bucket keys not exposed", "s3_bucket" not in cfg and "aws_region" not in cfg)

saved = client.put("/config", json={"nas_root": NAS,
                                    "aws_secret_access_key": "supergeheim"}).get_json()
check("secret is masked after save", saved["aws_secret_access_key"] == state.SECRET_MASK)
check("secret flag true", saved["aws_secret_access_key_set"] is True)
check("legacy keys not writable",
      client.put("/config", json={"s3_bucket": "x"}).status_code == 200)

# Saving again with the mask must not wipe the stored secret.
client.put("/config", json={"aws_secret_access_key": state.SECRET_MASK, "retention_days": "45"})
db = state.connect()
check("secret survives masked save",
      state.get_config(db)["aws_secret_access_key"] == "supergeheim")
check("crypto salt not writable via API",
      client.put("/config", json={"crypto_salt": "boese"}).status_code == 200
      and state.get_config(db)["crypto_salt"] == "")
check("legacy bucket key not writable", state.get_config(db)["s3_bucket"] == "")
db.close()

# ── Targets ──────────────────────────────────────────────────────────────────
check("no targets initially", client.get("/targets").get_json() == [])

created = client.post("/targets", json={"name": "Schweden", "region": "eu-north-1",
                                        "bucket": "se-bucket", "prefix": "/nas-backup/"})
check("target created", created.status_code == 201)
targets = created.get_json()
check("one target listed", len(targets) == 1)
check("prefix normalized", targets[0]["prefix"] == "nas-backup")
check("target enabled by default", targets[0]["enabled"] is True)
check("coverage reported", targets[0]["coverage"]["missing"] == 0, str(targets[0]["coverage"]))
se_id = targets[0]["id"]

targets = client.post("/targets", json={"name": "Spanien", "region": "eu-south-2",
                                        "bucket": "es-bucket", "prefix": "nas-backup"}).get_json()
check("two targets listed", len(targets) == 2)
es_id = [t for t in targets if t["name"] == "Spanien"][0]["id"]

check("duplicate bucket+prefix rejected",
      client.post("/targets", json={"name": "Nochmal", "region": "eu-north-1",
                                    "bucket": "se-bucket", "prefix": "nas-backup"}).status_code == 409)
check("missing bucket rejected",
      client.post("/targets", json={"name": "Leer", "region": "eu-north-1"}).status_code == 400)
check("unknown target update 404",
      client.put("/targets/9999", json={"name": "x"}).status_code == 404)

updated = client.put(f"/targets/{es_id}", json={"enabled": False,
                                                "storage_class": "DEEP_ARCHIVE"}).get_json()
spain = [t for t in updated if t["id"] == es_id][0]
check("target disabled", spain["enabled"] is False)
check("storage class stored", spain["storage_class"] == "DEEP_ARCHIVE")
check("other target untouched",
      [t for t in updated if t["id"] == se_id][0]["enabled"] is True)

# ── Tree ─────────────────────────────────────────────────────────────────────
root = client.get("/tree").get_json()
names = [e["name"] for e in root["entries"]]
check("root lists folders", names == ["Dokumente", "Fotos", "Musik"], str(names))
check("symlink not listed", "linkfalle" not in names)
check("root file count", root["fileCount"] == 0)
check("root effective is exclude", root["effective"] == "exclude")
check("hasChildren true for Fotos",
      next(e for e in root["entries"] if e["name"] == "Fotos")["hasChildren"] is True)
check("hasChildren false for Musik",
      next(e for e in root["entries"] if e["name"] == "Musik")["hasChildren"] is False)

sub = client.get("/tree?path=Fotos").get_json()
check("subfolder listing", [e["name"] for e in sub["entries"]] == ["2024", "RAW"])
check("subfolder file count", sub["fileCount"] == 1)

check("traversal rejected", client.get("/tree?path=../etc").status_code == 400)
check("missing folder 404", client.get("/tree?path=GibtEsNicht").status_code == 404)

# ── Rules ────────────────────────────────────────────────────────────────────
r = client.put("/rules", json={"path": "Fotos", "mode": "include"}).get_json()
check("rule stored", r["rule"] == "include" and r["effective"] == "include")
client.put("/rules", json={"path": "Fotos/RAW", "mode": "exclude"})

tree = client.get("/tree?path=Fotos").get_json()
by_name = {e["name"]: e for e in tree["entries"]}
check("child inherits include", by_name["2024"]["effective"] == "include")
check("child has no explicit rule", by_name["2024"]["rule"] is None)
check("explicit exclude visible", by_name["RAW"]["rule"] == "exclude")
check("explicit exclude effective", by_name["RAW"]["effective"] == "exclude")

rules = client.get("/rules").get_json()
check("rules listed", len(rules) == 2, str(rules))
check("bad mode rejected",
      client.put("/rules", json={"path": "Fotos", "mode": "vielleicht"}).status_code == 400)
check("rule traversal rejected",
      client.put("/rules", json={"path": "../x", "mode": "include"}).status_code == 400)

inherit = client.put("/rules", json={"path": "Fotos/RAW", "mode": "inherit"}).get_json()
check("inherit clears rule", inherit["rule"] is None and inherit["effective"] == "include")
check("delete endpoint clears rule",
      client.delete("/rules?path=Fotos").status_code == 200
      and len(client.get("/rules").get_json()) == 0)

# ── Status and runs ──────────────────────────────────────────────────────────
client.put("/rules", json={"path": "Dokumente", "mode": "include"})
st = client.get("/status").get_json()
check("status counts folders", st["includedFolders"] == 1)
check("status lists targets", len(st["targets"]) == 2)
check("status counts active targets", st["activeTargets"] == 1, str(st["activeTargets"]))
check("status live objects zero", st["liveObjects"] == 0)
check("status disabled", st["enabled"] is False)
check("status has no last run", st["lastRun"] is None)

check("runs list empty", client.get("/runs").get_json() == [])
check("unknown run 404", client.get("/runs/999").status_code == 404)

# A run already in progress must block a second trigger.
db = state.connect()
db.execute("INSERT INTO backup_run (started_at, status, trigger) VALUES (?, 'running', 'cron')",
           (state.now_iso(),))
db.commit()
db.close()
check("concurrent run blocked", client.post("/runs", json={}).status_code == 409)
st = client.get("/status").get_json()
check("status shows running run", st["runningRun"] is not None)

# ── Objects ──────────────────────────────────────────────────────────────────
db = state.connect()
db.execute("INSERT INTO backup_object (rel_path, s3_key, size, mtime_ns, uploaded_at) "
           "VALUES ('Dokumente/x.pdf', 'k1', 100, 1, ?)", (state.now_iso(),))
db.execute("INSERT INTO backup_object (rel_path, s3_key, size, mtime_ns, uploaded_at, deleted_at) "
           "VALUES ('Dokumente/alt.pdf', 'k2', 50, 1, ?, ?)", (state.now_iso(), state.now_iso()))
db.commit()
db.close()

missing = client.get(f"/objects?state=missing&target={se_id}").get_json()
check("missing lists what a target lacks",
      {o["rel_path"] for o in missing} == {"Dokumente/x.pdf"}, str(missing))
check("missing needs a target", client.get("/objects?state=missing").status_code == 400)

live = client.get("/objects?state=live").get_json()
deleted = client.get("/objects?state=deleted").get_json()
check("live objects", [o["rel_path"] for o in live] == ["Dokumente/x.pdf"])
check("deleted objects", [o["rel_path"] for o in deleted] == ["Dokumente/alt.pdf"])
check("path filter", len(client.get("/objects?path=Dokumente&state=live").get_json()) == 1)
check("path filter misses", client.get("/objects?path=Fotos&state=live").get_json() == [])

st = client.get("/status").get_json()
check("status counts live bytes", st["liveBytes"] == 100)
check("status counts markers", st["markedObjects"] == 1)
check("nothing fully replicated yet", st["fullyReplicated"] == 0, str(st["fullyReplicated"]))

check("target deletable", client.delete(f"/targets/{es_id}").status_code == 200)
check("one target left", len(client.get("/targets").get_json()) == 1)
check("deleting an unknown target 404", client.delete("/targets/9999").status_code == 404)

shutil.rmtree(WORK, ignore_errors=True)
print()
print(f"{len(failures)} Fehler: {failures}" if failures else "Alle Tests bestanden.")
sys.exit(1 if failures else 0)
