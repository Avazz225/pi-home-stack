# Setup auf dem Pi

```bash
# 1. Dateien auf den Pi kopieren (venv NICHT mitkopieren, siehe Hinweis unten)
scp -r tracking_persistence_service pi@PI-ADRESSE:~/

# 2. Virtualenv auf dem Pi NEU anlegen (venv ist nicht architekturportabel,
#    ein vom Dev-Rechner kopiertes venv führt zu "status=203/EXEC")
cd ~/tracking_persistence_service
rm -rf venv
python3 -m venv venv
venv/bin/pip install -r requirements.txt

# 3. Systemd-Service einrichten
sudo cp tracking-persistence.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable tracking-persistence
sudo systemctl start tracking-persistence

# 4. Nginx konfigurieren
# Inhalt von nginx.conf.snippet in den bestehenden server-Block einfügen, dann:
sudo nginx -t && sudo systemctl reload nginx
```

Der Service läuft auf Port 5002 und ist über `/tracking-api/` erreichbar.
Daten werden in `~/tracking_persistence_service/data/tracking.db` (SQLite) gespeichert.
Das Schema wird beim ersten Start automatisch aus `schema.sql` angelegt.
