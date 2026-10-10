#!/usr/bin/env bash
# Runs everything that can be tested without a Raspberry Pi.
#
# The backup suite needs cryptography and flask. If they are not importable, that
# part is skipped rather than reported as a failure.
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
rc=0

echo "=== shell syntax ==="
for f in "$ROOT"/install.sh "$ROOT"/lib/*.sh "$ROOT"/lib/backends/*.sh \
         "$ROOT"/lib/lang/*.sh "$ROOT"/modules/*.sh "$ROOT"/bin/pi-home-stack \
         "$ROOT"/assets/maintenance/export-config.sh "$ROOT"/tests/*.sh; do
    [ -f "$f" ] || continue
    if bash -n "$f"; then
        printf 'PASS  %s\n' "${f#"$ROOT"/}"
    else
        printf 'FAIL  %s\n' "${f#"$ROOT"/}"; rc=1
    fi
done

echo
echo "=== python syntax ==="
# apps/*/ gehoert dazu, seit die Dienste im Repo liegen. node_modules bleibt
# draussen - fremder Code, und Tausende Dateien.
for f in "$ROOT"/lib/*.py "$ROOT"/assets/homeui/*.py "$ROOT"/assets/netmonitor/*.py \
         "$ROOT"/assets/backup/*.py "$ROOT"/tools/*.py "$ROOT"/apps/*/*.py; do
    [ -f "$f" ] || continue
    if python3 -m py_compile "$f" 2>/dev/null; then
        printf 'PASS  %s\n' "${f#"$ROOT"/}"
    else
        printf 'FAIL  %s\n' "${f#"$ROOT"/}"; rc=1
    fi
done
find "$ROOT" -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null

echo
echo "=== javascript syntax ==="
if command -v node >/dev/null 2>&1; then
    for f in "$ROOT"/assets/homeui/*.js "$ROOT"/assets/backupui/*.js; do
        [ -f "$f" ] || continue
        if node --check "$f" >/dev/null 2>&1; then
            printf 'PASS  %s\n' "${f#"$ROOT"/}"
        else
            printf 'FAIL  %s\n' "${f#"$ROOT"/}"; node --check "$f"; rc=1
        fi
    done
else
    echo "SKIP  node not available"
fi

# Das Dashboard ist JSX mit ES-Modulen, node --check versteht das nicht. Was
# sich ohne Node pruefen laesst, ist das Entscheidende: liegt das vorgebaute
# Bundle da? Fehlt es, kann ein Pi ohne Node das Frontend nicht installieren.
if [ -f "$ROOT/apps/dashboard/package.json" ]; then
    echo
    echo "=== dashboard bundle ==="
    if [ -f "$ROOT/apps/dashboard/build/index.html" ]; then
        printf 'PASS  %s\n' "apps/dashboard/build/index.html present"
    else
        printf 'FAIL  %s\n' "apps/dashboard/build missing - run: npm ci && CI=false npm run build"
        rc=1
    fi
fi

echo
echo "=== feature graph ==="
bash "$ROOT/tests/test_features.sh" || rc=1

echo
echo "=== i18n ==="
bash "$ROOT/tests/test_i18n.sh" || rc=1

echo
echo "=== backup service ==="
PY=python3
if ! $PY -c "import cryptography, flask" 2>/dev/null; then
    echo "SKIP  cryptography/flask not importable - install them to run these"
else
    ( cd "$ROOT/assets/backup/tests" && bash ./run_tests.sh ) || rc=1
fi

echo
[ $rc = 0 ] && echo "Alle Tests bestanden." || echo "Fehler aufgetreten."
exit $rc
