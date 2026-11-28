# OMP-Handbuch (Dev-Betrieb)

> English version: [`MANUAL.md`](MANUAL.md) (same section numbers). Benutzerhandbuch: [`BENUTZERHANDBUCH.md`](BENUTZERHANDBUCH.md), English [`USER-MANUAL.md`](USER-MANUAL.md).

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

**Windows Active Directory / LDAP (Kapitel 92).** Mit `OMP_LDAP_URL` am Orchestrator melden sich
Verzeichnisnutzer mit ihrem Windows-Namen und -Passwort an; OMP speichert kein Passwort. **Alle Einstellungen
sind in der Oberfläche pflegbar** (Administration → Wartung → Einstellungen → Reiter „Active Directory“; die Gruppenzuordnung liegt unter Administration → Gruppen:
Speichern wirkt sofort ohne Neustart, „Testen“ prüft die eingetragenen Werte vorher, andere Orchestratoren des
Clusters übernehmen Änderungen binnen ~20 s; das Dienstkonto-Kennwort wird verschlüsselt gespeichert und braucht
`OMP_STORAGE_SECRET_KEY`). Solange dort nichts gespeichert ist, gelten die Umgebungsvariablen: Ablauf: Suche des
Nutzers (Dienstkonto) → Bind mit dessen DN und Passwort → Gruppen lesen (bei AD verschachtelt, OID
1.2.840.113556.1.4.1941). Der Nutzer wird beim ersten Login angelegt (Kennzeichen „AD“ in der Nutzerliste),
seine **Verzeichnisgruppen** werden bei **jeder** Anmeldung auf **OMP-Gruppen** abgebildet (Administration →
Gruppen → „Active Directory / LDAP“: Verzeichnisgruppe, Name oder DN, → OMP-Gruppe). Rechte hängen wie
bisher an den OMP-Gruppen; nur abgebildete Gruppen werden vom Verzeichnis geführt, von Hand gepflegte
Mitgliedschaften in anderen Gruppen bleiben. Einstellungen (Umgebung des Orchestrators):

| Variable | Bedeutung |
|---|---|
| `OMP_LDAP_URL` | `ldaps://dc1.firma.de:636` (mehrere durch Komma = Ausfallreihenfolge); leer = aus |
| `OMP_LDAP_BASE_DN` | Suchbasis, z. B. `DC=firma,DC=de` (Pflicht) |
| `OMP_LDAP_BIND_DN`, `OMP_LDAP_BIND_PASSWORD` | Dienstkonto (nur lesen) für die Suche |
| `OMP_LDAP_USER_FILTER` | Vorgabe: `(&(objectCategory=person)(objectClass=user)(\|(sAMAccountName={user})(userPrincipalName={user})))` — Anmeldung mit `hans` oder `hans@firma.de` |
| `OMP_LDAP_USER_ATTR` | Attribut des OMP-Namens, Vorgabe `sAMAccountName` |
| `OMP_LDAP_GROUP_BASE_DN`, `OMP_LDAP_GROUP_FILTER` | Gruppensuche; Vorgabe `(&(objectClass=group)(member:1.2.840.113556.1.4.1941:={dn}))` (verschachtelte Gruppen) |
| `OMP_LDAP_REQUIRED_GROUP` | optional: nur Mitglieder dieser Gruppe (Name oder DN) dürfen sich anmelden |
| `OMP_LDAP_CA_FILE` | PEM der Firmen-CA (leer = Systemzertifikate) |
| `OMP_LDAP_STARTTLS=1` | bei `ldap://` auf TLS umschalten |
| `OMP_LDAP_ALLOW_PLAIN=1` | Klartext erlauben — **nur Labor**, Passwörter laufen offen |
| `OMP_LDAP_TIMEOUT_S` | Zeitlimit je Anfrage, Vorgabe 8 |

Regeln: **lokale Konten haben Vorrang** und bleiben als Notzugang nutzbar (fällt das Verzeichnis aus, kommt
man mit dem lokalen Administrator hinein). Ein Verzeichnisname, der einem lokalen Konto gleicht, wird
abgewiesen. Solange es noch **keinen** Nutzer gibt (Erst-Einrichtung), ist die Verzeichnis-Anmeldung aus —
zuerst den lokalen Administrator anlegen. Das Passwort eines Verzeichnisnutzers lässt sich in OMP nicht
setzen. Ein im Verzeichnis gesperrter/gelöschter Nutzer kommt nicht mehr hinein; bereits ausgestellte
Sitzungen laufen bis zu ihrem Ablauf weiter (dann in der Nutzerliste löschen oder „Sitzungen widerrufen“).
Gruppenänderungen im Verzeichnis wirken ab der **nächsten Anmeldung**. Die Login-Sperre schützt auch vor dem
Durchprobieren gegen das AD (sonst würde das AD-Konto gesperrt). Der Test „Verbindung testen“ bindet nur das
Dienstkonto.

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
  make nodes   # baut alle Katalog-Nodes nach nodes/target/release (Liste aus catalog.json)
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

Verhalten bei Störungen (Datenbank, NATS, Cluster, Host, Schlüssel): [`betrieb/STOERUNGEN.md`](betrieb/STOERUNGEN.md).

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
vollständige Konzept steht in `docs/entwuerfe/ENTWURF-SYSTEM-UPDATE.md`.

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
make update-bundle UPDATE_VERSION=2026.10.1
```
Enthalten: Orchestrator (mit Versionsstempel), Supervisor, Host-Agent,
UI-Bundle und alle im Katalog referenzierten Node-Programme aus
`nodes/target/<NODES_PROFILE>` (Standard `release`, dorthin baut `make nodes`
alle Katalog-Nodes). Die Version muss numerisch
aufsteigen (Standard: Datum + Uhrzeit). Zusätzliche Optionen (Migrationen,
Mindestversion, Hinweistext) über `UPDATE_BUNDLE_ARGS` bzw. direkt mit
`cd tools/update-bundle && go run . pack -h`; `go run . verify -pub <Schlüssel> <Paket>`
prüft ein Paket auf der Kommandozeile.

**Cluster-Rolling-Update (Kap. 84).** `go run . pack … -rolling-safe` setzt im
Manifest `rollingSafe: true`; nur solche Pakete nimmt der Cluster-Rollout an.
Das Merkmal ist eine Zusage des Paketbauers: (1) Migrationen rein additiv
(Expand/Contract), das alte Programm läuft gegen das neue Schema; (2) keine neue
Raft-FSM-Befehlsart (`cluster.KnownCommandTypes`, der Test `fsm_compat_test.go`
schlägt bei jeder Ergänzung an und erzwingt die Entscheidung). Ablauf und
Entscheidungen: `docs/entwuerfe/ENTWURF-SYSTEM-UPDATE.md` §11. Technik: Rollout-Zustand in
Tabelle `cluster_rollouts` (Migration 0056), Treiber `internal/clusterupdate`
läuft nur auf dem Leader (`runWhileLeader`); Mitglieder werden über interne
Routen `/api/v1/internal/cluster-update/{info,fetch,apply}` angesteuert
(Authentisierung: HMAC `omp-cluster-update-v1` aus dem gemeinsamen
JWT-Geheimnis; `apply` trägt die Raft-Amtszeit, ein abgelöster Leader wird mit
409 abgewiesen). Das Mitglied prüft das Paket mit dem **eigenen**
Vertrauensanker. Der Supervisor kennt dafür `POST /restart` (Neustart ohne
Paket). Follower melden ihre HTTP-Adresse selbst dem Leader (`…/internal/cluster-update/announce`, HMAC); so ist auch ein per `OMP_CLUSTER_PEERS` gegründeter Cluster ohne `Join` ansteuerbar. „Host-Agents zuerst“ (§11.5) ist der Pseudo-Schritt `@hosts` vor allen Mitgliedern. API: `GET/POST /api/v1/admin/cluster-rollout`, `…/resume`, `…/cancel`.

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

**Signierte Host-Kommandos.** Der Orchestrator signiert jedes Kommando an einen Host-Agent (HMAC, Schlüssel je Host). Neue Hosts bekommen den Schlüssel bei der Registrierung; der Agent lehnt unsignierte, abgelaufene oder wiederholte Kommandos ab. Ein Host **ohne** Schlüssel (registriert vor Einführung der Signatur) führt **keine** Kommandos aus. Abhilfe: den Host neu registrieren (`state.json` entfernen, neues Bootstrap-Token) oder den Agent einmalig mit `OMP_HOST_AGENT_ALLOW_NATS_PROVISION=1` starten — dann schickt der Orchestrator den Schlüssel über NATS; dabei gewinnt, wer zuerst sendet, also nur im vertrauenswürdigen Netz und die Variable danach wieder entfernen. `OMP_HOST_AGENT_REQUIRE_KEY=false` lässt unsignierte Kommandos zu (nur Entwicklung). Hat ein Agent einen falschen Schlüssel (Kommandos scheitern mit „unauthorized“), den Host neu registrieren (oder `cmdKey` aus seiner `state.json` entfernen und wie oben einmalig freigeben). Den Schlüssel eines Hosts wechseln: `POST /api/v1/admin/hosts/<id>/rotate-key` (Host muss online sein und über NATS mit TLS verbunden sein, `OMP_NATS_TLS_ENABLED=true`; sonst lehnt der Agent ab, weil der neue Schlüssel mitlesbar wäre). Das Token-Secret für Anmeldungen liegt in der Datenbank (`app_secrets`) und wird beim ersten Start aus `OMP_AUTH_JWT_SECRET_FILE` übernommen — alle Orchestrator-Instanzen eines Clusters nutzen dasselbe. `OMP_METRICS_TOKEN` schützt `/metrics` mit einem Bearer-Token.

**NATS mit Anmeldung und TLS (Produktion).** Die Vorlage `deploy/quadlets/omp-nats.container` startet nur mit
TLS (Client- und Cluster-Port), Anmeldung und ohne Platzhalter-Passwörter; Einrichtung in
`deploy/quadlets/README.md`. Zugangsdaten stehen in der Adresse (`OMP_NATS_URL=tls://benutzer:passwort@host:4222`),
`OMP_NODE_NATS_URL` gibt gestarteten Nodes den eingeschränkten Benutzer `node` (Orchestrator und Host-Agent;
ohne die Variable erben die Nodes die Zugangsdaten des Starters). Logs und Oberfläche zeigen die Adresse ohne
Zugangsdaten. Das Dev-Setup (`make up`) bleibt ohne Anmeldung.

**Node-API-Token je Host (optional).** Standardmäßig teilen sich alle Nodes ein API-Token. `OMP_NODE_TOKEN_SCOPE=host`
am Orchestrator (auf jedem Cluster-Mitglied) gibt jedem Host ein eigenes; zwischen Nodes sind dann nur noch die
Aufrufe möglich, die sie wirklich brauchen. Vor dem Einschalten Nodes und Host-Agents aktualisieren, danach **alle
Instanzen neu starten** — bis dahin antworten laufende Nodes dem Orchestrator mit 401. Ausschalten ebenso.

**Anmelde-Geheimnis schützen und wechseln.** Mit `OMP_AUTH_SECRET_WRAP_KEY_FILE` (Datei mit mindestens 32
Zufallszeichen, z. B. `openssl rand -hex 32 > /etc/omp/wrap.key`, 0600) speichert der Orchestrator die Geheimnisse
verschlüsselt (AES-256-GCM) in der Datenbank; ein vorhandener Klartextwert wird beim Start umgeschrieben. **Alle**
Cluster-Mitglieder brauchen dieselbe Datei, ohne sie startet der Orchestrator danach nicht mehr — Datei getrennt
aufbewahren (sie liegt auch im verschlüsselten Schlüsselbündel der Sicherung, `OMP_BACKUP_PASSPHRASE`). Die lokale
Datei `OMP_AUTH_JWT_SECRET_FILE` enthält weiter den Startwert im Klartext. Signaturschlüssel wechseln ohne
Massen-Abmeldung: `docs/betrieb/STOERUNGEN.md` Abschnitt 8 (nicht bei fest gesetztem `OMP_AUTH_JWT_SECRET`).

**Datenbank-Cluster in Produktion.** Die Quadlets für etcd und Patroni verlangen TLS mit Zertifikaten (etcd:
Client- und Peer-Port; Patroni-REST: schreibend nur mit Zertifikat und Anmeldung) und eigene Passwörter aus
`/etc/omp/patroni.env`, auch für die Datenbankrolle `omp` (`OMP_DB_PASSWORD`). Einrichtung und Umstellung:
`deploy/quadlets/README.md`. Orchestrator und Supervisor brauchen bei `https` die Variable
`OMP_POSTGRES_PATRONI_CA_FILE`. Das Dev-Setup bleibt unverändert.

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

