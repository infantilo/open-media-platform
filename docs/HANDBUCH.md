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
`ARCHITECTURE.md` §12) — **aber nur für Anfragen vom Rechner selbst**; von
einem anderen Rechner aus braucht die Erstanlage `OMP_BOOTSTRAP_OPEN=1`
oder `OMP_BOOTSTRAP_TOKEN` (Abschnitt 5b, „Erst-Administrator“). Praktisch
relevant ist das nur auf einer komplett frischen Datenbank; auf dieser Dev-Maschine existiert bereits
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

**Passwörter.** Neue und zurückgesetzte Passwörter brauchen mindestens 10 Zeichen
(`OMP_AUTH_MIN_PASSWORD`, nicht unter 8), höchstens 72 Byte, dürfen nicht nur aus
einem Zeichen bestehen, den Nutzernamen enthalten oder zu den häufigsten
Passwörtern gehören; die Meldung nennt den Grund. Bestehende Passwörter bleiben
gültig (auch das Dev-Passwort oben — für den Produktivbetrieb ändern).

**Login-Sperre.** Fehlversuche werden dreifach gezählt: je **Name und
Adresse** (5 in 15 Minuten, dann 15 Minuten gesperrt), je **Adresse** (30,
gegen das Durchprobieren vieler Namen) und je **Name über alle Adressen**
(50, gegen verteiltes Durchprobieren). Wer einen Nutzernamen kennt, kann den
echten Nutzer an dessen eigener Adresse also nicht aussperren. Hinter einem
Reverse-Proxy auf demselben Rechner zählt als Adresse der letzte
`X-Forwarded-For`-Eintrag. Die Zähler liegen im Speicher (ein Neustart setzt
sie zurück). Meldet die Anmeldung „too many failed login attempts“, 15
Minuten warten oder von einer anderen Adresse anmelden.

**Tokens.** Löscht man einen Nutzer, wird sein Anmelde-Token sofort
ungültig (auch wenn später ein Nutzer gleichen Namens angelegt wird);
„Abmelden überall“ und Passwortwechsel widerrufen ebenfalls alle Tokens.

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
generiert der Orchestrator beim ersten Start selbst ein Secret
(Datei `OMP_AUTH_JWT_SECRET_FILE`, Default `../data/auth-jwt-secret`) und legt es
**in der Datenbank** ab (Tabelle `app_secrets`,
`internal/auth.LoadOrCreateSharedSecret`): Ein bestehendes Datei-Secret wird
dabei übernommen (bestehende Anmeldungen bleiben gültig), und **alle
Orchestrator-Instanzen eines Clusters benutzen dasselbe Secret** — ein Token
gilt also auch nach einem Leader-Wechsel. Für
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

**Sicherer Kommandokanal.** Bei der Registrierung bekommt der Host einen
eigenen Schlüssel (in seiner `state.json`, Rechte 0600); alle Kommandos des
Orchestrators an diesen Host sind damit signiert (Abschnitt 5b). Eine
**Erstinstallation braucht dafür nichts zu tun**; der Wizard-Ablauf bleibt
gleich.

Kein vorgefertigtes Installations-Artefakt für `omp-host-agent`
existiert bisher (kein curl-Installer) — das erzeugte Skript geht davon
aus, dass das OMP-Repo auf dem Zielhost liegt (`./install.sh --media`).
Es baut den Agent selbst (`go build` läuft dabei **in** `host-agent/`,
Ergebnis `bin/omp-host-agent`), lädt `deploy/dev/mxl.env` und setzt
`OMP_HOST_AGENT_CATALOG_PATH` auf `deploy/catalog.json`. Ohne Katalog
meldet der Agent „unknown catalog type … on this host“.

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

**Neustart/Reboot:** Instanzen, die beim Beenden des Orchestrators bzw. des Rechners liefen
(nicht abgestürzte Prozess-Nodes), werden nach dem Start unter ihrer alten ID wieder gestartet:
lokale vom jeweiligen Orchestrator selbst (Feld `origin`, damit sich zwei Cluster-Orchestratoren
nicht gegenseitig die Instanzen wegnehmen), Instanzen auf Host-Agents vom Cluster-Leader. Der Agent
meldet eine noch laufende Instanz idempotent zurück; ist ein Host noch nicht erreichbar, versucht der
Leader es bis zu 10 Minuten lang alle 10 s. Podman-Instanzen werden nicht automatisch wiederhergestellt.

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
**Geplante Sicherung.** Der Orchestrator (als Raft-Leader) legt selbst alle 24
Stunden eine Sicherung an, wenn die neueste älter ist (`OMP_BACKUP_INTERVAL_HOURS`,
`0` schaltet es ab; ein Fehlschlag steht laut im Log und wird nach einer Stunde
wiederholt). Nicht enthalten sind Schlüsselmaterial (Update-Schlüssel, mTLS-CA)
und ein Fremdziel — beides separat sichern.

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

**Signierte Host-Kommandos.** Der Orchestrator signiert jedes Kommando an einen Host-Agent (HMAC, Schlüssel je Host). Neue Hosts bekommen den Schlüssel bei der Registrierung, ältere erhalten ihn automatisch, sobald sie online sind; danach lehnt der Agent unsignierte, abgelaufene oder wiederholte Kommandos ab. `OMP_HOST_AGENT_REQUIRE_KEY=1` am Agent verweigert Kommandos schon vor der Schlüsselübergabe. Hat ein Agent einen falschen Schlüssel (Kommandos scheitern mit „unauthorized“), `cmdKey` aus seiner `state.json` entfernen und den Agent neu starten. Den Schlüssel eines Hosts wechseln: `POST /api/v1/admin/hosts/<id>/rotate-key` (Host muss online sein). Das Token-Secret für Anmeldungen liegt in der Datenbank (`app_secrets`) und wird beim ersten Start aus `OMP_AUTH_JWT_SECRET_FILE` übernommen — alle Orchestrator-Instanzen eines Clusters nutzen dasselbe. `OMP_METRICS_TOKEN` schützt `/metrics` mit einem Bearer-Token.

**Container-Images und ihre Digests.** Alle Images stehen mit Tag **und** Digest in `deploy/images.env`
(`repo:tag@sha256:…`) — ein bewegtes Tag kann so nicht still ein anderes Image liefern. Auffrischen:
`./deploy/dev/update-image-pins.sh` (löst die Tags neu auf und trägt die Digests in `images.env`, Quadlets,
CI und das Patroni-Dockerfile ein), nur prüfen: `make image-pins-check`. Eine neue Version: zuerst das Tag in
`images.env` ändern, dann das Skript ausführen. Bei **Offline-Installationen** (Images per `podman load`)
legt der Installer `.run/images-unpinned` an; dann gilt nur das Tag.

**Erst-Administrator (Bootstrap-Modus).** Solange kein Nutzer existiert, ist
die API offen, damit sich der erste Administrator anlegen lässt — aber nur
für Anfragen vom Rechner selbst (Loopback, ohne Proxy-Kopfzeilen). Von einem
anderen Rechner aus: `OMP_BOOTSTRAP_OPEN=1` setzen (nur für die Erstanlage,
danach entfernen) oder `OMP_BOOTSTRAP_TOKEN=<geheim>` setzen und den Aufruf
mit Kopfzeile `X-Bootstrap-Token: <geheim>` senden. Hinter einem Reverse-Proxy
auf demselben Rechner zählt die Anfrage als entfernt.

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
`prometheus/client_golang` (Minimal-Dependency-Regel) — standardmäßig
unauthentifiziert wie `/healthz` (Netzwerk-Isolation ist hier die erwartete
Absicherung). Mit `OMP_METRICS_TOKEN=<geheim>` verlangt `/metrics` dagegen
`Authorization: Bearer <geheim>` (in Prometheus: `authorization:
credentials: <geheim>`).

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

