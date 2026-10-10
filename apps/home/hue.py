"""Philips Hue bridge, spoken to locally over the CLIP v2 API.

No cloud account is involved: the bridge is reachable on the LAN and the only
credential is an application key handed out once, while the link button is
pressed. The bridge serves HTTPS with a certificate signed for its own bridge id,
which no normal trust store knows — so verification is off and the warning that
would otherwise be printed on every poll is silenced.
"""

from __future__ import annotations

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

TIMEOUT = 5
DEVICE_TYPE = "air-qual-dashboard#home"


class HueError(Exception):
    """Anything the bridge refused, plus a message worth showing to the user."""


class LinkButtonNotPressed(HueError):
    pass


def discover_bridges():
    """Ask Philips' discovery endpoint which bridges this WAN address has seen.
    It is the one cloud call in here and purely a convenience — the IP can always
    be typed in by hand."""
    try:
        r = requests.get("https://discovery.meethue.com/", timeout=TIMEOUT)
        r.raise_for_status()
        return [{"id": b.get("id"), "ip": b.get("internalipaddress")} for b in r.json()]
    except requests.RequestException:
        return []


def pair(ip):
    """Exchange a pressed link button for an application key. Hue answers 200 with
    an error body rather than an HTTP error code when the button was not pressed,
    so the body has to be inspected."""
    try:
        r = requests.post(
            f"https://{ip}/api",
            json={"devicetype": DEVICE_TYPE, "generateclientkey": True},
            verify=False,
            timeout=TIMEOUT,
        )
        r.raise_for_status()
        payload = r.json()
    except requests.RequestException as exc:
        raise HueError(f"Bridge {ip} nicht erreichbar: {exc}") from exc

    if not isinstance(payload, list) or not payload:
        raise HueError("Unerwartete Antwort der Bridge")
    entry = payload[0]
    if "error" in entry:
        description = entry["error"].get("description", "")
        if "link button" in description:
            raise LinkButtonNotPressed("Bitte den Knopf auf der Bridge drücken und erneut versuchen.")
        raise HueError(description or "Pairing abgelehnt")
    return entry["success"]["username"]


class HueBridge:
    def __init__(self, ip, app_key):
        self.ip = ip
        self.app_key = app_key

    def _request(self, method, path, body=None):
        url = f"https://{self.ip}/clip/v2/resource{path}"
        try:
            r = requests.request(
                method, url,
                headers={"hue-application-key": self.app_key},
                json=body, verify=False, timeout=TIMEOUT,
            )
        except requests.RequestException as exc:
            raise HueError(f"Bridge nicht erreichbar: {exc}") from exc
        if r.status_code in (401, 403):
            raise HueError("Application Key wird von der Bridge abgelehnt — neu koppeln.")
        try:
            payload = r.json()
        except ValueError as exc:
            raise HueError("Bridge antwortet nicht mit JSON") from exc
        errors = payload.get("errors") or []
        if errors:
            raise HueError(errors[0].get("description", "Unbekannter Fehler"))
        return payload.get("data", [])

    # ── Reading ──────────────────────────────────────────────────────────────

    def lights(self):
        """Flat list of controllable lights. Brightness is Hue's 0–100 percentage,
        not the 0–254 of the old v1 API."""
        out = []
        for light in self._request("GET", "/light"):
            colour = light.get("color_temperature") or {}
            out.append({
                "id": light["id"],
                "name": (light.get("metadata") or {}).get("name") or light["id"],
                "on": bool((light.get("on") or {}).get("on")),
                "brightness": (light.get("dimming") or {}).get("brightness"),
                "mirek": colour.get("mirek"),
                "mirek_min": (colour.get("mirek_schema") or {}).get("mirek_minimum"),
                "mirek_max": (colour.get("mirek_schema") or {}).get("mirek_maximum"),
                "supports_color_temperature": "color_temperature" in light,
                "reachable": True,
            })
        return sorted(out, key=lambda l: l["name"].lower())

    def rooms(self):
        """Hue's own room grouping, used only to propose a mapping onto the flat's
        rooms. Hue groups lights by *device*, while /light ids are services, so the
        device id of each light is resolved first."""
        light_by_device = {}
        for light in self._request("GET", "/light"):
            owner = (light.get("owner") or {}).get("rid")
            if owner:
                light_by_device.setdefault(owner, []).append(light["id"])

        out = []
        for room in self._request("GET", "/room"):
            light_ids = []
            for child in room.get("children") or []:
                light_ids.extend(light_by_device.get(child.get("rid"), []))
            out.append({
                "id": room["id"],
                "name": (room.get("metadata") or {}).get("name") or room["id"],
                "light_ids": light_ids,
            })
        return out

    # ── Writing ──────────────────────────────────────────────────────────────

    def set_light(self, light_id, on=None, brightness=None, mirek=None):
        body = {}
        if on is not None:
            body["on"] = {"on": bool(on)}
        if brightness is not None:
            # Switching a lamp to 0 % is "off" in Hue's model, not a dim level.
            value = max(0.0, min(100.0, float(brightness)))
            if value <= 0:
                body["on"] = {"on": False}
            else:
                body["dimming"] = {"brightness": value}
                body.setdefault("on", {"on": True})
        if mirek is not None:
            body["color_temperature"] = {"mirek": int(mirek)}
        if not body:
            return
        self._request("PUT", f"/light/{light_id}", body)

    def set_lights(self, light_ids, **kwargs):
        """Several lamps at once. Hue has grouped_light for this, but a group only
        covers its own room — a room of this flat may hold lamps Hue filed
        elsewhere, so each lamp is addressed individually."""
        failed = []
        for light_id in light_ids:
            try:
                self.set_light(light_id, **kwargs)
            except HueError as exc:
                failed.append({"id": light_id, "error": str(exc)})
        return failed