SSE-Kennzahlen im Einzelnen: `omp_sse_clients` (alle offenen Ereignis-Ströme,
auch die internen Abonnenten des Orchestrators wie Alarm-Mail und Zeitleiste),
`omp_sse_clients_identified` (nur Browser mit bekanntem Benutzer),
`omp_sse_clients_by_user{user="…"}` (je Benutzer),
`omp_sse_clients_with_midi` / `omp_sse_clients_with_streamdeck` (Browser, die ein
MIDI-Pult bzw. Stream Deck melden, auch Simulatoren),
`omp_sse_client_kicks_total` (vom Admin getrennte Clients seit Prozessstart)
und `omp_sse_dropped_events_total`. Wer verbunden ist, zeigt Administration →
Verbundene Clients; per API `GET /api/v1/admin/clients` (Liste mit `id`,
`user`, `remoteIp`, `userAgent`, `since`, `devices`) und `POST
/api/v1/admin/clients/{id}/disconnect` (Rumpf `{"endSessions":true}` beendet
zusätzlich alle Anmeldungen des Benutzers; ohne baut der Browser die Verbindung
selbst wieder auf), beide nur für Admins. Die Geräte (`devices.midi`, `devices.streamDeck`)
meldet der Browser selbst per `PUT /api/v1/clients/devices` (Rumpf `cid`, `midi`,
`streamDeck`; die Kennung `cid` hängt er als `?cid=` an den Ereignis-Strom); der
Server ordnet sie nur Verbindungen desselben Benutzers zu.

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
| **omp-hls-source** | HLS-Eingang: holt einen HTTP-Live-Streaming-Strom (`.m3u8`, http/https) und schreibt Video und Ton als MXL-Flows; verbindet bei Fehlern selbst neu. Siehe BENUTZERHANDBUCH 10c-2b. |
| **omp-mxl-bridge** | MXL-Domain-Brücke: kopiert einen Flow (Video oder Audio) aus einer MXL-Domain in eine andere, **ohne Umwandlung** (gleiches Format; Umwandlung optional per `OMP_BRIDGE_CONVERT`). Blockierendes Lesen, wartet per inotify auf Quellen, die später erscheinen. Best Practice: Abschnitt 9.3a. |
| **omp-avdelay** | Echter A/V-Delay für Bild und Ton (MXL → MXL, dieselbe Domain): Bild um ganze Bilder (`delay.videoFrames`, Obergrenze `OMP_AVDELAY_MAX_VIDEO_FRAMES`, Standard 25), Ton auf das Sample genau (`delay.audioMs`, gleitet mit `delay.slewPermille` ohne Sprung); alles zur Laufzeit änderbar. Ändert nur die Zeit, nie das Format (direkte Kopie, kaum CPU; abweichende Quelle wird abgelehnt, ein später erscheinender Quell-Flow wird per inotify erkannt). Anzeige: `delay.videoMs`, `delay.audioCurrentMs`, `delay.offsetMs` (Ton minus Bild, positiv = Ton später). Als Funktion „A/V-Delay“ im MCR einsetzbar (Abschnitt 10k, „Austauschbare Funktionen“). |
| **omp-audio-split** | Ton-Teiler: teilt einen Mehrkanal-Ton-Flow (z. B. 16 Spuren, `audio/float32`, 48 kHz) in einzelne Ausgangs-Flows, etwa 1/2 Stereo-Programm, 3/4 internationaler Ton, 9 Kommentar, damit z. B. der Audiomischer jeden Ausgang einzeln über IS-05 bezieht. Je Ausgang ein eigener Sender (Bezeichnung = Ausgangsname). Reiner Kanalkopierer: bitgleich, Sample-Index bleibt, Datenkanäle (nicht-PCM) gehen unverändert durch, ein Quellkanal darf in mehreren Ausgängen stehen. Ausgänge beim Start über `OMP_SPLIT_OUTPUTS` (JSON `[{"name":"Programm","channels":[1,2]},…]`, ohne Angabe je zwei Kanäle ein Ausgang aus `OMP_SPLIT_INPUT_CHANNELS`, Standard 16); `split.outputs` hängt Kanäle zur Laufzeit um (Namen und Kanalzahlen bleiben). Anzeige: `inputChannels`, `mode`, `flowing`, `outputFlowIds`. Im MCR als Funktion „Ton-Teiler“ je Leitung. |
| **omp-audio-matrix** | Audio-Matrix: Kreuzschiene mit frei konfigurierbaren, zur Laufzeit änderbaren Ein- und Ausgängen (`audio/float32`, 48 kHz). Jeder Eingang ist ein Empfänger mit Kanal-Labels, jeder Ausgang ein eigener Sender/Flow (Mono bis 64 Kanäle) mit Namen und Kanal-Labels (IS-04-Source `channels[]`: `label`, `symbol` nach VSF TR-03 Anhang A). Kreuzpunkte ordnen Eingangskanäle Ausgangskanälen zu: ein Kreuzpunkt ohne Gain ist eine **bitgleiche Kopie** (kaum CPU, Sample-Index bleibt), mehrere Quellen oder ein Gain (−120…+24 dB) werden **summiert** (nur dieser Kanal rechnet; keine stille Begrenzung, Übersteuerung zählt `overs`). Teiler (1 → n) und Kombinierer (n Quellen → z. B. ein 16-Kanal-Flow) sind Sonderfälle. Grenzen: 16 Eingänge, 32 Ausgänge, 64 Kanäle, 16 Quellen je Kanal. Konfiguration als JSON im Parameter `matrix.config` (Start: `OMP_MATRIX_CONFIG`; Prüfung vor Anwendung, Fehler in `matrix.error`), Lesen: `matrix.status` (Eingänge mit Signal-Anzeige, Ausgänge mit Sender-/Flow-ID, `overs`). Routing, Gain, Labels, Namen wirken ohne Unterbrechung; ändert sich die Kanalzahl eines Ausgangs, entsteht ein **neuer Flow** (gleiche Sender-ID), der Orchestrator aktiviert angeschlossene Empfänger dabei selbst neu (`graph.Service.Rewire`). Zustand über `GET/POST /state` (Konfiguration plus Empfänger-/Sender-IDs: Verbindungen überstehen Stop/Start). Alarm `matrix-input-silent`, wenn ein verbundener Eingang 6 s kein Signal liefert. Bedienfeld mit Kreuzschiene im Node-Fenster. In der MCR als Funktion „Ton-Matrix“ je Leitung (`normalize.audioMatrix`). |
| **omp-contribution** | Leitungseingang (Kap. 106.6, Katalog `omp-contribution-in`): `srtsrc` (SRT-Internet-Draft draft-sharabayko-srt-01; Caller/Listener/Rendezvous) → `tsdemux` → `decodebin` je Strom → MXL-Flows im **nativen** Format. Der Ausgang wird beim ersten dekodierten Bild gebaut (zwei Pipelines, Muster `omp-srt-gateway/autobridge`), bei Rasterwechsel mit denselben Flow-IDs neu. Ton: bis zu 8 PIDs (`contrib.audioPids` oder PID-Reihenfolge), je Stereo auf 48 kHz, ein Tonfluss mit der Summe der Kanäle (2 PIDs = 4 Kanäle). Schreibbare Parameter `contrib.uri`, `contrib.mode`, `contrib.latencyMs`, `contrib.streamId`, `contrib.audioPids` (Änderung = Neuaufbau); lesbar `contrib.state` (connecting/playing/reconnecting/error), `rttMs`, `lossPermille`, `retransmits`, `bitrateKbps`, `inputFormat`, `audioChannels`, `lastError`. RIST (`rist://host:port[,host:port…]`, Simple Profile TR-06-1 über `ristsrc`, Bündelung `bonding-addresses`) und Relay des Original-TS (`contrib.relayUri`, `contrib.relayMode`, byte-identisch) sind umgesetzt; Mitschnitt nur als dekodierter MXL-Fluss über den Ingest. **Rückleitung** (`OMP_CONTRIB_DIRECTION=out`, Katalog `omp-contribution-out`, Kap. 106.11): IS-05-Empfänger Ton + Bild (MXL) → AAC / optional H.264 → `mpegtsmux` → `tsparse alignment=7` → SRT oder RIST; Parameter `contrib.uri/mode/latencyMs/streamId/audioBitrateKbps/videoEnabled/videoBitrateKbps`, Ende-zu-Ende-Latenz lokal ≈ 457 ms (mit 200 ms SRT-Latenz). Der Eingang nimmt Ströme ohne Bild an (nur Tonfluss). Passphrase nur aus `OMP_CONTRIB_PASSPHRASE_FILE` (Rechte 0600, 10–79 Zeichen), nie in Adresse, Parameter oder Protokoll (eine Adresse mit `passphrase=` wird abgelehnt). Umgebung: `OMP_CONTRIB_URI`, `_MODE`, `_LATENCY_MS`, `_STREAMID`, `_AUDIO_PIDS`, `OMP_WIDTH/HEIGHT/FRAMERATE_*` und `OMP_CONTRIB_AUDIO_CHANNELS` nur als **NMOS-Deklaration** vor dem ersten Bild. |
| **omp-normalizer** | Hauskontrollraum-Normalizer (Kap. 106): vergleicht die `flow_def` je Zweig mit dem Hausformat (`normalize.houseFormat`, JSON, zur Laufzeit änderbar, Video/Ton getrennt) und kopiert bei Übereinstimmung **bitgleich mit erhaltenem Grain-Index** (`rawcopy`); nur bei Abweichung läuft die Wandlungskette (Größe, Rate, Halbbild auflösen/erzeugen über `deinterlace`/`interlace` in 8-Bit-4:2:2, Farbmatrix über `videoconvert` mit gesetzter `colorimetry`, Ton über `audiomixmatrix`/`audioresample`; Zuordnung `normalize.audioMap`). Die Ausgangs-Kennzeichnung (Farbraum/Übertragung) folgt dem Hausformat über `colorimetry::set_process_override`. `normalize.mode`: `auto` oder `copyOnly` (Abweichung = Alarm, keine Wandlung). Beide Werte sind schreibbare Parameter und überstehen Stop/Start. Bekannte Grenze: Halten nachgeschaltete Nodes den Ausgangs-Flow offen, kann ein geändertes Hausformat den Flow nicht ersetzen (Zustand `error`, Hinweis: Verbraucher trennen und neu verbinden). Übertragungsfunktion (SDR/HLG/PQ): `normalize.transferPolicy` (`house`/`warn`/`block`/`map`), `map` über austauschbare Stufe `normalize.mapBackend` (`builtin` = feste Mindest-Kennlinie auf Y ohne Qualitätsversprechen, sonst Fremdprozess nach Vertrag v1, `docs/entwuerfe/ENTWURF-MCR.md` §6). A/V-Messung: Methode `avsync.measure(seconds)` misst am Eingang mit Marker-Testsignal (Blip/Flash, Bibliothek `omp_mediaio::avmarker`), Ergebnis `avsync.measuredMs` in Normkonvention (positiv = Ton eilt dem Bild voraus), `avsync.confidence`, `avsync.method` (`marker`/`none`; ohne Marker kein Messwert). A/V-Ausgleich (nur im Kopierpfad): `avsync.mode` (`off`/`manual`/`once`, Standard `once`; `tracking` ist reserviert und wird abgelehnt), `avsync.manualMs`, `avsync.heldMs`, `avsync.deadbandMs`, `avsync.maxSlewPermille`, `avsync.freeze`; Methoden `avsync.apply` (letzten Messwert übernehmen und halten) und `avsync.reset`. Ton früh → Ton wird verzögert (Sample-genau, bitgleich versetzt); Ton spät → Bild um ganze Bilder (lokaler Ring), Rest im Ton. Änderungen im Betrieb gleiten ohne Sprung. Entwurf: `ARCHITECTURE.md` §33. Datenspur (ANC, Zeitcode, Untertitel): ein dritter Empfänger „Daten“ reicht einen Daten-Flow unverändert und mit gleichem Grain-Index in den eigenen Daten-Ausgang durch (`normalize.dataState`, `normalize.dataFlowing`). |
| **omp-switcher** | Einfacher Video-Umschalter zwischen automatisch entdeckten MXL-Quellen per Knopf. Die Quellen erscheinen als Menü: zuerst Workflows/Gruppen, darin Untergruppen und Quellen (Zurück-Knopf, Breadcrumb); „Nur eigene Gruppe“ beschränkt auf die Gruppe/den Workflow des Switchers samt Untergruppen. Nicht aktive Eingänge werden nur gedrosselt gelesen (geringe CPU-Last). Kein Programm-/Preset-Bus, kein Mischeffekt (funktionaler Vorläufer des Video Mixer M/E). |
| **omp-video-mixer-me** | Vollwertiger M/E-Bildmischer mit einstellbarer Anzahl Mischerebenen (1–8, Node-Option `OMP_ME_LEVELS` bzw. Feld „Mischerebenen“ der Rolle im Workflow-Editor, Standard 1; jede Ebene mit eigenem Programm-/Preset-Bus und eigenem MXL-/NMOS-Ausgang, gemeinsamer Quellen-Pool, die PGM-Ausgänge der anderen Ebenen stehen als Quellen bereit): Programm-/Preset-Bus (Kreuzschiene), Cut/Auto-Transition, mehrere PIP-Slots je Ebene (Szenen, z-Ordnung, Drehung/Trapez in den 2D-Slots, Klick-Fokus im PGM-Monitor; Optionen `OMP_PIP_SLOTS`, `OMP_PIP_2D_SLOTS`, `OMP_ME_PGM_MONITOR`), Downstream-Keyer (DSK, Fill+Key), Tally-Signalisierung. Unterstützt seit D8 Teil 3 `setOutputDelay()` (Latenzbudget-Ausgleich, s. Abschnitt 9.7). |
| **omp-audio-mixer** | Digitales Audiomischpult mit dynamischer Kanalanzahl, Gain/EQ (LO/MID/HIGH) und Kompressor pro Kanal, Master-Limiter, automatischem Audio-Follow-Video (Auswahl der Bildmischer/Tally-Geber global und je Videoquelle, `setTallyFilter`; `setVideoContext` nimmt optional `giver`), globalem Dialog „Szenen & Automation“. Zwei Oberflächen (klassisch und dichte „Konsole 2“ mit EQ-Graph, Dynamik, Routing und Kompaktmodus), umschaltbar in der Kopfzeile. |
| **omp-mxf-player** | MXF-Datei-/Playlist-Player, cue/take-bedient (A/B-Slot), mit Programmgruppen-Audio-Shuffle. Kann zusätzlich eine entdeckte Live-MXL-Quelle als Playlist-Item abspielen. Programmgruppen und Shuffle-Presets kommen aus dem gemeinsamen Audio-Dokument (Administration → Audio-Ausgabe, s. Benutzerhandbuch 10c); der frühere eigene Editor im Flow-Editor entfällt. Liest MXF-Audiolabels nach SMPTE ST 377-4/-41 (MCA): Kanalsprache, Inhalt und Klasse werden als Tags in die Audio-Regeln übernommen (Vorrang vor dem Spurschema) und im Panel angezeigt. |
| **omp-mxf-player-direct** | Diagnose-/Direkt-Variante von omp-mxf-player: kein A/B-Slot-Cue/Take, keine Playlist — spielt beim Start automatisch genau eine Datei direkt in die MXL-Ausgänge. Ausgangsgruppen und Shuffle-Presets kommen aus dem gemeinsamen Audio-Dokument (Administration → Audio-Ausgabe); „Einstellungen neu laden“ im Panel wendet Änderungen live an. Der frühere lokale Editor mit eigener Zustandsdatei entfällt. |
| **omp-channel-player** | Isel-freier, einzweigiger Player ohne Playlist/Cue-Take — `load()` ersetzt den aktuellen Inhalt sofort. Gedacht als eine von zwei physischen Quellen am Video-Mixer-Crosspoint für echten Crossfade. Audio: je Zielgruppe des Ausgabeprofils ein eigener Sender (Standard: Programmton, Hörfilm/AD, Originalton, Dolby E, 5.1), Zuordnung je Event per `audioMapping`, Ersatzregeln bei fehlenden Spuren (s. `docs/funktionen/PLAYOUT-AUTOMATION.md` §7a). |
| **omp-multiviewer** | Zeigt entdeckte MXL-Videoquellen automatisch als Kachel-Raster. Läuft er als Rolle eines Workflows, zeigt er **nur die Quellen dieses Workflows** (Node-Tag `urn:x-omp:workflow`); manuell gestartet zeigt er alle. Reines Monitoring, kein weiterverkettbares Programmsignal. |
| **omp-viewer** | Zeigt einen ausgewählten MXL-Videostream als MJPEG-Vorschau im Browser. |
| **omp-playout-automation** | Automatisierte Playlist-Sequenzierung: steuert zwei omp-channel-player-Kanäle (A/B) und einen Bildmischer fern (Auto/Hold-Modus, Next/Next-Live/Stop, Cart-/Interrupt-Assets), echtes Xfade zwischen den beiden Kanälen. Playlist als Datei **Laden / Anhängen / Speichern** (Methode `playlist.import` mit `documentJson` und `mode` = `replace`\|`append`, Parameter `playlistDocument`; Format `omp-playlist` Version 1, Beispiele `docs/examples/playlists/`). Keine eigene Medienpipeline. Mehrere Automationen in einem Workflow: jede bekommt als Ziele die Rollen, deren Name mit ihrem eigenen beginnt (`channel-a` → `channel-a-player-1`, `channel-a-player-2`, `channel-a-mixer`). |
| **omp-scte35** | Erzeugt SCTE-35-Marker (`splice_insert` Out/In/Cancel, `time_signal` mit Segmentation Descriptor) und SCTE-104-Nachrichten für Werbeblöcke, mit Vorlauf und auf Bildgrenzen genau. Ausgabe: Verlauf/Parameter, UDP, Sidecar-Transportstrom (UDP/SRT, PID wählbar) und **SCTE 104 als ANC** (`video/smpte291`, DID 0x41/SDID 0x07) in einem MXL-Daten-Flow, der als NMOS-Sender erscheint. Der Playout-Automator steuert ihn und kann Werbeblöcke **automatisch aus der Event-Klassifikation** kennzeichnen (Schalter „Werbeblöcke automatisch kennzeichnen“ im Automations-Panel). Einstellungen: Node-Optionen (Admin → Einstellungen), Details in `docs/funktionen/PLAYOUT-AUTOMATION.md`. |
| **omp-ograf** | Rendert EBU-OGraf-Grafikvorlagen (Bauchbinde, Laufband u. a.) als Fill+Key-MXL-Ausgang für den Bildmischer-DSK. Mehrere Grafiken können gleichzeitig on air stehen: die Liste „Auf Sendung“ im Panel zeigt sie, ein Klick öffnet die Grafik im Editor (Update live, Aus), „Weiter“ erscheint nur bei mehrstufigen Vorlagen. **Vorlagen-Bibliothek** (Knopf „Vorlagen bearbeiten…“ im Panel): Liste mit Suche, Neu/Duplizieren/ID ändern/Löschen, Import und Export als ZIP (Import auch als JSON-Paket), Reiter Allgemein (Manifest), Parameter (Schema als Feldliste) und Quelltext (alle Dateien, Hochladen von Bildern und Schriften). Geprüft wird nach dem offiziellen OGraf-v1-Schema; bearbeitete Vorlagen laden beim nächsten Einblenden neu. **Layout-Kopplung:** Elemente mit `data-ograf-zone="<id>"` werden live vermessen (Property `zones`); `layout.bind` lässt eine Zone einen PIP-Slot des Bildmischers führen (`kind` leer, Quelle Sender-ID oder `pst:N`) oder das Fenster des Paternoster-Übergangs setzen (`kind: window`, Vorlage `paternoster-frame`); im Panel gibt es dafür den Abschnitt **Layout-Kopplung (Bildmischer)**: je gemeldeter Zone Art, Mischer, Quelle und PIP-Slot wählen, „Koppeln“/„Lösen“, Anzeige des Zustands und des Nachlaufs. Bindungen überleben einen Neustart des Nodes (Workflow-Sicherung `/state`). Die Bindung trägt optional `templateId` (`layout.bind`/`layout.unbind`): sie gilt dann nur, solange die Ebene diese Vorlage zeigt (sonst ruht sie, `active: false` in `layout`); leer = jede Vorlage der Ebene (Altbestand). Vorlagen benennen ihre Fenster im Manifest im Vendor-Feld `v_omp_zones` (`[{id, name, slot?}]`; OGraf v1 erlaubt Zusatzfelder nur mit Präfix `v_`), der Node liefert sie als `zones` je Vorlage im Parameter `templates`. Die mitgelieferte PIP-Wand hat die Option `focusCover` (Standard an): das vergrößerte Fenster verdeckt Rahmen und Beschriftung der anderen, auch bei der Rückfahrt. Mitgelieferte Vorlagen werden in `data/ograf-templates/` beim Start ersetzt, wenn die installierte `version` kleiner ist als die des Programms. **Aktionen:** Methode `action {layerId, id}` löst eine `customAction` der stehenden Grafik aus (Panel-Knopf je Aktion der Vorlage). |
| **omp-audio-player** (Radio) | Spielt Audiodateien (WAV, FLAC, MP3, AAC, Ogg …) oder Live-Ton als reinen Ton-Sender: ein MXL-Ton-Ausgang je Zielgruppe, **kein Bild-Sender** und kein Zeitcode-Ausgang, `media_ready` meldet nur den Ton. Technisch der Kanal-Player mit `OMP_AUDIO_ONLY=1`; in Ton-Workflows (nur Ton-Typen und Recorder) entfällt die Warnung vor dem fehlenden Bild-Ausgangs-Anker. Planung weiterer Radio-Bausteine: `docs/entwuerfe/RADIO-PLAN.md`. |
| **omp-audio-delay** (Radio) | Sendeverzögerung für den Stereo-Programmton: hält `delayMs` (Standard 8 s), Ausgang auf eigener Uhr (reißt nie ab). **Dump** (`dump{ms}`) wirft die ältesten Sekunden weg (Sprung nach vorn, 5 ms Überblendung); danach baut der Node die Verzögerung selbsttätig mit `rebuildPercent` (Standard 1 % Tonhöhe) wieder auf. Zweiter Eingang „Notquelle“: bei Ausfall des Programms spielt der Puffer erst leer, dann läuft die Notquelle (sonst Stille), nach der Rückkehr füllt sich die Verzögerung neu (`state`: fill/run/hold). Anzeigen: `currentDelayMs`, `rebuilding`, Ein-/Ausgangspegel, `dumpedMs`, `underruns`. Ziel und Aufbaugeschwindigkeit sind im Betrieb änderbar und überleben einen Neustart. **Dead-Air-Wächter:** Liegt der Eingang länger als `deadAirHoldMs` (Standard 5 s) unter `deadAirThresholdDb` (−60 dBFS), übernimmt die Notquelle; Rückkehr erst nach `deadAirReturnMs` (2 s) stabilem Signal; Kennzahlen `deadAirActive`, `deadAirCount`, `deadAirSeconds`; Alarm bei Übernahme und Rückkehr. Schwelle und Haltezeiten sind eine Eigenlösung (keine Norm). |
| **omp-lowlat-mixer** (Studio-Mischer, niedrige Latenz) | Block-Mischer für Konferenz-, Moderations- und In-Ear-Wege (Ziel 2–15 ms Rundlauf, **auf Echtzeit-Host messen**). Takt `OMP_LL_BLOCK` (16/48/96/192/480 Rahmen = 0,33…10 ms). Eingänge: ALSA-Karte (`OMP_LL_ALSA_IN`, Karte gibt den Takt), AES67-RTP (`OMP_LL_AES_RX`, 1 ms, L24/L16), MXL (NMOS-Empfänger je Streifen oder `strip.N.setFlow`); Quelle je Streifen `off\|mxl\|alsa:K\|alsa:K-L\|aes:K\|aes:K-L`. Ausgänge: je Bus ein MXL-Ton-Flow (Sender), ALSA-Kanalpaar (`bus.N.alsaOut`), AES67-Strom (`OMP_LL_AES_TX`, Sende-SDP im Parameter `aesTxSdp`). Je Streifen Pegel, Mute und Sends auf bis zu 16 Stereo-Busse; **Mix-minus** per `bus.N.mixMinus{strip}`. Jeder Eingang hat einen Ring mit Drift-Regelung (kein Resampler) und selbstwachsender Reserve (`OMP_LL_INPUT_BUFFER_MS`/`…_MAX_MS`). Kennzahlen: Rechenzeit, verpasste Takte, Unterläufe, Driftausgleich, ALSA-Aussetzer, AES-Zähler. Bedienfeld mit Fadern, Pegel, Send-Matrix. Diagnose der Karte: `omp-lowlat-mixer --alsa-test <gerät> [periode]`. Ohne Echtzeit-Rechte (`RLIMIT_RTPRIO`/`CAP_SYS_NICE`) läuft der Node mit normaler Priorität (Kennzahl `realtime` = nein) und fängt Aussetzer des Rechners mit größerer Reserve ab — dann ist die Latenz höher. **Klangbearbeitung ohne Latenz** (alles ohne Vorausschau, Rechenkerne wie im Audiomischer): je Streifen Phase, Hochpass + 4-Band-EQ (`strip.N.eq.*`), Gate/Expander (`strip.N.gate.*`), Kompressor (`strip.N.comp.*`) mit Absenkungsanzeige; je Bus ein **Limiter** (`bus.N.limiter.enabled/ceiling/release`, sofortiger Anstieg im selben Rahmen — der Ausgang überschreitet die Obergrenze nie; Kopfhörerschutz bei In-Ear). Alle Werte stehen in der Workflow-Sicherung. Schreibweg für Bedienpulte: Methode `setParam{name,value}`. **Stream Deck:** Adapter `lowlat-mixer` (MUTE/SEND/SELECT, EQ-, Dynamik- und Bus-Seite mit Mix-minus und Limiter, Dials = Pegel). Normstand: RTP RFC 3550, L24 RFC 3190, L16 RFC 3551, SDP RFC 4566/7273; AES67-2018 und ST 2110-30 nicht gelesen, gegen echte Geräte ungeprüft. |
| **omp-segue-player** (Radio) | Mehrstimmiger Abspieler für Titel, Jingles und Bett: bis zu 8 Dateien gleichzeitig in einem Prozess, **sample-genau** auf einen Stereo-Ausgang gemischt. Jede Stimme startet auf einen TAI-Zeitpunkt im exakten Frame, mit Pegel, Ein-/Ausblenden (linear, Gleichleistung, logarithmisch), Ausblenden an einer Stelle der Datei und Start mitten in der Datei; `stop`/`fade` können schon vor dem Ende des Ladens befohlen werden. Eine vom Aufrufer vergebene `voiceId` verhindert Doppelstarts. Vertrag: `docs/contracts/CONTRACT-SEGUE-PLAYER.md`. |
| **omp-radio-automation** (Radio) | Spielt einen Radio-Log über den Segue-Player. Aus den Marken (Segue-Punkt, Intro) plant der Node die Übergänge: Titel→Titel Kreuzblende (Gleichleistung) am Segue-Punkt, Titel→Jingle (Jingle über dem Ausklang), Jingle→Titel (Titel unter dem Jingle-Ende), Gesprochenes am Stück. Die Stimmen gehen mit Vorlauf (Standard 30 s) und TAI-Startzeit an den Segue-Player (Parameter `target` = Name des Segue-Players); feste Stimmen-ID je Log und Platz verhindert Doppelstarts bei Wiederholung und Neustart. Methoden `load` (Log-JSON), `start` (`atTai`/`delayMs`), `stop`; As-Run im Parameter `asRun`, Sicherung über `/state`. **Bedienfeld** in der Konsole: Ziel (Segue-Player) und Vorlauf wählen, Log in einer Tabelle bearbeiten (Name, Art, Datei, Dauer, Intro, Segue-Punkt, Start in Datei, Pegel) oder als JSON einfügen/anzeigen, mit „Log laden“ übernehmen; Zeitleiste „Ablauf“ zeigt Überlappungen, Blendbereiche, gesendet/läuft/vorbei und die laufende Zeit; Start „in n s“ oder „um HH:MM:SS“, Stopp mit Rückfrage; As-Run darunter. **Harte Marken (Backtiming):** Ein Element mit `fixAtUnixMs` (Spalte „Harte Marke“) setzt zur Uhrzeit ein; beim Start lässt die Automation Füllkandidaten (`optional`, Spalte „Füller“) davor weg bzw. fügt Kandidaten aus `fillers` ein und verschiebt Segue-Punkte (höchstens 8 s je Titel); jede Entscheidung steht im As-Run. **Radio-Konsole:** Kopfleiste „Jetzt“ (läuft, Rest, Nächstes, Uhr); im Log-Editor Elemente per Drag&Drop sortieren, Spalte „Titel“ (Anzeigename) und „Block“ — gleichnamige aufeinanderfolgende Elemente bilden einen Block (z. B. Werbeblock) mit Soll-Länge, Summe, Differenz und „Füller anhängen“; „+ Spot (Werbeblock)“ legt einen Spot an; Zeitspalte zeigt den geplanten Beginn. **Hotkeys:** Tasten mit Name, Farbe, Datei und Pegel (Bearbeiten → + Taste → Speichern); Klick spielt sofort über den Segue-Player, erneuter Klick blendet aus. Methoden `setCarts`, `fireCart`, `stopCart`. **Sendungen vorbereiten:** Abschnitt „Sendung“ im Bedienfeld (Modul `radio`, Rechte `radio.show.prepare`/`release`/`manage_all`): Sendung anlegen oder aus einer Vorlage erzeugen, Titel, Zeitfenster und Moderation setzen, Log, Hotkeys, Moderationskarten (Text, „bei Element“, Minuten) und Notizen vorbereiten und speichern (Versionen, Wiederherstellen). Freigeben, zur Sendezeit „Auf Sendung laden“ (Log und Hotkeys gehen in die Automation, die Karten erscheinen groß unter „Jetzt“), danach „Sendung abschließen“. Als Vorlage speichern macht daraus ein Format für künftige Sendungen. **Wiederkehr:** An einer Vorlage lassen sich Wochentage, Uhrzeit, Dauer und Zeitzone einstellen; das System legt die Sendungen dann bis zum eingestellten Vorlauf (Standard 14 Tage) als Entwurf an, damit sie früh vorbereitet werden können (gelöschte Termine kommen nicht wieder). **Wochenplan:** Wochenübersicht aller Sendungen; Klick öffnet, „+“ legt am Tag eine neue an. **Zeitsteuerung:** Sendungen mit „Status automatisch nach dem Zeitfenster“ gehen zum Beginn auf „auf Sendung“ und nach dem Ende auf „gesendet“. **Automatisch laden und starten** (Kopfleiste): die Automation lädt die nächste freigegebene Sendung rechtzeitig vor dem Beginn (Vorlauf einstellbar), startet sie zum Sendebeginn und rührt eine laufende Sendung nicht an. **Zusammenarbeit:** Wer eine Sendung zum Bearbeiten öffnet, hält eine weiche Sperre; andere sehen „… bearbeitet gerade“ und die Sendung schreibgeschützt, können sie aber übernehmen (die Sperre verfällt ohne Herzschlag nach 30 s; zusätzlich schützt die Revisionsprüfung vor Überschreiben). **Karten:** Lesezeit je Karte (≈ 150 Wörter/min, Warnung bei Überschreitung der geplanten Minuten); **Teleprompter** (Vollbild) zeigt alle Karten fortlaufend, die aktive hervorgehoben und mitgeführt, mit Schriftgröße, Spiegeln und Auto-Scroll; Esc schließt. **Segue-Editor (Übergangs-Editor):** Doppelklick auf die Zeitzelle einer Playlist-Zeile oder Reiter „Übergänge“ → „Bearbeiten“ öffnet den Übergang vom Vortitel zum Titel: zwei Wellenformen mit Marken (Segue-Punkt, Einsatz, Intro-Ende, Blendbereiche), die sich ziehen lassen (Mausrad = Zoom, Umschalt+Ziehen = Verschieben), dazu Zahlenfelder für Segue-Punkt, Start von B (Verschiebung), Aus-/Einblenddauer und Kurven. Nicht destruktiv: gespeichert wird nur der Übergang im Log (`transition`), die Dateien bleiben unverändert. **Vorhören** des Übergangs, von A oder B einzeln, mit Schleife und einstellbarem Vor-/Nachlauf; **„Sendequalität prüfen“** rendert das Fenster mit dem unveränderten Mischer des Segue-Players und vergleicht es mit der Vorschau (gemessen −91 dB Abweichung). „Standardblende“ setzt den Übergang zurück. **Sendeplatz (Reiter „Sendebetrieb“):** Kopfzeile mit Uhr, Datum, Sendungstitel, „on air“-Leuchte und Auto-Anzeige; farbige Playlist (läuft rot, bereit grün, gespielt gedimmt, Randfarbe je Art, feste Zeiten gelb umrandet), Klick wählt eine Zeile; Tastenfeld (Start, Stopp, Laden, Cue, Reset, Übergang, Navigator, Bearbeiten, Planung, Modtext, Teleprompter, Protokoll); **Vorhören (PFL)** der gewählten Zeile mit Wellenform im Browser (nicht im Sendeweg); Player M1/M2 mit Wellenform, Restzeit und großem Countdown bis zum nächsten Element; Bibliothek als Platzhalter bis zur Anbindung der Datenquellen. **Layout dynamisch** („⚙ Layout“): Bereiche der rechten Spalte ein-/ausblenden und umordnen, Höhe der Playlist, Spaltenbreite und Farben einstellen — gilt je Sendung (liegt im Sendungsdokument unter `layout`, mit „Speichern“) und wird im Browser als Vorgabe gemerkt. Routen `POST /segue/plan`, `GET /segue/peaks`, `GET /segue/audio`, `POST /segue/render`; Entwurf `docs/entwuerfe/ENTWURF-SEGUE-EDITOR.md`. |
| **omp-gpio** (Radio, Studio) | Generische Kontakt-Ein-/Ausgänge als Node (Vertrag `docs/contracts/CONTRACT-GPIO.md`). Eingänge entprellt (`debounceMs`, Standard 20 ms) → NATS `omp.gpio.<node>.in.<pin>`; Ausgänge per `setOutput(pin, level, holdMs)`, mit Haltezeit fällt der Ausgang ohne Erneuerung auf den Fail-Safe-Pegel (`configurePin`), bei Verbindungsverlust sofort alle. Gerät in dieser Stufe: Simulator (`simulateInput`, `simulateLink`). Umgebung `OMP_GPIO_INPUTS`/`OMP_GPIO_OUTPUTS`. **Bedienfeld:** Eingänge als Lampen, Ausgänge schaltbar (mit wählbarer Haltezeit), Namen und Fail-Safe-Pegel, Entprellzeit, Simulator-Schalter für Eingänge und Verbindung, letzte Ereignisse. |
| **omp-ptz** | PTZ-Kamerasteuerung über VISCA über IP (UDP 52381), eine Instanz je Kamera (Vertrag `docs/contracts/CONTRACT-PTZ.md`, Kapitel 104). `move(pan, tilt)`/`zoom(speed)` mit **Haltezeit** (`holdMs`, Standard 1000 ms): ohne Erneuerung stoppt der Node die Kamera selbst. Voreinstellungen `recall`/`store`/`clearPreset`, absolute Fahrten `goto`/`zoomTo`, `home`, `stop`; Positionen als Rohwerte, Ereignisse `omp.ptz.<node>.<link\|preset\|hold\|error>`. Bedienfeld mit Joystick. `OMP_PTZ_TARGET` (Kamera), `OMP_PTZ_SIM=1` (Simulator). **An echter Kamera noch ungeprüft.** |
| **omp-tams-writer** (Aufnahme) | Nimmt eine per Kreuzschiene angeschlossene MXL-Quelle fortlaufend in einen zeitadressierten Medienspeicher (TAMS, API 8.2) auf: GOP-genaue MPEG-TS-Segmente (H.264/AAC), Video und Ton als getrennte Flows, Zeitachse auf der MXL-/TAI-Zeit. Warteschlange auf der Platte bei Speicherausfall. `tams.start`/`tams.stop`. Einrichtung `OMP_TAMS_URL`, `OMP_TAMS_AUTH`, Token nur aus Datei/Umgebung (Vertrag `docs/contracts/CONTRACT-TAMS.md`, Kapitel 105). **An echtem Speicher noch ungeprüft.** |
| **omp-tams-reader** (Wiedergabe) | Spielt einen Zeitbereich aus dem Speicher als MXL-Quelle ab (`tams.play`, per Zeitstempel oder „vor N Sekunden“) oder gibt eine laufende Aufnahme zeitverschoben wieder (`tams.follow`, z. B. Instant Replay). Lücken werden gefüllt (`OMP_TAMS_GAP`). Folge-Modus fragt ab, kein Webhook. **An echtem Speicher noch ungeprüft.** |
| **omp-midi-gateway** (Bedienpulte) | MIDI-Pulte am Server (Vertrag `docs/contracts/CONTRACT-MIDI.md`): Mackie-Control-Pulte (Hauptpult + Erweiterungen, z. B. iCON V1-M/V1-X, P1-M/P1-X) steuern den Audiomischer (Fader mit Motor, Mute, Solo = PFL, Auswahl, Drehgeber = Pan, Bank/Kanal, Anzeige, Pegel, Rec-LED = On-Air, Master-Fader → Aux-Bus); Tastenbelegung `keys` (Funktionsfeld F1–F8 in Seiten, feste Tasten, Jog-Modi, Zusatzprofil für frei belegte Pads/Regler); Betriebsart `profile` ordnet beliebige MIDI-Geräte per JSON Methoden zu. Anschlüsse: `raw` (`/dev/snd/midiC<n>D<m>`), `rtp` (RTP-MIDI/AppleMIDI als Hörer oder Einlader), `sim`. Parameter `config`/`status`/`ports`/`recent`, Methoden `setConfig`, `bank`, `simulate*` (inkl. `simulateJog`, `simulateMove`). Der iMAP-Anschluss (Anschluss 4) der iCON-Pulte wird nicht geöffnet. NATS `omp.midi.<node>.link`, `.button.<name>`, `.control.<id>`. **Bedienfeld:** Status, Einheiten einrichten, Mischer wählen, Profil, Simulator-Pult, Ereignisse. |
| **omp-studio-logic** (Radio, Studio) | Mikrofonlogik des Moderationsplatzes (Vertrag `docs/contracts/CONTRACT-STUDIO-LOGIC.md`). Je Mikrofongruppe: Mischerkanal auf Sendung → Rotlicht am GPIO-Node (mit Haltezeit, fällt bei Ausfall aus) und Studio-Lautsprecher stumm. Cough: Taste am GPIO-Eingang oder Methode `cough`, stellt den vorherigen Stummzustand wieder her, öffnet bei Loslassen, GPIO-Ausfall oder Höchstdauer. Studio-Übergabe `offerHandover`/`acceptHandover`/`abortHandover` auf einen Zeitpunkt, mit Audit. Regeln als JSON im Parameter `config`, Ziele `mixer` und `gpio`. **Bedienfeld:** Karten je Mikrofongruppe mit Lampe und Zustand, **Cough-Haltetaste** (halten = stumm, loslassen = offen), Studio-Übergabe (von/nach, Zeitpunkt, Anbieten/Annehmen/Abbrechen, Countdown, Audit) und „Regeln“ zum Bearbeiten der Gruppen und Studios mit Kanalvorschlägen aus dem Mischer; Änderungen gelten erst nach „Speichern“. **Moderationsplatz als Workflow:** Vorlage `docs/examples/workflow-radio-moderationsplatz.json` (Import mit `POST /api/v1/workflows`) legt Segue-Player, Radio-Automation, Moderationsmischer, GPIO und Studio-Logik an; die Ziele der Steuer-Nodes sind über die Rollennamen schon gesetzt (Rollen-Umgebung `OMP_RADIO_TARGET_LABEL`, `OMP_STUDIO_MIXER_LABEL`, `OMP_STUDIO_GPIO_LABEL`). Kanäle und die Quelle des Segue-Players legt man im Mischer an (`channel.<id>.setSource` mit dem Sender „Programm“ des Segue-Players); danach im Flow-Editor „Im Workflow speichern“, damit der Zustand beim nächsten Start zurückkommt. |
| **omp-failover** (Radio, Fernsehen folgt) | Modulationswächter und Havarieumschalter vor dem letzten Signalpunkt (`docs/entwuerfe/ENTWURF-HAVARIEUMSCHALTER.md`). Hauptsignal und drei Notquellen als MXL-Audio-Flows, dazu ein eingebauter Notclip (Datei in Schleife). Fällt das Hauptsignal aus (kein Signal länger als `noSignalMs`, Standard 1,5 s; Stille unter `silenceDb`, Standard −60 dBFS, länger als `silenceMs`, Standard 5 s), schlägt der Node Alarm (`omp.alert.<node>` → Alarmwege) und schaltet die erste gesunde Quelle der Reihenfolge `order` (mit 20 ms Überblendung). Rückkehr automatisch, wenn das Hauptsignal `returnMs` (3 s) stabil ist und die Mindestverweildauer `minHoldMs` (2 s) vorbei ist, abschaltbar (`autoReturn`). **Manuell:** Methode `select(source)` (`main`, `n1`–`n3`, `clip`) — die Wahl bleibt, ein Alarm meldet eine gestörte manuelle Quelle; `auto` stellt die Automatik wieder her. **Bedienfeld:** Statusanzeige (NORMAL / HAVARIE / ALLE GESTÖRT), Quellen mit Pegel, Zustand und „Aufschalten“ (mit Rückfrage, wenn das Hauptsignal in Ordnung ist), Automatik, Einstellungen (Zeiten, Schwelle, Reihenfolge, Clipdatei; Speichern), Protokoll. Alle Zeiten und Schwellen sind Eigenwerte (keine Norm). Nach „Im Workflow speichern“ bleiben die Einstellungen erhalten. **Fernsehbetrieb:** mit `OMP_FAILOVER_VIDEO=1` (Rollen-Umgebung) kommen zu jeder Quelle ein **Bild-Empfänger** (`… Bild`, Ton `… Ton`) und ein MXL-**Bild-Ausgang** im Format `OMP_FAILOVER_WIDTH/HEIGHT/FPS`; erkannt werden zusätzlich **Standbild** (`freezeMs`, Standard 5 s) und **Schwarzbild** (`blackMs`, Standard 5 s; höchstens 0,1 % helle Pixel — dunkle Inhalte bleiben „Bild“, Schwarz mit eingeblendetem Logo gilt als Bild); als weitere Notquelle gibt es das **Standbild** (`stillFile`, Bilddatei, `OMP_FAILOVER_STILL`; ohne Ton) und den Notclip mit Bild und Ton (`clipFile`, `OMP_FAILOVER_CLIP`). Bild und Ton schalten mit **einer** Entscheidung um (das Bild folgt am nächsten Bildtakt). **Profil „Redundanzpaar“ (Kapitel 109 Stufe B):** `OMP_FAILOVER_PROFILE=redundancy` (Rollen-Umgebung, zusammen mit `OMP_FAILOVER_VIDEO=1`) oder Methode `profile(name)` (`emergency`/`redundancy`) macht den Node zum Umschalter hinter einem Mischer-Paar: Hauptsignal = aktiver Mischer, Notquelle 1 = Standby-Mischer. Ausfall = kein neues Bild seit `presentMs` (3 Bildperioden) + `noSignalMs` (20 ms), also ca. 0,1–0,15 s; Rückkehr zum Hauptsignal erst nach 5 s stabilem Bild und 5 s Verweildauer (`returnMs`/`minHoldMs`), Anlauf-Schonzeit: scharf erst, wenn das Hauptsignal einmal gesund war (`arm_required`, spätestens nach 10 s), Stille/Standbild/Schwarz zählen nicht als Störung (`checkSilence` aus, `freezeMs`/`blackMs` 0). Im Workflow die Standby-Rolle als **Live-Standby** eintragen und ihren Ausgang ausdrücklich mit „Notquelle 1 Bild“ verbinden; alle Verbraucher hängen nur am Umschalter. Gemessen (2026-11-25, Testquellen 640×360@25, 6 von 6 Läufen): Umschaltung 107–142 ms nach hartem Kill, Ausgang lief ohne Unterbrechung weiter. |
| **omp-sign-avatar** | Gebärdensprach-Avatar (DGS), Rust, Software-Rasterizer (kein Browser/GPU): Eingang „Untertitel“ (`video/smpte291`, Text-Strom oder CEA-608, IS-05 wie bei Viewer/Multiviewer), Ausgang Fill+Key (zwei `video/v210`-Flows, 25 B/s, Größe klein/mittel/groß). Pipeline: Sätze trennen → Wörter über Lexikon (JSON, `verified`-Pflicht) und Regeldatei (JSON) auf Glossen → Schlüsselfolge mit Überblendung; Rückfälle: Buchstabieren, Text im Bild (eingebaute 5×7-Schrift) bei zu vielen Unbekannten; Warteschlange mit Aufholen/Verwerfen (`OMP_SIGN_MAX_DELAY_S`). Rendert nur bei geänderter Haltung und nur, solange ein Leser den Flow liest (`gate_on_consumers`). Parameter `auto`, `speed`, `text`, readonly `state`, `subtitle`, `lexicon`, `renderMs`; Methoden `translate`, `speak`, `stop`. Prüfwerkzeug `--lexicon-check`/`--sheet`, Messung `--bench`. Konzept und Messwerte: `docs/funktionen/GEBAERDENSPRACHE.md`. |
| **omp-recorder** | Nimmt eine per Kreuzschiene angeschlossene MXL-Quelle (Video/Audio) als Matroska-Datei auf (`record.start`/`record.stop`). Endet der Dateiname auf `.mxf`, entsteht MXF (H.264 + PCM 24 Bit); ist zuvor `record.mcaPlan` (JSON, Format wie `mxf-mca inject`) gesetzt, werden nach dem Stopp MCA-Labels (ST 377-4/-41) in die Datei geschrieben. Ausschließlich MXL als Eingang, keine Capture-Karte. „Warm, unabonniert" bis zum Start — keine Lese-Pipeline im Leerlauf. **Kanalplan (Kapitel 45):** `OMP_RECORDER_AUDIO_INPUTS=n` (1–8) legt die Audio-Empfänger „Audio“, „Audio 2“ … an; `record.audioPlan` (JSON `{"channels":[{"input":0,"channel":1,"gainDb":-3},{"input":null}]}`, `input` = Nummer des Audio-Empfängers ab 0, `null` = Stille) ordnet Kanäle mehrerer Quellen den Ausgabekanälen der Datei zu (`audiomixmatrix` je Quelle + `audiomixer`); ohne Plan wird der Ton des ersten Empfängers unverändert aufgenommen. MXF: bis 32 Kanäle PCM, Matroska/AAC: bis 8. |
| **omp-device-hub** | Erkennt die lokalen Video- (V4L2) und Audio-Geräte (ALSA/USB) des Hosts mit stabiler Geräte-ID (Seriennummer, sonst USB-Position) und Fähigkeiten. Je Gerät schaltet man „Anbieten“ ein: dann entsteht ein MXL-Flow mit NMOS-Sender (Tag `source.live`), der wie jede andere Quelle in der Kreuzschiene erscheint. Standard: alles aus; die Auswahl bleibt über Neustarts erhalten, ein abgezogenes Gerät wird beim Wiederanstecken wieder angeboten (gleiche Sender-ID). **Audio-Ausgänge** (Wiedergabe der Soundkarte, Kopfhörer/Lautsprecher) erscheinen als eigener Eintrag „Audio-Ausgang“: eingeschaltet wird daraus ein NMOS-Empfänger, der in der Kreuzschiene mit einer Audioquelle verbunden wird und dann über die Karte abspielt (Mehrkanal wird auf die Kanalzahl der Karte gemischt). Status je Gerät: Aus / Startet / Sendet / Wartet auf Verbindung / Nicht angesteckt / Fehler. Ein Node je Host, nicht je Gerät. |
| **omp-capture-card** | Karten-Node für SDI/IP-Capture-Karten (Blackmagic DeckLink, AJA, weitere SDK-Karten über ein vom Betreiber gebautes Plugin), **eine Instanz je Karte**. Der Start-Assistent zeigt die erkannten Karten des Hosts mit Eingang/Ausgang je Anschluss (frei/belegt); gewählt wird per `OMP_CARD_PORTS` (`0:in,0:out,1:in`), der Hersteller per `OMP_CARD_VENDOR` (`decklink`, `aja`, `custom`, Kap. 76). Je Eingang ein Video- und ein Audio-Sender, je Ausgang drei IS-05-Empfänger (Video, Audio, ANC/Untertitel); Duplex-Anschlüsse bekommen beides. Port-IDs im Inventar: `<Hersteller>-<N>-in|out`. Modus, Gerät und Zusatzwerte (`OMP_CARD_PROPS`) werden per Introspektion gegen das Plugin geprüft; fehlendes Plugin oder unbekannte Eigenschaft = klarer Startfehler. Erkennung: `omp-capture-card --list-cards` (Host-Agent-Aktion `list-cards`, Orchestrator `GET /api/v1/hosts/{id}/cards`). Nicht an Hardware geprüft. KONA IP im ST-2110-Betrieb läuft stattdessen über NMOS und das ST-2110-Gateway. |
| **omp-vfa** | Video folgt Audio (Kapitel 46), Go, reine Steuerebene ohne Ports. Liest Pegel des Tonmischers (SSE `levelsUrl`, `inDb` je Kanal) und Gesichtszustände (NATS `vfa.vision.state`), entscheidet mit `internal/engine` (Sprecher + Haltezeit, Mindestdauer, Totale bei Stille, Gesichtsposition je bestätigter Einstellung) und schaltet den Bildmischer per `crosspoint.select`+`crosspoint.cut` über den Orchestrator-Proxy (Service-Token; Typ als Control-Plane in `main.go` angemeldet). Meldet die Vorschau-URLs der Kameras auf `vfa.vision.config`. Einrichtung per „Person spricht jetzt“ (Lernfenster 5 s, Kandidaten aus `engine.Learner`). Persistenz `OMP_VFA_DATA` (JSON). |
| **omp-vfa-vision** | Gesichtszählung je Kamera, Go ohne CGO (Pico-Kaskade `esimov/pigo`, eingebettet). Holt alle 300 ms `GET /preview` der Kamera-Nodes (Kameraliste kommt von `omp-vfa` über `vfa.vision.config`, alternativ `OMP_VFA_CAMERAS`), bestimmt Position/Größe und veröffentlicht `{camera_id, faces:[{center_x, center_y, size_percent}]}` auf `vfa.vision.state`. Keine Identitäten. |
| **omp-intercom** | Intercom (Kapitel 47), Rust. Eigener Mix-Kern `mix.rs` (20-ms-Takt, Matrix Teilnehmer×Kanal, Mix-minus über Kanalsummen O(N·C), Ducking für IFB/Priorität, Begrenzer, Sprecher-Erkennung, VOX), je Teilnehmer eine **statische** WebRTC-Pipeline (`peer.rs`: webrtcbin sendrecv Opus + Datenkanal `ctl`, Panel-Seite `GET /panel?token=`, Signalisierung `POST /offer?token=`), gemeinsame Opus-Encoder je identischem Hörsignal (`encpool.rs`), Stille wird nicht gesendet, Browser-DTX für ruhende Mikrofone. Zustand/Befehle über den Datenkanal (JSON, Ping alle 2 s, Ablauf 8 s). MXL: IS-05-Receiver „Programm n“ und MXL-Sender „Intercom Mix n“ (`mxl_io.rs`). **Der Node ist ein eigener Dienst (Kapitel 48):** er hält Kanäle, Teilnehmer, Vorlagen und Gäste selbst (`admin.rs`, Datei `OMP_INTERCOM_DATA`, Standard `data/omp-intercom.json`, atomar geschrieben) und meldet sich dem Dienst-Gateway des Orchestrators mit einem Manifest (`GET /service.json`, Routen unter `/service/…`, nur mit Dienst-Token `OMP_SERVICE_TOKEN`). Eine Sicherungskopie liegt in der Datenbank des Orchestrators (Datensicherung); startet der Node leer (Datei verloren, anderer Host), spielt das Gateway sie wieder ein. `PUT /config` (rohes Node-Dokument) gibt es nur noch ohne Dienst-Token (Entwicklung/Tests). `GET /status`, Stream Deck über die Vertragsrollen `deck.state`/`deck.command` (`/service/deck/{party}`, `docs/contracts/CONTRACT-INTERCOM.md`). On-Air: Parameter `onAir` + Tally-Bus (`OMP_INTERCOM_ONAIR_SOURCES`). Start-Optionen: `OMP_INTERCOM_PROGRAM_INPUTS`/`_MIX_OUTPUTS`/`_LATENCY_MS`, HTTPS wegen Browser-Mikrofon (`OMP_HTTPS`). **Ton-Gast (RC3):** `POST /service/guests` mit `"audio": true` legt in einem Schritt Rückweg- und Mikrofonkanal samt Anbindungen an (Rückweg-Eingang = freier Programmeingang, Mikrofon = freier Mix-Ausgang); Widerruf und Ablauf räumen alles wieder ab. Den N-1-Ausgang des Tonmischers auf den genannten Programmeingang und den Mix-Ausgang auf einen Mischerkanal zu verbinden, macht der Mensch im Flow-Editor. Gemessen mit echtem Tonmischer: der Gast hört den anderen Gast (Pegel 0,18), sich selbst nicht (0,0000); `tools/intercom-e2e/ton-gast-n1.mjs`. |
| **omp-xy-panel** | X/Y-Kreuzschiene als Bedienpanel (reine Steuerebene, keine Ports): links Quellen, rechts Ziele, je mit Home-/Hoch-Taste durch Workflows, Gruppen (verschachtelt) und „Nicht zugewiesen“. Drei Ansichten (Listen, Matrix, Router-Kachelraster mit Ebenen Video/Audio/Daten, nur Darstellung, Wahl im Browser gemerkt). Schaltet über `POST /api/v1/graph/edges` (Rechte, Audit, Schleifenschutz des Kerns gelten). Per „⇉ Alle Ports“ schaltet es einen ganzen Node (z. B. Video+Audio) auf einen anderen Node: Paarung nach gemeinsamen Tags, sonst 1:1 je Medientyp (`planTagRoutes`). Zusätzlich Bouquets (mehrere Schaltungen mit einem Take, im Layout `xy-bouquets` gespeichert) und tag-basierte Schaltung über `GET /api/v1/sources` und `GET /api/v1/sinks` (Tags an Quelle **und** Senke, z. B. `role.commentator`). Für Desktop und Smartphone/Tablet (Layout folgt der Breite der Kachel). |
| **omp-scope** | Passives Messgerät (Tap, kein Ausgang) auf je einen optionalen MXL-Video- und -Audio-Flow. **Bild:** Waveform + Vektorskop als ein Messbild, mittleres Luma, Bild-zu-Bild-Differenz. **Ton:** Peak/RMS, EBU-R-128-Lautheit (M/S/I/LRA), True Peak in dBTP nach ITU-R BS.1770 samt R-128-Konformitätsampel (−23 ±0,5 LUFS, ≤ −1 dBTP). **Timing:** Transportlatenz, Jitter, Ist-/Soll-Kadenz, ausgelassene Grains und Reader-Neuaufsetzer je Flow — gerechnet aus den MXL-Ursprungszeitstempeln der Grains, nicht aus Ankunftszeiten; daraus der **A/V-Versatz (Lipsync)**, bewertet nach EBU R 37 (Ton höchstens 40 ms vor, 60 ms nach dem Bild). **Flow:** die Deklaration aus der MXL-Domain (Media-Type, Rate, Bittiefe, Farbraum, Interlace, Grouphint, Grain-Größe, Datenrate), bewusst getrennt vom gemessenen Ist angezeigt. **Signalüberwachung:** Schwarzbild, Standbild und Stille als gehaltene Alarme (1/2/2 s Haltezeit) sowie **Gamut nach EBU R 103 v3.0** (R, G, B, Y außerhalb 5…246 bei 8 Bit auf mehr als 1 % der Fläche, Vorfilter und Matrixwahl nach Norm, Haltezeit 1 s). Ein negativer Latenzwert ist kein Anzeigefehler, sondern die Aussage „der Schreiber stempelt in die Zukunft" — s. `docs/decisions.md` Nachtrag 226. |
| **omp-scaler** | Skaliert/konvertiert eine per Drag & Drop angeschlossene MXL-Videoquelle auf ein fest konfiguriertes Zielformat (Rollen-Format, s. Workflow-Formular) und schreibt sie als zweiten MXL-Flow zurück — gleicht Auflösungs-/Framerate-Unterschiede zwischen Quellen und Zielen aus. Unterstützt seit D8 Teil 3 `setOutputDelay()` (Latenzbudget-Ausgleich, s. Abschnitt 9.7). **Bekannte Einschränkung:** in einer Kette Quelle→Scaler→Ziel innerhalb desselben Workflow-Starts kann die letzte Verbindung (Scaler→Ziel) zu früh ausgelöst werden, bevor der Scaler seinen eigenen Ausgangs-Flow fertig aufgebaut hat — betroffene Verbindung im Flow-Editor einmal neu ziehen behebt es sofort (s. `docs/decisions.md` Nachtrag 109). **Bildratenwandlung:** Standard `videorate` (verwirft/verdoppelt Bilder); Option `OMP_FRAMERATE_CONVERSION=blend` überblendet stattdessen (optionales Plugin `avvideofilter`, ohne Plugin Rückfall auf `videorate`, +9…43 ms Latenz je nach Ratenpaar, bei gleicher Rate keine Stufe; Installation und Offline-Weg: `docs/INSTALLATION.md` §9). |
| **omp-playout-buffer** | **Ausgangs-Anker** am Ende eines Workflows (Kapitel 39): hält Bild und Ton um eine einstellbare Tiefe (`bufferMs`, Standard 2500 ms) zurück und schreibt sie als eigene, nie abreißende MXL-Flows (Video + Audio) im Rollen-Format. Fällt der Vorgänger aus (Absturz, Quellwechsel, Hot-Standby-Übernahme), läuft der Ausgang zuerst aus dem Puffer weiter (bis zur Puffertiefe ohne sichtbare Störung), danach mit Standbild oder Schwarz und Stille — der nachgelagerte Sender bleibt verbunden. Standard je ein Empfänger/Sender für Video und Audio; optional mehrere parallele Spuren (`videoTracks` 1–8, `audioTracks` 1–16, Start per `OMP_VIDEO_TRACKS`/`OMP_AUDIO_TRACKS`, zur Laufzeit änderbar, je Spur eigener Ring; `status` enthält `videoTracks`/`audioTracks` mit Verbindung, Füllstand, Zählern). Zeitstempel werden neu und streng monoton auf dem MXL-Raster vergeben; Bild und Ton bleiben nach jedem Splice im ursprünglichen Verhältnis (gemessen mit der Marker-Quelle). Nach einem überbrückten Ausfall wird die Tiefe mit `refillPermille` (Standard 1 %) wieder aufgebaut. Speicher fest begrenzt (`OMP_BUFFER_MAX_MIB`; 1080p25 bei 2,5 s ≈ 0,45 GiB, ≈ 28 % eines Kerns). Parameter: `bufferMs`, `resumeMs`, `holdMode` (`last`/`black`), `refillPermille` sowie Messwerte (`state` = `fill`/`run`/`hold`, `fillMs`, `bufferBytes`, `underruns`, …, gesammelt in `status`). Unterstützt `setOutputDelay()` (der Ausgleich wird zur Tiefe addiert, Bild + Ton gemeinsam) und ist im Katalog als `anchor` markiert: im Workflow-Editor nicht löschbar, die Start-Vorschau warnt bei fehlendem Anker. Eine Rollen-Verbindung auf den Puffer verbindet Bild **und** Ton. **Grenzen:** nur unkomprimierter Pfad (MXL-Frames); die Latenz im Katalog (63 Bilder) gilt für 25 Bilder/s und 2,5 s Standardtiefe; Kanalzahl/Abtastrate des Ton-Ausgangs sind fest (`OMP_AUDIO_CHANNELS`, 48 kHz). Details: `ARCHITECTURE.md` §30, `docs/BENUTZERHANDBUCH.md` Abschnitt 10f. |

