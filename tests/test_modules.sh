#!/usr/bin/env bash
# Structural checks on the modules themselves — the kind of mistake that only
# shows up on a real Pi, and then only sometimes.
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
fail=0
check() {
    if [[ $2 == "$3" ]]; then
        printf 'PASS  %s\n' "$1"
    else
        printf 'FAIL  %s\n        expected: %q\n        got:      %q\n' "$1" "$3" "$2"
        fail=1
    fi
}

# ── Exit status of module functions ──────────────────────────────────────────
#
# install.sh runs with set -e, so a module function that ends on a conditional
# aborts the whole installation whenever that condition happens to be false.
# This bit real: apiservices ended on
#     [[ ${#skipped[@]} -gt 0 ]] && log_warn ...
# which returns 1 exactly when nothing was skipped — that is, when everything
# worked. A module must end on something that cannot fail, or on return 0.
risky=$(python3 - "$ROOT" <<'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
out = []
for p in sorted((root / "modules").glob("*.sh")):
    src = p.read_text().splitlines()
    for fn in ("module_install()", "module_remove()"):
        starts = [i for i, l in enumerate(src) if l.startswith(fn)]
        if not starts:
            continue
        start = starts[0]
        end = next(i for i in range(start + 1, len(src)) if src[i] == "}")
        last = next((src[i].strip() for i in range(end - 1, start, -1)
                     if src[i].strip() and not src[i].strip().startswith("#")), "")
        if last.startswith(("[[", "[ ")):
            out.append(f"{p.name}:{fn}")
print(" ".join(out))
PY
)
check "no module function ends on a bare conditional" "$risky" ""

# ── Every template is claimed by some module ─────────────────────────────────
#
# A template nobody renders is dead weight; worse, a template a module renders
# under a name that no longer exists fails only at install time.
unused=""
for tpl in "$ROOT"/templates/*; do
    name=$(basename "$tpl")
    grep -rqF "$name" "$ROOT"/modules/ || unused="${unused:+$unused }$name"
done
check "every template is referenced by a module" "$unused" ""

# ── Every module referenced by a feature exists ──────────────────────────────
missing=""
while IFS= read -r line; do
    id=${line%%:*}
    [[ -f "$ROOT/modules/$id.sh" ]] || missing="${missing:+$missing }$id"
done < <(sed -n '/^FEATURE_DEFS=(/,/^)/p' "$ROOT/install.sh" | sed -n 's/^    "\(.*\)"$/\1/p')
check "every feature has a module file" "$missing" ""

# ── Fingerprint inputs ──────────────────────────────────────────────────────
#
# FEATURE_INPUTS names what belongs to a component but is not spelled out in its
# module. Two ways for it to rot: an application under apps/ that nobody claims
# (its changes would never trigger an update), and a claimed path that no longer
# exists (a rename nobody followed).
export PHS_ROOT="$ROOT" PHS_LIB_DIR="$ROOT/lib" PHS_MODULE_DIR="$ROOT/modules"
export PHS_TEMPLATE_DIR="$ROOT/templates" PHS_ASSET_DIR="$ROOT/assets"
# shellcheck source=../lib/fingerprint.sh
source "$ROOT/lib/fingerprint.sh"
eval "$(sed -n '/^declare -A FEATURE_INPUTS=(/,/^)/p' "$ROOT/install.sh")"

unclaimed=""
for dir in "$ROOT"/apps/*/; do
    [[ -d $dir ]] || continue
    rel="apps/$(basename "$dir")"
    found=0
    for id in "${!FEATURE_INPUTS[@]}"; do
        for claimed in ${FEATURE_INPUTS[$id]}; do
            [[ $claimed == "$rel" ]] && found=$((found + 1))
        done
    done
    [[ $found == 1 ]] || unclaimed="${unclaimed:+$unclaimed }$rel(claimed=$found)"
done
check "every apps/ directory is claimed exactly once" "$unclaimed" ""

gone=""
for id in "${!FEATURE_INPUTS[@]}"; do
    for claimed in ${FEATURE_INPUTS[$id]}; do
        [[ -e "$ROOT/$claimed" ]] || gone="${gone:+$gone }$claimed"
    done
done
check "every claimed input exists" "$gone" ""

# ── Fingerprints are deterministic ──────────────────────────────────────────
#
# An unstable hash would make every update redeploy everything, which is the
# same as having no update logic at all.
drift=""
while IFS= read -r line; do
    id=${line%%:*}
    [[ -f "$ROOT/modules/$id.sh" ]] || continue
    a=$(feature_fingerprint "$id" ${FEATURE_INPUTS[$id]:-})
    b=$(feature_fingerprint "$id" ${FEATURE_INPUTS[$id]:-})
    [[ $a == "$b" ]] || drift="${drift:+$drift }$id"
done < <(sed -n '/^FEATURE_DEFS=(/,/^)/p' "$ROOT/install.sh" | sed -n 's/^    "\(.*\)"$/\1/p')
check "fingerprints are stable across two runs" "$drift" ""

exit $fail
