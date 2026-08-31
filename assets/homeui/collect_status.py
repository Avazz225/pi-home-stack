#!/usr/bin/env python3
"""Collects the numbers the home interface shows and writes them to status.json.

Runs as a systemd timer rather than as a web service on purpose: the page stays a
static file, nginx needs no application server, and nothing that talks to the
network runs as root. Every probe degrades to null instead of failing the run — a
missing Pi-hole must not cost us the disk usage.
"""

import json
import os
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone

CONFIG_FILE = "/etc/pi-home-stack/stack.env"
TIMEOUT = 10


def read_config():
    config = {}
    try:
        with open(CONFIG_FILE, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                config[key] = value.strip().strip("'")
    except OSError:
        pass
    return config


def run_command(args, timeout=TIMEOUT):
    try:
        result = subprocess.run(args, capture_output=True, text=True,
                                timeout=timeout, check=False)
        return result.stdout.strip() if result.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        return None


def service_state(unit):
    """active / inactive / missing — 'missing' keeps a not-installed service from
    looking like a crashed one on the page."""
    if run_command(["systemctl", "list-unit-files", unit]) is None:
        return "missing"
    state = run_command(["systemctl", "is-active", unit])
    if state is None:
        # is-active exits non-zero for inactive units, so fall back to the raw call.
        try:
            result = subprocess.run(["systemctl", "is-active", unit],
                                    capture_output=True, text=True, check=False)
            state = result.stdout.strip()
        except (OSError, subprocess.SubprocessError):
            return "unknown"
    return state or "unknown"


def system_info():
    info = {"hostname": socket.gethostname()}
    try:
        with open("/proc/uptime", encoding="utf-8") as handle:
            info["uptimeSeconds"] = int(float(handle.read().split()[0]))
    except (OSError, ValueError, IndexError):
        info["uptimeSeconds"] = None
    try:
        info["load"] = list(os.getloadavg())
    except OSError:
        info["load"] = None
    info["cpuCount"] = os.cpu_count()

    try:
        with open("/sys/class/thermal/thermal_zone0/temp", encoding="utf-8") as handle:
            info["cpuTemperature"] = round(int(handle.read().strip()) / 1000.0, 1)
    except (OSError, ValueError):
        info["cpuTemperature"] = None

    memory = {}
    try:
        with open("/proc/meminfo", encoding="utf-8") as handle:
            for line in handle:
                key, _, rest = line.partition(":")
                if key in ("MemTotal", "MemAvailable"):
                    memory[key] = int(rest.strip().split()[0]) * 1024
        info["memoryTotal"] = memory.get("MemTotal")
        info["memoryAvailable"] = memory.get("MemAvailable")
    except (OSError, ValueError, IndexError):
        info["memoryTotal"] = info["memoryAvailable"] = None

    model = None
    for path in ("/proc/device-tree/model", "/sys/firmware/devicetree/base/model"):
        try:
            with open(path, encoding="utf-8", errors="replace") as handle:
                model = handle.read().replace("\x00", "").strip()
                break
        except OSError:
            continue
    info["model"] = model
    return info


def storage_info(config):
    path = config.get("SHARE_PATH") or config.get("SHARE_DATA_DIR")
    if not path or not os.path.isdir(path):
        return None
    try:
        usage = shutil.disk_usage(path)
    except OSError:
        return None
    return {
        "path": path,
        "total": usage.total,
        "used": usage.used,
        "free": usage.free,
        "mounted": os.path.ismount(path) or config.get("STORAGE_MODE") == "folder",
    }


def raid_info():
    """Parses /proc/mdstat. The [UU] field is what matters: a U turned into an
    underscore is a failed disk, and that is the one thing worth alerting on."""
    try:
        with open("/proc/mdstat", encoding="utf-8") as handle:
            content = handle.read()
    except OSError:
        return None

    arrays = []
    current = None
    for line in content.splitlines():
        match = re.match(r"^(md\d+)\s*:\s*(\w+)\s+(\S+)", line)
        if match:
            current = {"name": match.group(1), "state": match.group(2),
                       "level": match.group(3), "healthy": None, "disks": None,
                       "resync": None}
            arrays.append(current)
            continue
        if current is None:
            continue
        status = re.search(r"\[(\d+)/(\d+)\]\s+\[([U_]+)\]", line)
        if status:
            current["disks"] = f"{status.group(2)}/{status.group(1)}"
            current["healthy"] = "_" not in status.group(3)
        resync = re.search(r"(resync|recovery|check)\s*=\s*([\d.]+)%", line)
        if resync:
            current["resync"] = {"kind": resync.group(1), "percent": float(resync.group(2))}
    return arrays or None


def pihole_info():
    """Pi-hole v5 answers `pihole -c -j`; v6 replaced it with an authenticated API.
    Without a token we simply report no numbers rather than storing credentials here."""
    raw = run_command(["pihole", "-c", "-j"])
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return {
        "queriesToday": data.get("dns_queries_today"),
        "blockedToday": data.get("ads_blocked_today"),
        "blockedPercent": data.get("ads_percentage_today"),
        "domainsOnList": data.get("domains_being_blocked"),
    }


def backup_info(config):
    database = config.get("BACKUP_DB") or "/opt/pi-home-stack/backup/data/backup.db"
    if not os.path.isfile(database):
        return None
    try:
        # Read-only and short timeout: a running backup holds the write lock, and
        # the status page must never be the thing that blocks it.
        connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True, timeout=2)
        connection.row_factory = sqlite3.Row
        run = connection.execute(
            "SELECT started_at, finished_at, status, files_uploaded, bytes_uploaded "
            "FROM backup_run WHERE status != 'running' ORDER BY started_at DESC LIMIT 1"
        ).fetchone()
        live = connection.execute(
            "SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes "
            "FROM backup_object WHERE deleted_at IS NULL"
        ).fetchone()
        connection.close()
    except sqlite3.Error:
        return None
    return {
        "lastRun": dict(run) if run else None,
        "objects": live["n"] if live else 0,
        "bytes": live["bytes"] if live else 0,
    }


