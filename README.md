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
| `status` | The numbers about this machine, collected once a minute into a `status.json` |
| `homeui` | A status page: disks, RAID health, Pi-hole numbers, backup state, quick links |
| `dashboard` | A React dashboard as the start page, shipped prebuilt in `apps/dashboard` |

`status` is the data source, not a page, and both interfaces pull it in. It is a
systemd timer that writes one file; nothing listens on the network for it. It used
to be part of `homeui`, which meant a dashboard-only install had no way to see
whether the array was healthy — on the day a boot medium dies, that is the screen
you want. The dashboard's *System* pane reads the same file.

`homeui` and `dashboard` both want to be the page at `/`, so only one of them can
be installed. Choosing `dashboard` removes `homeui` — and `backupui` with it,
since the dashboard has that view built in. The installer says so before it does
it:

```
dashboard replaces homeui - both want to be the start page.
```

The rule works in one direction only. Installing `homeui` on top of a dashboard
is not undone for you; it overwrites the start page and warns.

**Services behind the interfaces**

| Component | What you get |
|---|---|
| `apiservices` | Four small Flask services from `apps/` — profiles and todos, feature tracking, study planning, home control |
| `speedtest` | Its own speed-test service: scheduled measurements, a read API, and the rates your line was sold as |
| `grafana` | Grafana in a container, published under `/grafana/` |
| `vault` | HashiCorp Vault as a service on this Pi, published under `/vault/` |

The home pane draws the flat as a floorplan. Its geometry lives in the service's
database, not in the frontend, which is why the prebuilt bundle fits every
installation: changing a flat is changing data, not rebuilding the frontend.

Under *Settings* there is an editor for it. Draw a room on a grid, drag it by its
middle, pull a corner to reshape it, pull the midpoint of a wall to turn a
rectangle into an L. Rooms snap to each other, not only to the grid — with a
0.25 m grid and a neighbour's wall at 3.965 m the grid alone leaves a seam of
three centimetres that is not in the flat. Exact wall lengths are a list beside
the plan, and setting one moves only the far end of that wall, so walls already
measured stay where they were put.

The rooms tile the flat, so a wall is an edge two rooms share rather than a shape
of its own. Which edges are partitions and which face outside is derived, not
configured: an edge another room lies against is interior, and an edge touching
something outdoors — a balcony — is the building's skin however well it is
shared. Two thicknesses, 11.5 and 24 cm by default, are all the configuration
there is.

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
sudo pi-home-stack --features backupui   # installs storage, nginx, status, homeui, backup, backupui
```

### What ends up where

| Path | Serves |
|---|---|
| `/` | `homeui` or `dashboard` |
| `/status.json` | `status` — a file, not a route; no service answers it |
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
* Nothing else. Everything the stack installs lives in this repository,
  `apps/dashboard/build` included, so a Pi needs neither Node nor a second
  checkout. Node is only needed if you change the frontend's source and want to
  rebuild it.
* For the home-control service in `apiservices`: Python 3.14, because
  `deebot-client` requires it. Install it somewhere readable by the service user,
  `/opt` rather than a home directory. Without it that one service is skipped and
  the other three still run.

## Building the same thing

What this was developed and is running on. Nothing here is required — the stack
cares about Raspberry Pi OS and a disk, not about a particular model — but a
parts list saves the evening of research, and the case exists.

| Part | Why this one |
|---|---|
| Raspberry Pi 5 (at least 4GB RAM) | Enough memory to build the frontend on the device and run the containers |
| Official 27 W USB-C power supply | The USB disks need the higher current limit; a weaker supply caps the ports at 600 mA |
| High-endurance microSD card (from 32GB) | A normal card dies of the write load from logs and databases — see below |
| Two SATA SSDs (e.g. Samsung 870 QVO 1TB) | For the RAID 1. Identical capacities, so the array stays symmetric |
| Two USB to SATA Adapters | For connecting the SSDs |
| A PWM fan on GPIO 12 (40×40×10mm) | Quiet under load; the fan controller is not part of this repository |

Deliberately without shop links. Models change, listings disappear, and a parts
list the author earns from reads differently from one that just says what is in
the box. The Raspberry Pi parts are easiest bought from the
[official reseller list](https://www.raspberrypi.com/resellers/); the rest is
generic.

### The case

A 3D-printed enclosure holding the Pi, both SSDs and the 40 mm fan:
[the case on Thingiverse](https://www.thingiverse.com/thing:7357571).

<!-- TODO: Druckeinstellungen ergänzen — Material, Schichthöhe, Infill, ob
     Stützen nötig sind. Für jemanden, der nachdruckt, ist das oft wichtiger
     als die Datei selbst. -->

### When the Pi stops responding after a reboot

Worth recognising, because it cost days here.

The symptom: after a restart the Pi still answers a ping, the SSH banner may
even appear within milliseconds, and yet nothing completes. Logging in hangs.
The load climbs into double digits with no process to account for it. Anything
already in memory keeps serving; anything that has to read from the boot medium
stops.

That is what a dying SD card looks like, and a reboot is when it shows — a
restart reads a great deal that has not been touched in weeks. Not a kernel
problem, not the update that preceded it, however much it looks that way.

What to do is unglamorous: stop trying to repair it from inside. Take the card
out, image it elsewhere with `ddrescue`, and put a new one in. A high-endurance
card is worth the few extra euros; a normal one lives on the write load of logs
and databases.

One thing that is easy to get wrong: **a clean sequential read does not clear
the card.** The one here came back from `ddrescue` with zero bad sectors across
128 GB and was still the problem — the filesystem damage was logical, not a
matter of unreadable blocks. So do not conclude from a successful image that the
card is fine.

You will also find advice to turn off Command Queueing, which newer kernels use
on SD cards:

```
dtparam=sd_cqe=off
```

It may help, and a missing `CQHCI version` line in `dmesg` confirms it took
effect. But honestly: here the card was replaced and this line was added in the
same step, so which of the two fixed it was never established. Replacing the
card alone did it, as far as anyone can tell.

## Usage

```bash
sudo ./install.sh                        # guided
sudo ./install.sh --features storage,samba,pihole
sudo ./install.sh --features all
sudo ./install.sh --status               # what is installed, changes nothing
sudo ./install.sh --update               # after a git pull: only what changed
sudo ./install.sh --update --force       # redeploy everything regardless
./install.sh --dry-run --features all    # preview, no root needed
sudo ./install.sh --remove netmonitor
sudo ./install.sh -l en                  # force a language
```

After the first run the installer copies itself to `/opt/pi-home-stack/src` and
puts `pi-home-stack` on your PATH, so the checked-out repository is no longer
needed.

### Updating

`git pull`, then `sudo ./install.sh --update`. It works out what actually
changed and leaves the rest alone:

```
· Up to date: storage samba nginx pihole maintenance
  To be updated: dashboard speedtest
