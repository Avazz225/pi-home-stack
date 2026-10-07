#!/usr/bin/env bash
# Credential backend: KeePass file on the Pi.
#
# The operator picks one master password and that is the only one they have to
# remember. The vault file itself must be backed up off the Pi — without it the
# generated passwords are gone.

PHS_MASTER=""

backend_describe() {
    t 'KeePass vault %s' "$VAULT_FILE"
}

backend_configure() {
    ensure_packages python3 >/dev/null 2>&1 || true
    return 0
}

_kdbx_py() { printf '%s' "${PHS_LIB_DIR}/keepass_store.py"; }

# keepass_store.py takes <command> <kdbx> <rest>, so the vault path is spliced in here
# rather than left to each call site.
_kdbx() {
    local command=$1; shift
    PHS_MASTER="$PHS_MASTER" "$(secrets_python)" "$(_kdbx_py)" "$command" "$VAULT_FILE" "$@"
}

_kdbx_usable() {
    [[ -f $VAULT_FILE ]] || return 0
    _kdbx list >/dev/null 2>&1
}

backend_unlock() {
    [[ -n $PHS_MASTER ]] && return 0

    if is_dry_run && [[ ! -f $VAULT_FILE ]]; then
        PHS_MASTER="dry-run"
        return 0
    fi

    if [[ -f $VAULT_FILE ]]; then
        if ! interactive; then
            [[ -n ${PHS_MASTER_ENV:-} ]] || die "$(t 'Non-interactive run: PHS_MASTER_ENV must be set.')"
            PHS_MASTER=$PHS_MASTER_ENV
            _kdbx_usable || die "$(t 'The master password from PHS_MASTER_ENV is wrong.')"
            return 0
        fi
        local attempt
        for attempt in 1 2 3; do
            read -r -s -p "    $(t 'Master password for %s' "$VAULT_FILE"): " PHS_MASTER
            echo
            _kdbx_usable && return 0
            log_warn "$(t 'Wrong password (attempt %s of 3).' "$attempt")"
            PHS_MASTER=""
        done
        die "$(t 'Could not open the vault.')"
    fi

    log_raw ""
    log_info "$(t 'Creating a new credential vault: %s' "$VAULT_FILE")"
    log_info "${C_BOLD}$(t 'This is the one password you have to remember.')${C_RESET}"
    log_warn "$(t 'Without this password and a copy of the file, every credential')"
    log_warn "$(t 'created in it is lost for good.')"

    if ! interactive; then
        [[ -n ${PHS_MASTER_ENV:-} ]] || die "$(t 'Non-interactive run: PHS_MASTER_ENV must be set.')"
        PHS_MASTER=$PHS_MASTER_ENV
    else
        local first second
        while :; do
            read -r -s -p "    $(t 'Choose a master password (min. 10 characters)'): " first; echo
            if [[ ${#first} -lt 10 ]]; then
                log_warn "$(t 'Too short - this is the key to everything else.')"
                continue
            fi
            read -r -s -p "    $(t 'Repeat'): " second; echo
            [[ $first == "$second" ]] && break
            log_warn "$(t 'Passwords do not match.')"
        done
        PHS_MASTER=$first
    fi

    is_dry_run && return 0
    ensure_dir "$(dirname "$VAULT_FILE")" 0755
    _kdbx init >/dev/null || die "$(t 'Could not create the vault.')"
    chmod 0600 "$VAULT_FILE"
    log_ok "$(t 'Vault created: %s' "$VAULT_FILE")"
}

backend_ensure() {
    local title=$1 username=$2 length=$3
    if is_dry_run && [[ ! -f $VAULT_FILE ]]; then
        printf 'dry-run-placeholder'
        return 0
    fi
    _kdbx ensure "$title" "$username" "$length"
}

backend_store() {
    local title=$1 username=$2 password=$3 notes=$4
    is_dry_run && return 0
    printf '%s' "$password" | _kdbx set "$title" "$username" "$notes"
    log_ok "$(t 'Stored in the vault: %s' "$title")"
}

backend_get() {
    is_dry_run && { printf 'dry-run-placeholder'; return 0; }
    _kdbx get "$1" 2>/dev/null
}
