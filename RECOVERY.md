# Wiederaufbau nach dem Ausfall vom 5. Oktober 2026

## Ursache

**Die SD-Karte war nicht defekt.** Sie ließ sich anschließend mit `ddrescue`
vollständig und fehlerfrei auslesen — 128 GB, 0 bad areas, 0 read errors.

Was wirklich passiert ist:

1. `apt upgrade -y` installierte einen Kernelsprung von **6.1.54 auf 6.12.109** —
   nicht ein Punkt-Update, sondern eine neue Kernel-Serie.
2. Der automatische Reboot aus dem `maintenance`-Modul startete unbeobachtet in
   den neuen Kernel.
3. Dort scheiterte das **Command Queueing** des SD-Controllers. Die Karte lief im
   schnellsten Modus (`new ultra high speed SDR104 SDXC card`, `CQHCI version
   5.10`), und der neue Kernel behandelt diese Kombination anders.
4. Folge: Lese- und Schreibfehler auf `mmcblk0`, hängende ext4-Journal-Vorgänge,
   und ein System, das nur noch antwortete, solange nichts die Platte anfasste.

Das ist ein [bekanntes Problem](https://github.com/raspberrypi/linux/issues/6561)
am Pi 5. Der Raspberry-Pi-Kernel führt eine Sperrliste für Karten, bei denen CQE
nachweislich scheitert — Karten, die nicht darauf stehen, laufen mit CQE weiter.

## Die Behebung

In `/boot/firmware/config.txt` (Partition **p1**, nicht p2):

```
dtparam=sd_cqe=off
```

Danach prüfen, dass es greift:

```bash
dmesg | grep -i cqe      # sollte keine CQE-Recovery mehr melden
dmesg | grep mmc0
```

Alternativ ließe sich der alte Kernel festhalten — die genauen Paketversionen
stehen in `/var/log/apt/history.log`. Der Parameter ist aber die gezieltere
Lösung, weil er genau das abschaltet, was nicht funktioniert.

## Zwei Lehren, unabhängig von der Ursache

* **Automatische Reboots abschalten.** Der Installer fragt danach. Ein Neustart
  direkt nach einem Kernelupdate, unbeobachtet und ohne Konsole am Gerät, ist der
  Unterschied zwischen zwanzig Minuten und einem Tag.
* **Die Datenbanken lagen auf dem Bootmedium** und damit in keinem Backup. Das
  `apiservices`-Modul legt sie jetzt auf den Datenspeicher — siehe unten.

---

Der Rest dieses Dokuments beschreibt den Wiederaufbau. Er bleibt gültig: das
Dateisystem hat beim Ausfall Schaden genommen, auch wenn das Medium heil ist.

## Was sicher ist

* **Das RAID.** `md0` (RAID 1 aus `sda1` + `sdb1`) war beim Ausfall `[UU]`,
  fehlerfrei und ohne laufenden Resync. Die Nutzdaten sind nicht betroffen.
* **Der Code.** Alle Dienste liegen im Arbeitsverzeichnis — pi-home-stack samt
  Modulen und Templates, dazu die vier Flask-Dienste. Neu aufsetzen heißt
  installieren, nicht neu schreiben.
* **Profile, Quicklinks, Settings** — vor dem Abschalten über die noch laufende
  HTTP-API gesichert (`~/pinas-rescue/http-dump/`).

Unwiederbringlich ist nur, was ausschließlich auf der Karte lag.

## Phase 1 — Retten

1. Karte **nicht** mounten. Abbild ziehen:

   ```bash
   sudo ddrescue -n /dev/sdX sdcard.img sdcard.map     # schneller Durchgang
   sudo ddrescue -d -r3 /dev/sdX sdcard.img sdcard.map # Problemstellen nachfassen
   ```

2. Abbild schreibgeschützt einhängen und auswerten:

   ```bash
   sudo losetup -fP --read-only --show sdcard.img      # -> /dev/loopN
   sudo mount -o ro,noload /dev/loopNp2 /mnt/rescue
   tools/rescue-from-image.sh /mnt/rescue ~/pinas-rescue/system
   ```

   `noload` ist nicht optional: ext4 spielt beim Einhängen das Journal zurück,
   wenn das Dateisystem unsauber ist — und das ist ein *Schreib*vorgang. Auf einem
   schreibgeschützten Loop-Gerät scheitert er, und `mount` meldet dann
   irreführend, es könne „nicht im Lese-Schreib-Modus" einhängen.

   Der Preis: man sieht den Stand **vor** dem Journal-Rückspiel. Was unmittelbar
   vor dem Absturz geschrieben wurde, kann fehlen oder halb sein. Für das
   Herausholen der Dateien reicht das meist; wenn etwas fehlt, hilft Schritt 4.

4. Nur falls nötig — reparierte Variante. Das Original bleibt unangetastet,
   gearbeitet wird auf einer Kopie, damit Journal-Rückspiel und `fsck` erlaubt
   sind:

   ```bash
   cp --sparse=always sdcard.img sdcard-arbeit.img
   sudo losetup -fP --show sdcard-arbeit.img           # ohne --read-only
   sudo fsck.ext4 -fy /dev/loopNp2
   sudo mount /dev/loopNp2 /mnt/rescue
   ```

   Platzsparender geht es mit einem Overlay statt einer Vollkopie:
   `qemu-img create -f qcow2 -b sdcard.img -F raw overlay.qcow2` und dann
   `qemu-nbd` — braucht `qemu-utils` und das `nbd`-Modul.

5. Geborgene SQLite-Dateien prüfen, bevor man sie zurückspielt. Ein Abbild ohne
   Journal-Rückspiel kann eine Datenbank in einem Zwischenstand erwischen:

   ```bash
   sqlite3 tracking.db 'PRAGMA integrity_check;'   # erwartet: ok
   ```

   Das Skript holt Geheimnisse, Daten und Konfiguration in dieser Reihenfolge und
   benennt, was es **nicht** gefunden hat — bei einer defekten Karte ist die Lücke
   die eigentliche Information.

3. Auf dem RAID nach einem fertigen Config-Export suchen. Der liegt auf den
   Platten und ist unversehrt:

   ```bash
   find /media/nas -name 'pi-home-stack-config-*.tar.gz'
   ```

### Das eine, was wirklich weh tut

`/etc/pi-home-stack/secrets.kdbx` (beim `kdbx`-Backend) enthält den
**Backup-Schlüssel**. Ohne diese Datei und ihr Master-Passwort ist jedes
verschlüsselte Off-Site-Backup dauerhaft unlesbar — die Dateien liegen dann zwar
noch beim Anbieter, aber niemand kann sie je wieder entschlüsseln.

Beim `vault`-Backend ist die Lage besser: dort liegen die Geheimnisse auf dem
Vault-Server, der Pi hält nur eine widerrufbare AppRole in
`/etc/pi-home-stack/vault.env`.

Beides steht bewusst in **keinem** Config-Export — `export-config.sh` schließt
Schlüsselmaterial absichtlich aus. Es muss aus dem Abbild kommen.

## Phase 2 — Neu aufsetzen, diesmal auf M.2

**Nicht wieder auf SD-Karte.** Ein NAS schreibt dauernd Logs, Datenbanken und
Backup-Indizes; genau daran sterben SD-Karten.

### Vorher: welcher Pi?

| | |
| --- | --- |
| **Pi 5** | Hat einen PCIe-Anschluss. Mit einem M.2-HAT+ läuft eine **NVMe** direkt an PCIe — der gute Fall. |
| **Pi 4 und älter** | PCIe ist nicht herausgeführt. M.2 geht nur über ein **USB3-Gehäuse**. Funktioniert und ist immer noch um Längen besser als eine SD-Karte, aber über USB. |

**Der teure Irrtum beim Einkauf:** M.2 gibt es als **NVMe (M-Key)** und als
**SATA (B+M-Key)**. Die Pi-HATs nehmen ausschließlich NVMe. Eine M.2-SATA-SSD
passt teilweise sogar mechanisch und wird trotzdem nie erkannt. Vor dem Kauf
außerdem in die Kompatibilitätsliste des HAT-Herstellers schauen — nicht jede
NVMe läuft am Pi sauber.

### Pi 5 mit M.2-HAT

1. **Bootloader aktualisieren.** Ein zu alter EEPROM kennt NVMe als Bootquelle
   nicht:

   ```bash
   sudo rpi-eeprom-update -a && sudo reboot
   ```

2. **Bootreihenfolge setzen** — über `sudo raspi-config` →
   *Advanced Options* → *Boot Order* → *NVMe/USB Boot*.

   Von Hand ginge es über `BOOT_ORDER` in der EEPROM-Konfiguration: die Ziffern
   werden **von rechts nach links** abgearbeitet, `1` = SD, `4` = USB,
   `6` = NVMe, `f` = wieder von vorn. `raspi-config` schreibt den Wert korrekt,
   und ein Tippfehler an dieser Stelle macht den Pi vorübergehend unbootbar.

3. **System frisch aufspielen, nicht klonen.** Die alte Karte hat defekte
   Sektoren — ein Klon zieht sie mit. Raspberry Pi OS mit dem Imager direkt auf
   die NVMe schreiben (NVMe per USB-Adapter am PC, oder `rpi-imager` auf dem noch
   laufenden Pi). Die Wiederherstellung kommt danach aus Phase 3.

4. **Optional PCIe Gen 3** in `/boot/firmware/config.txt`:

   ```
   dtparam=pciex1_gen=3
   ```

   Zertifiziert ist Gen 2. Gen 3 läuft bei den meisten Laufwerken, ist aber nicht
   garantiert — bei Aussetzern wieder herausnehmen.

5. **Netzteil.** NVMe plus zwei Festplatten am selben Pi brauchen das offizielle
   27-W-USB-C-Netzteil. Unterspannung erzeugt genau die I/O-Fehler, die diesen
   Ausfall verursacht haben — es lohnt nicht, hier zu sparen.

### Wenn es doch eine SD-Karte wird

Eine **High-Endurance-Karte** (SanDisk Max Endurance, Samsung PRO Endurance) ist
deutlich haltbarer als eine normale — sie ist für Dauerschreiblast in Dashcams
gebaut. Zwei Einschränkungen muss man trotzdem kennen:

* Die Ausdauer ist für **große, fortlaufende Schreibvorgänge** ausgelegt. Ein
  Root-Dateisystem macht das Gegenteil: viele kleine, verstreute Schreibzugriffe
  durch Journal, SQLite und Logs. Die Stundenangabe auf der Packung sagt über
  diesen Fall wenig.
* **Kein SMART.** Eine SSD meldet ihren Verschleiß, eine SD-Karte nicht. Du
  bekommst keine Vorwarnung — genau das ist gerade passiert.

Beides lässt sich entschärfen, indem man die Schreiblast vom Bootmedium nimmt.
Danach ist eine Endurance-Karte eine vernünftige Wahl:

**1. Datenbanken aufs RAID.** Macht das `apiservices`-Modul von allein: es legt
`data/` als Symlink auf `<datenspeicher>/services/<dienst>`. Nebeneffekt, der
fast wichtiger ist — damit liegen sie im Backup, was vorher nicht der Fall war.

**2. Logs in den RAM.**

```bash
sudo apt install log2ram        # /var/log im RAM, schreibt stündlich weg
```

Dazu das Journal deckeln, aber **nicht** auf `volatile` stellen — ohne
persistente Logs wäre der Ausfall von heute kaum zu diagnostizieren gewesen:

```ini
# /etc/systemd/journald.conf
[Journal]
SystemMaxUse=64M
Compress=yes
```

**3. Swap ohne Karte.** `dphys-swapfile` schreibt auf das Bootmedium. zram nimmt
stattdessen komprimierten Arbeitsspeicher und fasst die Karte nie an:

```bash
sudo dphys-swapfile swapoff && sudo systemctl disable dphys-swapfile
sudo apt install zram-tools
```

**4. Pi-hole-Abfragelog.** FTL schreibt jede DNS-Anfrage mit — auf einem Netz mit
vielen Geräten der größte Einzelschreiber. Entweder auf das RAID legen oder die
Langzeitstatistik verkürzen, in `/etc/pihole/pihole-FTL.conf`:

```ini
DBFILE=/media/nas/data/services/pihole/pihole-FTL.db
MAXDBDAYS=7
```

**5. `noatime`** für das Root-Dateisystem in `/etc/fstab` — spart einen
Schreibzugriff pro Lesezugriff.

Mit 1–4 schreibt das System im Normalbetrieb fast nichts mehr auf die Karte.

**Zwischenweg, falls M.2 am HAT-Preis scheitert:** eine gewöhnliche 2,5"-SATA-SSD
in einem USB3-Gehäuse ist meist deutlich billiger als NVMe plus HAT, liefert SMART
und ist der SD-Karte in Haltbarkeit und wahlfreiem Zugriff weit überlegen. Der Pi
bootet davon genauso über `raspi-config` → Boot Order → USB.

### Pi 4 über USB3

Gehäuse mit **UASP**-Unterstützung wählen (JMicron- oder ASMedia-Chipsatz);
billige Adapter ohne UASP sind spürbar langsamer und manche brauchen
`usb-storage.quirks`. Bootreihenfolge ebenfalls über `raspi-config` auf USB.

### Danach

```bash
lsblk                       # bootet er wirklich von nvme0n1 bzw. sda?
findmnt /                   # und liegt / dort?
```

Die SD-Karte **draußen lassen** — je nach Bootreihenfolge startet er sonst wieder
von ihr. Die beiden RAID-Platten bleiben, wo sie sind; es zieht nur das
Betriebssystem um.

### Vor dem ersten Start: CQE abschalten

Ein frisches Raspberry Pi OS bringt heute einen 6.12er-Kernel mit — also genau
den, an dem der Ausfall hing. Ob die **neue** Karte dieselbe Schwäche hat, weiß
man vorher nicht; sie steht genauso wenig auf der Sperrliste des Kernels wie die
alte. Der Parameter kostet etwas SD-Durchsatz und ist billiger als ein zweiter
Ausfall, also gleich mit auf die Karte, bevor der Pi das erste Mal bootet:

```bash
# Karte am PC, Bootpartition gemountet
printf '\n[all]\ndtparam=sd_cqe=off\n' | sudo tee -a /mnt/boot-neu/config.txt
```

Der Abschnitt `[all]` muss mit, weil eine `config.txt` bedingte Abschnitte hat —
angehängt ohne ihn landet die Zeile in dem Abschnitt, der zufällig zuletzt steht,
und wird dann je nach Modell nie angewendet.

Läuft alles stabil, kann man den Parameter später zum Test wieder entfernen.

### Migration statt Wiederherstellung

Der alte Pi war **handgebaut** — eigene Units (`tracking-persistence`,
`backup-persistence`, `flask-server`), keine Spur von `/etc/pi-home-stack`. Der
neue bekommt den Installer. Das ist eine Migration, und drei Dinge müssen dabei
zusammenpassen:

**1. Mountpoint `/media/raid` beibehalten.** Beim `storage`-Modul das vorhandene
Array übernehmen *und* `/media/raid` als Mountpoint angeben — nicht die Vorgabe
`/media/nas`. Daran hängen die SMB-Freigabe `[shared]`, die Pfade der drei
Dienste, die schon auf dem Array liegen, und deren Unit-Dateien. Ein anderer
Mountpoint bedeutet, das alles umzubiegen.

Die fstab-Zeile aus dem Abbild nennt die UUID des Arrays:

```
UUID=c0caf833-09ec-479f-b492-89ca472580e4  /media/raid  ext4  nofail,usrquota,grpquota  0  0
```

Die Quota-Optionen gehen beim Installer verloren, der schreibt
`defaults,noatime,nofail`. Falls du Quotas brauchst, danach wieder ergänzen.

**2. Das Dienste-Layout bleibt, wie es ist.** `apiservices` steuert
`<datenspeicher>/services/<dienstverzeichnis>/data` an — genau die Pfade, die auf
dem Array schon existieren:

| Dienst | Lag vorher | Modul findet |
| --- | --- | --- |
| quickaction | `/media/raid/services/quickaction_persistence_service/data` | dieselbe Stelle |
| study | `/media/raid/services/study_persistence_service/data` | dieselbe Stelle |
| tracking | `/home/jesch/tracking_persistence_service/data` (Karte) | zieht auf das Array |
| home | existierte noch nicht | wird angelegt |

Es wird also nichts verschoben, was schon richtig liegt. Nur `tracking` zieht vom
Bootmedium auf das Array — und ist damit erstmals im Backup.

**3. Das Backup wandert mit, es wird nicht neu aufgebaut.**
`pinas_s3_backup` ist das Upstream des `backup`-Moduls;
`tools/sync-backup-service.py` patcht beim Einpflegen genau eine Sache: der
Schlüssel kommt aus einer root-only-Datei statt direkt aus KeePass. `filecrypt.py`
und `schema.sql` sind **identisch**. Konkret heißt das:

* der bestehende Chiffretext beim Anbieter bleibt entschlüsselbar,
* der bestehende Index (`backup.db`) ist direkt weiterverwendbar,
* es muss **nichts neu hochgeladen** werden.

Nötig ist nur, den Backup-Schlüssel aus deiner kdbx in den Secrets-Store des
Stacks zu übernehmen und `backup.db` zurückzuspielen. Ohne den Index hielte der
erste Lauf den gesamten Bestand für neu.

### Dann

```bash
git clone <repo> pi-home-stack && cd pi-home-stack
sudo ./install.sh --features storage,samba,pihole,nginx,backup,backupui,netmonitor,maintenance,apiservices
```

Beim `maintenance`-Modul den automatischen Reboot auf **nein** setzen.

Beim Punkt *Datenspeicher* das **vorhandene RAID übernehmen** wählen — das Modul
bietet gefundene Arrays an und fragt, ob das Dateisystem einfach eingehängt werden
soll. Es formatiert nichts, was es nicht ausdrücklich bestätigt bekommen hat.

Nebeneffekt: der Installer schreibt den fstab-Eintrag **per UUID** und trägt das
Array in `/etc/mdadm/mdadm.conf` ein. Damit ist auch die Ursache der
`md127`-Fehlermeldung von vorher behoben — ohne diesen Eintrag bekommt ein Array
beim Zusammenbau eine automatische Nummer von 127 abwärts und wandert nach einem
Upgrade.

## Phase 3 — Zurückspielen

### Was auf keinen Fall zurückgespielt wird

Die naheliegende Idee, `/etc` und `/boot/firmware` aus dem Abbild zu übernehmen,
führt zu einem System, das nicht mehr startet. Diese Dateien gehören zur **alten
Installation**, nicht zu den Daten:

| Datei | Warum nicht |
| --- | --- |
| `/boot/firmware/config.txt` | Gehört zum alten Kernel und zur alten Firmware. Enthält womöglich Overlays, die der neue Kernel anders oder nicht mehr kennt. Einzelne Zeilen übernehmen, nie die Datei. |
| `/boot/firmware/cmdline.txt` | Enthält die `PARTUUID` der **alten** Karte. Zurückgespielt sucht der neue Pi eine Rootpartition, die es nicht gibt. |
| `/etc/fstab` | Dasselbe Problem für `/` und `/boot/firmware`. Nur die RAID-Zeile übernehmen — die steht per UUID drin und bleibt gültig, weil das Array unverändert ist. |
| `/etc/passwd`, `/etc/shadow`, `/etc/group` | Benutzer im Installer neu anlegen. Zurückspielen bringt inkonsistente UIDs und kann die Anmeldung unmöglich machen. |
| `/etc/nginx/*` | Schreibt der Installer selbst, passend zu den tatsächlich installierten Modulen. Eine alte Konfiguration verweist auf Dienste, die noch nicht da sind, und dann startet nginx nicht. |

Optional, aber angenehm: `/etc/ssh/ssh_host_*` übernehmen. Dann meckert kein
Client über einen geänderten Hostkey.

### Was zurückgespielt wird

In dieser Reihenfolge, jeweils vor dem Start des zugehörigen Dienstes:

| Was | Wohin |
| --- | --- |
| `secrets.kdbx` / `vault.env` / `secrets/` | `/etc/pi-home-stack/` |
| `stack.env` | `/etc/pi-home-stack/` — danach `install.sh` erneut, es übernimmt die Antworten |
| `passdb.tdb` | `/var/lib/samba/private/` (sonst neue SMB-Passwörter setzen) |
| `backup.db` | `/opt/pi-home-stack/backup/data/` — ohne den Index lädt der nächste Lauf alles neu hoch |
| `tracking.db`, `quickaction/data` | in die jeweiligen Dienstverzeichnisse |
| `grafana.db` | `/var/lib/grafana/` |
| `etc/pihole`, `etc/dnsmasq.d` | zurück nach `/etc/` |

Beschädigte SQLite-Dateien aus dem Abbild lassen sich meist noch retten:

```bash
sqlite3 tracking.db ".recover" | sqlite3 tracking-repariert.db
```

## Was der Installer abdeckt — und was nicht

Erhoben aus den Unit-Dateien und der Paketliste des Abbilds — nicht geraten:

| Lief auf dem alten Pi | Port | Status im Stack |
| --- | --- | --- |
| RAID auf `/media/raid` | — | `storage` ✅ |
| SMB `[shared]` → `/media/raid` | — | `samba` ✅ |
| Pi-hole + lighttpd | — | `pihole` ✅ |
| nginx | 80 | `nginx` ✅ |
| `backup-persistence` (`pinas_s3_backup`) | 5003 | `backup`, `backupui` ✅ — **gleiche Codebasis, Index wandert mit** |
| `quickaction-persistence` | 5001 | `apiservices` ✅ neu |
| `tracking-persistence` | 5002 | `apiservices` ✅ neu |
| `study-persistence` | 5004 | `apiservices` ✅ neu |
| `flask-server` (eigener Speedtest) | 5000 | `netmonitor` ⚠️ siehe unten |
| Vault (**Debian-Paket**, `/etc/vault.d/vault.hcl`) | 8200 | **fehlt** |
| Grafana (kein Paket → Container) | 3000 | **fehlt** |
| React-Dashboard | 80 | **fehlt** — `air-qual-dashboard` |
| SurrealDB | — | **fehlt** |
| GitHub-Runner, GitLab-Runner | — | bewusst **kein** Modul, siehe unten |
| — (neu) | 5005 | `apiservices` → Wohnung (Hue/yeedi) |

**Zum Speedtest:** `netmonitor` ist die Entsprechung im Stack, bringt aber seine
eigene Datenbank mit. Deine Messhistorie liegt in
`/media/raid/services/speedtest/` und wäre danach verwaist — sie ist nicht
verloren, aber auch nicht in der neuen Oberfläche. Wer die Reihe fortführen will,
behält besser `flask-server` und lässt `netmonitor` weg.

**Zu den CI-Runnern:** GitHub- und GitLab-Runner gehören nicht in einen
Home-Stack — das sind Arbeitsmittel mit eigenen Registrierungs-Token und eigenem
Lebenszyklus. Dafür baue ich kein Modul. Ihre Unit-Dateien und
Konfigurationsverzeichnisse kommen aus dem Abbild zurück; die Token sind
widerrufbar und notfalls neu auszustellen.

Die vier Flask-Dienste sind untereinander baugleich — eigenes Verzeichnis, venv,
systemd-Unit, nginx-`location`, SQLite oder JSON unter `data/`. Deshalb ein
gemeinsames Modul statt vier fast identischer.
