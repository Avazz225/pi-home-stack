#!/usr/bin/env bash
# Network share (SMB) for the data store.
#
# The share gets its own system account without a login shell. Its Samba password
# is independent of any Unix password and lives in the chosen credential store.

module_install() {
    local share_path share_name smb_user smb_password
    share_path=$(state_get SHARE_DATA_DIR)
    [[ -n $share_path ]] || die "$(t 'Data store missing - set up the storage component first.')"

    ensure_packages samba samba-common-bin

    share_name=$(state_get SHARE_NAME nas)
    smb_user=$(state_get SMB_USER)
    [[ -z $smb_user ]] && smb_user=nasuser

    ask share_name "$(t 'Share name')"
    ask smb_user "$(t 'Username for access')"
    valid_username "$smb_user" || die "$(t 'Invalid username: %s' "$smb_user")"

    # Service account: no login, no home. It exists only so Samba and the file
    # permissions have an owner.
    if user_exists "$smb_user"; then
        log_skip "$(t 'User %s already exists' "$smb_user")"
    else
        log_info "$(t 'Creating user %s (no login)' "$smb_user")"
        run useradd --system --no-create-home --shell /usr/sbin/nologin "$smb_user"
    fi

    smb_password=$(secret_ensure "samba/$smb_user" "$smb_user" 24) \
        || die "$(t 'Could not provision the password.')"

    # The password is re-applied on every run so the credential store and Samba
    # can never drift apart.
    if ! is_dry_run; then
        printf '%s\n%s\n' "$smb_password" "$smb_password" | smbpasswd -s -a "$smb_user" >/dev/null
        smbpasswd -e "$smb_user" >/dev/null
        log_ok "$(t 'Samba user configured: %s' "$smb_user")"
    else
        log_raw "    ${C_DIM}[dry-run] $(t 'would configure Samba user %s' "$smb_user")${C_RESET}"
    fi

    run chown -R "$smb_user:$smb_user" "$share_path"
    run chmod 2770 "$share_path"

    SHARE_NAME=$share_name SHARE_PATH_DATA=$share_path SMB_USER=$smb_user \
        render_template "$PHS_TEMPLATE_DIR/smb-share.conf" \
                        "/etc/samba/pi-home-stack.conf" 0644
    local share_changed=$FILE_CHANGED

    # An include line instead of editing smb.conf: the distribution file stays
    # untouched and a re-run cannot add the same block twice.
    if grep -q "pi-home-stack.conf" /etc/samba/smb.conf 2>/dev/null; then
        log_skip "$(t 'smb.conf already includes the share')"
    else
        log_info "$(t 'Adding the include to smb.conf')"
        is_dry_run || {
            cp -a /etc/samba/smb.conf /etc/samba/smb.conf.phs-orig 2>/dev/null || true
            printf '\n# pi-home-stack\ninclude = /etc/samba/pi-home-stack.conf\n' >>/etc/samba/smb.conf
        }
        share_changed=1
    fi

    if ! is_dry_run && ! testparm -s >/dev/null 2>&1; then
        die "$(t 'Samba configuration is invalid - run testparm for details.')"
    fi

    run systemctl enable smbd >/dev/null 2>&1
    restart_if_changed smbd "$share_changed"
    unit_exists nmbd.service && run systemctl restart nmbd 2>/dev/null || true

    if ! is_dry_run; then
        state_set SHARE_NAME "$share_name"
        state_set SMB_USER "$smb_user"
    fi

    log_ok "$(t 'Share reachable at \\\\%s\\%s as %s' "$(primary_ip)" "$share_name" "$smb_user")"
}

module_remove() {
    local share_name smb_user
    share_name=$(state_get SHARE_NAME nas)
    smb_user=$(state_get SMB_USER)

    log_info "$(t 'Removing the share configuration')"
    run rm -f /etc/samba/pi-home-stack.conf
    if grep -q "pi-home-stack" /etc/samba/smb.conf 2>/dev/null; then
        run sed -i '/# pi-home-stack/,+1d' /etc/samba/smb.conf
    fi
    [[ -n $smb_user ]] && run smbpasswd -x "$smb_user" 2>/dev/null
    unit_exists smbd.service && run systemctl restart smbd
    log_warn "$(t 'User %s and the data are left in place.' "$smb_user")"
}
