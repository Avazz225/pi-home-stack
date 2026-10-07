#!/usr/bin/env bash
# The dashboard's backend services.
#
# Four Flask services of identical shape — own directory, own venv, SQLite or
# JSON under data/, one systemd unit, one nginx location. They differ only in
# name, port, route and which Python they need, so they are one module with a
# table rather than four almost identical files.
#
# The home service is the odd one out: deebot-client needs Python 3.14, which
# Raspberry Pi OS does not ship. Its row therefore carries a minimum version, and
# the module looks for a suitable interpreter instead of assuming python3 will do.

# key|directory name|port|nginx route|label|minimum python
API_SERVICES=(
    "quickaction|quickaction_persistence_service|5001|profile-api|Profile and todos|3.9"
    "tracking|tracking_persistence_service|5002|tracking-api|Feature tracking|3.9"
    "study|study_persistence_service|5004|study-api|Study planning|3.9"
    "home|home_persistence_service|5005|home-api|Home — Hue, yeedi, Shelly|3.14"
)

API_ROOT_DEFAULT="/opt/pi-home-stack/api"
API_USER=pi-api

# Finds an interpreter that satisfies the minimum. Returns empty when there is
# none, so the caller can skip that service instead of installing something that
# cannot start.
_api_python() {
    local want=$1 candidate
    local -a candidates=(python3 python3.14 python3.13 python3.12)

    # Ein selbst installierter Interpreter liegt irgendwo unter /opt - ein
    # Glob, damit eine andere Patchversion nicht durchs Raster fällt.
    candidates+=(/opt/python-3.1*/bin/python3.1*)

    # install-python314.sh legt ihn ohne sudo ins Heimatverzeichnis. Dieser
    # Installer laeuft dagegen MIT sudo, wo $HOME gleich /root ist - dort hat
    # niemand etwas installiert. Also auch im Home des aufrufenden Benutzers
    # suchen. Gefunden wird er dann zwar, taugt aber meist nicht: ein
    # Heimatverzeichnis ist oft 0700, und der Dienst laeuft als pi-api, der es
    # nicht betreten kann. Deshalb wird er unten geprueft UND verworfen, wenn
    # der Dienstbenutzer ihn nicht ausfuehren kann.
    local home
    for home in "${SUDO_USER:+$(getent passwd "$SUDO_USER" 2>/dev/null | cut -d: -f6)}" "$HOME"; do
        [[ -n $home ]] || continue
        candidates+=("$home"/.local/opt/python-3.1*/bin/python3.1*)
    done

    for candidate in "${candidates[@]}"; do
        command -v "$candidate" >/dev/null 2>&1 || [[ -x $candidate ]] || continue
        "$candidate" -c "
import sys
want = tuple(int(p) for p in '$want'.split('.'))
sys.exit(0 if sys.version_info[:len(want)] >= want else 1)
" >/dev/null 2>&1 || continue

        # Der Dienst laeuft als $API_USER, nicht als root. Ein Interpreter in
        # einem 0700-Heimatverzeichnis besteht die Versionspruefung, ist fuer
        # den Dienst aber unerreichbar, und die Unit waere sofort tot. Also
        # einmal wirklich als dieser Benutzer starten.
        #
        # Die Meldung geht auf stderr: diese Funktion wird ueber $(...)
        # aufgerufen, auf stdout gehoert nur der Pfad.
        if user_exists "$API_USER" \
           && ! runuser -u "$API_USER" -- "$candidate" -c pass >/dev/null 2>&1; then
            log_warn "$(t 'Python %s fits but %s cannot run it - check the path permissions.' \
                          "$candidate" "$API_USER")" >&2
            continue
        fi
        echo "$candidate"
        return 0
    done
    return 1
}

