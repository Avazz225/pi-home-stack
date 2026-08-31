#!/usr/bin/env bash
# Unattended security updates, log rotation and a configuration export.
#
# Only security updates are applied automatically, and reboots are never taken
# without being asked: an appliance that reboots itself in the middle of a backup
# is worse than one that waits for a human.

module_install() {
    local auto_reboot reboot_time export_script

    ensure_packages unattended-upgrades apt-listchanges

    auto_reboot=$(state_get AUTO_REBOOT)
    if [[ -z $auto_reboot ]]; then
        ask_choice auto_reboot "$(t 'Reboot automatically when an update requires it?')" \
            "no:$(t 'No - only install updates, reboot by hand (recommended)')" \
            "yes:$(t 'Yes - reboot at a fixed time when required')"
    fi
    reboot_time=$(state_get AUTO_REBOOT_TIME "04:30")
    [[ $auto_reboot == yes ]] && ask reboot_time "$(t 'Time for the reboot (HH:MM)')" "04:30"

    AUTO_REBOOT=$([[ $auto_reboot == yes ]] && echo "true" || echo "false") \
    AUTO_REBOOT_TIME="$reboot_time" \
        render_template "$PHS_TEMPLATE_DIR/unattended-upgrades.conf" \
                        /etc/apt/apt.conf.d/51pi-home-stack-upgrades 0644
    local changed=$FILE_CHANGED

    render_template "$PHS_TEMPLATE_DIR/auto-upgrades.conf" \
                    /etc/apt/apt.conf.d/20auto-upgrades 0644
    [[ $FILE_CHANGED == 1 ]] && changed=1

    run systemctl enable --now unattended-upgrades >/dev/null 2>&1
    restart_if_changed unattended-upgrades "$changed"

    # The stack's own logs would otherwise grow without bound on an SD card.
    render_template "$PHS_TEMPLATE_DIR/logrotate.conf" \
                    /etc/logrotate.d/pi-home-stack 0644

    # Bounded journal: the default on Pi OS can eat a surprising amount of card.
    ensure_dir /etc/systemd/journald.conf.d 0755
    write_file /etc/systemd/journald.conf.d/pi-home-stack.conf 0644 <<'EOF'
# pi-home-stack - keep the journal from filling the SD card.
[Journal]
SystemMaxUse=200M
SystemMaxFileSize=20M
MaxRetentionSec=1month
EOF
    [[ $FILE_CHANGED == 1 ]] && run systemctl restart systemd-journald

    export_script="$PHS_INSTALL_DIR/export-config.sh"
    write_file "$export_script" 0755 root:root <"$PHS_ASSET_DIR/maintenance/export-config.sh"

    if ! is_dry_run; then
        state_set AUTO_REBOOT "$auto_reboot"
        state_set AUTO_REBOOT_TIME "$reboot_time"
    fi

    log_ok "$(t 'Automatic security updates are active.')"
    if [[ $auto_reboot == yes ]]; then
        log_info "$(t 'Reboots when required at %s.' "$reboot_time")"
    else
        log_info "$(t 'Reboots are never taken automatically; check with: ls /var/run/reboot-required')"
    fi
    log_ok "$(t 'Configuration export: %s' "sudo $export_script <target-directory>")"
    log_info "$(t 'The export deliberately contains no passwords and no key files.')"
}

module_remove() {
    run rm -f /etc/apt/apt.conf.d/51pi-home-stack-upgrades \
              /etc/logrotate.d/pi-home-stack \
              /etc/systemd/journald.conf.d/pi-home-stack.conf \
              "$PHS_INSTALL_DIR/export-config.sh"
    log_warn "$(t 'unattended-upgrades stays installed and enabled.')"
    log_info "$(t 'Disable it with: sudo systemctl disable --now unattended-upgrades')"
}
