#!/usr/bin/env bash
# The existing speed-test service - adopted, not replaced.
#
# This is the one service whose code is not shipped by the stack: it lives in the
# data store together with its measurement history, and that history is the whole
# point. Rewriting it would mean a new database schema and a new format for data
# going back years. So the module checks what is there and builds the units
# around it.
#
# Two units again, same split as the old setup: a long-running reader that
# answers the dashboard, and a timer that takes the measurements.
#
# The route /api belongs to this module, because the service behind it does. The
# dashboard component writes the same location when this one is absent - only
# one of the two may do it, or nginx refuses to start on a duplicate location.

SPEEDTEST_DIRNAME="speedtest"
# Dateinamen der adoptierten Anwendung. Als Variablen, damit das Modul nicht
# auf die Benennung einer bestimmten Installation festgelegt ist.
SPEEDTEST_API_SCRIPT="${SPEEDTEST_API_SCRIPT:-read_db.py}"
SPEEDTEST_MEASURE_SCRIPT="${SPEEDTEST_MEASURE_SCRIPT:-test.py}"
SPEEDTEST_PORT_DEFAULT=5000
SPEEDTEST_USER_DEFAULT="pi-nas-user"

module_install() {
    local data_root app_dir port svc_user times oncalendar changed=0

    data_root=$(state_get SHARE_DATA_DIR)
    [[ -n $data_root ]] || die "$(t 'Data store missing - set up the storage component first.')"

    app_dir=$(state_get SPEEDTEST_DIR)
    if [[ -z $app_dir ]]; then
        ask app_dir "$(t 'Where does the speed-test service live?')" \
            "$data_root/services/$SPEEDTEST_DIRNAME"
    fi
    [[ -d $app_dir ]] || die "$(t 'Not found: %s' "$app_dir")"

    # Determined up here because the checks below name it in their advice.
    svc_user=$(state_get SPEEDTEST_USER)
    if [[ -z $svc_user ]]; then
        # The share user owns the data store, so it can read and write there.
        svc_user=$(state_get SMB_USER "$SPEEDTEST_USER_DEFAULT")
    fi
    user_exists "$svc_user" || die "$(t 'User %s does not exist.' "$svc_user")"

    # Named individually, because a missing reader and a missing measurement
    # script have different consequences.
    local missing=()
    [[ -f $app_dir/$SPEEDTEST_API_SCRIPT ]] \
        || missing+=("$SPEEDTEST_API_SCRIPT ($(t 'the API for the dashboard'))")
    [[ -f $app_dir/$SPEEDTEST_MEASURE_SCRIPT ]] \
        || missing+=("$SPEEDTEST_MEASURE_SCRIPT ($(t 'the measurement itself'))")
    [[ -x $app_dir/venv/bin/python ]] || missing+=("venv/bin/python ($(t 'the Python environment'))")
    if [[ ${#missing[@]} -eq 0 ]] && ! is_dry_run; then
        # Ein venv ueberlebt keinen Versionssprung des System-Python.
        # venv/bin/python ist ein Symlink darauf, startet also weiter - aber die
        # Pakete liegen in venv/lib/python<alt>/site-packages, und das neue
        # Python sucht in python<neu>. Ergebnis: ein venv, das laeuft und in dem
        # nichts installiert ist, nicht einmal pip. Ein Test auf "startet"
        # genuegt hier deshalb nicht.
        local venv_py
        venv_py=$("$app_dir/venv/bin/python" -c \
                  'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null) || venv_py=""
        if [[ -z $venv_py ]]; then
            missing+=("venv ($(t 'the interpreter does not start'))")
        elif [[ ! -d $app_dir/venv/lib/python$venv_py ]]; then
            local have
            have=$(cd "$app_dir/venv/lib" 2>/dev/null && echo python* | tr ' ' ',')
            log_warn "$(t 'The environment in %s is orphaned.' "$app_dir/venv")"
            log_raw  "      $(t 'Interpreter: Python %s, packages for: %s' "$venv_py" "${have:-?}")"
            log_raw  "      $(t 'A venv does not survive a system Python upgrade.')"
            log_info "$(t 'Rebuild it, then install what the scripts import:')"
            log_raw  "        sudo mv $app_dir/venv $app_dir/venv.alt"
            log_raw  "        sudo python3 -m venv $app_dir/venv"
            log_raw  "        sudo $app_dir/venv/bin/pip install -r <$(t 'requirements')>"
            log_raw  "        sudo chown -R $svc_user: $app_dir/venv"
            die "$(t 'The service cannot start with this environment.')"
        fi

        # Zweite Stufe: die Importe der Skripte im venv nachvollziehen.
        # Paketnamen zu raten geht nicht - das Modul kennt die Abhaengigkeiten
        # dieses Dienstes nicht, und sie decken sich nicht mit den Modulnamen
        # (flask_cors kommt aus flask-cors, speedtest aus speedtest-cli). Der
        # Import selbst ist die verlaessliche Probe und faengt genau den Fall
        # "venv neu gebaut, ein Paket vergessen", bevor die Units aktiv werden.
        local mods mod unimportable=()
        mods=$(grep -hoE '^[[:space:]]*(import|from)[[:space:]]+[A-Za-z_][A-Za-z0-9_]*' \
                   "$app_dir/$SPEEDTEST_MEASURE_SCRIPT" \
                   "$app_dir/$SPEEDTEST_API_SCRIPT" 2>/dev/null \
               | awk '{print $2}' | sort -u)
        for mod in $mods; do
            "$app_dir/venv/bin/python" -c "import $mod" 2>/dev/null \
                || unimportable+=("$mod")
        done
        if [[ ${#unimportable[@]} -gt 0 ]]; then
            log_warn "$(t 'The environment in %s cannot import:' "$app_dir/venv")"
            for mod in "${unimportable[@]}"; do log_raw "      $mod"; done
            log_info "$(t 'Install the packages providing them, then run this again:')"
            if [[ -f $app_dir/requirements.txt ]]; then
                log_raw "        sudo $app_dir/venv/bin/pip install -r $app_dir/requirements.txt"
            else
                log_raw "        sudo $app_dir/venv/bin/pip install <$(t 'package')>"
                log_info "$(t 'A requirements.txt in %s would make this unnecessary.' "$app_dir")"
            fi
            log_raw "        sudo chown -R $svc_user: $app_dir/venv"
            die "$(t 'The service would start and immediately fail.')"
        fi
    fi
    if [[ ${#missing[@]} -gt 0 ]]; then
        log_warn "$(t 'Missing in %s:' "$app_dir")"
        local item
        for item in "${missing[@]}"; do log_raw "      $item"; done
        die "$(t 'This component adopts an existing service - it does not bring its own.')"
    fi

    port=$(state_get SPEEDTEST_PORT)
    [[ -n $port && $port != none ]] || port=$SPEEDTEST_PORT_DEFAULT

    times=$(state_get SPEEDTEST_TIMES)
    if [[ -z $times ]]; then
        ask times "$(t 'At what times should it measure? (HH:MM, comma-separated)')" \
            "03:23,23:23"
    fi
    # systemd takes several OnCalendar lines, one per time - simpler and easier
    # to read back than squeezing them into one expression.
    oncalendar=""
    local one
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

    SPEEDTEST_APP_DIR="$app_dir" SPEEDTEST_SERVICE_USER="$svc_user" \
    SPEEDTEST_API_SCRIPT="$SPEEDTEST_API_SCRIPT" \
        render_template "$PHS_TEMPLATE_DIR/speedtest-api.service" \
                        /etc/systemd/system/pi-home-speedtest.service 0644
    [[ $FILE_CHANGED == 1 ]] && changed=1

    SPEEDTEST_APP_DIR="$app_dir" SPEEDTEST_SERVICE_USER="$svc_user" \
    SPEEDTEST_MEASURE_SCRIPT="$SPEEDTEST_MEASURE_SCRIPT" \
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
        # The dashboard component writes the same location. Removing its file
        # here is what keeps nginx startable; it checks for this component in
        # turn, so a later dashboard run will not put it back.
        if [[ -f /etc/nginx/pi-home-stack/70-dashboard.conf ]]; then
            run rm -f /etc/nginx/pi-home-stack/70-dashboard.conf
            log_info "$(t 'Took the /api route over from the dashboard component.')"
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
    fi

    log_ok "$(t 'Speed test measures at %s, API at %s' "$times" "http://$(primary_ip)/api/")"
    log_info "$(t 'Measure once now: sudo systemctl start pi-home-speedtest-measure')"
    log_info "$(t 'The history stays in %s and is covered by the backup.' "$app_dir")"
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
    # Nothing in the application directory is touched: the stack never put it
    # there and the measurement history is irreplaceable.
    log_warn "$(t 'The service and its history in %s are left untouched.' \
                   "$(state_get SPEEDTEST_DIR "?")")"
    log_info "$(t 'Re-run the dashboard component to get the /api route back.')"
}
