#!/usr/bin/env bash
# HashiCorp Vault als Einzelknoten.
#
# Aus HashiCorps apt-Repo, nicht als Container: das Paket bringt seine eigene
# systemd-Unit samt CAP_IPC_LOCK mit, und genau so lief es auf diesem Pi vorher
# schon. Dieses Modul schreibt deshalb nur die Konfiguration und lässt die Unit
# des Pakets in Ruhe.
#
# Was dieses Modul NICHT tut: initialisieren und entsiegeln. 'vault operator init'
# erzeugt die Unseal-Keys genau einmal, und sie dürfen nirgends landen, wo ein
# Installer sie hinschreiben könnte. Ein versiegelter Vault nach der Installation
# ist das richtige Ergebnis, kein Fehler.

VAULT_DATA_DEFAULT="/opt/vault/data"
VAULT_TLS_DEFAULT="/opt/vault/tls"
VAULT_PORT=8200
VAULT_TLS_PORT=8300
VAULT_CLUSTER_PORT=8201
VAULT_REPO_LIST="/etc/apt/sources.list.d/hashicorp.list"
VAULT_KEYRING="/usr/share/keyrings/hashicorp-archive-keyring.gpg"

_vault_add_repo() {
    if [[ -f $VAULT_KEYRING && -f $VAULT_REPO_LIST ]]; then
        log_skip "$(t 'HashiCorp apt repository already configured')"
        return 0
    fi
    ensure_packages curl gnupg
    log_info "$(t 'Adding the HashiCorp apt repository')"
    if is_dry_run; then
        log_raw "    $(t 'would fetch the HashiCorp signing key')"
        return 0
    fi
    run bash -c "curl -fsSL https://apt.releases.hashicorp.com/gpg \
        | gpg --dearmor --yes -o '$VAULT_KEYRING'" \
        || die "$(t 'Could not fetch the HashiCorp signing key.')"
    run chmod 0644 "$VAULT_KEYRING"

    local codename
    codename=$(. /etc/os-release 2>/dev/null; printf '%s' "${VERSION_CODENAME:-}")
    [[ -n $codename ]] || die "$(t 'Could not determine the Debian codename.')"
    printf 'deb [arch=%s signed-by=%s] https://apt.releases.hashicorp.com %s main\n' \
        "$(dpkg --print-architecture)" "$VAULT_KEYRING" "$codename" \
        | write_file "$VAULT_REPO_LIST" 0644 root:root
    apt_refresh
}

module_install() {
    local data_dir tls_dir disable_mlock changed=0

    data_dir=$(state_get VAULT_DATA "$VAULT_DATA_DEFAULT")
    tls_dir=$(state_get VAULT_TLS_DIR "$VAULT_TLS_DEFAULT")
    # zram-Swap auf einem Pi heißt: Schlüsselmaterial könnte komprimiert im RAM
    # landen. mlock an zu lassen ist hier die richtige Vorgabe.
    disable_mlock=$(state_get VAULT_DISABLE_MLOCK false)

    _vault_add_repo
    ensure_packages vault

    # Der Dienstbenutzer kommt aus dem Paket
    local vault_user=vault
    user_exists "$vault_user" || vault_user=root

    ensure_dir "$(dirname "$data_dir")" 0755 root:root
    if [[ -d $data_dir ]] && [[ -n $(ls -A "$data_dir" 2>/dev/null) ]]; then
        # Ein vorhandener Bestand wird nie angefasst — er ist der Tresor.
        log_skip "$(t 'Vault store at %s already holds data - left untouched' "$data_dir")"
    else
        ensure_dir "$data_dir" 0700 "$vault_user:$vault_user"
    fi

    _vault_ensure_tls "$tls_dir" "$vault_user"

    VAULT_DATA="$data_dir" VAULT_TLS_DIR="$tls_dir" \
    VAULT_PORT="$VAULT_PORT" VAULT_TLS_PORT="$VAULT_TLS_PORT" \
    VAULT_CLUSTER_PORT="$VAULT_CLUSTER_PORT" \
    VAULT_DISABLE_MLOCK="$disable_mlock" \
    VAULT_API_ADDR="http://127.0.0.1:$VAULT_PORT" \
        render_template "$PHS_TEMPLATE_DIR/vault.hcl" /etc/vault.d/vault.hcl 0640 \
                        "root:$vault_user"
    [[ $FILE_CHANGED == 1 ]] && changed=1

    run systemctl enable vault.service >/dev/null 2>&1
    restart_if_changed vault.service "$changed"
    unit_active vault.service || run systemctl start vault.service

    if feature_installed nginx || [[ -d /etc/nginx/pi-home-stack ]]; then
        VAULT_SCHEME=http VAULT_PORT=$VAULT_PORT \
            render_template "$PHS_TEMPLATE_DIR/nginx-vault.conf" \
                            /etc/nginx/pi-home-stack/60-vault.conf 0644
        if nginx -t >/dev/null 2>&1; then
            run systemctl reload nginx
        else
            log_warn "$(t 'nginx test failed - the location is not active.')"
        fi
    fi

    if ! is_dry_run; then
        state_set VAULT_DATA "$data_dir"
        state_set VAULT_TLS_DIR "$tls_dir"
        state_set VAULT_DISABLE_MLOCK "$disable_mlock"
    fi

    _vault_report "$data_dir"
}

