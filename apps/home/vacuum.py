"""yeedi / Ecovacs robot vacuum, via the community library `deebot-client`.

Two things shape this module.

First, there is no official API. Ecovacs publishes none, and everything
deebot-client knows was reverse engineered; yeedi models in particular are
supported "best effort". The yeedi Vac 2 Pro is not named in the library's device
registry, so it may well come back as unsupported — hence FALLBACK_CLASSES, which
lets a known yeedi profile be tried on an unknown device instead of giving up.

Second, deebot-client is async and keeps a live MQTT connection, while Flask is
synchronous and request-scoped. So the connection lives in a background thread
with its own event loop; requests read a cached state that the event
subscriptions keep current, and write by handing a coroutine to that loop.
"""

from __future__ import annotations

import asyncio
import threading
import time

COMMAND_TIMEOUT = 20
CONNECT_TIMEOUT = 60

# Device classes the library knows as yeedi. Used only when the real device is
# reported as unsupported and the user opts into trying one of these profiles.
FALLBACK_CLASSES = ["kd0una", "p95mgv", "rwp09o", "t5e5o6", "t6kipw", "u3bsxq"]

STATE_LABELS = {
    "idle": "Bereit", "cleaning": "Saugt", "returning": "Fährt zurück",
    "docked": "In der Station", "error": "Fehler", "paused": "Pausiert",
}


class VacuumError(Exception):
    pass


