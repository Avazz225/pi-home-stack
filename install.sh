#!/usr/bin/env bash
# pi-home-stack — guided, repeatable setup of a Raspberry Pi as an ad filter,
# NAS and home dashboard.
#
# The installer is idempotent: it may be run as often as you like. A second run
# repairs what has drifted and installs only what was newly selected.
#
#   sudo ./install.sh                      guided, asks everything
#   sudo ./install.sh --features storage,samba,pihole
#   sudo ./install.sh --status             show what is installed
#   sudo ./install.sh --dry-run            show what would happen, change nothing
#   sudo ./install.sh --update             bring installed components up to date
#   sudo ./install.sh --remove netmonitor  remove one component

set -euo pipefail

PHS_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PHS_LIB_DIR="$PHS_ROOT/lib"
PHS_MODULE_DIR="$PHS_ROOT/modules"
PHS_TEMPLATE_DIR="$PHS_ROOT/templates"
PHS_ASSET_DIR="$PHS_ROOT/assets"
PHS_VENV=${PHS_VENV:-/opt/pi-home-stack/venv}
PHS_INSTALL_DIR=${PHS_INSTALL_DIR:-/opt/pi-home-stack}
export PHS_ROOT PHS_LIB_DIR PHS_MODULE_DIR PHS_TEMPLATE_DIR PHS_ASSET_DIR PHS_VENV PHS_INSTALL_DIR

# shellcheck source=lib/i18n.sh
source "$PHS_LIB_DIR/i18n.sh"
# shellcheck source=lib/common.sh
source "$PHS_LIB_DIR/common.sh"
# shellcheck source=lib/state.sh
source "$PHS_LIB_DIR/state.sh"
# shellcheck source=lib/ui.sh
source "$PHS_LIB_DIR/ui.sh"
# shellcheck source=lib/secrets.sh
source "$PHS_LIB_DIR/secrets.sh"
# shellcheck source=lib/fingerprint.sh
source "$PHS_LIB_DIR/fingerprint.sh"

# id:description — the order here is the installation order.
FEATURE_DEFS=(
    "storage:Data store — RAID 1, a single disk or an existing directory"
    "samba:Network share (SMB) for the data store"
    "pihole:Pi-hole as a network-wide ad and tracker filter"
    "nginx:Web server and reverse proxy for the interface and the APIs"
    "status:System numbers - disks, RAID, services, collected on a timer"
    "homeui:Home interface — status page with tiles and quick links"
    "backup:Encrypted off-site backup of the data store"
    "backupui:Web interface for the backup - folders, targets, credentials"
    "netmonitor:Periodic internet speed measurement"
    "apiservices:Dashboard backend services - profiles, tracking, study planning, home"
    "grafana:Grafana for dashboards and graphs"
    "dashboard:The React dashboard as the start page"
    "vault:HashiCorp Vault - secret store"
    "mdns:Reachable as <name>.local - hostname and Avahi announcement"
    "speedtest:Your own speed-test service - API and scheduled measurements"
    "duckdns:DuckDNS - keep a dynamic hostname pointed here"
    "maintenance:Automatic security updates, log rotation, config export"
)

# Was in den Fingerabdruck einer Komponente gehoert, aber nicht wortwoertlich in
# ihrem Modul steht. Die vier Dienstverzeichnisse berechnet apiservices aus einer
# Tabelle, ein grep ueber die Modulquelle findet sie deshalb nicht.
# tests/test_modules.sh prueft, dass jedes Verzeichnis unter apps/ hier von
# genau einer Komponente beansprucht wird - sonst veraltet diese Liste unbemerkt.
declare -A FEATURE_INPUTS=(
    [apiservices]="apps/quickaction apps/tracking apps/study apps/home apps/notify"
    [dashboard]="apps/dashboard"
    [speedtest]="apps/speedtest"
)

# Hard requirements between features.
declare -A FEATURE_REQUIRES=(
    [samba]="storage"
    [status]="nginx"
    [homeui]="nginx status"
    [backup]="storage nginx"
    [backupui]="backup homeui"
    [netmonitor]="nginx"
    # Die drei veröffentlichen sich über nginx. Einen Datenspeicher verlangt
    # apiservices bewusst nicht: ohne ihn legt es die Datenbanken lokal ab und
    # sagt, dass sie dann in keinem Backup liegen — das ist eine Warnung wert,
    # aber kein Grund, die Installation zu verweigern.
    [apiservices]="nginx"
    [grafana]="nginx"
    [dashboard]="nginx status"
    [vault]="nginx"
    # Nur nginx. Einen Datenspeicher verlangt speedtest bewusst NICHT — genauso
    # wie apiservices: liegt einer vor, wohnt der Dienst dort und ist damit im
    # Backup, sonst lokal unter /opt. Ihn zu verlangen hiesse, storage
    # nachzuziehen und dem Betreiber Fragen zu Platten und Dateisystemen zu
    # stellen, die mit einer Geschwindigkeitsmessung nichts zu tun haben.
    [speedtest]="nginx"
)

