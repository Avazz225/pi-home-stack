"""Shelly switches with a power meter in them, each at its own address.

Different in shape from everything else in this service. A BLU valve is one of
several behind one gateway, and a Hue lamp is one of several behind one bridge;
a Shelly plug is its own device on the network with its own IP, so there is no
one place to ask what exists. The flat's plugs are therefore a list this
service keeps, and each entry is an address it talks to directly.

Two generations are in circulation and both are worth supporting, because the
older one is the plug most people already own:

  gen 1   a plain HTTP API - GET /status, GET /relay/0?turn=on. Energy comes
          back in watt-minutes.
  gen 2+  the JSON-RPC that the BLU gateway also speaks - Switch.GetStatus,
          Switch.Set, Schedule.*. Energy comes back in watt-hours.

Both are normalised to one shape here, in watt-hours, so nothing above this
file has to know which is which. What is not normalised is the weekly timer:
gen 1 stores it as its own string format and gen 2 as cron jobs, and only the
second is implemented - a gen 1 plug says so rather than pretending.

As with the heating plan, a timer belongs on the device. A plug that switches
itself off at half past eleven should keep doing that with the Pi switched
off, so the schedule is written into the plug and this service is only its
mirror.
"""

from __future__ import annotations

import time

import requests
from requests.auth import HTTPDigestAuth

TIMEOUT = 5
# Switching is a relay closing, not a Bluetooth round trip, so it is quick -
# but a plug behind a weak access point is not, and a timeout here would leave
# the interface claiming a failure for a lamp that did come on.
WRITE_TIMEOUT = 10

# A countdown longer than this is a schedule, and belongs in one.
MAX_COUNTDOWN_S = 24 * 3600


class PlugError(Exception):
    pass


def _auth(password):
    # Gen 2+ uses digest auth with a fixed user name; gen 1 uses basic auth
    # with a configurable one. Digest covers the case that matters, and a plug
    # with no password - the common case on a home network - needs neither.
    return HTTPDigestAuth("admin", password) if password else None