# Selbstsigniertes Zertifikat für den LAN-Listener. Ein vorhandenes bleibt liegen:
# wer aus dem Abbild ein altes zurückgespielt hat, will es behalten — und wer ein
# eigenes von einer internen CA hat, erst recht.
_vault_ensure_tls() {
    local tls_dir=$1 owner=$2
    ensure_dir "$tls_dir" 0700 "$owner:$owner"
    if [[ -f $tls_dir/tls.crt && -f $tls_dir/tls.key ]]; then
        log_skip "$(t 'TLS certificate already present in %s' "$tls_dir")"
        return 0
    fi
    if is_dry_run; then
        log_raw "    $(t 'would create a self-signed certificate in %s' "$tls_dir")"
        return 0
    fi
    ensure_packages openssl
    log_info "$(t 'Creating a self-signed certificate for %s' "$(primary_ip)")"
    run openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
        -subj "/CN=$(hostname)" \
        -addext "subjectAltName=DNS:$(hostname),DNS:$(hostname).local,IP:$(primary_ip),IP:127.0.0.1" \
        -keyout "$tls_dir/tls.key" -out "$tls_dir/tls.crt" 2>/dev/null \
        || log_warn "$(t 'Could not create a certificate - the TLS listener will not start.')"
    run chown "$owner:$owner" "$tls_dir/tls.key" "$tls_dir/tls.crt"
    run chmod 0600 "$tls_dir/tls.key"
    run chmod 0644 "$tls_dir/tls.crt"
}

# Ein frisch aufgesetzter Vault ist versiegelt und ohne Initialisierung nutzlos.
# Das ist Absicht, muss aber gesagt werden — sonst sucht man den Fehler.
_vault_report() {
    local data_dir=$1
    log_ok "$(t 'Vault at %s' "http://$(primary_ip)/vault/")"
    if [[ -d $data_dir ]] && [[ -n $(ls -A "$data_dir" 2>/dev/null) ]]; then
        log_info "$(t 'Existing store found. Unseal it with your keys:')"
        log_raw  "    export VAULT_ADDR=http://127.0.0.1:$VAULT_PORT"
        log_raw  "    vault operator unseal   # $(t 'once per key share')"
    else
        log_warn "$(t 'Empty store. Initialise it ONCE and keep the output safe:')"
        log_raw  "    export VAULT_ADDR=http://127.0.0.1:$VAULT_PORT"
        log_raw  "    vault operator init"
        log_warn "$(t 'The unseal keys and the root token are shown exactly once.')"
        log_warn "$(t 'Without them the store cannot be opened again - not by anyone.')"
    fi
}

module_remove() {
    local data_dir
    data_dir=$(state_get VAULT_DATA "$VAULT_DATA_DEFAULT")
    run systemctl disable --now vault.service 2>/dev/null || true
    run rm -f /etc/nginx/pi-home-stack/60-vault.conf
    nginx -t >/dev/null 2>&1 && run systemctl reload nginx
    # Weder Paket noch Tresor werden entfernt: Komponenten abwählen löscht keine
    # Daten, und ein gelöschter Tresor ist nicht wiederherstellbar.
    log_warn "$(t 'The store at %s is left in place.' "$data_dir")"
    log_info "$(t 'Remove the package deliberately with: sudo apt remove vault')"
}
