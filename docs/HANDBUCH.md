# OMP-Handbuch (Dev-Betrieb)

Kurzanleitung für den lokalen Dev-Betrieb des Orchestrators. Architektur-
Hintergrund steht in `ARCHITECTURE.md`, der Implementierungsplan in
`UMSETZUNG.md` — hier geht es nur um „wie starte ich das Ding".

## 1. Voraussetzungen

- **Go** (aktuelle Version, siehe `docs/decisions.md` 2026-07-07)
- **Deno** (für das UI-Bundle, kein Node/npm nötig)
- **Podman** (rootless; startet NATS + NMOS-Registry + PostgreSQL als Container)

Nur für die Node-Contract-Demo-Services (`omp-source`/`-viewer`/
`-switcher`, `nodes/`) zusätzlich nötig, **nicht** für den Orchestrator
selbst:
- **Rust/Cargo** (`make nodes` baut sie)
- **MXL-Bibliothek** (`deploy/dev/install-mxl.sh`, siehe dessen
  Kopfkommentar) — ohne sie bauen die Nodes zwar (MXL wird per
  `libloading`/`dlopen` erst zur Laufzeit geladen), lassen sich aber nicht
  starten (`libmxl.so … cannot open shared object file`).

## 2. Schnellstart

```sh
make start
```

Das macht in einem Schritt:
1. NATS + NMOS-Registry + PostgreSQL als Podman-Container starten
   (`make up`, idempotent). Der Orchestrator wendet seine SQL-
   Migrationen (`orchestrator/internal/db`) beim Start automatisch an —
   kein manueller Schema-Schritt nötig.
2. UI-Bundle bauen (`make ui`).
3. Orchestrator-Binary bauen (`orchestrator/` → `bin/omp-orchestrator`).
4. Orchestrator im Hintergrund starten, auf `/healthz` warten.

Danach: **http://localhost:8000** im Browser öffnen — das ist die
Flow-Editor-Shell.

```sh
make status   # kurzer Überblick: Orchestrator/NATS/Registry/Postgres laufen?
make stop     # stoppt nur den Orchestrator-Prozess (Container bleiben an)
make stop ARGS=--all   # stoppt zusätzlich NATS + NMOS-Registry + Postgres
make down     # Alternative: nur die Container stoppen (make up macht das rückgängig)
```

Layouts (B5) und Snapshots (B7) liegen seit D1 in Postgres statt als
Dateien unter `data/` — `data/` bleibt nur noch für den Instanz-
Launcher-Zustand (C8) und `role-bindings.json` (C13) in Benutzung.

Log des Orchestrators: `.run/orchestrator.log` (nicht versioniert).

### 2.1 Optional: mTLS Orchestrator↔Nodes (D3)

Standardmäßig **aus** — der Schnellstart oben braucht nichts davon, alle
Flows funktionieren unverändert per Klartext-HTTP. Zum Ausprobieren von
mTLS (`ARCHITECTURE.md` §4.6):

```sh
make mtls-up            # startet step-ca (eigene interne CA), separat von "make up"
make mtls-issue-certs    # stellt Dev-Zertifikate für Orchestrator + Mock-Node aus
OMP_MTLS_ENABLED=true ./deploy/dev/start-omp.sh
OMP_MTLS_ENABLED=true OMP_MTLS_CERT_FILE=.run/mtls/mock-node.crt \
  OMP_MTLS_KEY_FILE=.run/mtls/mock-node.key OMP_MTLS_CA_FILE=.run/mtls/root_ca.crt \
  nodes/mock/mock --label "Mock (mTLS)" --port 9001
```

