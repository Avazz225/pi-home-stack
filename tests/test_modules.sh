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

exit $fail
