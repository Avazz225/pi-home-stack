# Benachrichtigungen

Regeln, die jemand sich gewünscht hat, werden auf einem Takt geprüft und ihm
gemeldet. Ein eigener Dienst, weil die Dinge, über die es sich zu reden lohnt,
auf drei Quellen verteilt sind — und das Gemeinsame daran ist die **Person**,
die davon hören will. Regeln an einer Stelle, der Empfänger daneben; die
Quellen müssen nur beantworten, was sie ohnehin beantworten.

Der Dienst **liest** nur und schreibt nirgends hinein. Damit bleibt die
Abhängigkeit einseitig: fällt er aus, kostet das die Glocke und sonst nichts.

## Quellen

| Quelle | Woher | Wofür |
| --- | --- | --- |
| Wohnung | `http://127.0.0.1:5005/overview` | Licht, Temperatur, Luftfeuchte, Batterien |
| System | `/var/www/pi-home/status.json` | Dienste, Platten, RAID, Sicherung |
| Upstream | GitHub-Releases-API | neue Version dieses Stacks |

Geholt wird nur, was die **aktiven** Regeln brauchen. Eine Wohnung ohne
Wohnungsregeln lässt den Wohnungsdienst in Ruhe.

## „Seit drei Stunden"

Aus einer Momentaufnahme nicht zu beantworten: Hue weiß, dass eine Lampe an
ist, nicht seit wann, und niemand sonst merkt es sich. Deshalb schreibt jeder
Durchgang in `observation`, was er gesehen hat — und der Zeitstempel wandert
**nur, wenn sich der Wert ändert**. Das Alter eines Zustands ist dann eine
Subtraktion.

## Wartezeit

Jede Regel hat eine, voreingestellt eine Stunde. Ohne sie erzeugt eine
vergessene Lampe eine Meldung pro Minute, bis jemand sie ausschaltet — und das
bringt Leute dazu, die Glocke zu ignorieren.

## Kanäle

Die Glocke im Dashboard gibt es immer. Zusätzlich ein **generischer Webhook**
statt einer Anbindung je Anbieter: ntfy, Gotify, Home Assistant und Discord
nehmen alle einen POST entgegen, und was sich unterscheidet, ist die Form des
Rumpfes. Dafür gibt es eine Vorlage mit `{{title}}`, `{{body}}`, `{{level}}`
und `{{link}}`.

## Regelarten

Eine Art ist eine Funktion in `rules.py` plus ein Eintrag in `KINDS`. Sie
beschreibt dort selbst, welche Einstellungen sie braucht — die Oberfläche baut
das Formular daraus, eine neue Art erscheint also von allein.

| Art | Einstellung |
| --- | --- |
| Licht brennt zu lange | Raum, Minuten |
| Luftfeuchte über / unter | Raum, Prozent |
| Temperatur über / unter | Raum, Grad |
| Batterie schwach | Prozent |
| Dienst steht | — |
| Datenspeicher voll | Prozent |
| RAID beschädigt | — |
| Sicherung fehlgeschlagen | — |
| Neue Version verfügbar | — |

Die Versionsprüfung vergleicht gegen die Datei `VERSION` im installierten
Stand. Ist sie nicht da, wird **nichts** behauptet: eine Meldung, dass es eine
Version gibt, ohne zu wissen, ob es die laufende ist, wäre Lärm.

## Endpunkte

| Methode | Pfad | Beschreibung |
| --- | --- | --- |
| GET | `/kinds` | Katalog der Regelarten samt benötigter Einstellungen |
| GET/POST | `/rules` · PUT/DELETE `/rules/<id>` | Regeln dieses Benutzers |
| POST | `/rules/check` | sofort prüfen, statt auf die nächste Minute zu warten |
| GET | `/notifications` | Meldungen und Anzahl ungelesener |
| POST | `/notifications/read` | eine oder alle als gelesen markieren |
| DELETE | `/notifications` | gelesene entfernen |
| GET/POST | `/channels` · DELETE `/channels/<id>` | Zustellwege |
| POST | `/channels/<id>/test` | Testnachricht |
| GET | `/version` | installierte und oberste Version |

Alles außer `/kinds` und `/version` verlangt `X-Home-User`.