# Which component REPLACES another. Both interfaces claim / in the web root, and
# two start pages cannot share one address. The dashboard is the newer one and
# does everything the status page does, so homeui gives way - and backupui with
# it, because the dashboard has that view built in. Not the other way round:
# asking for homeui after the dashboard gets the module's warning and overwrites
# on purpose.
declare -A FEATURE_DISPLACES=(
    [dashboard]="backupui homeui"
)

# Features that only make sense once something else is there. They stay out of the
# interactive menu until their condition is installed, so nobody is offered a
# configuration screen for a service they do not run. Naming one explicitly with
# --features still works and pulls its requirements in.
declare -A FEATURE_OFFER_IF=(
    [backupui]="backup"
)

# True when a feature should appear in the interactive list.
feature_offered() {
    local condition=${FEATURE_OFFER_IF[$1]:-}
    [[ -z $condition ]] && return 0
    local needed
    for needed in $condition; do
        feature_installed "$needed" || return 1
    done
    return 0
}

ACTION=install
FORCE=0
SELECTED=""
REMOVE_FEATURE=""
REQUESTED_LANGUAGE=""
REQUESTED_TIMEZONE=""

usage() {
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    cat <<EOF

$(t 'Options:')
  --features LIST    $(t 'Comma separated, or "all". Asks when omitted.')
  --status           $(t 'Overview of installed components, changes nothing.')
  --update           $(t 'Bring installed components up to date with this checkout.')
  --force            $(t 'With --update: redeploy everything, not only what changed.')
  --remove ID        $(t 'Remove one component.')
  --timezone ZONE    $(t 'Set the system time zone, e.g. Europe/Berlin. Asked once on the first run.')
  --dry-run          $(t 'Change nothing, only show what would happen.')
  --unattended       $(t 'No questions (defaults and --flags must suffice).')
  --yes, -y          $(t 'Answer confirmation prompts with yes.')
  -l, --language XX  $(t 'Interface language (%s). Defaults to your locale.' "$(available_languages | tr '\n' ' ' | sed 's/ $//')")
  --no-color         $(t 'Disable ANSI colours.')
  --help, -h         $(t 'This help.')

$(t 'Available components:')
EOF
    local line
    for line in "${FEATURE_DEFS[@]}"; do
        printf '  %-12s %s\n' "${line%%:*}" "$(t "${line#*:}")"
    done
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --features)   SELECTED=${2:-}; shift 2 ;;
            --features=*) SELECTED=${1#*=}; shift ;;
            --remove)     ACTION=remove; REMOVE_FEATURE=${2:-}; shift 2 ;;
            --remove=*)   ACTION=remove; REMOVE_FEATURE=${1#*=}; shift ;;
            --timezone)   ACTION=timezone; REQUESTED_TIMEZONE=${2:-}; shift 2 ;;
            --timezone=*) ACTION=timezone; REQUESTED_TIMEZONE=${1#*=}; shift ;;
            --language|-l) REQUESTED_LANGUAGE=${2:-}; shift 2 ;;
            --language=*) REQUESTED_LANGUAGE=${1#*=}; shift ;;
            -l=*)         REQUESTED_LANGUAGE=${1#*=}; shift ;;
            --status)     ACTION=status; shift ;;
            --update)     ACTION=update; shift ;;
            --force)      FORCE=1; shift ;;
            --dry-run)    DRY_RUN=1; shift ;;
            --unattended) UNATTENDED=1; shift ;;
            --yes|-y)     ASSUME_YES=1; shift ;;
            --no-color)   PHS_NO_COLOR=1; shift ;;
            --help|-h)    ACTION=help; shift ;;
            *)            printf 'Unknown option: %s\n' "$1" >&2; ACTION=help; EXIT_CODE=2; shift ;;
        esac
    done
}

feature_known() {
    local line
    for line in "${FEATURE_DEFS[@]}"; do
        [[ ${line%%:*} == "$1" ]] && return 0
    done
    return 1
}

feature_label() {
    local line
    for line in "${FEATURE_DEFS[@]}"; do
        [[ ${line%%:*} == "$1" ]] && { t "${line#*:}"; return 0; }
    done
    printf '%s' "$1"
}

