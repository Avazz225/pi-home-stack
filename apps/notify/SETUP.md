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

Die Glocke im Dashboard gibt es immer. Darüber hinaus drei Wege:

| Art | Wofür |
| --- | --- |
| `ntfy` | **Push aufs Handy.** App installieren, Thema abonnieren, Themen-Adresse eintragen |
| `gotify` | selbst gehosteter Push-Server mit eigener Android-App |
| `webhook` | alles andere, was einen POST annimmt — Home Assistant, Discord, eigene Skripte |

### Push aufs Handy mit ntfy

Der kürzeste Weg. Entweder über `ntfy.sh` — dann laufen die Meldungen über
einen fremden Server — oder über eine **eigene Instanz**, dann verlässt nichts
das Netz:

```bash
sudo apt install ntfy        # oder als Container
# Themen-Adresse dann z. B. http://pinas.local:2586/haus
```

In der ntfy-App denselben Server und dasselbe Thema abonnieren. Themen sind
**nicht geheim**: wer die Adresse kennt, liest mit und kann schreiben. Für
`ntfy.sh` deshalb einen Namen wählen, den niemand rät, oder ein Zugriffstoken
hinterlegen.

Gesendet wird als reiner Text mit den Zusätzen in Kopfzeilen — der von ntfy
dokumentierte Weg, und der einzige, der sowohl mit `ntfy.sh` als auch mit einer
eigenen Instanz unter derselben Adresse funktioniert.

**Die drei Stufen werden auf Prioritäten abgebildet**, und das ist eine
Entscheidung, keine Formalie: nur ein Alarm darf nachts klingeln.

| Stufe | ntfy / Gotify | wofür |
| --- | --- | --- |
| `info` | 3 | neue Version, Hinweise |
| `warn` | 4 | Licht zu lange an, Schwellen überschritten, Batterie schwach |
| `alert` | 5 | Dienst steht, RAID beschädigt, Sicherung fehlgeschlagen |

### Webhook

Für alles andere. Wer eigene Feldnamen braucht, hinterlegt eine Vorlage mit
`{{title}}`, `{{body}}`, `{{level}}` und `{{link}}` — so wächst diese Datei
nicht um einen Zweig je Anbieter.

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
| GET | `/channel-kinds` | Welche Zustellwege es gibt und was sie brauchen |
| GET/POST | `/channels` · DELETE `/channels/<id>` | Zustellwege |
| POST | `/channels/<id>/test` | Testnachricht |
| GET | `/version` | installierte und oberste Version |

Alles außer `/kinds` und `/version` verlangt `X-Home-User`.
