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

# ── Executable bits in the index ─────────────────────────────────────────────
#
# The repository lives on a mount that reports 0777 for everything and has
# core.fileMode=false, so git never notices the filesystem bit. The modes in the
# index are therefore whatever they were when first added — and they were 0644,
# which means a fresh clone could not run ./install.sh at all. The very first
# command in the README failed, and nothing here noticed.
#
# Checked against the index rather than the working tree, because the working
# tree says 0777 on this machine and would always pass.
missing_x=""
for f in install.sh bin/pi-home-stack \
         tests/run_tests.sh tests/test_features.sh tests/test_i18n.sh tests/test_modules.sh \
         assets/backup/tests/run_tests.sh assets/maintenance/export-config.sh \
         assets/duckdns/update.sh apps/home/install-python314.sh \
         apps/speedtest/read_db.py apps/speedtest/test.py tools/sync-backup-service.py; do
    mode=$(git -C "$ROOT" ls-files -s -- "$f" 2>/dev/null | awk '{print $1}')
    [[ -z $mode ]] && continue          # noch nicht eingecheckt: nicht hier melden
    [[ $mode == 100755 ]] || missing_x="${missing_x:+$missing_x }$f($mode)"
done
check "entry points are executable in the index" "$missing_x" ""

# Sourced files must NOT be executable - the distinction is the point. A
# module that looks runnable invites being run, and running it does nothing.
wrong_x=""
while IFS= read -r line; do
    mode=${line%% *}
    file=${line#* }
    [[ $mode == 100755 ]] && wrong_x="${wrong_x:+$wrong_x }$file"
done < <(git -C "$ROOT" ls-files -s -- lib modules 2>/dev/null \
         | awk '{print $1" "$4}' | grep -vE 'lib/lang/' || true)
check "sourced files are not executable" "$wrong_x" ""

# ── The pane manifest ────────────────────────────────────────────────────────
#
# features.json decides which panes the dashboard offers. Two kinds of entry:
# a pane with an nginx route, which is checked by looking at the snippets that
# were really written, and a pane gated on a component - the system pane reads
# a file a timer writes, and nginx knows nothing about it.
#
# Worth a test because the failure is invisible: a pane that quietly stops
# appearing looks like a design decision.
manifest=$(
    set -uo pipefail
    WORK=$(mktemp -d)
    trap 'rm -rf "$WORK"' EXIT
    export PHS_LIB_DIR="$ROOT/lib" PHS_NO_COLOR=1
    export STATE_DIR="$WORK" STATE_FILE="$WORK/stack.env"
    DRY_RUN=0
    # shellcheck source=../lib/i18n.sh
    source "$ROOT/lib/i18n.sh"
    # shellcheck source=../lib/common.sh
    source "$ROOT/lib/common.sh"
    # shellcheck source=../lib/state.sh
    source "$ROOT/lib/state.sh"
    load_language en
    state_load
    eval "$(sed -n '/^write_pane_manifest()/,/^}/p' "$ROOT/install.sh")"

    mkdir -p "$WORK/web" "$WORK/snippets"
    state_set WEB_ROOT "$WORK/web"
    export PHS_NGINX_SNIPPET_DIR="$WORK/snippets"
    printf 'location /home-api/ { }\n'  >"$WORK/snippets/50-home.conf"
    printf 'location /backup-api/ { }\n' >"$WORK/snippets/40-backup.conf"

    # status not installed and not in this run: no system pane.
    write_pane_manifest dashboard >/dev/null 2>&1
    printf 'without: %s\n' "$(cat "$WORK/web/features.json")"

    # named in the same run - the dry-run case, where nothing is marked yet.
    write_pane_manifest dashboard status >/dev/null 2>&1
    printf 'in-run: %s\n' "$(cat "$WORK/web/features.json")"

    # installed from an earlier run, not named again.
    feature_mark status
    write_pane_manifest dashboard >/dev/null 2>&1
    printf 'installed: %s\n' "$(cat "$WORK/web/features.json")"
)
check "route-based panes come from the snippets" \
      "$(grep '^without:' <<<"$manifest")" \
      'without: {"panes": ["home", "backup"]}'
check "the system pane follows the status component in this run" \
      "$(grep '^in-run:' <<<"$manifest")" \
      'in-run: {"panes": ["system", "home", "backup"]}'
check "and once it is installed" \
      "$(grep '^installed:' <<<"$manifest")" \
      'installed: {"panes": ["system", "home", "backup"]}'

# ── The self-copy ────────────────────────────────────────────────────────────
#
# install.sh copies the checkout to /opt/pi-home-stack/src, so the command keeps
# working once the clone is gone. rsync applies an exclude pattern on EVERY
# level unless it is anchored with a leading slash, and that bit for real:
# --exclude 'tests' silently took assets/backup/tests along, the backup module
# copies exactly that directory onto the Pi, and the failing cp - after it had
# already removed the old one - aborted the whole installation.
#
# The patterns are read out of install.sh and run against a small tree with all
# three cases, so this tests what ships instead of a restatement of it.
copied=$(
    set -uo pipefail
    command -v rsync >/dev/null 2>&1 || { printf 'SKIP\n'; exit 0; }
    WORK=$(mktemp -d)
    trap 'rm -rf "$WORK"' EXIT
    mkdir -p "$WORK/from/tests" "$WORK/from/assets/backup/tests" \
             "$WORK/from/apps/dashboard/node_modules/pkg" "$WORK/from/modules" \
             "$WORK/to"
    : >"$WORK/from/tests/run_tests.sh"
    : >"$WORK/from/assets/backup/tests/test_job.py"
    : >"$WORK/from/apps/dashboard/node_modules/pkg/index.js"
    : >"$WORK/from/modules/backup.sh"

    mapfile -t patterns < <(grep -o -- "--exclude '[^']*'" "$ROOT/install.sh" \
                            | sed "s/--exclude '//; s/'\$//")
    [[ ${#patterns[@]} -gt 0 ]] || { printf 'NO PATTERNS\n'; exit 0; }
    args=()
    for pattern in "${patterns[@]}"; do args+=(--exclude "$pattern"); done
    rsync -a --delete "${args[@]}" "$WORK/from/" "$WORK/to/" >/dev/null 2>&1

    ( cd "$WORK/to" && find . -type f | sed 's|^\./||' | sort | tr '\n' ' ' )
)
if [[ $copied == "SKIP" ]]; then
    printf 'SKIP  rsync not available - self-copy excludes unchecked\n'
else
    check "the self-copy keeps the backup service tests and drops its own" \
          "$copied" "assets/backup/tests/test_job.py modules/backup.sh "
fi

# ── Service code actually gets installed ─────────────────────────────────────
#
# A service whose adapter was not copied starts with an ImportError and nothing
# else - the module reports success, the unit is enabled, and the pane stays
# empty. That happened: apiservices copied a hand-written list of file names,
# shelly.py was added to apps/home and not to the list.
#
# Checked as a property, not as a line of code: every .py under a claimed apps/
# directory must be covered, either by a glob over the source or by its own
# name. Both implementations pass; a list that forgets a file does not.
uninstalled=$(python3 - "$ROOT" <<'PYEOF'
import pathlib, re, sys
root = pathlib.Path(sys.argv[1])
missing = []

# Which component claims which apps/ directory, straight out of install.sh.
inputs = {}
block = re.search(r"declare -A FEATURE_INPUTS=\((.*?)\n\)", (root / "install.sh").read_text(), re.S)
for feature, paths in re.findall(r"\[(\w+)\]=\"([^\"]*)\"", block.group(1) if block else ""):
    for path in paths.split():
        inputs[path] = feature

for path, feature in sorted(inputs.items()):
    directory = root / path
    module = root / "modules" / f"{feature}.sh"
    if not directory.is_dir() or not module.is_file():
        continue
    # Code only, comments dropped. A first attempt searched the whole module
    # and passed because a *comment* happened to mention shelly.py - prose
    # about a file is not a file being installed. Looking only at the loop line
    # was then too narrow the other way: speedtest keeps its file names in an
    # array above the loop, which is perfectly fine.
    code = "\n".join(line for line in module.read_text().splitlines()
                     if not line.strip().startswith("#"))
    globbed = "*.py" in code
    for script in sorted(directory.glob("*.py")):
        if globbed or script.name in code:
            continue
        missing.append(f"{path}/{script.name} ({feature})")
print(" ".join(missing))
PYEOF
)
check "every service .py is installed by its module" "$uninstalled" ""

# The other half of the same failure: something imported that will not be there
# at run time. An import is fine when it is the standard library, a sibling file,
# or a declared requirement - and nothing else is.
unresolved=$(python3 - "$ROOT" <<'PYEOF'
import ast, pathlib, re, sys
root = pathlib.Path(sys.argv[1])
bad = []
for main in sorted((root / "apps").glob("*/*.py")):
    folder = main.parent
    siblings = {p.stem for p in folder.glob("*.py")}
    declared = set()
    requirements = folder / "requirements.txt"
    if requirements.is_file():
        for line in requirements.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                declared.add(re.split(r"[<>=!\[;]", line)[0].strip().lower().replace("-", "_"))
    try:
        tree = ast.parse(main.read_text())
    except SyntaxError:
        continue        # the python syntax suite reports that one
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module.split(".")[0])
    # A package's import name is usually its distribution name with dashes
    # turned into underscores - flask-cors, deebot-client. Where it is not, the
    # mapping has to be written down: speedtest-cli installs a module called
    # speedtest, and no rule derives that.
    aliases = {"speedtest": "speedtest_cli"}
    for name in sorted(names):
        if name in sys.stdlib_module_names or name in siblings:
            continue
        if name.lower() in declared or aliases.get(name, "") in declared:
            continue
        bad.append(f"{folder.name}/{main.name}: {name}")
print(" ".join(bad))
PYEOF
)
check "every import is stdlib, a sibling or a declared requirement" "$unresolved" ""

# ── Every api client says who is asking ──────────────────────────────────────
#
# The services that belong to a person read X-Home-User and answer 400 without
# it. A client that forgets the header therefore fails loudly - but one that
# sends it only on writes does not: reads go out anonymous and come back as
# somebody else's data, or as an error nobody connects to the cause. Both
# happened in the first cut, because the fetch init was built only when there
# were options and a plain GET passed undefined.
#
# So: every request wrapper under src/ that talks to a user-bound service must
# name userHeaders, and must not build its init conditionally.
clients=$(python3 - "$ROOT" <<'PYEOF'
import pathlib, re, sys
root = pathlib.Path(sys.argv[1])
src = root / "apps" / "dashboard" / "src"
bad = []
# The services whose data belongs to a person. The home service is deliberately
# not in here: its floorplan is the flat's, and a wall tablet nobody signed in
# on has to keep working - but it still has to pass the header along for the
# arrangement, so it is checked all the same.
# Every client must bypass the browser cache. Only some must say who is asking:
# the gallery is the flat's picture frame and the backup is the flat's backup,
# and inventing a user for them would be a lie about whose they are.
PERSONAL = {"tracking/api.js", "study/api.js", "home/api.js", "notify/api.js",
            "common/user.js", "helpers.js"}
for rel in sorted(PERSONAL | {"gallery/api.js", "backup/api.js"}):
    path = src / rel
    if not path.is_file():
        continue
    # Comments stripped first. Twice now a check of this kind has passed
    # because the thing it looked for was mentioned in a comment rather than
    # done in the code - prose about a rule is not the rule being followed.
    text = re.sub(r"/\*.*?\*/", "", path.read_text(), flags=re.S)
    text = re.sub(r"^\s*//.*$", "", text, flags=re.M)
    # The spread inside the headers object, not merely the import: dropping
    # the call while leaving the import at the top is exactly how this would
    # regress, and a first cut of this check passed that.
    if rel in PERSONAL and "...userHeaders()" not in text:
        bad.append(f"{rel}: sendet keinen Benutzer")
        continue
    # An API answer is a fact about right now, never a document. A browser that
    # keeps one replays it - and the first thing it ever gets for a route that
    # does not exist yet is the dashboard's own page with status 200, which it
    # then serves long after the route was added. That outlived its own repair
    # once already.
    if 'cache: "no-store"' not in text:
        bad.append(f"{rel}: erlaubt dem Browser, Antworten aufzuheben")
    if re.search(r"fetch\([^)]*,\s*options\s*&&", text):
        bad.append(f"{rel}: baut das Init nur mit Optionen - GETs gehen ohne Kopf raus")
print(" ".join(bad))
PYEOF
)
check "api clients name their user and never cache an answer" "$clients" ""

exit $fail
