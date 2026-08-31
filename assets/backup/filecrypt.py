"""Streaming AES-256-GCM file encryption for the pinas S3 backup.

Container format (all integers big-endian):

    header (50 bytes)
        0   4   magic b"PNB1"
        4   1   version = 1
        5   1   kdf id (1 = scrypt n=2^14 r=8 p=1)
        6   4   chunk size in bytes
        10  16  scrypt salt   (constant per installation, kept in the config)
        26  16  hkdf salt     (random per file)
        42  8   nonce prefix  (random per file)

    then a sequence of records
        1   flag  (0 = data chunk, 1 = final marker)
        4   ciphertext length
        n   ciphertext incl. 16-byte GCM tag

The final record carries an empty plaintext, so a truncated file cannot decrypt
successfully: the reader only stops when it has seen flag 1.

Key derivation is split in two so that a run pays the expensive step only once:
scrypt turns the KeePass passphrase into a master key, and a cheap HKDF derives a
distinct key per file from the per-file salt. The scrypt salt travels in every
header, which keeps a single file restorable with nothing but the passphrase.
"""

import os
import struct

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

MAGIC = b"PNB1"
VERSION = 1
KDF_SCRYPT = 1
HEADER_FORMAT = ">4sBBI16s16s8s"
HEADER_SIZE = struct.calcsize(HEADER_FORMAT)  # 50
RECORD_FORMAT = ">BI"
RECORD_SIZE = struct.calcsize(RECORD_FORMAT)  # 5

DEFAULT_CHUNK_SIZE = 1024 * 1024
ENCRYPTED_SUFFIX = ".enc"

# Kept modest on purpose: the Pi has to run this and the step happens once per run.
SCRYPT_N = 2 ** 14
SCRYPT_R = 8
SCRYPT_P = 1


class DecryptionError(Exception):
    pass


def derive_master_key(passphrase, scrypt_salt):
    kdf = Scrypt(salt=scrypt_salt, length=32, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P)
    return kdf.derive(passphrase.encode("utf-8"))


def _derive_file_key(master_key, hkdf_salt):
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=hkdf_salt,
                info=b"pinas-s3-backup file key").derive(master_key)


class BackupCipher:
    """Holds the master key for one run so scrypt runs exactly once."""

    def __init__(self, passphrase, scrypt_salt, chunk_size=DEFAULT_CHUNK_SIZE):
        self.scrypt_salt = scrypt_salt
        self.chunk_size = chunk_size
        self.master_key = derive_master_key(passphrase, scrypt_salt)

    def encrypt_file(self, src_path, dst_path):
        """Encrypt src_path to dst_path. Returns the size of the written file."""
        hkdf_salt = os.urandom(16)
        nonce_prefix = os.urandom(8)
        header = struct.pack(HEADER_FORMAT, MAGIC, VERSION, KDF_SCRYPT,
                             self.chunk_size, self.scrypt_salt, hkdf_salt, nonce_prefix)
        aesgcm = AESGCM(_derive_file_key(self.master_key, hkdf_salt))

        with open(src_path, "rb") as src, open(dst_path, "wb") as dst:
            dst.write(header)
            index = 0
            while True:
                chunk = src.read(self.chunk_size)
                if not chunk:
                    break
                _write_record(dst, aesgcm, header, nonce_prefix, index, chunk, last=False)
                index += 1
            _write_record(dst, aesgcm, header, nonce_prefix, index, b"", last=True)
            dst.flush()
            os.fsync(dst.fileno())
        return os.path.getsize(dst_path)


def _nonce(nonce_prefix, index):
    return nonce_prefix + struct.pack(">I", index)


def _aad(header, index, last):
    return header + struct.pack(">IB", index, 1 if last else 0)


def _write_record(dst, aesgcm, header, nonce_prefix, index, plaintext, last):
    ciphertext = aesgcm.encrypt(_nonce(nonce_prefix, index), plaintext,
                                _aad(header, index, last))
    dst.write(struct.pack(RECORD_FORMAT, 1 if last else 0, len(ciphertext)))
    dst.write(ciphertext)


def decrypt_file(src_path, dst_path, passphrase, master_key_cache=None):
    """Decrypt a container written by BackupCipher.

    master_key_cache is an optional dict keyed by the scrypt salt so a bulk
    restore derives the master key only once.
    """
    with open(src_path, "rb") as src:
        header = src.read(HEADER_SIZE)
        if len(header) != HEADER_SIZE:
            raise DecryptionError(f"{src_path}: file is too short to hold a header")
        magic, version, kdf_id, chunk_size, scrypt_salt, hkdf_salt, nonce_prefix = \
            struct.unpack(HEADER_FORMAT, header)
        if magic != MAGIC:
            raise DecryptionError(f"{src_path}: not a pinas backup container")
        if version != VERSION or kdf_id != KDF_SCRYPT:
            raise DecryptionError(f"{src_path}: unsupported container version {version}/{kdf_id}")

        cache = master_key_cache if master_key_cache is not None else {}
        master_key = cache.get(scrypt_salt)
        if master_key is None:
            master_key = derive_master_key(passphrase, scrypt_salt)
            cache[scrypt_salt] = master_key
        aesgcm = AESGCM(_derive_file_key(master_key, hkdf_salt))

        with open(dst_path, "wb") as dst:
            index = 0
            while True:
                record_header = src.read(RECORD_SIZE)
                if len(record_header) != RECORD_SIZE:
                    raise DecryptionError(f"{src_path}: truncated before the final marker")
                flag, length = struct.unpack(RECORD_FORMAT, record_header)
                ciphertext = src.read(length)
                if len(ciphertext) != length:
                    raise DecryptionError(f"{src_path}: truncated chunk {index}")
                try:
                    plaintext = aesgcm.decrypt(_nonce(nonce_prefix, index), ciphertext,
                                               _aad(header, index, flag == 1))
                except Exception as exc:
                    raise DecryptionError(
                        f"{src_path}: chunk {index} failed to authenticate "
                        f"(wrong passphrase or corrupted data)") from exc
                if flag == 1:
                    break
                dst.write(plaintext)
                index += 1
    return dst_path
