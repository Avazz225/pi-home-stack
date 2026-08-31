#!/usr/bin/env python3
"""Misst periodisch die Internetgeschwindigkeit und schreibt sie in eine SQLite-DB.

Ein Messlauf pro Aufruf; die Wiederholung übernimmt ein systemd-Timer. Die kleine
HTTP-API (--serve) liefert den Verlauf für das Home-Interface.

Gemessen wird mit speedtest-cli, falls vorhanden. Ohne das Werkzeug fällt die
Messung auf einen einfachen HTTP-Download zurück — ungenauer, aber es sagt
zumindest, ob die Leitung eingebrochen ist.
"""

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("NETMON_DATA", os.path.join(BASE_DIR, "data"))
DB_FILE = os.path.join(DATA_DIR, "netmon.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS measurement (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    measured_at    TEXT NOT NULL,
    download_mbps  REAL,
    upload_mbps    REAL,
    ping_ms        REAL,
    server         TEXT,
    method         TEXT NOT NULL DEFAULT 'speedtest',
    error          TEXT
);
CREATE INDEX IF NOT EXISTS idx_measured_at ON measurement(measured_at DESC);
"""

# 10 MB reichen, um eine Leitung grob einzuordnen, ohne das Volumen zu belasten.
FALLBACK_URL = "https://speed.cloudflare.com/__down?bytes=10000000"
FALLBACK_BYTES = 10_000_000


def connect():
    os.makedirs(DATA_DIR, exist_ok=True)
    connection = sqlite3.connect(DB_FILE, timeout=20)
    connection.row_factory = sqlite3.Row
    connection.executescript(SCHEMA)
    return connection


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def measure_speedtest():
    """speedtest-cli --json. Bricht nach 4 Minuten ab, damit ein hängender Server
    nicht den Timer blockiert."""
    binary = shutil.which("speedtest-cli") or shutil.which("speedtest")
    if not binary:
        return None
    try:
        result = subprocess.run([binary, "--json", "--secure"],
                                capture_output=True, text=True, timeout=240, check=False)
    except (OSError, subprocess.SubprocessError) as error:
        return {"error": f"speedtest fehlgeschlagen: {error}", "method": "speedtest"}
    if result.returncode != 0:
        return {"error": (result.stderr or "unbekannter Fehler").strip()[:300],
                "method": "speedtest"}
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return {"error": "Antwort war kein JSON", "method": "speedtest"}
    return {
        "download_mbps": round(data.get("download", 0) / 1_000_000, 2),
        "upload_mbps": round(data.get("upload", 0) / 1_000_000, 2),
        "ping_ms": round(data.get("ping", 0), 1),
        "server": (data.get("server") or {}).get("sponsor"),
        "method": "speedtest",
    }


def measure_fallback():
    """Reiner Download-Test. Kein Upload, keine Serverwahl — nur eine Hausnummer."""
    started = time.monotonic()
    downloaded = 0
    try:
        request = urllib.request.Request(FALLBACK_URL, headers={"User-Agent": "pi-home-stack"})
        with urllib.request.urlopen(request, timeout=120) as response:
            while True:
                chunk = response.read(65536)
                if not chunk:
                    break
                downloaded += len(chunk)
                if downloaded >= FALLBACK_BYTES:
                    break
    except Exception as error:  # noqa: BLE001 - jede Netzstörung ist ein Messergebnis
        return {"error": f"Download-Test fehlgeschlagen: {error}", "method": "http"}
    elapsed = max(time.monotonic() - started, 0.001)
    return {
        "download_mbps": round((downloaded * 8) / elapsed / 1_000_000, 2),
        "upload_mbps": None,
        "ping_ms": None,
        "server": "cloudflare",
        "method": "http",
    }


def run_measurement(verbose=False):
    result = measure_speedtest()
    if result is None or result.get("error"):
        if result and verbose:
            print(f"speedtest nicht nutzbar: {result['error']}", file=sys.stderr)
        result = measure_fallback()

    connection = connect()
    connection.execute(
        "INSERT INTO measurement (measured_at, download_mbps, upload_mbps, ping_ms, "
        "server, method, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (now_iso(), result.get("download_mbps"), result.get("upload_mbps"),
         result.get("ping_ms"), result.get("server"), result.get("method", "unknown"),
         result.get("error")),
    )
    # Alte Messwerte fallen nach einem Jahr raus; die DB soll auf einer SD-Karte
    # nicht unbegrenzt wachsen.
    cutoff = (datetime.now(timezone.utc) - timedelta(days=365)).isoformat(timespec="seconds")
    connection.execute("DELETE FROM measurement WHERE measured_at < ?", (cutoff,))
    connection.commit()
    connection.close()

    if verbose:
        print(json.dumps(result, indent=1))
    return 1 if result.get("error") else 0


# ── Kleine API ───────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def _send(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 - vorgegeben von BaseHTTPRequestHandler
        path = self.path.split("?")[0].rstrip("/") or "/"
        connection = connect()
        try:
            if path in ("/", "/latest"):
                row = connection.execute(
                    "SELECT * FROM measurement ORDER BY measured_at DESC LIMIT 1").fetchone()
                self._send(dict(row) if row else {})
            elif path == "/history":
                rows = connection.execute(
                    "SELECT measured_at, download_mbps, upload_mbps, ping_ms "
                    "FROM measurement ORDER BY measured_at DESC LIMIT 500").fetchall()
                self._send([dict(r) for r in rows])
            elif path == "/health":
                self._send({"status": "ok"})
            else:
                self._send({"error": "not found"}, 404)
        finally:
            connection.close()

    def log_message(self, *_args):
        pass  # journald bekommt die Fehler ohnehin; Zugriffe brauchen wir nicht


def serve(port):
    connect().close()
    # Nur lokal: nginx stellt die API nach außen bereit.
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"netmonitor-API auf 127.0.0.1:{port}", flush=True)
    server.serve_forever()


def main():
    parser = argparse.ArgumentParser(description="Misst und veröffentlicht die Internetgeschwindigkeit.")
    parser.add_argument("--measure", action="store_true", help="Eine Messung durchführen")
    parser.add_argument("--serve", action="store_true", help="API starten")
    parser.add_argument("--port", type=int, default=5010)
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    if args.serve:
        serve(args.port)
        return 0
    return run_measurement(verbose=args.verbose or not args.measure)


if __name__ == "__main__":
    sys.exit(main())
