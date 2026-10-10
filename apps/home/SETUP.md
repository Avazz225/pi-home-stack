# Setup auf dem Pi

```bash
# 1. Dateien auf den Pi kopieren (venv NICHT mitkopieren, siehe Hinweis unten)
scp -r home_persistence_service pi@PI-ADRESSE:~/

# 2. Python 3.14 bereitstellen (siehe Abschnitt "Python-Version" unten).
#    Raspberry Pi OS bringt derzeit 3.11 mit, deebot-client verlangt aber 3.14.
cd ~/home_persistence_service
./install-python314.sh

# 3. Virtualenv auf dem Pi NEU anlegen (venv ist nicht architekturportabel,
#    ein vom Dev-Rechner kopiertes venv führt zu "status=203/EXEC")
rm -rf venv
~/.local/opt/python-3.14.8/bin/python3.14 -m venv venv
venv/bin/pip install -r requirements.txt

# 4. Systemd-Service einrichten
sudo cp home-persistence.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable home-persistence
sudo systemctl start home-persistence

# 5. Nginx konfigurieren
# Inhalt von nginx.conf.snippet in den bestehenden server-Block einfügen, dann:
sudo nginx -t && sudo systemctl reload nginx
```

## Python-Version

`deebot-client` verlangt ab Version 18 **Python 3.14 oder neuer**. Raspberry Pi OS
liefert aktuell 3.11. Die letzte deebot-client-Version mit 3.11 wäre **6.0.2** —
zwölf Major-Versionen alt, mit anderer API und einer deutlich kleineren
Geräte-Registry. Gerade für den Vac 2 Pro, der ohnehin am Rand der Unterstützung
liegt, ist Zurückgehen der schlechtere Tausch.

`./install-python314.sh` legt deshalb ein zweites Python daneben:

