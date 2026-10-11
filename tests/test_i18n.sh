#!/usr/bin/env bash
# Verifies the translation layer and that every catalogue key still exists in the
# source. A stale key is a translation that silently stopped being used.
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
export PHS_LIB_DIR="$ROOT/lib"
PHS_NO_COLOR=1
# shellcheck source=../lib/i18n.sh
source "$ROOT/lib/i18n.sh"

fail=0
check() {
    if [[ $2 == "$3" ]]; then
        printf 'PASS  %s\n' "$1"
    else
        printf 'FAIL  %s\n        erwartet: %q\n        bekommen: %q\n' "$1" "$3" "$2"
        fail=1
    fi
}

load_language en
check "english is a passthrough" "$(t 'Mounted: %s' /media/nas)" "Mounted: /media/nas"
check "english without args" "$(t 'Done.')" "Done."

load_language de
check "german translates" "$(t 'Done.')" "Fertig."
check "german substitutes" "$(t 'Mounted: %s' /media/nas)" "Eingehängt: /media/nas"
check "multiple placeholders" "$(t 'Creating RAID 1 %s from /dev/%s and /dev/%s' md0 sda sdb)" \
      "Lege RAID 1 md0 an aus /dev/sda und /dev/sdb"
check "untranslated falls back" "$(t 'Totally unknown string')" "Totally unknown string"
check "confirm letters localised" "$(t 'y')" "j"

load_language xx 2>/dev/null
check "unknown language falls back to english" "$LANGUAGE" "en"

LANG=de_DE.UTF-8 LC_ALL= LC_MESSAGES= ; check "locale detection de" "$(LANG=de_DE.UTF-8 LC_ALL= LC_MESSAGES= detect_language)" "de"
check "locale detection other" "$(LANG=fr_FR.UTF-8 LC_ALL= LC_MESSAGES= detect_language)" "en"

# Every catalogue key must still be used somewhere, or it is dead weight.
load_language de
missing=0
for key in "${!MESSAGES[@]}"; do
    if ! grep -qF -- "$key" "$ROOT"/install.sh "$ROOT"/lib/*.sh "$ROOT"/lib/backends/*.sh "$ROOT"/modules/*.sh 2>/dev/null; then
        printf 'FAIL  stale catalogue key: %q\n' "$key"
        missing=1
    fi
done
[[ $missing == 0 ]] && printf 'PASS  no stale catalogue keys (%d entries)\n' "${#MESSAGES[@]}"
[[ $missing == 1 ]] && fail=1

echo
[[ $fail == 0 ]] && echo "Alle Tests bestanden." || echo "Fehler aufgetreten."
exit $fail