**Hosts-Tabelle zeigt „⏱ Uhr“** — die Systemuhr des Hosts ist nicht synchronisiert
(NTP/PTP) und/oder der TAI-Versatz ist nicht gesetzt (`CLOCK_TAI` entspricht dann UTC,
derzeit 37 s daneben). MXL-Zeitstempel und Schaltzeitpunkte (`takeAt`) stimmen dann
nicht mit anderen Hosts überein. Abhilfe: chrony mit `leapsectz right/UTC` (setzt den
TAI-Versatz) bzw. `ptp4l`/`phc2sys`; prüfen mit `timedatectl` und `chronyc tracking`.
Der Hinweis erscheint nur bei Host-Agents, die die Uhr melden.

**Befehle an einen Host scheitern mit „unauthorized: …“** — der Host-Agent
prüft die Signatur der Kommandos (Abschnitt 5b). „command is not signed“:
das Kommando stammt nicht vom Orchestrator (oder der Orchestrator hat für
diesen Host noch keinen Schlüssel geliefert — er tut das automatisch, sobald
der Host online ist, spätestens nach etwa 20 Sekunden). „signature invalid“:
Orchestrator und Agent haben verschiedene Schlüssel (z. B. weil die
Datenbank neu aufgesetzt wurde). Abhilfe: im Agent `cmdKey` aus seiner
`state.json` entfernen, den Agent neu starten — der Orchestrator liefert
den Schlüssel neu. Planmäßig wechseln: `POST
/api/v1/admin/hosts/<id>/rotate-key`.

