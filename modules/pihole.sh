#!/usr/bin/env bash
# Pi-hole as a network-wide filter, plus weekly upkeep via a systemd timer.
#
# Pi-hole v6 moved its configuration from setupVars.conf to pihole.toml and changed
# the password command. Both paths are supported, because either version can be
# found on a Pi in the wild.

PIHOLE_INSTALL_URL="https://install.pi-hole.net"

_pihole_present() { command -v pihole >/dev/null 2>&1; }

_pihole_major() {
    local version
    version=$(pihole -v 2>/dev/null | grep -oE 'v?[0-9]+\.[0-9]+' | head -1 | tr -d 'v')
    printf '%s' "${version%%.*}"
}

_pihole_set_password() {
    local password=$1
    is_dry_run && { log_raw "    ${C_DIM}[dry-run] $(t 'would set the Pi-hole password')${C_RESET}"; return 0; }
    if [[ $(_pihole_major) -ge 6 ]]; then
        pihole setpassword "$password" >/dev/null 2>&1 \
            || log_warn "$(t 'Could not set the password - run: pihole setpassword')"
    else
        pihole -a -p "$password" "$password" >/dev/null 2>&1 \
            || log_warn "$(t 'Could not set the password - run: pihole -a -p')"
    fi
    log_ok "$(t 'Pi-hole web interface secured with a password.')"
}

_write_setup_vars() {
    # Pre-seed for the unattended run of the official installer (v5).
    # v6 ignores the file, where it does no harm either.
    local iface ip gateway
    iface=$(ip -4 route show default | awk '{print $5; exit}')
    ip=$(primary_ip)
    gateway=$(ip -4 route show default | awk '{print $3; exit}')
    local cidr
    cidr=$(ip -4 -o addr show dev "$iface" 2>/dev/null | awk '{print $4; exit}')

    ensure_dir /etc/pihole 0755
    PIHOLE_IFACE=$iface PIHOLE_CIDR=${cidr:-$ip/24} PIHOLE_GATEWAY=$gateway \
    PIHOLE_DNS_1=$(state_get PIHOLE_DNS_1) PIHOLE_DNS_2=$(state_get PIHOLE_DNS_2) \
        render_template "$PHS_TEMPLATE_DIR/pihole-setupVars.conf" \
                        /etc/pihole/setupVars.conf 0644
}

module_install() {
    local upstream="" update_mode="" web_password

    upstream=$(state_get PIHOLE_UPSTREAM)
    if [[ -z $upstream ]]; then
        ask_choice upstream "$(t 'Which upstream DNS servers should Pi-hole use?')" \
            "quad9:$(t 'Quad9 (9.9.9.9) - blocks known malware domains, EU foundation')" \
            "cloudflare:$(t 'Cloudflare (1.1.1.1) - fast, no filtering')" \
            "digitalcourage:$(t 'Digitalcourage (5.9.164.112) - privacy focused, Germany')" \
            "google:Google (8.8.8.8)"
    fi
    case $upstream in
        quad9)          state_set PIHOLE_DNS_1 "9.9.9.9";       state_set PIHOLE_DNS_2 "149.112.112.112" ;;
        cloudflare)     state_set PIHOLE_DNS_1 "1.1.1.1";       state_set PIHOLE_DNS_2 "1.0.0.1" ;;
        digitalcourage) state_set PIHOLE_DNS_1 "5.9.164.112";   state_set PIHOLE_DNS_2 "5.1.66.255" ;;
        google)         state_set PIHOLE_DNS_1 "8.8.8.8";       state_set PIHOLE_DNS_2 "8.8.4.4" ;;
    esac
    is_dry_run || state_set PIHOLE_UPSTREAM "$upstream"

    if _pihole_present; then
        log_skip "$(t 'Pi-hole is already installed (v%s)' "$(_pihole_major)")"
    else
        ensure_packages curl ca-certificates
        _write_setup_vars
        log_info "$(t 'Installing Pi-hole - this takes a few minutes.')"
        if is_dry_run; then
            log_raw "    ${C_DIM}[dry-run] $(t 'would run %s unattended' "$PIHOLE_INSTALL_URL")${C_RESET}"
        else
            # The official install script is downloaded and inspected before it
            # runs - never piped straight into a shell.
            local installer
            installer=$(mktemp /tmp/pihole-install.XXXXXX.sh)
            curl -fsSL "$PIHOLE_INSTALL_URL" -o "$installer" \
                || die "$(t 'Could not download the Pi-hole installer.')"
            [[ -s $installer ]] || die "$(t 'The downloaded installer is empty.')"
            head -1 "$installer" | grep -q '^#!' \
                || die "$(t 'The downloaded file does not look like a script.')"
            chmod +x "$installer"
            bash "$installer" --unattended || die "$(t 'Pi-hole installation failed.')"
            rm -f "$installer"
        fi
        log_ok "$(t 'Pi-hole installed.')"
    fi

    web_password=$(secret_ensure "pihole/web" "admin" 20)
    _pihole_set_password "$web_password"

    # Weekly upkeep. Two very different things:
    #   gravity  re-reads the block lists - harmless
    #   update   upgrades Pi-hole itself - can change behaviour unattended
    update_mode=$(state_get PIHOLE_UPDATE_MODE)
    if [[ -z $update_mode ]]; then
        ask_choice update_mode "$(t 'Weekly upkeep')" \
            "gravity:$(t 'Update the block lists only (recommended)')" \
            "full:$(t 'Update the block lists and Pi-hole itself')" \
            "none:$(t 'Do not update anything automatically')"
    fi
    is_dry_run || state_set PIHOLE_UPDATE_MODE "$update_mode"

    if [[ $update_mode == none ]]; then
        run systemctl disable --now pi-home-pihole-update.timer 2>/dev/null || true
        run rm -f /etc/systemd/system/pi-home-pihole-update.{timer,service}
        log_info "$(t 'No automatic Pi-hole upkeep configured.')"
    else
        local update_cmd="/usr/local/bin/pihole -g"
        [[ $update_mode == full ]] && update_cmd="/usr/local/bin/pihole -g && /usr/local/bin/pihole -up --unattended"
        PIHOLE_UPDATE_CMD=$update_cmd \
            render_template "$PHS_TEMPLATE_DIR/pihole-update.service" \
                            /etc/systemd/system/pi-home-pihole-update.service 0644
        render_template "$PHS_TEMPLATE_DIR/pihole-update.timer" \
                        /etc/systemd/system/pi-home-pihole-update.timer 0644
        systemd_reload
        run systemctl enable --now pi-home-pihole-update.timer >/dev/null 2>&1
        log_ok "$(t 'Weekly upkeep active (Sundays 03:30, mode: %s).' "$update_mode")"
    fi

    log_ok "$(t 'Pi-hole interface: %s' "http://$(primary_ip)/admin")"
    log_info "$(t 'For the network to use the filter, set your router DNS to %s.' "$(primary_ip)")"
}

module_remove() {
    run systemctl disable --now pi-home-pihole-update.timer 2>/dev/null || true
    run rm -f /etc/systemd/system/pi-home-pihole-update.timer \
              /etc/systemd/system/pi-home-pihole-update.service
    systemd_reload
    log_warn "$(t 'Pi-hole itself stays installed.')"
    log_info "$(t 'Remove it completely with: sudo pihole uninstall')"
}
