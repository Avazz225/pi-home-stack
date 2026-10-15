"""Shelly BLU Gateway Gen3, spoken to locally over its JSON-RPC endpoint.

No cloud account is involved: the gateway sits on the LAN and answers RPC on
http://<ip>/rpc. Radiator valves (BLU TRV) are Bluetooth devices paired to the
gateway, which exposes each of them as a `blutrv:<id>` component and relays RPC
to them.

Two ways to reach a valve, and the difference decides how long its batteries
last:

  BluTrv.GetRemoteStatus   a cached snapshot the gateway already holds, built
                           from the advertisements the valve broadcasts anyway.
                           Free. It carries the timestamp of the snapshot, so
                           the caller can see how old the numbers are.
  BluTrv.Call              a real Bluetooth connection to the valve. This is
                           what changing a setpoint needs, and it costs energy
                           on a device running on two AA cells.

So everything here reads from the cache and connects only to write. Polling
through BluTrv.Call every few seconds would work and would drain the valves.
"""

from __future__ import annotations

import requests
from requests.auth import HTTPDigestAuth

TIMEOUT = 8
# A Bluetooth round trip is slower than a local HTTP call, and the gateway waits
# for the valve before it answers.
WRITE_TIMEOUT = 20

# The valve accepts between these; the gateway passes the value through
# unchecked and an out-of-range setpoint fails silently on the device.
MIN_TARGET_C = 4.0
MAX_TARGET_C = 30.0

# Measured against the firmware, not taken from documentation: the gateway
# refuses the 21st job with "Reached the maximum 20 of jobs", and a job with six
# calls with "Invalid argument 'calls'". Five calls times twenty jobs is a
# hundred setpoints per firing cycle, which is far more than a flat needs - but
# the caller has to know where the wall is to say something useful when it is
# reached.
MAX_JOBS = 20
MAX_CALLS_PER_JOB = 5

# BTHome object ids, as the sensors advertise them. Only the three that carry a
# number anyone wants to read: a Shelly BLU H&T also advertises a boolean (0x1E)
# and an id that arrives without a value (0x64), and guessing at those would put
# invented meaning on a screen.
OBJ_BATTERY = 1        # 0x01, per cent
OBJ_HUMIDITY = 46      # 0x2E, per cent
OBJ_TEMPERATURE = 69   # 0x45, degrees Celsius


def target_call(trv_id, target_C):
    """One scheduled setpoint, in the form the gateway's scheduler expects.

    The gateway calls its own RPC when a job fires, and BluTrv.Call is what
    relays that to the valve over Bluetooth. So the schedule lives on the
    gateway and the Pi is not in the loop when it fires - which is the point:
    the heating keeps its plan while the Pi is being rebuilt.
    """
    return {"method": "BluTrv.Call",
            "params": {"id": int(trv_id), "method": "Trv.SetTarget",
                       "params": {"id": 0, "target_C": round(float(target_C), 1)}}}


class ShellyError(Exception):
    """Anything the gateway refused, with a message worth showing to the user."""


