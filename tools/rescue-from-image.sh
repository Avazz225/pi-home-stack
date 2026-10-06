#!/usr/bin/env bash
#
# Holt alles Wiederherstellungswürdige aus einem gemounteten Abbild der SD-Karte.
#
#   sudo mount -o ro /dev/loopNp2 /mnt/rescue
#   tools/rescue-from-image.sh /mnt/rescue ~/pinas-rescue/system
#
# Liest nur, schreibt nie in die Quelle. Was fehlt, wird benannt statt
# stillschweigend übergangen — bei einer sterbenden Karte ist die Lücke die
# eigentliche Information.
#
# Drei Stufen:
#   geheim   unwiederbringlich. Steht bewusst in keinem Config-Export, weil ein
#            Export, der Schlüssel enthält, in den falschen Händen landet.
#   daten    existiert nur hier, nicht im Repo und nicht auf dem RAID.
#   config   rekonstruierbar, spart aber Stunden.

set -uo pipefail

SRC=${1:-}
DEST=${2:-}
if [[ -z $SRC || -z $DEST ]]; then
    echo "Aufruf: $0 <gemountetes-abbild> <zielverzeichnis>" >&2
    exit 2
fi
[[ -d $SRC ]] || { echo "Quelle ist kein Verzeichnis: $SRC" >&2; exit 2; }

# Ohne root übersieht das Skript genau das, worum es geht: /secrets, /root,
# /var/lib/samba/private und /etc/vault.d sind 0700 oder root-only. Unprivilegiert
# gelesen melden sie "nicht vorhanden" — und das wäre die gefährlichste Form von
# falscher Beruhigung, die ein Rettungswerkzeug liefern kann.
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
    echo "Bitte mit sudo ausführen — sonst bleiben die Geheimnisse unsichtbar" >&2
    echo "und werden fälschlich als 'nicht vorhanden' gemeldet." >&2
    exit 1
fi

mkdir -p "$DEST"

# stufe|pfad-relativ-zur-wurzel|beschreibung
#
# Die Reihenfolge folgt der Unersetzlichkeit auf DIESEM Pi: die Nutzdaten der
# Dienste liegen auf dem RAID und sind damit ohnehin sicher. Auf dem Bootmedium
# steht fast nur Konfiguration — und genau die müsste man sonst von Hand
# rekonstruieren. Deshalb wiegt "config" hier schwerer als "daten".
MANIFEST=(
    # Eigenes Geheimnis-Verzeichnis in der Wurzel — nicht fstab-gemountet, liegt
    # also wirklich auf dem Bootmedium.
    "geheim|secrets|/secrets — eigener Geheimnis-Ordner"
    "geheim|etc/vault.d|Vault-Konfiguration"
    # vault.hcl sagt: storage "file" path = /opt/vault/data, und der zweite
    # Listener nutzt /opt/vault/tls. Beides liegt auf dem Bootmedium.
    "geheim|opt/vault/data|Vault-Tresor (verschlüsselt — braucht die Unseal-Keys)"
    "geheim|opt/vault/tls|Vault-TLS — enthält den privaten Schlüssel"
    "geheim|var/lib/samba/private|SMB-Passwortdatenbank"
    "geheim|home/*/gitlab-runner|GitLab-Runner inkl. Registrierungs-Token"
    "geheim|home/*/git/*/deploy/runner|GitHub-Runner inkl. Zugangsdaten"
    # Für den Fall, dass pi-home-stack doch irgendwann lief
    "geheim|etc/pi-home-stack|pi-home-stack-Geheimnisse (hier nicht installiert)"

    # Die beiden Dienste, die NICHT auf dem RAID lagen. Ganze Verzeichnisse, nicht
    # nur data/ — es ist auch die Installation selbst.
    "daten|home/*/tracking_persistence_service|Feature-Tracking — lag auf der Karte"
    "daten|home/*/pinas_s3_backup|Backup-Dienst samt Index — lag auf der Karte"
    "daten|data|/data — eigener Datenordner in der Wurzel"
    # Grafana läuft als Container im Compose-Projekt "monitoring". Ein Named
    # Volume liegt unter /var/lib/docker/volumes und damit auf dem Bootmedium —
    # nicht auf dem RAID, auch wenn der Rest der Überwachung dort liegt.
    "daten|var/lib/docker/volumes/monitoring_*|Grafana & Co. — Container-Volumes des monitoring-Stacks"

    "config|etc/systemd/system|Unit-Dateien — die eigentliche Installationskette"
    "config|etc/mdadm/mdadm.conf|RAID-Benennung — ohne die wandert md0 wieder nach md127"
    "config|etc/samba|Freigabedefinition ([shared] -> /media/raid)"
    "config|etc/docker/daemon.json|Docker-Konfiguration"
    "config|root/.bashrc|Shell-Umgebung root"
    "config|root/.bash_aliases|Aliase root"
    "config|home/*/.bashrc|Shell-Umgebung"
    "config|home/*/.bash_aliases|Aliase"
    "config|home/*/.profile|Shell-Profil"
    "config|home/*/.ssh|authorized_keys"
    "config|etc/pihole|Pi-hole: Gravity-DB, White-/Blacklists"
    "config|etc/dnsmasq.d|DNS-Sonderregeln"
    "config|etc/lighttpd|Pi-hole-Weboberfläche"
    "config|etc/cron.d|Cronjobs"
    "config|var/spool/cron/crontabs|Benutzer-Crontabs"
    "config|etc/nginx|Reverse-Proxy — als Vorlage, nicht zum Zurückspielen"
    "config|etc/fstab|Mounts — nur die RAID-Zeile daraus übernehmen"

    # Erwartet leer: /media/raid ist im Abbild nur ein Mountpoint. "nicht
    # vorhanden" bestätigt hier, dass die Dienste auf dem Array lagen.
    "info|media/raid/services|Dienste auf dem RAID (im Abbild nur Mountpoint)"
)