Ein Node mit aktiviertem mTLS registriert sich mit `https://`-href und
verlangt ein gültiges Client-Zertifikat derselben CA für **jeden**
Zugriff (auch `curl` ohne Zertifikat wird abgewiesen) — der generische
Orchestrator-Proxy funktioniert unverändert, weil er automatisch den
passenden (mTLS-fähigen oder Klartext-)Client für die jeweilige
`http://`-/`https://`-Node-Adresse verwendet; ein gemischter Bestand aus
mTLS- und Klartext-Nodes funktioniert gleichzeitig. Zertifikate sind
23h gültig (step-ca-Default-Limit) — für eine längere Sitzung
`make mtls-issue-certs` erneut ausführen. Nur `nodes/mock` (Go)
unterstützt mTLS bisher — die Rust-`omp-node-sdk`-Nodes noch nicht
(`docs/decisions.md` D3, verbleibender Scope). `make mtls-down` stoppt
den CA-Container wieder (separat von `make down`).

## 3. Anmeldung (Login)

Solange kein Nutzer angelegt ist, läuft die GUI **ohne** Anmeldung
(Auth ist deaktiviert, solange `UserCount()==0`,
`ARCHITECTURE.md` §12) — praktisch relevant ist das nur auf einer
komplett frischen Datenbank; auf dieser Dev-Maschine existiert bereits
ein Nutzer (s. u.).

**Aktueller Dev-Standardnutzer** (Bootstrap-Admin mit Wildcard-
`admin`-Rolle, angelegt bei der Umsetzung von Kapitel 11 Teil 1,
`docs/END-GOAL-FEATURES.md` §11, s. `UMSETZUNG.md`-Status-Checkliste):

| Nutzername | Passwort |
|---|---|
| `admin` | `adminpass123` |

Weitere Nutzer/Rollenbindungen verwaltet der **Administration**-Tab in
der App-Bar (nur sichtbar für Nutzer mit `admin`-Verb, sowie im
Bootstrap-Fall für die Erstanlage): Nutzer anlegen/löschen, Passwort
zurücksetzen, Rollenbindungen (Nutzer × Node × Recht — `view` <
`operate` < `configure` < `admin`, `"*"` = alle Nodes) anlegen/
löschen, Audit-Log einsehen. Der letzte verbleibende Admin kann sich
dort nicht selbst löschen oder entrechten (Selbstschutz gegen
versehentliches Aussperren).

**Passwort vergessen, kein zweiter Admin übrig?** Es gibt keine
CLI-Passwort-Reset-Funktion — stattdessen den Nutzer aus der
Datenbank entfernen, das versetzt das System zurück in den
Bootstrap-Zustand (danach über die GUI einen neuen Admin anlegen):
```sh
podman exec -it omp-postgres psql -U omp -d omp \
  -c "DELETE FROM role_bindings; DELETE FROM users;"
```

**JWT-Secret in Produktions-Deployments (S4, docs/REVIEW-2026-07-17-
SKALIERUNG-24-7.md):** ohne gesetztes `OMP_AUTH_JWT_SECRET`
generiert/persistiert der Orchestrator beim ersten Start selbst ein
Secret unter `OMP_AUTH_JWT_SECRET_FILE` (Default
`../data/auth-jwt-secret`, s. `internal/auth.LoadOrCreateSecret`) — für
den lokalen Dev-Betrieb bequem (kein manueller Schritt nötig), für ein
echtes Deployment aber **zwingend** `OMP_AUTH_JWT_SECRET_FILE` auf
einen dauerhaften, gesicherten Pfad setzen (oder gleich
`OMP_AUTH_JWT_SECRET` direkt aus einer eigenen Secret-Verwaltung
einspeisen): landet das auto-generierte Secret stattdessen auf einem
vergänglichen Datenträger (z. B. einem Container-Overlay ohne Volume),
werden nach jedem Neustart alle ausgestellten Anmelde-Tokens ungültig —
jeder angemeldete Nutzer wird ungefragt ausgeloggt.

## 4. Erste Schritte in der GUI

- Der Flow-Editor zeigt zunächst einen leeren Graphen — noch keine Nodes
  registriert.
