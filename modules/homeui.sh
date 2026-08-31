#!/usr/bin/env bash
# Home interface: a static status page plus a timer that collects the numbers.
#
# Deliberately no application server. The page is a file; its data comes from a
# status.json that a systemd timer rewrites once a minute. That way nothing which
# listens on the network runs as root.

module_install() {
    local web_root collector
    web_root=$(state_get WEB_ROOT /var/www/pi-home)
    [[ -n $web_root ]] || die "$(t 'Web server missing - set up the nginx component first.')"

    ensure_dir "$web_root" 0755 www-data:www-data

    local file changed=0
    for file in index.html style.css app.js; do
        write_file "$web_root/$file" 0644 www-data:www-data <"$PHS_ASSET_DIR/homeui/$file"
        [[ $FILE_CHANGED == 1 ]] && changed=1
    done

    collector="$PHS_INSTALL_DIR/collect_status.py"
    ensure_dir "$PHS_INSTALL_DIR" 0755
    write_file "$collector" 0755 root:root <"$PHS_ASSET_DIR/homeui/collect_status.py"

    STATUS_COLLECTOR=$collector STATUS_OUTPUT="$web_root/status.json" \
    STATUS_OUTPUT_DIR="$web_root" \
        render_template "$PHS_TEMPLATE_DIR/status.service" \
                        /etc/systemd/system/pi-home-status.service 0644
    render_template "$PHS_TEMPLATE_DIR/status.timer" \
                    /etc/systemd/system/pi-home-status.timer 0644

    systemd_reload
    run systemctl enable pi-home-status.timer >/dev/null 2>&1
    run systemctl start pi-home-status.timer

    # Run once immediately so the page does not show an error until the first
    # scheduled run.
    if ! is_dry_run; then
        systemctl start pi-home-status.service 2>/dev/null || true
        if [[ ! -f "$web_root/status.json" ]]; then
            log_warn "$(t 'status.json was not created - check: journalctl -u pi-home-status')"
        fi
    fi

    log_ok "$(t 'Home interface: %s' "http://$(primary_ip)/")"
}

module_remove() {
    local web_root
    web_root=$(state_get WEB_ROOT /var/www/pi-home)
    run systemctl disable --now pi-home-status.timer 2>/dev/null || true
    run rm -f /etc/systemd/system/pi-home-status.timer /etc/systemd/system/pi-home-status.service
    run rm -f "$PHS_INSTALL_DIR/collect_status.py"
    run rm -f "$web_root"/{index.html,style.css,app.js,status.json}
    systemd_reload
    log_info "$(t 'Web server and web root are left in place.')"
}
