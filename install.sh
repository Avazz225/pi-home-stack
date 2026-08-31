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

# id:description — the order here is the installation order.
FEATURE_DEFS=(
    "storage:Data store — RAID 1, a single disk or an existing directory"
    "samba:Network share (SMB) for the data store"
    "pihole:Pi-hole as a network-wide ad and tracker filter"
    "nginx:Web server and reverse proxy for the interface and the APIs"
    "homeui:Home interface — status page with tiles and quick links"
    "backup:Encrypted S3 backup of the data store"
    "netmonitor:Periodic internet speed measurement"
    "maintenance:Automatic security updates, log rotation, config export"
)

# Hard requirements between features.
declare -A FEATURE_REQUIRES=(
    [samba]="storage"
    [homeui]="nginx"
    [backup]="storage nginx"
    [netmonitor]="nginx"
)

ACTION=install
SELECTED=""
REMOVE_FEATURE=""
REQUESTED_LANGUAGE=""

usage() {
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    cat <<EOF

$(t 'Options:')
  --features LIST    $(t 'Comma separated, or "all". Asks when omitted.')
  --status           $(t 'Overview of installed components, changes nothing.')
  --remove ID        $(t 'Remove one component.')
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
            --language|-l) REQUESTED_LANGUAGE=${2:-}; shift 2 ;;
            --language=*) REQUESTED_LANGUAGE=${1#*=}; shift ;;
            -l=*)         REQUESTED_LANGUAGE=${1#*=}; shift ;;
            --status)     ACTION=status; shift ;;
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
resolve_features() {
    local -n _wanted=$1
    local -a expanded=()
    local item dep found

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
        else
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
        # shellcheck source=/dev/null
        source "$file"
        case $phase in
            install) module_install ;;
            remove)  module_remove ;;
        esac
    )
}

# Base packages and the shared venv. Runs before anything else, because even
# choosing a credential store needs Python.
bootstrap_runtime() {
    log_step "$(t 'Foundations')"
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
    if ! is_dry_run; then
        rsync -a --delete --exclude '.git' --exclude 'tests' \
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
    log_info "$(t 'To be set up: %s' "${C_BOLD}${chosen[*]}${C_RESET}")"

    bootstrap_runtime

    # The credential store is unlocked up front so the password prompt does not
    # appear in the middle of an ongoing installation.
    setup_secret_backend

    local id
    for id in "${chosen[@]}"; do
        log_step "$(feature_label "$id")"
        run_module "$id" install
        is_dry_run || feature_mark "$id"
        state_load
    done

    print_summary "${chosen[@]}"
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
    is_dry_run || feature_unmark "$REMOVE_FEATURE"
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
    LOG_FILE=/var/log/pi-home-stack.log
    is_dry_run || { mkdir -p "$(dirname "$LOG_FILE")"; touch "$LOG_FILE"; chmod 0640 "$LOG_FILE"; }

    case $ACTION in
        install) do_install ;;
        remove)  do_remove ;;
    esac
}

main "$@"
