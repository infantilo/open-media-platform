# OMP-Handbuch (Dev-Betrieb)

Kurzanleitung für den lokalen Dev-Betrieb des Orchestrators. Architektur-
Hintergrund steht in `ARCHITECTURE.md`, der Implementierungsplan in
`UMSETZUNG.md` — hier geht es nur um „wie starte ich das Ding".

## 1. Voraussetzungen und Preflight-Prüfung

> **Neuinstallation:** siehe `docs/INSTALLATION.md` (Ein-Befehl-Installer `./install.sh`, Port-/Firewall-Tabelle, Kommunikationswege). Dieses Handbuch beschreibt den Betrieb.

- **Go** (aktuelle Version, siehe `docs/decisions.md` 2026-07-07)
- **Deno** (für das UI-Bundle, kein Node/npm nötig)
- **Podman** (rootless; startet NATS + NMOS-Registry + PostgreSQL als Container)
- Standardwerkzeuge: `make`, `curl`, `openssl`, `git`
- Empfohlen: mindestens 2 GB RAM für das Grundsystem (8 GB und mehr für Medien-Nodes), 10 GB
  freier Plattenplatz, Linux (x86_64 getestet)

Nur für die Node-Contract-Demo-Services (`omp-source`/`-viewer`/
`-switcher`, `nodes/`) zusätzlich nötig, **nicht** für den Orchestrator
selbst:
- **Rust/Cargo** (`make nodes` baut sie; Edition 2024, mindestens 1.85)
- **GStreamer** (Entwicklungsbibliotheken + die Plugin-Pakete
  base/good/bad/ugly)
- **MXL-Bibliothek** (`deploy/dev/install-mxl.sh`, siehe dessen
  Kopfkommentar) — ohne sie bauen die Nodes zwar (MXL wird per
  `libloading`/`dlopen` erst zur Laufzeit geladen), lassen sich aber nicht
  starten (`libmxl.so … cannot open shared object file`).

### 1.1 Preflight: `make preflight`

Vor der Erstinstallation (und bei jedem Problem) prüft

```sh
make preflight                                    # alles
make preflight PREFLIGHT_ARGS="--for=start"       # nur, was make start braucht
make preflight PREFLIGHT_ARGS="--strict"          # Warnungen wie Fehler behandeln
make preflight PREFLIGHT_ARGS="--json"            # maschinenlesbar (eine Zeile je Prüfung)
```

(bzw. direkt `./deploy/dev/preflight.sh`), ob der Rechner alles hat. Jede
Zeile ist ✔ in Ordnung, `!` Hinweis oder ✘ Fehler; zu jedem Problem steht
darunter der **Befehl zur Behebung** für die erkannte Distribution
(apt, dnf, pacman, zypper). Das Skript ändert nichts am System und braucht
kein `sudo`. Geprüft wird:

- **System:** Linux, Architektur, Arbeitsspeicher, CPU-Kerne, Plattenplatz.
- **Werkzeuge:** `make`, `curl`, `openssl`, `git`, Go (Version gegen
  `go.mod`), Deno.
- **Container:** Podman vorhanden und funktionsfähig (`podman info`),
  `subuid`/`subgid` für rootless, die benötigten Images (NATS, NMOS-Registry,
  etcd — aus dem Makefile abgeleitet) und das lokal gebaute Postgres-Image;
  fehlen Images, wird geprüft, ob die Registries erreichbar sind (sonst
  Fehler mit Hinweis auf `podman save`/`load`).
- **Ports:** 8000, 8091, 8010/8011, 4222–4224, 8222, 5432/5442/5452, 8008,
  2379 — belegt ein **fremder** Prozess einen dieser Ports, steht sein Name
  dabei. Belegung durch einen bereits laufenden OpenMediaPlatform-Stack ist
  kein Fehler.
- **Konfiguration:** Schreibrechte in `.run/` und `bin/`, Storage-Schlüssel,
  Signaturschlüssel fürs System-Update (Hinweis, kein Fehler).
- **Medien-Nodes** (nicht bei `--for=start`): Rust-Version, GStreamer-
  Entwicklungsbibliotheken, GStreamer-Kernelemente (Mischer, Multiviewer,
  MXF-Player …) und optionale (WebRTC, x264, SRT, ST 2110, Matroska),
  gebaute MXL-Bibliothek, `/dev/shm`-Größe, ffmpeg/ffprobe.

Exit-Code 0 = kein Fehler, 1 = mindestens ein Fehler. `make start` ruft
die Kurzform (`--for=start --quiet`) automatisch auf und bricht bei
Fehlern **vor** dem ersten Schritt ab; mit `OMP_SKIP_PREFLIGHT=1 make start`
lässt sich die Prüfung überspringen (beim System-Update ist sie ohnehin
aus).

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

### 2.1 Optional: mehrere Hosts simulieren (Dev)

Standardmäßig läuft nur ein Host (dieser Rechner, unsichtbar für die
GUI, solange kein Host-Agent registriert ist). Für Kapitel 13/14/15
(Host-Zonen im Flow-Editor, Placement, Ressourcen-Profile — s. `make
start` oben, Abschnitt 4) braucht es mindestens zwei registrierte
Hosts. Zwei simulierte `omp-host-agent`-Prozesse auf derselben Maschine
reichen dafür (`docs/decisions.md` 2026-08-13 ff., "Regie-Host-A"/
"Regie-Host-B"):

```sh
make hosts
```

Baut `bin/omp-host-agent` und startet beide Agents im Hintergrund
(`.run/host1/`, `.run/host2/` — Logs, PID-Datei, `state.json`). Die
Host-Identität (Host-ID + Label) bleibt über `state.json` stabil über
Neustarts hinweg — ein erneuter `make hosts`-Aufruf registriert wieder
dieselben zwei Hosts (an die bestehende Zonen-Zuordnungen/Workflows
anknüpfen), keine neuen. Idempotent: ein bereits laufender Agent wird
übersprungen. Beide lesen denselben Katalog wie der Instanz-Launcher
(`deploy/catalog.json` direkt — eine frühere Kopie nach
`/tmp/host-catalog.json` verschob das Basisverzeichnis für relative
Kommandopfade und ließ jeden Node-Start auf einem simulierten Host
fehlschlagen, Nutzerfund 2026-09-10).

```sh
deploy/dev/stop-hosts.sh   # stoppt beide wieder (state.json bleibt erhalten)
```

