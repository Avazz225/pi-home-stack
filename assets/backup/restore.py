#!/usr/bin/env python3
"""Restore files from the S3 backup.

Works from the local object index (data/backup.db), which knows for every bucket
what it holds. If that database is lost the bucket can still be restored:
`--from-bucket` lists S3 directly instead.

With several targets, one bucket is restored from — by default the first enabled
one, or `--target` to name another. The copies are equivalent, so this normally
only matters when one region is unavailable.

Examples:
    # Everything that is currently live, into /tmp/restore
    python3 restore.py --dest /tmp/restore

    # From the second region instead
    python3 restore.py --dest /tmp/restore --target Spanien

    # A single folder, including files whose deletion marker has not expired yet
    python3 restore.py --dest /tmp/restore --path "Fotos/2024" --include-deleted

    # Recover without the index
    python3 restore.py --dest /tmp/restore --from-bucket

    # Decrypt a single already-downloaded container
    python3 restore.py --decrypt-local backup.pdf.enc --dest-file backup.pdf
"""

import argparse
import os
import sys
import tempfile

import state
from backup_job import JobError, S3Clients, load_backup_passphrase
from storage_targets import TargetError, build_target
from filecrypt import ENCRYPTED_SUFFIX, DecryptionError, decrypt_file


def safe_join(dest_root, rel_path):
    """Join and verify the result stays inside dest_root (defence against odd keys)."""
    target = os.path.normpath(os.path.join(dest_root, rel_path))
    root = os.path.normpath(dest_root)
    if target != root and not target.startswith(root + os.sep):
        raise JobError(f"Zielpfad verlässt das Zielverzeichnis: {rel_path}")
    return target


def pick_target(db, wanted):
    """Choose the bucket to restore from: by name or id, otherwise the first enabled one."""
    targets = state.get_targets(db)
    if not targets:
        raise JobError("Es ist kein Backup-Ziel konfiguriert.")
    if wanted:
        for target in targets:
            if str(target["id"]) == str(wanted) or target["name"].lower() == str(wanted).lower():
                return target
        names = ", ".join(f"{t['id']}={t['name']}" for t in targets)
        raise JobError(f"Ziel '{wanted}' nicht gefunden. Verfügbar: {names}")
    for target in targets:
        if target["enabled"]:
            return target
    return targets[0]


def objects_from_index(db, target, path_filter, include_deleted):
    """Objects this specific bucket holds, from the local index."""
    query = ("SELECT o.rel_path AS rel_path, ot.s3_key AS s3_key, o.encrypted AS encrypted "
             "FROM object_target ot JOIN backup_object o ON o.id = ot.object_id "
             "WHERE ot.target_id = ?")
    params = [target["id"]]
    if not include_deleted:
        query += " AND o.deleted_at IS NULL"
    if path_filter:
        query += " AND (o.rel_path = ? OR o.rel_path LIKE ?)"
        params += [path_filter, f"{path_filter}/%"]
    query += " ORDER BY o.rel_path"
    return [
        {"rel_path": r["rel_path"], "s3_key": r["s3_key"], "encrypted": bool(r["encrypted"])}
        for r in db.execute(query, params)
    ]


def objects_from_backend(backend, target, path_filter):
    """Rebuild the object list straight from the target — the key layout mirrors
    the NAS tree, so the index is not needed to find anything."""
    prefix = (target["prefix"] or "").strip("/")
    listing_prefix = "/".join(p for p in (prefix, path_filter) if p)
    objects = []
    for key in backend.list_keys(listing_prefix):
        rel = key[len(prefix) + 1:] if prefix and key.startswith(prefix + "/") else key
        encrypted = rel.endswith(ENCRYPTED_SUFFIX)
        if encrypted:
            rel = rel[: -len(ENCRYPTED_SUFFIX)]
        objects.append({"rel_path": rel, "s3_key": key, "encrypted": encrypted})
    objects.sort(key=lambda o: o["rel_path"])
    return objects


