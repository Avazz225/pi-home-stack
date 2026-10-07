#!/usr/bin/env bash
# nginx as the single entry point on port 80.
#
# Pi-hole ships its own web server, which also wants port 80 (lighttpd in v5, FTL
# itself in v6). Rather than letting the two fight over it, Pi-hole is moved to
# 8080 and re-published here under /admin/, so there is one address for everything.
#
# Every module that brings an API drops its own file into
# /etc/nginx/pi-home-stack/. Those get included into the server block, so modules
# can never overwrite each other's configuration.

PIHOLE_WEB_PORT=8080

_nginx_test() {
    is_dry_run && return 0
    nginx -t >/dev/null 2>&1
}

# Moves the Pi-hole web server out of the way so nginx can have port 80.
# Läuft hier Pi-hole v6 oder v5?
#
# Nicht über 'pihole -v': dessen Ausgabeformat hat sich mit v6 geändert, der
# frühere grep fand nichts, gab 1 zurück und riss unter 'set -o pipefail' den
# ganzen Installer stumm mit. Die Dateien sind das stabilere Merkmal — v6 führt
# seinen Webserver in pihole-FTL und konfiguriert ihn über pihole.toml, v5 nutzt
# lighttpd. Eine falsche Antwort hätte hier Folgen: auf dem v5-Pfad bliebe
# Pi-holes Webserver auf Port 80 und stritte mit nginx darum.
_pihole_is_v6() {
    [[ -f /etc/pihole/pihole.toml ]] && return 0
    if command -v pihole-FTL >/dev/null 2>&1 \
       && pihole-FTL --config webserver.port >/dev/null 2>&1; then
        return 0
    fi
    # Letzter Rückfall über die Versionszeile, aber ohne Abbruchgefahr
    local major
    major=$(pihole -v 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -1 || true)
    major=${major%%.*}
    [[ -n $major ]] && [[ $major -ge 6 ]]
}

_relocate_pihole_web() {
    command -v pihole >/dev/null 2>&1 || return 0

    if _pihole_is_v6; then
        # v6: the web server lives in pihole-FTL and is driven by pihole.toml.
        if is_dry_run; then
            log_raw "    ${C_DIM}[dry-run] $(t 'would move the Pi-hole web server to port %s' "$PIHOLE_WEB_PORT")${C_RESET}"
            return 0
        fi
        local current
        current=$(pihole-FTL --config webserver.port 2>/dev/null || echo "")
        if [[ $current == *"$PIHOLE_WEB_PORT"* ]]; then
            log_skip "$(t 'Pi-hole web already listens on %s' "$PIHOLE_WEB_PORT")"
        else
            log_info "$(t 'Moving the Pi-hole web server to port %s' "$PIHOLE_WEB_PORT")"
            pihole-FTL --config webserver.port "$PIHOLE_WEB_PORT" >/dev/null 2>&1 \
                || log_warn "$(t 'Could not set webserver.port - check /etc/pihole/pihole.toml.')"
            systemctl restart pihole-FTL 2>/dev/null || true
        fi
    else
        # v5: lighttpd.
        local conf=/etc/lighttpd/lighttpd.conf
        [[ -f $conf ]] || return 0
        if grep -qE "^server.port\s*=\s*$PIHOLE_WEB_PORT" "$conf"; then
            log_skip "$(t 'lighttpd already listens on %s' "$PIHOLE_WEB_PORT")"
        else
            log_info "$(t 'Moving lighttpd to port %s' "$PIHOLE_WEB_PORT")"
            run cp -a "$conf" "$conf.phs-orig"
            run sed -i -E "s|^server\\.port\\s*=.*|server.port = $PIHOLE_WEB_PORT|" "$conf"
            grep -qE "^server\.port" "$conf" || is_dry_run \
                || printf 'server.port = %s\n' "$PIHOLE_WEB_PORT" >>"$conf"
            run systemctl restart lighttpd
        fi
    fi
    is_dry_run || state_set PIHOLE_WEB_PORT "$PIHOLE_WEB_PORT"
}

module_install() {
    ensure_packages nginx

    local web_root server_name
    web_root=$(state_get WEB_ROOT /var/www/pi-home)
    server_name=$(state_get WEB_SERVER_NAME "_")

    ensure_dir "$PHS_INSTALL_DIR" 0755
    ensure_dir "$web_root" 0755 www-data:www-data
    ensure_dir /etc/nginx/pi-home-stack 0755

    # Placeholder page so the address answers even before the homeui module runs.
    if [[ ! -f "$web_root/index.html" ]]; then
        printf '<!doctype html><meta charset="utf-8"><title>pi-home-stack</title><p>Running.' \
            | write_file "$web_root/index.html" 0644 www-data:www-data
    fi

    _relocate_pihole_web

    # The file always exists, even without Pi-hole - empty in that case, so the
    # include in the site configuration never dangles.
    if command -v pihole >/dev/null 2>&1; then
        PIHOLE_PORT=$PIHOLE_WEB_PORT \
            render_template "$PHS_TEMPLATE_DIR/nginx-pihole.conf" \
                            /etc/nginx/pi-home-stack/10-pihole.conf 0644
    else
        printf '# Pi-hole is not installed.\n' \
            | write_file /etc/nginx/pi-home-stack/10-pihole.conf 0644
    fi
    local changed=$FILE_CHANGED

    WEB_ROOT=$web_root WEB_SERVER_NAME=$server_name \
        render_template "$PHS_TEMPLATE_DIR/nginx-site.conf" \
                        /etc/nginx/sites-available/pi-home-stack 0644
    [[ $FILE_CHANGED == 1 ]] && changed=1

    if [[ -L /etc/nginx/sites-enabled/pi-home-stack ]]; then
        log_skip "$(t 'Site already enabled')"
    else
        log_info "$(t 'Enabling the site')"
        run ln -sf /etc/nginx/sites-available/pi-home-stack /etc/nginx/sites-enabled/pi-home-stack
        changed=1
    fi

    # The default site would otherwise claim the same port and server name.
    if [[ -e /etc/nginx/sites-enabled/default ]]; then
        log_info "$(t 'Disabling the default site')"
        run rm -f /etc/nginx/sites-enabled/default
        changed=1
    fi

    if ! _nginx_test; then
        log_error "$(t 'The nginx configuration is invalid:')"
        nginx -t 2>&1 | sed 's/^/        /' >&2
        die "$(t 'Aborting so no broken web server is left behind.')"
    fi

    run systemctl enable nginx >/dev/null 2>&1
    restart_if_changed nginx "$changed"
    unit_active nginx || run systemctl start nginx

    if ! is_dry_run; then
        state_set WEB_ROOT "$web_root"
        state_set WEB_SERVER_NAME "$server_name"
    fi
    log_ok "$(t 'Web server running: %s' "http://$(primary_ip)/")"
}

module_remove() {
    run rm -f /etc/nginx/sites-enabled/pi-home-stack
    run rm -f /etc/nginx/sites-available/pi-home-stack
    run rm -rf /etc/nginx/pi-home-stack
    _nginx_test && run systemctl reload nginx
    log_warn "$(t 'nginx itself stays installed; the default site stays disabled.')"
}
