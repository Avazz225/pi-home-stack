# pi-home-stack

Turns a Raspberry Pi into a network ad filter, a NAS and a small home dashboard —
with one guided script that you can run again whenever you want to add something.

```bash
git clone <this-repo> pi-home-stack
cd pi-home-stack
sudo ./install.sh
```

Everything is optional and everything is re-runnable. Decided against the backup
at first and changed your mind three months later?

```bash
sudo pi-home-stack --features backup
```

## What it sets up

**Foundations**

| Component | What you get |
|---|---|
| `storage` | A data store: an existing RAID, a new RAID 1, a single disk, or just a directory |
| `nginx` | One web server on port 80 in front of everything, Pi-hole included |
| `maintenance` | Unattended security updates, log rotation, and a config export |

**Network**

| Component | What you get |
|---|---|
| `pihole` | Pi-hole as a network-wide ad and tracker filter, plus weekly upkeep |
| `mdns` | The Pi reachable as `<name>.local`: sets the hostname and announces it over Avahi |
| `duckdns` | Keeps a DuckDNS hostname pointed here, on a timer |
| `netmonitor` | A periodic internet speed measurement with a small API |

**NAS and backup**

| Component | What you get |
|---|---|
| `samba` | An SMB share of the data store, with its own account and a recycle bin |
| `backup` | Encrypted off-site backup of the data store, to object storage or a directory |
| `backupui` | Web interface for the backup: folders, targets, credentials, run history |

**Interfaces**

| Component | What you get |
|---|---|
| `homeui` | A status page: disks, RAID health, Pi-hole numbers, backup state, quick links |
| `dashboard` | A React dashboard as the start page, built from a checkout you point at |

`homeui` and `dashboard` both want to be the page at `/`. Install one of them.
Asking for the second one warns and takes the place over.

**Services behind the interfaces**

| Component | What you get |
|---|---|
| `apiservices` | Four small Flask services — profiles and todos, feature tracking, study planning, home control |
| `speedtest` | Adopts an existing speed-test service and gives it an API and a schedule |
| `grafana` | Grafana in a container, published under `/grafana/` |
| `vault` | HashiCorp Vault as a service on this Pi, published under `/vault/` |

`vault` as a *component* installs a Vault server. That is a different thing from
the `vault` *credential backend* below, which talks to a Vault you already have —
they are unrelated choices that happen to share a name.

### Dependencies

They resolve themselves, and the installer says why something it was not asked
for turned up:

```
To be set up: storage nginx samba
      storage comes along because samba needs it
```

Only components that genuinely cannot work without it pull `storage` in — a
network share and a backup of the data store need one. Everything else treats it
as optional: `apiservices` and `speedtest` put their databases on the data store
when there is one and under `/var/lib/pi-home-stack` when there is not, and say
so, because a database outside the data store is in no backup.

Some components only appear once they make sense. `backupui` stays out of the
menu until `backup` is installed — a configuration screen for a service you do
not run is a dead end. Naming it explicitly still works and pulls the whole chain
in:

```bash
sudo pi-home-stack --features backupui   # installs storage, nginx, homeui, backup, backupui
```

### What ends up where

| Path | Serves |
|---|---|
| `/` | `homeui` or `dashboard` |
| `/admin/` | Pi-hole's own interface |
| `/api/` | Pi-hole's REST API — **not** free for your own use |
| `/backup/`, `/backup-api/` | `backupui` and its API |
| `/profile-api/`, `/tracking-api/`, `/study-api/`, `/home-api/` | `apiservices` |
| `/speedtest-api/` | `speedtest` |
| `/netmon-api/` | `netmonitor` |
| `/grafana/` | `grafana` |
| `/vault/` | `vault` |

Each component writes one numbered snippet into `/etc/nginx/pi-home-stack/`, and
the numbers decide the order. Two snippets declaring the same `location` stop
nginx from starting at all, which is why `/api/` belongs to Pi-hole alone: it
serves its own API there, and anything of yours has to live somewhere else.

## Requirements

