#!/usr/bin/env bash
# Periodic internet speed measurement with a small API.
#
# Two units: a timer for the measurement itself and a service for the API. The API
# only listens on 127.0.0.1; nginx is what publishes it.

NETMON_DIR_DEFAULT="/opt/pi-home-stack/netmonitor"
NETMON_PORT=5010
NETMON_USER=pi-netmon

module_install() {
    local netmon_dir interval
    netmon_dir=$(state_get NETMON_DIR "$NETMON_DIR_DEFAULT")
    interval=$(state_get NETMON_INTERVAL)

    if [[ -z $interval ]]; then
        ask_choice interval "$(t 'How often should it measure?')" \
            "1h:$(t 'Hourly (recommended)')" \
            "4h:$(t 'Every four hours')" \
            "30min:$(t 'Every 30 minutes - finer detail, more traffic')" \
            "1d:$(t 'Once a day')"
    fi

    # speedtest-cli is optional: without it the script falls back to an HTTP download.
    ensure_packages python3
    if ! package_installed speedtest-cli; then
        if confirm "$(t 'Install speedtest-cli? (more accurate, includes upload)')" y; then
            ensure_packages speedtest-cli || log_warn "$(t 'speedtest-cli unavailable - the HTTP test will be used.')"
        fi
    fi

    if user_exists "$NETMON_USER"; then
        log_skip "$(t 'User %s already exists' "$NETMON_USER")"
    else
        log_info "$(t 'Creating service user %s' "$NETMON_USER")"
        run useradd --system --no-create-home --shell /usr/sbin/nologin "$NETMON_USER"
    fi

    ensure_dir "$netmon_dir" 0755 root:root
    ensure_dir "$netmon_dir/data" 0755 "$NETMON_USER:$NETMON_USER"
    write_file "$netmon_dir/netmonitor.py" 0755 root:root <"$PHS_ASSET_DIR/netmonitor/netmonitor.py"
    local changed=$FILE_CHANGED

    NETMON_SCRIPT="$netmon_dir/netmonitor.py" NETMON_DATA="$netmon_dir/data" \
    NETMON_SERVICE_USER="$NETMON_USER" NETMON_API_PORT="$NETMON_PORT" \
        render_template "$PHS_TEMPLATE_DIR/netmonitor.service" \
                        /etc/systemd/system/pi-home-netmonitor.service 0644
    [[ $FILE_CHANGED == 1 ]] && changed=1

    NETMON_SCRIPT="$netmon_dir/netmonitor.py" NETMON_DATA="$netmon_dir/data" \
    NETMON_SERVICE_USER="$NETMON_USER" \
        render_template "$PHS_TEMPLATE_DIR/netmonitor-measure.service" \
                        /etc/systemd/system/pi-home-netmonitor-measure.service 0644

    NETMON_INTERVAL="$interval" \
        render_template "$PHS_TEMPLATE_DIR/netmonitor-measure.timer" \
                        /etc/systemd/system/pi-home-netmonitor-measure.timer 0644

    systemd_reload
    run systemctl enable pi-home-netmonitor.service >/dev/null 2>&1
    restart_if_changed pi-home-netmonitor.service "$changed"
    unit_active pi-home-netmonitor.service || run systemctl start pi-home-netmonitor.service
    run systemctl enable --now pi-home-netmonitor-measure.timer >/dev/null 2>&1

    if feature_installed nginx || [[ -d /etc/nginx/pi-home-stack ]]; then
        NETMON_API_PORT=$NETMON_PORT \
            render_template "$PHS_TEMPLATE_DIR/nginx-netmonitor.conf" \
                            /etc/nginx/pi-home-stack/30-netmonitor.conf 0644
        if nginx -t >/dev/null 2>&1; then
            run systemctl reload nginx
        else
            log_warn "$(t 'nginx test failed - the location is not active.')"
        fi
    fi

    if ! is_dry_run; then
        state_set NETMON_DIR "$netmon_dir"
        state_set NETMON_INTERVAL "$interval"
        state_set NETMON_DB "$netmon_dir/data/netmon.db"
    fi

    log_ok "$(t 'Measuring every %s, API at %s' "$interval" "http://$(primary_ip)/netmon-api/latest")"
    log_info "$(t 'Trigger the first measurement now: sudo systemctl start pi-home-netmonitor-measure')"
}

module_remove() {
    run systemctl disable --now pi-home-netmonitor-measure.timer 2>/dev/null || true
    run systemctl disable --now pi-home-netmonitor.service 2>/dev/null || true
    run rm -f /etc/systemd/system/pi-home-netmonitor.service \
              /etc/systemd/system/pi-home-netmonitor-measure.service \
              /etc/systemd/system/pi-home-netmonitor-measure.timer \
              /etc/nginx/pi-home-stack/30-netmonitor.conf
    systemd_reload
    nginx -t >/dev/null 2>&1 && run systemctl reload nginx
    log_warn "$(t 'Measurements are left in place at %s.' "$(state_get NETMON_DIR "$NETMON_DIR_DEFAULT")/data")"
}