- Über die Katalog-Palette (links) lassen sich die in `deploy/catalog.json`
  gelisteten Node-Typen aus der GUI heraus starten (Instanz-Launcher,
  `UMSETZUNG.md` C8) — vorausgesetzt, sie wurden vorher gebaut:
  ```sh
  make nodes   # baut nodes/target/debug/{omp-source,omp-switcher,omp-viewer}
  ```
- Gestartete Instanzen erscheinen automatisch als Kacheln (Selbstregistrierung
  über NMOS, kein manuelles Eintragen).

## 5. Backup & Restore

Der komplette Orchestrator-Zustand (Nutzer, Rollenbindungen, Audit-Log,
Layouts, Snapshots, Workflows, Hosts) liegt in Postgres (`omp-postgres`-
Container). Zwei Skripte, `deploy/dev/backup-omp.sh`/`restore-omp.sh`
(bzw. `make backup`/`make restore`):

**Backup:**
```sh
make backup
# oder direkt:
./deploy/dev/backup-omp.sh
```
Schreibt `.backups/omp-<UTC-Zeitstempel>.sql.gz` (`pg_dump --clean
--if-exists` über `podman exec`, kein lokal installiertes
`postgresql-client`-Paket nötig). Behält automatisch die letzten 14
Sicherungen, ältere werden nach einem erfolgreichen neuen Dump
gelöscht. `.backups/` ist bewusst nicht Teil des Git-Repos
(`.gitignore`) — enthält Passwort-Hashes und andere sensible Daten,
gehört auf ein separates, gesichertes Backup-Ziel (aus dieser
Dev-Sitzung heraus nicht mit ausgerollt).

**Restore:**
```sh
make stop                                    # Orchestrator muss gestoppt sein
make restore ARGS=.backups/omp-<zeitstempel>.sql.gz
```
Verlangt eine interaktive Bestätigung (exakt `yes` eingeben) — das
Skript **überschreibt den kompletten aktuellen Inhalt** der Datenbank
`omp` mit dem Stand aus der angegebenen Datei. Ohne Argument listet
`restore-omp.sh` die vorhandenen Sicherungen in `.backups/` auf.

**Ein Restore, der nie ausgeführt wurde, ist keiner** — dieses
Skriptpaar wurde bei seiner Einführung einmal echt durchgespielt
(Backup → Testnutzer angelegt → Restore → Testnutzer wieder weg,
dokumentiert in `docs/decisions.md`), nicht nur gelesen/geschrieben.

## 6. Remote-Zugriff / Reverse-Proxy (S7)

Der Orchestrator selbst spricht nur Klartext-HTTP (`http://localhost:8000`)
— das ist für den lokalen Dev-Betrieb korrekt, aber **nicht** sicher
genug für einen Zugriff von außerhalb dieser Maschine: Anmeldung läuft
über ein Bearer-Token (`Authorization: Bearer …`), das Node-UI-Bundle
und SSE-Reconnects akzeptieren das Token zusätzlich als
`?access_token=`-Query-Parameter (praktisch für `<img src>`/
`EventSource`, die keinen eigenen Header setzen können) — **beides
ergibt nur mit HTTPS Sinn**, sonst liegt das Token im Klartext auf der
Leitung bzw. sichtbar in jedem Proxy-/Server-Log, das die URL
mitschreibt.

**Lösung: TLS-Terminierung durch einen vorgeschalteten Reverse-Proxy**
(`deploy/dev/Caddyfile`), der Orchestrator bleibt dahinter unverändert
Klartext — dieselbe Trennung wie beim optionalen mTLS
Orchestrator↔Nodes (Abschnitt 2.1): TLS-Handling ist Aufgabe der
Infrastruktur, nicht des Go-Codes.

```sh
make proxy-up     # startet Caddy (Podman-Container) auf https://localhost:8443
make proxy-down   # stoppt ihn wieder
```