* A Raspberry Pi (tested against Pi 5) running Raspberry Pi OS Bookworm or newer,
  64-bit, with SSH access. Pi OS Lite is enough.
* For the NAS part: at least one disk that is not the system disk. Two of the same
  size if you want the installer to build a RAID 1 for you.
* For the backup part: an S3 bucket, an account with an S3-compatible provider, or
  a directory the Pi can write to.
* For `dashboard`: either a prebuilt `build/` in the checkout, or Node on the Pi —
  the module installs `nodejs` and `npm` and builds, which needs about 1 GB of
  memory and a few minutes.
* For the home-control service in `apiservices`: Python 3.14, because
  `deebot-client` requires it. Install it somewhere readable by the service user,
  `/opt` rather than a home directory. Without it that one service is skipped and
  the other three still run.

## Usage

```bash
sudo ./install.sh                        # guided
sudo ./install.sh --features storage,samba,pihole
sudo ./install.sh --features all
sudo ./install.sh --status               # what is installed, changes nothing
./install.sh --dry-run --features all    # preview, no root needed
sudo ./install.sh --remove netmonitor
sudo ./install.sh -l en                  # force a language
```

After the first run the installer copies itself to `/opt/pi-home-stack/src` and
puts `pi-home-stack` on your PATH, so the checked-out repository is no longer
needed.

### Language

The interface follows your locale and falls back to English. `-l de` / `-l en`
overrides it. Translations live in `lib/lang/<code>.sh` and are keyed by the
English source string, so an incomplete catalogue simply shows English for the
strings it does not cover — adding a language is one file, no code changes.

## Where credentials go

The stack generates several passwords. You pick once where they live:

* **`kdbx`** — a KeePass file at `/etc/pi-home-stack/secrets.kdbx`. You remember one
  master password; everything else is generated and stored. **Copy this file off
  the Pi** — without it and the master password, the generated credentials are gone.
* **`vault`** — HashiCorp Vault (KV v2), for homelabs that already run one. Secrets
  stay on the Vault server; the Pi keeps only an AppRole credential. A stolen SD
  card then costs you one revocable AppRole instead of a vault file that can be
  attacked offline forever.
* **`none`** — nothing is stored, passwords are printed once.

Services never talk to the credential store. Anything a daemon needs unattended is
written to a single root-only file under `/etc/pi-home-stack/secrets/`, so a
compromised Pi exposes one service credential rather than the whole store. That
directory is `0711`: a service user has to be able to walk through it, and what
protects each file is its own mode and owner, not a closed door that would shut
the legitimate reader out as well.

## The backup

Files are encrypted **before** they leave the Pi: AES-256-GCM, streamed in 1 MiB
chunks, a separate key per file derived from one backup key. The provider only
ever sees ciphertext.

`.kdbx` files are the one exception — they are uploaded as they are, so a KeePass
database stays openable straight from the backup without this tooling. Their own
encryption is what protects them.

**Targets** are where copies go, and you can have several. Each file is written to
every enabled target, and the index tracks per target what it holds — so if one
target is unreachable, only that one is caught up on the next run, and the others
are never rewritten. Encryption happens once per file regardless of how many
targets there are.

A target is one of:

* **Object storage** — Amazon S3, or anything speaking S3: MinIO, Garage, Ceph,
  Backblaze B2, Wasabi, Hetzner. Set an endpoint URL; some self-hosted stores also
  need path-style addressing.
* **A directory** — an NFS or SMB mount, a USB disk, a second internal drive. For
  network mounts, turn on *only when mounted*: otherwise a share that failed to come
  up looks like an empty writable directory and the backup silently lands on the
  local disk.

Deleted files get a marker and are removed from every target once the retention
period passes (30 days by default), so an accidental delete is recoverable for a
while.

Guards worth knowing about, because a job that deletes on a schedule needs them:

* A flock prevents two runs at once, and the kernel releases it even if a run crashes.
* If a run finds no files at all while the index is full, it aborts instead of
  marking the entire backup for deletion — that is what an unmounted NAS looks like.
* An empty folder selection aborts rather than treating it as "delete everything".

### Configuring it

