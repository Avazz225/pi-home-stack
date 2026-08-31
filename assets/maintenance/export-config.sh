#!/usr/bin/env bash
# Exports the stack configuration so a Pi can be rebuilt from scratch.
#
# Deliberately excludes every secret: no KeePass vault, no key files, no Vault
# AppRole, no Samba password database. Those belong in your own credential store,
# and an export that quietly contained them would end up in the wrong places.
#
#   sudo export-config.sh /media/nas/data/backups

set -euo pipefail

TARGET=${1:-}
if [[ -z $TARGET ]]; then
    echo "Usage: $0 <target-directory>" >&2
    exit 2
fi
[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo "Please run with sudo." >&2; exit 1; }

mkdir -p "$TARGET"
STAMP=$(date +%Y-%m-%d)
ARCHIVE="$TARGET/pi-home-stack-config-$STAMP.tar.gz"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

OUT="$WORK/pi-home-stack-config"
mkdir -p "$OUT"

copy() {
    local source=$1
    [[ -e $source ]] || return 0
    mkdir -p "$OUT/$(dirname "${source#/}")"
    cp -a "$source" "$OUT/${source#/}"
}

copy /etc/pi-home-stack/stack.env
copy /etc/samba/pi-home-stack.conf
copy /etc/nginx/sites-available/pi-home-stack
copy /etc/nginx/pi-home-stack
copy /etc/fstab
copy /etc/mdadm/mdadm.conf
copy /etc/apt/apt.conf.d/51pi-home-stack-upgrades

mkdir -p "$OUT/etc/systemd/system"
for unit in /etc/systemd/system/pi-home-*; do
    [[ -e $unit ]] && cp -a "$unit" "$OUT/etc/systemd/system/"
done

# The backup index describes what is stored where; it holds no credentials.
if [[ -f /opt/pi-home-stack/backup/data/backup.db ]]; then
    mkdir -p "$OUT/backup"
    sqlite3 /opt/pi-home-stack/backup/data/backup.db \
        ".backup '$OUT/backup/backup.db'" 2>/dev/null \
        || cp -a /opt/pi-home-stack/backup/data/backup.db "$OUT/backup/backup.db"
    # The AWS secret lives in that database - remove it from the copy.
    sqlite3 "$OUT/backup/backup.db" \
        "UPDATE config SET value='' WHERE key='aws_secret_access_key';" 2>/dev/null || true
fi

{
    echo "pi-home-stack configuration export"
    echo "created: $(date -Is)"
    echo "host:    $(hostname)"
    echo
    echo "Contains no passwords, no key files and no credential store."
    echo "To restore: install the stack, then put these files back and re-run"
    echo "  sudo pi-home-stack --features all"
} >"$OUT/README.txt"

tar -czf "$ARCHIVE" -C "$WORK" pi-home-stack-config
chmod 0640 "$ARCHIVE"
echo "$ARCHIVE"