`tls internal` lässt Caddy beim ersten Start automatisch eine eigene,
lokale CA erzeugen und ein Zertifikat dafür ausstellen — kein
manueller Zertifikats-Schritt nötig. Der Browser zeigt trotzdem eine
Sicherheitswarnung, weil er Caddys lokale CA nicht kennt (für einen
Dev-Test ignorierbar/akzeptierbar; Caddy kann die CA auch exportieren
und ins System-Vertrauensspeicher importiert werden, s.
[Caddy-Doku](https://caddyserver.com/docs/automatic-https#local-https)
— hier bewusst nicht automatisiert, das ist Betriebssystem-spezifisch).
`.run/caddy` persistiert diese CA über `make proxy-down`/`proxy-up`
hinweg, damit der Browser sie nicht bei jedem Neustart neu akzeptieren
muss.

**Echter Fernzugriff über das Internet** (nicht nur `localhost`):
`:8443` im Caddyfile durch die eigene Domain ersetzen (z. B.
`omp.example.org`) — Caddy stellt dafür automatisch ein echtes
Let's-Encrypt-Zertifikat aus, kein `tls internal` mehr nötig, keine
weitere Konfiguration. Der Host muss dafür von außen auf Port 443
erreichbar sein (Firewall/Router-Weiterleitung), was außerhalb des
Scopes dieses Handbuchs liegt.

**`X-Forwarded-*`-Verträglichkeit geprüft, kein Code-Beitrag nötig:**
der Orchestrator liest an keiner Stelle `r.Host`/`r.TLS` oder setzt
Cookies/CORS-Header (Code durchsucht, `docs/decisions.md` 2026-07-18)
— die gesamte Auth läuft über das selbsttragende Bearer-Token, das
unabhängig vom verwendeten Schema/Host gültig bleibt. Ein Reverse-Proxy
davor ändert daher am Orchestrator-Verhalten nichts, unabhängig davon,
ob/wie er `X-Forwarded-*`-Header setzt.

## 7. Troubleshooting

**Login-Formular erscheint, aber keine Zugangsdaten bekannt** — s.
Abschnitt 3 oben (Standardnutzer `admin`/`adminpass123`, bzw.
Passwort-Reset-Verfahren, falls dieser Nutzer inzwischen geändert oder
gelöscht wurde).

**„Auf Port 8000 antwortet bereits ein Prozess, der nicht über
start-omp.sh/PID-Datei bekannt ist"** — ein verwaister Prozess (z. B. aus
einer manuell im Terminal gestarteten Sitzung) blockiert den Port:
```sh
ss -ltnp | grep 8000     # zeigt PID des Prozesses
kill <PID>                # bzw. kill -9, falls er nicht reagiert
```

**`registry poll failed: connection refused` kurz nach dem Start** — harmlos:
der Orchestrator pollt die NMOS-Registry alle 2 s; unmittelbar nach `make up`
braucht der Registry-Container ein paar hundert ms zum Hochfahren. Verschwindet
von selbst; falls nicht, `podman logs omp-nmos-registry` prüfen.

**`make check` schlägt bei `cargo test -p omp-mediaio` fehl
(`libmxl.so … cannot open shared object file`)** — erwartet, solange
`deploy/dev/install-mxl.sh` nicht gelaufen ist (siehe Voraussetzungen oben).
Betrifft nur die MXL-Nodes, nicht den Orchestrator/die UI.

**Podman rootless startet nicht** — siehe `deploy/quadlets/README.md` bzw.
`docs/decisions.md` (2026-07-07, Toolchain-Installation) für die auf dieser
Dev-Maschine verifizierte Konfiguration.

## 8. Mehr Kontext

- Architektur/Konzepte: `ARCHITECTURE.md` (Referenzdokument, wird bei jeder
  größeren Entscheidung fortgeschrieben)
- Umsetzungsplan/Status: `UMSETZUNG.md` (Status-Checkliste am Ende)
- Einzelentscheidungen/Blocker-Historie: `docs/decisions.md`
- Eigenen Node-Typ bauen (SDK-Tutorial): `docs/NODE-TUTORIAL.md`
