#!/usr/bin/env python3
"""Syncs the backup service from its upstream checkout into assets/backup.

The packaged copy differs from upstream in exactly one respect: it reads its
encryption key from a root-only file instead of opening a KeePass database, so the
installer can serve KeePass and HashiCorp Vault users with the same service. That
difference is expressed here as a patch rather than as a forked file, so upstream
fixes keep flowing in.

    python3 tools/sync-backup-service.py ../pinas_s3_backup
"""

import os
import shutil
import sys

FILES = ["state.py", "filecrypt.py", "storage_targets.py", "backup_job.py",
         "app.py", "restore.py", "schema.sql", "requirements.txt"]

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEST = os.path.join(HERE, "assets", "backup")


def replace(path, old, new, required=True):
    with open(path, encoding="utf-8") as handle:
        content = handle.read()
    if old not in content:
        if required:
            sys.exit(f"Patch target not found in {os.path.basename(path)}: {old[:70]!r}")
        return
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(content.replace(old, new))


def cut(path, start_marker, end_marker, replacement):
    with open(path, encoding="utf-8") as handle:
        content = handle.read()
    if start_marker not in content or end_marker not in content:
        sys.exit(f"Cut markers not found in {os.path.basename(path)}")
    start = content.index(start_marker)
    end = content.index(end_marker)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(content[:start] + replacement + content[end:])


def main():
    source = os.path.abspath(sys.argv[1] if len(sys.argv) > 1
                             else os.path.join(HERE, "..", "pinas_s3_backup"))
    if not os.path.isdir(source):
        sys.exit(f"Source not found: {source}")

    os.makedirs(DEST, exist_ok=True)
    for name in FILES:
        shutil.copy2(os.path.join(source, name), os.path.join(DEST, name))
    shutil.rmtree(os.path.join(DEST, "tests"), ignore_errors=True)
    shutil.copytree(os.path.join(source, "tests"), os.path.join(DEST, "tests"))
    os.remove(os.path.join(DEST, "tests", "run_tests.sh")) \
        if os.path.exists(os.path.join(DEST, "tests", "run_tests.sh")) else None

    state_py = os.path.join(DEST, "state.py")
    replace(state_py, '''    "kdbx_path": "",
    "kdbx_password_file": "/etc/pinas-s3-backup/kdbx.secret",
    "kdbx_entry_title": "pinas S3 Backup",''',
            '''    # Path to a root-only file holding the backup encryption key. The
    # authoritative copy of that key lives in the operator's credential store
    # (KeePass or HashiCorp Vault); this file is the materialised copy the
    # unattended job is allowed to read.
    "key_file": "/etc/pi-home-stack/secrets/backup.key",''')
    replace(state_py, '"""Shared state layer for the pinas S3 backup.',
            '"""Shared state layer for the NAS backup.')

    job_py = os.path.join(DEST, "backup_job.py")
    cut(job_py, "def load_backup_passphrase(cfg):", "class S3Clients:",
        '''def load_backup_passphrase(cfg):
    """Read the backup encryption key from its root-only file.

    The key is generated once during installation and its authoritative copy lives
    in the operator's credential store; this file is the materialised copy the
    unattended job is allowed to read. Limiting the job to a single key means a
    compromised Pi leaks the backup key alone, not the store holding every other
    credential as well.
    """
    key_file = cfg.get("key_file") or ""
    if not key_file:
        raise JobError("Keine Schlüsseldatei konfiguriert.")
    return read_secret_file(key_file)


''')
    replace(job_py, '''    if not cfg.get("kdbx_path"):
        problems.append("Kein Pfad zur kdbx-Datei konfiguriert.")
    if not cfg.get("kdbx_entry_title"):
        problems.append("Kein kdbx-Eintrag konfiguriert.")''',
            '''    key_file = cfg.get("key_file") or ""
    if not key_file:
        problems.append("Keine Schlüsseldatei konfiguriert.")
    elif not os.path.isfile(key_file):
        problems.append(f"Schlüsseldatei nicht gefunden: {key_file}")''')
    replace(job_py, '"""Read the KeePass master password from a file that only its owner may read."""',
            '"""Read a secret from a file that only its owner may read."""')
    replace(job_py, '''comes from an entry in a KeePass database. .kdbx files themselves are uploaded
unencrypted so they stay usable without this tooling — their own encryption is
what protects them.''',
            '''comes from a root-only key file. .kdbx files themselves are uploaded unencrypted
so they stay usable without this tooling — their own encryption is what protects
them.''')
    replace(job_py, 'log("Backup-Schlüssel aus kdbx geladen.")',
            'log("Backup-Schlüssel geladen.")')

    replace(os.path.join(DEST, "app.py"),
            '"""Verifies every enabled bucket and that the backup key can be read from the kdbx."""',
            '"""Verifies every enabled target and that the backup key file is readable."""')

    # pykeepass is only needed by the upstream key source.
    requirements = os.path.join(DEST, "requirements.txt")
    with open(requirements, encoding="utf-8") as handle:
        lines = [line for line in handle if not line.startswith("pykeepass")]
    with open(requirements, "w", encoding="utf-8") as handle:
        handle.writelines(lines)

    for name in ("test_guards.py", "test_job.py", "test_targets.py", "test_backends.py"):
        path = os.path.join(DEST, "tests", name)
        if not os.path.exists(path):
            continue
        replace(path, '"kdbx_path": __file__,\n                      "kdbx_entry_title": "x", ',
                '"key_file": __file__, ', required=False)
        replace(path, '"kdbx_path": __file__, "kdbx_entry_title": "x",',
                '"key_file": __file__,', required=False)
        replace(path, '("kdbx_path", __file__),\n                   ("kdbx_entry_title", "x"), ',
                '("key_file", __file__), ', required=False)
        replace(path, '"kdbx_path": __file__,\n                      "kdbx_entry_title": "x", "enabled": "1"',
                '"key_file": __file__, "enabled": "1"', required=False)

    print(f"Synced {len(FILES)} files + tests into {DEST}")


if __name__ == "__main__":
    main()