### 9.2 Gateway-Nodes (Standort-/Fremdgeräte-Anbindung)

| Node | Funktion |
|---|---|
| **omp-2110-gateway** | Bidirektionale Brücke SMPTE-ST-2110-Multicast (LAN, Fremdgeräte) ⇄ OMP-internes MXL-Fabric. Gerichtet je Instanz (Ingest/Output), SDP- oder Einzel-Env-Var-Konfiguration. **Etiketten (Ingest, Kap. 106.8):** Bild und Ton bekommen ihre MXL-Etiketten aus den RTP-Zeitstempeln (ST 2110-10/ST 2059-1, `omp-mediaio::rtptime`/`rtplabel`) statt aus der Ankunft, sobald eine gemeinsame Uhr da ist (`OMP_PTP_DOMAIN`, synchron); sonst Ankunft. Parameter `ingest.labelSource` (`rtp`/`arrival`), lesbar `ingest.labelClock`, `labelJumps`, `labelFallbacks`, `labelMessage`; `OMP_2110_LABEL_CLOCK=system` nur als Ersatz zum Testen ohne PTP-Karte. **JPEG XS (ST 2110-22, optional, Kap. Nutzerwunsch 2026-11-22):** Modul `omp_mediaio::jxs` sucht zur Laufzeit `svtjpegxsenc`/`svtjpegxsdec` (gst-plugins-bad) und `rtpjxsvpay`/`rtpjxsvdepay` (gst-plugins-rs, RFC 9134), erzeugt das SDP (`jxsv/90000`, `SSN=ST2110-22:2019`) und baut Sende-/Empfangskette; fehlen Elemente, klare Fehlermeldung. Im Gateway-Datenpfad **noch nicht angeschlossen** (ein JPEG-XS-SDP wird mit Begründung abgelehnt), auf dem Entwicklungsrechner (GStreamer 1.22) nicht live belegt; MXL bleibt V210. |
| **omp-aes67-gateway** | Audio-Pendant zu `omp-2110-gateway`: AES67/RTP-Multicast (Geräte im AES67-Modus, Ravenna u. a.) ⇄ MXL, inkl. SAP-Discovery (RFC 2974) für Fremdströme, die nur darüber auffindbar sind. |
| **omp-srt-gateway** | Bidirektionale Brücke ST 2110 (LAN) ⇄ SRT (WAN) für Beitrag/Distribution über verlustbehaftete Netze. Gerichtet je Instanz (Uplink/Downlink). **Beliebige Auflösung und Bildrate** je Instanz (`OMP_SRT_GATEWAY_WIDTH`, `_HEIGHT`, `_FPS`; gerade Werte 16–16384, auch gebrochene Raten wie `30000/1001`; sie müssen zum ST-2110-Strom passen, weil dessen SDP sie fest vorgibt). **Transport** (`OMP_SRT_GATEWAY_CODEC`): `raw` (Standard, RTP-Rohvideo nach RFC 4175 über SRT, sehr hohe Datenrate), `h264` oder `hevc` (komprimiert als **MPEG-2-Transportstrom über SRT**, ISO/IEC 13818-1; `_BITRATE_KBPS`, sonst automatisch aus dem Raster; `_BIT_DEPTH=10` für H.264 High 10 / HEVC Main 10). **Optional automatisches Raster:** `OMP_SRT_GATEWAY_RASTER=auto` (nur Downlink mit `h264`/`hevc`) übernimmt Auflösung und Rate aus dem ankommenden Strom; der 2110-Ausgang wird beim ersten dekodierten Bild gebaut, bei einer Änderung im laufenden Strom neu (neues SDP, Empfänger müssen folgen); fehlt die Rate im Strom, gilt `OMP_SRT_GATEWAY_FPS` (Standard 25). Beim Uplink und bei Rohvideo ist die Angabe nötig, weil das Raster dort im 2110-Strom (SDP) bzw. RTP nicht von selbst feststeht — `auto` wird dort abgelehnt. Nicht dabei: AV1 (kein Decoder installiert, `mpegtsmux` ohne AV1) und lernbasierte Codecs (kein standardisierter, einsetzbarer Strom); neue Codecs kommen als weitere Variante in `codec.rs`. Im komprimierten Betrieb gibt es keinen RTP-Jitterbuffer, Verluste meldet die SRT-Statistik. |
| **omp-webrtc-gateway** (Typen `omp-webrtc-gateway-camera` / `-monitor`) | Anbindung gewöhnlicher Handys per Browser, ohne App: **Kamera** nimmt Handy-Kamera/-Mikrofon per WebRTC (WHIP, H.264 + Opus) auf und speist sie als MXL-Flow ein; **Monitor** sendet einen gewählten MXL-Flow als Retourbild (WHEP) zurück. Zugang nur über Einladungslinks/QR-Codes; die Einladungen bleiben über einen Neustart des Gateways erhalten, auch über einen manuellen Neustart mit neuer Instanz-ID (Datei je Zustandsschlüssel `OMP_STATE_KEY` und Richtung unter `.run/webrtc-gateway/`, anpassbar mit `OMP_WEBRTC_GATEWAY_STATE_DIR`, Rechte 0600; Dateien anderer Instanzen, die länger als 90 Tage unverändert sind, räumt das Gateway beim Start weg, `OMP_WEBRTC_GATEWAY_INVITE_KEEP_DAYS`). Ausführlich: Benutzerhandbuch, Abschnitt „Handy-Kamera“.  **Tally:** Die Kamera-Seite zeigt ON AIR, wenn Bildmischer/Switcher/Tally-Geber (`OMP_TALLY_GIVER`, z. B. 2110-Ausgang) sie auf Sendung schalten (`OMP_TALLY_SOURCES` schränkt Auslöser ein; Tally-Ereignis `omp.tally.<node>` trägt den Absender `src`). Feste HTTPS-Ports per `OMP_HTTPS_PORT` (9443/9444). |
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