class Plug:
    """One switch, whichever generation it is.

    `gen` is discovered rather than configured: asking the device is one call
    and remembering the answer in the database would be one more thing that
    can be wrong after a firmware update.
    """

    def __init__(self, address, password=None, gen=2):
        self.address = str(address).strip()
        self.password = password
        self.auth = _auth(password)
        self.gen = int(gen or 2)

    # ── Transport ────────────────────────────────────────────────────────────

    def _get(self, path, params=None, timeout=TIMEOUT):
        url = f"http://{self.address}{path}"
        try:
            r = requests.get(url, params=params, auth=self.auth, timeout=timeout)
        except requests.Timeout as exc:
            raise PlugError(f"Steckdose {self.address} antwortet nicht "
                            f"innerhalb von {timeout} s") from exc
        except requests.RequestException as exc:
            # Deliberately not str(exc): urllib3 wraps a refused connection in
            # three nested exceptions and the whole chain would end up on
            # screen where a sentence belongs.
            raise PlugError(f"Steckdose {self.address} nicht erreichbar") from exc
        if r.status_code == 401:
            raise PlugError("Steckdose verlangt ein Passwort — unter Einstellungen hinterlegen.")
        try:
            return r.json()
        except ValueError as exc:
            raise PlugError("Steckdose antwortet nicht mit JSON") from exc

    def _rpc(self, method, params=None, timeout=TIMEOUT):
        """One JSON-RPC call. Gen 2+ answers 200 with an `error` member for a
        refusal, so the body has to be read rather than the status code."""
        body = {"id": 1, "method": method}
        if params is not None:
            body["params"] = params
        url = f"http://{self.address}/rpc"
        try:
            r = requests.post(url, json=body, auth=self.auth, timeout=timeout)
        except requests.Timeout as exc:
            raise PlugError(f"Steckdose {self.address} antwortet nicht "
                            f"innerhalb von {timeout} s") from exc
        except requests.RequestException as exc:
            raise PlugError(f"Steckdose {self.address} nicht erreichbar") from exc
        if r.status_code == 401:
            raise PlugError("Steckdose verlangt ein Passwort — unter Einstellungen hinterlegen.")
        try:
            payload = r.json()
        except ValueError as exc:
            raise PlugError("Steckdose antwortet nicht mit JSON") from exc
        error = payload.get("error")
        if error:
            raise PlugError(error.get("message") or f"Fehler {error.get('code')}")
        return payload.get("result", {})

    # ── What it is ───────────────────────────────────────────────────────────

    def identify(self):
        """Model, name and generation, by asking twice at most.

        `/shelly` is the one path both generations answer, and the presence of
        a `gen` member is what tells them apart.
        """
        info = self._get("/shelly")
        gen = int(info.get("gen") or 1)
        self.gen = gen
        return {
            "address": self.address,
            "gen": gen,
            "mac": (info.get("mac") or "").upper() or None,
            "model": info.get("model") or info.get("type"),
            "name": info.get("name") or None,
            "firmware": info.get("fw_id") or info.get("fw"),
        }

    # ── Reading ──────────────────────────────────────────────────────────────

    def status(self):
        """One reading, the same shape whichever generation answered.

        `energy_wh` is the device's own lifetime counter, not a delta. It
        resets when the plug is factory-reset, which is why whoever stores it
        has to cope with the number going backwards.
        """
        if self.gen >= 2:
            return self._status_gen2()
        return self._status_gen1()

    def _status_gen2(self):
        result = self._rpc("Switch.GetStatus", {"id": 0})
        energy = (result.get("aenergy") or {}).get("total")
        return {
            "on": bool(result.get("output")),
            "power_w": result.get("apower"),
            "voltage": result.get("voltage"),
            "current": result.get("current"),
            # Already watt-hours on this generation.
            "energy_wh": float(energy) if energy is not None else None,
            "temperature_c": (result.get("temperature") or {}).get("tC"),
            # Seconds left on a countdown, where one is running.
            "countdown_s": _countdown_left(result),
            "error": None,
        }

    def _status_gen1(self):
        result = self._get("/status")
        relay = (result.get("relays") or [{}])[0]
        meter = (result.get("meters") or [{}])[0]
        total = meter.get("total")
        return {
            "on": bool(relay.get("ison")),
            "power_w": meter.get("power"),
            "voltage": result.get("voltage"),
            "current": None,
            # Gen 1 counts watt-minutes. Everything above this file is in
            # watt-hours, and mixing the two silently would be a factor of
            # sixty in somebody's electricity bill.
            "energy_wh": round(float(total) / 60.0, 3) if total is not None else None,
            "temperature_c": result.get("temperature"),
            "countdown_s": relay.get("timer_remaining") or None,
            "error": None,
        }

    # ── Switching ────────────────────────────────────────────────────────────

    def switch(self, on, after_s=None):
        """On or off, optionally flipping back after a while.

        `after_s` is the plug's own countdown, not a timer in this service: a
        lamp told to go off in twenty minutes should go off even if the Pi is
        rebooted in the meantime.
        """
        on = bool(on)
        if after_s is not None:
            after_s = int(after_s)
            if not 1 <= after_s <= MAX_COUNTDOWN_S:
                raise PlugError(
                    f"Ein Countdown muss zwischen 1 s und {MAX_COUNTDOWN_S // 3600} h liegen.")
        if self.gen >= 2:
            params = {"id": 0, "on": on}
            if after_s is not None:
                # The plug flips back to the other state after this many
                # seconds; which member carries it depends on the direction.
                params["toggle_after"] = after_s
            self._rpc("Switch.Set", params, timeout=WRITE_TIMEOUT)
        else:
            params = {"turn": "on" if on else "off"}
            if after_s is not None:
                params["timer"] = after_s
            self._get("/relay/0", params, timeout=WRITE_TIMEOUT)
        return on

    # ── The weekly timer, which lives on the plug ────────────────────────────

    def schedules(self):
        """Every job the plug holds, ours and anybody else's."""
        if self.gen < 2:
            raise PlugError("Wochenzeitschaltuhren brauchen eine Steckdose der 2. Generation.")
        return (self._rpc("Schedule.List") or {}).get("jobs") or []

    def create_schedule(self, timespec, on, enable=True):
        if self.gen < 2:
            raise PlugError("Wochenzeitschaltuhren brauchen eine Steckdose der 2. Generation.")
        result = self._rpc("Schedule.Create", {
            "enable": bool(enable),
            "timespec": timespec,
            "calls": [{"method": "Switch.Set", "params": {"id": 0, "on": bool(on)}}],
        }, timeout=WRITE_TIMEOUT)
        return result.get("id")

    def delete_schedule(self, job_id):
        if self.gen < 2:
            raise PlugError("Wochenzeitschaltuhren brauchen eine Steckdose der 2. Generation.")
        # Never DeleteAll: a job somebody made in the Shelly app lives in the
        # same list, and wiping it because it is in the way would be the kind
        # of help nobody asked for.
        self._rpc("Schedule.Delete", {"id": int(job_id)}, timeout=WRITE_TIMEOUT)


def _countdown_left(result):
    """Seconds until a gen 2 plug flips itself back, or None.

    The firmware reports when the countdown started and how long it runs, not
    how much is left - so the remainder is worked out here, against our clock.
    Both ends keep time over NTP, and a few seconds of drift does not matter
    for a figure shown to the minute; `timer_duration` on its own would be the
    whole countdown reported as its remainder, which is wrong from the second
    it starts.
    """
    started, duration = result.get("timer_started_at"), result.get("timer_duration")
    if not started or not duration:
        return None
    left = int(started) + int(duration) - int(time.time())
    return left if left > 0 else None
