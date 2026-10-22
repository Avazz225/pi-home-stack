"""Notification rules: what fires, what stays quiet, and who hears it.

Run against made-up facts rather than a running flat. What is worth proving has
nothing to do with Hue or systemd: that a threshold fires on the right side of
itself, that "for three hours" is measured rather than guessed, that a rule
which has just spoken stays quiet, and that two people in one flat do not get
each other's messages.
"""

import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
NOTIFY = os.path.join(HERE, "..", "apps", "notify")
sys.path.insert(0, NOTIFY)

failed = 0


def check(label, got, want):
    global failed
    if got == want:
        print(f"PASS  {label}")
    else:
        print(f"FAIL  {label}\n        expected: {want!r}\n        got:      {got!r}")
        failed = 1


def ok(label, condition, detail=""):
    check(label, bool(condition) or detail, True)


def load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(NOTIFY, f"{name}.py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


work = tempfile.mkdtemp(prefix="phs-notify-")
os.environ["PHS_STATUS_FILE"] = os.path.join(work, "status.json")
os.environ["PHS_VERSION_FILE"] = os.path.join(work, "VERSION")

rules = load("rules")

# ── Comparing release tags ───────────────────────────────────────────────────

check("a plain tag", rules.version_tuple("1.2.0"), (1, 2, 0))
check("a v in front changes nothing", rules.version_tuple("v1.2.0"), (1, 2, 0))
check("a suffix is cut at the first non-digit", rules.version_tuple("v1.2.0-rc1"), (1, 2, 0))
check("the stray dot in v.1.1.0 is tolerated", rules.version_tuple("v.1.1.0"), (1, 1, 0))
ok("1.2.0 is newer than 1.1.1",
   rules.version_tuple("1.2.0") > rules.version_tuple("1.1.1"))
ok("1.10.0 is newer than 1.9.0, which a string compare would get wrong",
   rules.version_tuple("1.10.0") > rules.version_tuple("1.9.0"))
check("a tag with no numbers sorts before everything", rules.version_tuple("latest"), ())

# ── The facts a flat might present ───────────────────────────────────────────

HOME = {"rooms": [
    {"key": "wohnen", "name": "Wohnen",
     "lights": {"bound": 3, "on": 2},
     "climate": {"temperature": 26.5, "humidity": 71, "battery": 15}},
    {"key": "schlafen", "name": "Schlafen",
     "lights": {"bound": 1, "on": 0},
     "climate": {"temperature": 15.0, "humidity": 40, "battery": 90}},
]}
STATUS = {
    "units": [{"name": "pi-home-api-home.service", "state": "failed"},
              {"name": "pi-home-backup.service", "state": "active"},
              {"name": "pi-home-speedtest-measure.timer", "state": "inactive"}],
    "storage": {"path": "/media/raid", "total": 1000, "used": 940},
    "raid": [{"name": "md0", "healthy": False, "disks": "2/1", "state": "active"}],
    "backup": {"lastRun": {"status": "error", "started_at": "2026-10-20T01:00:00+00:00"}},
}
context = {"home": HOME, "status": STATUS}

# ── Thresholds ───────────────────────────────────────────────────────────────

hot = rules.check_temperature_above(context, {"value": 25}, {})
check("too warm fires for the warm room only", [e["key"] for e in hot], ["temperature.wohnen"])
ok("and says both numbers", "26.5" in hot[0]["body"] and "25" in hot[0]["body"], hot[0]["body"])

cold = rules.check_temperature_below(context, {"value": 16}, {})
check("too cold fires for the cold room only", [e["key"] for e in cold], ["temperature.schlafen"])

check("a threshold nothing crosses stays quiet",
      rules.check_temperature_above(context, {"value": 30}, {}), [])
check("a rule without a threshold does nothing at all",
      rules.check_temperature_above(context, {}, {}), [])

check("humidity, same shape",
      [e["key"] for e in rules.check_humidity_above(context, {"value": 65}, {})],
      ["humidity.wohnen"])

check("one room only, when one is named",
      [e["key"] for e in rules.check_temperature_above(
          context, {"value": 10, "room": "schlafen"}, {})],
      ["temperature.schlafen"])
check("a room that does not exist fires nothing",
      rules.check_temperature_above(context, {"value": 10, "room": "keller"}, {}), [])

check("a weak battery is noticed",
      [e["key"] for e in rules.check_battery_below(context, {"percent": 20}, {})],
      ["battery.wohnen"])

# ── Duration, which a snapshot cannot answer ─────────────────────────────────

check("lights on but not long enough stays quiet",
      rules.check_lights_on_for(context, {"minutes": 120}, {"room.wohnen.lights_on": 30}), [])
long_on = rules.check_lights_on_for(context, {"minutes": 120},
                                    {"room.wohnen.lights_on": 185})
check("and fires once it is", [e["key"] for e in long_on], ["lights.wohnen"])
ok("naming the hours", "3.1 h" in long_on[0]["body"], long_on[0]["body"])
check("a room whose lights are off never fires, however old the observation",
      rules.check_lights_on_for(context, {"minutes": 1},
                                {"room.schlafen.lights_on": 9999}), [])
check("without an observation nothing is claimed",
      rules.check_lights_on_for(context, {"minutes": 1}, {}), [])

# ── What the system says ─────────────────────────────────────────────────────

down = rules.check_service_down(context, {}, {})
check("a failed unit is an alert", [e["key"] for e in down], ["unit.pi-home-api-home.service"])
check("and it is an alert, not a warning", down[0]["level"], "alert")

check("a full disk fires", [e["key"] for e in rules.check_disk_above(context, {"percent": 90}, {})],
      ["disk"])
check("a disk below the mark does not",
      rules.check_disk_above(context, {"percent": 95}, {}), [])
check("a degraded array fires", [e["key"] for e in rules.check_raid_degraded(context, {}, {})],
      ["raid.md0"])
check("a failed backup fires", [e["key"] for e in rules.check_backup_failed(context, {}, {})],
      ["backup"])

check("nothing at all is reported when there are no facts",
      rules.check_service_down({}, {}, {}) + rules.check_disk_above({}, {}, {})
      + rules.check_raid_degraded({}, {}, {}) + rules.check_backup_failed({}, {}, {}), [])

# ── Upstream ─────────────────────────────────────────────────────────────────

check("a newer release is announced",
      [e["title"] for e in rules.check_upstream_release(
          {"upstream": {"tag": "v1.3.0", "local": "1.2.0", "url": "u"}}, {}, {})],
      ["Update verfügbar: v1.3.0"])
check("the one already running is not",
      rules.check_upstream_release({"upstream": {"tag": "v1.2.0", "local": "1.2.0"}}, {}, {}), [])
check("an older one is not either",
      rules.check_upstream_release({"upstream": {"tag": "v1.1.0", "local": "1.2.0"}}, {}, {}), [])
check("and without knowing what is installed, nothing is claimed",
      rules.check_upstream_release({"upstream": {"tag": "v9.9.9"}}, {}, {}), [])

check("every kind in the catalogue has a check",
      sorted(k for k, v in rules.KINDS.items() if not callable(v.get("check"))), [])
check("and a label and a source",
      sorted(k for k, v in rules.KINDS.items() if not v.get("label") or not v.get("needs")), [])

# ── The service: observations, cooldown, recipients ──────────────────────────

os.environ["PHS_NOTIFY_TICK"] = "3600"
app_module = load("app")
app_module.DB_FILE = os.path.join(work, "notify.db")
app_module.init_db()

sent_webhooks = []


class FakeResponse:
    ok = True
    status_code = 200


# Everything a channel sends goes through requests.request, so one stand-in
# catches all three kinds.
def fake_request(method, url, timeout=None, **kwargs):
    sent_webhooks.append({"url": url, "body": kwargs.get("json"), **kwargs})
    return FakeResponse()


app_module.requests.request = fake_request
app_module.gather = lambda needs: dict(context)

db = app_module.connect()

# The same state seen twice keeps its timestamp; a changed one restarts it.
app_module.record(db, "probe", "on")
first = db.execute("SELECT since FROM observation WHERE key = 'probe'").fetchone()["since"]
app_module.record(db, "probe", "on")
again = db.execute("SELECT since FROM observation WHERE key = 'probe'").fetchone()["since"]
check("an unchanged state keeps its start", again, first)
app_module.record(db, "probe", "off")
after = db.execute("SELECT since FROM observation WHERE key = 'probe'").fetchone()["since"]
ok("a changed state restarts it", after >= first)

db.execute("INSERT INTO rule (user_id, kind, name, params, cooldown_s) "
           "VALUES ('jan', 'temperature_above', 'Zu warm', ?, 3600)",
           (json.dumps({"value": 25}),))
db.execute("INSERT INTO rule (user_id, kind, name, params, cooldown_s) "
           "VALUES ('lisa', 'temperature_below', 'Zu kalt', ?, 3600)",
           (json.dumps({"value": 16}),))
db.commit()

check("one pass delivers one message per matching rule", app_module.evaluate(db), 2)
check("jan hears about his rule only",
      [r["title"] for r in db.execute(
          "SELECT title FROM notification WHERE user_id = 'jan'").fetchall()],
      ["Temperatur in Wohnen"])
check("and lisa about hers",
      [r["title"] for r in db.execute(
          "SELECT title FROM notification WHERE user_id = 'lisa'").fetchall()],
      ["Temperatur in Schlafen"])

check("a second pass right after says nothing", app_module.evaluate(db), 0)

# Cooldown expired: the same complaint is allowed again, because the thing
# complained about is still true.
db.execute("UPDATE rule SET last_fired_at = ?",
           ((datetime.now(timezone.utc) - timedelta(seconds=7200)).isoformat(timespec="seconds"),))
db.commit()
check("once the cooldown has passed it speaks again", app_module.evaluate(db), 2)

# A rule whose kind went away must not stop the rest.
db.execute("INSERT INTO rule (user_id, kind, params) VALUES ('jan', 'erfunden', '{}')")
db.execute("UPDATE rule SET last_fired_at = NULL")
db.commit()
check("an unknown kind is skipped, not fatal", app_module.evaluate(db), 2)

# ── Channels ─────────────────────────────────────────────────────────────────

db.execute("INSERT INTO channel (user_id, kind, config) VALUES ('jan', 'webhook', ?)",
           (json.dumps({"url": "http://ntfy.local/haus"}),))
db.execute("UPDATE rule SET last_fired_at = NULL")
db.commit()
sent_webhooks.clear()
app_module.evaluate(db)
check("jan's webhook was called once", len(sent_webhooks), 1)
check("with his message", sent_webhooks[0]["body"]["title"], "Temperatur in Wohnen")
check("and lisa's message did not go to it",
      [w["body"]["title"] for w in sent_webhooks], ["Temperatur in Wohnen"])

channel = db.execute("SELECT * FROM channel WHERE user_id = 'jan'").fetchone()
check("a channel without an address says so",
      app_module.send_to_channel(
          {"kind": "webhook", "config": "{}"}, {"title": "x"}), "Keine Adresse hinterlegt")

sent_webhooks.clear()
app_module.send_to_channel(channel, {"title": "T", "body": "B", "level": "warn",
                                     "link": "http://x"})
check("the default body carries title, message and level",
      sorted(sent_webhooks[0]["body"]), ["link", "message", "priority", "title"])

templated = dict(channel)
templated["config"] = json.dumps({"url": "http://x", "template":
                                  '{"text": "{{title}}: {{body}}", "tags": "{{level}}"}'})
sent_webhooks.clear()
check("a template is honoured", app_module.send_to_channel(
    templated, {"title": "T", "body": "B", "level": "warn"}), None)
check("and shapes the body", sent_webhooks[0]["body"], {"text": "T: B", "tags": "warn"})

broken = dict(channel)
broken["config"] = json.dumps({"url": "http://x", "template": "{kaputt"})
ok("a broken template is reported rather than sent",
   "JSON" in (app_module.send_to_channel(broken, {"title": "T"}) or ""))

# ── Push to a phone ──────────────────────────────────────────────────────────
#
# ntfy is addressed by its topic URL and takes the message as plain text with
# the extras in headers. That is its documented way and the one that works
# whether the server is ntfy.sh or one on this Pi; posting JSON would need the
# topic in the body and the root URL instead.

posts = sent_webhooks

ntfy = {"kind": "ntfy", "config": json.dumps(
    {"url": "https://ntfy.sh/mein-haus", "token": "tk_1", "tags": "house"})}
check("ntfy accepts the message", app_module.send_to_channel(
    ntfy, {"title": "Licht an", "body": "Seit 3.1 h", "level": "warn",
           "link": "http://pi/"}), None)
check("addressed at the topic", posts[-1]["url"], "https://ntfy.sh/mein-haus")
check("the body is the message, as bytes",
      posts[-1]["data"], "Seit 3.1 h".encode("utf-8"))
check("the title rides in a header", posts[-1]["headers"]["Title"], "Licht an")
check("a warning is priority 4", posts[-1]["headers"]["Priority"], "4")
check("the link becomes a tap target", posts[-1]["headers"]["Click"], "http://pi/")
check("the token is a bearer", posts[-1]["headers"]["Authorization"], "Bearer tk_1")

app_module.send_to_channel(ntfy, {"title": "Nur ein Titel", "level": "alert"})
check("a message without a body falls back to the title",
      posts[-1]["data"], "Nur ein Titel".encode("utf-8"))
# Only an alert may wake somebody at three in the morning.
check("an alert is the highest priority", posts[-1]["headers"]["Priority"], "5")
check("and plain information is the middle",
      (app_module.send_to_channel(ntfy, {"title": "x"}),
       posts[-1]["headers"]["Priority"])[1], "3")

check("ntfy without an address says so",
      app_module.send_to_channel({"kind": "ntfy", "config": "{}"}, {"title": "x"}),
      "Keine Adresse hinterlegt")

gotify = {"kind": "gotify", "config": json.dumps(
    {"url": "http://pi.local:8008", "token": "A_token"})}
check("gotify accepts it", app_module.send_to_channel(
    gotify, {"title": "T", "body": "B", "level": "alert"}), None)
check("posted to /message", posts[-1]["url"], "http://pi.local:8008/message")
check("with the token in its own header", posts[-1]["headers"]["X-Gotify-Key"], "A_token")
check("and a numeric priority", posts[-1]["json"]["priority"], 5)

app_module.send_to_channel({"kind": "gotify", "config": json.dumps(
    {"url": "http://pi.local:8008/message/", "token": "t"})}, {"title": "x"})
check("a url that already names /message is not doubled",
      posts[-1]["url"], "http://pi.local:8008/message")
check("gotify without a token says so",
      app_module.send_to_channel(
          {"kind": "gotify", "config": json.dumps({"url": "http://x"})}, {"title": "x"}),
      "Kein Token hinterlegt")

check("an unknown kind is named, not ignored",
      app_module.send_to_channel({"kind": "rauchzeichen", "config": "{}"}, {"title": "x"}),
      "Unbekannter Kanal: rauchzeichen")


class FailingResponse:
    ok = False
    status_code = 403
    text = "forbidden"


app_module.requests.request = lambda *a, **k: FailingResponse()
ok("a refusal carries its reason",
   "403" in (app_module.send_to_channel(ntfy, {"title": "x"}) or ""))

db.close()
print()
print("Alle Benachrichtigungs-Tests bestanden." if not failed else "Fehler aufgetreten.")
sys.exit(failed)
