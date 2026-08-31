"""Smoke tests for filecrypt round-trips and the folder-rule resolution."""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import filecrypt  # noqa: E402
import state  # noqa: E402

failures = []


def check(name, condition):
    print(("PASS  " if condition else "FAIL  ") + name)
    if not condition:
        failures.append(name)


# ── filecrypt round-trip ─────────────────────────────────────────────────────
salt = os.urandom(16)
cipher = filecrypt.BackupCipher("correct horse battery staple", salt, chunk_size=4096)

with tempfile.TemporaryDirectory() as tmp:
    for label, payload in [
        ("empty file", b""),
        ("single byte", b"x"),
        ("exact chunk", os.urandom(4096)),
        ("chunk + 1", os.urandom(4097)),
        ("multi chunk", os.urandom(4096 * 3 + 17)),
    ]:
        src = os.path.join(tmp, "src.bin")
        enc = os.path.join(tmp, "src.bin.enc")
        dec = os.path.join(tmp, "out.bin")
        with open(src, "wb") as f:
            f.write(payload)
        cipher.encrypt_file(src, enc)
        filecrypt.decrypt_file(enc, dec, "correct horse battery staple")
        with open(dec, "rb") as f:
            check(f"round-trip: {label}", f.read() == payload)

    # Ciphertext must not contain the plaintext.
    src = os.path.join(tmp, "plain.txt")
    enc = os.path.join(tmp, "plain.txt.enc")
    with open(src, "w", encoding="utf-8") as f:
        f.write("GEHEIMER INHALT" * 100)
    cipher.encrypt_file(src, enc)
    with open(enc, "rb") as f:
        blob = f.read()
    check("ciphertext hides plaintext", b"GEHEIMER" not in blob)
    check("header magic present", blob[:4] == b"PNB1")

    # Wrong passphrase must fail.
    try:
        filecrypt.decrypt_file(enc, os.path.join(tmp, "x.bin"), "falsches passwort")
        check("wrong passphrase rejected", False)
    except filecrypt.DecryptionError:
        check("wrong passphrase rejected", True)

    # Truncation must fail (final marker missing).
    trunc = os.path.join(tmp, "trunc.enc")
    with open(trunc, "wb") as f:
        f.write(blob[: len(blob) - 40])
    try:
        filecrypt.decrypt_file(trunc, os.path.join(tmp, "y.bin"), "correct horse battery staple")
        check("truncation rejected", False)
    except filecrypt.DecryptionError:
        check("truncation rejected", True)

    # Bit flip must fail.
    corrupt = os.path.join(tmp, "corrupt.enc")
    tampered = bytearray(blob)
    tampered[filecrypt.HEADER_SIZE + filecrypt.RECORD_SIZE + 5] ^= 0x01
    with open(corrupt, "wb") as f:
        f.write(bytes(tampered))
    try:
        filecrypt.decrypt_file(corrupt, os.path.join(tmp, "z.bin"), "correct horse battery staple")
        check("bit flip rejected", False)
    except filecrypt.DecryptionError:
        check("bit flip rejected", True)

    # A second file gets a different salt/nonce, so identical input differs on disk.
    a, b = os.path.join(tmp, "a.enc"), os.path.join(tmp, "b.enc")
    cipher.encrypt_file(src, a)
    cipher.encrypt_file(src, b)
    check("per-file randomness", open(a, "rb").read() != open(b, "rb").read())

# ── Path normalization ───────────────────────────────────────────────────────
check("normalize strips slashes", state.normalize_rel("/Fotos/2024/") == "Fotos/2024")
check("normalize empty", state.normalize_rel("") == "")
check("normalize root slash", state.normalize_rel("/") == "")
for evil in ["../etc", "Fotos/../../etc", "..", "/../x"]:
    try:
        state.normalize_rel(evil)
        check(f"rejects traversal {evil!r}", False)
    except ValueError:
        check(f"rejects traversal {evil!r}", True)

# ── Rule resolution ──────────────────────────────────────────────────────────
rules = state.RuleSet({
    "Fotos": "include",
    "Fotos/RAW": "exclude",
    "Fotos/RAW/Wichtig": "include",
    "Dokumente/Steuer": "include",
})

check("default is exclude", rules.mode("") == "exclude")
check("unknown top-level excluded", rules.mode("Musik") == "exclude")
check("included folder", rules.mode("Fotos") == "include")
check("inherits include", rules.mode("Fotos/2024/Urlaub") == "include")
check("explicit exclude wins", rules.mode("Fotos/RAW") == "exclude")
check("exclude inherited down", rules.mode("Fotos/RAW/Nikon") == "exclude")
check("re-include below exclude", rules.mode("Fotos/RAW/Wichtig") == "include")
check("re-include inherited", rules.mode("Fotos/RAW/Wichtig/a/b") == "include")
check("deep include only", rules.mode("Dokumente") == "exclude")
check("deep include target", rules.mode("Dokumente/Steuer/2023") == "include")

check("descend into root", rules.should_descend("") is True)
check("descend to reach deep include", rules.should_descend("Dokumente") is True)
check("descend into excluded branch with include below",
      rules.should_descend("Fotos/RAW") is True)
check("do not descend into plain excluded", rules.should_descend("Musik") is False)
check("do not descend into excluded leaf", rules.should_descend("Fotos/RAW/Nikon") is False)

# ── s3 key layout ────────────────────────────────────────────────────────────
import backup_job  # noqa: E402

target = {"prefix": "nas-backup"}
check("object key encrypted", backup_job.object_key("Fotos/a.jpg", True) == "Fotos/a.jpg.enc")
check("object key plain", backup_job.object_key("pw.kdbx", False) == "pw.kdbx")
check("target key adds prefix",
      backup_job.target_key(target, "Fotos/a.jpg.enc") == "nas-backup/Fotos/a.jpg.enc")
check("target key without prefix",
      backup_job.target_key({"prefix": ""}, "a/b.txt.enc") == "a/b.txt.enc")
check("same object key in every bucket",
      backup_job.target_key({"prefix": "se"}, "x.enc").endswith("x.enc")
      and backup_job.target_key({"prefix": "es"}, "x.enc").endswith("x.enc"))
check("kdbx is plain", backup_job.is_plain("Safe/passwords.KDBX") is True)
check("pdf is encrypted", backup_job.is_plain("Safe/x.pdf") is False)

# ── Secret masking ───────────────────────────────────────────────────────────
masked = state.masked_config({**state.DEFAULTS, "aws_secret_access_key": "topsecret",
                              "crypto_salt": "abc"})
check("secret masked", masked["aws_secret_access_key"] == state.SECRET_MASK)
check("secret flag set", masked["aws_secret_access_key_set"] is True)
check("crypto salt not exposed", "crypto_salt" not in masked)
merged = state.merge_secrets({"aws_secret_access_key": state.SECRET_MASK, "s3_bucket": "b"})
check("masked secret dropped on save", "aws_secret_access_key" not in merged)
merged2 = state.merge_secrets({"aws_secret_access_key": "neu"})
check("new secret kept on save", merged2["aws_secret_access_key"] == "neu")

print()
print(f"{len(failures)} Fehler" if failures else "Alle Tests bestanden.")
sys.exit(1 if failures else 0)