# Pulls in missing dependencies and sorts by the FEATURE_DEFS order.
#
# Fuellt dabei PULLED_IN: welche Komponente wegen welcher anderen dazukommt.
# Ohne das stand eine Komponente in "To be set up", die niemand genannt hatte,
# und stellte dann Fragen - bei storage sind das Fragen zu Platten und
# Dateisystemen, und die sind ohne Begruendung schlicht verwirrend.
resolve_features() {
    local -n _wanted=$1
    local -a expanded=()
    local item dep found

    # -g, und bewusst INNERHALB der Funktion: tests/test_features.sh zieht diese
    # Funktion einzeln mit sed aus dieser Datei, damit der Test nicht vom
    # Ausgelieferten abdriftet. Eine Deklaration auf Dateiebene fehlte dort und
    # das assoziative Feld wurde zu einem gewoehnlichen - dessen Index wird
    # arithmetisch ausgewertet, und "storage" ist keine Zahl.
    # Bei jedem Aufruf neu, damit kein Grund aus einem frueheren haengenbleibt.
    declare -gA PULLED_IN=()

    # Was der Betreiber selbst genannt hat, bekommt nie eine Begruendung.
    local -A asked_for=()
    for item in "${_wanted[@]}"; do asked_for[$item]=1; done

    local -a queue=("${_wanted[@]}")
    while [[ ${#queue[@]} -gt 0 ]]; do
        item=${queue[0]}
        queue=("${queue[@]:1}")
        found=0
        for dep in "${expanded[@]}"; do [[ $dep == "$item" ]] && found=1; done
        [[ $found == 1 ]] && continue
        expanded+=("$item")
        for dep in ${FEATURE_REQUIRES[$item]:-}; do
            queue+=("$dep")
            # Erster Nenner gewinnt - das ist der, der am naechsten an der
            # eigentlichen Auswahl liegt.
            [[ -n ${asked_for[$dep]:-} || -n ${PULLED_IN[$dep]:-} ]] || PULLED_IN[$dep]=$item
        done
    done

    local -a ordered=()
    local line id
    for line in "${FEATURE_DEFS[@]}"; do
        id=${line%%:*}
        for item in "${expanded[@]}"; do
            [[ $item == "$id" ]] && { ordered+=("$id"); break; }
        done
    done
    _wanted=("${ordered[@]}")
}

# Takes out of the selection whatever another component replaces - and removes
# what is already installed, before the new start page is written over it. Never
# silently: the operator may well have asked for homeui themselves, and a
# component that disappears without a word is a bug, not a convenience.
#
# Backwards through FEATURE_DEFS, because backupui builds on homeui: the
# interface first, then what it stands on.
apply_displacements() {
    local -n _chosen=$1
    local winner loser id line
    local -a drop=() kept=()

    for winner in "${_chosen[@]}"; do
        for loser in ${FEATURE_DISPLACES[$winner]:-}; do
            local listed=0 pick
            for pick in "${_chosen[@]}"; do [[ $pick == "$loser" ]] && listed=1; done
            if [[ $listed == 1 ]]; then
                log_warn "$(t '%s replaces %s - both want to be the start page.' \
                             "${C_BOLD}$winner${C_RESET}" "${C_BOLD}$loser${C_RESET}")"
                drop+=("$loser")
            elif feature_installed "$loser"; then
                log_warn "$(t '%s is installed and will be removed: %s takes over the start page.' \
                             "${C_BOLD}$loser${C_RESET}" "${C_BOLD}$winner${C_RESET}")"
                drop+=("$loser")
            fi
        done
    done
    [[ ${#drop[@]} -eq 0 ]] && return 0

    # Abbauen in umgekehrter Installationsreihenfolge.
    local -a order=()
    for line in "${FEATURE_DEFS[@]}"; do order+=("${line%%:*}"); done
    local i
    for (( i=${#order[@]}-1; i>=0; i-- )); do
        id=${order[$i]}
        local hit=0 d
        for d in "${drop[@]}"; do [[ $d == "$id" ]] && hit=1; done
        [[ $hit == 1 ]] || continue
        if feature_installed "$id"; then
            log_step "$(t 'Removing %s' "$id")"
            run_module "$id" remove
            state_load
            is_dry_run || { feature_unmark "$id"; state_unset "FP_$id"; }
        fi
    done

    # And out of the selection, so nothing is installed again right away.
    for id in "${_chosen[@]}"; do
        local hit=0 d
        for d in "${drop[@]}"; do [[ $d == "$id" ]] && hit=1; done
        [[ $hit == 1 ]] || kept+=("$id")
    done
    _chosen=("${kept[@]}")
}

# ── Time zone ────────────────────────────────────────────────────────────────
#
# It matters more than it looks. The heating plan is written in wall-clock time
# and compared against the clock of this machine; timestamps that services write
# in UTC are shown in local time. A Pi left on UTC therefore does not look
# broken - it looks like a heating plan that fires two hours late, which is a
# much harder thing to track down.
#
# Asked once, on the first run. Asking again on every update would be noise, and
# an installer that silently changes the clock of a machine it is updating is
# worse than one that never offers.

current_timezone() {
    local zone
    zone=$(timedatectl show -p Timezone --value 2>/dev/null) || zone=""
    [[ -n $zone ]] || zone=$(readlink -f /etc/localtime 2>/dev/null | sed 's|.*/zoneinfo/||')
    printf '%s' "${zone:-unknown}"
}

timezone_known() {
    # Checked against the system's own list rather than a pattern: "Europe/Berlin"
    # and "Europe/Berln" look equally plausible to a regular expression.
    timedatectl list-timezones 2>/dev/null | grep -qxF "$1"
}

set_timezone() {
    local zone=$1
    timezone_known "$zone" || die "$(t 'Unknown time zone: %s' "$zone")"
    run timedatectl set-timezone "$zone" || die "$(t 'Could not set the time zone.')"
    is_dry_run || state_set TIMEZONE_SET "$zone"
    log_ok "$(t 'Time zone: %s (%s)' "$zone" "$(date '+%H:%M %Z')")"
}

do_timezone() {
    [[ -n $REQUESTED_TIMEZONE ]] || die "$(t 'Which time zone? e.g. --timezone Europe/Berlin')"
    set_timezone "$REQUESTED_TIMEZONE"
}

# Offered on the first run only. A machine that has been set up once keeps its
# clock unless somebody says otherwise with --timezone.
ensure_timezone() {
    state_has TIMEZONE_SET && return 0
    local zone
    zone=$(current_timezone)
    if ! interactive; then
        # Recorded, not changed: an unattended run must not move the clock, and
        # it must not ask again on every later run either.
        is_dry_run || state_set TIMEZONE_SET "$zone"
        return 0
    fi
    log_raw ""
    log_info "$(t 'Time zone of this machine: %s (%s)' "$zone" "$(date '+%H:%M %Z')")"
    log_raw "      $(t 'The heating plan and every displayed time depend on it.')"
    if confirm "$(t 'Is that right?')" y; then
        state_set TIMEZONE_SET "$zone"
        return 0
    fi
    local wanted=""
    ask wanted "$(t 'Time zone (e.g. Europe/Berlin)')" "$zone"
    if timezone_known "$wanted"; then
        set_timezone "$wanted"
    else
        log_warn "$(t 'Unknown time zone: %s' "$wanted")"
        log_raw "      $(t 'List them with: timedatectl list-timezones')"
        log_raw "      $(t 'Set it later with: pi-home-stack --timezone ZONE')"
    fi
}

show_status() {
    banner
    log_raw ""
    log_raw "  $(t 'Model')      $(pi_model)"
    log_raw "  $(t 'Address')    $(primary_ip || t 'unknown')"
    log_raw "  $(t 'State file') $STATE_FILE"
    log_raw ""
    local line id
    for line in "${FEATURE_DEFS[@]}"; do
        id=${line%%:*}
        if feature_installed "$id"; then
            log_raw "  ${C_GREEN}●${C_RESET} ${C_BOLD}$(printf '%-12s' "$id")${C_RESET} $(t "${line#*:}")"
        elif feature_offered "$id"; then
            log_raw "  ${C_DIM}○ $(printf '%-12s' "$id") $(t "${line#*:}")${C_RESET}"
        fi
    done
    log_raw ""
    if state_has SHARE_PATH; then
        log_raw "  $(t 'Data store'): $(state_get SHARE_PATH)"
    fi
    if state_has SECRET_BACKEND; then
        secrets_init "$(state_get SECRET_BACKEND)"
        [[ $SECRET_BACKEND == vault ]] && _vault_load_env
        log_raw "  $(t 'Credentials'): $(secrets_describe)"
    fi
    log_raw ""
}

run_module() {
    local id=$1 phase=$2
    local file="$PHS_MODULE_DIR/$id.sh"
    [[ -f $file ]] || die "$(t 'Module is missing: %s' "$file")"
    # Each module runs in a subshell so variables cannot leak between modules.
    # State is shared deliberately through the state file, not the environment.
    (
        # Und deshalb muss sie hier neu eingelesen werden. state_set schreibt die
        # Datei sofort, aktualisiert aber nur die STATE-Kopie der eigenen Subshell
        # — die der Elternshell bleibt stehen, und das nächste Modul erbt die
        # veraltete. Ohne dieses state_load sah samba das SHARE_DATA_DIR nicht,
        # das storage unmittelbar davor gesetzt hatte.
        state_load
        # shellcheck source=/dev/null
        source "$file"
        case $phase in
            install) module_install ;;
            remove)  module_remove ;;
            # Nur wenn das Modul eine Migration mitbringt. Die Mehrheit tut das
            # nicht, und ein fehlender Haken ist kein Fehler.
            migrate) declare -F module_migrate >/dev/null && module_migrate || true ;;
        esac
    )
}

# Base packages and the shared venv. Runs before anything else, because even
# choosing a credential store needs Python.
# Which dashboard panes have a backend on this machine.
#
# Written after the module loop, not inside a module: installing backup later
# has to make its pane appear, and the backup module knows nothing about the
# dashboard. Derived from the nginx locations that were actually configured
# rather than from the feature list, which is the more honest signal - if
# apiservices skipped the home service for want of Python 3.14, there is no
# /home-api/ and the pane should stay away.
#
# The frontend treats a missing or unreadable file as "show everything", so a
# failure here degrades to the previous behaviour instead of an empty dropdown.
write_pane_manifest() {
    # Im Probelauf wird nichts markiert, feature_installed waere also immer
    # falsch und der Probelauf koennte gerade diesen Schritt nicht zeigen. Die
    # Auswahl dieses Laufs zaehlt deshalb mit.
    local in_run=0 f
    for f in "$@"; do [[ $f == dashboard ]] && in_run=1; done
    feature_installed dashboard || [[ $in_run == 1 ]] || return 0

    local web_root
    web_root=$(state_get WEB_ROOT /var/www/pi-home)
    [[ -n $web_root ]] || return 0

    # pane:route - several panes may share one route, quicklinks and the todo
    # list both live in the profile service.
    #
    # pane:@feature for what has no route: the system pane reads a file in the
    # web root that a timer writes. nginx knows nothing about it, so here the
    # component itself has to decide.
    local -a map=(
        "system:@status"
        "network_speed:/speedtest-api/"
        "network_speed:/netmon-api/"
        "to_do_list:/profile-api/"
        "quick_links:/profile-api/"
        "feature_tracking:/tracking-api/"
        "study:/study-api/"
        "home:/home-api/"
        "backup:/backup-api/"
    )

    # Ueberschreibbar, damit die Funktion ohne nginx pruefbar ist.
    local snippets=${PHS_NGINX_SNIPPET_DIR:-/etc/nginx/pi-home-stack}
    local -a panes=()
    local entry pane route seen p
    for entry in "${map[@]}"; do
        pane=${entry%%:*}
        route=${entry#*:}
        seen=0
        for p in ${panes[*]-}; do [[ $p == "$pane" ]] && seen=1; done
        [[ $seen == 1 ]] && continue
        if [[ $route == @* ]]; then
            local needed=${route#@} in_this_run=0
            for f in "$@"; do [[ $f == "$needed" ]] && in_this_run=1; done
            { feature_installed "$needed" || [[ $in_this_run == 1 ]]; } && panes+=("$pane")
        else
            grep -rqF "location $route" "$snippets"/ 2>/dev/null && panes+=("$pane")
        fi
    done

    local json="{\"panes\": ["
    local first=1
    for pane in ${panes[*]-}; do
        [[ $first == 1 ]] || json+=", "
        json+="\"$pane\""
        first=0
    done
    json+="]}"

    if is_dry_run; then
        log_raw "    ${C_DIM}[dry-run] $(t 'would write %s' "$web_root/features.json")${C_RESET}"
        log_raw "    ${C_DIM}$json${C_RESET}"
        return 0
    fi
    printf '%s\n' "$json" | write_file "$web_root/features.json" 0644 www-data:www-data
    log_info "$(t 'Panes with a backend: %s' "${panes[*]:-none}")"
}

bootstrap_runtime() {
    log_step "$(t 'Foundations')"
    ensure_timezone
    ensure_packages ca-certificates curl python3 python3-venv rsync
    ensure_dir "$PHS_INSTALL_DIR" 0755

    if [[ -x "$PHS_VENV/bin/python3" ]]; then
        log_skip "$(t 'Python environment present: %s' "$PHS_VENV")"
    else
        log_info "$(t 'Creating the Python environment: %s' "$PHS_VENV")"
        run python3 -m venv "$PHS_VENV" || die "$(t 'Could not create the venv.')"
    fi

    # The installer copies itself, so 'pi-home-stack' keeps working even after the
    # checked-out repository is deleted.
    #
    # Which is exactly why 'pi-home-stack' runs FROM that copy: PHS_ROOT is then
    # /opt/pi-home-stack/src, and a git pull in the checkout changes nothing
    # about it. That is a trap - you pull a fix, run 'pi-home-stack --update' and
    # get the same error, because the fix never arrives. So it is said out loud
    # instead of copying the directory onto itself.
    local installed_src
    installed_src=$(cd "$PHS_INSTALL_DIR/src" 2>/dev/null && pwd || echo '')
    if [[ -n $installed_src && $installed_src == "$PHS_ROOT" ]]; then
        log_info "$(t 'Running from the installed copy %s' "$PHS_ROOT")"
        log_raw "      $(t 'A newer checkout is not picked up here - run ./install.sh from it.')"
    elif ! is_dry_run; then
        # node_modules und venv bleiben draussen: ein Dashboard-Checkout
        # schleppt eine halbe Gigabyte Abhaengigkeiten mit, die auf dem Pi
        # nichts zu suchen haben - gebraucht wird nur apps/dashboard/build.
        #
        # '/tests' is anchored on purpose - here '/' means the root of the
        # transfer. Without the slash the pattern applies on EVERY level and took
        # assets/backup/tests with it; the backup module copies those service
        # tests onto the Pi, then could not find them and brought the whole
        # installation down. The other patterns stay unanchored, because
        # node_modules and __pycache__ can turn up anywhere.
        rsync -a --delete --exclude '.git' --exclude '/tests' \
            --exclude 'node_modules' --exclude 'venv' --exclude '__pycache__' \
            "$PHS_ROOT/" "$PHS_INSTALL_DIR/src/"
        install -m 0755 "$PHS_ROOT/bin/pi-home-stack" /usr/local/bin/pi-home-stack
        log_ok "$(t 'Command available: pi-home-stack')"
    fi
}

# Installs whatever the chosen backend needs.
ensure_backend_deps() {
    case $SECRET_BACKEND in
        kdbx)
            if "$PHS_VENV/bin/python3" -c "import pykeepass" 2>/dev/null; then
                log_skip "$(t 'pykeepass present')"
            else
                log_info "$(t 'Installing pykeepass ...')"
                # libffi/argon2 need build tools when no wheel matches this platform.
                ensure_packages build-essential libffi-dev python3-dev
                run_quiet "$PHS_VENV/bin/pip" install --upgrade pip
                run_quiet "$PHS_VENV/bin/pip" install pykeepass \
                    || die "$(t 'Could not install pykeepass.')"
            fi ;;
        vault)
            : ;;  # vault_api.py only needs the standard library
    esac
}

setup_secret_backend() {
    SECRET_BACKEND=$(state_get SECRET_BACKEND)
    if [[ -z $SECRET_BACKEND ]]; then
        log_raw ""
        log_raw "    ${C_BOLD}$(t 'Where should credentials be kept?')${C_RESET}"
        log_raw "    ${C_DIM}$(t 'The stack generates several passwords (SMB, Pi-hole, backup key).')${C_RESET}"
        ask_choice SECRET_BACKEND "$(t 'Choose a credential store')" \
            "kdbx:$(t 'KeePass file on the Pi - you remember one master password (recommended)')" \
            "vault:$(t 'HashiCorp Vault - for homelabs already running one')" \
            "none:$(t 'No store - passwords are shown once')"
    fi
    secrets_init "$SECRET_BACKEND"
    ensure_backend_deps
    secrets_configure
    is_dry_run || state_set SECRET_BACKEND "$SECRET_BACKEND"
    secrets_unlock
}

do_install() {
    banner
    is_dry_run && log_warn "$(t 'Dry run - nothing will be changed.')"

    if ! is_raspberry_pi; then
        log_warn "$(t 'This does not look like a Raspberry Pi (%s).' "$(pi_model)")"
        confirm "$(t 'Continue anyway?')" n || exit 0
    fi

    local -a chosen=()
    if [[ -n $SELECTED ]]; then
        if [[ ${SELECTED,,} == all ]]; then
            local line
            for line in "${FEATURE_DEFS[@]}"; do chosen+=("${line%%:*}"); done
        else
            IFS=',' read -r -a chosen <<<"$SELECTED"
        fi
        local f
        for f in "${chosen[@]}"; do
            feature_known "$f" || die "$(t 'Unknown component: %s' "$f")"
        done
    else
        ask_features FEATURE_DEFS chosen
    fi

    [[ ${#chosen[@]} -eq 0 ]] && { log_warn "$(t 'Nothing selected.')"; exit 0; }

    resolve_features chosen
    log_raw ""
    # Before the list, so "To be set up" is already true.
    apply_displacements chosen
    [[ ${#chosen[@]} -eq 0 ]] && { log_warn "$(t 'Nothing selected.')"; exit 0; }
    log_info "$(t 'To be set up: %s' "${C_BOLD}${chosen[*]}${C_RESET}")"
    # Jede nachgezogene Komponente mit ihrem Grund, damit ihre Rueckfragen
    # nicht aus dem Nichts kommen.
    local pulled
    for pulled in "${chosen[@]}"; do
        [[ -n ${PULLED_IN[$pulled]:-} ]] \
            && log_raw "      $(t '%s comes along because %s needs it' \
                                 "${C_BOLD}$pulled${C_RESET}" "${PULLED_IN[$pulled]}")"
    done

    bootstrap_runtime

    # The credential store is unlocked up front so the password prompt does not
    # appear in the middle of an ongoing installation.
    setup_secret_backend

    local id
    for id in "${chosen[@]}"; do
        log_step "$(feature_label "$id")"
        run_module "$id" install
        # Zuerst nachladen, dann markieren — nicht umgekehrt. feature_mark geht
        # über state_set/state_save, und das schreibt das ganze STATE-Array
        # dieser Shell. Darin fehlt alles, was die Modul-Subshell soeben gesetzt
        # hat: markieren vor dem Nachladen überschreibt es wieder. Sichtbar wurde
        # das daran, dass samba das SHARE_DATA_DIR nicht fand, das storage
        # unmittelbar davor geschrieben hatte — und nur beim ersten Lauf, weil
        # feature_mark bei einem schon markierten Feature gar nicht schreibt.
        state_load
        if ! is_dry_run; then
            feature_mark "$id"
            # Erst jetzt, nach dem erfolgreichen Lauf: ein abgebrochener
            # Durchgang darf nicht als aktuell gelten.
            state_set "FP_$id" "$(feature_fingerprint "$id" ${FEATURE_INPUTS[$id]:-})"
        fi
    done

    write_pane_manifest "${chosen[@]}"

    print_summary "${chosen[@]}"
}

# Brings what is installed into line with this checkout.
#
# Two separate questions, and conflating them is the mistake to avoid:
#
#   does it need migrating?  a layout or format changed, and data has to move.
#                            The module answers that itself in module_migrate;
#                            modules without one are skipped.
#   does it need redeploying? the content fingerprint differs from the one
#                            recorded at install time.
#
# Only components whose fingerprint moved are touched, so an update after a
# small change is quiet. A component installed before fingerprints existed has
# none recorded and counts as changed once - which is correct, nobody knows what
# it was built from.
do_update() {
    banner
    log_raw ""

    local line id
    local -a installed=()
    for line in "${FEATURE_DEFS[@]}"; do
        id=${line%%:*}
        feature_installed "$id" && installed+=("$id")
    done
    if [[ ${#installed[@]} -eq 0 ]]; then
        log_warn "$(t 'Nothing is installed yet - run the installer first.')"
        exit 0
    fi

    # An installation from before this rule may have both interfaces marked.
    # Resolved here rather than in the module: otherwise the dashboard overwrites
    # homeui's files and leaves behind a component that counts as installed and
    # serves nothing.
    apply_displacements installed

    # Pull in hard requirements that did not exist on the last run. status was
    # split out of homeui, so an older installation has the collector but does
    # not know the component.
    local -a before=("${installed[@]}")
    resolve_features installed
    local item known
    for item in "${installed[@]}"; do
        known=0
        for id in "${before[@]}"; do [[ $id == "$item" ]] && known=1; done
        [[ $known == 1 ]] && continue
        log_info "$(t '%s is new and comes along because %s needs it' \
                     "${C_BOLD}$item${C_RESET}" "${PULLED_IN[$item]:-?}")"
    done

    local -a stale=() current=()
    local want have
    for id in "${installed[@]}"; do
        want=$(feature_fingerprint "$id" ${FEATURE_INPUTS[$id]:-})
        have=$(state_get "FP_$id")
        if [[ $FORCE == 1 || -z $have || $want != "$have" ]]; then
            stale+=("$id")
        else
            current+=("$id")
        fi
    done

    [[ ${#current[@]} -gt 0 ]] && log_skip "$(t 'Up to date: %s' "${current[*]}")"
    if [[ ${#stale[@]} -eq 0 ]]; then
        log_ok "$(t 'Everything is up to date.')"
        exit 0
    fi
    log_info "$(t 'To be updated: %s' "${C_BOLD}${stale[*]}${C_RESET}")"
    [[ $FORCE == 1 ]] && log_raw "      $(t '--force was given, so nothing was compared.')"

    bootstrap_runtime
    setup_secret_backend

    for id in "${stale[@]}"; do
        log_step "$(feature_label "$id")"
        run_module "$id" migrate
        state_load
        run_module "$id" install
        state_load
        if ! is_dry_run; then
            # Mark it too: an update can bring a component in for the first
            # time (a pulled-in requirement), and unmarked it counts nowhere -
            # the pane manifest included.
            feature_mark "$id"
            state_set "FP_$id" "$(feature_fingerprint "$id" ${FEATURE_INPUTS[$id]:-})"
        fi
    done

    write_pane_manifest "${stale[@]}"

    log_raw ""
    log_ok "$(t 'Updated: %s' "${stale[*]}")"
}

do_remove() {
    feature_known "$REMOVE_FEATURE" || die "$(t 'Unknown component: %s' "$REMOVE_FEATURE")"
    if ! feature_installed "$REMOVE_FEATURE"; then
        log_warn "$(t '%s is not recorded as installed.' "$REMOVE_FEATURE")"
    fi

    # Never remove something another installed feature builds on.
    local other deps
    for other in "${!FEATURE_REQUIRES[@]}"; do
        feature_installed "$other" || continue
        deps=" ${FEATURE_REQUIRES[$other]} "
        if [[ $deps == *" $REMOVE_FEATURE "* ]]; then
            die "$(t '%s builds on %s - remove %s first.' "$other" "$REMOVE_FEATURE" "$other")"
        fi
    done

    banner
    log_warn "$(t 'About to remove: %s' "$(feature_label "$REMOVE_FEATURE")")"
    confirm "$(t 'Really remove it?')" n || exit 0
    secrets_init "$(state_get SECRET_BACKEND none)"
    log_step "$(t 'Removing %s' "$REMOVE_FEATURE")"
    run_module "$REMOVE_FEATURE" remove
    state_load
    is_dry_run || { feature_unmark "$REMOVE_FEATURE"; state_unset "FP_$REMOVE_FEATURE"; }
    log_ok "$(t '%s removed.' "$REMOVE_FEATURE")"
}

print_summary() {
    local ip
    ip=$(primary_ip || echo "<pi-address>")
    log_raw ""
    log_raw "${C_BOLD}${C_GREEN}  $(t 'Done.')${C_RESET}"
    log_raw ""
    local id
    for id in "$@"; do
        case $id in
            samba)      log_raw "  $(printf '%-18s' "$(t 'Network share')")\\\\$ip\\$(state_get SHARE_NAME nas)" ;;
            pihole)     log_raw "  $(printf '%-18s' "Pi-hole")http://$ip/admin" ;;
            homeui)     log_raw "  $(printf '%-18s' "$(t 'Home interface')")http://$ip/" ;;
            backup)     log_raw "  $(printf '%-18s' "$(t 'Backup API')")http://$ip/backup-api/status" ;;
            backupui)   log_raw "  $(printf '%-18s' "$(t 'Backup interface')")http://$ip/backup/" ;;
            netmonitor) log_raw "  $(printf '%-18s' "$(t 'Network API')")http://$ip/netmon-api/latest" ;;
        esac
    done
    log_raw ""
    secrets_print_plaintext
    case $SECRET_BACKEND in
        kdbx)
            log_raw "  ${C_BOLD}$(t 'Credentials live in the vault:')${C_RESET} $VAULT_FILE"
            log_raw "  ${C_YELLOW}$(t 'Back this file up off the Pi.')${C_RESET} $(t 'Without it and your master')"
            log_raw "  $(t 'password the generated credentials cannot be recovered.')"
            log_raw "" ;;
        vault)
            log_raw "  ${C_BOLD}$(t 'Credentials live in Vault:')${C_RESET} $(secrets_describe)"
            log_raw "  $(t 'The Pi only holds the AppRole credentials in %s.' "$VAULT_ENV_FILE")"
            log_raw "  $(t 'If the Pi is lost, revoking that AppRole is enough.')"
            log_raw "" ;;
    esac
    local id gated condition unlocked=()
    for id in "${!FEATURE_OFFER_IF[@]}"; do
        feature_installed "$id" && continue
        gated=1
        for condition in ${FEATURE_OFFER_IF[$id]}; do
            feature_installed "$condition" || gated=0
        done
        [[ $gated == 1 ]] && unlocked+=("$id")
    done
    if [[ ${#unlocked[@]} -gt 0 ]]; then
        log_raw "  $(t 'Now available: %s' "${C_BOLD}${unlocked[*]}${C_RESET}")"
        log_raw "  $(t 'Add it with:')     sudo pi-home-stack --features ${unlocked[0]}"
        log_raw ""
    fi
    log_raw "  $(t 'Status any time:')  sudo pi-home-stack --status"
    log_raw "  $(t 'Add components:')   sudo pi-home-stack --features <id>"
    log_raw ""
}

main() {
    EXIT_CODE=0
    parse_args "$@"
    load_language "$REQUESTED_LANGUAGE"
    export PHS_NO_COLOR
    state_load

    case $ACTION in
        help)   usage; exit "${EXIT_CODE:-0}" ;;
        status) show_status; exit 0 ;;
    esac

    # A dry run changes nothing, so it does not need root - that makes it usable
    # as a preview before anyone types sudo.
    is_dry_run || require_root "$@"
    if is_dry_run; then
        # Auch kein Dateilog: /var/log ist ohne root nicht beschreibbar, und ein
        # gesetztes LOG_FILE ohne anlegbare Datei lässt log_raw scheitern. Leer
        # lassen heißt: nur auf die Konsole schreiben.
        LOG_FILE=""
    else
        LOG_FILE=/var/log/pi-home-stack.log
        mkdir -p "$(dirname "$LOG_FILE")"
        touch "$LOG_FILE"
        chmod 0640 "$LOG_FILE"
    fi

    case $ACTION in
        install)  do_install ;;
        remove)   do_remove ;;
        update)   do_update ;;
        timezone) do_timezone ;;
    esac
}

main "$@"
