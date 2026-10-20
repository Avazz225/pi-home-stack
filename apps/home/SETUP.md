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

## Shelly BLU (Heizung)

Heizkörperventile (BLU TRV) hängen per Bluetooth an einem BLU Gateway Gen3, das
im LAN unter einer festen Adresse erreichbar sein muss — im Router reservieren,
sonst zeigt die Zuordnung irgendwann ins Leere. Gekoppelt werden die Ventile in
der Shelly-App; hier werden sie nur Räumen zugeordnet.

Unter *Einstellungen → Shelly BLU* die Adresse eintragen und verbinden. Der
Dienst prüft das Gateway, bevor er die Adresse speichert, damit ein Tippfehler
nicht später als „keine Ventile“ erscheint.

Zwei Wege zum Ventil, und der Unterschied entscheidet über die Batterielaufzeit:

| Aufruf | Was es kostet |
| --- | --- |
| `BluTrv.GetRemoteStatus` | nichts — ein Schnappschuss, den das Gateway aus den Broadcasts des Ventils ohnehin hält. Er trägt seinen Zeitstempel, das Alter ist also sichtbar |
| `BluTrv.Call` | eine echte Bluetooth-Verbindung zum Ventil. Nötig zum Setzen, und es kostet Energie an einem Gerät mit zwei AA-Zellen |

`shelly.py` liest deshalb nur aus dem Cache und verbindet ausschließlich zum
Schreiben. Ein Polling über `BluTrv.Call` würde funktionieren und die Zellen
leeren.

Mehrere Ventile dürfen in denselben Raum: zwei Heizkörper unter einem Fenster
sind ein Raum mit einem Wunsch. Die Temperatur ist dann das Mittel der Messwerte,
der Sollwert der niedrigste und das Alter das älteste — die vorsichtige Lesart.

### Wandfühler (BLU H&T)

Ein H&T wird wie ein Ventil einem Raum zugeordnet, Gerätesorte `shelly_ht`. Die
Kennung ist dabei die **MAC-Adresse**, nicht die Gateway-ID wie beim Ventil: ein
Ventil wird über seine ID per RPC angesprochen, ein Fühler nur gelesen, und die
MAC übersteht ein erneutes Koppeln.

Wo ein Fühler im Raum liegt, kommt die Raumtemperatur von ihm und nicht vom
Ventilkopf. Der Kopf sitzt in der Fensternische auf einem meist kalten
Heizkörper und liest systematisch zu niedrig — gemessen 1,1 bis 3,0 K unter dem
Fühler zwei Meter weiter. Welcher Wert woher kommt, steht in
`climate.temperature_source` (`sensor` oder `valve`), und die Kopftemperatur
bleibt als `head_temperature` daneben erhalten.

Dass das Ventil selbst auf den Wandfühler *regelt*, ist eine zweite Sache. Dafür
muss die Zuordnung im Gateway stehen (`blutrv.temp_sensors`), und die ist nur in
der Shelly-App zu setzen: `BluTrv.SetConfig` quittiert das Feld mit
`restart_required: false` und verwirft es — in vier Formen probiert. Gelesen wird
sie als `temp_sensors` je Ventil.

Fensterstatus bleibt leer, dafür braucht es einen BLU-Tür/Fenster-Sensor.

### Darstellung

`home_setting.home_layout` hält als JSON, in welcher Reihenfolge die Blöcke des
Raumpanels und die Kacheln im Klima-Block stehen und was ausgeblendet ist. Es
wird mit `/overview` ausgeliefert, damit das Panel beim ersten Zeichnen schon
richtig sortiert ist.

Die Anordnung gehört einem **Benutzer**, alles andere der Wohnung. `home_setting`
hält, was die Wohnung angeht — Wandstärken, Hue-Schlüssel, Gateway-Adresse —,
`user_setting` hält je Benutzer das, was nur ihn betrifft. Bewusst zwei
Tabellen und keine Benutzerspalte an der ersten: hier ist fast alles geteilt,
und eine Spalte lädt dazu ein, das nächste geteilte Ding versehentlich
persönlich zu machen.