**Erstanlage des Administrators von einem anderen Rechner scheitert (401)** —
auf einer frischen Installation ist die API nur lokal offen. Entweder per
`localhost`/SSH-Tunnel arbeiten oder `OMP_BOOTSTRAP_OPEN=1` setzen (nach der
Erstanlage wieder entfernen), siehe Abschnitt 5b.

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
| **omp-video-mixer-me** | Vollwertiger M/E-Bildmischer mit einstellbarer Anzahl Mischerebenen (1–8, Node-Option `OMP_ME_LEVELS` bzw. Feld „Mischerebenen“ der Rolle im Workflow-Editor, Standard 1; jede Ebene mit eigenem Programm-/Preset-Bus und eigenem MXL-/NMOS-Ausgang, gemeinsamer Quellen-Pool, die PGM-Ausgänge der anderen Ebenen stehen als Quellen bereit): Programm-/Preset-Bus (Kreuzschiene), Cut/Auto-Transition, DVE-Kanal (PIP), Downstream-Keyer (DSK, Fill+Key), Tally-Signalisierung. Unterstützt seit D8 Teil 3 `setOutputDelay()` (Latenzbudget-Ausgleich, s. Abschnitt 9.7). |
| **omp-audio-mixer** | Digitales Audiomischpult mit dynamischer Kanalanzahl, Gain/EQ (LO/MID/HIGH) und Kompressor pro Kanal, Master-Limiter, automatischem Audio-Follow-Video (Auswahl der Bildmischer/Tally-Geber global und je Videoquelle, `setTallyFilter`; `setVideoContext` nimmt optional `giver`), globalem Dialog „Szenen & Automation“. |
| **omp-mxf-player** | MXF-Datei-/Playlist-Player, cue/take-bedient (A/B-Slot), mit Programmgruppen-Audio-Shuffle. Kann zusätzlich eine entdeckte Live-MXL-Quelle als Playlist-Item abspielen. Programmgruppen und Shuffle-Presets kommen aus dem gemeinsamen Audio-Dokument (Administration → Audio-Ausgabe, s. Benutzerhandbuch 10c); der frühere eigene Editor im Flow-Editor entfällt. Liest MXF-Audiolabels nach SMPTE ST 377-4/-41 (MCA): Kanalsprache, Inhalt und Klasse werden als Tags in die Audio-Regeln übernommen (Vorrang vor dem Spurschema) und im Panel angezeigt. |
| **omp-mxf-player-direct** | Diagnose-/Direkt-Variante von omp-mxf-player: kein A/B-Slot-Cue/Take, keine Playlist — spielt beim Start automatisch genau eine Datei direkt in die MXL-Ausgänge. Ausgangsgruppen und Shuffle-Presets kommen aus dem gemeinsamen Audio-Dokument (Administration → Audio-Ausgabe); „Einstellungen neu laden“ im Panel wendet Änderungen live an. Der frühere lokale Editor mit eigener Zustandsdatei entfällt. |
| **omp-channel-player** | Isel-freier, einzweigiger Player ohne Playlist/Cue-Take — `load()` ersetzt den aktuellen Inhalt sofort. Gedacht als eine von zwei physischen Quellen am Video-Mixer-Crosspoint für echten Crossfade. Audio: je Zielgruppe des Ausgabeprofils ein eigener Sender (Standard: Programmton, Hörfilm/AD, Originalton, Dolby E, 5.1), Zuordnung je Event per `audioMapping`, Ersatzregeln bei fehlenden Spuren (s. `docs/PLAYOUT-AUTOMATION.md` §7a). |
| **omp-multiviewer** | Zeigt entdeckte MXL-Videoquellen automatisch als Kachel-Raster. Läuft er als Rolle eines Workflows, zeigt er **nur die Quellen dieses Workflows** (Node-Tag `urn:x-omp:workflow`); manuell gestartet zeigt er alle. Reines Monitoring, kein weiterverkettbares Programmsignal. |
| **omp-viewer** | Zeigt einen ausgewählten MXL-Videostream als MJPEG-Vorschau im Browser. |
| **omp-playout-automation** | Automatisierte Playlist-Sequenzierung: steuert zwei omp-channel-player-Kanäle (A/B) und einen Bildmischer fern (Auto/Hold-Modus, Next/Next-Live/Stop, Cart-/Interrupt-Assets), echtes Xfade zwischen den beiden Kanälen. Keine eigene Medienpipeline. |
| **omp-scte35** | Erzeugt SCTE-35-Marker (`splice_insert` Out/In/Cancel, `time_signal` mit Segmentation Descriptor) und SCTE-104-Nachrichten für Werbeblöcke, mit Vorlauf und auf Bildgrenzen genau. Ausgabe: Verlauf/Parameter, UDP, Sidecar-Transportstrom (UDP/SRT, PID wählbar) und **SCTE 104 als ANC** (`video/smpte291`, DID 0x41/SDID 0x07) in einem MXL-Daten-Flow, der als NMOS-Sender erscheint. Der Playout-Automator steuert ihn und kann Werbeblöcke **automatisch aus der Event-Klassifikation** kennzeichnen (Schalter „Werbeblöcke automatisch kennzeichnen“ im Automations-Panel). Einstellungen: Node-Optionen (Admin → Einstellungen), Details in `docs/PLAYOUT-AUTOMATION.md`. |
| **omp-ograf** | Rendert EBU-OGraf-Grafikvorlagen (Bauchbinde, Laufband u. a.) als Fill+Key-MXL-Ausgang für den Bildmischer-DSK. Mehrere Grafiken können gleichzeitig on air stehen: die Liste „Auf Sendung“ im Panel zeigt sie, ein Klick öffnet die Grafik im Editor (Update live, Aus), „Weiter“ erscheint nur bei mehrstufigen Vorlagen. |
| **omp-sign-avatar** | Gebärdensprach-Avatar (DGS), Rust, Software-Rasterizer (kein Browser/GPU): Eingang „Untertitel“ (`video/smpte291`, Text-Strom oder CEA-608, IS-05 wie bei Viewer/Multiviewer), Ausgang Fill+Key (zwei `video/v210`-Flows, 25 B/s, Größe klein/mittel/groß). Pipeline: Sätze trennen → Wörter über Lexikon (JSON, `verified`-Pflicht) und Regeldatei (JSON) auf Glossen → Schlüsselfolge mit Überblendung; Rückfälle: Buchstabieren, Text im Bild (eingebaute 5×7-Schrift) bei zu vielen Unbekannten; Warteschlange mit Aufholen/Verwerfen (`OMP_SIGN_MAX_DELAY_S`). Rendert nur bei geänderter Haltung und nur, solange ein Leser den Flow liest (`gate_on_consumers`). Parameter `auto`, `speed`, `text`, readonly `state`, `subtitle`, `lexicon`, `renderMs`; Methoden `translate`, `speak`, `stop`. Prüfwerkzeug `--lexicon-check`/`--sheet`, Messung `--bench`. Konzept und Messwerte: `docs/GEBAERDENSPRACHE.md`. |
| **omp-recorder** | Nimmt eine per Kreuzschiene angeschlossene MXL-Quelle (Video/Audio) als Matroska-Datei auf (`record.start`/`record.stop`). Endet der Dateiname auf `.mxf`, entsteht MXF (H.264 + PCM 24 Bit); ist zuvor `record.mcaPlan` (JSON, Format wie `mxf-mca inject`) gesetzt, werden nach dem Stopp MCA-Labels (ST 377-4/-41) in die Datei geschrieben. Ausschließlich MXL als Eingang, keine Capture-Karte. „Warm, unabonniert" bis zum Start — keine Lese-Pipeline im Leerlauf. **Kanalplan (Kapitel 45):** `OMP_RECORDER_AUDIO_INPUTS=n` (1–8) legt die Audio-Empfänger „Audio“, „Audio 2“ … an; `record.audioPlan` (JSON `{"channels":[{"input":0,"channel":1,"gainDb":-3},{"input":null}]}`, `input` = Nummer des Audio-Empfängers ab 0, `null` = Stille) ordnet Kanäle mehrerer Quellen den Ausgabekanälen der Datei zu (`audiomixmatrix` je Quelle + `audiomixer`); ohne Plan wird der Ton des ersten Empfängers unverändert aufgenommen. MXF: bis 32 Kanäle PCM, Matroska/AAC: bis 8. |
| **omp-device-hub** | Erkennt die lokalen Video- (V4L2) und Audio-Geräte (ALSA/USB) des Hosts mit stabiler Geräte-ID (Seriennummer, sonst USB-Position) und Fähigkeiten. Je Gerät schaltet man „Anbieten“ ein: dann entsteht ein MXL-Flow mit NMOS-Sender (Tag `source.live`), der wie jede andere Quelle in der Kreuzschiene erscheint. Standard: alles aus; die Auswahl bleibt über Neustarts erhalten, ein abgezogenes Gerät wird beim Wiederanstecken wieder angeboten (gleiche Sender-ID). **Audio-Ausgänge** (Wiedergabe der Soundkarte, Kopfhörer/Lautsprecher) erscheinen als eigener Eintrag „Audio-Ausgang“: eingeschaltet wird daraus ein NMOS-Empfänger, der in der Kreuzschiene mit einer Audioquelle verbunden wird und dann über die Karte abspielt (Mehrkanal wird auf die Kanalzahl der Karte gemischt). Status je Gerät: Aus / Startet / Sendet / Wartet auf Verbindung / Nicht angesteckt / Fehler. Ein Node je Host, nicht je Gerät. |
| **omp-capture-card** | Karten-Node für SDI/IP-Capture-Karten (Blackmagic DeckLink, AJA, Matrox-SDK-Karten über ein vom Betreiber gebautes Plugin), **eine Instanz je Karte**. Der Start-Assistent zeigt die erkannten Karten des Hosts mit Eingang/Ausgang je Anschluss (frei/belegt); gewählt wird per `OMP_CARD_PORTS` (`0:in,0:out,1:in`), der Hersteller per `OMP_CARD_VENDOR` (`decklink`, `aja`, `custom`, Kap. 76). Je Eingang ein Video- und ein Audio-Sender, je Ausgang drei IS-05-Empfänger (Video, Audio, ANC/Untertitel); Duplex-Anschlüsse bekommen beides. Port-IDs im Inventar: `<Hersteller>-<N>-in|out`. Modus, Gerät und Zusatzwerte (`OMP_CARD_PROPS`) werden per Introspektion gegen das Plugin geprüft; fehlendes Plugin oder unbekannte Eigenschaft = klarer Startfehler. Erkennung: `omp-capture-card --list-cards` (Host-Agent-Aktion `list-cards`, Orchestrator `GET /api/v1/hosts/{id}/cards`). Nicht an Hardware geprüft. KONA IP im ST-2110-Betrieb läuft stattdessen über NMOS und das ST-2110-Gateway. |
| **omp-vfa** | Video folgt Audio (Kapitel 46), Go, reine Steuerebene ohne Ports. Liest Pegel des Tonmischers (SSE `levelsUrl`, `inDb` je Kanal) und Gesichtszustände (NATS `vfa.vision.state`), entscheidet mit `internal/engine` (Sprecher + Haltezeit, Mindestdauer, Totale bei Stille, Gesichtsposition je bestätigter Einstellung) und schaltet den Bildmischer per `crosspoint.select`+`crosspoint.cut` über den Orchestrator-Proxy (Service-Token; Typ als Control-Plane in `main.go` angemeldet). Meldet die Vorschau-URLs der Kameras auf `vfa.vision.config`. Einrichtung per „Person spricht jetzt“ (Lernfenster 5 s, Kandidaten aus `engine.Learner`). Persistenz `OMP_VFA_DATA` (JSON). |
| **omp-vfa-vision** | Gesichtszählung je Kamera, Go ohne CGO (Pico-Kaskade `esimov/pigo`, eingebettet). Holt alle 300 ms `GET /preview` der Kamera-Nodes (Kameraliste kommt von `omp-vfa` über `vfa.vision.config`, alternativ `OMP_VFA_CAMERAS`), bestimmt Position/Größe und veröffentlicht `{camera_id, faces:[{center_x, center_y, size_percent}]}` auf `vfa.vision.state`. Keine Identitäten. |
| **omp-intercom** | Intercom (Kapitel 47), Rust. Eigener Mix-Kern `mix.rs` (20-ms-Takt, Matrix Teilnehmer×Kanal, Mix-minus über Kanalsummen O(N·C), Ducking für IFB/Priorität, Begrenzer, Sprecher-Erkennung, VOX), je Teilnehmer eine **statische** WebRTC-Pipeline (`peer.rs`: webrtcbin sendrecv Opus + Datenkanal `ctl`, Panel-Seite `GET /panel?token=`, Signalisierung `POST /offer?token=`), gemeinsame Opus-Encoder je identischem Hörsignal (`encpool.rs`), Stille wird nicht gesendet, Browser-DTX für ruhende Mikrofone. Zustand/Befehle über den Datenkanal (JSON, Ping alle 2 s, Ablauf 8 s). MXL: IS-05-Receiver „Programm n“ und MXL-Sender „Intercom Mix n“ (`mxl_io.rs`). **Der Node ist ein eigener Dienst (Kapitel 48):** er hält Kanäle, Teilnehmer, Vorlagen und Gäste selbst (`admin.rs`, Datei `OMP_INTERCOM_DATA`, Standard `data/omp-intercom.json`, atomar geschrieben) und meldet sich dem Dienst-Gateway des Orchestrators mit einem Manifest (`GET /service.json`, Routen unter `/service/…`, nur mit Dienst-Token `OMP_SERVICE_TOKEN`). Eine Sicherungskopie liegt in der Datenbank des Orchestrators (Datensicherung); startet der Node leer (Datei verloren, anderer Host), spielt das Gateway sie wieder ein. `PUT /config` (rohes Node-Dokument) gibt es nur noch ohne Dienst-Token (Entwicklung/Tests). `GET /status`, Stream Deck über die Vertragsrollen `deck.state`/`deck.command` (`/service/deck/{party}`, `docs/CONTRACT-INTERCOM.md`). On-Air: Parameter `onAir` + Tally-Bus (`OMP_INTERCOM_ONAIR_SOURCES`). Start-Optionen: `OMP_INTERCOM_PROGRAM_INPUTS`/`_MIX_OUTPUTS`/`_LATENCY_MS`, HTTPS wegen Browser-Mikrofon (`OMP_HTTPS`). |
| **omp-xy-panel** | X/Y-Kreuzschiene als Bedienpanel (reine Steuerebene, keine Ports): links Quellen, rechts Ziele, je mit Home-/Hoch-Taste durch Workflows, Gruppen (verschachtelt) und „Nicht zugewiesen“. Schaltet über `POST /api/v1/graph/edges` (Rechte, Audit, Schleifenschutz des Kerns gelten). Per „⇉ Alle Ports“ schaltet es einen ganzen Node (z. B. Video+Audio) auf einen anderen Node: Paarung nach gemeinsamen Tags, sonst 1:1 je Medientyp (`planTagRoutes`). Zusätzlich Bouquets (mehrere Schaltungen mit einem Take, im Layout `xy-bouquets` gespeichert) und tag-basierte Schaltung über `GET /api/v1/sources` und `GET /api/v1/sinks` (Tags an Quelle **und** Senke, z. B. `role.commentator`). Für Desktop und Smartphone/Tablet (Layout folgt der Breite der Kachel). |
| **omp-scope** | Passives Messgerät (Tap, kein Ausgang) auf je einen optionalen MXL-Video- und -Audio-Flow. **Bild:** Waveform + Vektorskop als ein Messbild, mittleres Luma, Bild-zu-Bild-Differenz. **Ton:** Peak/RMS, EBU-R-128-Lautheit (M/S/I/LRA), True Peak in dBTP nach ITU-R BS.1770 samt R-128-Konformitätsampel (−23 ±0,5 LUFS, ≤ −1 dBTP). **Timing:** Transportlatenz, Jitter, Ist-/Soll-Kadenz, ausgelassene Grains und Reader-Neuaufsetzer je Flow — gerechnet aus den MXL-Ursprungszeitstempeln der Grains, nicht aus Ankunftszeiten; daraus der **A/V-Versatz (Lipsync)**, bewertet nach EBU R 37 (Ton höchstens 40 ms vor, 60 ms nach dem Bild). **Flow:** die Deklaration aus der MXL-Domain (Media-Type, Rate, Bittiefe, Farbraum, Interlace, Grouphint, Grain-Größe, Datenrate), bewusst getrennt vom gemessenen Ist angezeigt. **Signalüberwachung:** Schwarzbild, Standbild und Stille als gehaltene Alarme (1/2/2 s Haltezeit). Ein negativer Latenzwert ist kein Anzeigefehler, sondern die Aussage „der Schreiber stempelt in die Zukunft" — s. `docs/decisions.md` Nachtrag 226. |
| **omp-scaler** | Skaliert/konvertiert eine per Drag & Drop angeschlossene MXL-Videoquelle auf ein fest konfiguriertes Zielformat (Rollen-Format, s. Workflow-Formular) und schreibt sie als zweiten MXL-Flow zurück — gleicht Auflösungs-/Framerate-Unterschiede zwischen Quellen und Zielen aus. Unterstützt seit D8 Teil 3 `setOutputDelay()` (Latenzbudget-Ausgleich, s. Abschnitt 9.7). **Bekannte Einschränkung:** in einer Kette Quelle→Scaler→Ziel innerhalb desselben Workflow-Starts kann die letzte Verbindung (Scaler→Ziel) zu früh ausgelöst werden, bevor der Scaler seinen eigenen Ausgangs-Flow fertig aufgebaut hat — betroffene Verbindung im Flow-Editor einmal neu ziehen behebt es sofort (s. `docs/decisions.md` Nachtrag 109). **Bildratenwandlung:** Standard `videorate` (verwirft/verdoppelt Bilder); Option `OMP_FRAMERATE_CONVERSION=blend` überblendet stattdessen (optionales Plugin `avvideofilter`, ohne Plugin Rückfall auf `videorate`, +9…43 ms Latenz je nach Ratenpaar, bei gleicher Rate keine Stufe; Installation und Offline-Weg: `docs/INSTALLATION.md` §9). |
| **omp-playout-buffer** | **Ausgangs-Anker** am Ende eines Workflows (Kapitel 39): hält Bild und Ton um eine einstellbare Tiefe (`bufferMs`, Standard 2500 ms) zurück und schreibt sie als eigene, nie abreißende MXL-Flows (Video + Audio) im Rollen-Format. Fällt der Vorgänger aus (Absturz, Quellwechsel, Hot-Standby-Übernahme), läuft der Ausgang zuerst aus dem Puffer weiter (bis zur Puffertiefe ohne sichtbare Störung), danach mit Standbild oder Schwarz und Stille — der nachgelagerte Sender bleibt verbunden. Standard je ein Empfänger/Sender für Video und Audio; optional mehrere parallele Spuren (`videoTracks` 1–8, `audioTracks` 1–16, Start per `OMP_VIDEO_TRACKS`/`OMP_AUDIO_TRACKS`, zur Laufzeit änderbar, je Spur eigener Ring; `status` enthält `videoTracks`/`audioTracks` mit Verbindung, Füllstand, Zählern). Zeitstempel werden neu und streng monoton auf dem MXL-Raster vergeben; Bild und Ton bleiben nach jedem Splice im ursprünglichen Verhältnis (gemessen mit der Marker-Quelle). Nach einem überbrückten Ausfall wird die Tiefe mit `refillPermille` (Standard 1 %) wieder aufgebaut. Speicher fest begrenzt (`OMP_BUFFER_MAX_MIB`; 1080p25 bei 2,5 s ≈ 0,45 GiB, ≈ 28 % eines Kerns). Parameter: `bufferMs`, `resumeMs`, `holdMode` (`last`/`black`), `refillPermille` sowie Messwerte (`state` = `fill`/`run`/`hold`, `fillMs`, `bufferBytes`, `underruns`, …, gesammelt in `status`). Unterstützt `setOutputDelay()` (der Ausgleich wird zur Tiefe addiert, Bild + Ton gemeinsam) und ist im Katalog als `anchor` markiert: im Workflow-Editor nicht löschbar, die Start-Vorschau warnt bei fehlendem Anker. Eine Rollen-Verbindung auf den Puffer verbindet Bild **und** Ton. **Grenzen:** nur unkomprimierter Pfad (MXL-Frames); die Latenz im Katalog (63 Bilder) gilt für 25 Bilder/s und 2,5 s Standardtiefe; Kanalzahl/Abtastrate des Ton-Ausgangs sind fest (`OMP_AUDIO_CHANNELS`, 48 kHz). Details: `ARCHITECTURE.md` §30, `docs/BENUTZERHANDBUCH.md` Abschnitt 10f. |
| **omp-pipeline-controller** | Bettet `PIPELINE CONTROLLER` (eigenständiges, produktiv gelaufenes Broadcast-Playout-System) als OMP-Node ein — komplettes Web-UI + REST-API laufen unverändert im Container, das Bedienpanel zeigt es als `<iframe>`. Registriert zwei NMOS-Sender (Programm-Video/-Audio) und zwei Receiver für echte MXL-Ein-/Ausgänge im DMF-Verbund; per IS-05-Connect verkabelte Live-Quellen werden automatisch in PIPELINE CONTROLLERs eigene Live-Quellen-Liste eingetragen. Keine eigenen OMP-Play/Stop/Cue-Methoden — Playlist/Grafik/Player/Assets/Voiceover/Record bleiben ausschließlich über PIPELINE CONTROLLERs eigenes UI bedient. |

