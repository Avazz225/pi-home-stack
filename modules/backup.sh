#!/usr/bin/env bash
# Encrypted S3 backup of the data store.
#
# The encryption key is generated once, stored in the chosen credential store, and
# additionally written to a file only root may read. The service knows nothing but
# that file - it has never heard of KeePass or Vault. If the Pi is lost, exactly
# one key is exposed rather than the whole credential store.

BACKUP_DIR_DEFAULT="/opt/pi-home-stack/backup"
BACKUP_PORT=5003
BACKUP_USER=pi-backup
BACKUP_KEY_FILE="/etc/pi-home-stack/secrets/backup.key"

module_install() {
    local backup_dir nas_root key
    backup_dir=$(state_get BACKUP_DIR "$BACKUP_DIR_DEFAULT")
    nas_root=$(state_get SHARE_DATA_DIR)
    [[ -n $nas_root ]] || die "$(t 'Data store missing - set up the storage component first.')"

    ensure_packages python3 python3-venv

    if user_exists "$BACKUP_USER"; then
        log_skip "$(t 'User %s already exists' "$BACKUP_USER")"
    else
        log_info "$(t 'Creating service user %s' "$BACKUP_USER")"
        run useradd --system --no-create-home --shell /usr/sbin/nologin "$BACKUP_USER"
    fi

    ensure_dir "$backup_dir" 0755 root:root
    ensure_dir "$backup_dir/data" 0750 "$BACKUP_USER:$BACKUP_USER"

    local file changed=0
    for file in state.py filecrypt.py storage_targets.py backup_job.py app.py restore.py \
                schema.sql requirements.txt; do
        write_file "$backup_dir/$file" 0644 root:root <"$PHS_ASSET_DIR/backup/$file"
        [[ $FILE_CHANGED == 1 ]] && changed=1
    done
    run chmod 0755 "$backup_dir/backup_job.py" "$backup_dir/restore.py"

    if ! is_dry_run; then
        rm -rf "$backup_dir/tests"
        cp -r "$PHS_ASSET_DIR/backup/tests" "$backup_dir/tests"
        chmod +x "$backup_dir/tests/run_tests.sh" 2>/dev/null || true
    fi

    # A dedicated venv: boto3 and cryptography do not belong in the system Python.
    if [[ -x "$backup_dir/venv/bin/python" ]]; then
        log_skip "$(t 'Backup Python environment present')"
    else
        log_info "$(t 'Creating the backup Python environment (takes a while on a Pi)')"
        run python3 -m venv "$backup_dir/venv"
        changed=1
    fi
    if [[ $changed == 1 ]]; then
        ensure_packages build-essential libffi-dev python3-dev
        run_quiet "$backup_dir/venv/bin/pip" install --upgrade pip
        run_quiet "$backup_dir/venv/bin/pip" install -r "$backup_dir/requirements.txt" \
            || die "$(t 'Could not install the backup dependencies.')"
    fi

    # Provision the key: the credential store is the source of truth, the file is
    # the copy the service reads.
    key=$(secret_ensure "backup/encryption-key" "pi-home-stack" 44) \
        || die "$(t 'Could not generate the backup key.')"
    secret_materialise "backup/encryption-key" "$BACKUP_KEY_FILE" "$key"
    run chown root:"$BACKUP_USER" "$BACKUP_KEY_FILE"
    run chmod 0640 "$BACKUP_KEY_FILE"

    BACKUP_APP_DIR="$backup_dir" BACKUP_SERVICE_USER="$BACKUP_USER" \
    BACKUP_API_PORT="$BACKUP_PORT" \
        render_template "$PHS_TEMPLATE_DIR/backup.service" \
                        /etc/systemd/system/pi-home-backup.service 0644
    [[ $FILE_CHANGED == 1 ]] && changed=1

    BACKUP_APP_DIR="$backup_dir" BACKUP_SERVICE_USER="$BACKUP_USER" \
        render_template "$PHS_TEMPLATE_DIR/backup-job.service" \
                        /etc/systemd/system/pi-home-backup-job.service 0644
    render_template "$PHS_TEMPLATE_DIR/backup-job.timer" \
                    /etc/systemd/system/pi-home-backup-job.timer 0644

    systemd_reload
    run systemctl enable pi-home-backup.service >/dev/null 2>&1
    restart_if_changed pi-home-backup.service "$changed"
    unit_active pi-home-backup.service || run systemctl start pi-home-backup.service
    run systemctl enable --now pi-home-backup-job.timer >/dev/null 2>&1

    # Seed the configuration so the interface does not start with empty fields.
    if ! is_dry_run; then
        sleep 1
        "$backup_dir/venv/bin/python" - "$backup_dir" "$nas_root" "$BACKUP_KEY_FILE" <<'PYEOF' || log_warn "$(t 'Could not seed the backup configuration.')"
import sys
sys.path.insert(0, sys.argv[1])
import state
state.init_db()
db = state.connect()
config = state.get_config(db)
values = {}
if not config.get("nas_root") or config["nas_root"] == state.DEFAULTS["nas_root"]:
    values["nas_root"] = sys.argv[2]
values["key_file"] = sys.argv[3]
state.set_config(db, values)
db.close()
PYEOF
        chown -R "$BACKUP_USER:$BACKUP_USER" "$backup_dir/data"
    fi

    if feature_installed nginx || [[ -d /etc/nginx/pi-home-stack ]]; then
        BACKUP_API_PORT=$BACKUP_PORT \
            render_template "$PHS_TEMPLATE_DIR/nginx-backup.conf" \
                            /etc/nginx/pi-home-stack/20-backup.conf 0644
        if nginx -t >/dev/null 2>&1; then
            run systemctl reload nginx
        else
            log_warn "$(t 'nginx test failed - the location is not active.')"
        fi
    fi

    if ! is_dry_run; then
        state_set BACKUP_DIR "$backup_dir"
        state_set BACKUP_DB "$backup_dir/data/backup.db"
    fi

    log_ok "$(t 'Backup service running. API: %s' "http://$(primary_ip)/backup-api/status")"
    log_raw ""
    log_info "${C_BOLD}$(t 'Still to do before anything is backed up:')${C_RESET}"
    log_info "  1. $(t 'Create an S3 bucket and an IAM user with write access in AWS')"
    log_info "  2. $(t 'Enter region, bucket and credentials under /backup-api/')"
    log_info "  3. $(t 'Select the folders to back up (default: none)')"
    log_info "  4. $(t 'Enable the backup')"
    log_warn "$(t 'The backup key lives in %s.' "$BACKUP_KEY_FILE")"
    log_warn "$(t 'Without it the backups cannot be decrypted - keep a copy off site.')"
}

module_remove() {
    run systemctl disable --now pi-home-backup-job.timer 2>/dev/null || true
    run systemctl disable --now pi-home-backup.service 2>/dev/null || true
    run rm -f /etc/systemd/system/pi-home-backup.service \
              /etc/systemd/system/pi-home-backup-job.service \
              /etc/systemd/system/pi-home-backup-job.timer \
              /etc/nginx/pi-home-stack/20-backup.conf
    systemd_reload
    nginx -t >/dev/null 2>&1 && run systemctl reload nginx
    log_warn "$(t 'The object index and the key are left in place:')"
    log_warn "  $(state_get BACKUP_DIR "$BACKUP_DIR_DEFAULT")/data"
    log_warn "  $BACKUP_KEY_FILE"
    log_info "$(t 'Objects in S3 are not touched.')"
}