```

The comparison is a content hash per component, taken over its module, the
library it is built on, the templates and assets it names, and the applications
under `apps/` that belong to it. A hash rather than a version number in each
module, because a number has to be remembered and the one time it is forgotten
the update quietly does nothing.

It is deliberately broad: a change in `lib/` counts for every component, since
anything there can change every file a module renders. That costs little — a
redeploy writes identical files, notices they are identical, and restarts
nothing.

A component installed before this existed has no hash recorded and is updated
once. `--force` skips the comparison entirely.

Where a layout or a data format changed, the module migrates before it
redeploys: data is copied to its new place and the old location is kept as
`<name>.vor-umzug`. Nothing is deleted on an update, ever.

An update can ask a question if a component gained a setting it did not have
before. Everything answered previously comes from the state file.

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
  fingerprint.sh        content hashes, so --update knows what changed
  keepass_store.py      KeePass access for the kdbx backend
  vault_api.py          Vault access for the vault backend
modules/<feature>.sh    one file per component, module_install / module_remove
templates/              config files with @PLACEHOLDER@ substitution
apps/                   the applications the stack deploys
  dashboard/            React frontend, with a committed build/ so no Node is needed
  quickaction/          profiles and todos        -> /profile-api/
  tracking/             feature tracking          -> /tracking-api/
  study/                study planning            -> /study-api/
  home/                 Hue, heating, vacuum      -> /home-api/
  speedtest/            measurement and read API  -> /speedtest-api/
assets/
  status/               the collector behind status.json, run by a timer
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

Automatic updates are limited on purpose. Only the Debian security pocket is
applied without asking; the kernel and the firmware are on the blacklist unless
you say otherwise, and a reboot is never taken automatically by default. The
reason is specific: a new kernel does not break anything at install time, it
breaks at the next reboot — which can be days later and look like something
else entirely. The price is that kernel security fixes wait for you;
`apt list --upgradable` shows what.

Removing a component never deletes your data. `--remove storage` drops the fstab
entry and leaves the array and its contents alone. Data that has to move is copied
and the old location is kept as `<name>.vor-umzug` rather than deleted.

## Tests

```bash
tests/run_tests.sh
```

Eight suites: shell syntax over every script, Python syntax over every module
and every application under `apps/`, JavaScript syntax where Node is available,
a check that the prebuilt dashboard bundle is present, the feature graph
(dependency resolution, conditional visibility, displacement — that `dashboard`
really does take `homeui` out of the selection and off the machine, and that it
does not work the other way round — and that every declared feature has a
working module), module structure (no module function may end on a bare conditional —
under `set -e` that aborts the run exactly when the condition is false, which
bit for real; every template claimed by a module; every application under
`apps/` claimed by exactly one component, so a change to it really does trigger
an update; fingerprints stable across two runs; the pane manifest, including the
system pane, which is gated on a component rather than on an nginx route; and the
executable bits — checked
against the git index rather than the working tree, because this one was once
committed wrong and a fresh clone could not run `./install.sh` at all), the
translation layer
including a check for stale catalogue keys, and the
backup service end to end — encryption round-trips including wrong passwords,
truncation and bit flips; the folder rule resolution; complete backup runs against
a stubbed object store and a real directory; multi-target replication with an
unreachable target; retention; and the REST API. None of it needs a Pi, AWS, or a
credential store. Suites whose dependencies are missing report `SKIP` rather than
failing.

## Supporting this

It is free, and it stays free — there is nothing behind a paywall and nothing
that phones home. If it saved you an evening and you feel like giving something
back, the repository page has a sponsor button. Any amount, once, or not at all;
nobody is keeping score.

An issue that describes a problem precisely, or a pull request, is worth more
than the money. That is not a polite phrase: a bug report from a Pi that is set
up differently from mine is the only way some of these mistakes ever surface.

## Known limits

* Change detection in the backup uses size and mtime, not checksums. A file
  modified so that both stay identical is not noticed.
* Renamed files count as "deleted plus new" and are uploaded again.
* Pi-hole's own numbers on the status page come from `pihole -c -j`, which v6 no
  longer provides; the tile then shows service state only.