### 9.2 Gateway-Nodes (Standort-/Fremdgeräte-Anbindung)

| Node | Funktion |
|---|---|
| **omp-2110-gateway** | Bidirektionale Brücke SMPTE-ST-2110-Multicast (LAN, Fremdgeräte) ⇄ OMP-internes MXL-Fabric. Gerichtet je Instanz (Ingest/Output), SDP- oder Einzel-Env-Var-Konfiguration. |
| **omp-aes67-gateway** | Audio-Pendant zu `omp-2110-gateway`: AES67/RTP-Multicast (Dante im AES67-Modus, Ravenna, Lawo/Merging u. a.) ⇄ MXL, inkl. SAP-Discovery (RFC 2974) für Fremdströme, die nur darüber auffindbar sind. |
| **omp-srt-gateway** | Bidirektionale Brücke ST 2110 (LAN) ⇄ SRT (WAN) für Beitrag/Distribution über verlustbehaftete Netze. Gerichtet je Instanz (Uplink/Downlink). |
| **omp-webrtc-gateway** (Typen `omp-webrtc-gateway-camera` / `-monitor`) | Anbindung gewöhnlicher Handys per Browser, ohne App: **Kamera** nimmt Handy-Kamera/-Mikrofon per WebRTC (WHIP, H.264 + Opus) auf und speist sie als MXL-Flow ein; **Monitor** sendet einen gewählten MXL-Flow als Retourbild (WHEP) zurück. Zugang nur über Einladungslinks/QR-Codes. Ausführlich: Benutzerhandbuch, Abschnitt „Handy-Kamera“.  **Tally:** Die Kamera-Seite zeigt ON AIR, wenn Bildmischer/Switcher/Tally-Geber (`OMP_TALLY_GIVER`, z. B. 2110-Ausgang) sie auf Sendung schalten (`OMP_TALLY_SOURCES` schränkt Auslöser ein; Tally-Ereignis `omp.tally.<node>` trägt den Absender `src`). Feste HTTPS-Ports per `OMP_HTTPS_PORT` (9443/9444). |
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