class BluGateway:
    def __init__(self, ip, password=None):
        self.ip = ip
        # The firmware allows exactly one account, and its name is fixed.
        self.auth = HTTPDigestAuth("admin", password) if password else None

    def _rpc(self, method, params=None, timeout=TIMEOUT):
        """One JSON-RPC call. The gateway answers 200 with an `error` member for
        refusals, so the body has to be inspected rather than the status code."""
        body = {"id": 1, "method": method}
        if params is not None:
            body["params"] = params
        try:
            r = requests.post(f"http://{self.ip}/rpc", json=body,
                              auth=self.auth, timeout=timeout)
        except requests.Timeout as exc:
            raise ShellyError(f"Gateway {self.ip} antwortet nicht innerhalb von {timeout} s") from exc
        except requests.RequestException as exc:
            # Deliberately not str(exc): urllib3 wraps a refused connection in
            # three nested exceptions and the whole chain ends up in the
            # message. On screen that is a paragraph of library internals where
            # a sentence belongs.
            raise ShellyError(f"Gateway {self.ip} nicht erreichbar") from exc

        if r.status_code == 401:
            raise ShellyError("Gateway verlangt ein Passwort — unter Einstellungen hinterlegen.")
        try:
            payload = r.json()
        except ValueError as exc:
            raise ShellyError("Gateway antwortet nicht mit JSON") from exc

        error = payload.get("error")
        if error:
            raise ShellyError(error.get("message") or f"Fehler {error.get('code')}")
        return payload.get("result", {})

    # ── Reading ──────────────────────────────────────────────────────────────

    def info(self):
        result = self._rpc("Shelly.GetDeviceInfo")
        return {
            "id": result.get("id"),
            "model": result.get("model"),
            "version": result.get("ver"),
            "auth_enabled": bool(result.get("auth_en")),
        }

    def _components(self):
        """Every dynamic component, across however many pages it takes.

        The gateway pages this list and does not say how large a page is, so the
        loop follows `total` and stops as soon as a page adds nothing — without
        that second condition a firmware that reports a wrong total would spin
        here forever.
        """
        out = []
        offset = 0
        while True:
            page = self._rpc("Shelly.GetComponents",
                             {"dynamic_only": True, "offset": offset})
            batch = page.get("components") or []
            if not batch:
                break
            out.extend(batch)
            offset += len(batch)
            if offset >= int(page.get("total") or 0):
                break
        return out

    def sensors(self, components=None):
        """Every BTHome sensor device that is not a valve, with its readings.

        Valves are filtered out by address rather than by component type: a BLU
        TRV appears as a bthomedevice as well, and it advertises two temperature
        channels of its own. Mixing those in would give a room two temperatures
        that disagree for a reason nobody can see.
        """
        components = self._components() if components is None else components
        valve_addrs = {(c.get("config") or {}).get("addr")
                       for c in components if str(c.get("key", "")).startswith("blutrv:")}

        devices = {}
        for component in components:
            key = str(component.get("key", ""))
            config = component.get("config") or {}
            if not key.startswith("bthomedevice:") or config.get("addr") in valve_addrs:
                continue
            status = component.get("status") or {}
            devices[config.get("addr")] = {
                "key": key,
                "addr": config.get("addr"),
                "name": config.get("name"),
                "battery": status.get("battery"),
                "rssi": status.get("rssi"),
                "temperature": None, "humidity": None,
                "updated_ts": None, "channels": {},
            }

        for component in components:
            key = str(component.get("key", ""))
            config = component.get("config") or {}
            if not key.startswith("bthomesensor:"):
                continue
            device = devices.get(config.get("addr"))
            if device is None:
                continue
            status = component.get("status") or {}
            value = status.get("value")
            obj = config.get("obj_id")
            # The channel keys are kept so a caller can tell which sensor
            # component a valve's temp_sensors entry refers to.
            device["channels"][key] = {"obj_id": obj, "value": value}
            if obj == OBJ_TEMPERATURE and device["temperature"] is None:
                device["temperature"] = value
            elif obj == OBJ_HUMIDITY:
                device["humidity"] = value
            elif obj == OBJ_BATTERY and value is not None:
                device["battery"] = value
            stamp = status.get("last_updated_ts")
            # Each channel carries its own timestamp; the device is as fresh as
            # its freshest channel, and an id that never reported has a stamp
            # from 1992 that must not drag the whole device backwards.
            if obj in (OBJ_TEMPERATURE, OBJ_HUMIDITY) and stamp:
                device["updated_ts"] = max(device["updated_ts"] or 0, int(stamp))

        gateway_now = (self._rpc("Sys.GetStatus") or {}).get("unixtime")
        out = []
        for device in devices.values():
            device["age_s"] = (max(0, int(gateway_now) - device["updated_ts"])
                               if gateway_now and device["updated_ts"] else None)
            out.append(device)
        return sorted(out, key=lambda d: (d["name"] or "", d["addr"] or ""))

    def snapshot(self):
        """Valves and sensors from one pass over the components.

        /overview wants both on every poll, and fetching the component list
        twice would double the calls for data that was already in hand.
        """
        components = self._components()
        return {"trvs": self.trvs(components), "sensors": self.sensors(components)}

    def trvs(self, components=None):
        """Every paired radiator valve with its current numbers.

        `age_s` is measured against the gateway's own clock, not ours: the two
        agree over NTP in practice, but a snapshot's age is a property of the
        gateway and should not silently become a statement about our clock.
        """
        components = self._components() if components is None else components
        valves = []
        for component in components:
            if not str(component.get("key", "")).startswith("blutrv:"):
                continue
            status = component.get("status") or {}
            config = component.get("config") or {}
            valves.append({
                "id": status.get("id"),
                "addr": config.get("addr"),
                "name": config.get("name"),
                "paired": bool(status.get("paired")),
                "rpc": bool(status.get("rpc")),
                "battery": status.get("battery"),
                "rssi": status.get("rssi"),
                # Which sensor channels the gateway hands this valve as its
                # reference. Read-only here: the field is not writable through
                # BluTrv.SetConfig - the firmware acknowledges the write and
                # drops it - the association is made in the Shelly app.
                "temp_sensors": config.get("temp_sensors") or [],
                "dw_sensors": config.get("dw_sensors") or [],
            })
        if not valves:
            return []

        gateway_now = (self._rpc("Sys.GetStatus") or {}).get("unixtime")
        for valve in valves:
            valve.update({"target_C": None, "current_C": None, "position": None,
                          "age_s": None, "error": None})
            if valve["id"] is None:
                continue
            try:
                snapshot = self._rpc("BluTrv.GetRemoteStatus", {"id": valve["id"]})
            except ShellyError as exc:
                # One unreachable valve must not cost us the other two.
                valve["error"] = str(exc)
                continue
            trv = (snapshot.get("status") or {}).get("trv:0") or {}
            valve["target_C"] = trv.get("target_C")
            valve["current_C"] = trv.get("current_C")
            valve["position"] = trv.get("pos")
            taken_at = snapshot.get("ts")
            if gateway_now and taken_at:
                valve["age_s"] = max(0, int(gateway_now) - int(taken_at))
            valve["valve_errors"] = trv.get("errors") or []
        return sorted(valves, key=lambda v: v["id"] if v["id"] is not None else -1)

    # ── Schedules on the gateway ─────────────────────────────────────────────

    def schedules(self):
        """Every job the gateway holds, ours and anybody else's."""
        return (self._rpc("Schedule.List") or {}).get("jobs") or []

    def create_schedule(self, timespec, calls, enable=True):
        result = self._rpc("Schedule.Create",
                           {"enable": bool(enable), "timespec": timespec, "calls": calls})
        return result.get("id")

    def delete_schedule(self, job_id):
        # Not DeleteAll, ever: jobs created in the Shelly app live in the same
        # list, and wiping them because they are in the way would be the kind of
        # help nobody asked for.
        self._rpc("Schedule.Delete", {"id": int(job_id)})

    # ── Writing ──────────────────────────────────────────────────────────────

    def set_target(self, trv_id, target_C):
        """Set one valve's setpoint. This opens a Bluetooth connection, so it is
        called when somebody asks for a temperature — never on a timer."""
        value = float(target_C)
        if not MIN_TARGET_C <= value <= MAX_TARGET_C:
            raise ShellyError(
                f"Solltemperatur muss zwischen {MIN_TARGET_C:.0f} und {MAX_TARGET_C:.0f} °C liegen.")
        self._rpc("BluTrv.Call",
                  {"id": int(trv_id), "method": "Trv.SetTarget",
                   "params": {"id": 0, "target_C": round(value, 1)}},
                  timeout=WRITE_TIMEOUT)
        return value