`make stop ARGS=--all` stoppt sie automatisch mit. Weiteres zur
Host-Ansicht im Flow-Editor: Abschnitt 4 unten,
[`docs/BENUTZERHANDBUCH.md`](BENUTZERHANDBUCH.md) §2.5/§8.

### 2.2 Optional: mTLS Orchestrator↔Nodes (D3)

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
ein Nutzer (s. u.). Auf einer **Neuinstallation** existiert dagegen noch keiner: sofort in Administration einen Admin anlegen.

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

### 3.1 Rechte-Modell: vier Begriffe, vier verschiedene Fragen

Der Administration-Tab hat vier Unteransichten, die sich auf den ersten
Blick überschneiden können — sie beantworten aber vier unterschiedliche
Fragen und bleiben bewusst unabhängig nebeneinander bestehen:

| Begriff | Beantwortet | Unteransicht |
|---|---|---|
| **Nutzer** | Wer kann sich anmelden? | Nutzer |
| **Organisation** | Welche Workflows/Assets sieht ein Nutzer überhaupt (Mandanten-/Sichtbarkeitsgrenze)? | Organisationen |
| **Gruppe** | Rechte-Bündel für mehrere Nutzer gleichzeitig (z. B. für eine spätere AD-Anbindung, die Gruppenmitgliedschaft synchronisiert, keine Einzelrechte) | Gruppen |
| **Rollenbindung** | Die eigentliche Berechtigung: Subjekt (Nutzer **oder** Gruppe) × Bereich (Node/`"*"`/Workflow-Rolle) × Verb | Rollenbindungen |

Eine Rollenbindung ist also der einzige Ort, an dem tatsächlich Rechte
vergeben werden — sowohl direkt an einen Nutzer als auch indirekt über
eine Gruppe, deren Mitglied er ist. Organisation ist davon komplett
unabhängig: Sie schränkt ein, was ein Nutzer überhaupt sehen kann,
unabhängig davon, was seine Rollenbindungen ihm erlauben würden.

