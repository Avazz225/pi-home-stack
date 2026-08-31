#!/usr/bin/env bash
# Persistent answers and installed-feature bookkeeping.
#
# Everything the user was asked once lands in STATE_FILE, so a second run can add a
# feature without asking the same questions again. The file is plain KEY='value'
# and safe to edit by hand.

STATE_DIR=${STATE_DIR:-/etc/pi-home-stack}
STATE_FILE=${STATE_FILE:-$STATE_DIR/stack.env}

declare -A STATE=()

state_load() {
    STATE=()
    [[ -f $STATE_FILE ]] || return 0
    local line key value
    while IFS= read -r line; do
        [[ $line =~ ^[[:space:]]*# ]] && continue
        [[ $line =~ ^[[:space:]]*$ ]] && continue
        [[ $line != *=* ]] && continue
        key=${line%%=*}
        value=${line#*=}
        # Strip one layer of single quotes, undoing what state_save writes.
        if [[ $value == \'*\' ]]; then
            value=${value:1:${#value}-2}
            value=${value//\'\\\'\'/\'}
        fi
        STATE[$key]=$value
    done <"$STATE_FILE"
}

state_save() {
    is_dry_run && { log_raw "    ${C_DIM}[dry-run] $(t 'would write state: %s' "$STATE_FILE")${C_RESET}"; return 0; }
    mkdir -p "$STATE_DIR"
    chmod 0755 "$STATE_DIR"
    local tmp key value
    tmp=$(mktemp)
    {
        echo "# pi-home-stack - managed by install.sh."
        echo "# Safe to edit by hand; the next run uses these values as defaults."
        echo "# Deliberately holds NO passwords - those live in the credential store."
        for key in $(printf '%s\n' "${!STATE[@]}" | sort); do
            value=${STATE[$key]}
            printf "%s='%s'\n" "$key" "${value//\'/\'\\\'\'}"
        done
    } >"$tmp"
    mv "$tmp" "$STATE_FILE"
    chmod 0644 "$STATE_FILE"
}

state_set() {
    STATE[$1]=$2
    state_save
}

state_get() {
    local key=$1 default=${2:-}
    if [[ -n ${STATE[$key]+x} ]]; then
        printf '%s' "${STATE[$key]}"
    else
        printf '%s' "$default"
    fi
}

state_has() { [[ -n ${STATE[$1]+x} && -n ${STATE[$1]} ]]; }

# ── Features ─────────────────────────────────────────────────────────────────

feature_installed() {
    local installed
    installed=" $(state_get INSTALLED_FEATURES) "
    [[ $installed == *" $1 "* ]]
}

feature_mark() {
    feature_installed "$1" && return 0
    local installed
    installed=$(state_get INSTALLED_FEATURES)
    state_set INSTALLED_FEATURES "${installed:+$installed }$1"
}

feature_unmark() {
    local installed result=() f
    installed=$(state_get INSTALLED_FEATURES)
    for f in $installed; do
        [[ $f == "$1" ]] || result+=("$f")
    done
    state_set INSTALLED_FEATURES "${result[*]-}"
}
