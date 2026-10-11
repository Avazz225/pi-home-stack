#!/usr/bin/env bash
#
# Installiert CPython 3.14 auf dem Pi, ohne das System-Python anzufassen.
#
# Hintergrund: deebot-client verlangt ab Version 18 Python >= 3.14. Die letzte
# Version, die mit Python 3.11 lief, ist 6.0.2 — zwölf Major-Versionen zurück,
# mit anderer API und einer deutlich kleineren Geräte-Registry. Für einen
# Saugroboter, der ohnehin am Rand der Unterstützung liegt, ist das der
# schlechtere Tausch. Also lieber ein zweites Python danebenlegen.
#
# Es wird ein fertiges Binary von python-build-standalone geladen (dasselbe, das
# auch `uv python install` benutzt) — kein Kompilieren, keine Build-Abhängigkeiten,
# ein Download von etwa 30 MB statt einer knappen Stunde Übersetzerlauf.
#
# Die Installation landet komplett in $PREFIX im Home-Verzeichnis. Kein sudo,
# kein Eingriff in /usr/bin, `python3` bleibt unverändert das System-Python.
# Deinstallieren heißt: Verzeichnis löschen.

set -euo pipefail

VERSION="3.14.8"
RELEASE="20261003"
PREFIX="${PREFIX:-$HOME/.local/opt/python-${VERSION}}"
BASE_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE}"

case "$(uname -m)" in
    aarch64|arm64)
        TARGET="aarch64-unknown-linux-gnu"
        SHA256="abc0c8dd54a144909a5e4905737bc33f244cb17ce8afc4a7b0791ee1e006ae23"
        ;;
    armv7l|armv6l)
        # 32-Bit-Raspberry-Pi-OS. armv6l (Pi Zero/1) ist hier nicht abgedeckt —
        # dafür gibt es kein Standalone-Build, da hilft nur Selbstkompilieren.
        if [ "$(uname -m)" = "armv6l" ]; then
            echo "armv6l wird von python-build-standalone nicht angeboten." >&2
            echo "Auf so einem Pi bleibt nur: Python 3.14 aus den Quellen bauen." >&2
            exit 1
        fi
        TARGET="armv7-unknown-linux-gnueabihf"
        SHA256="99bdea55d1f860cedc982e8c64feba8e594cd89c48e76bd4d7e5cf6e90bcba5a"
        ;;
    x86_64)
        echo "x86_64 erkannt — das Skript ist für den Pi gedacht." >&2
        echo "Für den Desktop reicht der Paketmanager oder 'uv python install 3.14'." >&2
        exit 1
        ;;
    *)
        echo "Unbekannte Architektur: $(uname -m)" >&2
        exit 1
        ;;
esac

ASSET="cpython-${VERSION}+${RELEASE}-${TARGET}-install_only.tar.gz"
# Das Pluszeichen muss in der URL kodiert sein, sonst antwortet GitHub mit 404
URL="${BASE_URL}/$(printf '%s' "$ASSET" | sed 's/+/%2B/')"

if [ -x "${PREFIX}/bin/python3.14" ]; then
    echo "Python 3.14 liegt bereits in ${PREFIX}:"
    "${PREFIX}/bin/python3.14" -V
    exit 0
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "Lade ${ASSET} …"
curl -fL --proto '=https' --tlsv1.2 -o "${WORKDIR}/python.tar.gz" "$URL"

echo "Prüfe Signatur …"
echo "${SHA256}  ${WORKDIR}/python.tar.gz" | sha256sum -c -

echo "Entpacke …"
mkdir -p "${WORKDIR}/unpack"
tar -xzf "${WORKDIR}/python.tar.gz" -C "${WORKDIR}/unpack"

# Das Archiv bringt alles unter einem einzelnen Oberverzeichnis mit (derzeit
# "python/"). Statt die Ebene blind abzuschneiden wird sie ermittelt — bricht ein
# späteres Release mit der Konvention, scheitert das hier sichtbar statt eine
# halb entpackte Installation zu hinterlassen.
TOPDIR="$(find "${WORKDIR}/unpack" -mindepth 1 -maxdepth 1 -type d | head -1)"
if [ -z "$TOPDIR" ]; then
    echo "Archiv enthält kein Verzeichnis — Aufbau unerwartet." >&2
    exit 1
fi

PYBIN=""
for candidate in python3.14 python3 python; do
    if [ -x "${TOPDIR}/bin/${candidate}" ]; then
        PYBIN="$candidate"
        break
    fi
done
if [ -z "$PYBIN" ]; then
    echo "In ${TOPDIR}/bin steckt kein ausführbares Python — Aufbau unerwartet." >&2
    ls -1 "${TOPDIR}/bin" 2>/dev/null | head -20 >&2
    exit 1
fi

echo "Installiere nach ${PREFIX} …"
mkdir -p "$(dirname "$PREFIX")"
rm -rf "${PREFIX}.new" "$PREFIX"
mv "$TOPDIR" "${PREFIX}.new"
mv "${PREFIX}.new" "$PREFIX"

INSTALLED="${PREFIX}/bin/${PYBIN}"
echo
"$INSTALLED" -V
"$INSTALLED" -c "import sys; assert sys.version_info[:2] >= (3, 14), sys.version; print('venv-tauglich:', __import__('venv') is not None)"
echo "Installiert in: ${PREFIX}"
echo
echo "Virtualenv für den Dienst anlegen:"
echo "  cd ~/home_persistence_service"
echo "  rm -rf venv"
echo "  ${INSTALLED} -m venv venv"
echo "  venv/bin/pip install -r requirements.txt"
