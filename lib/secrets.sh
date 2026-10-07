#!/usr/bin/env bash
# Credential store — dispatcher over three interchangeable backends.
#
#   kdbx   KeePass file on the Pi. The operator remembers one master password.
#   vault  HashiCorp Vault (KV v2). For homelabs that already run one; the Pi holds
#          only an AppRole credential, and secrets never rest on its disk.
#   none   Nothing is stored. Generated passwords are shown once.
#
# Services never talk to the backend. Anything a daemon needs unattended is
# materialised into a root-only file (see secret_materialise), so the blast radius
# of a compromised Pi is one service credential rather than the whole store.

SECRET_BACKEND=${SECRET_BACKEND:-}
VAULT_FILE=${VAULT_FILE:-/etc/pi-home-stack/secrets.kdbx}
SECRET_DIR=${SECRET_DIR:-/etc/pi-home-stack/secrets}

secrets_python() {
    local py="${PHS_VENV:-/opt/pi-home-stack/venv}/bin/python3"
    [[ -x $py ]] || py=$(command -v python3)
    printf '%s' "$py"
}

secrets_backend_file() { printf '%s/backends/%s.sh' "${PHS_LIB_DIR}" "$1"; }

# Loads the backend implementation. Safe to call repeatedly.
secrets_init() {
    local backend=${1:-$SECRET_BACKEND}
    [[ -n $backend ]] || die "$(t 'No credential backend selected.')"
    local file
    file=$(secrets_backend_file "$backend")
    [[ -f $file ]] || die "$(t 'Unknown credential backend: %s' "$backend")"
    SECRET_BACKEND=$backend
    # shellcheck source=/dev/null
    source "$file"
}

# ── Public API — every backend implements the backend_* counterparts ─────────

secrets_configure() { backend_configure; }
secrets_unlock()    { backend_unlock; }
secrets_describe()  { backend_describe; }

# secret_ensure <title> <username> [length] -> prints the password
secret_ensure() { backend_ensure "$1" "$2" "${3:-24}"; }

# secret_store <title> <username> <password> [notes]
secret_store() { backend_store "$1" "$2" "$3" "${4:-}"; }

# secret_get <title> -> prints the password, non-zero if absent
secret_get() { backend_get "$1"; }

# Writes a single secret to a root-only file for a daemon to read. This is the only
# way a service ever gets a credential — it never learns the backend exists.
secret_materialise() {
    local title=$1 dest=$2 value=$3
    if is_dry_run; then
        log_raw "    ${C_DIM}[dry-run] $(t 'would write key file: %s' "$dest")${C_RESET}"
        return 0
    fi
    # 0711, nicht 0700: --x erlaubt das Betreten, r-- bleibt root vorbehalten.
    #
    # Mit 0700 kann ein Dienstbenutzer das Verzeichnis nicht einmal betreten,
    # und dann ist der Modus der Datei darin bedeutungslos — ein Modul, das sie
    # auf 0640 root:dienst setzt, erreicht nichts. Genau daran scheiterten
    # duckdns (pi-duckdns) und backup (pi-backup) mit "not readable", obwohl
    # beide Dateien korrekt zugeordnet waren.
    #
    # Was 0711 aufgibt: ein lokaler Benutzer kann die Dateinamen nicht mehr
    # auflisten — das konnte er mit 0700 auch nicht — aber er kann einen
    # geratenen Namen oeffnen VERSUCHEN. Darueber entscheidet dann der Modus der
    # Datei, und der ist 0600 root:root oder 0640 root:dienst. Der Schutz liegt
    # also dort, wo er hingehoert, statt an einem Verzeichnis, das ihn
    # pauschal auch dem berechtigten Dienst verweigert.
    ensure_dir "$(dirname "$dest")" 0711 root:root
    local tmp
    tmp=$(mktemp)
    chmod 0600 "$tmp"
    printf '%s' "$value" >"$tmp"
    mv "$tmp" "$dest"
    chmod 0600 "$dest"
    chown root:root "$dest"
    log_ok "$(t 'Key file written: %s (0600, root only)' "$dest")"
}

# Convenience: fetch-or-create a secret, materialise it, and report where it went.
secret_provision() {
    local title=$1 username=$2 dest=$3 length=${4:-32}
    local value
    value=$(secret_ensure "$title" "$username" "$length") || return 1
    secret_materialise "$title" "$dest" "$value"
    printf '%s' "$value"
}

# Passwords the operator has to see because nothing stored them.
SECRETS_TO_PRINT=()

secrets_note_plaintext() {
    SECRETS_TO_PRINT+=("$1: $2")
}

secrets_print_plaintext() {
    [[ ${#SECRETS_TO_PRINT[@]} -eq 0 ]] && return 0
    log_raw ""
    log_raw "  ${C_BOLD}${C_YELLOW}$(t 'These credentials are not stored anywhere:')${C_RESET}"
    local line
    for line in "${SECRETS_TO_PRINT[@]}"; do
        log_raw "    $line"
    done
    log_raw "  ${C_YELLOW}$(t 'Write them down now - they will not be shown again.')${C_RESET}"
    log_raw ""
}
