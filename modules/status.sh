#!/usr/bin/env bash
# The numbers about this machine: disks, RAID, services, backup state.
#
# Split out of homeui, because it is not part of a page. Both interfaces want
# these numbers - the status page is built from them, and the dashboard has a
# pane for them - and whoever installed only the dashboard used to have no way
# to see whether the array was healthy. That was the gap worth closing: on the
# day the boot medium died, this is the screen you want.
#
# Deliberately no application server. A systemd timer rewrites a status.json in
# the web root once a minute, and the pages read that file. Nothing that listens
# on the network runs as root.

module_install() {
    local web_root collector

    web_root=$(state_get WEB_ROOT /var/www/pi-home)
    [[ -n $web_root ]] || die "$(t 'Web server missing - set up the nginx component first.')"
    ensure_dir "$web_root" 0755 www-data:www-data

    collector="$PHS_INSTALL_DIR/collect_status.py"
    ensure_dir "$PHS_INSTALL_DIR" 0755
    write_file "$collector" 0755 root:root <"$PHS_ASSET_DIR/status/collect_status.py"

    STATUS_COLLECTOR=$collector STATUS_OUTPUT="$web_root/status.json" \
    STATUS_OUTPUT_DIR="$web_root" \
        render_template "$PHS_TEMPLATE_DIR/status.service" \
                        /etc/systemd/system/pi-home-status.service 0644
    render_template "$PHS_TEMPLATE_DIR/status.timer" \
                    /etc/systemd/system/pi-home-status.timer 0644

    systemd_reload
    run systemctl enable pi-home-status.timer >/dev/null 2>&1
    run systemctl start pi-home-status.timer

    # Once immediately, so no interface shows an error until the first
    # scheduled run. No restart_if_changed in front of it: the unit is a
    # one-shot, so a restart IS the run - and that should happen either way,
    # whether or not the collector changed.
    if ! is_dry_run; then
        systemctl start pi-home-status.service 2>/dev/null || true
        if [[ -f "$web_root/status.json" ]]; then
            log_ok "$(t 'Status collected: %s' "$web_root/status.json")"
        else
            log_warn "$(t 'status.json was not created - check: journalctl -u pi-home-status')"
        fi
    fi
    return 0
}

module_remove() {
    local web_root
    web_root=$(state_get WEB_ROOT /var/www/pi-home)
    run systemctl disable --now pi-home-status.timer 2>/dev/null || true
    run rm -f /etc/systemd/system/pi-home-status.timer \
              /etc/systemd/system/pi-home-status.service \
              "$PHS_INSTALL_DIR/collect_status.py" \
              "$web_root/status.json"
    systemd_reload
    log_info "$(t 'The interfaces then show no system numbers any more.')"
}
