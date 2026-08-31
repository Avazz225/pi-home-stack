#!/usr/bin/env bash
# Credential backend: none.
#
# Nothing is stored anywhere. Generated passwords are collected and printed once at
# the end of the run. Services still get their root-only key files, so the stack
# works — but a lost password can only be replaced, never recovered.

backend_describe() { t 'no vault - passwords are shown once and not stored'; }

backend_configure() {
    log_warn "$(t 'Without a vault a forgotten password cannot be recovered.')"
    log_warn "$(t 'For the backup that means: lose the key and the encrypted')"
    log_warn "$(t 'copies in S3 can never be read again.')"
    return 0
}

backend_unlock() { return 0; }

# Without a store there is nothing to look up, so each call would produce a new
# password. Callers therefore cache within a run, and the value is printed at the end.
declare -A NONE_CACHE=()

backend_ensure() {
    local title=$1 username=$2 length=$3
    if [[ -n ${NONE_CACHE[$title]+x} ]]; then
        printf '%s' "${NONE_CACHE[$title]}"
        return 0
    fi
    local password
    password=$(random_password "$length")
    NONE_CACHE[$title]=$password
    secrets_note_plaintext "$title ($username)" "$password"
    printf '%s' "$password"
}

backend_store() {
    local title=$1 username=$2 password=$3
    NONE_CACHE[$title]=$password
    secrets_note_plaintext "$title ($username)" "$password"
}

backend_get() {
    local title=$1
    [[ -n ${NONE_CACHE[$title]+x} ]] || return 1
    printf '%s' "${NONE_CACHE[$title]}"
}
