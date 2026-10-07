#!/usr/bin/env bash
# Grafana als Container.
#
# Bewusst kein Paket: Grafana liefert für arm64 zwar eines, aber der bisherige
# Aufbau auf diesem Pi war ein Compose-Stack, und das Volume mit den Dashboards
# soll unverändert weiterbenutzt werden. Ein Umstieg auf das Paket würde die
# grafana.db an eine andere Stelle verlangen und nichts verbessern.
#
# Das Volume wird als "external" deklariert: so übersteht es ein
# 'compose down -v' und behält seinen Namen — unter dem liegen die geretteten
# Dashboards, Datenquellen und Benutzer.

GRAFANA_DIR_DEFAULT="/opt/pi-home-stack/grafana"
GRAFANA_PORT=3000
GRAFANA_IMAGE_TAG_DEFAULT="latest"
GRAFANA_MEM_LIMIT_DEFAULT="300m"
# Derselbe Name wie im alten monitoring-Stack (Projekt "monitoring",
# Volume "grafana-data" -> "monitoring_grafana-data").
GRAFANA_VOLUME_DEFAULT="monitoring_grafana-data"

module_install() {
    local grafana_dir volume image_tag mem_limit admin_user password secret_file changed=0

    grafana_dir=$(state_get GRAFANA_DIR "$GRAFANA_DIR_DEFAULT")
    volume=$(state_get GRAFANA_VOLUME "$GRAFANA_VOLUME_DEFAULT")
    image_tag=$(state_get GRAFANA_IMAGE_TAG "$GRAFANA_IMAGE_TAG_DEFAULT")
    mem_limit=$(state_get GRAFANA_MEM_LIMIT "$GRAFANA_MEM_LIMIT_DEFAULT")
    admin_user=$(state_get GRAFANA_ADMIN_USER admin)

    # Debian trennt die Teile anders als Dockers eigenes Repo, und die Namen von
    # dort funktionieren hier nicht:
    #   docker.io       nur der Daemon (dockerd)
    #   docker-cli      /usr/bin/docker — ohne das gibt es kein docker-Kommando
    #   docker-compose  Compose v2 (2.26), bringt das cli-plugin mit, sodass
    #                   "docker compose" als Unterkommando funktioniert
    # ensure_packages überspringt, was schon installiert ist.
    ensure_packages docker.io docker-cli docker-compose

    # Erst prüfen, dann weitermachen. Ohne diese Stelle lief das Modul in ein
    # "docker: command not found" mitten im Anlegen des Volumes und hinterließ
    # eine halbe Installation samt systemd-Unit, die beim Start scheitert.
    if ! is_dry_run; then
        command -v docker >/dev/null 2>&1 \
            || die "$(t 'Docker is not available - install docker.io and try again.')"
        docker compose version >/dev/null 2>&1 \
            || die "$(t 'Docker Compose v2 is missing - install docker-compose and try again.')"
        systemctl is-active --quiet docker \
            || run systemctl enable --now docker
    fi

    ensure_dir "$grafana_dir" 0755 root:root

    # Das Passwort kommt aus dem Geheimnis-Store und wird in eine root-only
    # Datei geschrieben, die der Container als Docker-Secret liest. Es steht
    # damit nicht in der Compose-Datei und nicht in 'docker inspect'.
    password=$(secret_ensure "grafana/admin" "$admin_user" 20)
    secret_file="$grafana_dir/admin_password"
    secret_materialise "grafana/admin" "$secret_file" "$password"
    # Der Container laeuft als UID/GID 472 — Benutzer "grafana" im offiziellen
    # Image. Ein Docker-Secret aus einer Datei wird in nicht-Swarm-Betrieb
    # unveraendert nach /run/secrets gebunden, Besitzer und Modus des Hosts
    # gelten dort also weiter (uid/gid/mode am Secret wirken nur in Swarm).
    # Mit 0600 root:root kann Grafana die Datei nicht lesen, schreibt das nur
    # ins Log und faellt auf das Standardpasswort zurueck — der Stack glaubt
    # dann, ein starkes gesetzt zu haben.
    #
    # Gruppe 472 und 0640 statt 0644: sonst koennte jeder lokale Benutzer auf
    # dem Pi das Administratorpasswort lesen.
    if ! is_dry_run; then
        run chown root:472 "$secret_file"
        run chmod 0640 "$secret_file"
    fi

    # Volume muss existieren, bevor es als external eingebunden wird
    if is_dry_run; then
        log_raw "    $(t 'would ensure docker volume %s' "$volume")"
    elif docker volume inspect "$volume" >/dev/null 2>&1; then
        log_skip "$(t 'Docker volume %s already exists' "$volume")"
    else
        log_info "$(t 'Creating docker volume %s' "$volume")"
        run docker volume create "$volume" >/dev/null
    fi

    GRAFANA_DIR="$grafana_dir" GRAFANA_PORT="$GRAFANA_PORT" \
    GRAFANA_IMAGE_TAG="$image_tag" GRAFANA_MEM_LIMIT="$mem_limit" \
    GRAFANA_ADMIN_USER="$admin_user" GRAFANA_VOLUME="$volume" \
    GRAFANA_SECRET_FILE="$secret_file" GRAFANA_TZ="$(cat /etc/timezone 2>/dev/null || echo UTC)" \
    GRAFANA_ROOT_URL="http://$(primary_ip)/grafana/" \
        render_template "$PHS_TEMPLATE_DIR/grafana-compose.yml" \
                        "$grafana_dir/docker-compose.yml" 0640
    [[ $FILE_CHANGED == 1 ]] && changed=1

    GRAFANA_DIR="$grafana_dir" \
        render_template "$PHS_TEMPLATE_DIR/grafana.service" \
                        /etc/systemd/system/pi-home-grafana.service 0644
    [[ $FILE_CHANGED == 1 ]] && changed=1

    systemd_reload
    run systemctl enable pi-home-grafana.service >/dev/null 2>&1
    restart_if_changed pi-home-grafana.service "$changed"
    unit_active pi-home-grafana.service || run systemctl start pi-home-grafana.service

    if feature_installed nginx || [[ -d /etc/nginx/pi-home-stack ]]; then
        GRAFANA_PORT=$GRAFANA_PORT \
            render_template "$PHS_TEMPLATE_DIR/nginx-grafana.conf" \
                            /etc/nginx/pi-home-stack/50-grafana.conf 0644
        if nginx -t >/dev/null 2>&1; then
            run systemctl reload nginx
        else
            log_warn "$(t 'nginx test failed - the location is not active.')"
        fi
    fi

    if ! is_dry_run; then
        state_set GRAFANA_DIR "$grafana_dir"
        state_set GRAFANA_VOLUME "$volume"
        state_set GRAFANA_IMAGE_TAG "$image_tag"
        state_set GRAFANA_MEM_LIMIT "$mem_limit"
        state_set GRAFANA_ADMIN_USER "$admin_user"
    fi

    log_ok "$(t 'Grafana at %s' "http://$(primary_ip)/grafana/")"
    log_info "$(t 'Dashboards live in the docker volume %s - restore it before the first start.' "$volume")"
}

module_remove() {
    local grafana_dir volume
    grafana_dir=$(state_get GRAFANA_DIR "$GRAFANA_DIR_DEFAULT")
    volume=$(state_get GRAFANA_VOLUME "$GRAFANA_VOLUME_DEFAULT")

    run systemctl disable --now pi-home-grafana.service 2>/dev/null || true
    run rm -f /etc/systemd/system/pi-home-grafana.service \
              /etc/nginx/pi-home-stack/50-grafana.conf
    systemd_reload
    nginx -t >/dev/null 2>&1 && run systemctl reload nginx

    # Das Volume bleibt: Entfernen einer Komponente löscht keine Daten.
    log_warn "$(t 'The docker volume %s is left in place - it holds the dashboards.' "$volume")"
    log_info "$(t 'Delete it deliberately with: docker volume rm %s' "$volume")"
    run rm -f "$grafana_dir/admin_password"
}
