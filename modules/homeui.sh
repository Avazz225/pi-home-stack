#!/usr/bin/env bash
# Home interface: a static status page over the numbers the status component
# collects.
#
# Deliberately no application server. The page is a file and reads the
# status.json that the status timer rewrites once a minute.

module_install() {
    local web_root
    web_root=$(state_get WEB_ROOT /var/www/pi-home)
    [[ -n $web_root ]] || die "$(t 'Web server missing - set up the nginx component first.')"

    ensure_dir "$web_root" 0755 www-data:www-data

    local file changed=0
    # common.js and theme-boot.js are shared with the backup interface.
    for file in index.html style.css app.js common.js theme-boot.js; do
        write_file "$web_root/$file" 0644 www-data:www-data <"$PHS_ASSET_DIR/homeui/$file"
        [[ $FILE_CHANGED == 1 ]] && changed=1
    done

    # Die Zahlen selbst kommen von der status-Komponente, nicht von hier: sie
    # sind keine Eigenschaft dieser Seite, und das Dashboard braucht sie
    # genauso.

    log_ok "$(t 'Home interface: %s' "http://$(primary_ip)/")"
}

module_remove() {
    local web_root
    web_root=$(state_get WEB_ROOT /var/www/pi-home)
    # Nur die Seite. Sammler, Timer und status.json gehoeren der
    # status-Komponente, und die kann noch gebraucht werden - vom Dashboard.
    run rm -f "$web_root"/{index.html,style.css,app.js,common.js,theme-boot.js}
    log_info "$(t 'Web server, web root and the status collector are left in place.')"
}
