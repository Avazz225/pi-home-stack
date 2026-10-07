#!/usr/bin/env bash
# DuckDNS: keeps a dynamic hostname pointed at this line.
#
# The token is issued by DuckDNS, so it is asked for rather than generated - the
# one case where secret_ensure is the wrong helper. It goes into the credential
# store and from there into a root-only file that the update script reads.
#
# A oneshot service plus a timer, not a daemon: the work is one HTTP request.

DUCKDNS_DIR_DEFAULT="/opt/pi-home-stack/duckdns"
DUCKDNS_USER=pi-duckdns
DUCKDNS_TOKEN_FILE="/etc/pi-home-stack/secrets/duckdns.token"
DUCKDNS_CONF_FILE="/etc/pi-home-stack/duckdns.conf"

module_install() {
    local duckdns_dir domains interval oncalendar token changed=0

    duckdns_dir=$(state_get DUCKDNS_DIR "$DUCKDNS_DIR_DEFAULT")

    domains=$(state_get DUCKDNS_DOMAINS)
    if [[ -z $domains ]]; then
        ask domains "$(t 'DuckDNS subdomain, without .duckdns.org (several: comma-separated)')"
    fi
    [[ -n $domains ]] || die "$(t 'Without a subdomain there is nothing to update.')"
    # A full hostname is a common slip, and DuckDNS silently answers KO for it.
    domains=${domains//.duckdns.org/}

    interval=$(state_get DUCKDNS_INTERVAL)
    if [[ -z $interval ]]; then
        ask_choice interval "$(t 'How often should the address be reported?')" \
            "15min:$(t 'Every 15 minutes (recommended)')" \
            "5min:$(t 'Every 5 minutes')" \
            "1h:$(t 'Hourly')"
    fi
    case $interval in
        5min) oncalendar="*:0/5" ;;
        1h)   oncalendar="hourly" ;;
        *)    oncalendar="*:0/15" ;;
    esac

    ensure_packages curl

    if user_exists "$DUCKDNS_USER"; then
        log_skip "$(t 'User %s already exists' "$DUCKDNS_USER")"
    else
        log_info "$(t 'Creating service user %s' "$DUCKDNS_USER")"
        run useradd --system --no-create-home --shell /usr/sbin/nologin "$DUCKDNS_USER"
    fi

    token=$(secret_get "duckdns/token" 2>/dev/null) || token=""
    if [[ -z $token ]]; then
        log_info "$(t 'The token is on your DuckDNS account page, above the domain list.')"
        ask_secret token "$(t 'DuckDNS token')"
        secret_store "duckdns/token" "$domains" "$token" "DuckDNS"
    else
        log_skip "$(t 'DuckDNS token already in the credential store')"
    fi
    secret_materialise "duckdns/token" "$DUCKDNS_TOKEN_FILE" "$token"
    if ! is_dry_run; then
        run chown root:"$DUCKDNS_USER" "$DUCKDNS_TOKEN_FILE"
        run chmod 0640 "$DUCKDNS_TOKEN_FILE"
    fi

    ensure_dir "$duckdns_dir" 0755 root:root
    write_file "$duckdns_dir/update.sh" 0755 root:root <"$PHS_ASSET_DIR/duckdns/update.sh"
    [[ $FILE_CHANGED == 1 ]] && changed=1

    # The domain is configuration, not a secret, and therefore world-readable.
    write_file "$DUCKDNS_CONF_FILE" 0644 root:root <<EOF
# Written by pi-home-stack. The token is deliberately NOT here -
# it lives in $DUCKDNS_TOKEN_FILE, readable only by root and $DUCKDNS_USER.
DUCKDNS_DOMAINS="$domains"
EOF
    [[ $FILE_CHANGED == 1 ]] && changed=1

    DUCKDNS_SCRIPT="$duckdns_dir/update.sh" DUCKDNS_SERVICE_USER="$DUCKDNS_USER" \
        render_template "$PHS_TEMPLATE_DIR/duckdns.service" \
                        /etc/systemd/system/pi-home-duckdns.service 0644
    [[ $FILE_CHANGED == 1 ]] && changed=1

    DUCKDNS_ONCALENDAR="$oncalendar" DUCKDNS_INTERVAL="$interval" \
        render_template "$PHS_TEMPLATE_DIR/duckdns.timer" \
                        /etc/systemd/system/pi-home-duckdns.timer 0644
    [[ $FILE_CHANGED == 1 ]] && changed=1

    systemd_reload
    run systemctl enable --now pi-home-duckdns.timer >/dev/null 2>&1

    # One run right away, so a wrong token shows up now and not in 15 minutes.
    if ! is_dry_run; then
        if run systemctl start pi-home-duckdns.service; then
            log_ok "$(t 'First update went through.')"
        else
            log_warn "$(t 'The first update failed - see: journalctl -u pi-home-duckdns -n 10')"
        fi
    fi

    if ! is_dry_run; then
        state_set DUCKDNS_DIR "$duckdns_dir"
        state_set DUCKDNS_DOMAINS "$domains"
        state_set DUCKDNS_INTERVAL "$interval"
    fi

    log_ok "$(t '%s is updated every %s.' "$domains.duckdns.org" "$interval")"
    log_info "$(t 'Check it: journalctl -u pi-home-duckdns -n 5')"
}

module_remove() {
    run systemctl disable --now pi-home-duckdns.timer 2>/dev/null || true
    run rm -f /etc/systemd/system/pi-home-duckdns.timer \
              /etc/systemd/system/pi-home-duckdns.service \
              "$DUCKDNS_CONF_FILE" "$DUCKDNS_TOKEN_FILE"
    systemd_reload
    # The entry in the credential store stays: removing a component must not
    # destroy a credential that cannot be regenerated locally.
    log_warn "$(t 'The token stays in the credential store under duckdns/token.')"
    log_info "$(t 'The hostname keeps pointing here until DuckDNS stops hearing from you.')"
}