### 9.9 Orchestrator-Module (Playout, Audio-Ausgabe, Cloud, File Eingangskontrolle/Review, Stream Ingest)

> **Dienste statt Module (Kapitel 48):** Das Intercom ist kein Modul mehr, sondern ein Dienst im Node `omp-intercom`. Das Modul `extsvc` ist das generische Dienst-Gateway (`/api/v1/ext/<dienst>/…`): es prüft Anmeldung und Funktionsrecht, reicht die Identität an den Dienst weiter und bringt dessen Rechte, Tabs, Kacheln und Metriken in die Plattform. Anleitung: `docs/MODULE-SCHREIBEN.md` §7.

Domänenfunktionen sind **Module** des Orchestrators, keine Kernfunktion: **Playout** (Channels, Trigger, As-Run, Preflight),
**Audio-Ausgabe** (Audio-Regeln), **Cloud** (§9.8) und **File Eingangskontrolle/Review** (Datei-QC, Review-Player, Conform, Metadaten — `docs/ENTWURF-FILE-QC.md`) und **Stream Ingest** (geplante Live-Aufnahme mit Ressourcenplanung — `docs/ENTWURF-INGEST.md`). Jedes Modul bringt seine Routen, ggf. Hintergrundjobs, Kennzahlen und seine
Oberfläche mit; `GET /api/v1/modules` zeigt Stand und Oberfläche (die Shell baut ihre Tabs daraus). Mit der Umgebungsvariable
`OMP_MODULES_DISABLE=cloud,audio-rules` (Komma-Liste der Namen `cloud`, `playout`, `audio-rules`, `review`, `ingest`) lässt sich ein Modul abschalten:
seine Routen antworten dann mit 404 und der Tab fehlt — der Kern (Nodes, Graph, Hosts, Workflows, Rechte) läuft unverändert. Ein Modul,
dessen Start oder Migration scheitert, steht als `failed` im Manifest, die übrigen laufen weiter. Eigene Module: `docs/MODULE-SCHREIBEN.md`.

### 9.10 Stream Deck (WebHID, Browser-Bedienpult)

Rein clientseitig (`ui/shell/streamdeck/`), kein Server-Anteil. Modelle (Hersteller-HID-Beschreibung, `docs/ENTWURF-STREAMDECK.md` §1): XL und XL 2022
(8×4, 96 px, 180° gedreht), 15-Tasten-Familie (5×3, 72 px, 180°), „+“ (4×2, 120 px, 4 Dials, Streifen 800×100, ungedreht) und **„+ XL“** (PID `0x00C6`,
9×4, 112 px, 6 Dials, Streifen 1200×100, **90° gegen den Uhrzeigersinn**, auch die Streifen-Teilbilder).

| Datei | Aufgabe |
|---|---|
| `models.ts`, `protocol.ts` | Modelltabelle (inkl. `rotation`), Chunking/Dekodierung der HID-Berichte (rein, getestet) |
| `transport.ts`, `sim-device.ts` | WebHID (`HidLike`) bzw. Simulator, der dieselbe Schnittstelle erfüllt |
| `render-logic.ts`, `draw.ts`, `plot-*.ts` | Fingerprint + Debounce, Canvas → JPEG (Text mit Umbruch/Auto-Größe), Kurven (EQ/Dynamik) über mehrere Tasten/Streifen |
| `broker*.ts`, `session.ts` | Kopfzeile (Home + Tabs), Eingabeverteilung, 1,5-s-Takt `refresh()` (nicht gestapelt, 8-s-Limit), Tab-Register der Konsole, Wiederverbinden |
| `adapters/` | `video-mixer`, `audio-mixer`, `ograf`, `xy-panel` (je `*-logic.ts` + Deno-Test); sonst `autoraster*.ts` |

