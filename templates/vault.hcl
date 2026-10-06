# pi-home-stack - managed by install.sh, changes may be overwritten.
#
# Dateispeicher statt Raft: ein Einzelknoten auf einem Pi braucht kein Consensus-
# Protokoll, und der Bestand bleibt ein Verzeichnis, das sich schlicht kopieren
# lässt. Genau so lief es vorher auch.

ui = true

# mlock verhindert, dass Schlüsselmaterial in den Swap gerät. Auf einem Pi mit
# zram-Swap ist das besonders relevant — dafür braucht der Dienst CAP_IPC_LOCK,
# was die Unit des Pakets mitbringt.
disable_mlock = @VAULT_DISABLE_MLOCK@

storage "file" {
  path = "@VAULT_DATA@"
}

# Lokaler Klartext-Listener. Nicht nach außen gebunden: veröffentlicht wird über
# nginx unter /vault/, und zwischen nginx und Vault liegt nur das Loopback.
listener "tcp" {
  address     = "127.0.0.1:@VAULT_PORT@"
  tls_disable = 1
}

# Direkter TLS-Zugang im LAN, für Clients die nicht über nginx gehen.
listener "tcp" {
  address                  = "0.0.0.0:@VAULT_TLS_PORT@"
  tls_cert_file            = "@VAULT_TLS_DIR@/tls.crt"
  tls_key_file             = "@VAULT_TLS_DIR@/tls.key"
  tls_disable_client_certs = true
}

api_addr     = "@VAULT_API_ADDR@"
cluster_addr = "https://127.0.0.1:@VAULT_CLUSTER_PORT@"