Der Benutzer ist hier **optional**, anders als bei ToDo, Tracking und
Modulplanung. Dort gehört alles jemandem, ohne Benutzer gibt es also nichts.
Hier gehört fast nichts jemandem: Grundriss, Ventile und Lampen sind die der
Wohnung und müssen auch auf einem Wandtablet funktionieren, an dem sich nie
jemand angemeldet hat. Fehlt der Benutzer, gilt die Anordnung der Wohnung —
und genau darüber erbt jeder die bisherige globale Anordnung, ohne dass etwas
übernommen werden müsste. Gespeichert wird ohne Benutzer nicht; der Dienst
antwortet mit 400, statt die Anordnung zu jedermanns zu machen.

Gespeicherte Reihenfolgen werden **zusammengeführt, nicht geglaubt**: was der
Eintrag nicht kennt, wird hinten angehängt, was es nicht mehr gibt, fällt weg.
Ohne das würde ein Block, der in einer späteren Version dazukommt, bei jedem nie
erscheinen, der die Darstellung einmal angepasst hat.

Was es nicht gibt, wird nie gezeigt — unabhängig von der Reihenfolge. Ein Raum
ohne Ventil hat keinen Klima-Block, ein Haushalt ohne Saugroboter keinen
Staubsauger-Reiter. Dafür liefert `/overview` je Teilsystem ein `configured`.

Ein BLU TRV sendet nur alle paar Minuten, solange sich nichts ändert. Ein
Messwert von vor zwei Minuten ist deshalb normal; die Oberfläche zeigt das Alter
und wird ab zehn Minuten deutlich.

### Heizpläne liegen im Gateway

Der Plan läuft **nicht** auf dem Pi. Ein Timer hier hieße, dass die Heizung ihrem
Plan nur folgt, solange der Pi läuft — und der eine Morgen, auf den es ankommt,
ist der nach dem Morgen, an dem er nicht hochkam. Das Gateway hat Strom, es ist
der Bluetooth-Master, und es hat einen Scheduler.

Diese Datenbank bleibt die Quelle, das Gateway ist ihr Abbild. Gespiegelt wird
bei jeder Änderung an einem Zeitplan, an einer Ventilzuordnung und beim
Verbinden; `POST /shelly/schedules/sync` zieht von Hand nach. Aufträge, die
dieser Dienst nicht angelegt hat, werden nie angefasst — die IDs der eigenen
stehen in `home_setting.shelly_managed_jobs`. Umgekehrt heißt das: was in der
Shelly-App an *unseren* Aufträgen geändert wird, ist beim nächsten Abgleich weg.

Gruppiert wird nach Zeitpunkt, nicht nach Raum: „werktags 6:30" ist **ein**
Auftrag, zu dem jeder betroffene Raum seinen eigenen Aufruf beiträgt. Das liegt
an zwei Grenzen der Firmware, beide gemessen und nicht aus der Dokumentation
übernommen:

| Grenze | Wert | Fehlermeldung des Gateways |
| --- | --- | --- |
| Aufträge | 20 | `Reached the maximum 20 of jobs` |
| Aufrufe je Auftrag | 5 | `Invalid argument 'calls': Failed validation!` |

Ein Auftrag pro Raum wäre bei sieben Räumen mit drei Einträgen schon am Limit; so
zählt nur die Zahl *verschiedener Zeiten*, und davon hat ein Tag eine Handvoll.
Mehr als fünf Ventile zu einem Zeitpunkt werden auf mehrere Aufträge verteilt.

Die Wochentage brauchen keine Umrechnung: das Gateway liest `1` als Montag und
sowohl `0` als auch `7` als Sonntag, die ISO-Nummerierung in der Spalte passt
also unverändert. Der Zeitstempel ist `0 MM HH * * <Tage>` — sechs Felder,
Sekunden zuerst.

Ein Raum mit Plan aber ohne Ventil trägt nichts bei. Das ist kein Fehler, nur
noch kein Heizkörper — die Oberfläche sagt es im Raumpanel.

