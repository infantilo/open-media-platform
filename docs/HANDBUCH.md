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
(`deploy/catalog.json`, nach `/tmp/host-catalog.json` kopiert, weil
`/tmp` einen Neustart nicht übersteht).

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
| **omp-switcher** | Einfacher Video-Umschalter zwischen automatisch entdeckten MXL-Quellen per Knopf — kein Programm-/Preset-Bus, kein Mischeffekt (funktionaler Vorläufer des Video Mixer M/E). |
| **omp-video-mixer-me** | Vollwertiger M/E-Bildmischer: Programm-/Preset-Bus (Kreuzschiene), Cut/Auto-Transition, DVE-Kanal (PIP), Downstream-Keyer (DSK, Fill+Key), Tally-Signalisierung. Unterstützt seit D8 Teil 3 `setOutputDelay()` (Latenzbudget-Ausgleich, s. Abschnitt 9.7). |
| **omp-audio-mixer** | Digitales Audiomischpult mit dynamischer Kanalanzahl, Gain/EQ (LO/MID/HIGH) und Kompressor pro Kanal, Master-Limiter, automatischem Audio-Follow-Video. |
| **omp-player** | Datei-/Playlist-Player, cue/take-bedient. Zwei Katalog-Profile desselben Binaries: `omp-player-video` (Video inkl. Audio) und `omp-player-jingle` (nur Audio, für Jingles/Musik). Kann seit [C21] zusätzlich eine entdeckte Live-MXL-Quelle als Playlist-Item abspielen. |
| **omp-multiviewer** | Zeigt alle im Netz entdeckten MXL-Videoquellen automatisch als Kachel-Raster. Reines Monitoring, kein weiterverkettbares Programmsignal. |
| **omp-viewer** | Zeigt einen ausgewählten MXL-Videostream als MJPEG-Vorschau im Browser. |
| **omp-playout-automation** | Automatisierte Playlist-Sequenzierung: steuert einen bereits laufenden Player und Bildmischer fern (Auto/Hold-Modus, Next/Next-Live/Stop, Cart-/Interrupt-Assets). Keine eigene Medienpipeline. |
| **omp-ograf** | Rendert eine EBU-OGraf-Grafikvorlage (Bauchbinde, Laufband u. a.) als Fill+Key-MXL-Ausgang für den Bildmischer-DSK. |
| **omp-media-library** | Datei-Katalog mit technischen Metadaten (`ffprobe`) und Mark-In/Out-Segmenten. Keine eigene Medienpipeline. |
| **omp-recorder** | Nimmt eine per Kreuzschiene angeschlossene MXL-Quelle (Video/Audio) als Matroska-Datei auf (`record.start`/`record.stop`). Ausschließlich MXL als Eingang, keine Capture-Karte. „Warm, unabonniert" bis zum Start — keine Lese-Pipeline im Leerlauf. |
| **omp-scaler** | Skaliert/konvertiert eine per Drag & Drop angeschlossene MXL-Videoquelle auf ein fest konfiguriertes Zielformat (Rollen-Format, s. Workflow-Formular) und schreibt sie als zweiten MXL-Flow zurück — gleicht Auflösungs-/Framerate-Unterschiede zwischen Quellen und Zielen aus. Unterstützt seit D8 Teil 3 `setOutputDelay()` (Latenzbudget-Ausgleich, s. Abschnitt 9.7). **Bekannte Einschränkung:** in einer Kette Quelle→Scaler→Ziel innerhalb desselben Workflow-Starts kann die letzte Verbindung (Scaler→Ziel) zu früh ausgelöst werden, bevor der Scaler seinen eigenen Ausgangs-Flow fertig aufgebaut hat — betroffene Verbindung im Flow-Editor einmal neu ziehen behebt es sofort (s. `docs/decisions.md` Nachtrag 109). |

### 9.2 Gateway-Nodes (Standort-/Fremdgeräte-Anbindung)

| Node | Funktion |
|---|---|
| **omp-2110-gateway** | Bidirektionale Brücke SMPTE-ST-2110-Multicast (LAN, Fremdgeräte) ⇄ OMP-internes MXL-Fabric. Gerichtet je Instanz (Ingest/Output), SDP- oder Einzel-Env-Var-Konfiguration. |
| **omp-aes67-gateway** | Audio-Pendant zu `omp-2110-gateway`: AES67/RTP-Multicast (Dante im AES67-Modus, Ravenna, Lawo/Merging u. a.) ⇄ MXL, inkl. SAP-Discovery (RFC 2974) für Fremdströme, die nur darüber auffindbar sind. |
| **omp-srt-gateway** | Bidirektionale Brücke ST 2110 (LAN) ⇄ SRT (WAN) für Beitrag/Distribution über verlustbehaftete Netze. Gerichtet je Instanz (Uplink/Downlink). |
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

## 10. Mehr Kontext

- Architektur/Konzepte: `ARCHITECTURE.md` (Referenzdokument, wird bei jeder
  größeren Entscheidung fortgeschrieben)
- Umsetzungsplan/Status: `UMSETZUNG.md` (Status-Checkliste am Ende)
- Einzelentscheidungen/Blocker-Historie: `docs/decisions.md`
- Eigenen Node-Typ bauen (SDK-Tutorial): `docs/NODE-TUTORIAL.md`