def restore(dest, path_filter, include_deleted, from_bucket, dry_run, wanted_target):
    state.init_db()
    db = state.connect()
    try:
        cfg = state.get_config(db)
        target = pick_target(db, wanted_target)
        backend = build_target(target, S3Clients(cfg))
        print(f"Quelle: {target['name']} — {backend.describe()}"
              + (f"/{target['prefix']}" if target["prefix"] else ""))
        objects = (objects_from_backend(backend, target, path_filter) if from_bucket
                   else objects_from_index(db, target, path_filter, include_deleted))
        if not objects:
            print("Keine passenden Objekte gefunden.")
            return 0

        needs_key = any(o["encrypted"] for o in objects)
        passphrase = load_backup_passphrase(cfg) if needs_key and not dry_run else None
        key_cache = {}

        print(f"{len(objects)} Objekte werden nach {dest} wiederhergestellt.")
        failed = 0
        for obj in objects:
            dest_path = safe_join(dest, obj["rel_path"])
            if dry_run:
                print(f"  [dry-run] {obj['s3_key']} -> {dest_path}")
                continue
            os.makedirs(os.path.dirname(dest_path) or ".", exist_ok=True)
            try:
                if obj["encrypted"]:
                    fd, tmp_path = tempfile.mkstemp(prefix="pinas-restore-")
                    os.close(fd)
                    try:
                        backend.download(obj["s3_key"], tmp_path)
                        decrypt_file(tmp_path, dest_path, passphrase, key_cache)
                    finally:
                        try:
                            os.unlink(tmp_path)
                        except OSError:
                            pass
                else:
                    backend.download(obj["s3_key"], dest_path)
                print(f"  {obj['rel_path']}")
            except Exception as exc:  # noqa: BLE001 - one bad object must not stop the restore
                failed += 1
                print(f"  FEHLER {obj['rel_path']}: {exc}", file=sys.stderr)

        if failed:
            print(f"{failed} Objekt(e) konnten nicht wiederhergestellt werden.", file=sys.stderr)
            return 1
        return 0
    finally:
        db.close()


def decrypt_local(src, dest_file):
    state.init_db()
    db = state.connect()
    try:
        cfg = state.get_config(db)
        passphrase = load_backup_passphrase(cfg)
    finally:
        db.close()
    decrypt_file(src, dest_file, passphrase)
    print(f"{src} -> {dest_file}")
    return 0


def main():
    parser = argparse.ArgumentParser(description="Stellt Dateien aus dem S3-Backup wieder her.")
    parser.add_argument("--dest", help="Zielverzeichnis für die Wiederherstellung")
    parser.add_argument("--path", default="", help="Nur diesen NAS-relativen Unterpfad")
    parser.add_argument("--include-deleted", action="store_true",
                        help="Auch Objekte mit noch nicht abgelaufenem Löschmarker")
    parser.add_argument("--from-bucket", action="store_true",
                        help="Objektliste aus S3 statt aus dem lokalen Index lesen")
    parser.add_argument("--target", default="",
                        help="Aus welchem Ziel wiederherstellen (Name oder ID). "
                             "Ohne Angabe das erste aktive Ziel.")
    parser.add_argument("--dry-run", action="store_true", help="Nur anzeigen, nichts schreiben")
    parser.add_argument("--decrypt-local", help="Eine einzelne .enc-Datei lokal entschlüsseln")
    parser.add_argument("--dest-file", help="Zieldatei für --decrypt-local")
    args = parser.parse_args()

    try:
        if args.decrypt_local:
            if not args.dest_file:
                parser.error("--decrypt-local benötigt --dest-file")
            sys.exit(decrypt_local(args.decrypt_local, args.dest_file))
        if not args.dest:
            parser.error("--dest wird benötigt")
        path_filter = state.normalize_rel(args.path)
        sys.exit(restore(args.dest, path_filter, args.include_deleted,
                         args.from_bucket, args.dry_run, args.target))
    except (JobError, TargetError, DecryptionError, ValueError) as exc:
        print(f"Fehler: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