### 9.3a MXL-Domains: Betrieb und Best Practice

**Grundsatz: eine Domain, bis es einen Grund für mehr gibt.** Die Standarddomain `default` (`/dev/shm/omp-mxl`) genügt für einen Betrieb mit einer Produktion. Jede zusätzliche Domain kostet Aufmerksamkeit: Verbindungen über Domaingrenzen gibt es nur über eine Brücke, und jede Brücke ist ein Prozess, der Bilder kopiert.

**Wann eine eigene Domain sinnvoll ist**

| Anlass | Empfehlung |
|---|---|
| Test neben Live auf derselben Maschine | Domain `test` (Pfad-Trennung genügt); ein Testlauf kann keinen Live-Flow berühren oder aufräumen |
| Mandanten / getrennte Sichtbarkeit | je Mandant eine Domain, **abgeschottet** |
| Fremd- oder wenig vertraute Nodes | eigene, abgeschottete Domain; nur die Brücke sieht beide Seiten |
| Nur „es sieht ordentlicher aus“ | keine Domain — dafür gibt es Workflows und die Host-Ansicht |

**Regeln**

1. **Namen:** Kleinbuchstaben, Ziffern, Bindestrich; nach Zweck, nicht nach Person (`live`, `test`, `mandant-a`). Auf **allen Hosts denselben Namen** verwenden — die Zuordnung läuft über den Namen, jeder Host legt den Pfad selbst an. Pfade nie von Hand setzen.
2. **Zuordnung je Workflow** (Workflow-Einstellung „MXL-Domain“), nicht je Rolle. Eine Rolle bekommt nur dann eine andere Domain, wenn sie eine **Brücke** ist (Ziel-Domain). So bleibt ein Workflow in sich geschlossen, und Umzug/Failover legen ihn in dieselbe Domain des Zielhosts.
3. **Brücken sparsam:** Eine Brücke kopiert nur, sie wandelt nicht (gleiches Format auf beiden Seiten; sonst wird die Umwandlung **vor** der Brücke in der Quelldomain gemacht, z. B. mit `omp-scaler`). Pro Flow-Paar eine Brücke, auf dem Host, der beide Domains hat. Kopieren kostet Speicher und etwas CPU, die Brücke wartet blockierend (kein Polling) und ruht ohne Quelle.
4. **Abschotten nur mit Grund:** Die Abschottung (Sandbox) wird beim Anlegen gewählt und lässt sich nicht nachträglich ändern. Sie verbirgt die Flows anderer Domains vor den Nodes; sie schützt nicht vor einem Node mit Root-Rechten auf dem Host. Voraussetzung: `unshare` (util-linux) und erlaubte User-Namespaces; fehlt das, startet der Node nicht (kein stilles Weiterlaufen ohne Schutz). Nach dem Anlegen einmal prüfen: `ls /proc/<PID>/root/dev/shm` darf nur die eigene Domain zeigen.
5. **Domain einer laufenden Instanz** nur über „Domain wechseln“ (ohne Verbindungen, nicht für Workflow-Mitglieder) oder Neustart; Workflows stoppen, dann ändern.
6. **Löschen:** nur leere Domains (keine Instanz). Reste (Flows ohne Schreiber) zeigt „MXL-Flows“ als *verwaist*; sie belegen `/dev/shm`.
7. **Speicher:** Alle Domains liegen im selben tmpfs `/dev/shm` des Hosts und teilen sich dessen Größe (Abschnitt 10.6). Eine Größengrenze je Domain gibt es nicht; Reste und volle Bereiche zeigt der Selbsttest.
8. **Über Hostgrenzen** hilft keine Domain: MXL ist host-lokal. Zwischen Hosts braucht es SMPTE ST 2110, SRT oder Fabrics. Die Domain-Ansicht im Flow Editor zeigt dazu je Domain die Hosts als Reiter.
9. **Container-Nodes** bekommen automatisch nur ihre eigene Domain eingehängt.

