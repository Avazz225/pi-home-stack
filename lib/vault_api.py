#!/usr/bin/env python3
"""HashiCorp Vault (KV v2) helper for the installer.

Same command surface as keepass_store.py, so the shell side can treat both credential
stores identically. Uses only the standard library — a Pi OS Lite install has
python3 but neither the vault CLI nor jq, and requiring either would make this
backend harder to reach than the problem it solves.

Configuration comes from the environment:
    VAULT_ADDR        https://vault.example:8200
    VAULT_MOUNT       KV v2 mount, default "secret"
    VAULT_PREFIX      path below the mount, default "pi-home-stack"
    VAULT_NAMESPACE   optional (Vault Enterprise / HCP)
    VAULT_CACERT      optional path to a CA bundle
    VAULT_SKIP_VERIFY set to 1 to accept any certificate (self-signed homelab)

Authentication, in order of preference:
    VAULT_TOKEN                    a plain token
    VAULT_ROLE_ID + VAULT_SECRET_ID  AppRole, the right choice for a machine

Commands:
    check                                 verify address, auth and mount
    has    <title>                        exit 0 if the secret exists
    get    <title>                        print the password
    set    <title> <user> [notes]         store/replace (password on stdin)
    ensure <title> <user> [len]           print existing password, else generate one
    list                                  print titles, one per line
"""

import json
import os
import secrets
import ssl
import string
import sys
import urllib.error
import urllib.parse
import urllib.request

ALPHABET = string.ascii_letters + string.digits
TIMEOUT = 15


def fail(message, code=1):
    print(message, file=sys.stderr)
    sys.exit(code)


def env(name, default=""):
    return os.environ.get(name, default).strip()


def ssl_context():
    if env("VAULT_SKIP_VERIFY") in ("1", "true", "yes"):
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        return context
    cacert = env("VAULT_CACERT")
    if cacert:
        return ssl.create_default_context(cafile=cacert)
    return ssl.create_default_context()


class Vault:
    def __init__(self):
        self.addr = env("VAULT_ADDR").rstrip("/")
        if not self.addr:
            fail("VAULT_ADDR ist nicht gesetzt.", 2)
        self.mount = env("VAULT_MOUNT", "secret").strip("/")
        self.prefix = env("VAULT_PREFIX", "pi-home-stack").strip("/")
        self.namespace = env("VAULT_NAMESPACE")
        self.context = ssl_context()
        self.token = self._authenticate()

    # ── transport ────────────────────────────────────────────────────────────

    def _request(self, method, path, payload=None, token=None):
        url = f"{self.addr}/v1/{path.lstrip('/')}"
        data = json.dumps(payload).encode() if payload is not None else None
        request = urllib.request.Request(url, data=data, method=method)
        request.add_header("Content-Type", "application/json")
        if token:
            request.add_header("X-Vault-Token", token)
        if self.namespace:
            request.add_header("X-Vault-Namespace", self.namespace)
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT,
                                        context=self.context) as response:
                body = response.read()
                return json.loads(body) if body else {}
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            detail = exc.read().decode(errors="replace")[:400]
            fail(f"Vault {method} {path} -> HTTP {exc.code}: {detail}", 5)
        except urllib.error.URLError as exc:
            fail(f"Vault nicht erreichbar ({self.addr}): {exc.reason}", 6)
        return None

    def _authenticate(self):
        token = env("VAULT_TOKEN")
        if token:
            return token
        role_id, secret_id = env("VAULT_ROLE_ID"), env("VAULT_SECRET_ID")
        if role_id and secret_id:
            result = self._request("POST", "auth/approle/login",
                                   {"role_id": role_id, "secret_id": secret_id})
            if not result or "auth" not in result:
                fail("AppRole-Login fehlgeschlagen.", 5)
            return result["auth"]["client_token"]
        fail("Weder VAULT_TOKEN noch VAULT_ROLE_ID/VAULT_SECRET_ID gesetzt.", 2)
        return None

    # ── KV v2 ────────────────────────────────────────────────────────────────

    def _data_path(self, title):
        return f"{self.mount}/data/{self.prefix}/{urllib.parse.quote(title)}"

    def read(self, title):
        result = self._request("GET", self._data_path(title), token=self.token)
        if result is None:
            return None
        data = result.get("data", {}).get("data")
        # A deleted-but-not-destroyed KV v2 version returns data: null.
        return data or None

    def write(self, title, payload):
        self._request("POST", self._data_path(title), {"data": payload}, token=self.token)

    def list_titles(self):
        path = f"{self.mount}/metadata/{self.prefix}?list=true"
        result = self._request("GET", path, token=self.token)
        if result is None:
            return []
        return result.get("data", {}).get("keys", [])

    def check(self):
        self._request("GET", "auth/token/lookup-self", token=self.token)
        # Confirms the mount exists and the token may read it; an empty prefix is fine.
        self.list_titles()


def cmd_check(vault, _args):
    vault.check()
    print(f"{vault.addr} · {vault.mount}/{vault.prefix}")


def cmd_has(vault, args):
    sys.exit(0 if vault.read(args[0]) else 1)


def cmd_get(vault, args):
    entry = vault.read(args[0])
    if not entry:
        fail(f"Kein Eintrag: {args[0]}", 4)
    print(entry.get("password", ""))


def cmd_set(vault, args):
    title, username = args[0], args[1]
    notes = args[2] if len(args) > 2 else ""
    password = sys.stdin.read().rstrip("\n")
    if not password:
        fail("Kein Passwort auf stdin.", 2)
    vault.write(title, {"username": username, "password": password, "notes": notes})


def cmd_ensure(vault, args):
    title, username = args[0], args[1]
    length = int(args[2]) if len(args) > 2 else 24
    entry = vault.read(title)
    if entry and entry.get("password"):
        print(entry["password"])
        return
    password = "".join(secrets.choice(ALPHABET) for _ in range(length))
    vault.write(title, {"username": username, "password": password, "notes": ""})
    print(password)


def cmd_list(vault, _args):
    for title in vault.list_titles():
        print(title)


def main():
    if len(sys.argv) < 2:
        fail(__doc__, 2)
    command, args = sys.argv[1], sys.argv[2:]
    handlers = {
        "check": (cmd_check, 0), "has": (cmd_has, 1), "get": (cmd_get, 1),
        "set": (cmd_set, 2), "ensure": (cmd_ensure, 2), "list": (cmd_list, 0),
    }
    if command not in handlers:
        fail(f"Unbekannter Befehl: {command}", 2)
    handler, minimum = handlers[command]
    if len(args) < minimum:
        fail(f"'{command}' benötigt {minimum} weitere Argument(e).", 2)
    handler(Vault(), args)


if __name__ == "__main__":
    main()
