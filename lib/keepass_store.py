#!/usr/bin/env python3
"""KeePass vault helper for the installer.

Every credential the stack generates or is given goes in here, so the operator ends
up having to remember exactly one password: the vault's own.

The master password is only ever passed through the environment variable
PHS_MASTER, never as an argument — arguments are world-readable in /proc.

Commands:
    init   <kdbx>                         create the vault if it does not exist
    has    <kdbx> <title>                 exit 0 if an entry exists
    get    <kdbx> <title>                 print the password
    set    <kdbx> <title> <user> [notes]  store/replace (password on stdin)
    ensure <kdbx> <title> <user> [len]    print existing password, else generate one
    list   <kdbx>                         print titles, one per line
"""

import os
import secrets
import string
import sys

ALPHABET = string.ascii_letters + string.digits
GROUP_NAME = "pi-home-stack"


def fail(message, code=1):
    print(message, file=sys.stderr)
    sys.exit(code)


def load_keepass():
    try:
        from pykeepass import PyKeePass, create_database
    except ImportError:
        fail("pykeepass fehlt — bitte 'pip install pykeepass' im Stack-venv ausführen.", 3)
    return PyKeePass, create_database


def master_password():
    password = os.environ.get("PHS_MASTER", "")
    if not password:
        fail("PHS_MASTER ist nicht gesetzt.", 2)
    return password


def open_vault(path, create=False):
    PyKeePass, create_database = load_keepass()
    password = master_password()
    if not os.path.exists(path):
        if not create:
            fail(f"Vault nicht gefunden: {path}", 4)
        vault = create_database(path, password=password)
        vault.save()
        os.chmod(path, 0o600)
        return vault
    try:
        return PyKeePass(path, password=password)
    except Exception as exc:  # noqa: BLE001 - wrong password and corrupt file look alike
        fail(f"Vault konnte nicht geöffnet werden: {exc}", 5)
        return None


def stack_group(vault):
    """All entries live in one group so the vault stays usable as a personal one."""
    group = vault.find_groups(name=GROUP_NAME, first=True)
    if group is None:
        group = vault.add_group(vault.root_group, GROUP_NAME)
    return group


def find(vault, title):
    return vault.find_entries(title=title, group=stack_group(vault), first=True)


def cmd_init(path):
    open_vault(path, create=True)
    print(path)


def cmd_has(path, title):
    sys.exit(0 if find(open_vault(path), title) else 1)


def cmd_get(path, title):
    entry = find(open_vault(path), title)
    if entry is None:
        fail(f"Kein Eintrag: {title}", 4)
    print(entry.password)


def cmd_set(path, title, username, notes=""):
    password = sys.stdin.read().rstrip("\n")
    if not password:
        fail("Kein Passwort auf stdin.", 2)
    vault = open_vault(path, create=True)
    entry = find(vault, title)
    if entry is None:
        vault.add_entry(stack_group(vault), title, username, password, notes=notes)
    else:
        entry.username = username
        entry.password = password
        if notes:
            entry.notes = notes
    vault.save()
    os.chmod(path, 0o600)


def cmd_ensure(path, title, username, length="24"):
    vault = open_vault(path, create=True)
    entry = find(vault, title)
    if entry is not None and entry.password:
        print(entry.password)
        return
    password = "".join(secrets.choice(ALPHABET) for _ in range(int(length)))
    if entry is None:
        vault.add_entry(stack_group(vault), title, username, password)
    else:
        entry.password = password
    vault.save()
    os.chmod(path, 0o600)
    print(password)


def cmd_list(path):
    vault = open_vault(path)
    for entry in vault.find_entries(group=stack_group(vault)) or []:
        print(entry.title)


def main():
    if len(sys.argv) < 3:
        fail(__doc__, 2)
    command, path, args = sys.argv[1], sys.argv[2], sys.argv[3:]
    handlers = {
        "init": (cmd_init, 0), "has": (cmd_has, 1), "get": (cmd_get, 1),
        "set": (cmd_set, 2), "ensure": (cmd_ensure, 2), "list": (cmd_list, 0),
    }
    if command not in handlers:
        fail(f"Unbekannter Befehl: {command}", 2)
    handler, minimum = handlers[command]
    if len(args) < minimum:
        fail(f"'{command}' benötigt {minimum} weitere Argument(e).", 2)
    handler(path, *args)


if __name__ == "__main__":
    main()
