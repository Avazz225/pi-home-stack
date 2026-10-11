#!/usr/bin/env python3
"""Take one speed measurement and append it to the history.

Run from a timer, twice a day. One measurement, one row, then exit - no daemon,
so a failed run shows up in systemctl instead of hiding in a loop.

The contracted rates below are what the percentages are measured against. They
were derived from the surviving rows of the old database (upload_percent /
upload * 100 gave 40, download the same gave 175) rather than from a contract on
file - check them against yours before trusting the SLA column.
"""
import os
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

def _rate(name, fallback):
    """Contracted rate from the environment, set by the installer.

    The percentages and the SLA column are meaningless without these two
    numbers, and only the operator knows them - so the installer asks and the
    unit passes them in. A bad or missing value falls back rather than crashing
    a scheduled run; the log line then shows what was used.
    """
    raw = os.environ.get(name, "")
    try:
        value = float(raw)
    except ValueError:
        value = 0.0
    if value <= 0:
        if raw:
            print(f"{name}={raw!r} is not a usable rate, using {fallback}", file=sys.stderr)
        return fallback
    return value


CONTRACTED_UPLOAD_MBIT = _rate("SPEEDTEST_UP_MBIT", 50.0)
CONTRACTED_DOWNLOAD_MBIT = _rate("SPEEDTEST_DOWN_MBIT", 250.0)

# A measurement counts as fulfilled when BOTH directions reach this share of the
# contracted rate. The old data shows 100: a row with 244 % upload but 3 %
# download was recorded as not fulfilled.
SLA_THRESHOLD_PERCENT = 100.0

DB_PATH = Path(__file__).resolve().with_name("speed_test_result.db")
SCHEMA_PATH = Path(__file__).resolve().with_name("schema.sql")


def ensure_db(path):
    """Creates the table on first run so a fresh install needs no extra step."""
    connection = sqlite3.connect(path)
    try:
        if SCHEMA_PATH.is_file():
            connection.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
            connection.commit()
        return connection
    except Exception:
        connection.close()
        raise


def measure():
    """Returns (upload_mbit, download_mbit).

    Imported here, not at module level: without the package the error should
    name the measurement as the thing that failed, not the whole script.
    """
    try:
        import speedtest
    except ImportError as exc:
        sys.exit(f"speedtest-cli is missing ({exc}). "
                 f"Install it with: {Path(sys.executable)} -m pip install speedtest-cli")

    client = speedtest.Speedtest(secure=True)
    # Without a server the library measures against whatever it finds first,
    # and the numbers stop being comparable between runs.
    client.get_best_server()
    download_bits = client.download()
    upload_bits = client.upload()
    return upload_bits / 1_000_000, download_bits / 1_000_000


def main():
    upload, download = measure()

    upload_percent = upload / CONTRACTED_UPLOAD_MBIT * 100
    download_percent = download / CONTRACTED_DOWNLOAD_MBIT * 100
    fulfilled = int(upload_percent >= SLA_THRESHOLD_PERCENT
                    and download_percent >= SLA_THRESHOLD_PERCENT)

    row = (
        datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        round(upload, 2),
        round(upload_percent, 2),
        round(download, 2),
        round(download_percent, 2),
        fulfilled,
    )

    connection = ensure_db(DB_PATH)
    with connection:
        connection.execute(
            "INSERT INTO result (datetime, upload, upload_percent,"
            " download, download_percent, sla_fullfilled) VALUES (?,?,?,?,?,?)",
            row,
        )
    connection.close()

    print(f"{row[0]}  up {row[1]} Mbit/s ({row[2]} %)  "
          f"down {row[3]} Mbit/s ({row[4]} %)  SLA {row[5]}")


if __name__ == "__main__":
    main()