class VacuumBridge:
    """Owns the connection. One instance per process; `status()` is always safe to
    call, also before any credentials exist."""

    def __init__(self):
        self._lock = threading.Lock()
        self._loop = None
        self._thread = None
        self._device = None
        self._caps = None
        self._session = None
        self._state = self._empty_state()

    @staticmethod
    def _empty_state():
        return {
            "connected": False,
            "connecting": False,
            "error": None,
            "device_name": None,
            "device_class": None,
            "used_fallback": None,
            "unsupported": None,
            "available": None,
            "state": None,
            "battery": None,
            "fan_speed": None,
            "error_code": None,
            "error_text": None,
            "rooms": [],
            "updated_at": None,
        }

    # ── State, read by request threads ───────────────────────────────────────

    def _set(self, **values):
        with self._lock:
            self._state.update(values)
            self._state["updated_at"] = time.time()

    def status(self):
        with self._lock:
            snapshot = dict(self._state)
        snapshot["state_label"] = STATE_LABELS.get(snapshot.get("state") or "", None)
        return snapshot

    @property
    def connected(self):
        with self._lock:
            return self._state["connected"]

    # ── Connection lifecycle ─────────────────────────────────────────────────

    def start(self, account_id, password_hash, country, fallback_class=None):
        """Connect in the background and return at once. Progress and failures
        show up in status(), because pairing can take longer than a request."""
        self.stop()
        self._state = self._empty_state()
        self._set(connecting=True)
        self._thread = threading.Thread(
            target=self._run,
            args=(account_id, password_hash, country, fallback_class),
            name="vacuum-bridge",
            daemon=True,
        )
        self._thread.start()

    def stop(self):
        loop, thread = self._loop, self._thread
        if loop is not None and loop.is_running():
            asyncio.run_coroutine_threadsafe(self._teardown(), loop)
            loop.call_soon_threadsafe(loop.stop)
        if thread is not None:
            thread.join(timeout=10)
        self._loop = self._thread = self._device = self._caps = None
        self._set(connected=False, connecting=False)

    def _run(self, account_id, password_hash, country, fallback_class):
        loop = asyncio.new_event_loop()
        self._loop = loop
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(self._connect(account_id, password_hash, country, fallback_class))
        except VacuumError as exc:
            # Already phrased for the user — the class name would only be noise
            self._set(connected=False, connecting=False, error=str(exc))
            loop.close()
            return
        except Exception as exc:  # noqa: BLE001 — surfaced to the user verbatim
            self._set(connected=False, connecting=False, error=f"{type(exc).__name__}: {exc}")
            loop.close()
            return
        try:
            loop.run_forever()
        finally:
            loop.close()

    async def _connect(self, account_id, password_hash, country, fallback_class):
        # deebot-client is imported here rather than at module level on purpose:
        # it needs Python >= 3.14 while nothing else in this service does, so a
        # missing library costs only the vacuum — Hue, rooms and the heating plan
        # keep working.
        try:
            import aiohttp
            from deebot_client.api_client import ApiClient, get_static_device_info
            from deebot_client.authentication import Authenticator, create_rest_config
            from deebot_client.device import Device
            from deebot_client.models import DeviceInfo
            from deebot_client.mqtt_client import MqttClient, create_mqtt_config
            from deebot_client.util import md5
        except ImportError as exc:
            raise VacuumError(
                f"deebot-client ist nicht installiert ({exc}). Es verlangt Python 3.14 "
                "oder neuer — siehe install-python314.sh im Service-Verzeichnis."
            ) from exc

        device_id = md5(str(time.time()))
        self._session = aiohttp.ClientSession()
        rest_config = create_rest_config(self._session, device_id=device_id, alpha_2_country=country)
        authenticator = Authenticator(rest_config, account_id, password_hash)
        api_client = ApiClient(authenticator)

        devices = await api_client.get_devices()
        unsupported = [d.get("class") for d in devices.not_supported]
        info = devices.mqtt[0] if devices.mqtt else None
        used_fallback = None

        if info is None and devices.not_supported and fallback_class:
            # The device exists in the account but the library has no profile for
            # its class. Borrow a known yeedi profile and see how far it gets.
            static = await get_static_device_info(fallback_class)
            if static is None:
                raise VacuumError(f"Unbekanntes Kompatibilitätsprofil: {fallback_class}")
            info = DeviceInfo(devices.not_supported[0], static)
            used_fallback = fallback_class

        if info is None:
            self._set(connecting=False, unsupported=unsupported,
                      error="Kein unterstützter Saugroboter im Konto gefunden."
                            + (f" Nicht unterstützt: {', '.join(c for c in unsupported if c)}."
                               if unsupported else ""))
            return

        device = Device(info, authenticator)
        mqtt = MqttClient(create_mqtt_config(device_id=device_id, country=country), authenticator)
        await device.initialize(mqtt)

        self._device = device
        self._caps = info.static.capabilities
        self._subscribe(device, self._caps)
        self._set(
            connected=True, connecting=False, error=None,
            device_name=info.api.get("nick") or info.api.get("name"),
            device_class=info.api.get("class"),
            used_fallback=used_fallback,
            unsupported=unsupported,
        )

    def _subscribe(self, device, caps):
        from deebot_client.events import (
            AvailabilityEvent, BatteryEvent, ErrorEvent, FanSpeedEvent, RoomsEvent, StateEvent,
        )

        async def on_state(event: StateEvent):
            self._set(state=event.state.name.lower())

        async def on_battery(event: BatteryEvent):
            self._set(battery=event.value)

        async def on_availability(event: AvailabilityEvent):
            self._set(available=event.available)

        async def on_error(event: ErrorEvent):
            self._set(error_code=event.code, error_text=event.description)

        async def on_fan_speed(event: FanSpeedEvent):
            self._set(fan_speed=event.speed.name.lower())

        async def on_rooms(event: RoomsEvent):
            self._set(rooms=[{"id": r.id, "name": r.name} for r in event.rooms])

        device.events.subscribe(StateEvent, on_state)
        device.events.subscribe(BatteryEvent, on_battery)
        device.events.subscribe(AvailabilityEvent, on_availability)
        device.events.subscribe(ErrorEvent, on_error)
        if caps.fan_speed is not None:
            device.events.subscribe(FanSpeedEvent, on_fan_speed)
        # Subscribing is what makes deebot-client ask for the map in the first
        # place; without a subscriber the rooms never arrive.
        if caps.map is not None:
            device.events.subscribe(RoomsEvent, on_rooms)

    async def _teardown(self):
        if self._device is not None:
            try:
                await self._device.teardown()
            except Exception:  # noqa: BLE001 — shutting down anyway
                pass
        if self._session is not None and not self._session.closed:
            await self._session.close()

    # ── Commands ─────────────────────────────────────────────────────────────

    def _caps_or_raise(self):
        """Commands are built from the capability objects, so the connection has
        to be checked before the command is constructed, not only before it is
        sent."""
        if self._caps is None or self._device is None or not self.connected:
            raise VacuumError("Saugroboter ist nicht verbunden.")
        return self._caps

    def _execute(self, command):
        if self._loop is None or self._device is None or not self.connected:
            raise VacuumError("Saugroboter ist nicht verbunden.")
        future = asyncio.run_coroutine_threadsafe(self._device.execute_command(command), self._loop)
        try:
            return future.result(timeout=COMMAND_TIMEOUT)
        except asyncio.TimeoutError as exc:
            raise VacuumError("Der Roboter hat nicht rechtzeitig geantwortet.") from exc
        except Exception as exc:  # noqa: BLE001 — library raises many shapes
            raise VacuumError(f"{type(exc).__name__}: {exc}") from exc

    def clean_all(self):
        from deebot_client.commands.json.clean import CleanAction
        caps = self._caps_or_raise()
        return self._execute(caps.clean.action.command(CleanAction.START))

    def clean_rooms(self, room_ids, cleanings=1):
        """Spot-area cleaning. room_ids are the robot's own map subset numbers —
        the ones from status()["rooms"], not this service's room ids."""
        from deebot_client.commands.json.clean import CleanMode
        area = self._caps_or_raise().clean.action.area
        if area is None:
            raise VacuumError("Dieses Gerät meldet keine Raumreinigung.")
        if not room_ids:
            raise VacuumError("Keine Räume ausgewählt.")
        return self._execute(area(CleanMode.SPOT_AREA, [int(r) for r in room_ids], cleanings))

    def control(self, action):
        from deebot_client.commands.json.clean import CleanAction
        caps = self._caps_or_raise()
        actions = {a.value: a for a in CleanAction}
        if action == "home":
            return self._execute(caps.charge.execute())
        if action not in actions:
            raise VacuumError(f"Unbekannte Aktion: {action}")
        return self._execute(caps.clean.action.command(actions[action]))

    def set_fan_speed(self, level):
        from deebot_client.events import FanSpeedLevel
        caps = self._caps_or_raise()
        if caps.fan_speed is None:
            raise VacuumError("Dieses Gerät meldet keine Saugstufen.")
        try:
            value = FanSpeedLevel[level.upper()]
        except KeyError as exc:
            raise VacuumError(f"Unbekannte Saugstufe: {level}") from exc
        return self._execute(caps.fan_speed.set(value))

    def fan_speed_levels(self):
        if self._caps is None or self._caps.fan_speed is None:
            return []
        return [level.name.lower() for level in self._caps.fan_speed.types]


bridge = VacuumBridge()