**Um herauszufinden, was ein bestimmter Nutzer insgesamt darf** (direkt
zugewiesene Rollenbindungen **plus** alle über seine Gruppenmitgliedschaften
geerbten), nicht selbst zwischen den Unteransichten hin- und
herspringen und im Kopf zusammenrechnen — stattdessen im Tab **Nutzer**
bei der jeweiligen Person auf **„Rechte"** klicken: Das Panel listet
direkte Bindungen und jede Gruppe mit ihren Bindungen an einem Ort auf
(inkl. Löschen-Button, falls dort etwas entfernt werden soll). Ebenso
zeigt der Tab **Gruppen** bei einer Gruppe unter „Mitglieder" direkt
auch „Rechte dieser Gruppe" — auch das erspart den Umweg über
Rollenbindungen, nur um zu sehen, was eine Gruppe überhaupt gewährt.

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
- Sobald mehr als ein Host über einen Host-Agenten registriert ist, zeigt
  der Flow-Editor automatisch Host-Zonen pro Maschine an (Toggle
  „Host-Ansicht" oben rechts) — Details mit Screenshots:
  [`docs/BENUTZERHANDBUCH.md`](BENUTZERHANDBUCH.md) §2.5/§8.

### 4.1 Echten Remote-Host hinzufügen (Wizard)

Abschnitt 2.1 oben simuliert zwei Hosts auf derselben Dev-Maschine.
Für einen echten zweiten Rechner (Bare-Metal, VM, oder eine AWS-EC2-
Instanz) den bisher nur per API erreichbaren Bootstrap-Token-Flow
(`ARCHITECTURE.md` §18.3) über die GUI bedienen: Hosts-Tab → „+ Neuen
Host hinzufügen" (nur für Admins sichtbar). Der Wizard erzeugt das
Token, liefert ein fertiges Provisionierungs-Skript (Shell-Einzeiler
bzw. EC2-User-Data, je nach gewählter Zielumgebung) und erkennt die
Anmeldung des neuen `omp-host-agent` live. Details mit Screenshot:
[`docs/BENUTZERHANDBUCH.md`](BENUTZERHANDBUCH.md) §8.1.

Kein vorgefertigtes Installations-Artefakt für `omp-host-agent`
existiert bisher (kein curl-Installer) — das erzeugte Skript geht davon
aus, dass die Binary bereits auf dem Zielhost liegt (`cd host-agent &&
go build -o omp-host-agent .`, oder `bin/omp-host-agent` von dieser
Maschine dorthin kopiert).

### 4.2 Orchestrator-Cluster einrichten (Wizard)

Für die in §19.3 (`ARCHITECTURE.md`) beschriebene Raft-Redundanz des
Orchestrators selbst: Administration → Cluster (Details mit
Screenshot: [`docs/BENUTZERHANDBUCH.md`](BENUTZERHANDBUCH.md) §7).
Zeigt Status/Mitglieder der eigenen Instanz und bietet „+ Weiteren
Orchestrator hinzufügen" — Formular für Node-ID/Raft-Adresse/
HTTP-Adresse der neuen Instanz erzeugt live das nötige Start-Skript
(`OMP_NODE_ID`/`OMP_RAFT_LISTEN`/`OMP_RAFT_DATA_DIR`/
`OMP_CLUSTER_JOIN=true`), ein Klick auf „Jetzt beitreten lassen" ruft
danach `POST /api/v1/cluster/join` auf. Für einen lokalen Testlauf mit
zwei echten Orchestrator-Prozessen auf derselben Maschine (statt einer
echten zweiten Maschine) reicht ein zweiter `bin/omp-orchestrator`-
Aufruf mit eigenem `OMP_NODE_ID`/`OMP_RAFT_LISTEN`/`OMP_RAFT_DATA_DIR`/
`OMP_LISTEN`/`OMP_CLUSTER_JOIN=true` und denselben `OMP_POSTGRES_URL`/
`OMP_NATS_URL` wie die erste Instanz (geteilte Infrastruktur) —
Postgres/NATS/Registry-Adressen unverändert lassen, nur die
cluster-spezifischen Variablen sind pro Instanz eindeutig.

## 5. Backup & Restore

Der komplette Orchestrator-Zustand (Nutzer, Rollenbindungen, Audit-Log,
Layouts, Snapshots, Workflows, Hosts) liegt in Postgres (`omp-postgres`-
Container).

**Backup und Restore — beide über die GUI möglich** (Nutzerwunsch
2026-08-13): Administration → Backup/Restore.

- „Backup jetzt erstellen“ (`POST /api/v1/admin/backup`, Admin-Recht
  nötig) erstellt eine Sicherung genau wie `backup-omp.sh` (gleicher
  `.backups/`-Ordner, gleiche Rotation) und liefert sie sofort als
  Download.
- Restore: Backup aus der Liste wählen, den Dateinamen zur Bestätigung
  exakt eintippen, „Zurückspielen“. Ein Zurückspielen verlangt, dass
  der Orchestrator selbst gestoppt ist — ein laufender Prozess kann
  sich das nicht selbst befehlen, während er gerade den Restore-Request
  beantwortet. Deshalb läuft seit Nutzerentscheidung 2026-08-13 immer
  ein eigenständiger, dauerhaft laufender **Supervisor-Prozess**
  daneben (`omp-supervisor`, `supervisor/main.go`, nur auf `127.0.0.1`
  erreichbar, automatisch von `make start`/`start-omp.sh` mitgestartet,
  überlebt einen `make stop`/`make start`-Zyklus des Orchestrators
  unverändert) — der Orchestrator-Endpunkt ruft ihn intern auf, er
  führt den eigentlichen Stop→Restore→Start-Zyklus aus (ruft dafür
  dieselben `stop-omp.sh`/`start-omp.sh`-Skripte wie unten auf, keine
  eigene Neuimplementierung). Die Browserseite meldet währenddessen
  „Server wird neu gestartet …“ und lädt sich nach ca. 5–10s automatisch
  neu, sobald `/healthz` wieder antwortet.

Zwei Skripte, `deploy/dev/backup-omp.sh`/`restore-omp.sh`
(bzw. `make backup`/`make restore`) — bleiben als Kommandozeilen-
Alternative bestehen, z. B. für ein Skript-gesteuertes Deployment ohne
Browser:

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

## 5a. Aufbewahrung und automatisches Aufräumen

Alles, was mit der Zeit wächst, wird automatisch gelöscht — beim Start und danach täglich. Die Dauer ist je Bereich per Umgebungsvariable des Orchestrators einstellbar; `0` oder weniger schaltet das Löschen für den Bereich ab.

| Bereich | Variable | Standard |
|---|---|---|
| Zentrales Log (`logs`) | `OMP_LOG_RETENTION_HOURS` | 72 Stunden |
| Audit-Log und fachliches Audit | `OMP_AUDIT_RETENTION_DAYS` | 90 Tage |
| Workflow-Läufe (Scheduler: geplant gegen real) | `OMP_WORKFLOW_RUN_RETENTION_DAYS` | 30 Tage |
| Versendete Outbox-Ereignisse | `OMP_OUTBOX_RETENTION_DAYS` | 14 Tage |
| Verbrauchte/abgelaufene Host-Einmaltokens | `OMP_HOST_TOKEN_RETENTION_DAYS` | 7 Tage |
| Abgeschlossene Prozess-Ausführungen (samt Schritten, Aufgaben und Asset-Verknüpfungen) | `OMP_PROCESS_EXECUTION_RETENTION_DAYS` | 180 Tage |
| Quittierte/maskierte Alarme | fest | 30 Tage bzw. bis Ablauf |

Nicht automatisch gelöscht werden Nutzerdaten und Betriebsstand: Workflows, Snapshots, Layouts, Assets, Prozess-Definitionen, Hosts, Katalog, Verbrauchsprofile und Instanzen. Noch nicht versendete Outbox-Ereignisse und noch laufende Workflow-Läufe bleiben immer erhalten. Die NATS-Streams (Domain-Ereignisse, Logs) begrenzt NATS selbst über ihre Höchstdauer.

## 5b. System-Update (Browser-Upload)

Neue Versionen des Servers lassen sich ohne Zugriff auf die Maschine
einspielen: Administration → **System-Update** (Bedienung: `BENUTZERHANDBUCH.md`
§7). Dieser Abschnitt beschreibt Einrichtung, Paketbau und Betrieb; das
vollständige Konzept steht in `docs/ENTWURF-SYSTEM-UPDATE.md`.

**Bausteine.** Der Orchestrator nimmt das Paket entgegen und prüft es;
angewendet wird es vom eigenständigen **Supervisor** (derselbe Prozess wie
beim Restore, `deploy/dev/start-supervisor.sh`), der den Orchestrator dafür
anhalten und neu starten muss. Beide prüfen das Paket unabhängig
voneinander — der Supervisor vertraut dem Orchestrator nicht, der ja gerade
ersetzt wird.

**Paketformat.** `omp-update-<Version>.tar.gz` mit `manifest.json`
(Version, Architektur, Mindestversion, Migrationen, Komponenten mit
SHA-256 und Ziel) und `manifest.sig` (Ed25519-Signatur über das
Manifest). Abgelehnt wird jedes Archiv mit Symlinks, `..`/absoluten
Pfaden, nicht im Manifest gelisteten Dateien, falscher Prüfsumme,
falscher Architektur oder Zielen außerhalb der erlaubten Liste:
`bin/omp-orchestrator`, `bin/omp-supervisor`, `bin/omp-host-agent`,
`ui/dist/…` und `node:<omp-name>` (das über den Katalog auf den echten
Pfad abgebildet wird, nur für Nodes, die im Katalog stehen).

**Einrichtung (einmalig).**
```sh
make update-keygen                                  # erzeugt ~/.omp-update/update-signing.key (GEHEIM) und update-trusted.pub
cp ~/.omp-update/update-trusted.pub .run/update-trusted.pub   # Vertrauensanker auf dem Server
make stop && make start                             # Orchestrator + Supervisor laden den neuen Code
```
Den privaten Schlüssel nicht auf den Server legen. Ohne `.run/update-trusted.pub`
lehnt der Server jedes Paket ab; `OMP_UPDATE_ALLOW_UNSIGNED=true` erlaubt
unsignierte Pakete und ist nur für die Entwicklung gedacht.

**Paket bauen.**
```sh
make update-bundle                    # baut Binaries + UI und packt sie signiert nach dist/
make update-bundle UPDATE_VERSION=2026.10.1 NODES_PROFILE=release
```
Enthalten: Orchestrator (mit Versionsstempel), Supervisor, Host-Agent,
UI-Bundle und alle im Katalog referenzierten Node-Programme aus
`nodes/target/<NODES_PROFILE>`. Debug-Nodes summieren sich auf mehrere GB;
für Pakete `NODES_PROFILE=release` verwenden. Die Version muss numerisch
aufsteigen (Standard: Datum + Uhrzeit). Zusätzliche Optionen (Migrationen,
Mindestversion, Hinweistext) über `UPDATE_BUNDLE_ARGS` bzw. direkt mit
`cd tools/update-bundle && go run . pack -h`; `go run . verify -pub <Schlüssel> <Paket>`
prüft ein Paket auf der Kommandozeile.

**Ablauf beim Installieren.**
1. Backup (Pflicht, wenn das Paket Datenbank-Migrationen enthält).
2. Alle Dateien werden neben ihrem Ziel bereitgestellt und geprüft —
   noch ohne Ausfall.
3. Orchestrator anhalten (`stop-omp.sh`), Dateien atomar tauschen (die
   Vorgänger liegen unter `.updates/rollback/<Zeitstempel>/`, die letzten
   drei bleiben erhalten), Orchestrator starten (`start-omp.sh` mit
   `OMP_SKIP_BUILD=1`, es wird also **nichts aus dem Quellcode gebaut**).
4. Prüfung: `/healthz` und `GET /api/v1/version` müssen die neue Version
   melden (Zeitlimit 90 s).
5. Bei Fehlern **automatischer Rollback** und Neustart des alten Stands;
   der Grund steht im Verlauf. Enthielt das Update Datenbank-Migrationen,
   die bereits angewendet wurden, weist die Meldung ausdrücklich darauf
   hin, dass das Schema neuer als das alte Programm sein kann — dann das
   Backup über Backup/Restore einspielen (ein automatischer Datenbank-
   Restore findet bewusst nicht statt).
6. Ist der Supervisor selbst Teil des Pakets, ersetzt er sich zuletzt per
   `exec` (gleiche PID). Schlägt der `exec` selbst fehl, läuft der alte
   Supervisor weiter; stürzt das neue Programm erst nach dem Start ab,
   muss er per `deploy/dev/start-supervisor.sh` neu gestartet werden.

**Nodes und Host-Agents.** Laufende Prozesse behalten ihr altes Programm
(Linux hält die alte Datei fest) und bleiben in Betrieb; sie gelten als
**„veraltet"**, bis sie neu gestartet werden — Erkennung: das Programm ist
jünger als der Prozessstart. „Veraltete Instanzen jetzt neu starten"
(`POST /api/v1/admin/updates/restart-outdated`) startet Workflow-Rollen
über RestartRole und freistehende Instanzen per Stop + Start neu.
„An Remote-Hosts verteilen" (`POST /api/v1/admin/updates/{id}/distribute`)
schickt jedem erreichbaren Host-Agent ein `update`-Kommando; der Agent
lädt das Paket mit einem Einmal-Token vom eigenen Orchestrator, prüft es
mit **seinem** Vertrauensanker (`OMP_UPDATE_PUBKEY_FILE` auf dem Host,
in `start-hosts.sh` für die simulierten Hosts gesetzt) und ersetzt Agent-
und Node-Programme seines lokalen Katalogs. Ein neuer Host-Agent wird erst
nach dessen Neustart aktiv, weil ein Neustart seine verwalteten
Kindprozesse verwaisen ließe.

**Wichtige Umgebungsvariablen.** `OMP_UPDATE_DIR` (Ablage der Pakete,
Rollback-Kopien und Verlauf, Standard `.updates/`),
`OMP_UPDATE_PUBKEY_FILE` (Standard `.run/update-trusted.pub`),
`OMP_UPDATE_ALLOW_UNSIGNED`, `OMP_SKIP_BUILD` (überspringt in
`start-omp.sh`/`start-supervisor.sh`/`start-hosts.sh` den Quellcode-Build).

**Entwicklungsbetrieb.** Ein späteres `make start` baut wieder aus dem
Quellcode (Version „dev") und überschreibt damit einen eingespielten
Stand. Der Update-Weg ist für Installationen mit fertigen Binaries
gedacht; im Entwicklungsbetrieb bleibt `git pull` + `make start` der
normale Weg.

**Noch nicht enthalten.** Rollierendes Update mehrerer Orchestrator-
Mitglieder (Cluster) und ein automatischer Neustart von Host-Agents/Nodes
nach dem Update.

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

## 7. Metrics & Soak-Test (S8)

`GET /metrics` liefert Kennzahlen im Prometheus-Textformat — Go-Runtime
(Goroutinen, Heap, GC), Registry (Nodes online/gesamt, Poll-Dauer),
SSE (Clients, verlorene Events), Launcher (Instanzen, automatische
Neustarts) und HTTP-Requests nach Status-Klasse. Handgeschrieben, kein
`prometheus/client_golang` (Minimal-Dependency-Regel) — unauthentifiziert
wie `/healthz` (ein echter Scraper trägt üblicherweise kein
Bearer-Token; Netzwerk-Isolation ist hier die erwartete Absicherung,
nicht Anwendungs-Auth).

```sh
curl http://localhost:8000/metrics
```

**Soak-Test:**

```sh
make soak                        # 1h, alle 60s ein Sample (S8-Default)
make soak ARGS="1800 30"         # 30min, alle 30s (Sekunden: Dauer Intervall)
```

Startet den Stack (falls nicht bereits gestartet) + 2 Test-Nodes
(`omp-source`, reine Grundlast, keine Verkabelung nötig) und schreibt
`/metrics` alle N Sekunden als Zeile in
`.run/soak/soak-<UTC-Zeitstempel>.csv` (nicht Teil des Git-Repos,
`.gitignore`). Strg+C bricht früher ab, die bis dahin gesammelte CSV
bleibt gültig; Test-Nodes werden beim Beenden (auch nach Strg+C)
automatisch wieder gestoppt.

**Soak-Analyse (Abbruchkriterium, S8):** kein automatischer Trend-Test
im Skript — ein Mensch bewertet die entstandene CSV. Steigen
`heap_alloc_bytes` oder `goroutines` über die **gesamte** Laufzeit
ohne erkennbares Plateau/Sägezahnmuster (normale GC-Zyklen sorgen für
regelmäßiges Auf und Ab) monoton an, ist das ein Leck-Befund. Ein
einzelner kurzer Smoke-Lauf (2,5 min, 5 Samples,
`docs/decisions.md` 2026-07-18) zeigte das erwartete gesunde Muster
(Goroutinen/Heap schwankend, kein Trend) — die eigentliche, im Review
verlangte 1-Stunden-Verifikation ohne monotonen Anstieg ist noch
offen (dokumentierte Folgearbeit, sprengt eine einzelne Sitzung).

## 8. Troubleshooting

**Bei jedem Problem zuerst `make preflight`** (Abschnitt 1.1): es prüft Werkzeuge,
Podman, Images, Ports und Rechte und nennt den Befehl zur Behebung.

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

**Tally im Flow Editor bleibt aus, Audio-Follow-Video (AFV) schaltet nicht
mit, im Orchestrator-Log stehen „tally publish … timed out"** — die Nodes
erreichen NATS nicht. Häufige Ursache: die Pfad-Variablen
`OMP_NATS_TLS_*` sind gesetzt (`start-omp.sh` exportiert Standardpfade
unter `.run/mtls`), der NATS-Cluster läuft aber im Klartext. Der
Node-SDK nutzt TLS zu NATS nur noch, wenn zusätzlich
`OMP_NATS_TLS_ENABLED=true` gesetzt ist (Standard: Klartext). Prüfen: die
NATS-Monitoring-Ports (`curl localhost:8222/connz`) müssen die
`omp-node-sdk`-Verbindungen der Nodes zeigen.

**System-Update wird abgelehnt** — „Signatur ungültig" heißt: der
Schlüssel des Pakets steht nicht in `.run/update-trusted.pub` (bzw. es gibt
die Datei nicht); „Architektur" heißt: das Paket wurde für eine andere
Plattform gebaut; „Mindestversion" verlangt zuerst ein Zwischenupdate.
Scheitert das Anwenden, steht der Grund samt automatischem Rollback im
Reiter System-Update unter „Verlauf" und in `.run/supervisor.log`.

**Podman rootless startet nicht** — siehe `deploy/quadlets/README.md` bzw.
`docs/decisions.md` (2026-07-07, Toolchain-Installation) für die auf dieser
Dev-Maschine verifizierte Konfiguration.

## 9. Microservices im Überblick

Jeder Microservice ist ein eigenständiger Prozess (`nodes/`-Workspace-
Mitglied), der sich selbst per NMOS IS-04 beim Orchestrator anmeldet und
seine Parameter/Methoden per Node-Contract (§5, `ARCHITECTURE.md`)
selbst beschreibt — der Orchestrator kennt keinen der folgenden Typen
fest verdrahtet, die Liste unten beschreibt nur, was aktuell tatsächlich
existiert und über den Instanz-Launcher (`deploy/catalog.json`)
startbar ist.

### 9.1 Medien-erzeugende/-verarbeitende Nodes

| Node | Funktion |
|---|---|
| **omp-source** | Erzeugt ein wählbares GStreamer-Testbild (Farbbalken u. a.) inkl. Testton als MXL-Flow. Reine Testquelle, keine echte Kamera-/Dateianbindung. |
| **omp-switcher** | Einfacher Video-Umschalter zwischen automatisch entdeckten MXL-Quellen per Knopf. Die Quellen erscheinen als Menü: zuerst Workflows/Gruppen, darin Untergruppen und Quellen (Zurück-Knopf, Breadcrumb); „Nur eigene Gruppe“ beschränkt auf die Gruppe/den Workflow des Switchers samt Untergruppen. Nicht aktive Eingänge werden nur gedrosselt gelesen (geringe CPU-Last). Kein Programm-/Preset-Bus, kein Mischeffekt (funktionaler Vorläufer des Video Mixer M/E). |
| **omp-video-mixer-me** | Vollwertiger M/E-Bildmischer: Programm-/Preset-Bus (Kreuzschiene), Cut/Auto-Transition, DVE-Kanal (PIP), Downstream-Keyer (DSK, Fill+Key), Tally-Signalisierung. Unterstützt seit D8 Teil 3 `setOutputDelay()` (Latenzbudget-Ausgleich, s. Abschnitt 9.7). |
| **omp-audio-mixer** | Digitales Audiomischpult mit dynamischer Kanalanzahl, Gain/EQ (LO/MID/HIGH) und Kompressor pro Kanal, Master-Limiter, automatischem Audio-Follow-Video. |
| **omp-mxf-player** | MXF-Datei-/Playlist-Player, cue/take-bedient (A/B-Slot), mit Programmgruppen-Audio-Shuffle. Kann zusätzlich eine entdeckte Live-MXL-Quelle als Playlist-Item abspielen. Programmgruppen und Shuffle-Presets kommen aus dem gemeinsamen Audio-Dokument (Administration → Audio-Ausgabe, s. Benutzerhandbuch 10c); der frühere eigene Editor im Flow-Editor entfällt. Liest MXF-Audiolabels nach SMPTE ST 377-4/-41 (MCA): Kanalsprache, Inhalt und Klasse werden als Tags in die Audio-Regeln übernommen (Vorrang vor dem Spurschema) und im Panel angezeigt. |
| **omp-mxf-player-direct** | Diagnose-/Direkt-Variante von omp-mxf-player: kein A/B-Slot-Cue/Take, keine Playlist — spielt beim Start automatisch genau eine Datei direkt in die MXL-Ausgänge. Ausgangsgruppen und Shuffle-Presets kommen aus dem gemeinsamen Audio-Dokument (Administration → Audio-Ausgabe); „Einstellungen neu laden“ im Panel wendet Änderungen live an. Der frühere lokale Editor mit eigener Zustandsdatei entfällt. |
| **omp-channel-player** | Isel-freier, einzweigiger Player ohne Playlist/Cue-Take — `load()` ersetzt den aktuellen Inhalt sofort. Gedacht als eine von zwei physischen Quellen am Video-Mixer-Crosspoint für echten Crossfade. Audio: je Zielgruppe des Ausgabeprofils ein eigener Sender (Standard: Programmton, Hörfilm/AD, Originalton, Dolby E, 5.1), Zuordnung je Event per `audioMapping`, Ersatzregeln bei fehlenden Spuren (s. `docs/PLAYOUT-AUTOMATION.md` §7a). |
| **omp-multiviewer** | Zeigt entdeckte MXL-Videoquellen automatisch als Kachel-Raster. Läuft er als Rolle eines Workflows, zeigt er **nur die Quellen dieses Workflows** (Node-Tag `urn:x-omp:workflow`); manuell gestartet zeigt er alle. Reines Monitoring, kein weiterverkettbares Programmsignal. |
| **omp-viewer** | Zeigt einen ausgewählten MXL-Videostream als MJPEG-Vorschau im Browser. |
| **omp-playout-automation** | Automatisierte Playlist-Sequenzierung: steuert zwei omp-channel-player-Kanäle (A/B) und einen Bildmischer fern (Auto/Hold-Modus, Next/Next-Live/Stop, Cart-/Interrupt-Assets), echtes Xfade zwischen den beiden Kanälen. Keine eigene Medienpipeline. |
| **omp-scte35** | Erzeugt SCTE-35-Marker (`splice_insert` Out/In/Cancel, `time_signal` mit Segmentation Descriptor) und SCTE-104-Nachrichten für Werbeblöcke, mit Vorlauf und auf Bildgrenzen genau. Ausgabe: Verlauf/Parameter, UDP, Sidecar-Transportstrom (UDP/SRT, PID wählbar) und **SCTE 104 als ANC** (`video/smpte291`, DID 0x41/SDID 0x07) in einem MXL-Daten-Flow, der als NMOS-Sender erscheint. Der Playout-Automator steuert ihn und kann Werbeblöcke **automatisch aus der Event-Klassifikation** kennzeichnen (Schalter „Werbeblöcke automatisch kennzeichnen“ im Automations-Panel). Einstellungen: Node-Optionen (Admin → Einstellungen), Details in `docs/PLAYOUT-AUTOMATION.md`. |
| **omp-ograf** | Rendert EBU-OGraf-Grafikvorlagen (Bauchbinde, Laufband u. a.) als Fill+Key-MXL-Ausgang für den Bildmischer-DSK. Mehrere Grafiken können gleichzeitig on air stehen: die Liste „Auf Sendung“ im Panel zeigt sie, ein Klick öffnet die Grafik im Editor (Update live, Aus), „Weiter“ erscheint nur bei mehrstufigen Vorlagen. |
| **omp-media-library** | Datei-Katalog mit technischen Metadaten (`ffprobe`) und Mark-In/Out-Segmenten. Keine eigene Medienpipeline. |
| **omp-recorder** | Nimmt eine per Kreuzschiene angeschlossene MXL-Quelle (Video/Audio) als Matroska-Datei auf (`record.start`/`record.stop`). Endet der Dateiname auf `.mxf`, entsteht MXF (H.264 + PCM 24 Bit); ist zuvor `record.mcaPlan` (JSON, Format wie `mxf-mca inject`) gesetzt, werden nach dem Stopp MCA-Labels (ST 377-4/-41) in die Datei geschrieben. Ausschließlich MXL als Eingang, keine Capture-Karte. „Warm, unabonniert" bis zum Start — keine Lese-Pipeline im Leerlauf. |
| **omp-device-hub** | Erkennt die lokalen Video- (V4L2) und Audio-Geräte (ALSA/USB) des Hosts mit stabiler Geräte-ID (Seriennummer, sonst USB-Position) und Fähigkeiten. Je Gerät schaltet man „Anbieten“ ein: dann entsteht ein MXL-Flow mit NMOS-Sender (Tag `source.live`), der wie jede andere Quelle in der Kreuzschiene erscheint. Standard: alles aus; die Auswahl bleibt über Neustarts erhalten, ein abgezogenes Gerät wird beim Wiederanstecken wieder angeboten (gleiche Sender-ID). **Audio-Ausgänge** (Wiedergabe der Soundkarte, Kopfhörer/Lautsprecher) erscheinen als eigener Eintrag „Audio-Ausgang“: eingeschaltet wird daraus ein NMOS-Empfänger, der in der Kreuzschiene mit einer Audioquelle verbunden wird und dann über die Karte abspielt (Mehrkanal wird auf die Kanalzahl der Karte gemischt). Status je Gerät: Aus / Startet / Sendet / Wartet auf Verbindung / Nicht angesteckt / Fehler. Ein Node je Host, nicht je Gerät. |
| **omp-xy-panel** | X/Y-Kreuzschiene als Bedienpanel (reine Steuerebene, keine Ports): links Quellen, rechts Ziele, je mit Home-/Hoch-Taste durch Workflows, Gruppen (verschachtelt) und „Nicht zugewiesen“. Schaltet über `POST /api/v1/graph/edges` (Rechte, Audit, Schleifenschutz des Kerns gelten). Zusätzlich Bouquets (mehrere Schaltungen mit einem Take, im Layout `xy-bouquets` gespeichert) und tag-basierte Schaltung über `GET /api/v1/sources` und `GET /api/v1/sinks` (Tags an Quelle **und** Senke, z. B. `role.commentator`). Für Desktop und Smartphone/Tablet (Layout folgt der Breite der Kachel). |
| **omp-scope** | Passives Messgerät (Tap, kein Ausgang) auf je einen optionalen MXL-Video- und -Audio-Flow. **Bild:** Waveform + Vektorskop als ein Messbild, mittleres Luma, Bild-zu-Bild-Differenz. **Ton:** Peak/RMS, EBU-R-128-Lautheit (M/S/I/LRA), True Peak in dBTP nach ITU-R BS.1770 samt R-128-Konformitätsampel (−23 ±0,5 LUFS, ≤ −1 dBTP). **Timing:** Transportlatenz, Jitter, Ist-/Soll-Kadenz, ausgelassene Grains und Reader-Neuaufsetzer je Flow — gerechnet aus den MXL-Ursprungszeitstempeln der Grains, nicht aus Ankunftszeiten; daraus der **A/V-Versatz (Lipsync)**, bewertet nach EBU R 37 (Ton höchstens 40 ms vor, 60 ms nach dem Bild). **Flow:** die Deklaration aus der MXL-Domain (Media-Type, Rate, Bittiefe, Farbraum, Interlace, Grouphint, Grain-Größe, Datenrate), bewusst getrennt vom gemessenen Ist angezeigt. **Signalüberwachung:** Schwarzbild, Standbild und Stille als gehaltene Alarme (1/2/2 s Haltezeit). Ein negativer Latenzwert ist kein Anzeigefehler, sondern die Aussage „der Schreiber stempelt in die Zukunft" — s. `docs/decisions.md` Nachtrag 226. |
| **omp-scaler** | Skaliert/konvertiert eine per Drag & Drop angeschlossene MXL-Videoquelle auf ein fest konfiguriertes Zielformat (Rollen-Format, s. Workflow-Formular) und schreibt sie als zweiten MXL-Flow zurück — gleicht Auflösungs-/Framerate-Unterschiede zwischen Quellen und Zielen aus. Unterstützt seit D8 Teil 3 `setOutputDelay()` (Latenzbudget-Ausgleich, s. Abschnitt 9.7). **Bekannte Einschränkung:** in einer Kette Quelle→Scaler→Ziel innerhalb desselben Workflow-Starts kann die letzte Verbindung (Scaler→Ziel) zu früh ausgelöst werden, bevor der Scaler seinen eigenen Ausgangs-Flow fertig aufgebaut hat — betroffene Verbindung im Flow-Editor einmal neu ziehen behebt es sofort (s. `docs/decisions.md` Nachtrag 109). |
| **omp-pipeline-controller** | Bettet `PIPELINE CONTROLLER` (eigenständiges, produktiv gelaufenes Broadcast-Playout-System) als OMP-Node ein — komplettes Web-UI + REST-API laufen unverändert im Container, das Bedienpanel zeigt es als `<iframe>`. Registriert zwei NMOS-Sender (Programm-Video/-Audio) und zwei Receiver für echte MXL-Ein-/Ausgänge im DMF-Verbund; per IS-05-Connect verkabelte Live-Quellen werden automatisch in PIPELINE CONTROLLERs eigene Live-Quellen-Liste eingetragen. Keine eigenen OMP-Play/Stop/Cue-Methoden — Playlist/Grafik/Player/Assets/Voiceover/Record bleiben ausschließlich über PIPELINE CONTROLLERs eigenes UI bedient. |

### 9.2 Gateway-Nodes (Standort-/Fremdgeräte-Anbindung)

| Node | Funktion |
|---|---|
| **omp-2110-gateway** | Bidirektionale Brücke SMPTE-ST-2110-Multicast (LAN, Fremdgeräte) ⇄ OMP-internes MXL-Fabric. Gerichtet je Instanz (Ingest/Output), SDP- oder Einzel-Env-Var-Konfiguration. |
| **omp-aes67-gateway** | Audio-Pendant zu `omp-2110-gateway`: AES67/RTP-Multicast (Dante im AES67-Modus, Ravenna, Lawo/Merging u. a.) ⇄ MXL, inkl. SAP-Discovery (RFC 2974) für Fremdströme, die nur darüber auffindbar sind. |
| **omp-srt-gateway** | Bidirektionale Brücke ST 2110 (LAN) ⇄ SRT (WAN) für Beitrag/Distribution über verlustbehaftete Netze. Gerichtet je Instanz (Uplink/Downlink). |
| **omp-webrtc-gateway** (Typen `omp-webrtc-gateway-camera` / `-monitor`) | Anbindung gewöhnlicher Handys per Browser, ohne App: **Kamera** nimmt Handy-Kamera/-Mikrofon per WebRTC (WHIP, H.264 + Opus) auf und speist sie als MXL-Flow ein; **Monitor** sendet einen gewählten MXL-Flow als Retourbild (WHEP) zurück. Zugang nur über Einladungslinks/QR-Codes. Ausführlich: Benutzerhandbuch, Abschnitt „Handy-Kamera“. |
| **omp-fabrics-gateway** | Siehe Abschnitt 9.3 — **Remote Memory Access** zwischen zwei OMP-Hosts. |

### 9.3 Remote Memory Access (MXL-native Fabrics)

Für den Medientransport **zwischen** Hosts stehen zwei Wege zur Wahl:
klassisch **ST 2110 ⇄ SRT** (`omp-srt-gateway`, WAN-tauglich, verlustbehandelt)
oder **MXL-native Fabrics** (`omp-fabrics-gateway`) — echter,
Zero-Copy-**Remote-Memory-Zugriff** über Hostgrenzen hinweg auf Basis von
libfabric (der OFI-Standard-Abstraktion für RDMA-fähige Transporte),
vendort in MXL selbst (`third_party/mxl/lib/fabrics/ofi/`).

- **Implementiert und live verifiziert** (Kapitel 16 Teil 0/1/2,
  `docs/END-GOAL-FEATURES.md` §16, `docs/decisions.md` Nachträge 41–55):
  ein eigener `omp-fabrics-gateway`-Node (zweigeteilt wie die übrigen
  Gateways, `OMP_FABRICS_GATEWAY_ROLE=target|initiator`) relayt einen
  kompletten MXL-Flow per echtem One-Sided-RDMA-Write kontinuierlich in
  eine Domain auf einem anderen Host — **kein Mock, keine GStreamer-
  Pipeline nötig**, da Fabrics unterhalb der GStreamer-Ebene direkt auf
  `mxlFlowWriter`/`mxlFlowReader`-Handles arbeitet.
- **Software-Provider (`tcp`) läuft ohne RDMA-Hardware** — reines
  Ethernet/Loopback genügt, echte RDMA-Verbindung samt kontinuierlich
  wachsendem, auf beiden Seiten identischem MXL-Head-Index bereits
  verifiziert (zwei MXL-Domains auf einer Maschine, echte
  Mehr-Host-Verifikation ist Kapitel-16-Teil-3, wartet auf einen zweiten
  physischen Host).
- **Noch offen:** `verbs`/`efa`-Provider mit echter RoCEv2-Hardware
  (Kapitel 16 Teil 4 — Hardware-Beschaffung entschieden, aber noch nicht
  verfügbar) sowie eine automatische Placement-Auswahl Fabrics vs.
  ST2110/SRT durch den Orchestrator (bisher manuelle Node-Wahl).
- Provider werden per `OMP_FABRICS_PROVIDER=tcp|verbs|efa|shm`
  konfiguriert — derselbe Code, der Wechsel zu echter RoCEv2-Hardware ist
  damit eine Konfigurationsfrage, kein Architekturwechsel.
- **Noch nicht im GUI-Instanz-Katalog** (`deploy/catalog.json`) —
  `omp-fabrics-gateway` wird bisher von Hand gestartet
  (`OMP_FABRICS_GATEWAY_ROLE`/`OMP_FABRICS_TARGET_URL` u. a., s.
  `nodes/omp-fabrics-gateway/src/main.rs`), nicht per Katalog-Kachel wie
  die übrigen Nodes.

### 9.4 Referenz-/Tutorial-Node

**`nodes/mock`** (Go) — Referenz-Node ohne echte Medientechnik, Begleiter
zu `docs/NODE-TUTORIAL.md` für eigene Node-Implementierungen; einziger
mTLS-fähiger Node bisher (Abschnitt 2.1).

### 9.5 Eigenen Microservice zum Katalog hinzufügen

Zwei unabhängige Wege, je nach Auslieferungsform (Details/Codepfade:
`docs/NODE-TUTORIAL.md` Schritt 5):

- **Lokal gebautes Binary** (`runner: "process"`, der Normalfall für
  einen frisch mit dem SDK gebauten Node, s. `docs/NODE-TUTORIAL.md`):
  Eintrag von Hand in `deploy/catalog.json`, danach Orchestrator neu
  starten (`make stop && make start`) — die Datei wird nur beim Start
  gelesen, kein Hot-Reload.
- **Container-Image** (`runner: "podman"`, §17 Teil 4/5): Import über
  den **Administration**-Tab (bzw. `POST /api/v1/catalog`) ohne
  Orchestrator-Neustart, inkl. Admission-Check und Mehrfachversionen
  desselben Typs (§17 Teil 5). Dieser Weg akzeptiert serverseitig
  ausschließlich `runner: "podman"` — ein reiner Prozess-Eintrag lässt
  sich darüber nicht anlegen.

### 9.6 Instanz-Label vergeben

Ohne eigenes Label heißt jede gestartete Instanz generisch
„`<Katalog-Label>` (`<Kurz-ID>`)" (z. B. „Source (66a0c71b)") — auch in
Kreuzschienen-Dropdowns anderer Nodes (Bild-/Audiomischer). Für über
einen **Workflow** gestartete Rollen übernimmt der Launcher automatisch
den im Workflow frei vergebenen Rollennamen als Label (kein Zusatzschritt
nötig). Für einen direkten Katalog-Start (`POST /api/v1/instances`) lässt
sich ein Label zusätzlich explizit im Request-Body mitgeben:
`{"type": "omp-source", "label": "Kamera 1"}`.

### 9.7 Redundanz & Latenzbudget (Workflow-Einstellungen)

Zwei Workflow-Definitions-Felder betreffen mehrere Rollen gleichzeitig
und werden erst beim `Start()` durchgesetzt — beide rein deklarativ im
Rollen-Designer bzw. Workflow-Formular gesetzt, kein manueller
Orchestrator-Eingriff nötig (Bedienung im Detail:
`docs/BENUTZERHANDBUCH.md` Abschnitt 4):

- **Hot-Standby (`Role.standbyFor`, seit K7 Teil 4):** eine Rolle kann
  eine andere Rolle gleichen Node-Typs als Standby begleiten. Fällt die
  Primärinstanz nach Ausschöpfung der Crash-Loop-Bremse endgültig aus,
  oder wird ihr Host als offline erkannt (Telemetrie-Staleness), wird
  die Standby-Instanz automatisch befördert — Verkabelung und
  Bedienzustand (per `/state` GET/POST) übernommen, ihre Kachel im Flow
  Editor bis dahin gestrichelt dargestellt. Break-before-make (kurzer
  sichtbarer Schnitt), kein Genlock-Äquivalent — Details/Grenzen in
  `ARCHITECTURE.md` §6.3 Stufe 4.
- **Latenzbudget (`Settings.targetLatencyFrames`, seit D8):** legt fest,
  nach wie vielen Frames jeder Pfad des Workflows den Graphen verlassen
  soll. `Start()` lehnt eine Verkabelung hart ab, deren kürzester Pfad
  länger als das Zielband wäre; für Pfade, die **kürzer** sind, weist
  der Orchestrator die fehlende Differenz automatisch der spätesten
  delay-fähigen Rolle im Pfad per `setOutputDelay()` zu (bisher
  `omp-scaler`, `omp-video-mixer-me`, s. Abschnitt 9.1-Tabelle). Kein
  delay-fähiger Node auf einem zu kurzen Pfad → derselbe harte
  Start-Fehler statt stillem Teil-Ausgleich. Details:
  `ARCHITECTURE.md` §15.1.


### 9.8 Cloud-Hosts (Modul des Orchestrators, kein Node)

Der Orchestrator kann über einen **Provider-Adapter** Cloud-Hosts mieten (`OMP_CLOUD_PROVIDER=mock|aws`; Zugangsdaten und Konfiguration gehören in die Datei `deploy/dev/cloud.env` (Vorlage `cloud.env.example`, nicht im Repo, `chmod 600`), die `make start` liest — nie in Oberfläche oder Datenbank; Sicherheitsnetze in `docs/CLOUD-AWS.md`). Ein Cloud-Host ist ein gewöhnlicher Host (Host-Agent per Bootstrap-Token, Placement, Migration); neu sind nur Anlegen/Beenden und Kosten. Bausteine: Pools (Anbieter, Region, Instanztyp, min/max), Reservierungen („Kapazität von–bis“), Autoscaling-Regeln je Pool (Aus/Vorschlagen/Automatisch, harter Tages-/Monatsdeckel), Kostenvorberechnung und geschätzte Ist-Kosten, Draining-Abbau. API: `/api/v1/cloud/{pricing,estimate,hosts,costs,reservations,policies,suggestions}`; Bedienung: Tab **Cloud** (Benutzerhandbuch §10e). Die AWS-Anbindung ist ohne SDK gebaut und **noch nicht gegen echtes AWS getestet**; echte Starts sind standardmäßig gesperrt (nur Trockenlauf).


### 9.9 Orchestrator-Module (Playout, Audio-Ausgabe, Cloud)

Domänenfunktionen sind **Module** des Orchestrators, keine Kernfunktion: **Playout** (Channels, Trigger, As-Run, Preflight),
**Audio-Ausgabe** (Audio-Regeln) und **Cloud** (§9.8). Jedes Modul bringt seine Routen, ggf. Hintergrundjobs, Kennzahlen und seine
Oberfläche mit; `GET /api/v1/modules` zeigt Stand und Oberfläche (die Shell baut ihre Tabs daraus). Mit der Umgebungsvariable
`OMP_MODULES_DISABLE=cloud,audio-rules` (Komma-Liste der Namen `cloud`, `playout`, `audio-rules`) lässt sich ein Modul abschalten:
seine Routen antworten dann mit 404 und der Tab fehlt — der Kern (Nodes, Graph, Hosts, Workflows, Rechte) läuft unverändert. Ein Modul,
dessen Start oder Migration scheitert, steht als `failed` im Manifest, die übrigen laufen weiter. Eigene Module: `docs/MODULE-SCHREIBEN.md`.

## 10. Mehr Kontext

- Architektur/Konzepte: `ARCHITECTURE.md` (Referenzdokument, wird bei jeder
  größeren Entscheidung fortgeschrieben)
- Umsetzungsplan/Status: `UMSETZUNG.md` (Status-Checkliste am Ende)
- Einzelentscheidungen/Blocker-Historie: `docs/decisions.md`
- Eigenen Node-Typ bauen (SDK-Tutorial): `docs/NODE-TUTORIAL.md`
