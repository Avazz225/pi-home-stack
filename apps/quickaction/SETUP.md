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