**X/Y-Adapter: Ebenen und Bouquets.** *Ebenen:* die obere Zeile jeder Seite zeigt „Alle“ + die Ordner (Workflows, Gruppen, „Nicht zugewiesen“) wie das Panel; ein Ordner begrenzt Quellen bzw. Ziele auf seine Nodes (rekursiv), „↑ Hoch“ geht eine Ebene zurück, Nodes der Ebene sind als Kategorie wählbar. Ohne Ordner bleibt es bei „Alle“ + je Node. *Bouquets* (aus dem Layout `xy-bouquets`, im Panel angelegt) liegen auf eigenen Seiten hinter der Kreuzschiene (Taste unten rechts „Seite weiter“): Taste = Bouquet schalten (grün/rot: geschaltet/mit Fehlern), „↶ Zurück“ oben links macht die letzte Schaltung innerhalb von 60 s rückgängig (auch Take/Trennen). Bündel-Bouquets brauchen ein gewähltes Ziel (dessen Node ist das Bündel-Ziel). Auf kleinen Decks hängen die Bouquet-Seiten an die Seiten der Kreuzschiene an.

*Ebenen per Dial:* am „+ XL“ (6 Dials) wählen Dial 5/6 die Ebene von Quellen/Zielen (Drehen = Eintrag, Druck = öffnen/zurück); am „+“ (4 Dials) schaltet ein Druck auf Dial 3 in den Ebenen-Modus (Dial 1/2 steuern dann die Ebenen, nochmal Dial 3 = zurück zur Auswahl). *Bouquet aufzeichnen:* auf der Bouquet-Seite „● Aufzeichnen“ (nur mit `configure`, ab 8 Tasten): Take/AUTO sammeln Schaltungen, ohne zu schalten (TAKE zeigt „● n“); „■ Speichern“ legt ein Bouquet „Deck HH:MM:SS“ an (im Panel umbenennbar), „✕ Verwerfen“ bricht ab.

**Flow-Editor (Engineering):** Nutzer mit globalem `configure` bekommen am Stream Deck den Tab „Flow“ mit derselben Kreuzschiene wie am X/Y-Panel (`FlowCanvas.streamDeck` → `xyPanelAdapter(coreIO())`); Operatoren sehen ihn nicht (`whoami.canConfigure`).

**X/Y-Adapter (`adapters/xy-panel*.ts`):** Ab 5 Spalten × 3 Zeilen Spaltenlayout (Quellen links, Steuerspalte Mitte, Ziele rechts; oberste Zeile je Seite = Kategorien „Alle“ + je Node, „mehr ▶“ zum Blättern), darunter das Seitenlayout (Quellen/Ziele/Steuerung) ohne Kategorien. Schalten über `POST/DELETE /api/v1/graph/edges`; der Kern verlangt dafür `operate` auf dem Node des Ziel-Receivers (Node-Bindung oder Workflow-Rolle) oder global `configure` (`requireVerbOnReceiver`, `orchestrator/internal/httpapi/auth_middleware.go`). **Rechte pro Nutzer oder pro Panel:** (1) pro Nutzer/Gruppe über Bindungen (`operate` auf dem Ziel-Node oder der Workflow-Rolle); (2) pro Panel: ein Engineering-Nutzer (`configure`) schaltet im Panel die Option „Schalten über dieses Panel freigeben“ ein (Layout `xy-panel-grants`, `{"grants":{"<Panel-Instanz>":true}}`); dann darf jeder mit `operate` auf **diesem Panel-Node** (auch über Gruppen) darüber beliebige Ziele schalten. Panel und Stream-Deck-Adapter senden dafür den Header `X-OMP-Panel`; ohne Freigabe oder Bedienrecht bleibt es bei 403. `GET /api/v1/auth/whoami` liefert zusätzlich `canConfigure`.

Adapter-Auflösung (3 Stufen, `adapters/index.ts`): Eigenschaft `streamDeck` am Element des Node-UI-Bundles → Fabrik nach Elementname in der Shell → Auto-Raster
aus dem Descriptor. **Eigene/fremde Nodes:** `docs/NODE-TUTORIAL.md`, Abschnitt „Stream-Deck-Belegung für einen eigenen Node“.
Linux: udev-Regel auf dem **Bedienplatz-Rechner** (`make streamdeck-udev [ARGS=--dry-run|--remove]`, `deploy/dev/streamdeck-udev.sh`,
`./install.sh --streamdeck-udev`; siehe auch `docs/INSTALLATION.md` §6). Testseite/Simulator: `/streamdeck-sim` (Orchestrator-Route; eingebettet im Panel der Konsole).
Der Simulator skaliert auf die Fensterbreite. Tests: `cd ui && deno test -A shell/streamdeck`.

## 10. Echtzeit-Betrieb (deterministisches Timing, Host-Tuning)

OMP selbst setzt **keine** Echtzeit-Prioritäten, Affinitäten oder Speichersperren;
das Timing hängt vom Betriebssystem ab (GStreamer-Streaming-Threads, MXL-Lesen/
Schreiben, Netzwerk-Interrupts). Dieses Kapitel beschreibt, was man am Host
einstellt, damit Ausgänge ohne Aussetzer, Frame-Drops oder Jitter laufen.
Reihenfolge nach Wirkung: **(1) BIOS, (2) Kernel-Bootparameter, (3) CPU-Aufteilung,
(4) Interrupts/NIC, (5) Prioritäten der Dienste, (6) Speicher, (7) Zeitbasis,
(8) Messen.** Schritte 1–4 und 6–8 bringen den größten Teil; harte
SCHED_FIFO-Prioritäten (5) sind optional und bei Fehlern gefährlich.

> **Wichtig:** Nichts davon ist im Repo automatisiert oder auf der
> Zielhardware gemessen. Jede Änderung einzeln einführen und mit §10.8 belegen.
> Ein Referenz-Setup „Proxmox + RT-Kernel" wurde noch nicht getestet.

### 10.1 BIOS/UEFI

