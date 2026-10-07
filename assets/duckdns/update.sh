#!/bin/sh
# pi-home-stack - report this line's address to DuckDNS.
#
# Domain and token come from files, never from arguments. Arguments are visible
# to every local user through ps, and a DuckDNS token is a password: whoever
# reads it can repoint the hostname at a machine of their choosing. curl is
# therefore fed a config on stdin (-K -) instead of a URL on the command line.
#
# An empty ip= makes DuckDNS use the source address of the request, which is
# what -4 pins to IPv4.
set -eu

CONF=${DUCKDNS_CONF:-/etc/pi-home-stack/duckdns.conf}
TOKEN_FILE=${DUCKDNS_TOKEN_FILE:-/etc/pi-home-stack/secrets/duckdns.token}

[ -r "$CONF" ]       || { echo "config not readable: $CONF" >&2; exit 1; }
[ -r "$TOKEN_FILE" ] || { echo "token not readable: $TOKEN_FILE" >&2; exit 1; }

# shellcheck source=/dev/null
. "$CONF"
: "${DUCKDNS_DOMAINS:?no DUCKDNS_DOMAINS in $CONF}"
TOKEN=$(cat "$TOKEN_FILE")

RESP=$(printf 'url = "https://www.duckdns.org/update?domains=%s&token=%s&ip=&verbose=true"\n' \
               "$DUCKDNS_DOMAINS" "$TOKEN" \
       | curl -4 -s --max-time 20 -K -)

# Exit non-zero on a rejected update, so an expired token shows up in
# "systemctl --failed" rather than only in a log nobody reads.
case $(printf '%s\n' "$RESP" | head -n1) in
    OK) printf 'DuckDNS %s: %s\n' "$DUCKDNS_DOMAINS" "$(printf '%s' "$RESP" | tr '\n' ' ')" ;;
    "") echo "DuckDNS $DUCKDNS_DOMAINS: no answer (network or timeout)" >&2; exit 1 ;;
    *)  echo "DuckDNS $DUCKDNS_DOMAINS rejected the update - check the token" >&2; exit 1 ;;
esac