module_install() {
    local api_root src_root data_root
    api_root=$(state_get API_ROOT "$API_ROOT_DEFAULT")
    src_root=$(state_get API_SRC_ROOT)

    # The databases belong on the data store, not on the boot medium. Two reasons:
    # a boot medium that dies takes them with it, and the backup only covers the
    # data store — a database under /opt is simply not in any backup.
    data_root=$(state_get SHARE_DATA_DIR)
    if [[ -n $data_root && -d $data_root ]]; then
        data_root="$data_root/services"
        log_info "$(t 'Databases go to %s - covered by the backup' "$data_root")"
    else
        data_root=""
        log_warn "$(t 'No data store - databases stay on the boot medium and are not backed up.')"
    fi

    if [[ -z $src_root ]]; then
        # Kein geratener Projektname als Vorgabe: nur das Heimatverzeichnis,
        # den Rest tippt der Betreiber.
        ask src_root "$(t 'Where is the services checkout?')" \
            "/home/$(logname 2>/dev/null || echo pi)"
    fi
    [[ -d $src_root ]] || die "$(t 'Checkout not found: %s' "$src_root")"

    ensure_packages python3 python3-venv
    if user_exists "$API_USER"; then
        log_skip "$(t 'User %s already exists' "$API_USER")"
    else
        log_info "$(t 'Creating service user %s' "$API_USER")"
        run useradd --system --no-create-home --shell /usr/sbin/nologin "$API_USER"
    fi
    ensure_dir "$api_root" 0755 root:root

    local installed=() skipped=()
    local entry key dirname port route label minpy src dest python changed

    for entry in "${API_SERVICES[@]}"; do
        IFS='|' read -r key dirname port route label minpy <<<"$entry"
        src="$src_root/$dirname"

        if [[ ! -f $src/app.py ]]; then
            log_warn "$(t 'Skipping %s - not found at %s' "$key" "$src")"
            skipped+=("$key")
            continue
        fi

        if ! python=$(_api_python "$minpy"); then
            log_warn "$(t 'Skipping %s - needs Python %s or newer' "$key" "$minpy")"
            [[ $key == home ]] && log_info "$(t 'See install-python314.sh in the service directory.')"
            skipped+=("$key")
            continue
        fi

        dest="$api_root/$key"
        ensure_dir "$dest" 0755 root:root
        # Everything but data/ is code and gets replaced on every run; data/
        # belongs to the service and is never touched.
        changed=0
        local file
        for file in app.py schema.sql seed.json requirements.txt hue.py vacuum.py; do
            [[ -f $src/$file ]] || continue
            write_file "$dest/$file" 0644 root:root <"$src/$file"
            [[ $FILE_CHANGED == 1 ]] && changed=1
        done
        # The services look for data/ next to app.py. Rather than patching four
        # code bases, the directory becomes a symlink onto the data store — the
        # service notices nothing, the bytes land on the array.
        local data_dir
        if [[ -n $data_root ]]; then
            # Verzeichnisname des Dienstes, nicht der kurze Key: auf einem Pi, der
            # die Dienste vorher von Hand unter <datenspeicher>/services/<name>/data
            # betrieben hat, findet das Modul die Daten damit genau dort, wo sie
            # schon liegen — kein Umzug, kein Risiko.
            data_dir="$data_root/$dirname/data"
            ensure_dir "$data_dir" 0750 "$API_USER:$API_USER"
            # ensure_dir setzt nur das Verzeichnis. Eine uebernommene Datenbank
            # aus der handgebauten Installation gehoert aber noch dem damaligen
            # Benutzer, und mit 0644 kann der Dienst sie LESEN, aber nicht
            # schreiben - die Oberflaeche zeigt dann alles an und scheitert erst
            # beim Speichern. Deshalb auch der Inhalt.
            if ! is_dry_run && [[ -d $data_dir ]]; then
                local wrong
                wrong=$(find "$data_dir" ! -user "$API_USER" -printf . 2>/dev/null | wc -c)
                if [[ ${wrong:-0} -gt 0 ]]; then
                    log_info "$(t 'Taking over %s file(s) in %s' "$wrong" "$data_dir")"
                    run chown -R "$API_USER:$API_USER" "$data_dir"
                fi
            fi
            if [[ -L $dest/data ]]; then
                log_skip "$(t 'data/ for %s already points at the data store' "$key")"
            elif [[ -d $dest/data ]]; then
                # An earlier run without a data store left real files here
                log_warn "$(t 'Moving existing data of %s to %s' "$key" "$data_dir")"
                run cp -an "$dest/data/." "$data_dir/" 2>/dev/null || true
                run mv "$dest/data" "$dest/data.vor-umzug"
                run ln -s "$data_dir" "$dest/data"
            else
                run ln -s "$data_dir" "$dest/data"
            fi
        else
            data_dir="$dest/data"
            ensure_dir "$data_dir" 0750 "$API_USER:$API_USER"
        fi

        if [[ ! -x $dest/venv/bin/python ]]; then
            log_info "$(t 'Creating virtualenv for %s with %s' "$key" "$python")"
            run "$python" -m venv "$dest/venv"
            changed=1
        fi
        if [[ -f $dest/requirements.txt && $changed == 1 ]]; then
            log_info "$(t 'Installing dependencies for %s' "$key")"
            run "$dest/venv/bin/pip" install --quiet --upgrade pip
            run "$dest/venv/bin/pip" install --quiet -r "$dest/requirements.txt" \
                || log_warn "$(t 'Some dependencies of %s failed to install.' "$key")"
        fi

        # ReadWritePaths and RequiresMountsFor need the real path, not the symlink
        API_LABEL="$label" API_DIR="$dest" API_DATA="$data_dir" \
        API_SERVICE_USER="$API_USER" \
            render_template "$PHS_TEMPLATE_DIR/apiservice.service" \
                            "/etc/systemd/system/pi-home-api-$key.service" 0644
        [[ $FILE_CHANGED == 1 ]] && changed=1

        systemd_reload
        run systemctl enable "pi-home-api-$key.service" >/dev/null 2>&1
        restart_if_changed "pi-home-api-$key.service" "$changed"
        unit_active "pi-home-api-$key.service" || run systemctl start "pi-home-api-$key.service"
        installed+=("$key:$port:$route")
    done

    if feature_installed nginx || [[ -d /etc/nginx/pi-home-stack ]]; then
        _api_write_nginx "${installed[@]}"
    fi

    if ! is_dry_run; then
        state_set API_ROOT "$api_root"
        state_set API_SRC_ROOT "$src_root"
    fi

    [[ ${#installed[@]} -gt 0 ]] && log_ok "$(t '%s service(s) running' "${#installed[@]}")"
    [[ ${#skipped[@]} -gt 0 ]] && log_warn "$(t 'Not installed: %s' "${skipped[*]}")"
}

# One location block per running service. Written in one go rather than appended,
# so a service that was skipped does not leave a proxy pointing at nothing.
_api_write_nginx() {
    local conf=/etc/nginx/pi-home-stack/40-apiservices.conf
    local body="# pi-home-stack - dashboard backend services.\n"
    local entry key port route
    for entry in "$@"; do
        IFS=':' read -r key port route <<<"$entry"
        body+="\nlocation /$route/ {\n"
        body+="    proxy_pass http://127.0.0.1:$port/;\n"
        body+="    proxy_set_header Host            \$host;\n"
        body+="    proxy_set_header X-Real-IP       \$remote_addr;\n"
        body+="    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;\n"
        body+="}\n"
    done
    printf '%b' "$body" | write_file "$conf" 0644 root:root
    if nginx -t >/dev/null 2>&1; then
        run systemctl reload nginx
    else
        log_warn "$(t 'nginx test failed - the locations are not active.')"
    fi
}

module_remove() {
    local entry key rest
    for entry in "${API_SERVICES[@]}"; do
        IFS='|' read -r key rest <<<"$entry"
        run systemctl disable --now "pi-home-api-$key.service" 2>/dev/null || true
        run rm -f "/etc/systemd/system/pi-home-api-$key.service"
    done
    run rm -f /etc/nginx/pi-home-stack/40-apiservices.conf
    systemd_reload
    nginx -t >/dev/null 2>&1 && run systemctl reload nginx
    log_warn "$(t 'Databases are left in place at %s.' "$(state_get API_ROOT "$API_ROOT_DEFAULT")/<service>/data")"
}
