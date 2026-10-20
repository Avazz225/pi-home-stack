# Setup auf dem Pi

```bash
# 1. Dateien auf den Pi kopieren (z. B. via scp oder git)
scp -r quickaction_persistence_service pi@PI-ADRESSE:~/

# 2. Virtualenv anlegen und Abhängigkeiten installieren
cd ~/quickaction_persistence_service
python3 -m venv venv
venv/bin/pip install -r requirements.txt

# 3. Systemd-Service einrichten
sudo cp quickaction-persistence.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable quickaction-persistence
sudo systemctl start quickaction-persistence

# 4. Nginx konfigurieren
# Inhalt von nginx.conf.snippet in den bestehenden server-Block einfügen, dann:
sudo nginx -t && sudo systemctl reload nginx
```

Der Service läuft auf Port 5001 und ist über `/profile-api/` erreichbar.
Profile werden als JSON-Dateien unter `~/quickaction_persistence_service/data/` gespeichert.

## Galerie

Die Galerie ist für den Bilderrahmen gedacht, den ein altes Tablet abgibt. Zwei
Arten von Eintrag, weil sie verschiedene Bedürfnisse bedienen:

| | |
| --- | --- |
| hochgeladen | liegt auf dem Pi und ist damit im Backup |
| verknüpft | liegt, wo es liegt — NAS-Freigabe, Fotodienst — und kostet hier nichts |

Hochgeladene Bilder landen standardmäßig in `data/gallery`. Dieses Verzeichnis
zeigt der Installer auf den Datenspeicher, wenn es einen gibt, und lässt es
lokal, wenn nicht — der Normalfall braucht also keine Entscheidung. Wer einen
anderen Ort will, trägt ihn in den Einstellungen ein; die vorhandenen Bilder
ziehen mit um, und das Ziel wird durch einen Schreibversuch geprüft, nicht durch
einen Blick: ein Verzeichnis kann existieren und trotzdem für diesen Dienst
nicht beschreibbar sein.

Der Dateiname auf der Platte ist **immer selbst vergeben**, nie der, der
hereinkam — ein Dateiname aus dem Browser ist Eingabe, und dieser landet in
einem Pfad. Ausgeliefert wird über die Eintrags-ID (`/gallery/file/<id>`), der
Pfad also nie aus etwas gebaut, das der Aufrufer geschickt hat.

Grenzen: 20 MB je Datei, und `.jpg .jpeg .png .webp .gif .avif`. Die Grenze muss
**auch in nginx** stehen (`client_max_body_size`), sonst lehnt der Webserver den
Upload ab, bevor der Dienst ihn sieht, und der Fehler sieht nach einem Fehler
des Dienstes aus.

| Methode | Pfad | Beschreibung |
| --- | --- | --- |
| GET | `/gallery` | Liste, Ablageort, Grenzen, freier Platz |
| POST | `/gallery/upload` | Multipart-Upload eines Bildes |
| POST | `/gallery/url` | Adresse verknüpfen |
| DELETE | `/gallery/<id>` | Eintrag entfernen, bei Uploads samt Datei |
| GET | `/gallery/file/<id>` | Hochgeladenes Bild ausliefern |
| PUT | `/gallery/settings` | Ablageort ändern, Bilder ziehen mit |
