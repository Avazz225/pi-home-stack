"""Smart sockets: the client, and turning a lifetime counter into a day's use.

The interesting cases are all about the counter. A plug reports how much it has
passed since it was made, so everything shown is a difference between two
readings - and a difference is wrong in a different way for every thing that
can go wrong with the pair.
"""

import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
HOME = os.path.join(HERE, "..", "apps", "home")
sys.path.insert(0, HOME)

failed = 0


def check(label, got, want):
    global failed
    if got == want:
        print(f"PASS  {label}")
    else:
        print(f"FAIL  {label}\n        expected: {want!r}\n        got:      {got!r}")
        failed = 1


def near(label, got, want, tolerance=0.01):
    global failed
    if got is not None and abs(got - want) <= tolerance:
        print(f"PASS  {label}")
    else:
        print(f"FAIL  {label}\n        expected: {want} ± {tolerance}\n        got:      {got!r}")
        failed = 1


def ok(label, condition, detail=""):
    check(label, bool(condition) or detail, True)


def load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HOME, f"{name}.py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


plug_api = load("plugs")
energy = load("energy")

# ── The two generations, normalised to one shape ─────────────────────────────
#
# A gen 1 plug counts watt-minutes and a gen 2 plug counts watt-hours. Mixing
# the two silently would be a factor of sixty in somebody's electricity bill,
# so the conversion is pinned here.


class FakeResponse:
    def __init__(self, payload, status=200):
        self.payload = payload
        self.status_code = status

    def json(self):
        return self.payload


class FakeHttp:
    """Stands in for requests, and remembers what was asked for."""

    def __init__(self, gets=None, posts=None):
        self.gets = gets or {}
        self.posts = posts or {}
        self.calls = []

    def get(self, url, params=None, auth=None, timeout=None):
        self.calls.append(("GET", url, params))
        path = url.split(self_host(url), 1)[-1]
        return FakeResponse(self.gets.get(path, {}))

    def post(self, url, json=None, auth=None, timeout=None):
        self.calls.append(("POST", url, json))
        return FakeResponse({"result": self.posts.get((json or {}).get("method"), {})})


def self_host(url):
    return url.split("//", 1)[-1].split("/", 1)[0]


def with_http(http):
    plug_api.requests = http
    return http


GEN2_STATUS = {
    "id": 0, "output": True, "apower": 86.4, "voltage": 231.2, "current": 0.39,
    "aenergy": {"total": 12345.6}, "temperature": {"tC": 41.2},
}

http = with_http(FakeHttp(posts={"Switch.GetStatus": GEN2_STATUS}))
gen2 = plug_api.Plug("192.0.2.10", gen=3)
status = gen2.status()
check("a gen 2 socket reports its switch", status["on"], True)
near("and what it is drawing", status["power_w"], 86.4)
near("its counter is already watt-hours", status["energy_wh"], 12345.6)
near("and it reports its own temperature", status["temperature_c"], 41.2)

GEN1_STATUS = {
    "relays": [{"ison": False, "timer_remaining": 0}],
    # Gen 1 counts watt-minutes: 60 of them are one watt-hour.
    "meters": [{"power": 0.0, "total": 740_400}],
    "temperature": 38.5,
}

http = with_http(FakeHttp(gets={"/status": GEN1_STATUS}))
gen1 = plug_api.Plug("192.0.2.11", gen=1)
status = gen1.status()
check("a gen 1 socket reports its switch", status["on"], False)
near("and its watt-minutes become watt-hours", status["energy_wh"], 12340.0)

# ── Which generation it is, asked rather than configured ────────────────────

http = with_http(FakeHttp(gets={"/shelly": {"gen": 3, "model": "S3PL-00112EU",
                                            "mac": "a0b1c2d3e4f5", "name": "Medienwand"}}))
found = plug_api.Plug("192.0.2.12").identify()
check("the generation comes from the device", found["gen"], 3)
check("and the address is carried through", found["address"], "192.0.2.12")
check("the mac is upper case, as everything else here keys on", found["mac"], "A0B1C2D3E4F5")

http = with_http(FakeHttp(gets={"/shelly": {"type": "SHPLG-S", "mac": "aabbccddeeff"}}))
check("a device with no gen member is the first generation",
      plug_api.Plug("192.0.2.13").identify()["gen"], 1)

# ── Switching, and the countdown the socket keeps itself ────────────────────