def netmonitor_info(config):
    database = config.get("NETMON_DB") or "/opt/pi-home-stack/netmonitor/data/netmon.db"
    if not os.path.isfile(database):
        return None
    try:
        connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True, timeout=2)
        connection.row_factory = sqlite3.Row
        row = connection.execute(
            "SELECT measured_at, download_mbps, upload_mbps, ping_ms "
            "FROM measurement ORDER BY measured_at DESC LIMIT 1"
        ).fetchone()
        connection.close()
    except sqlite3.Error:
        return None
    return dict(row) if row else None


def main():
    config = read_config()
    destination = sys.argv[1] if len(sys.argv) > 1 else \
        os.path.join(config.get("WEB_ROOT", "/var/www/pi-home"), "status.json")

    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "system": system_info(),
        "storage": storage_info(config),
        "raid": raid_info(),
        "pihole": pihole_info(),
        "backup": backup_info(config),
        "netmonitor": netmonitor_info(config),
        "services": {
            "nginx": service_state("nginx.service"),
            "samba": service_state("smbd.service"),
            "pihole": service_state("pihole-FTL.service"),
            "backup": service_state("pi-home-backup.service"),
            "netmonitor": service_state("pi-home-netmonitor.service"),
        },
        "shareName": config.get("SHARE_NAME"),
        "features": (config.get("INSTALLED_FEATURES") or "").split(),
    }

    # Atomic replace: the page polls this file and must never read a half-written one.
    temporary = f"{destination}.tmp-{os.getpid()}"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=1)
    os.chmod(temporary, 0o644)
    os.replace(temporary, destination)


if __name__ == "__main__":
    for attempt in range(3):
        try:
            main()
            break
        except Exception as error:  # noqa: BLE001 - a timer job must not die loudly
            if attempt == 2:
                print(f"status konnte nicht geschrieben werden: {error}", file=sys.stderr)
                sys.exit(1)
            time.sleep(2)
