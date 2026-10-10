#!/usr/bin/env python3
"""Speed-test result API for the dashboard.

One endpoint. The dashboard's network pane fetches
<endpoint>/speed-test-results, optionally with ?limit=N, and reads the rows
positionally as plain arrays - newest first. That contract is why the response
is a list of lists rather than a list of objects: changing it would need the
dashboard rebuilt.

Binds to 127.0.0.1 by default. nginx publishes it under /speedtest-api/ (and,
for bundles built before that path existed, /api/speed-test-results), so there
is no reason to listen on the network. Set SPEEDTEST_HOST=0.0.0.0 to reach it
directly during development.
"""
import os
import sqlite3
from pathlib import Path

from flask import Flask, jsonify, request
from flask_cors import CORS

DB_PATH = Path(__file__).resolve().with_name("speed_test_result.db")
SCHEMA_PATH = Path(__file__).resolve().with_name("schema.sql")

HOST = os.environ.get("SPEEDTEST_HOST", "127.0.0.1")
PORT = int(os.environ.get("SPEEDTEST_PORT", "5000"))

COLUMNS = ("datetime", "upload", "upload_percent",
           "download", "download_percent", "sla_fullfilled")

app = Flask(__name__)
CORS(app)


def ensure_db():
    """Creates the table if it is missing, so a fresh install answers [] instead
    of raising OperationalError on every request."""
    with sqlite3.connect(DB_PATH) as connection:
        if SCHEMA_PATH.is_file():
            connection.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))


@app.get("/speed-test-results")
def speed_test_results():
    # The parameter comes straight from a select box, so anything may arrive.
    # A bad value means "no limit" rather than an error - an empty pane is
    # harder to understand than a complete one.
    limit = request.args.get("limit")
    try:
        limit = int(limit) if limit is not None else None
    except (TypeError, ValueError):
        limit = None
    if limit is not None and limit <= 0:
        limit = None

    query = f"SELECT {', '.join(COLUMNS)} FROM result ORDER BY datetime DESC"
    params = ()
    if limit is not None:
        query += " LIMIT ?"
        params = (limit,)

    with sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True) as connection:
        rows = connection.execute(query, params).fetchall()
    return jsonify([list(row) for row in rows])


@app.get("/health")
def health():
    """For a quick check that the service is up without reading the history."""
    with sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True) as connection:
        count = connection.execute("SELECT COUNT(*) FROM result").fetchone()[0]
    return jsonify({"rows": count, "database": str(DB_PATH)})


if __name__ == "__main__":
    ensure_db()
    app.run(host=HOST, port=PORT)