* lädt ein fertiges Binary von
  [python-build-standalone](https://github.com/astral-sh/python-build-standalone)
  — dasselbe, das auch `uv python install` verwendet. Kein Kompilieren, keine
  Build-Abhängigkeiten, ~30 MB Download statt einer knappen Stunde Übersetzerlauf;
* prüft den Download gegen eine im Skript hinterlegte SHA256-Summe;
* installiert nach `~/.local/opt/python-3.14.8`. **Kein sudo, kein Eingriff ins
  System** — `python3` bleibt unverändert 3.11, und alles andere auf dem Pi merkt
  nichts davon. Deinstallieren heißt: Verzeichnis löschen;
* erkennt aarch64 (64-Bit-Pi OS) und armv7l (32-Bit). Für armv6l — Pi Zero und
  Pi 1 — gibt es kein Standalone-Build, dort bliebe nur Selbstkompilieren.

Ein zweiter Lauf erkennt die vorhandene Installation und tut nichts.

Alternativ geht auch `uv python install 3.14`, falls `uv` ohnehin auf dem Pi ist —
es lädt exakt dieselben Binaries.

**Wenn es bei 3.11 bleiben soll:** der Dienst startet trotzdem. `deebot-client`
wird erst beim Verbindungsaufbau importiert, Hue, Räume und Heizplan laufen also
normal weiter; nur der Staubsauger meldet beim Verbinden einen Hinweis auf die
fehlende Bibliothek. `pip install -r requirements.txt` schlägt dann allerdings
fehl — in dem Fall die beiden letzten Zeilen der `requirements.txt` auslassen.

Der Service läuft auf Port 5005 und ist über `/home-api/` erreichbar.
Daten liegen in `~/home_persistence_service/data/home.db` (SQLite).

## Erstbefüllung

Beim ersten Start werden die Räume aus `seed.json` angelegt — mitgeliefert ist
ein Beispielgrundriss, eine erfundene Dreizimmerwohnung. Der Import läuft nur in
eine leere Datenbank, ändere `seed.json` also vorher oder lege die Räume danach
in der Oberfläche an.

Die **Geometrie** der Räume steht bewusst nicht in der Datenbank, sondern im
Frontend unter `src/home/floorplan/shapes.js`, verschlüsselt über `room.key`. Ein
Raum ohne Eintrag dort erscheint nicht auf dem Grundriss, bleibt aber in allen
Listen bedienbar. Wer umzieht, tauscht eine Datei und die Seed-Räume.

## Hue

Lokal über die CLIP-v2-API, kein Hue-Konto nötig.

1. Tab „Einstellungen“ → „Bridges suchen“ (fragt `discovery.meethue.com`, was
   diese WAN-Adresse an Bridges kennt) oder IP von Hand eintragen.
2. Den runden Knopf auf der Bridge drücken, **danach** innerhalb von ~30 Sekunden
   „Koppeln“. Vorher antwortet die Bridge mit `link button not pressed`, was die
   Oberfläche als Hinweis anzeigt.
3. „Aus Hue-Räumen übernehmen“ ordnet Lampen automatisch zu, wenn der Hue-Raum
   genauso heißt wie ein Raum hier. Der Rest geht per Auswahlfeld.

Die Bridge liefert ein selbstsigniertes Zertifikat auf ihre eigene Bridge-ID, das
keinem Trust Store bekannt ist — die Prüfung ist daher aus. Das ist bei lokalem
Hue unvermeidbar und auch das, was die offiziellen Apps tun.

## yeedi / Ecovacs

**Es gibt keine offizielle Schnittstelle.** Der Zugriff läuft über die
Ecovacs-Cloud und `deebot-client`, eine nachgebaute Protokollbibliothek. yeedi
wird dort „best effort“ unterstützt; ein Firmware- oder Serverupdate kann das
jederzeit brechen.

In den Einstellungen Konto, Passwort und Land eintragen. Das Passwort wird nur als
MD5-Hash abgelegt, weil die Anmeldung genau den verlangt — es wird nicht im
Klartext gespeichert und nie über die API zurückgegeben.

Meldet der Dienst „Kein unterstützter Saugroboter im Konto gefunden“, ist die
Geräteklasse der Bibliothek unbekannt. Die Klasse steht dann in der Meldung; mit
einem **Ersatzprofil** (eines der bekannten yeedi-Modelle) lässt sich das Gerät
trotzdem ansprechen. Ob der Vac 2 Pro ein eigenes Profil hat, zeigt erst der
Verbindungsversuch — die Bibliothek nennt ihn nicht namentlich.

Raumweises Saugen braucht die Karte des Roboters: sobald er seine Raumliste
gemeldet hat, erscheint sie in den Einstellungen und kann auf die Räume hier
gelegt werden. Erst dann funktioniert „Ausgewählte saugen“.

## Shelly

Noch kein Adapter. Datenmodell (`shelly_climate`, `shelly_window`), Soll-Temperatur
und Heizplan sind da und funktionieren; die Messwerte bleiben leer, bis Geräte
angebunden sind.

## Datenmodell

| Tabelle | Zweck |
| --- | --- |
| `room` | Raum mit Fläche und manueller Soll-Temperatur; `key` verbindet mit der Geometrie im Frontend |
| `room_device` | Was in welchem Raum hängt. `external_id` ist die Kennung des jeweiligen Herstellers — Hue-Ressourcen-ID, Shelly-Adresse, yeedi-Kartenraum |
| `heating_schedule` | „um X Uhr will ich Y Grad“, je Raum, mit Wochentagen |
| `home_setting` | Key/Value: Bridge-IP, Hue-Key, yeedi-Zugang |

Ein Heizplan-Eintrag gilt bis zum nächsten. Die Auswertung geht deshalb bis zu
sieben Tage zurück und nicht nur bis Mitternacht — sonst hätte man nachts um zwei
keinen Sollwert.

## Endpunkte

| Methode | Pfad | Beschreibung |
| --- | --- | --- |
| GET | `/overview` | Räume inkl. Geräten, Lampenzustand, Heizplan und Saugroboter-Status |
| GET/POST | `/rooms` · PUT/DELETE `/rooms/<id>` | Räume pflegen |
| POST | `/rooms/<id>/devices` · DELETE `/devices/<id>` | Gerät an einen Raum binden/lösen |
| POST | `/lights/<id>` · `/rooms/<id>/lights` | Einzelne Lampe bzw. alle Lampen eines Raums schalten |
| GET | `/hue/discover` · `/hue/lights` | Bridges suchen, Lampen und Hue-Räume lesen |
| POST | `/hue/pair` · `/hue/automap` · DELETE `/hue` | Koppeln, automatisch zuordnen, entkoppeln |
| GET | `/vacuum/status` | Verbindung, Zustand, Akku, Kartenräume |
| POST | `/vacuum/connect` · `/vacuum/disconnect` | Cloud-Verbindung auf/zu |
| POST | `/vacuum/clean` | `{"all": true}` oder `{"room_ids": [...]}` (Räume dieses Dienstes) |
| POST | `/vacuum/control` · `/vacuum/fan-speed` | start/pause/resume/stop/home, Saugstufe |
| POST | `/rooms/<id>/schedules` · PUT/DELETE `/schedules/<id>` | Heizplan |
| GET/PUT | `/settings` | Zugangsdaten; Geheimnisse werden nie zurückgegeben |
