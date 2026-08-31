#!/usr/bin/env bash
# Feature graph: dependency resolution, install order, and the conditional
# visibility that keeps an interface out of the menu until its service is there.
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

export PHS_LIB_DIR="$ROOT/lib"
export STATE_DIR="$WORK"
export STATE_FILE="$WORK/stack.env"
export PHS_NO_COLOR=1
DRY_RUN=0

# shellcheck source=../lib/i18n.sh
source "$ROOT/lib/i18n.sh"
# shellcheck source=../lib/common.sh
source "$ROOT/lib/common.sh"
# shellcheck source=../lib/state.sh
source "$ROOT/lib/state.sh"
load_language en

fail=0
check() {
    if [[ $2 == "$3" ]]; then
        printf 'PASS  %s\n' "$1"
    else
        printf 'FAIL  %s\n        expected: %q\n        got:      %q\n' "$1" "$3" "$2"
        fail=1
    fi
}

# Pull the feature graph out of install.sh rather than restating it here, so the
# test cannot drift away from what actually ships.
eval "$(sed -n '/^FEATURE_DEFS=(/,/^)/p' "$ROOT/install.sh")"
eval "$(sed -n '/^declare -A FEATURE_REQUIRES=(/,/^)/p' "$ROOT/install.sh")"
eval "$(sed -n '/^declare -A FEATURE_OFFER_IF=(/,/^)/p' "$ROOT/install.sh")"
eval "$(sed -n '/^feature_offered()/,/^}/p' "$ROOT/install.sh")"
eval "$(sed -n '/^resolve_features()/,/^}/p' "$ROOT/install.sh")"

state_load

# ── Dependency resolution ────────────────────────────────────────────────────
selection=(backup)
resolve_features selection
check "backup pulls in its requirements" "${selection[*]}" "storage nginx backup"

selection=(backupui)
resolve_features selection
check "backupui pulls the whole chain" "${selection[*]}" "storage nginx homeui backup backupui"

selection=(samba)
resolve_features selection
check "samba pulls storage" "${selection[*]}" "storage samba"

selection=(netmonitor homeui)
resolve_features selection
check "shared requirement appears once" "${selection[*]}" "nginx homeui netmonitor"

selection=(maintenance)
resolve_features selection
check "standalone feature stays alone" "${selection[*]}" "maintenance"

selection=(backup storage)
resolve_features selection
check "explicit duplicate is not repeated" "${selection[*]}" "storage nginx backup"

# ── Conditional visibility ───────────────────────────────────────────────────
check "gated feature hidden while its service is missing" \
      "$(feature_offered backupui && echo yes || echo no)" "no"
check "ungated feature always offered" \
      "$(feature_offered backup && echo yes || echo no)" "yes"
check "ungated feature offered on a bare system" \
      "$(feature_offered storage && echo yes || echo no)" "yes"

feature_mark backup
state_load
check "gated feature appears once its service is installed" \
      "$(feature_offered backupui && echo yes || echo no)" "yes"

feature_unmark backup
state_load
check "and disappears again when it is removed" \
      "$(feature_offered backupui && echo yes || echo no)" "no"

# ── Feature bookkeeping ──────────────────────────────────────────────────────
feature_mark storage
feature_mark nginx
state_load
check "installed features recorded" "$(state_get INSTALLED_FEATURES)" "storage nginx"
check "feature_installed is true for a recorded one" \
      "$(feature_installed storage && echo yes || echo no)" "yes"
check "feature_installed is false for another" \
      "$(feature_installed samba && echo yes || echo no)" "no"
feature_mark storage
state_load
check "marking twice does not duplicate" "$(state_get INSTALLED_FEATURES)" "storage nginx"
feature_unmark storage
state_load
check "unmark removes only that one" "$(state_get INSTALLED_FEATURES)" "nginx"

# A substring must not count as installed.
feature_mark backupui
state_load
check "backup is not implied by backupui" \
      "$(feature_installed backup && echo yes || echo no)" "no"

# ── Every declared feature has a module ──────────────────────────────────────
missing=0
for line in "${FEATURE_DEFS[@]}"; do
    id=${line%%:*}
    if [[ ! -f "$ROOT/modules/$id.sh" ]]; then
        printf 'FAIL  no module for feature %s\n' "$id"; missing=1
    elif ! grep -q 'module_install()' "$ROOT/modules/$id.sh" \
       || ! grep -q 'module_remove()' "$ROOT/modules/$id.sh"; then
        printf 'FAIL  module %s lacks install/remove\n' "$id"; missing=1
    fi
done
[[ $missing == 0 ]] && printf 'PASS  every feature has a complete module\n'
[[ $missing == 1 ]] && fail=1

# ── Every requirement names a real feature ───────────────────────────────────
bad=0
for id in "${!FEATURE_REQUIRES[@]}" "${!FEATURE_OFFER_IF[@]}"; do
    for needed in ${FEATURE_REQUIRES[$id]:-} ${FEATURE_OFFER_IF[$id]:-}; do
        found=0
        for line in "${FEATURE_DEFS[@]}"; do
            [[ ${line%%:*} == "$needed" ]] && found=1
        done
        [[ $found == 0 ]] && { printf 'FAIL  %s references unknown feature %s\n' "$id" "$needed"; bad=1; }
    done
done
[[ $bad == 0 ]] && printf 'PASS  all requirements reference real features\n'
[[ $bad == 1 ]] && fail=1

# A gated feature must also require what it is gated on, or selecting it
# explicitly would install a UI without its service.
for id in "${!FEATURE_OFFER_IF[@]}"; do
    for needed in ${FEATURE_OFFER_IF[$id]}; do
        if [[ " ${FEATURE_REQUIRES[$id]:-} " != *" $needed "* ]]; then
            printf 'FAIL  %s is gated on %s but does not require it\n' "$id" "$needed"; fail=1
        fi
    done
done
[[ $fail == 0 ]] && printf 'PASS  gated features require what they are gated on\n'

echo
[[ $fail == 0 ]] && echo "Alle Tests bestanden." || echo "Fehler aufgetreten."
exit $fail