http = with_http(FakeHttp(posts={"Switch.Set": {}}))
plug_api.Plug("192.0.2.10", gen=2).switch(True, after_s=1200)
method, url, body = http.calls[-1]
check("switching a gen 2 socket is one call", method, "POST")
check("with the countdown on the device, not here", body["params"]["toggle_after"], 1200)
check("and the state it should take now", body["params"]["on"], True)

http = with_http(FakeHttp(gets={"/relay/0": {}}))
plug_api.Plug("192.0.2.11", gen=1).switch(False, after_s=60)
method, url, params = http.calls[-1]
check("a gen 1 socket takes its timer as a parameter", params, {"turn": "off", "timer": 60})

try:
    plug_api.Plug("192.0.2.10", gen=2).switch(True, after_s=99999)
except plug_api.PlugError as error:
    ok("a countdown longer than a day is refused", "Countdown" in str(error), str(error))
else:
    check("a countdown longer than a day is refused", "accepted", "refused")

# A weekly timer is the one thing the older generation does differently enough
# that pretending would be worse than saying so.
try:
    plug_api.Plug("192.0.2.11", gen=1).schedules()
except plug_api.PlugError as error:
    ok("gen 1 says what it cannot do", "2. Generation" in str(error), str(error))
else:
    check("gen 1 says what it cannot do", "silent", "refused")

# The countdown left is worked out, not taken from the duration: reporting the
# whole countdown as its remainder is wrong from the second it starts.
import time as _time
now_s = int(_time.time())
near("a running countdown reports what is left",
     plug_api._countdown_left({"timer_started_at": now_s - 300, "timer_duration": 1200}),
     900, tolerance=2)
check("one that has run out reports nothing",
      plug_api._countdown_left({"timer_started_at": now_s - 1300, "timer_duration": 1200}), None)
check("and a socket with no timer reports nothing",
      plug_api._countdown_left({"output": True}), None)

# ── What a step between two counters is allowed to be ───────────────────────

ok("an ordinary five minutes is plausible", energy.plausible_step(7.0, 300))
# A German socket is fused at 16 A, so 3.7 kW is the ceiling.
ok("the whole fuse for five minutes is still plausible",
   energy.plausible_step(energy.MAX_WATTS * 300 / 3600.0, 300))
ok("twice the fuse is not", not energy.plausible_step(energy.MAX_WATTS * 300 / 1800.0, 300))
# A counter that goes backwards is a factory reset or a swapped device, not
# negative consumption.
ok("a counter that goes backwards is not a step", not energy.plausible_step(-5.0, 300))
ok("nothing at all is not a step", not energy.plausible_step(None, 300))
ok("no energy in no time is fine", energy.plausible_step(0.0, 0))
ok("energy in no time is not", not energy.plausible_step(3.0, 0))


# ── Keeping the books ───────────────────────────────────────────────────────


class Clock:
    def __init__(self):
        self.moment = datetime(2026, 11, 20, 8, 0, tzinfo=timezone.utc)

    def __call__(self):
        return self.moment

    def advance(self, minutes):
        self.moment += timedelta(minutes=minutes)


class Socket:
    """A socket whose counter the test winds on."""

    def __init__(self):
        self.counter = 1000.0
        self.power = 60.0
        self.on = True
        self.error = None

    def status(self):
        if self.error:
            raise plug_api.PlugError(self.error)
        return {"on": self.on, "power_w": self.power, "energy_wh": self.counter,
                "voltage": 230, "current": None, "temperature_c": None,
                "countdown_s": None, "error": None}


class Flat:
    def __init__(self, sockets=1):
        handle, self.path = tempfile.mkstemp(suffix=".db")
        os.close(handle)
        connection = sqlite3.connect(self.path)
        with open(os.path.join(HOME, "schema.sql"), encoding="utf-8") as f:
            connection.executescript(f.read())
        for i in range(sockets):
            connection.execute("INSERT INTO plug (address, name) VALUES (?, ?)",
                               (f"192.0.2.{20 + i}", f"Dose {i + 1}"))
        connection.commit()
        connection.close()
        self.sockets = {i + 1: Socket() for i in range(sockets)}
        self.clock = Clock()
        energy.now = self.clock
        self.meter = energy.Meter(self.path, plug_for=lambda row: self.sockets[row["id"]])

    def tick(self, minutes=5):
        self.meter.tick()
        self.clock.advance(minutes)

    def query(self, sql, args=()):
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        rows = [dict(r) for r in connection.execute(sql, args).fetchall()]
        connection.close()
        return rows

    def today(self):
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        out = self.meter.today(connection)
        connection.close()
        return out

    def close(self):
        os.unlink(self.path)