- C-States tief aus (C-State-Limit C1 oder „Maximum Performance"), Package-C-States aus
- Frequenz fest: Governor `performance`, Turbo nach Wahl (für Determinismus eher aus), SpeedStep/Cool'n'Quiet aus
- Hyper-Threading/SMT: für harte Echtzeit aus oder die Schwester-Threads der Medien-Kerne mit isolieren
- Energiesparen von PCIe (ASPM), „Memory Power Saving" aus
- System Management Interrupts (SMI) minimieren (Hersteller-Option „Legacy USB", „Platform Firmware Performance" deaktivieren)
- VT-x/VT-d (IOMMU) an, wenn VMs oder PCIe-Passthrough gebraucht werden
- Auf Mehr-Sockel-Systemen: NUMA an, Medien-Nodes und NIC auf **demselben** Knoten halten

### 10.2 Kernel (Proxmox-Host)

Drei Stufen, aufsteigend im Aufwand:

1. **Standard-pve-Kernel mit Voll-Preemption** (empfohlen als Start; kein
   Paketwechsel): Der pve-Kernel ist `PREEMPT_DYNAMIC`, der Modus lässt sich per
   Bootparameter wählen. In `/etc/default/grub` (oder `/etc/kernel/cmdline`
   bei systemd-boot/ZFS-Root, danach `proxmox-boot-tool refresh`):
   `preempt=full threadirqs`
2. **Debian-RT-Kernel** (`PREEMPT_RT`, seit Kernel 6.12 im Hauptzweig):
   `apt install linux-image-rt-amd64` (Debian 13), danach im Bootmenü wählen.
   Einschränkungen auf Proxmox: Der RT-Kernel ist von Proxmox **nicht
   unterstützt**; ZFS/DKMS-Module (z. B. NVIDIA, Mellanox-OFED) müssen zum
   Kernel passen, KVM funktioniert, ist aber im RT-Betrieb deutlich weniger
   durchsatzstark. Nur wählen, wenn Stufe 1 + CPU-Isolierung nicht reicht.
3. **Eigenes Gerät nur für OMP**: Läuft OMP direkt auf Debian 13 (ohne
   Proxmox, siehe `docs/INSTALLATION.md`), ist der RT-Kernel unproblematisch.
   Für harten Sendebetrieb ist das der einfachere Weg.

Prüfen: `uname -v` zeigt `PREEMPT_RT` bzw. `PREEMPT_DYNAMIC`; `cat /sys/kernel/debug/sched/preempt` zeigt `(full)`.

### 10.3 CPU-Aufteilung (Pinning, Isolierung)

Idee: wenige „Haushalts"-Kerne (Betriebssystem, Orchestrator, Datenbank, UI,
Interrupts) und dedizierte Medien-Kerne, auf denen nichts anderes läuft.
Beispiel 16 Kerne (0–15): Haushalt 0–3, Medien 4–15.

Bootparameter (zusätzlich zu §10.2):

```
isolcpus=managed_irq,domain,4-15 nohz_full=4-15 rcu_nocbs=4-15 \
rcu_nocb_poll irqaffinity=0-3 skew_tick=1 \
intel_pstate=disable processor.max_cstate=1 intel_idle.max_cstate=0 \
nosoftlockup tsc=reliable
```

(`intel_*` nur für Intel; bei AMD `amd_pstate=passive` bzw. weglassen.)

Dienste auf die Kerne legen (systemd, vererbt sich auf alle Kindprozesse – also
auch auf die Nodes, die Orchestrator bzw. Host-Agent starten):

```ini
# /etc/systemd/system/omp-host-agent.service.d/rt.conf   (Medien-Host)
[Service]
CPUAffinity=4-15
Nice=-10
LimitMEMLOCK=infinity
LimitRTPRIO=95
LimitNICE=-15

# /etc/systemd/system/omp.service.d/rt.conf              (Hauptrechner, Orchestrator/DB/NATS)
[Service]
CPUAffinity=0-3
```

`systemctl daemon-reload && systemctl restart omp-host-agent`. Hinweis: Der
Neustart des Agents beendet seine Nodes (siehe Kopfkommentar der Unit) – nur
in einem Wartungsfenster. Auch System-Dienste (`system.slice`, `user.slice`,
`init.scope`) auf Haushalt festnageln: `/etc/systemd/system.conf` →
`CPUAffinity=0-3`.

Pro Node gezielt (z. B. nur Mischer und Ausgang auf eigene Kerne): optionales
Katalog-Feld `realtime` am Eintrag in `deploy/catalog.json` (gilt für Orchestrator
und Host-Agent, nur `runner:"process"`):

```json
"realtime": { "cpus": "4-7", "policy": "fifo", "priority": 40 }
"realtime": { "cpus": "8,10-11", "nice": -10 }
```

`cpus` (taskset-Liste), `policy` (`other`|`fifo`|`rr`), `priority` (1–90, nur
fifo/rr), `nice` (−20…19, relativ zur Priorität des startenden Dienstes, nur ohne fifo/rr). Umgesetzt als Wrapper
`chrt`/`taskset`/`nice` vor dem Binary; die PID bleibt die des Nodes, Pinning
gilt ab dem ersten Thread. Nicht anwendbare Teile (CPU existiert auf diesem
Host nicht, `LimitRTPRIO`/`LimitNICE` fehlen, Werkzeug fehlt) werden mit einer
Warnung im Log weggelassen – die Instanz startet dann ungepinnt. Kerne sind
je Host verschieden: bei unterschiedlich großen Hosts den Eintrag nur dort
setzen, wo er passt, oder auf jedem Host `OMP_RT_DISABLE=1` setzen, der ihn
nicht nutzen soll. Wirkt auf neu gestartete Instanzen, nicht auf laufende.
Podman-Einträge (`runner:"podman"`) sind ausgenommen (dort `--cpuset-cpus`).

### 10.4 Interrupts und Netzwerkkarte

- `irqbalance` abschalten (`systemctl disable --now irqbalance`), IRQs von Hand:
  `for i in /proc/irq/*/smp_affinity_list; do echo 0-3 > $i 2>/dev/null; done`;
  die Queues der Medien-NIC bewusst auf **einen** nahen Kern legen
  (`/proc/interrupts` zeigt Namen, z. B. `eth1-TxRx-0`).
- NIC: `ethtool -C eth1 adaptive-rx off rx-usecs 0 tx-usecs 0` (keine
  Interrupt-Coalescing-Verzögerung), Ringe groß genug
  (`ethtool -G eth1 rx 4096 tx 4096`), Energiesparen aus
  (`ethtool --set-eee eth1 eee off`), LRO/GRO für Echtzeit-Medien ggf. aus.
- Getrennte NIC (oder VLAN + QoS) für Medien und für Verwaltung/Datenbank;
  Medienverkehr mit DSCP EF/AF41 markieren, am Switch priorisieren.
- Für ST 2110/PTP: Karte mit Hardware-Zeitstempel (`ethtool -T eth1` zeigt
  `hardware-transmit/receive`), Switch mit PTP-Boundary-/Transparent-Clock.
- Firewall-Verbindungsverfolgung (`conntrack`) für Medienports umgehen
  (`NOTRACK`), sie kostet Zeit pro Paket.

### 10.5 Thread-Prioritäten (optional, mit Vorsicht)

- **Reichen oft schon**: Pinning + `Nice=-10` (§10.3) + isolierte Kerne.
  Auf isolierten Kernen konkurriert ohnehin niemand.
- **SCHED_FIFO** für die zeitkritischen Threads (Ausgangsknoten, Mischer):
  `chrt -f -p 50 <tid>` je Thread (`ps -L -p <pid> -o tid,comm`), nie 99
  (reserviert für Kernel-Watchdog/Migration). Reihenfolge: Interrupt-Threads
  (`irq/…`, mit `threadirqs`) 80–90 > Medien-NIC-Threads 60 > OMP-Streaming-
  Threads 40–50 > alles andere normal. Setzt man `CPUSchedulingPolicy=fifo` +
  `CPUSchedulingPriority=40` in einem Drop-in, gilt das für **alle**
  Kindprozesse inkl. Datenbank/Orchestrator – nur bei dedizierter Medien-Maschine
  und mit Haushaltskernen (sonst Aushungern des Systems). Alternative:
  `CPUSchedulingResetOnFork=yes` im Drop-in und die Nodes einzeln per `chrt` anheben.
