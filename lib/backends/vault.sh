#!/usr/bin/env bash
# Credential backend: HashiCorp Vault (KV v2).
#
# For homelabs that already run Vault. Secrets live on the Vault server, not on the
# Pi; the Pi only keeps an AppRole credential in a root-only file. That is a better
# story than the KeePass backend — a stolen SD card yields one revocable AppRole
# rather than a vault file that can be attacked offline forever.
#
# AppRole is preferred over a plain token because a token expires and a machine
# cannot renew it unattended without extra machinery.

VAULT_ENV_FILE=${VAULT_ENV_FILE:-/etc/pi-home-stack/vault.env}

backend_describe() {
    t 'HashiCorp Vault %s (%s/%s)' "${VAULT_ADDR:-?}" "${VAULT_MOUNT:-secret}" "${VAULT_PREFIX:-pi-home-stack}"
}

_vault_py() { printf '%s' "${PHS_LIB_DIR}/vault_api.py"; }

_vault() {
    VAULT_ADDR="$VAULT_ADDR" VAULT_MOUNT="$VAULT_MOUNT" VAULT_PREFIX="$VAULT_PREFIX" \
    VAULT_NAMESPACE="${VAULT_NAMESPACE:-}" VAULT_CACERT="${VAULT_CACERT:-}" \
    VAULT_SKIP_VERIFY="${VAULT_SKIP_VERIFY:-}" \
    VAULT_TOKEN="${VAULT_TOKEN:-}" VAULT_ROLE_ID="${VAULT_ROLE_ID:-}" \
    VAULT_SECRET_ID="${VAULT_SECRET_ID:-}" \
        "$(secrets_python)" "$(_vault_py)" "$@"
}

# Reads a previously stored connection so a re-run does not ask again.
_vault_load_env() {
    [[ -f $VAULT_ENV_FILE ]] || return 0
    # shellcheck source=/dev/null
    source "$VAULT_ENV_FILE"
}

_vault_save_env() {
    is_dry_run && return 0
    ensure_dir "$(dirname "$VAULT_ENV_FILE")" 0755
    local tmp
    tmp=$(mktemp); chmod 0600 "$tmp"
    {
        echo "# pi-home-stack - Vault access, including the AppRole credentials."
        echo "# Root-readable only. If the Pi is lost, revoke this AppRole in Vault."
        printf "VAULT_ADDR='%s'\n" "$VAULT_ADDR"
        printf "VAULT_MOUNT='%s'\n" "$VAULT_MOUNT"
        printf "VAULT_PREFIX='%s'\n" "$VAULT_PREFIX"
        [[ -n ${VAULT_NAMESPACE:-} ]]   && printf "VAULT_NAMESPACE='%s'\n" "$VAULT_NAMESPACE"
        [[ -n ${VAULT_CACERT:-} ]]      && printf "VAULT_CACERT='%s'\n" "$VAULT_CACERT"
        [[ -n ${VAULT_SKIP_VERIFY:-} ]] && printf "VAULT_SKIP_VERIFY='%s'\n" "$VAULT_SKIP_VERIFY"
        [[ -n ${VAULT_ROLE_ID:-} ]]     && printf "VAULT_ROLE_ID='%s'\n" "$VAULT_ROLE_ID"
        [[ -n ${VAULT_SECRET_ID:-} ]]   && printf "VAULT_SECRET_ID='%s'\n" "$VAULT_SECRET_ID"
        [[ -n ${VAULT_TOKEN:-} ]]       && printf "VAULT_TOKEN='%s'\n" "$VAULT_TOKEN"
        return 0
    } >"$tmp"
    mv "$tmp" "$VAULT_ENV_FILE"
    chmod 0600 "$VAULT_ENV_FILE"
    chown root:root "$VAULT_ENV_FILE"
    log_ok "$(t 'Vault access stored: %s (0600, root only)' "$VAULT_ENV_FILE")"
}

