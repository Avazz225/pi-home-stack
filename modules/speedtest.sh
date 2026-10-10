#!/usr/bin/env bash
# Periodic speed measurement with a small read API, shipped from apps/speedtest.
#
# Two units: a long-running reader that answers the dashboard, and a timer that
# takes the measurements. Deliberately two, because a measurement that fails
# should show up in systemctl rather than disappear into a restart loop.
#
# The service is deployed into the data store when there is one, so that its
# measurement history travels with the rest of the data and is covered by the
# backup. Without a data store it goes to /var/lib. Either way the database is
# never touched by this module - only the code around it.
#
# The contracted rates are asked for, not guessed: the percentages and the SLA
# column mean nothing without them, and nobody else knows what a line was sold
# as.

SPEEDTEST_DIRNAME="speedtest"
SPEEDTEST_FALLBACK_ROOT="/var/lib/pi-home-stack"
SPEEDTEST_API_SCRIPT="read_db.py"
SPEEDTEST_MEASURE_SCRIPT="test.py"
SPEEDTEST_PORT_DEFAULT=5000
SPEEDTEST_USER_DEFAULT="pi-nas-user"
# Files that make up the application. The database is NOT in this list.
SPEEDTEST_FILES=(read_db.py test.py schema.sql requirements.txt)

