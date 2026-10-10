# Setup auf dem Pi

```bash
# 1. Dateien auf den Pi kopieren (venv NICHT mitkopieren, siehe Hinweis unten)
scp -r study_persistence_service pi@PI-ADRESSE:~/

# 2. Virtualenv auf dem Pi NEU anlegen (venv ist nicht architekturportabel,
#    ein vom Dev-Rechner kopiertes venv führt zu "status=203/EXEC")
cd ~/study_persistence_service
rm -rf venv
python3 -m venv venv
venv/bin/pip install -r requirements.txt

# 3. Systemd-Service einrichten
sudo cp study-persistence.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable study-persistence
sudo systemctl start study-persistence

# 4. Nginx konfigurieren
# Inhalt von nginx.conf.snippet in den bestehenden server-Block einfügen, dann:
sudo nginx -t && sudo systemctl reload nginx
```

Der Service läuft auf Port 5004 und ist über `/study-api/` erreichbar.
Daten werden in `~/study_persistence_service/data/study.db` (SQLite) gespeichert.
Das Schema wird beim ersten Start automatisch aus `schema.sql` angelegt.

## Erstbefüllung

Dieses Paket bringt **keine** `seed.json` mit — die Datenbank startet leer, und
Fachrichtungen, CP-Grenzen und Module trägst du in der Weboberfläche ein.

Legst du doch eine `seed.json` daneben, wird sie beim allerersten Start
importiert, aber nur solange die Datenbank komplett leer ist; sobald eine
Fachrichtung oder ein Modul existiert, wird sie ignoriert. Spätere Änderungen in
der Oberfläche können also nicht überschrieben werden. Soll neu geseedet werden:
`rm data/study.db` und den Service neu starten.

## Datenmodell

| Tabelle | Zweck |
| --- | --- |
| `category` | Fachrichtung mit CP-Intervall (`cp_min`/`cp_max`). `is_thesis` markiert die Thesis |
| `module` | Modulpool: Stammdaten **und** Ist-Stand (Status, Note, Semester). `category_id NULL` = Ideenpool |
| `plan` | Benannter Planungsstand, `is_active` markiert den Plan, an dem man sich gerade langhangelt |
| `plan_entry` | Zuordnung Modul → Semester **innerhalb** eines Plans |
| `study_setting` | Key/Value, aktuell nur `target_cp` |

Genau eine Fachrichtung kann `is_thesis` tragen (im Seed die Masterarbeit). Sie ist ein
fester Block, der in jedem Fall kommt, und wird deshalb getrennt gerechnet: `/overview`
liefert neben den Gesamtzahlen `cp_done_coursework`, `target_coursework`, `cp_to_thesis`
und `progress_coursework` – also den Fortschritt **bis** zur Thesis, ohne sie. Setzt man
das Flag auf einer anderen Fachrichtung, wird es bei allen übrigen automatisch entfernt.
Ohne Flag ist `totals.thesis` `null` und die Oberfläche blendet Block und Kennzahl aus.

`is_thesis` kam nach der ersten Version dazu; `migrate_db()` ergänzt die Spalte beim
Start, bestehende Datenbanken müssen also nicht neu aufgesetzt werden.

Pläne kopieren bewusst keine Moduldaten. Ändert sich die CP-Zahl oder der Moses-Link
eines Moduls, stimmt das sofort in allen Plänen – und Pläne bleiben untereinander
vergleichbar, weil sie sich auf denselben Modulpool beziehen.

## Endpunkte

| Methode | Pfad | Beschreibung |
| --- | --- | --- |
| GET | `/overview` | Fachrichtungen inkl. Module, CP-Check je Fachrichtung, Notenschnitt, Gesamtfortschritt |
| GET/POST | `/categories` | Fachrichtungen lesen/anlegen |
| PUT/DELETE | `/categories/<id>` | Ändern/löschen (Module wandern in den Ideenpool, statt gelöscht zu werden) |
| GET/POST | `/modules` | Module lesen/anlegen |
| PUT/DELETE | `/modules/<id>` | Modul ändern/löschen |
| GET/POST | `/plans` | Pläne lesen/anlegen (`copy_from_plan_id` oder `seed_from_current` als Startpunkt) |
| GET | `/plans/<id>` | Plandetail: Einträge, Semesterspalten, CP-Check je Fachrichtung |
| PUT/DELETE | `/plans/<id>` | Plan umbenennen/löschen |
| POST | `/plans/<id>/activate` | Plan aktiv setzen (erneut aufgerufen: wieder deaktivieren) |
| POST | `/plans/<id>/adopt` | Semester des Plans in die Module übernehmen und Plan aktiv setzen |
| POST | `/plans/<id>/entries` | Modul in den Plan aufnehmen |
| PUT/DELETE | `/plan-entries/<id>` | Semester/Notiz eines Plan-Eintrags ändern, Modul aus Plan entfernen |
| GET/PUT | `/settings` | aktuell `target_cp` (Regelabschluss in Credit Points) |
