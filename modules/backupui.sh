#!/usr/bin/env bash
# Web interface for the backup service.
#
# Static files under <web root>/backup/, talking to the API nginx already
# publishes at /backup-api/. Nothing new listens on the network, and the page is
# only ever offered when the backup itself is installed - a configuration screen
# for a service that is not there would be a dead end.

module_install() {
    local web_root target
    web_root=$(state_get WEB_ROOT /var/www/pi-home)
    [[ -n $web_root ]] || die "$(t 'Web server missing - set up the nginx component first.')"
    target="$web_root/backup"

    ensure_dir "$target" 0755 www-data:www-data

    local file changed=0
    for file in index.html app.js backup.css; do
        write_file "$target/$file" 0644 www-data:www-data <"$PHS_ASSET_DIR/backupui/$file"
        [[ $FILE_CHANGED == 1 ]] && changed=1
    done

    # The page reuses the home interface's tokens and chrome, so those files must
    # be present. The homeui module is a hard requirement, but a partial install
    # would otherwise fail silently in the browser rather than here.
    local shared
    for shared in style.css common.js theme-boot.js; do
        [[ -f "$web_root/$shared" ]] && continue
        log_warn "$(t 'Shared file %s is missing - re-run the homeui component.' "$shared")"
    done

    if [[ $changed == 1 ]]; then
        log_ok "$(t 'Backup interface: %s' "http://$(primary_ip)/backup/")"
    else
        log_skip "$(t 'Backup interface already up to date')"
    fi
    log_info "$(t 'Reachable from the home page through the backup tile.')"
}

module_remove() {
    local web_root
    web_root=$(state_get WEB_ROOT /var/www/pi-home)
    run rm -rf "$web_root/backup"
    log_info "$(t 'The backup service itself keeps running.')"
}
