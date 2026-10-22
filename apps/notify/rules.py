"""What can be watched, and what counts as worth saying.

One entry per kind of rule. Each knows its own name, the settings it needs, and
how to decide - so adding a kind is adding a function here and nothing else:
the service, the storage and the interface are already general.

A check returns the events it found, never the decision to send them. Whether a
message actually goes out depends on the rule's cooldown, and that is the
service's business. Keeping it out of here means a check can be run twice in a
test without side effects.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone


def now():
    return datetime.now(timezone.utc)


def parse(value):
    if not value:
        return None
    try:
        moment = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def minutes_since(value):
    moment = parse(value)
    return None if moment is None else (now() - moment).total_seconds() / 60


def version_tuple(text):
    """A release tag as something comparable.

    Leading v, trailing anything: "v1.2.0", "1.2", "v1.2.0-rc1" all reduce to
    the numbers, because that is the part that orders. A tag that holds no
    numbers at all sorts before everything, which is the safe direction - it
    means "do not claim this is newer".
    """
    numbers = []
    for part in str(text or "").lstrip("vV.").split("."):
        digits = ""
        for char in part:
            if char.isdigit():
                digits += char
            else:
                break
        if digits:
            numbers.append(int(digits))
        else:
            break
    return tuple(numbers)


def rooms_of(context):
    return ((context.get("home") or {}).get("rooms")) or []


def room_label(room):
    return room.get("name") or room.get("key") or "?"


def pick_rooms(context, params):
    """The rooms a rule applies to: the one named, or all of them.

    By key rather than by id: an id is a number in one service's database, and a
    rule that survives a room being deleted and recreated is worth more than one
    that is a row cheaper.
    """
    wanted = params.get("room")
    rooms = rooms_of(context)
    if not wanted:
        return rooms
    return [r for r in rooms if r.get("key") == wanted]


# ── The checks ───────────────────────────────────────────────────────────────


def check_lights_on_for(context, params, observations):
    """Lamps that have been on for longer than asked.

    The duration comes from the observations, not from the lamp: Hue knows that
    a lamp is on, not since when, and nothing in the flat remembers for it.
    """
    limit = float(params.get("minutes") or 120)
    out = []
    for room in pick_rooms(context, params):
        lights = room.get("lights") or {}
        if not lights.get("on"):
            continue
        age = observations.get(f"room.{room.get('key')}.lights_on")
        if age is None or age < limit:
            continue
        hours = age / 60
        duration = f"{hours:.1f} h" if hours >= 1 else f"{int(age)} min"
        out.append({
            "level": "warn",
            "title": f"Licht an in {room_label(room)}",
            "body": f"Seit {duration}, {lights.get('on')} von {lights.get('bound')} Lampen.",
            "key": f"lights.{room.get('key')}",
        })
    return out


def _climate_threshold(context, params, field, above, unit, what):
    limit = params.get("value")
    if limit is None:
        return []
    limit = float(limit)
    out = []
    for room in pick_rooms(context, params):
        value = (room.get("climate") or {}).get(field)
        if value is None:
            continue
        if (value > limit) if above else (value < limit):
            out.append({
                "level": "warn",
                "title": f"{what} in {room_label(room)}",
                "body": (f"{value} {unit} — {'über' if above else 'unter'} "
                         f"den eingestellten {limit:g} {unit}."),
                "key": f"{field}.{room.get('key')}",
            })
    return out


def check_humidity_above(context, params, observations):
    return _climate_threshold(context, params, "humidity", True, "%", "Luftfeuchte")


def check_humidity_below(context, params, observations):
    return _climate_threshold(context, params, "humidity", False, "%", "Luftfeuchte")


def check_temperature_above(context, params, observations):
    return _climate_threshold(context, params, "temperature", True, "°C", "Temperatur")


def check_temperature_below(context, params, observations):
    return _climate_threshold(context, params, "temperature", False, "°C", "Temperatur")


def check_upstream_release(context, params, observations):
    """A newer release of this stack upstream.

    Compared against the version this machine was installed from where that is
    known. Where it is not, nothing is claimed: a message saying a release
    exists, without knowing whether it is the one already running, is noise.
    """
    upstream = context.get("upstream") or {}
    tag = upstream.get("tag")
    local = upstream.get("local")
    if not tag or not local:
        return []
    if version_tuple(tag) <= version_tuple(local):
        return []
    return [{
        "level": "info",
        "title": f"Update verfügbar: {tag}",
        "body": f"Installiert ist {local}. {upstream.get('name') or ''}".strip(),
        "link": upstream.get("url"),
        "key": f"upstream.{tag}",
    }]


def check_service_down(context, params, observations):
    """A unit of this stack that is not running.

    Reads what the status collector already writes, so this costs nothing and
    covers every component rather than a list kept here. Timers are left out:
    an inactive timer is usually one somebody switched off.
    """
    units = ((context.get("status") or {}).get("units")) or []
    out = []
    for unit in units:
        name = unit.get("name") or ""
        if name.endswith(".timer"):
            continue
        if unit.get("state") in ("active", "missing", None):
            continue
        out.append({
            "level": "alert",
            "title": f"Dienst steht: {name}",
            "body": f"Zustand: {unit.get('state')}.",
            "key": f"unit.{name}",
        })
    return out


def check_disk_above(context, params, observations):
    """The data store filling up, before a backup discovers it."""
    limit = float(params.get("percent") or 90)
    storage = (context.get("status") or {}).get("storage") or {}
    total, used = storage.get("total"), storage.get("used")
    if not total:
        return []
    percent = used / total * 100
    if percent < limit:
        return []
    return [{
        "level": "warn",
        "title": "Datenspeicher wird voll",
        "body": f"{percent:.0f} % belegt auf {storage.get('path')}.",
        "key": "disk",
    }]


def check_raid_degraded(context, params, observations):
    arrays = (context.get("status") or {}).get("raid") or []
    out = []
    for array in arrays:
        if array.get("healthy") is False:
            out.append({
                "level": "alert",
                "title": f"RAID {array.get('name')} beschädigt",
                "body": f"{array.get('disks') or '?'} Platten, Zustand {array.get('state')}.",
                "key": f"raid.{array.get('name')}",
            })
    return out


def check_backup_failed(context, params, observations):
    run = ((context.get("status") or {}).get("backup") or {}).get("lastRun") or {}
    if run.get("status") != "error":
        return []
    return [{
        "level": "alert",
        "title": "Sicherung fehlgeschlagen",
        "body": f"Letzter Lauf {run.get('started_at') or 'unbekannt'}.",
        "key": "backup",
    }]


def check_battery_below(context, params, observations):
    """A valve or sensor running out, while there is still time to act."""
    limit = float(params.get("percent") or 20)
    out = []
    for room in rooms_of(context):
        climate = room.get("climate") or {}
        level = climate.get("battery")
        if level is None or level > limit:
            continue
        out.append({
            "level": "warn",
            "title": f"Batterie schwach in {room_label(room)}",
            "body": f"{level} % — unter den eingestellten {limit:g} %.",
            "key": f"battery.{room.get('key')}",
        })
    return out


# ── The registry ─────────────────────────────────────────────────────────────
#
# params describes what the interface has to ask for, so a new kind needs no
# change there either: a number with a unit, or a room to pick.

KINDS = {
    "lights_on_for": {
        "label": "Licht brennt zu lange",
        "needs": "home",
        "params": [{"name": "room", "type": "room", "label": "Raum (leer = alle)"},
                   {"name": "minutes", "type": "number", "label": "Minuten", "default": 120}],
        "check": check_lights_on_for,
    },
    "humidity_above": {
        "label": "Luftfeuchte über",
        "needs": "home",
        "params": [{"name": "room", "type": "room", "label": "Raum (leer = alle)"},
                   {"name": "value", "type": "number", "label": "Prozent", "default": 65}],
        "check": check_humidity_above,
    },
    "humidity_below": {
        "label": "Luftfeuchte unter",
        "needs": "home",
        "params": [{"name": "room", "type": "room", "label": "Raum (leer = alle)"},
                   {"name": "value", "type": "number", "label": "Prozent", "default": 35}],
        "check": check_humidity_below,
    },
    "temperature_above": {
        "label": "Temperatur über",
        "needs": "home",
        "params": [{"name": "room", "type": "room", "label": "Raum (leer = alle)"},
                   {"name": "value", "type": "number", "label": "Grad", "default": 25}],
        "check": check_temperature_above,
    },
    "temperature_below": {
        "label": "Temperatur unter",
        "needs": "home",
        "params": [{"name": "room", "type": "room", "label": "Raum (leer = alle)"},
                   {"name": "value", "type": "number", "label": "Grad", "default": 16}],
        "check": check_temperature_below,
    },
    "battery_below": {
        "label": "Batterie schwach",
        "needs": "home",
        "params": [{"name": "percent", "type": "number", "label": "Prozent", "default": 20}],
        "check": check_battery_below,
    },
    "service_down": {
        "label": "Dienst steht",
        "needs": "status",
        "params": [],
        "check": check_service_down,
    },
    "disk_above": {
        "label": "Datenspeicher voll",
        "needs": "status",
        "params": [{"name": "percent", "type": "number", "label": "Prozent", "default": 90}],
        "check": check_disk_above,
    },
    "raid_degraded": {
        "label": "RAID beschädigt",
        "needs": "status",
        "params": [],
        "check": check_raid_degraded,
    },
    "backup_failed": {
        "label": "Sicherung fehlgeschlagen",
        "needs": "status",
        "params": [],
        "check": check_backup_failed,
    },
    "upstream_release": {
        "label": "Neue Version verfügbar",
        "needs": "upstream",
        "params": [],
        "check": check_upstream_release,
    },
}


def describe():
    """The catalogue, for the screen that builds rules."""
    return [{"kind": kind, "label": spec["label"], "needs": spec["needs"],
             "params": spec["params"]}
            for kind, spec in sorted(KINDS.items(), key=lambda item: item[1]["label"])]