**Lesemodus (Fehlersuche):** Die MXL-Leseschleifen aller Nodes warten blockierend auf den nächsten Grain (kein 5-ms-Abfragen mehr). Zeigt ein Node bei 100 % CPU kein Bild oder bleibt „Last read time“ eingefroren, mit `OMP_MXL_READ_MODE=poll` in den Node-Umgebungsvariablen gegenprüfen und den Befund melden.

**Nicht geprüft:** Browser-/WPE-Nodes (OGraf) in abgeschotteten Domains (laufen im Namespace als Benutzer 0), Betrieb mit Dritt-Schreibern, die Teil-Grains schreiben.

### 9.4 Referenz-/Tutorial-Node

**`nodes/mock`** (Go) — Referenz-Node ohne echte Medientechnik, Begleiter
zu `docs/entwicklung/NODE-TUTORIAL.md` für eigene Node-Implementierungen; einziger
mTLS-fähiger Node bisher (Abschnitt 2.1).

### 9.5 Eigenen Microservice zum Katalog hinzufügen

Zwei unabhängige Wege, je nach Auslieferungsform (Details/Codepfade:
`docs/entwicklung/NODE-TUTORIAL.md` Schritt 5):

- **Lokal gebautes Binary** (`runner: "process"`, der Normalfall für
  einen frisch mit dem SDK gebauten Node, s. `docs/entwicklung/NODE-TUTORIAL.md`):
  Eintrag von Hand in `deploy/catalog.json`, danach Orchestrator neu
  starten (`make stop && make start`) — die Datei wird nur beim Start
  gelesen, kein Hot-Reload.
