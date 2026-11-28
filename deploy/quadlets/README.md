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
