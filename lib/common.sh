#!/usr/bin/env bash
# Shared helpers: logging, guarded execution and the idempotence primitives every
# module builds on. Sourced, never executed.
#
# The rule for every helper here: running it a second time must be a no-op that
# reports "unchanged", so a module can be re-run to add or repair a feature
# without touching what already works.

# shellcheck disable=SC2034  # colour codes are used by sourcing modules

if [[ -t 1 && -z ${PHS_NO_COLOR:-} ]]; then
    C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_RED=$'\033[31m'
    C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[36m'; C_BOLD=$'\033[1m'
else
    C_RESET=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_BOLD=""
fi

DRY_RUN=${DRY_RUN:-0}
LOG_FILE=${LOG_FILE:-}

# Set by write_file/render_template: 1 when the last call actually changed something.
FILE_CHANGED=0

log_raw() {
    printf '%s\n' "$*"
    [[ -n $LOG_FILE ]] && printf '%s %s\n' "$(date -Is)" "$(strip_color "$*")" >>"$LOG_FILE"
    return 0
}

strip_color() { printf '%s' "$1" | sed -e 's/\x1b\[[0-9;]*m//g'; }

log_step()  { log_raw ""; log_raw "${C_BOLD}${C_BLUE}==>${C_RESET} ${C_BOLD}$*${C_RESET}"; }
log_info()  { log_raw "    $*"; }
log_ok()    { log_raw "    ${C_GREEN}✓${C_RESET} $*"; }
log_skip()  { log_raw "    ${C_DIM}·${C_RESET} ${C_DIM}$*${C_RESET}"; }
log_warn()  { log_raw "    ${C_YELLOW}!${C_RESET} $*"; }
log_error() { log_raw "    ${C_RED}✗${C_RESET} $*" >&2; }

die() { log_error "$*"; exit 1; }

is_dry_run() { [[ $DRY_RUN == 1 ]]; }

# Run a command, or print it in dry-run mode.
run() {
    if is_dry_run; then
        log_raw "    ${C_DIM}[dry-run] $*${C_RESET}"
        return 0
    fi
    "$@"
}

# Run and capture output, showing it only on failure — keeps apt and friends quiet
# without losing the diagnostics when something breaks.
run_quiet() {
    if is_dry_run; then
        log_raw "    ${C_DIM}[dry-run] $*${C_RESET}"
        return 0
    fi
    local out status=0
    out=$("$@" 2>&1) || status=$?
    if [[ $status -ne 0 ]]; then
        log_error "$(t 'Command failed: %s' "$*")"
        printf '%s\n' "$out" | sed 's/^/        /' >&2
        return $status
    fi
    return 0
}

require_root() {
    [[ ${EUID:-$(id -u)} -eq 0 ]] || die "$(t 'Please run with sudo: sudo %s' "$0 $*")"
}

require_cmd() {
    local cmd
    for cmd in "$@"; do
        command -v "$cmd" >/dev/null 2>&1 || die "$(t 'Required program is missing: %s' "$cmd")"
    done
}

# ── Packages ─────────────────────────────────────────────────────────────────

APT_UPDATED=0

apt_refresh() {
    [[ $APT_UPDATED == 1 ]] && return 0
    log_info "$(t 'Refreshing package lists ...')"
    run_quiet apt-get update || return 1
    APT_UPDATED=1
}

package_installed() {
    dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q "ok installed"
}

# Installs only what is genuinely missing, so a re-run costs nothing.
ensure_packages() {
    local missing=()
    local pkg
    for pkg in "$@"; do
        package_installed "$pkg" || missing+=("$pkg")
    done
    if [[ ${#missing[@]} -eq 0 ]]; then
        log_skip "$(t 'Packages already installed: %s' "$*")"
        return 0
    fi
    apt_refresh || return 1
    log_info "$(t 'Installing: %s' "${missing[*]}")"
    DEBIAN_FRONTEND=noninteractive run_quiet apt-get install -y --no-install-recommends "${missing[@]}"
}

# ── Files ────────────────────────────────────────────────────────────────────

ensure_dir() {
    local dir=$1 mode=${2:-0755} owner=${3:-root:root}
    if [[ -d $dir ]]; then
        run chmod "$mode" "$dir"
        run chown "$owner" "$dir"
        return 0
    fi
    log_info "$(t 'Creating directory: %s' "$dir")"
    run mkdir -p "$dir" && run chmod "$mode" "$dir" && run chown "$owner" "$dir"
}

# Writes stdin to a file, but only when the content differs. Sets FILE_CHANGED.
write_file() {
    local dest=$1 mode=${2:-0644} owner=${3:-root:root}
    local tmp
    tmp=$(mktemp) || return 1
    cat >"$tmp"

    FILE_CHANGED=0
    if [[ -f $dest ]] && cmp -s "$tmp" "$dest"; then
        rm -f "$tmp"
        log_skip "$(t 'unchanged: %s' "$dest")"
        return 0
    fi

    if is_dry_run; then
        log_raw "    ${C_DIM}[dry-run] $(t 'would write: %s' "$dest")${C_RESET}"
        if [[ -f $dest ]]; then
            diff -u "$dest" "$tmp" 2>/dev/null | head -20 | sed 's/^/        /' || true
        fi
        rm -f "$tmp"
        FILE_CHANGED=1
        return 0
    fi

    # Anything we did not create ourselves gets a one-time backup before we touch it.
    if [[ -f $dest && ! -f "$dest.phs-orig" ]] && ! grep -q "pi-home-stack" "$dest" 2>/dev/null; then
        cp -a "$dest" "$dest.phs-orig"
        log_info "$(t 'Original backed up: %s' "$dest.phs-orig")"
    fi

    mkdir -p "$(dirname "$dest")"
    mv "$tmp" "$dest"
    chmod "$mode" "$dest"
    chown "$owner" "$dest"
    FILE_CHANGED=1
    log_ok "$(t 'written: %s' "$dest")"
}

# Renders a template, replacing @NAME@ with the value of the environment variable NAME.
# nginx and Samba configs are full of $variables, so a $-based substitution
# (envsubst) would corrupt them — hence the @@ delimiters.
render_template() {
    local src=$1 dest=$2 mode=${3:-0644} owner=${4:-root:root}
    [[ -f $src ]] || die "$(t 'Template not found: %s' "$src")"

    local content var value
    content=$(<"$src")
    while IFS= read -r var; do
        [[ -z $var ]] && continue
        if [[ -z ${!var+x} ]]; then
            log_warn "$(t 'Template %s: placeholder @%s@ is not set' "$src" "$var")"
            value=""
        else
            value=${!var}
        fi
        content=${content//@${var}@/$value}
    done < <(grep -oE '@[A-Z_][A-Z0-9_]*@' "$src" | tr -d '@' | sort -u)

    printf '%s\n' "$content" | write_file "$dest" "$mode" "$owner"
}

# Idempotent single line in a config file, matched by a key pattern.
ensure_line() {
    local file=$1 pattern=$2 line=$3
    if [[ ! -f $file ]]; then
        run touch "$file"
    fi
    if grep -qE "$pattern" "$file" 2>/dev/null; then
        if grep -qxF "$line" "$file" 2>/dev/null; then
            log_skip "$(t 'Entry already present in %s' "$file")"
            return 0
        fi
        log_info "$(t 'Updating entry in %s' "$file")"
        run sed -i -E "s|$pattern|${line//|/\\|}|" "$file"
    else
        log_info "$(t 'Adding entry to %s' "$file")"
        is_dry_run || printf '%s\n' "$line" >>"$file"
    fi
    FILE_CHANGED=1
}

# ── systemd ──────────────────────────────────────────────────────────────────

systemd_reload() { run systemctl daemon-reload; }

unit_exists() { systemctl list-unit-files "$1" >/dev/null 2>&1 && systemctl cat "$1" >/dev/null 2>&1; }

unit_active() { systemctl is-active --quiet "$1"; }

enable_now() {
    local unit=$1
    log_info "$(t 'Enabling service: %s' "$unit")"
    run systemctl enable "$unit" >/dev/null 2>&1
    run systemctl restart "$unit"
}

# Restarts only when the unit is running and something actually changed.
restart_if_changed() {
    local unit=$1 changed=$2
    if [[ $changed == 1 ]]; then
        log_info "$(t 'Restarting service: %s' "$unit")"
        run systemctl restart "$unit"
    else
        log_skip "$(t '%s unchanged, no restart' "$unit")"
    fi
}

# ── Misc ─────────────────────────────────────────────────────────────────────

random_password() {
    local length=${1:-24}
    # Restricted alphabet on purpose: these passwords end up in smb.conf, systemd
    # units and shell one-liners, where quoting mistakes are a real risk.
    tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$length"
}

valid_username() { [[ $1 =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; }

user_exists() { id -u "$1" >/dev/null 2>&1; }

primary_ip() {
    ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1); exit}'
}

is_raspberry_pi() {
    grep -qi "raspberry pi" /proc/device-tree/model 2>/dev/null \
        || grep -qi "raspberry pi" /sys/firmware/devicetree/base/model 2>/dev/null
}

pi_model() {
    tr -d '\0' </proc/device-tree/model 2>/dev/null || echo "unbekannt"
}
