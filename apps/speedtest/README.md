# speedtest_service

Periodic internet speed measurement with a small read API, for the dashboard's
network pane.

| File | Purpose |
|---|---|
| `test.py` | takes one measurement and appends a row |
| `read_db.py` | serves the history at `/speed-test-results` |
| `schema.sql` | the `result` table |
| `speed_test_result.db` | the history (not in the repository) |

Runs on the Pi from `<data store>/services/speedtest`, driven by
`pi-home-speedtest.service` (API) and `pi-home-speedtest-measure.timer`
(measurements at 03:23 and 23:23). The `speedtest` component of pi-home-stack
adopts the directory rather than shipping it.

## Why this directory exists

The original files lived only on the RAID and were lost on 2026-10-07 to an
`rsync --delete` with the wrong destination. They are here now so that the code
has a copy outside the machine that runs it. The measurement history is not
recoverable and starts again from the first new measurement.

## Setup

    python3 -m venv venv
    ./venv/bin/pip install -r requirements.txt
    ./venv/bin/python test.py          # one measurement, creates the database
    ./venv/bin/python read_db.py       # API on 127.0.0.1:5000

`CONTRACTED_UPLOAD_MBIT` and `CONTRACTED_DOWNLOAD_MBIT` in `test.py` are what
the percentages and the SLA column are measured against. They were derived from
the old data (40 up, 175 down) - check them against your contract.