With `backupui` installed, everything is reachable at `http://<pi>/backup/`,
linked from the backup tile on the home page: a status tab with run history and
logs, a folder tree for picking what gets backed up, a target list with coverage
per target, and the credentials. Without it, the same is available as a REST API
under `/backup-api/`.

Restores:

```bash
cd /opt/pi-home-stack/backup
venv/bin/python restore.py --dest /tmp/restore
venv/bin/python restore.py --dest /tmp/restore --target "Spain"
venv/bin/python restore.py --dest /tmp/restore --from-bucket   # without the index
venv/bin/python restore.py --decrypt-local file.pdf.enc --dest-file file.pdf
```

## Layout

```
install.sh              entry point, feature selection, orchestration
bin/pi-home-stack       wrapper onto the installed copy
lib/
  common.sh             logging, guarded execution, idempotence primitives
  state.sh              persisted answers and installed-feature bookkeeping
  ui.sh                 prompts
  i18n.sh, lang/        translation layer and catalogues
  secrets.sh, backends/ credential store dispatcher and its three backends
  keepass_store.py      KeePass access for the kdbx backend
  vault_api.py          Vault access for the vault backend
modules/<feature>.sh    one file per component, module_install / module_remove
templates/              config files with @PLACEHOLDER@ substitution
assets/
  homeui/               status page, plus the theme/i18n chrome both pages share
  backupui/             backup configuration interface
  backup/               the backup service itself
  netmonitor/           speed measurement service
  duckdns/              the DuckDNS update script
  maintenance/          config export
tools/
  sync-backup-service.py  pulls the backup service in from its upstream checkout
tests/                  what can be tested without a Pi
```

Each module is a shell file with `module_install` and `module_remove`, sourced in
a subshell so modules cannot leak variables into each other. Adding a component is
one file in `modules/` plus one line in `FEATURE_DEFS`.

## Idempotence

Running the installer twice must be boring. Every helper reports "unchanged"
rather than redoing work, files are only written when their content actually
differs, services restart only when something changed, and answers you gave once
are remembered in `/etc/pi-home-stack/stack.env` and offered back as defaults.

Files the installer did not create are backed up to `<name>.phs-orig` before they
are first touched.

## Safety

The only step that can destroy data is creating a RAID or formatting a disk. It is
gated: system and mounted disks are never offered, the contents of every candidate
are printed first, the device name has to be typed out rather than picked from a
list, and a confirmation phrase has to be typed exactly. Unattended mode refuses
to do it at all. Those questions only appear when `storage` is actually part of
the run, and if it was pulled in rather than asked for, the installer names the
component that needed it.

Removing a component never deletes your data. `--remove storage` drops the fstab
entry and leaves the array and its contents alone. Data that has to move is copied
and the old location is kept as `<name>.vor-umzug` rather than deleted.

## Tests

```bash
tests/run_tests.sh
```

Six suites: shell syntax over every script, Python syntax over every module,
JavaScript syntax where Node is available, the feature graph (dependency
resolution, conditional visibility, and that every declared feature has a working
module), the translation layer including a check for stale catalogue keys, and the
backup service end to end — encryption round-trips including wrong passwords,
truncation and bit flips; the folder rule resolution; complete backup runs against
a stubbed object store and a real directory; multi-target replication with an
unreachable target; retention; and the REST API. None of it needs a Pi, AWS, or a
credential store. Suites whose dependencies are missing report `SKIP` rather than
failing.

## Known limits

* `dashboard`, `apiservices` and `speedtest` do not ship their own source. They
  install from a checkout you point them at, or in the case of `speedtest` adopt a
  service that is already there. Until that changes, a complete install needs more
  than this repository.
* Change detection in the backup uses size and mtime, not checksums. A file
  modified so that both stay identical is not noticed.
* Renamed files count as "deleted plus new" and are uploaded again.
* Pi-hole's own numbers on the status page come from `pihole -c -j`, which v6 no
  longer provides; the tile then shows service state only.
* There is no update path yet. Re-running a component installs the current
  version, but nothing compares what is installed against what the repository
  holds, so you decide yourself what needs re-running after a `git pull`.
