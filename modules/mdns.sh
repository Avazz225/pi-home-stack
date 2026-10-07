#!/usr/bin/env bash
# The Pi under <name>.local, without a DNS entry anywhere.
#
# There is nothing to bind: Avahi announces the system hostname over mDNS, so
# "<name>.local" is simply what a host called "<name>" is reachable as. No
# router entry, no hosts file on every client.
#
# Which is why this component sets the hostname as well. That has consequences
# for things already installed - a certificate issued for the old name, an
# nginx server_name - and they are named rather than silently left behind.

module_install() {
    local new_name old_name changed=0

    old_name=$(hostname)
    new_name=$(state_get HOSTNAME_WANTED)
    if [[ -z $new_name ]]; then
        ask new_name "$(t 'Under which name should the Pi be reachable? (without .local)')" \
            "$old_name"
    fi
    # Erst die Endung weg: ".local" mitzutippen ist naheliegend, und der Punkt
    # wuerde die Pruefung sonst scheitern lassen.
    new_name=${new_name%.local}
    # RFC 1123: letters, digits, hyphens; not starting or ending with one.
    [[ $new_name =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$ ]] \
        || die "$(t 'Not a usable hostname: %s' "$new_name")"

    ensure_packages avahi-daemon

    if [[ $new_name == "$old_name" ]]; then
        log_skip "$(t 'Hostname is already %s' "$new_name")"
    else
        log_info "$(t 'Renaming %s to %s' "$old_name" "$new_name")"
        run hostnamectl set-hostname "$new_name"
        changed=1
    fi

    # /etc/hosts has to follow, or every sudo waits on a name resolution that
    # cannot succeed ("unable to resolve host") and the delay is seconds long.
    # This is the one line in /etc/hosts this stack touches.
    if is_dry_run; then
        log_raw "    $(t 'would point 127.0.1.1 at %s in /etc/hosts' "$new_name")"
    elif grep -qE "^127\.0\.1\.1[[:space:]]+$new_name([[:space:]]|$)" /etc/hosts; then
        log_skip "$(t '/etc/hosts already names %s' "$new_name")"
    elif grep -qE '^127\.0\.1\.1[[:space:]]' /etc/hosts; then
        run sed -i -E "s|^127\.0\.1\.1[[:space:]].*|127.0.1.1\t$new_name|" /etc/hosts
        log_ok "$(t '/etc/hosts now names %s' "$new_name")"
    else
        printf '127.0.1.1\t%s\n' "$new_name" >>/etc/hosts
        log_ok "$(t 'Added 127.0.1.1 %s to /etc/hosts' "$new_name")"
    fi

    run systemctl enable --now avahi-daemon.service >/dev/null 2>&1
    # A rename while the daemon is running keeps the old name announced until
    # it re-reads it.
    [[ $changed == 1 ]] && run systemctl restart avahi-daemon.service

    is_dry_run || state_set HOSTNAME_WANTED "$new_name"

    log_ok "$(t 'Reachable as %s' "$new_name.local")"
    log_info "$(t 'Test it from another machine: ping %s' "$new_name.local")"
    log_info "$(t 'Windows needs Bonjour or Windows 10 1803 and later for .local names.')"

    [[ $changed == 1 ]] && _mdns_report_stale "$old_name" "$new_name"
    return 0
}

# What still carries the old name. Nothing is changed here - a certificate and a
# vhost belong to their own components, and re-rendering them from here would
# put two owners on one file.
_mdns_report_stale() {
    local old_name=$1 new_name=$2
    local findings=()

    # Vault's self-signed certificate names the host it was issued on. The
    # vault component reissues it on its next run, but only a restart activates
    # it - and a restart seals Vault.
    local vault_crt=/opt/vault/tls/tls.crt
    if [[ -f $vault_crt ]] \
       && ! openssl x509 -in "$vault_crt" -noout -ext subjectAltName 2>/dev/null \
            | grep -qE "DNS:$new_name([,[:space:]]|\.local|$)"; then
        findings+=("$(t 'Vault certificate still names %s: sudo ./install.sh --features vault' "$old_name")")
    fi

    local server_name
    server_name=$(state_get WEB_SERVER_NAME "_")
    if [[ $server_name != "_" && $server_name == *"$old_name"* ]]; then
        findings+=("$(t 'nginx server_name is still %s: sudo ./install.sh --features nginx' "$server_name")")
    fi

    if [[ ${#findings[@]} -gt 0 ]]; then
        log_warn "$(t 'Still carrying the old name:')"
        local item
        for item in "${findings[@]}"; do log_raw "      $item"; done
    fi

    # Samba runs with "disable netbios = yes", so the share was never found by
    # name - only by address. With Avahi running, smb://<name>.local works.
    if feature_installed samba; then
        log_info "$(t 'The share is now also at smb://%s/' "$new_name.local")"
    fi
}

module_remove() {
    # The hostname stays: it is the system's identity, not a setting of this
    # stack, and changing it back would surprise more than it helps.
    run systemctl disable --now avahi-daemon.service 2>/dev/null || true
    log_warn "$(t 'The hostname stays %s - only the announcement is gone.' "$(hostname)")"
    log_info "$(t 'The Pi is then reachable by address only.')"
}
