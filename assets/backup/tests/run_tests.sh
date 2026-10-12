#!/usr/bin/env bash
# Runs the backup service tests. Needs neither AWS nor a credential store.
set -u
cd "$(dirname "$0")"
PY="../venv/bin/python"
[ -x "$PY" ] || PY="python3"
rc=0
for t in test_backup.py test_job.py test_api.py test_guards.py test_targets.py test_backends.py; do
    echo "=== $t ==="
    "$PY" "$t" || rc=1
done
exit $rc