- **Container-Image** (`runner: "podman"`, §17 Teil 4/5): Import über
  den **Administration**-Tab (bzw. `POST /api/v1/catalog`) ohne
  Orchestrator-Neustart, inkl. Admission-Check und Mehrfachversionen
  desselben Typs (§17 Teil 5). Dieser Weg akzeptiert serverseitig
  ausschließlich `runner: "podman"` — ein reiner Prozess-Eintrag lässt
  sich darüber nicht anlegen.

Start-Optionen eines Nodes (was im Start-Dialog oder über `options` in `POST /api/v1/instances` gesetzt werden kann) müssen in `deploy/node-options.json` stehen; der Launcher lehnt eine nicht deklarierte Option mit „unbekannte Option für diesen Node-Typ“ ab. Bekommt ein Node eine neue Umgebungsvariable, dort mit eintragen (deutsches Label und die Übersetzung `i18n.en`).

**Importierte Container-Microservices auf Hosts verteilen (Kap. 85).**
Der Import gilt zunächst nur auf dem Orchestrator. Damit der Typ auch auf
Remote-Hosts läuft, steht auf seiner Katalogkarte (Administration › Node-Katalog)
der Block **Hosts** mit **„Auf Hosts verteilen …“** (nur mit Versionsangabe beim Import).
Ablauf: Der Orchestrator baut aus Katalogeintrag und Image ein **signiertes Bundle**
(Ed25519-Verteilschlüssel des Clusters, liegt in der Datenbank) und schickt jedem
gewählten Host ein signiertes Kommando mit Einmal-Token. Der Host-Agent lädt das
Bundle **nur vom eigenen Orchestrator**, prüft Signatur (eigener Vertrauensanker,
der Verteilschlüssel wird beim ersten Kontakt hinterlegt und danach nicht still
ersetzt) und die Prüfsumme des Image-Archivs, dann `podman load`, und führt den
Typ in seinem eigenen Katalog (`<Zustandsverzeichnis>/microservices/`).