module_install() {
    local src app_dir port svc_user times oncalendar up down one changed=0

    src="$PHS_ROOT/apps/$SPEEDTEST_DIRNAME"
    [[ -d $src ]] || die "$(t 'apps/%s is missing from %s' "$SPEEDTEST_DIRNAME" "$PHS_ROOT")"

    # Ein Datenspeicher ist willkommen, aber nicht Bedingung. Ihn zu VERLANGEN
    # zog storage nach und stellte Fragen zu Platten, die mit einer Messung
    # nichts zu tun haben.
    local data_root
    data_root=$(state_get SHARE_DATA_DIR)
    app_dir=$(state_get SPEEDTEST_DIR)
    if [[ -z $app_dir ]]; then
        if [[ -n $data_root && -d $data_root ]]; then
            app_dir="$data_root/services/$SPEEDTEST_DIRNAME"
            log_info "$(t 'Service and history go to %s - covered by the backup' "$app_dir")"
        else
            app_dir="$SPEEDTEST_FALLBACK_ROOT/$SPEEDTEST_DIRNAME"
            log_warn "$(t 'No data store - the measurement history will not be in any backup.')"
            log_info "$(t 'Set up the storage component first if you want it covered.')"
        fi
    fi

    svc_user=$(state_get SPEEDTEST_USER)
    if [[ -z $svc_user ]]; then
        # Der Freigabebenutzer besitzt den Datenspeicher und darf dort schreiben.
        svc_user=$(state_get SMB_USER "$SPEEDTEST_USER_DEFAULT")
    fi
    if ! user_exists "$svc_user"; then
        log_info "$(t 'Creating service user %s' "$svc_user")"
        run useradd --system --no-create-home --shell /usr/sbin/nologin "$svc_user"
    fi

    port=$(state_get SPEEDTEST_PORT)
    [[ -n $port && $port != none ]] || port=$SPEEDTEST_PORT_DEFAULT

    up=$(state_get SPEEDTEST_UP_MBIT)
    [[ -n $up ]] || ask up "$(t 'Contracted upload in Mbit/s (what the percentages measure against)')" "50"
    down=$(state_get SPEEDTEST_DOWN_MBIT)
    [[ -n $down ]] || ask down "$(t 'Contracted download in Mbit/s')" "250"
    for one in "$up" "$down"; do
        [[ $one =~ ^[0-9]+([.][0-9]+)?$ && $one != 0 ]] \
            || die "$(t 'Not a usable rate: %s' "$one")"
    done

    times=$(state_get SPEEDTEST_TIMES)
    if [[ -z $times ]]; then
        ask times "$(t 'At what times should it measure? (HH:MM, comma-separated)')" \
            "03:23,23:23"
    fi
    # systemd nimmt mehrere OnCalendar-Zeilen, eine je Zeit - einfacher zu lesen
    # als ein zusammengequetschter Ausdruck.
    oncalendar=""
    local IFS_SAVE=$IFS
    IFS=','
    for one in $times; do
        one=${one// /}
        [[ $one =~ ^[0-9]{1,2}:[0-9]{2}$ ]] \
            || { IFS=$IFS_SAVE; die "$(t 'Not a time of day: %s' "$one")"; }
        oncalendar+="OnCalendar=*-*-* $one:00"$'\n'
    done
    IFS=$IFS_SAVE
    oncalendar=${oncalendar%$'\n'}

    # ── Ausliefern ──────────────────────────────────────────────────────────
    ensure_packages python3 python3-venv
    ensure_dir "$app_dir" 0755 "$svc_user:$svc_user"
    local file
    for file in "${SPEEDTEST_FILES[@]}"; do
        write_file "$app_dir/$file" 0644 "$svc_user:$svc_user" <"$src/$file"
        [[ $FILE_CHANGED == 1 ]] && changed=1
    done
    run chmod 0755 "$app_dir/$SPEEDTEST_API_SCRIPT" "$app_dir/$SPEEDTEST_MEASURE_SCRIPT"

    _speedtest_venv "$app_dir" "$svc_user" || die "$(t 'Could not prepare the Python environment.')"

    # ── Units ───────────────────────────────────────────────────────────────
    SPEEDTEST_APP_DIR="$app_dir" SPEEDTEST_SERVICE_USER="$svc_user" \
    SPEEDTEST_API_SCRIPT="$SPEEDTEST_API_SCRIPT" \
        render_template "$PHS_TEMPLATE_DIR/speedtest-api.service" \
                        /etc/systemd/system/pi-home-speedtest.service 0644
    [[ $FILE_CHANGED == 1 ]] && changed=1

    SPEEDTEST_APP_DIR="$app_dir" SPEEDTEST_SERVICE_USER="$svc_user" \
    SPEEDTEST_MEASURE_SCRIPT="$SPEEDTEST_MEASURE_SCRIPT" \
    SPEEDTEST_UP_MBIT="$up" SPEEDTEST_DOWN_MBIT="$down" \
        render_template "$PHS_TEMPLATE_DIR/speedtest-measure.service" \
                        /etc/systemd/system/pi-home-speedtest-measure.service 0644

    SPEEDTEST_ONCALENDAR="$oncalendar" \
        render_template "$PHS_TEMPLATE_DIR/speedtest-measure.timer" \
                        /etc/systemd/system/pi-home-speedtest-measure.timer 0644

    systemd_reload
    run systemctl enable pi-home-speedtest.service >/dev/null 2>&1
    restart_if_changed pi-home-speedtest.service "$changed"
    unit_active pi-home-speedtest.service || run systemctl start pi-home-speedtest.service
    run systemctl enable --now pi-home-speedtest-measure.timer >/dev/null 2>&1

    if feature_installed nginx || [[ -d /etc/nginx/pi-home-stack ]]; then
        # Eine fruehere Fassung des dashboard-Moduls schrieb dieselbe location.
        # Zwei Dateien mit einer location lassen nginx nicht mehr starten.
        if [[ -f /etc/nginx/pi-home-stack/70-dashboard.conf ]]; then
            run rm -f /etc/nginx/pi-home-stack/70-dashboard.conf
            log_info "$(t 'Removed a stale /api route left by an older dashboard run.')"
        fi
        SPEEDTEST_PORT=$port \
            render_template "$PHS_TEMPLATE_DIR/nginx-speedtest.conf" \
                            /etc/nginx/pi-home-stack/25-speedtest.conf 0644
        if nginx -t >/dev/null 2>&1; then
            run systemctl reload nginx
        else
            log_warn "$(t 'nginx test failed - the location is not active.')"
        fi
    fi

    if ! is_dry_run; then
        state_set SPEEDTEST_DIR "$app_dir"
        state_set SPEEDTEST_USER "$svc_user"
        state_set SPEEDTEST_PORT "$port"
        state_set SPEEDTEST_TIMES "$times"
        state_set SPEEDTEST_UP_MBIT "$up"
        state_set SPEEDTEST_DOWN_MBIT "$down"
    fi

    log_ok "$(t 'Measuring at %s against %s/%s Mbit/s, API at %s' \
                "$times" "$up" "$down" "http://$(primary_ip)/speedtest-api/")"
    log_info "$(t 'Measure once now: sudo systemctl start pi-home-speedtest-measure')"
}

# Builds or repairs the environment next to the application.
#
# A venv does not survive a version jump of the system Python: venv/bin/python is
# a symlink onto it and keeps starting, but the packages sit in
# venv/lib/python<old>/site-packages while the new interpreter looks in
# python<new>. The result is an environment that runs and contains nothing, not
# even pip. Testing whether it starts is therefore not enough.
_speedtest_venv() {
    local app_dir=$1 svc_user=$2
    local venv="$app_dir/venv"

    if is_dry_run; then
        log_raw "    ${C_DIM}[dry-run] $(t 'would prepare the venv in %s' "$venv")${C_RESET}"
        return 0
    fi

    local rebuild=0
    if [[ ! -x $venv/bin/python ]]; then
        rebuild=1
    else
        local venv_py
        venv_py=$("$venv/bin/python" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null) || venv_py=""
        if [[ -z $venv_py ]]; then
            log_warn "$(t 'The interpreter in %s does not start - rebuilding.' "$venv")"
            rebuild=1
        elif [[ ! -d $venv/lib/python$venv_py ]]; then
            log_warn "$(t 'The environment in %s is orphaned (interpreter %s) - rebuilding.' \
                          "$venv" "$venv_py")"
            rebuild=1
        fi
    fi

    if [[ $rebuild == 1 ]]; then
        # Das Alte beiseite, nicht weg: wenn der Neubau scheitert, ist der
        # vorherige Zustand noch da.
        [[ -d $venv ]] && run mv "$venv" "$venv.vor-umzug"
        log_info "$(t 'Creating the Python environment in %s' "$venv")"
        run python3 -m venv "$venv" || return 1
        run_quiet "$venv/bin/pip" install --upgrade pip
        run_quiet "$venv/bin/pip" install -r "$app_dir/requirements.txt" || return 1
        run chown -R "$svc_user:$svc_user" "$venv"
    fi

    # Probe statt Paketliste: die Paketnamen decken sich nicht mit den
    # Modulnamen (flask_cors kommt aus flask-cors, speedtest aus speedtest-cli),
    # und der Import selbst ist der verlaessliche Test.
    local mods mod missing=()
    mods=$(grep -hoE '^[[:space:]]*(import|from)[[:space:]]+[A-Za-z_][A-Za-z0-9_]*' \
               "$app_dir/$SPEEDTEST_MEASURE_SCRIPT" "$app_dir/$SPEEDTEST_API_SCRIPT" 2>/dev/null \
           | awk '{print $2}' | sort -u)
    for mod in $mods; do
        "$venv/bin/python" -c "import $mod" 2>/dev/null || missing+=("$mod")
    done
    if [[ ${#missing[@]} -gt 0 ]]; then
        log_info "$(t 'Installing missing dependencies: %s' "${missing[*]}")"
        run_quiet "$venv/bin/pip" install -r "$app_dir/requirements.txt" || return 1
        run chown -R "$svc_user:$svc_user" "$venv"
        for mod in "${missing[@]}"; do
            "$venv/bin/python" -c "import $mod" 2>/dev/null \
                || { log_warn "$(t 'Still cannot import %s' "$mod")"; return 1; }
        done
    fi
    return 0
}

module_remove() {
    run systemctl disable --now pi-home-speedtest-measure.timer 2>/dev/null || true
    run systemctl disable --now pi-home-speedtest.service 2>/dev/null || true
    run rm -f /etc/systemd/system/pi-home-speedtest.service \
              /etc/systemd/system/pi-home-speedtest-measure.service \
              /etc/systemd/system/pi-home-speedtest-measure.timer \
              /etc/nginx/pi-home-stack/25-speedtest.conf
    systemd_reload
    nginx -t >/dev/null 2>&1 && run systemctl reload nginx
    # Weder Code noch Historie werden entfernt: die Messwerte sind nicht
    # wiederherstellbar, und eine entfernte Komponente loescht keine Daten.
    log_warn "$(t 'The service and its history in %s are left in place.' \
                   "$(state_get SPEEDTEST_DIR "?")")"
}