backend_configure() {
    _vault_load_env

    VAULT_ADDR=${VAULT_ADDR:-}
    VAULT_MOUNT=${VAULT_MOUNT:-secret}
    VAULT_PREFIX=${VAULT_PREFIX:-pi-home-stack}

    ask VAULT_ADDR "$(t 'Vault address (e.g. https://vault.lan:8200)')"
    ask VAULT_MOUNT "$(t 'KV v2 mount')" "secret"
    ask VAULT_PREFIX "$(t 'Path below the mount')" "pi-home-stack"

    if [[ $VAULT_ADDR == https://* ]]; then
        local cert_mode=""
        [[ -n ${VAULT_CACERT:-} ]] && cert_mode=ca
        [[ ${VAULT_SKIP_VERIFY:-} == 1 ]] && cert_mode=skip
        ask_choice cert_mode "$(t 'Certificate verification')" \
            "system:$(t 'Use the system CAs (public or already trusted certificate)')" \
            "ca:$(t 'Point at your own CA file')" \
            "skip:$(t 'Do not verify - only sensible on a trusted LAN')"
        case $cert_mode in
            ca)   ask VAULT_CACERT "$(t 'Path to the CA file')"; VAULT_SKIP_VERIFY="" ;;
            skip) VAULT_SKIP_VERIFY=1; VAULT_CACERT=""
                  log_warn "$(t 'Verification off - anyone on the network can impersonate Vault.')" ;;
            *)    VAULT_SKIP_VERIFY=""; VAULT_CACERT="" ;;
        esac
    fi

    local auth_mode=""
    [[ -n ${VAULT_ROLE_ID:-} ]] && auth_mode=approle
    [[ -n ${VAULT_TOKEN:-} && -z ${VAULT_ROLE_ID:-} ]] && auth_mode=token
    ask_choice auth_mode "$(t 'Authentication')" \
        "approle:$(t 'AppRole - recommended, survives reboots and can be revoked')" \
        "token:$(t 'Token - simpler, but expires eventually')"

    if [[ $auth_mode == approle ]]; then
        ask VAULT_ROLE_ID "$(t 'AppRole role_id')"
        if [[ -z ${VAULT_SECRET_ID:-} ]]; then
            ask_secret VAULT_SECRET_ID "$(t 'AppRole secret_id')"
        fi
        VAULT_TOKEN=""
    else
        if [[ -z ${VAULT_TOKEN:-} ]]; then
            ask_secret VAULT_TOKEN "$(t 'Vault token')"
        fi
        VAULT_ROLE_ID=""; VAULT_SECRET_ID=""
        log_warn "$(t 'Tokens expire. Once it does, any run that needs to look up a')"
        log_warn "$(t 'credential will fail - AppRole avoids that.')"
    fi

    export VAULT_ADDR VAULT_MOUNT VAULT_PREFIX VAULT_NAMESPACE VAULT_CACERT \
           VAULT_SKIP_VERIFY VAULT_TOKEN VAULT_ROLE_ID VAULT_SECRET_ID
}

backend_unlock() {
    is_dry_run && return 0
    log_info "$(t 'Checking the Vault connection ...')"
    local result
    if ! result=$(_vault check 2>&1); then
        log_error "$result"
        die "$(t 'Vault is unreachable or the credentials are wrong.')"
    fi
    log_ok "$(t 'Vault reachable: %s' "$result")"
    _vault_save_env
}

backend_ensure() {
    local title=$1 username=$2 length=$3
    is_dry_run && { printf 'dry-run-placeholder'; return 0; }
    _vault ensure "$title" "$username" "$length"
}

backend_store() {
    local title=$1 username=$2 password=$3 notes=$4
    is_dry_run && return 0
    printf '%s' "$password" | _vault set "$title" "$username" "$notes"
    log_ok "$(t 'Stored in Vault: %s' "${VAULT_PREFIX}/$title")"
}

backend_get() {
    is_dry_run && { printf 'dry-run-placeholder'; return 0; }
    _vault get "$1" 2>/dev/null
}
