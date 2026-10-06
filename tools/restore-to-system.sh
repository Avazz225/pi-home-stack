#!/usr/bin/env bash
#
# Legt die mit rescue-from-image.sh geborgenen Sachen auf dem neuen Pi zurück —
# mit den Rechten, die der Stack selbst setzt, und in zwei Durchgängen.
#
#   sudo tools/restore-to-system.sh ~/pinas-rescue/system before   # VOR install.sh
#   sudo ./install.sh --features all
#   sudo tools/restore-to-system.sh ~/pinas-rescue/system after    # DANACH
#
# Warum zwei Durchgänge:
#
#   before  Geheimnisse und stack.env müssen liegen, bevor der Installer läuft —
#           sonst erzeugt er neue Passwörter und du hast zwei Generationen davon.
#   after   Datenbanken brauchen Dinge, die erst der Installer anlegt: den
#           gemounteten Datenspeicher, den grafana-Benutzer, das pihole-Paket.
#
# Was dieses Skript bewusst NICHT anfasst: config.txt, cmdline.txt, fstab,
# passwd/shadow/group und /etc/nginx. Die gehören zur alten Installation — die
# PARTUUIDs darin zeigen auf eine Karte, die es nicht mehr gibt.

set -uo pipefail

DRY=0
[[ ${1:-} == --dry-run ]] && { DRY=1; shift; }
SRC=${1:-}
PHASE=${2:-}

if [[ -z $SRC || ! $PHASE =~ ^(before|after)$ ]]; then
    echo "Aufruf: $0 [--dry-run] <rettungsverzeichnis> before|after" >&2
    exit 2
fi
[[ -d $SRC ]] || { echo "Rettungsverzeichnis nicht gefunden: $SRC" >&2; exit 2; }
if [[ $DRY -eq 0 && ${EUID:-$(id -u)} -ne 0 ]]; then
    echo "Bitte mit sudo ausführen." >&2
    exit 1
fi

# Dateien, die niemals zurückgespielt werden. Tauchen sie im Rettungsbestand auf,
# wird einmal darauf hingewiesen statt sie stillschweigend zu ignorieren.
NEVER=(
    "boot/firmware/config.txt"
    "boot/firmware/cmdline.txt"
    "etc/fstab"
    "etc/passwd" "etc/shadow" "etc/group"
    "etc/nginx"
)

