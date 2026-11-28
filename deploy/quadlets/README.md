# deploy/quadlets/

systemd-Quadlet-Unit-Dateien (Podman) für Infrastruktur-Container (NATS,
NMOS-Registry, ...). Siehe `ARCHITECTURE.md` §4.3, `UMSETZUNG.md` A2/A3.

## NATS einrichten (je Host)

```sh
sudo install -d -m 0755 /etc/omp /etc/omp/nats /etc/omp/nats/certs
sudo install -m 0644 omp-nats.conf.example /etc/omp/nats/omp-nats.conf
sudo install -m 0600 nats.env.example /etc/omp/nats.env   # alle "changeme" ersetzen
```

- Zertifikate nach `/etc/omp/nats/certs/`: `server.crt`, `server.key`, `root_ca.crt` (eigene CA, z. B. step-ca,
  Ablauf wie bei `deploy/dev/mtls-issue-cert.sh`). Das Serverzertifikat braucht als SAN alle Namen, unter denen
  Clients und die anderen Server den Knoten erreichen, und die Zwecke Server- und Client-Authentifizierung
  (die Routen prüfen sich gegenseitig).
- Passwörter nur aus URL-sicheren Zeichen und mit einem Buchstaben beginnend (`printf 'p%s\n' "$(openssl rand -hex 24)"`);
  auf allen drei Hosts dieselben.
- Auf Orchestrator- und Agent-Rechnern (`OMP_NATS_TLS_ENABLED=true` plus `OMP_NATS_TLS_CERT_FILE`/`_KEY_FILE`/`_CA_FILE`):

| Prozess | `OMP_NATS_URL` | `OMP_NODE_NATS_URL` (an gestartete Nodes) |
|---|---|---|
| Orchestrator | `tls://orchestrator:<pw>@h1:4222,tls://orchestrator:<pw>@h2:4222,…` | `tls://node:<pw>@h1:4222,…` |
| Host-Agent | `tls://hostagent:<pw>@h1:4222,…` | `tls://node:<pw>@h1:4222,…` |

  Fehlt `OMP_NODE_NATS_URL`, bekommen die Nodes die Zugangsdaten des startenden Prozesses.
- Prüfung: `journalctl --user -u omp-nats` (keine `authentication error`), `curl http://127.0.0.1:8222/routez`.

**Umstellung einer bestehenden Klartext-Installation:** Server und alle Clients gleichzeitig umstellen
(Wartungsfenster); alte Clients werden abgewiesen. Der JetStream-Speicher liegt jetzt im Volume `omp-nats-data`.

**Grenze:** Alle Host-Agents teilen sich den Benutzer `hostagent` (ein Host kann die Kommandos anderer Hosts
mitlesen, aber nicht senden), alle Nodes den Benutzer `node`.

## Datenbank-Cluster einrichten (etcd + Patroni, je Host)

- **Eigene CA** nur für diesen Cluster (jedes Zertifikat von ihr hat vollen Zugriff auf etcd). CA und Zertifikat
  brauchen die Erweiterung `keyUsage` (CA: `keyCertSign`, `cRLSign`), sonst lehnt Patroni die CA ab; das
  Zertifikat braucht als SAN alle Namen des Hosts und die Zwecke Server- **und** Client-Authentifizierung.
  step-ca erfüllt das; von Hand erzeugte Zertifikate vorher mit `openssl x509 -noout -text` prüfen.
- `/etc/omp/etcd/` und `/etc/omp/patroni/` je mit `ca.crt`, `server.crt`, `server.key` (0600).
- `sudo install -m 0600 patroni.env.example /etc/omp/patroni.env` und alle `changeme` ersetzen. Die Unit startet
  sonst nicht. In `omp-etcd.container`/`omp-patroni.container` weiterhin die Hostnamen ersetzen.
- Orchestrator: `OMP_POSTGRES_URL` mit dem Passwort aus `OMP_DB_PASSWORD`; für Sicherung/Wiederherstellung
  `OMP_POSTGRES_PATRONI_NODES=name=https://host:8008,…` und `OMP_POSTGRES_PATRONI_CA_FILE=<ca.crt>`
  (auch beim Supervisor).
- Prüfen: `patronictl -c /home/postgres/bootstrap.yml list` im Container; ohne Zertifikat muss
  `curl --cacert ca.crt -X PATCH https://host:8008/config -d '{}'` mit 403 scheitern. Lesende Aufrufe
  (`GET /cluster`, `/primary`) bleiben ohne Anmeldung.

**Umstellung einer bestehenden Installation:** etcd speichert die Peer-Adressen; vor dem Wechsel auf `https://`
sichern, je Mitglied `etcdctl member update <ID> --peer-urls=https://<host>:2380` ausführen (noch über die alten
Adressen), dann alle drei Units tauschen und neu starten (Wartungsfenster). Die Rolle `omp` einer bestehenden
Datenbank behält ihr Passwort: `ALTER ROLE omp PASSWORD '…'` und `OMP_POSTGRES_URL` anpassen.

**Grenzen:** Die Postgres-Verbindungen selbst (Port 5432, Replikation) sind weiterhin unverschlüsselt; Port 5432
nur im internen Netz erreichbar machen.

## Wiederherstellung auf einen Zeitpunkt (PITR)

Ohne diese Einrichtung reicht eine Wiederherstellung nur bis zur letzten Sicherung. Voraussetzung ist ein Image aus
dem aktuellen `deploy/patroni` (`podman build -t localhost/omp-patroni:latest -f deploy/patroni/Dockerfile deploy/patroni`).

1. **Ablage:** ein Verzeichnis, das alle drei Datenbank-Hosts sehen und das nicht auf deren Systemplatten liegt
   (Netzlaufwerk). In `omp-patroni.container` die Zeile `Volume=…:/archive` aktivieren, `systemctl daemon-reload`,
   Knoten nacheinander neu starten. Der Benutzer `postgres` (UID 70 im Container) muss dort schreiben dürfen.
2. **Archivierung einschalten** (einmal, im Container; braucht einen Neustart von Postgres):
   ```sh
   patronictl -c /home/postgres/bootstrap.yml edit-config --force -p archive_mode=on \
     -p "archive_command=/usr/local/bin/omp-pitr archive %p %f" -p archive_timeout=60 omp-postgres
   patronictl -c /home/postgres/bootstrap.yml restart --force omp-postgres
   ```
3. **Basissicherung** sofort (`podman exec omp-patroni omp-pitr backup`) und täglich: `omp-pg-basebackup.service`
   und `.timer` nach `/etc/systemd/system/`, `systemctl enable --now omp-pg-basebackup.timer`. Aufbewahrt werden
   7 Stück (`OMP_PG_BASE_KEEP`) samt den dafür nötigen Segmenten.
4. **Überwachen:** `select * from pg_stat_archiver;` — wächst `failed_count`, sammelt Postgres WAL auf der eigenen
   Platte, bis sie voll ist. Freien Platz in der Ablage überwachen.

**Wiederherstellen** (der laufende Verbund bleibt dabei unberührt):

```sh
podman exec omp-patroni omp-pitr restore "2026-11-28 14:05:00+01" /tmp/stand.sql.gz
podman cp omp-patroni:/tmp/stand.sql.gz .backups/
```

Die Datei dann wie jede Sicherung zurückspielen (`docs/betrieb/STOERUNGEN.md`, Abschnitt 7). Datenverlust ohne
Ausfall der Ablage: höchstens die letzte Minute (`archive_timeout`). Die Ablage enthält den vollständigen
Datenbankinhalt unverschlüsselt — Zugriff beschränken.