- **Der Host entscheidet** über Vertrauens-Erweiterungen des Eintrags. Ohne
  Konfiguration erlaubt er alle (`mxlAccess`, `mediaRead`, `hostNetwork`, `extraPort`,
  `dataDir`; Nutzerentscheidung 2026-11-04) — der Import bleibt admin-only, das Bundle
  signiert, der Contract-Check Pflicht. Enger fassen: `OMP_MICROSERVICE_ALLOW` am Host-Agent
  (Kommaliste, z. B. `extraPort,dataDir`; `none` = keine Erweiterung). Verlangt ein Eintrag
  mehr als erlaubt, wird die Installation abgelehnt (Fehlertext im UI), nie stillschweigend abgeschwächt.
- **Soll-Zustand in Postgres** (Tabelle `catalog_distribution`): ein Abgleich auf dem
  Leader zieht später hinzugekommene oder wieder erreichbare Hosts nach, wiederholt
  Fehlschläge mit wachsendem Abstand (bis 10 Minuten; „Erneut versuchen“ sofort) und
  erkennt Hosts, auf denen der Typ verschwunden ist (alle 2 Minuten Abgleich mit `catalog-list`).
- **Platzierung:** Ein importierter Typ wird nur auf Hosts angeboten und automatisch
  platziert, auf denen er „bereit“ ist. Ein direkter Start auf einem anderen Host
  liefert HTTP 409 mit Klartext statt OMP-2002.
- **Entfernen** („Entfernen“ am Host oder „Löschen“ im Katalog) räumt Image und –
  beim letzten Stand des Typs – das Datenvolumen auf den Hosts auf; läuft dort noch
  eine Instanz, bleibt es bei „fehlgeschlagen“, bis sie gestoppt ist.
- Konfiguration am Host-Agent: `OMP_MICROSERVICE_DIR` (Standard `microservices/`
  neben der Zustandsdatei), `OMP_MICROSERVICE_ALLOW`, optional `OMP_MICROSERVICE_PUBKEY`
  (Verteilschlüssel vorab); am Orchestrator `OMP_CATALOG_BUNDLE_DIR` (Zwischenspeicher
  der gebauten Bundles, Standard `<OMP_UPDATE_DIR>/catalog-bundles`).
- **Grenzen:** Das Image muss auf dem Orchestrator vorhanden sein, der die Bundles baut (im
  Orchestrator-Cluster der Leader). Der Download läuft über die im Host-Agent konfigurierte
  Orchestrator-Adresse (wie beim System-Update). Rootless Podman auf SELinux-Hosts (Rocky 9) ist noch nicht geprüft.
- Software-Stand je Host: `GET /api/v1/hosts/software[?refresh=1]` (Agent-Aktion `software`; Build-Stempel per
  `-ldflags` in `deploy/dev/start-hosts.sh` bzw. `make update-bundle`, Node-Stempel aus `OMPBUILD1…` in den Binaries,
  nie ausgeführt; UI: Hosts-Tab).
- API: `GET /api/v1/catalog/distribution`, `POST|DELETE /api/v1/catalog/{type}/hosts`
  (admin), `POST …/hosts/retry`, Download `GET /api/v1/host-catalog/{id}?token=…`.

### 9.6 Instanz-Label vergeben

Ohne eigenes Label heißt jede gestartete Instanz generisch
„`<Katalog-Label>` (`<Kurz-ID>`)" (z. B. „Source (66a0c71b)") — auch in
Kreuzschienen-Dropdowns anderer Nodes (Bild-/Audiomischer). Für über
einen **Workflow** gestartete Rollen übernimmt der Launcher automatisch
den im Workflow frei vergebenen Rollennamen als Label (kein Zusatzschritt
nötig). Für einen direkten Katalog-Start (`POST /api/v1/instances`) lässt
sich ein Label zusätzlich explizit im Request-Body mitgeben:
`{"type": "omp-source", "label": "Kamera 1"}`.

**Rollen bestehender Workflows umbenennen.** Rollennamen sind Verweise: sie stehen in den Port-Bezeichnungen der Nodes („`<Rolle>` Sender 1“), in Umgebungswerten, mit denen ein Node einen anderen beim Namen findet (z. B. `OMP_RADIO_TARGET_LABEL`), in Verbindungen, in der Workflow-Schnittstelle, im gesicherten Node-Zustand (Platzhalter und auch Namen wie `"mixer":"<Rolle>"`) und in den Playout-Channels (an Workflow + Rollenname gebunden). Rollen nicht durch Speichern der Definition umbenennen — das verwirft den gesicherten Zustand und lässt diese Verweise zurück. Stattdessen `POST /api/v1/workflows/{id}/rename-roles` mit `{"roles":{"alt":"neu"}}` für einen **gestoppten** Workflow: schreibt Definition, Verbindungen (samt Port-Präfix), Schnittstelle und Umgebungswerte um, migriert den gesicherten Zustand (Schlüssel, Platzhalter und Namensverweise) und zieht Module nach (die Playout-Channels).

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

Der Orchestrator kann über einen **Provider-Adapter** Cloud-Hosts mieten (`OMP_CLOUD_PROVIDER=mock|aws`; Zugangsdaten und Konfiguration gehören in die Datei `deploy/dev/cloud.env` (Vorlage `cloud.env.example`, nicht im Repo, `chmod 600`), die `make start` liest — nie in Oberfläche oder Datenbank; Sicherheitsnetze in `docs/betrieb/CLOUD-AWS.md`). Ein Cloud-Host ist ein gewöhnlicher Host (Host-Agent per Bootstrap-Token, Placement, Migration); neu sind nur Anlegen/Beenden und Kosten. Bausteine: Pools (Anbieter, Region, Instanztyp, min/max), Reservierungen („Kapazität von–bis“), Autoscaling-Regeln je Pool (Aus/Vorschlagen/Automatisch, harter Tages-/Monatsdeckel), Kostenvorberechnung und geschätzte Ist-Kosten, Draining-Abbau. API: `/api/v1/cloud/{pricing,estimate,hosts,costs,reservations,policies,suggestions}`; Bedienung: Tab **Cloud** (Benutzerhandbuch §10e). Die AWS-Anbindung ist ohne SDK gebaut und **noch nicht gegen echtes AWS getestet**; echte Starts sind standardmäßig gesperrt (nur Trockenlauf).


### 9.9 Orchestrator-Module (Playout, Audio-Ausgabe, Cloud, File Eingangskontrolle/Review, Stream Ingest)

> **Dienste statt Module (Kapitel 48):** Das Intercom ist kein Modul mehr, sondern ein Dienst im Node `omp-intercom`. Das Modul `extsvc` ist das generische Dienst-Gateway (`/api/v1/ext/<dienst>/…`): es prüft Anmeldung und Funktionsrecht, reicht die Identität an den Dienst weiter und bringt dessen Rechte, Tabs, Kacheln und Metriken in die Plattform. Anleitung: `docs/entwicklung/MODULE-SCHREIBEN.md` §7.

Domänenfunktionen sind **Module** des Orchestrators, keine Kernfunktion: **Playout** (Channels, Trigger, As-Run, Preflight),
**Audio-Ausgabe** (Audio-Regeln), **Cloud** (§9.8) und **File Eingangskontrolle/Review** (Datei-QC, Review-Player, Conform, Metadaten — `docs/entwuerfe/ENTWURF-FILE-QC.md`) und **Stream Ingest** (geplante Live-Aufnahme mit Ressourcenplanung — `docs/entwuerfe/ENTWURF-INGEST.md`). Jedes Modul bringt seine Routen, ggf. Hintergrundjobs, Kennzahlen und seine
Oberfläche mit; `GET /api/v1/modules` zeigt Stand und Oberfläche (die Shell baut ihre Tabs daraus). Mit der Umgebungsvariable
`OMP_MODULES_DISABLE=cloud,audio-rules` (Komma-Liste der Namen `cloud`, `playout`, `audio-rules`, `review`, `ingest`) lässt sich ein Modul abschalten:
seine Routen antworten dann mit 404 und der Tab fehlt — der Kern (Nodes, Graph, Hosts, Workflows, Rechte) läuft unverändert. Ein Modul,
dessen Start oder Migration scheitert, steht als `failed` im Manifest, die übrigen laufen weiter. Eigene Module: `docs/entwicklung/MODULE-SCHREIBEN.md`.

