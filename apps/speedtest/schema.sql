-- Speed-test history.
--
-- Column order matters: the dashboard receives rows as plain arrays and reads
-- them positionally, so a reordering here silently mislabels the chart.
--
-- Reconstructed on 2026-10-07 after the original was lost. The layout comes
-- from the surviving 2024 database and matches the rows the API was still
-- serving that morning.
CREATE TABLE IF NOT EXISTS result (
    datetime          TEXT NOT NULL,
    upload            REAL NOT NULL,
    upload_percent    REAL NOT NULL,
    download          REAL NOT NULL,
    download_percent  REAL NOT NULL,
    sla_fullfilled    INTEGER NOT NULL
);

-- The API always sorts by time; without this every request is a full scan.
CREATE INDEX IF NOT EXISTS result_datetime ON result(datetime DESC);
