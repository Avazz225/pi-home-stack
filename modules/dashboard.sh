#!/usr/bin/env bash
# Das React-Dashboard als Startseite.
#
# Es ist eine Single-Page-App, also reine statische Dateien — der location /
# -Eintrag des Haupt-vhosts liefert sie samt try_files-Rückfall auf /index.html.
# Dieses Modul muss deshalb nur bauen und kopieren.
#
# Gebaut wird bevorzugt NICHT auf dem Pi: ein fertiges build/ aus dem Checkout
# wird übernommen, wenn es da ist. Ein Create-React-App-Build braucht ~1 GB
# Arbeitsspeicher und mehrere Minuten, und das Ergebnis ist auf jeder Maschine
# dasselbe. Fehlt es, wird es hier gebaut — mit Hinweis.


module_install() {
    local web_root src build_dir changed=0

    web_root=$(state_get WEB_ROOT /var/www/pi-home)
    [[ -n $web_root ]] || die "$(t 'Web server missing - set up the nginx component first.')"

    # Das Frontend liegt im Repo unter apps/dashboard, mit vorgebautem build/.
    # Keine Rueckfrage, kein fremder Pfad, der nach einem git pull ins Leere
    # zeigt - und kein Node auf dem Pi, solange niemand src/ anfasst.
    src="$PHS_ROOT/apps/dashboard"
    [[ -d $src ]] || die "$(t 'apps/dashboard is missing from %s' "$PHS_ROOT")"

    build_dir="$src/build"
    if [[ -f $build_dir/index.html ]]; then
        log_skip "$(t 'Using the prebuilt bundle in %s' "$build_dir")"
    else
        _dashboard_build "$src" || die "$(t 'Build failed - ship a prebuilt build/ instead.')"
    fi
    [[ -f $build_dir/index.html ]] || die "$(t 'No index.html in %s' "$build_dir")"

    log_info "$(t 'Installing the dashboard into %s' "$web_root")"
    if is_dry_run; then
        log_raw "    ${C_DIM}[dry-run] $(t 'would copy %s to %s' "$build_dir" "$web_root")${C_RESET}"
    else
        ensure_dir "$web_root" 0755 www-data:www-data
        # --delete, because a single-page app has hashed file names: without it
        # the bundles of every earlier build pile up. No exception any more,
        # because homeui cannot sit next to it - install.sh removes it before
        # this module runs (FEATURE_DISPLACES). Two start pages in one place
        # never really worked anyway, only two halves of each.
        #
        # status.json stays: it lives in the web root but belongs to the status
        # component's timer, and the dashboard's system pane reads it.
        run rsync -a --delete --exclude status.json "$build_dir"/ "$web_root"/
        run chown -R www-data:www-data "$web_root"
        changed=1
    fi

    # Die Netzwerkmessung bekommt hier KEINE Route mehr. Sie gehoerte unter
    # /api/, und genau dort liegt Pi-holes eigene REST-API in v6 — zwei Dateien
    # mit derselben location lassen nginx nicht mehr starten. Die Route gehoert
    # jetzt dem speedtest-Modul, das sie unter /speedtest-api/ und dem
    # spezifischeren /api/speed-test-results veroeffentlicht.
    #
    # Eine frueher von diesem Modul geschriebene Datei wird entfernt: sie ist
    # der Grund, warum nginx -t fehlschlaegt.
    if feature_installed nginx || [[ -d /etc/nginx/pi-home-stack ]]; then
        if [[ -f /etc/nginx/pi-home-stack/70-dashboard.conf ]]; then
            run rm -f /etc/nginx/pi-home-stack/70-dashboard.conf
            log_info "$(t 'Removed the old /api route - it collided with Pi-hole.')"
        fi
        if nginx -t >/dev/null 2>&1; then
            run systemctl reload nginx
        else
            log_warn "$(t 'nginx test failed - the dashboard may not be reachable.')"
        fi
    fi


    log_ok "$(t 'Dashboard at %s' "http://$(primary_ip)/")"
    _dashboard_report_routes
}

# Baut im Checkout. Node kommt aus Debian; npm ci braucht die package-lock.json.
_dashboard_build() {
    local src=$1
    log_warn "$(t 'No prebuilt bundle found - building on the Pi, this takes a few minutes.')"
    ensure_packages nodejs npm
    is_dry_run && return 0
    ( cd "$src" || exit 1
      if [[ -f package-lock.json ]]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
      # CI=true macht aus Warnungen Fehler, und das Projekt hat welche aus
      # Altbestand — hier soll gebaut werden, nicht gelintet.
      CI=false npm run build )
}

# Welche APIs das Dashboard braucht und ob sie jemand ausliefert. Eine fehlende
# Route zeigt sich sonst erst als leere Kachel im Browser.
_dashboard_report_routes() {
    local -A routes=(
        [/speedtest-api/]="speedtest"
        [/profile-api/]="apiservices"
        [/tracking-api/]="apiservices"
        [/study-api/]="apiservices"
        [/home-api/]="apiservices"
        [/backup-api/]="backup"
    )
    local route missing=()
    for route in "${!routes[@]}"; do
        grep -rqF "location $route" /etc/nginx/pi-home-stack/ 2>/dev/null \
            || missing+=("$route (${routes[$route]})")
    done
    if [[ ${#missing[@]} -gt 0 ]]; then
        log_warn "$(t 'These panes have no backend yet:')"
        local entry
        for entry in "${missing[@]}"; do log_raw "      $entry"; done
    fi
}

module_remove() {
    local web_root
    web_root=$(state_get WEB_ROOT /var/www/pi-home)
    run rm -f /etc/nginx/pi-home-stack/70-dashboard.conf
    nginx -t >/dev/null 2>&1 && run systemctl reload nginx
    # Die Dateien bleiben: sie sind der Inhalt von /, und ein leeres Web-Root
    # wäre eine Überraschung. Wer sie weg will, löscht sie bewusst.
    log_warn "$(t 'The files in %s are left in place.' "$web_root")"
}