say()  { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
skip() { printf '  \033[33m–\033[0m %s\n' "$*"; }
warn() { printf '  \033[31m!\033[0m %s\n' "$*"; }

do_run() {
    if [[ $DRY -eq 1 ]]; then
        printf '  \033[2m[dry-run] %s\033[0m\n' "$*"
        return 0
    fi
    "$@"
}

# place <quelle-relativ> <ziel> <modus> <besitzer> [beschreibung]
place() {
    local rel=$1 dest=$2 mode=$3 owner=$4 desc=${5:-$2}
    local found="" match
    for match in $SRC/$rel; do
        [[ -e $match ]] && { found=$match; break; }
    done
    if [[ -z $found ]]; then
        skip "$desc — nicht im Rettungsbestand"
        return 0
    fi

    # Besitzer "-" heißt: so lassen, wie cp -a es übernommen hat. Nötig für
    # Container-Volumes, deren UIDs (Grafana: 472) auf dem Host niemandem gehören.
    local user=${owner%%:*}
    if [[ $owner != "-" && ! $user =~ ^[0-9]+$ ]] && ! id "$user" >/dev/null 2>&1; then
        warn "$desc — Benutzer '$user' fehlt, Paket noch nicht installiert. Übersprungen."
        return 0
    fi

    # Vorhandenes Ziel nicht einfach überschreiben
    if [[ -e $dest && $DRY -eq 0 ]]; then
        do_run mv "$dest" "$dest.vor-restore"
        say "vorhandenes $dest nach $dest.vor-restore beiseitegelegt"
    fi

    do_run mkdir -p "$(dirname "$dest")"
    do_run cp -a "$found" "$dest"
    [[ $owner != "-" ]] && do_run chown -R "$owner" "$dest"
    do_run chmod "$mode" "$dest"
    ok "$desc -> $dest ($mode $owner)"
}

stop_unit() {
    local unit=$1
    # cat ist ueber systemd-Versionen hinweg der verlaesslichere Existenztest
    systemctl cat "$unit" >/dev/null 2>&1 || return 0
    if systemctl is-active --quiet "$unit"; then
        do_run systemctl stop "$unit"
        say "$unit angehalten"
        STOPPED+=("$unit")
    fi
}

STOPPED=()

echo "Rettungsbestand: $SRC"
echo "Durchgang:       $PHASE${DRY:+ (dry-run)}"
echo

# Hinweis auf alles, was absichtlich liegen bleibt
for rel in "${NEVER[@]}"; do
    [[ -e $SRC/$rel ]] && skip "$rel — gehört zur alten Installation, bleibt liegen"
done
echo

if [[ $PHASE == before ]]; then
    echo "── Geheimnisse und Installer-Antworten ──"
    # Verzeichnis zuerst, mit den Rechten die der Stack selbst vergibt
    do_run mkdir -p /etc/pi-home-stack
    do_run chmod 0755 /etc/pi-home-stack
    do_run chown root:root /etc/pi-home-stack

    place "etc/pi-home-stack/stack.env"    /etc/pi-home-stack/stack.env    0644 root:root "Installer-Antworten"
    place "etc/pi-home-stack/secrets.kdbx" /etc/pi-home-stack/secrets.kdbx 0600 root:root "KeePass-Store"
    place "etc/pi-home-stack/vault.env"    /etc/pi-home-stack/vault.env    0600 root:root "Vault-AppRole"
    place "etc/pi-home-stack/secrets"      /etc/pi-home-stack/secrets      0700 root:root "Dienst-Zugangsdaten"
    if [[ -d /etc/pi-home-stack/secrets && $DRY -eq 0 ]]; then
        do_run find /etc/pi-home-stack/secrets -type f -exec chmod 0600 {} +
    fi

    echo
    echo "── SSH-Hostkeys (optional, verhindert Hostkey-Warnungen) ──"
    local_restored=0
    for key in "$SRC"/etc/ssh/ssh_host_*; do
        [[ -e $key ]] || continue
        base=$(basename "$key")
        do_run cp -a "$key" "/etc/ssh/$base"
        if [[ $base == *.pub ]]; then do_run chmod 0644 "/etc/ssh/$base"
        else do_run chmod 0600 "/etc/ssh/$base"; fi
        do_run chown root:root "/etc/ssh/$base"
        local_restored=1
    done
    [[ $local_restored -eq 1 ]] && ok "Hostkeys zurückgespielt" || skip "keine Hostkeys im Bestand"

    echo
    echo "Weiter mit: sudo ./install.sh --features all"
    echo "Beim Datenspeicher das vorhandene RAID übernehmen, nicht neu anlegen."
fi

if [[ $PHASE == after ]]; then
    # Der Datenspeicher steht erst nach dem Installer fest
    DATA_DIR=""
    if [[ -f /etc/pi-home-stack/stack.env ]]; then
        # shellcheck disable=SC1091
        DATA_DIR=$(. /etc/pi-home-stack/stack.env 2>/dev/null; printf '%s' "${SHARE_DATA_DIR:-}")
    fi
    if [[ -z $DATA_DIR || ! -d $DATA_DIR ]]; then
        warn "Kein Datenspeicher gefunden (SHARE_DATA_DIR). Datenbanken werden übersprungen."
        warn "Erst install.sh mit dem storage-Modul laufen lassen."
    else
        say "Datenspeicher: $DATA_DIR"
        echo
        echo "── Datenbanken der Dienste ──"
        # Zielpfad muss mit modules/apiservices.sh uebereinstimmen: dort ist es
        # <datenspeicher>/services/<dienstverzeichnis>/data, nicht der kurze Key.
        # Das ist genau das Layout, das auf diesem Pi schon existiert - eine
        # Abweichung hier legte die Datenbank daneben und der Dienst startete leer.
        for svc in quickaction tracking study home; do
            stop_unit "pi-home-api-$svc.service"
            place "home/*/${svc}_persistence_service/data" \
                  "$DATA_DIR/services/${svc}_persistence_service/data" \
                  0750 pi-api:pi-api "Daten $svc"
        done
    fi

    echo
    echo "── Übrige Dienste ──"
    stop_unit "pi-home-backup.service"
    place "opt/pi-home-stack/backup/data" /opt/pi-home-stack/backup/data 0750 root:root "Backup-Index"

    stop_unit smbd.service
    place "var/lib/samba/private" /var/lib/samba/private 0700 root:root "SMB-Passwortdatenbank"

    # Grafana laeuft als Container: die Dashboards liegen im Docker-Volume, nicht
    # unter /var/lib/grafana. Das Volume muss existieren, bevor hineinkopiert wird,
    # und die UID 472 des Containers gehoert auf dem Host niemandem - deshalb "-".
    stop_unit pi-home-grafana.service
    if [[ -d $SRC/var/lib/docker/volumes/monitoring_grafana-data ]]; then
        command -v docker >/dev/null 2>&1 \
            && do_run docker volume create monitoring_grafana-data >/dev/null \
            || warn "Docker fehlt - Grafana-Volume kann nicht angelegt werden"
    fi
    place "var/lib/docker/volumes/monitoring_grafana-data/_data" \
          /var/lib/docker/volumes/monitoring_grafana-data/_data 0755 - \
          "Grafana-Dashboards (Container-Volume)"

    stop_unit pihole-FTL.service
    place "etc/pihole" /etc/pihole 0755 root:root "Pi-hole (Gravity, Listen)"
    # Pi-hole hat zwischen v5 und v6 Konfiguration und Datenbankschema geaendert.
    # Ein Dateikopie ueber einen Versionssprung hinweg kann mehr kaputtmachen als
    # sie rettet - der vorgesehene Weg ist Pi-holes eigener Teleporter.
    say "Pi-hole: bei Versionssprung besser 'pihole -a -t' / Teleporter-Import"
    say "         statt dieser Dateikopie. Notfalls nur gravity.db und die"
    say "         custom list zurueckspielen."

    stop_unit vault.service
    place "opt/vault/data" /opt/vault/data 0700 vault:vault "Vault-Tresor (Dateispeicher)"
    place "opt/vault/tls"  /opt/vault/tls  0700 vault:vault "Vault-TLS"
    place "etc/vault.d"    /etc/vault.d    0750 vault:vault "Vault-Konfiguration"

    echo
    if [[ ${#STOPPED[@]} -gt 0 ]]; then
        echo "── Angehaltene Dienste wieder starten ──"
        for unit in "${STOPPED[@]}"; do
            do_run systemctl start "$unit"
            ok "$unit"
        done
    fi

    echo
    echo "Danach prüfen:"
    echo "  sqlite3 $DATA_DIR/services/tracking_persistence_service/data/tracking.db 'PRAGMA integrity_check;'"
    echo "  systemctl --failed"
    echo
    echo "Der Vault-Bestand ist verschlüsselt — er braucht die Unseal-Keys von"
    echo "'vault operator init'. Ohne sie bleibt der Tresor versiegelt."
fi