**Hauptkontrollraum (Modul `mcr`, Kap. 106.9):** Events mit Leitungen, Vorlagen und Rollen je Event; Name `mcr` in `OMP_MODULES_DISABLE`. Routen unter `/api/v1/mcr/`: `templates` (GET/POST, PUT/DELETE `{id}`), `events` (GET/POST, GET/PUT/DELETE `{id}`), `events/{id}/transition` (`{"to": …}`), `events/{id}/members` (PUT), `settings` (GET/PUT, nur Admin; Hausformat der Vorgabe). Lebenszyklus `planned → testing → live → teardown → done`, außerdem `cancelled` aus `planned`/`testing`, `testing → planned` (Umbau) erlaubt; alles andere → 409. Löschen nur in `planned`/`done`/`cancelled`. In `live` ändert sich die Leitungsstruktur nicht (nur Einstellungen). Leitungsarten `srt`, `rist`, `st2110`, `hls`, `mxl`. **Geheimnisse (Passphrasen, Passwörter, Token) werden nie gespeichert** (Fehler 400); erlaubt ist nur der Name eines Schlüssels (`passphraseKey`). Hausformat: Vorgabe (`mcr.houseFormat`) → Event → Leitung, getrennt für Bild und Ton, jederzeit änderbar, ohne feste Werte im Code; die Antwort eines Events enthält `effectiveHouse` je Leitung. Funktionsrechte `mcr.manage` und `mcr.live`. **Lebenszyklus mit Wirkung (106.10):** `testing` legt den Workflow `mcr-<name>-<id>` an und startet ihn (je Leitung Eingang + `omp-normalizer`, Interface-Ausgang = Leitungsname); `live` schaltet die Stoppbestätigung ein, `teardown` stoppt nur mit `"confirm": true` (sonst 409 `confirmation_required`), `done`/`cancelled` löschen den Workflow. Die Datenbank ist die Quelle der Wahrheit: die Startumgebung der Rollen (Hausformat, Eingangseinstellungen) kommt bei jedem Start über den Rollen-Umgebungs-Beobachter aus der Datenbank, und alle 3 s gleicht das Modul neu gestartete Instanzen ab (Hausformat, Ausgleich). Passphrasen: nur `passphraseKey`, die Datei liegt in `OMP_MCR_SECRETS_DIR` (Rechte 0600). Routen: `GET /api/v1/mcr/events/{id}/status`, `POST …/lines/{lineId}/measure`, `PUT …/lines/{lineId}/avsync`. **Intercom-Rückwege (106.12):** Leitungs-JSON `intercom.return` (`mode` `mix`/`guest`, `source`, `transport`); Regel: Quelle ohne Kommentar → IFB direkt, Quelle mit Kommentar → N-1-Bus am Mischer (`aux.<id>.setN1`, `exclude` = Kommentarkanal), sonst Warnung am Event (`warnings`). Vertragsrollen des Intercoms `event.return.create`/`.delete`. **Überwachung, Alarme, Rollen, Kette (106.13–106.15):** je Event ein Multiviewer-Workflow, je Leitung ein `omp-scope` im Überwachungsmodus (rendert nichts); Multiviewer nur für angesehene Events (Watch), `GET /api/v1/mcr/monitor` liefert die Wand, `POST …/lines/{id}/monitor` die Station Abhören/Messgerät. Alarme: Tabelle (Migration V4), `GET /api/v1/mcr/alarms/history`, Quittieren `POST …/events/{id}/alarms/{alarmId}/ack`; Prüfprofil `qc.profile` (`standard`/`strict`/`off`) plus Abweichungen `<Prüfung>.<holdSeconds|threshold|enabled|severity>` je Event/Leitung (`monitoring`), Reaktionsregeln am Event (Rand, Alarm-PiP über `omp-switcher`, Hinweis, GPIO, `panel` = Textanzeige an Intercom-Sprechstellen über die Vertragsrolle `panel.notice`, nur bei Alarmeintritt, nur an verbundene Panels). Aufzeichnungen über den Ingest (Migration V5, nur dekodierter MXL-Fluss). Rollen je Event (`lead`, `engineer`, `viewer`, `commentator`, Migration V6, `mcr.view` ⊂ `mcr.live` ⊂ `mcr.manage`); Verbindungen der Mitglieder als `authz`-Bindungen; Zugriffsregeln (`accessrules`) werden bewusst nicht gesetzt. Verarbeitungskette als Daten (`mcr.chain`, `mcr.stageTypes`, Migration V3); laufende Workflows werden per `workflows.Service.Reshape` umgeformt. Kapazitäts-Vorprüfung `GET …/events/{id}/precheck` (Warnung, keine Sperre). **Betrieb:** Passphrasen liegen als Dateien (Rechte 0600) in `OMP_MCR_SECRETS_DIR`, nie in der Datenbank. Nach Änderungen an Routen/Rechten `go run ./cmd/routetable -strip-source > cmd/routetable/testdata/routes.golden.json`. **Austauschbare Funktionen (106.13h):** die Einstellung `mcr.slots` (`PUT /settings {"slots":{…}}`) nennt den Node-Typ für Normalizer, Up-/Down-Converter, A/V-Delay und Ton-Teiler; leerer Converter/Delay = die Funktion bleibt im Normalizer, sonst wird der Node automatisch vor (Converter) bzw. hinter (A/V-Delay) den Normalizer gesetzt; bei getrenntem A/V-Delay ist der eigene Ausgleich des Normalizers aus, und ein gemessener oder manueller Versatz wird in Bilder + Millisekunden umgerechnet und am Delay-Node gesetzt (`delay.videoFrames`/`delay.audioMs`); je Slot optional `ports`, `env` (Start-Umgebung aus dem Hausformat, Platzhalter `{width} {height} {rate} {rateNum} {rateDen} {scan} {channels} {sampleRate}`), `params`, `maxFrames`, `strict`, `data`. **Ton-Teiler (106.19):** Leitungsoption `normalize.audioSplit` (`tracks`/`pairs`/`outputs`, Hauskanäle); jeder Ausgang wird ein Workflow-Ausgang „Leitung · Name“. **Datenspur:** hat die Leitung eine Datenquelle, reicht der Normalizer ANC/Zeitcode/Untertitel durch; der Alarm `signal-dataLoss` (4 Abgleichläufe ≈ 12 s ohne Daten) läuft über Alarmliste, Reaktionen und den globalen Alarmweg. **Globaler Alarmweg (106.13i):** MCR-Signalalarme werden mit Event, Leitung und Event-Workflow angereichert (`alertsink.Sink.Enrich`; Regeln je Event-Workflow, Webhook-Feld `mcr`), erscheinen im globalen Reiter „Alarme“ und in der Fußleiste (Quelle „MCR“) und schließen, wenn das Event endet oder gelöscht wird (`SweepStaleAlarms` beim Start). Die Historie `GET /api/v1/mcr/alarms/history` filtert nach `event`, `line`, `kind` (Teilstring ohne Groß-/Kleinschreibung, mit oder ohne `signal-`), `severity`, `state` (`open|ended|unacked`) und `days`. **Grenzen:** ein Tonfluss je Leitung; CPU je Event auf kleinen Hosts hoch (Normalizer ~1 Kern, Multiviewer ~1,4 Kerne bei 720p-Leinwand, Scope ~0,33 Kern je Leitung) — vor dem Teststart die Vorprüfung beachten; inhaltsbasierte A/V-Messung (106.16) wartet auf Material.

### 9.9a Zugriffsregeln, Dateiübertragung und AVC-Intra (neu)

- **Zugriffsregeln für Quellen und Senken** (`internal/accessrules`, Tabelle `access_rules`, Migration 0064): wer welche Quellen/Senken sehen und schalten darf, je Nutzer, Gruppe oder global; Sperren gewinnt, jede Erlauben-Regel schaltet auf Freigabeliste, Schalten setzt Sehen voraus. Durchgesetzt in `GET /api/v1/sources|sinks|graph` (gefiltert), `POST/DELETE /api/v1/graph/edges` und dem Schalten auf Workflow-Eingänge (403 mit Begründung); Verwaltung unter `/api/v1/access-rules` (Recht `configure`, Änderungsprotokoll), Vorschau `GET /api/v1/access-rules/effective?user=…`. Ausgenommen: `configure`, Dienst-Konten der Nodes, Support-Zugang. Bedienung: Benutzerhandbuch 10c-3b.
- **Dateien kopieren und verschieben** (Modul `files`, Recht `files.transfer`): blockweise über die jobwire-Operationen `read-chunk`, `write-chunk`, `commit`, `abort`, `move`, `mkdir` (384 KiB je Block, SHA-256 je Block, Zieldatei als `.omp-part` bis zum atomaren `commit`); Endpunkte `POST /api/v1/files/transfer/preview`, `POST /api/v1/files/transfer`, `GET /api/v1/files/transfers`, `POST /api/v1/files/transfers/{id}/cancel`; Fortschritt in `file_transfers`. **Host-Agenten müssen auf die neue Version aktualisiert werden** (Abschnitt 5b), sonst melden sie „unbekannte Operation“. Hintergrund: `docs/decisions.md`, Nachtrag „Dateien kopieren und verschieben“.
- **Workflow-Import mit Prüfung:** `POST /api/v1/workflows/import/preview` (Katalog, Definition, Hosts, Gruppen, Version der Datei, unbekannte Felder, vorhandener Workflow samt Unterschieden) und `POST /api/v1/workflows/import?replace=<id>`; Exportdateien tragen `meta.orchestratorVersion`, Rollenbindungen `subjectType`/`subjectName`.
- **AVC-Intra Class 100 (1080/50p, 16 Tonspuren):** Recorder-Profil `record.profile` bzw. `OMP_RECORDER_PROFILE` (`avci50|100|200`, nur `.mxf`); MXF-Player und Kanal-Player folgen der Bildrate des Workflows (`OMP_FRAMERATE_NUM/DEN`); QC-Profil `avc-intra-100-1080p50`; Audio-Regeln-Schema `mxf-16`. Rechenbedarf und offene Punkte: Benutzerhandbuch 5d-2.

### 9.10 Stream Deck (WebHID, Browser-Bedienpult)

Rein clientseitig (`ui/shell/streamdeck/`), kein Server-Anteil. Modelle (Hersteller-HID-Beschreibung, `docs/entwuerfe/ENTWURF-STREAMDECK.md` §1): XL und XL 2022
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
aus dem Descriptor. **Eigene/fremde Nodes:** `docs/entwicklung/NODE-TUTORIAL.md`, Abschnitt „Stream-Deck-Belegung für einen eigenen Node“.
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

### 9.10a MIDI-Pulte (Web MIDI und Gateway)

Zwei Wege, eine Logik (`docs/contracts/CONTRACT-MIDI.md`): **Browser** (`ui/shell/midi/`, Knopf „MIDI“) für USB-Pulte am Arbeitsplatz-Rechner, **Node `omp-midi-gateway`** für Pulte am Server oder im
Netzwerk, ohne Browser. Kern (TypeScript und Rust, gegen `docs/midi/*.json` geprüft): Mackie-Control-Codec (`mcu`), Fader-Kennlinie (`fader-law`/`fader.rs`), Pult-Logik (`surface-logic`/`surface.rs`) und
generisches Profil (`profile`). Der **Simulator** (`sim-surface.ts`, `SimPort`) versteht die Nachrichten des Rechners wie ein Pult (Fahrfader nur ohne Berührung, LEDs, Anzeige, Pegel) und erzeugt Bedienung —
alle Tests laufen ohne Gerät. Die Anbindung an den Mischer ist `audio-backend.ts` bzw. `mixer.rs` (`mixState`, Live-Strom, `channel.<id>.set*`). **Tastenbelegung** (`keys.ts`/`keys.rs`, Szenarien `docs/midi/keys-golden.json`): Standardbelegung ohne Konfiguration (F1–F8 auf den gewählten Kanal, Pfeile, Solo löscht Vorhören, Scrub schaltet das Jog-Rad), `{ch}`-Vorlagen, LED aus dem Mischer-Zustand, Seiten über die acht Ansichtstasten, Kurzmeldung in der Pult-Anzeige; Jog-Modi `gain`/`select`/`nudge`. Tasten, Drehgeber und Jog gelten nur auf MIDI-Kanal 1, alles andere geht an das Zusatzprofil (`keys.profile`); Noten ohne Namen heißen `note<N>`. **Gerätewissen aus dem P1-M-Handbuch:** vier USB-Anschlüsse (1–3 = DAW-Tasten, 4 = iMAP), Touchscreen mit 16 Feldern in 5 Farbebenen wird in iMAP belegt und sendet Mackie-Tasten (`docs/contracts/CONTRACT-MIDI.md` §1). **Simulator-Fader** im Stil der Audiomischer-Fader (`sim-fader.ts`), Kennlinie mit denselben Stützstellen wie der Bildschirm-Fader.
**Nicht an echter Hardware geprüft**, die offenen Punkte stehen in `UMSETZUNG.md` Kap. 93.

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
- Eigenen Node-Typ bauen (SDK-Tutorial): `docs/entwicklung/NODE-TUTORIAL.md`