# An hour at sixty watts is sixty watt-hours, however many readings it took.
flat = Flat()
flat.tick()
check("the first reading is a baseline, not a consumption", flat.today(), {})
for _ in range(12):
    flat.sockets[1].counter += 5.0
    flat.tick()
near("an hour of steps adds up to the hour", flat.today()[1], 60.0)
check("and it is one row for the day", len(flat.query("SELECT * FROM plug_day")), 1)
flat.close()

# A gap in the readings is covered by the next one: storing the counter rather
# than the difference is the whole reason this works.
flat = Flat()
flat.tick()
flat.sockets[1].counter += 40.0
flat.clock.advance(120)
flat.tick()
near("a two-hour gap is still counted once", flat.today()[1], 40.0)
flat.close()

# A factory reset, or a different plug at the same address.
flat = Flat()
flat.tick()
flat.sockets[1].counter += 20.0
flat.tick()
near("twenty before the reset", flat.today()[1], 20.0)
flat.sockets[1].counter = 3.0
flat.tick()
near("a counter that restarts adds nothing", flat.today()[1], 20.0)
flat.sockets[1].counter = 9.0
flat.tick()
near("and the new counter becomes the baseline", flat.today()[1], 26.0)
flat.close()

# A socket that cannot be reached is reported as such, and does not take the
# other one's reading with it.
flat = Flat(sockets=2)
flat.tick()
flat.sockets[1].error = "Steckdose 192.0.2.20 nicht erreichbar"
flat.sockets[2].counter += 10.0
flat.tick()
latest = flat.meter.latest()
ok("the unreachable socket carries its reason",
   "nicht erreichbar" in (latest[1].get("error") or ""), latest[1])
check("the other one still reported", latest[2]["error"], None)
near("and its energy was booked", flat.today()[2], 10.0)
flat.close()

# Midnight. A step is booked to the day of the reading that closed it, which
# puts at most one interval of consumption on the wrong side of the boundary -
# five minutes of a kettle, once a day. The alternative is splitting every
# step across two days by its duration, which is arithmetic nobody can check
# against a meter reading.
flat = Flat()
flat.clock.moment = datetime(2026, 11, 20, 23, 50, tzinfo=timezone.utc)
flat.tick()
flat.sockets[1].counter += 12.0
flat.tick()
flat.sockets[1].counter += 8.0
flat.tick()
days = {row["day"]: row["energy_wh"] for row in flat.query("SELECT * FROM plug_day")}
near("a step closed before midnight stays on that day", days["2026-11-20"], 12.0)
near("and one closed after it goes to the next", days["2026-11-21"], 8.0)
flat.close()

# Readings are thrown away after a week; the daily totals are not.
flat = Flat()
flat.tick()
flat.sockets[1].counter += 10.0
flat.tick()
flat.clock.advance(60 * 24 * (energy.KEEP_SAMPLES_DAYS + 1))
flat.tick()
ok("old readings are pruned",
   len(flat.query("SELECT * FROM plug_sample")) <= 2,
   len(flat.query("SELECT * FROM plug_sample")))
ok("the day's total survives them", len(flat.query("SELECT * FROM plug_day")) >= 1)
flat.close()

# ── Only the meter talks to a socket ────────────────────────────────────────
#
# The overview is polled every fifteen seconds. A socket read on that path
# would reintroduce the fan-out that produced Bad Gateways from the gateway,
# and an unreachable plug would hold the whole request while it timed out.

flat = Flat()
flat.tick()
flat.sockets[1].error = "weg"
before = dict(flat.meter.latest())
ok("the last reading is served from memory", before[1]["power_w"] == 60.0, before)
flat.close()

import re as _re

source = open(os.path.join(HOME, "app.py"), encoding="utf-8").read()
overview = _re.search(r"^def overview\(.*?(?=^@app\.route|^def )", source,
                      _re.S | _re.M).group(0)
ok("the overview reads what the meter last saw", "meter.latest()" in overview,
   overview[:120])
# Narrowly: a socket call, not any call. The vacuum bridge has a status() of
# its own on this path and is cached elsewhere.
reaches_a_plug = [name for name in ("plug_client(", "plug_api.Plug(", "plug_for(")
                  if name in overview]
check("and never asks a socket itself", reaches_a_plug, [])

print()
print("Alle Energie-Tests bestanden." if not failed else "Fehler aufgetreten.")
sys.exit(failed)