declare -A MISSING=()
PARTIAL=""
total_found=0

for entry in "${MANIFEST[@]}"; do
    IFS='|' read -r level path desc <<<"$entry"
    hit=0
    # Der Pfad darf einen Glob enthalten (home/*), deshalb ohne Quoting expandieren
    for match in $SRC/$path; do
        # -e folgt dem Link und wäre bei einem Symlink aufs RAID falsch: im Abbild
        # ist das Ziel nicht vorhanden, der Eintrag gälte als "nicht da". -L fängt
        # das ab, und gemeldet wird der Link samt Ziel statt eines stillen Kopierens.
        if [[ -L $match ]]; then
            rel=${match#"$SRC"/}
            printf '  \033[36m→\033[0m %-8s %-52s %s\n' "$level" "$rel" \
                   "Symlink auf $(readlink "$match") — liegt woanders"
            hit=1
            continue
        fi
        [[ -e $match ]] || continue
        rel=${match#"$SRC"/}
        mkdir -p "$DEST/$(dirname "$rel")"
        # Fehler wird klassifiziert statt pauschal "Lesefehler" zu melden: eine
        # fehlende Berechtigung ist ein Bedienfehler, ein EIO ein defekter Sektor.
        # Die beiden zu verwechseln schickt einen auf die Suche nach einem
        # Hardwaredefekt, den es nicht gibt.
        cp_err=$(cp -a "$match" "$DEST/$rel" 2>&1 >/dev/null)
        if [[ -z $cp_err ]]; then
            size=$(du -sh "$DEST/$rel" 2>/dev/null | cut -f1)
            printf '  \033[32m✓\033[0m %-8s %-52s %s\n' "$level" "$rel" "${size:-?}"
            total_found=$((total_found + 1))
        elif grep -qiE 'permission denied|Keine Berechtigung' <<<"$cp_err"; then
            printf '  \033[31m!\033[0m %-8s %-52s %s\n' "$level" "$rel" "keine Berechtigung"
            PARTIAL+="$rel|keine Berechtigung"$'\n'
        elif grep -qiE 'input/output error|Eingabe-/Ausgabefehler' <<<"$cp_err"; then
            printf '  \033[31m!\033[0m %-8s %-52s %s\n' "$level" "$rel" "LESEFEHLER — defekter Sektor"
            PARTIAL+="$rel|Lesefehler, unvollständig"$'\n'
        else
            printf '  \033[31m!\033[0m %-8s %-52s %s\n' "$level" "$rel" "${cp_err%%$'\n'*}"
            PARTIAL+="$rel|${cp_err%%$'\n'*}"$'\n'
        fi
        # In jedem Fall gefunden — sonst meldet der Eintrag zusätzlich
        # "nicht vorhanden" und widerspricht sich selbst.
        hit=1
    done
    if [[ $hit -eq 0 ]]; then
        printf '  \033[33m–\033[0m %-8s %-52s %s\n' "$level" "$path" "nicht vorhanden"
        MISSING[$level]+="$path|$desc"$'\n'
    fi
done

echo
echo "Gerettet: $total_found Einträge nach $DEST"

if [[ -n $PARTIAL ]]; then
    echo
    echo "Unvollständig oder gar nicht kopiert:"
    while IFS='|' read -r path why; do
        [[ -n $path ]] && printf '   %-50s %s\n' "$path" "$why"
    done <<<"$PARTIAL"
fi

if [[ -n ${MISSING[geheim]:-} ]]; then
    echo
    echo "ACHTUNG — folgende Geheimnisse wurden nicht gefunden:"
    while IFS='|' read -r path desc; do
        [[ -n $path ]] && echo "   $path — $desc"
    done <<<"${MISSING[geheim]}"
    echo
    echo "   Nicht jedes davon muss existiert haben: secrets.kdbx gibt es nur beim"
    echo "   kdbx-Backend, vault.env nur beim Vault-Backend. Liegt die kdbx bei dir"
    echo "   auf dem RAID, ist 'nicht vorhanden' hier die richtige Antwort."
    echo
    echo "   Fehlt aber das, was du tatsächlich benutzt hast, sind die erzeugten"
    echo "   Passwörter weg — und mit dem Backup-Schlüssel auch jedes"
    echo "   verschlüsselte Off-Site-Backup."
fi

if [[ -n ${MISSING[daten]:-} ]]; then
    echo
    echo "Nicht im Abbild (bei diesem Aufbau erwartet — liegt auf dem RAID):"
    while IFS='|' read -r path desc; do
        [[ -n $path ]] && echo "   $path — $desc"
    done <<<"${MISSING[daten]}"
fi

# ── Suche nach Dingen ohne festen Ort ────────────────────────────────────────
#
# Compose-Dateien, Env-Dateien und KeePass-Datenbanken liegen dort, wo man sie
# hingelegt hat. Statt Pfade zu raten wird gesucht; gefunden wird kopiert, weil
# es klein und wertvoll ist. Die Suche meidet /var/lib/docker und /proc, sonst
# läuft sie sich in Container-Schichten fest.
echo
echo "── Gesucht statt geraten ──"
FIND_DEST="$DEST/gefunden"
found_extra=0
while IFS= read -r hit; do
    [[ -z $hit ]] && continue
    rel=${hit#"$SRC"/}
    mkdir -p "$FIND_DEST/$(dirname "$rel")"
    if cp -a "$hit" "$FIND_DEST/$rel" 2>/dev/null; then
        printf '  \033[32m✓\033[0m %s\n' "$rel"
        found_extra=$((found_extra + 1))
    else
        printf '  \033[31m!\033[0m %s (Lesefehler)\n' "$rel"
    fi
done < <(find "$SRC" \
             -path "$SRC/var/lib/docker" -prune -o \
             -path "$SRC/proc" -prune -o \
             -path "$SRC/sys" -prune -o \
             \( -name 'docker-compose.y*ml' -o -name 'compose.y*ml' \
                -o -name '*.kdbx' -o -name '.env' \) -type f -print 2>/dev/null)

if [[ $found_extra -eq 0 ]]; then
    echo "  keine Compose-, Env- oder kdbx-Dateien auf dem Bootmedium"
else
    echo
    echo "  $found_extra Datei(en) in $FIND_DEST"
    echo "  Darunter sollten die Compose-Dateien deiner Container sein — die"
    echo "  Bind-Mounts darin sagen dir, was auf dem RAID lag und was nicht."
fi

echo
echo "── Vault ──"
echo "Laut vault.hcl liegt der Tresor als Datei-Storage unter /opt/vault/data,"
echo "also auf dem Bootmedium. Er ist mit dem Master Key verschlüsselt: ohne die"
echo "Unseal-Keys von 'vault operator init' lässt er sich nicht öffnen — die"
echo "Dateien allein genügen nicht. Prüfe das, bevor du die alte Karte weglegst."
echo
echo "/opt/vault/tls enthält den privaten Schlüssel des 0.0.0.0:8300-Listeners."
echo "Wer ihn in die Hände bekommt, kann sich als dieser Vault ausgeben."
echo
echo "── Nicht mitgenommen ──"
echo "Die runner-*-cache-*-Volumes unter /var/lib/docker/volumes sind Build-Caches"
echo "der CI-Runner: jederzeit neu erzeugbar, teils mehrere GB. Absichtlich"
echo "ausgelassen, damit die Rettung nicht daran erstickt."

echo
echo "Nächster Schritt: auf dem RAID nach einem fertigen Config-Export suchen —"
echo "  find /media/nas -name 'pi-home-stack-config-*.tar.gz' 2>/dev/null"
echo "Der liegt auf den Platten und ist von der kaputten Karte unberührt."