## Szenen

Eine Szene schaltet bestimmte Lampen in einen Zustand — Helligkeit, Farbe oder
Farbtemperatur — und beendet ihn nach einer festgelegten Zeit, wahlweise mit
Ausdimmen zum Schluss. Mehrere Szenen liegen als Kacheln über dem Grundriss.

Das Ende ist die eigentliche Schwierigkeit. Lampen einschalten ist ein Aufruf;
sie in vierzig Minuten auszuschalten heißt, dass in vierzig Minuten noch etwas
da sein muss. Drei Wege, und die Wahl zählt:

| | |
| --- | --- |
| Timer in der Anfrage | stirbt mit dem Worker, der die Anfrage bedient hat |
| Thread, der den Zustand hält | stirbt mit dem Dienst — und jedes Update startet ihn neu |
| **Zeile, die den Endzeitpunkt nennt** | übersteht beides |

Eine gestartete Szene ist deshalb eine Zeile in `scene_run`. Ein Thread sieht
alle 2 s nach; ein Lauf, dessen Ende beim Neustart schon vorbei war, wird beim
ersten Durchgang beendet, statt weiterzubrennen.

Das Ausdimmen macht die **Bridge**. Hue bekommt einen Übergang genannt und führt
ihn selbst aus — ein Aufruf statt hunderter, und er läuft weiter, wenn der Pi es
nicht tut. Nur ein Übergang, der länger ist als die Bridge auf einmal annimmt
(`MAX_TRANSITION_MS`), wird in Stücken nachgereicht. Gedimmt wird auf 1 %, nicht
auf 0: Hue liest 0 % als „aus", und einen Moment zu früh dunkel zu werden ist
genau das, was das Ausdimmen vermeiden soll.

Farben werden **einmal** umgerechnet, im Dienst: die Oberfläche schickt
`#rrggbb`, `hue.rgb_to_xy` macht daraus den CIE-xy-Punkt. Zwei Umsetzungen eines
Farbraums driften auseinander, und die Drift sieht aus wie eine falsche Lampe.

Szenen gehören der Wohnung, nicht einer Person — so wie die Lampen, die sie
schalten.

## Datenmodell

| Tabelle | Zweck |
| --- | --- |
| `room` | Raum mit Fläche und manueller Soll-Temperatur; `key` verbindet mit der Geometrie im Frontend |
| `room_device` | Was in welchem Raum hängt. `external_id` ist die Kennung des jeweiligen Herstellers — Hue-Ressourcen-ID, Shelly-Adresse, yeedi-Kartenraum |
| `heating_schedule` | „um X Uhr will ich Y Grad“, je Raum, mit Wochentagen |
| `home_setting` | Key/Value: Bridge-IP, Hue-Key, yeedi-Zugang, BLU-Gateway-Adresse und -Passwort |

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
| POST | `/shelly/connect` · DELETE `/shelly` | BLU-Gateway verbinden (prüft vor dem Speichern) bzw. vergessen |
| GET | `/shelly/trvs` | Alle gekoppelten Ventile mit Soll, Ist, Ventilstellung, Batterie und Alter des Messwerts |
| POST | `/trvs/<id>/target` | Sollwert eines einzelnen Ventils — baut eine Bluetooth-Verbindung auf |
| POST | `/rooms/<id>/target_temp` | Wunsch des Raums speichern **und** an alle Ventile darin schicken; ein Ventil ausser Reichweite wird gemeldet, nicht verschwiegen |
| GET | `/shelly/schedules` | Was im Gateway liegt, was dort liegen sollte, und wie viele Aufträge fremd sind |
| POST | `/shelly/schedules/sync` | Spiegelung von Hand nachziehen; passiert sonst bei jeder Änderung automatisch |
| POST | `/rooms/<id>/schedules` · PUT/DELETE `/schedules/<id>` | Heizplan |
| GET/PUT | `/settings` | Zugangsdaten; Geheimnisse werden nie zurückgegeben |
