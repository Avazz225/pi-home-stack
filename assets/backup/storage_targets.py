"""Storage adapters — the places a backup can be written to.

Everything above this module talks to a target through the same four operations
(upload, delete, download, check), so adding a destination never touches the
scanning, encryption or retention logic.

Two kinds today:

    s3   Amazon S3 and every S3-compatible store. The only thing that separates
         MinIO, Backblaze B2, Wasabi, Hetzner, Garage or Ceph from AWS is the
         endpoint URL and, for some of them, path-style addressing.

    fs   A directory. That covers an NFS or SMB mount, a USB disk, or a second
         local drive — the target is whatever the operating system has already
         mounted, which keeps network-filesystem quirks out of this code.
"""

import os
import shutil

CHUNK = 1024 * 1024


class TargetError(Exception):
    """Raised for problems that are the target's fault, not the caller's."""


# ── S3 and S3-compatible ─────────────────────────────────────────────────────

class S3Target:
    def __init__(self, target, clients):
        self.target = target
        self.bucket = target["bucket"]
        self.client = clients.for_target(target)

    @property
    def name(self):
        return self.target["name"]

    def describe(self):
        endpoint = self.target.get("endpoint_url") or "aws"
        return f"s3://{self.bucket} ({endpoint})"

    def upload(self, source_path, key):
        extra = {}
        storage_class = (self.target.get("storage_class") or "").strip()
        if storage_class and storage_class != "STANDARD":
            extra["StorageClass"] = storage_class
        # Server-side encryption is an AWS-ism; several compatible stores reject
        # the header outright, so it is only sent when talking to AWS itself.
        if not (self.target.get("endpoint_url") or "").strip():
            extra["ServerSideEncryption"] = "AES256"
        self.client.upload_file(source_path, self.bucket, key, ExtraArgs=extra)

    def delete(self, keys):
        """Delete many keys. Returns the set of keys that could not be removed."""
        failed = set()
        for start in range(0, len(keys), 1000):
            batch = keys[start:start + 1000]
            response = self.client.delete_objects(
                Bucket=self.bucket,
                Delete={"Objects": [{"Key": k} for k in batch], "Quiet": True},
            )
            for error in response.get("Errors", []):
                failed.add(error["Key"])
        return failed

    def download(self, key, dest_path):
        self.client.download_file(self.bucket, key, dest_path)

    def list_keys(self, prefix):
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            for item in page.get("Contents", []):
                yield item["Key"]

    def check(self):
        self.client.head_bucket(Bucket=self.bucket)


# ── Plain directory (NFS, SMB, USB, second disk) ─────────────────────────────

class FsTarget:
    """Writes into a directory tree. The 'bucket' field holds the base path."""

    def __init__(self, target):
        self.target = target
        self.base = os.path.abspath(target["bucket"])

    @property
    def name(self):
        return self.target["name"]

    def describe(self):
        return f"file://{self.base}"

    def _path_for(self, key):
        # Keys are built from NAS-relative paths, but a target is still not
        # allowed to write outside its own base directory.
        candidate = os.path.normpath(os.path.join(self.base, key))
        if candidate != self.base and not candidate.startswith(self.base + os.sep):
            raise TargetError(f"Key verlässt das Zielverzeichnis: {key}")
        return candidate

    def upload(self, source_path, key):
        destination = self._path_for(key)
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        # Write beside the target and rename: a half-copied file must never be
        # mistaken for a finished backup, and rename is atomic within a mount.
        temporary = f"{destination}.part"
        with open(source_path, "rb") as src, open(temporary, "wb") as dst:
            shutil.copyfileobj(src, dst, CHUNK)
            dst.flush()
            os.fsync(dst.fileno())
        os.replace(temporary, destination)

    def delete(self, keys):
        failed = set()
        for key in keys:
            try:
                path = self._path_for(key)
                if os.path.exists(path):
                    os.unlink(path)
                self._prune_empty(os.path.dirname(path))
            except (OSError, TargetError):
                failed.add(key)
        return failed

    def _prune_empty(self, directory):
        """Removes directories that the deletion just emptied, up to the base."""
        while directory.startswith(self.base) and directory != self.base:
            try:
                os.rmdir(directory)
            except OSError:
                return
            directory = os.path.dirname(directory)

    def download(self, key, dest_path):
        shutil.copyfile(self._path_for(key), dest_path)

    def list_keys(self, prefix):
        root = self._path_for(prefix) if prefix else self.base
        if not os.path.isdir(root):
            return
        for current, _dirs, files in os.walk(root):
            for name in files:
                if name.endswith(".part"):
                    continue
                full = os.path.join(current, name)
                yield os.path.relpath(full, self.base).replace(os.sep, "/")

    def check(self):
        if not os.path.isdir(self.base):
            raise TargetError(f"Verzeichnis nicht gefunden: {self.base}")
        # A missing mount usually looks like an empty, writable directory, so
        # writability alone is not proof that the real destination is there.
        if not os.access(self.base, os.W_OK):
            raise TargetError(f"Verzeichnis nicht beschreibbar: {self.base}")
        marker = self.target.get("require_mount")
        if marker and not os.path.ismount(self.base):
            raise TargetError(
                f"{self.base} ist kein Einhängepunkt — ist die Freigabe eingebunden?")


def build_target(target, clients):
    kind = (target.get("kind") or "s3").lower()
    if kind == "s3":
        return S3Target(target, clients)
    if kind == "fs":
        return FsTarget(target)
    raise TargetError(f"Unbekannte Zielart: {kind}")