- **Gefahr**: Ein FIFO-Thread in einer Endlosschleife blockiert seinen Kern
  vollständig. Deshalb Haushaltskerne frei halten und `kernel.sched_rt_runtime_us`
  bei dem Standard 950000 belassen (die letzten 5 % gehören dem normalen
  Scheduler und halten SSH erreichbar).
- GStreamer hebt manche Threads über `rtkit` (nur wenn installiert) an; auf
  gepinnten Systemen ist das unnötig und unvorhersehbar – ggf. `rtkit` entfernen.

### 10.6 Speicher

- `vm.swappiness=0` und Swap aus (`swapoff -a`, Eintrag in `/etc/fstab`
  entfernen); kein Zram. Auf Proxmox kein RAM-Ballooning für OMP-VMs.
- Transparente Hugepages aus: `transparent_hugepage=never` (Bootparameter).
  Wer Hugepages für VMs will, reserviert sie statisch: `hugepagesz=1G hugepages=16`.
- `LimitMEMLOCK=infinity` (siehe §10.3), damit Medienprozesse Speicher sperren
  können; die MXL-Domain liegt unter `/dev/shm` (tmpfs im RAM) – bei NUMA auf
  den Medienknoten legen und genügend Größe im Mount (`size=`) vorsehen.
- `vm.min_free_kbytes` auf ca. 1 GiB setzen, damit der Kernel nicht unter
  Druck in Direct-Reclaim gerät; `vm.dirty_ratio=5`, `vm.dirty_background_ratio=2`
  (Plattenaufnahmen stören sonst Echtzeit-Threads).
- Kein NUMA-Balancing: `kernel.numa_balancing=0`.

### 10.7 Zeitbasis und Hintergrundlast

- Uhren: NTP genügt für Verwaltung (`chrony`); für ST 2110/AES67 echtes PTP
  (`ptp4l` + `phc2sys -s eth1 -c CLOCK_REALTIME`), siehe `OMP_PTP_DOMAIN`
  (`docs/decisions.md`, Kap. 19 Teil 2). Nicht gleichzeitig mit NTP-Steppen
  auf derselben Uhr arbeiten (`makestep` für Medien-Hosts aus).
- Kein Hintergrund-Lärm auf den Medienkernen: `fstrim.timer`, `apt-daily*`,
  `unattended-upgrades`, Virenscanner, Backup-Läufe und `make`-/`cargo`-
  Builds nur in Sendepausen oder auf den Haushaltskernen.
- Container-Dienste (Postgres, NATS, Registry) per `--cpuset-cpus=0-3` auf
  die Haushaltskerne (Quadlet: `PodmanArgs=--cpuset-cpus=0-3`).
- Energieverwaltung: `cpupower frequency-set -g performance`,
  `tuned-adm profile realtime-virtual-host` (Host) bzw. `realtime-virtual-guest` (VM)
  übernimmt viele der Einstellungen oben in einem Schritt.

### 10.8 Proxmox: VM oder LXC?

- **VM (KVM)**: `cpu: host`, vCPUs fest auf Host-Kerne legen
  (`qm set <id> --affinity 4-11`), `numa: 1`, Speicher fest (`balloon: 0`,
  optional Hugepages `hugepages: 1024`), VirtIO-Netz mit `queues=` ≥ 2 oder
  besser NIC per **PCIe/SR-IOV-Passthrough** (umgeht Host-Switch, liefert
  Hardware-Zeitstempel). Im Gast gelten dieselben Bootparameter (§10.2–10.3).
  Der Gast ist nur so deterministisch wie sein Host: den Host mit
  `isolcpus` freihalten, damit nichts anderes auf den VM-Kernen läuft.
- **LXC**: teilt den Host-Kernel (RT-Kernel wirkt direkt, kein
  Virtualisierungs-Jitter). CPU per `lxc.cgroup2.cpuset.cpus: 4-15`,
  Mehr Rechte: `lxc.prlimit.rtprio: 95`, `lxc.prlimit.memlock: unlimited`,
  Gerätezugriff auf `/dev/shm`-MXL-Domain und `/dev/dri` (GPU) bewusst
  durchreichen. Für harte Echtzeit meist die bessere Wahl gegenüber VM.
- Eine VM/Container pro Aufgabe ist okay, aber Orchestrator/Postgres und
  Medien-Nodes **nicht** auf denselben Kernen.

### 10.9 Messen und Abnehmen

Ohne Messung ist alles Vermutung. Immer unter realer Last (alle Kanäle des
Zielworkflows laufen, Browser mit Konsole offen):

```
apt install rt-tests linux-perf
# Latenz des Scheduler auf einem Medienkern, 30 min:
cyclictest -m -S -p 90 -i 200 -h 400 -D 30m --affinity 4-15
# Hardware-/Firmware-Störungen (SMI) aufdecken:
hwlat_detector  bzw.  cd /sys/kernel/tracing && echo hwlat > current_tracer
# Wer läuft auf den Medienkernen?
ps -eLo psr,pid,tid,cls,rtprio,ni,comm | awk '$1>=4' | sort -n
cat /proc/interrupts      # Zähler der Medienkerne dürfen kaum wachsen
```

Richtwerte (Abnahme): `cyclictest` Maximum **< 50 µs** (RT-Kernel, isoliert)
bzw. < 200 µs (pve-Kernel mit `preempt=full`); keine SMI-Ausschläge > 20 µs.
Dann in OMP selbst: `make soak` bzw. die Alarme (Kap. 6 im Benutzerhandbuch) über
24 h beobachten – Zähler für Frame-Drops/Underruns des Ausgangs-Nodes
müssen bei 0 bleiben. Bei Ausreißern: `perf sched record` / `trace-cmd`
zeigen, welcher Thread den Kern belegt hat.

### 10.10 Checkliste „perfekt laufen"

- [ ] BIOS: C-States/Turbo/ASPM/SMI wie §10.1, Firmware aktuell
- [ ] Kernel mit `preempt=full` oder RT (§10.2), `threadirqs`
- [ ] Haushalts-/Medienkerne getrennt, `isolcpus`/`nohz_full`/`rcu_nocbs` (§10.3)
- [ ] `irqbalance` aus, IRQs gepinnt, NIC ohne Coalescing (§10.4)
- [ ] Dienste per `CPUAffinity`/`Nice` platziert, ggf. FIFO einzeln (§10.3, §10.5)
- [ ] Swap aus, THP aus, `LimitMEMLOCK=infinity`, Hugepages nach Bedarf (§10.6)
- [ ] PTP/chrony sauber, kein Lärm auf Medienkernen (§10.7)
- [ ] Getrennte NIC/VLAN für Medien, DSCP + Switch-QoS, ggf. SR-IOV (§10.4, §10.8)
- [ ] `cyclictest` + 24-h-Soak unter Last bestanden und protokolliert (§10.9)
- [ ] Netzteil/USV, Kühlung (Thermal-Throttling zerstört Determinismus), Server-Hardware mit ECC

## 11. Mehr Kontext

- Architektur/Konzepte: `ARCHITECTURE.md` (Referenzdokument, wird bei jeder
  größeren Entscheidung fortgeschrieben)
- Umsetzungsplan/Status: `UMSETZUNG.md` (Status-Checkliste am Ende)
- Einzelentscheidungen/Blocker-Historie: `docs/decisions.md`
- Eigenen Node-Typ bauen (SDK-Tutorial): `docs/NODE-TUTORIAL.md`
