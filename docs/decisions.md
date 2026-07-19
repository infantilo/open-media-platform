# Entscheidungen / Blocker-Log

Dokumentiert Entscheidungen, bei denen mehrere Optionen möglich waren, und
Blocker samt gewählter Lösung. Neueste Einträge unten anhängen.

## 2026-07-07 — Toolchain-Installation (Schritt A1)

**Kontext:** Go, Deno und Podman waren auf der Dev-Maschine (Debian 12
"bookworm", Crostini) nicht installiert.

- **Go:** Debian bookworm liefert nur `golang-go` 1.19 (Stand 2022) über apt.
  Stattdessen offizielles Tarball von go.dev installiert
  (`go1.26.4.linux-amd64.tar.gz`, SHA-256 gegen die offizielle Downloads-API
  geprüft) nach `/usr/local/go`, PATH-Eintrag in `~/.bashrc` ergänzt. Grund:
  aktuelle Go-Version statt drei Jahre alter Distro-Paketversion.
- **Deno:** Kein Debian-Paket verfügbar. Offizieller Installer
  (`https://deno.land/install.sh`) nach `~/.deno/bin` installiert, PATH in
  `~/.bashrc` ergänzt. Passt zum „ein Binary pro Werkzeug"-Muster
  (`ARCHITECTURE.md` §4.1).
- **Podman:** Debian-bookworm-Paket (4.3.1) über `apt` installiert — aktuell
  genug für rootless-Betrieb und Quadlets (ab A2).

Konsequenz für neue Shells/CI: `PATH` muss `/usr/local/go/bin` und
`$HOME/.deno/bin` enthalten (siehe `~/.bashrc`); bei automatisierten
Nicht-Login-Shells (z. B. CI-Runner) ggf. explizit setzen.

## 2026-07-07 — Rootless-Podman: fehlendes subuid/subgid-Mapping (Schritt A2)

**Problem:** `podman run` warnte initial „no subuid ranges found... Using
rootless single mapping into the namespace. This might break some images.",
weil `/etc/subuid`/`/etc/subgid` für den Nutzer leer waren.

**Lösung:** `sudo usermod --add-subuids 100000-165535 --add-subgids
100000-165535 infantilo` + `podman system migrate`. Damit bekommt jeder
rootless-Container einen echten User-Namespace (nicht mehr 1:1-Mapping auf
den Host-User) — Standard-Voraussetzung für rootless Podman, betrifft nur
diese Dev-Maschine, keine Projekt-Code-Konsequenz.

## 2026-07-07 — Podman-Version zu alt für systemd-Quadlets (Schritt A2)

**Problem:** `UMSETZUNG.md` A2 sieht `deploy/quadlets/omp-nats.container`
+ `systemctl --user` vor. Die auf Debian bookworm per `apt` installierte
Podman-Version ist 4.3.1; Quadlet-Unterstützung kam erst mit Podman 4.4
(Anfang 2023). `systemctl --user daemon-reload` erzeugt daher keine
`omp-nats.service`-Unit (kein Quadlet-Generator vorhanden). Ein
`bookworm-backports`-Paket für `podman` existiert nicht (geprüft via
packages.debian.org); die nächste Alternative wäre das Kubic/OBS-Drittanbieter-
Repo.

**Optionen geprüft:**
1. Kubic/OBS-Repo hinzufügen → neuere Podman-Version mit Quadlet-Support,
   aber zusätzliches Drittanbieter-APT-Repo + GPG-Key, widerspricht dem
   Minimal-Dependency-Ziel und der aktuellen Distro-Vertrauenskette.
2. Podman aus Source bauen → hoher Aufwand für ein Dev-Detail.
3. **Gewählt:** Der in `UMSETZUNG.md` A2 selbst vorgesehene Fallback
   („falls kein systemd-user vorhanden") sinngemäß angewendet: `make up`/
   `make down` starten/stoppen den Container direkt per `podman run
   --restart=always` / `podman rm`, ohne Quadlet/systemd-Unit. Die
   Quadlet-Datei bleibt in `deploy/quadlets/` als Referenz für spätere
   On-Prem-Produktion (`ARCHITECTURE.md` §4.3) erhalten, wird auf dieser
   Dev-Maschine aber nicht verwendet.

**Konsequenz:** Persistenz über Host-Reboots hinaus fehlt auf dieser
Dev-Maschine (kein systemd-Restart-Management) — für den Entwicklungs-
Workflow ausreichend (`make up` startet den Container bei Bedarf neu).
Sobald eine Podman-Version ≥ 4.4 verfügbar ist (z. B. auf einem echten
Zielsystem), kann `up`/`down` auf den Quadlet-Pfad umgestellt werden, ohne
die `.container`-Datei zu ändern.

## 2026-07-07 — NMOS-Registry-Image (Schritt A3)

**Image-Wahl:** `docker.io/rhastie/nmos-cpp:latest` (wie in `UMSETZUNG.md`
A3 vorgeschlagen) — verpackt die Referenzimplementierung `sony/nmos-cpp`
(cpprestsdk/Boost/OpenSSL, aktiv gepflegt) inkl. Registration-, Query- und
Node-API sowie optionalem MQTT-Broker. Alternative (`Mellanox/docker-nmos-cpp`)
geprüft, aber `rhastie`-Image ist gebräuchlicher (auch für den offiziellen
Easy-NMOS-Testaufbau verwendet) und einfacher konfigurierbar (ein
JSON-Config-Volume statt Build-Time-Flags).

**Konfiguration:** `deploy/nmos/registry.json` wird nach `/home/registry.json`
gemountet (`RUN_NODE=FALSE`, damit der Container nur die Registry startet,
nicht zusätzlich einen Sony-Referenz-Node). `http_port=8010` bedient
Registration- **und** Query-REST-API auf demselben Port (Standardverhalten
von nmos-cpp — beide APIs sind Pfad-getrennt: `/x-nmos/registration/...`
bzw. `/x-nmos/query/...`), `query_ws_port=8011` das Query-WebSocket für
Subscriptions.

**Abweichung von der Verifikationserwartung in `UMSETZUNG.md`:** Die dort
angegebene Erwartung `GET .../query/v1.3/nodes → []` trifft auf dieses
Image nicht zu — der Registry-Prozess registriert sich selbst als NMOS-Node
(Selbstbeschreibung für IS-04-Discovery), daher liefert eine frische
Registry ein Array mit **einem** Eintrag (dem Registry-Node selbst), nicht
ein leeres Array. Tatsächliches Kriterium: Query-API antwortet mit gültigem
JSON-Array (Erreichbarkeit), zusätzliche Fremd-Nodes erscheinen ab Schritt
A5/A7. Gleiche Fallback-Begründung wie A2 (Podman 4.3.1 ohne Quadlets) gilt
auch hier — `deploy/quadlets/omp-nmos-registry.container` bleibt Referenz,
`make up`/`down` starten den Container direkt per `podman run`.

## 2026-07-07 — Verifikations-Kommando angepasst (Schritt A4)

**Problem:** `UMSETZUNG.md` A4 verifiziert mit `go run ./orchestrator` —
das funktioniert nicht, weil `orchestrator/` laut A1 ein **eigenes**
Go-Modul ist (`go mod init .../orchestrator` innerhalb des Verzeichnisses),
das Repo-Root selbst aber kein Go-Modul ist. `go` sucht das Hauptmodul nur
in der aktuellen/übergeordneten Verzeichniskette, nicht in
Unterverzeichnissen, daher: „cannot find main module".

**Lösung:** Äquivalent aus dem Modulverzeichnis selbst ausführen:
`cd orchestrator && go run .` (so auch im `Makefile`, `build`/`test`-Targets
machen das bereits seit A1). Funktional identisch, betrifft nur die
Aufruf-Syntax. `OMP_UI_DIR` defaultet passend dazu auf `../ui` (relativ zu
`orchestrator/` als Arbeitsverzeichnis).

## 2026-07-07 — jq nachinstalliert (Schritt A5)

`jq` war nicht installiert, wird aber von den in `UMSETZUNG.md` selbst
vorgegebenen Verifikationskommandos vorausgesetzt (A5, A8, ...). Via
`apt-get install jq` nachgezogen (Debian-Paket, aktuell genug für reines
JSON-Filtering, keine Versionsbindung an das Projekt).

## 2026-07-07 — IS-04-Feldnamen aus der Spezifikation, nicht aus dem
Gedächtnis (Schritt A5)

Gemäß Arbeitsregel §0.6 wurden die tatsächlichen v1.3-JSON-Schemas aus
`AMWA-TV/is-04` (Branch `v1.3.x`, vormals `AMWA-TV/nmos-discovery-registration`
— Repo wurde umbenannt) nachgeschlagen statt Feldnamen zu raten:
`resource_core.json`, `node.json`, `device.json`, `sender.json`,
`receiver_core.json`/`receiver_video.json`. Wichtigster Fund: das
Medien-**Format** steht bei Sendern nur indirekt über `flow_id` → Flow-
Resource (`flow.format`) zur Verfügung, bei Receivern dagegen direkt als
eigenes `format`-Feld am Receiver selbst — deshalb lösen
`internal/registry/client.go` (`buildSnapshot`) und das Fake-Node-Skript
das unterschiedlich auf. Das Fake-Node-Skript registriert bewusst keinen
Flow (nicht Teil der A5-Anweisung), daher hat der Fake-Sender im
Testaufbau ein leeres `format`-Feld — das ist korrekt, kein Bug.

**Nebenbefund:** Ohne wiederholten Heartbeat (`POST
.../health/nodes/<id>`) verschwindet der Fake-Node nach
`registration_expiry_interval` (12 s, `deploy/nmos/registry.json`) wieder
aus der Registry — Standard-IS-04-Verhalten. Das Skript sendet einen
einmaligen Heartbeat direkt nach der Registrierung, das reicht für die
Verifikation, aber für längere manuelle Tests muss das Skript ggf. erneut
ausgeführt werden.

## 2026-07-07 — nats.go als Ausnahme von der Minimal-Dependency-Regel
(Schritt A6)

`github.com/nats-io/nats.go` (offizieller NATS-Client) eingebunden — wie in
`UMSETZUNG.md` A6 explizit als Ausnahme vorgesehen. Begründung: Ein
eigener minimaler NATS-Client wäre unnötiges Risiko (Reconnect-Logik,
Protokoll-Details) für ein zentrales Infrastrukturstück; der offizielle
Client ist schlank genug (Transitive Deps: `nkeys`, `nuid`,
`klauspost/compress`, `golang.org/x/{crypto,sys}` — alle für
NATS-Auth/Kompression, kein Bloat). Initial-Connect ist nicht fatal
(`RetryOnFailedConnect` + `MaxReconnects(-1)`): der Orchestrator startet
auch, wenn NATS gerade nicht erreichbar ist, und verbindet sich im
Hintergrund nach — konsistent mit der Resilienz-Linie aus
`internal/registry.Poller` (A5).

## 2026-07-07 — NATS-CLI (`natscli`) nachinstalliert (Schritt A6)

Für die in `UMSETZUNG.md` A6 vorgesehene Verifikation (`nats pub ...`)
gibt es weder im `nats:latest`-Container noch auf dem Host ein `nats`-CLI
(das offizielle NATS-Server-Image enthält nur `nats-server`, nicht das
CLI-Tool). Offizielles `natscli` (`github.com/nats-io/natscli`) per `go
install` nachgezogen — passt zum „ein Binary pro Werkzeug"-Muster
(ARCHITECTURE.md §4.1) und wird für Event-Bus-Debugging auch in späteren
Schritten (B4 Tally-Events, C-Phase) wiederkehrend gebraucht.

## 2026-07-07 — Mock-Node: eigenes Go-Modul, Scope-Grenze zu A8 (Schritt A7)

**Modul-Layout:** `nodes/mock/` ist ein eigenständiges Go-Modul (eigenes
`go.mod`), kein Teil des Orchestrator-Moduls — konsistent mit dem
Node-Contract (`ARCHITECTURE.md` §5: "eigenständiger Prozess/Container",
unabhängig baubar/startbar) und damit, dass künftige echte Media-Nodes
(Phase C) ohnehin als separate Rust-Crates kommen. UUIDs für IS-04-IDs
werden mit einer ~10-Zeilen-Eigenimplementierung (`internal/idgen`, RFC
4122 v4) erzeugt statt einer Library — Minimal-Dependency-Regel.

**Scope-Grenze zu A8:** `GET /descriptor.json` liefert bewusst nur einen
einzigen, schreibbaren Parameter (`label`) und keine Methoden. A8 fügt
laut `UMSETZUNG.md` explizit einen weiteren Parameter (`gain`) und eine
Methode (`reset()`) hinzu und formalisiert das Format als JSON-Schema
(`docs/descriptor-v0.schema.json`) mit generischem Orchestrator-Proxy
(`GET/PATCH /api/v1/nodes/<id>/params/<name>`). A7 liefert nur die
Node-seitigen Endpunkte (`GET/PATCH /params/<name>` direkt am Mock-Node),
noch ohne Orchestrator-Proxy und ohne Schema-Datei — sonst würde A8 keine
neue Substanz mehr haben (Arbeitsregel §0.2: "keine Features aus späteren
Schritten mitnehmen").

**Resilienz:** Sowohl NATS- als auch Registry-Verbindung sind beim Start
nicht fatal (Retry-Loop mit 2s-Backoff für die Registrierung, gleiches
`RetryOnFailedConnect`-Muster wie im Orchestrator für NATS). Schlägt ein
Heartbeat mit HTTP 404 fehl (Registry hat die Node vergessen, z. B. nach
Neustart), registriert sich der Mock-Node automatisch neu.

## 2026-07-07 — Descriptor v0: Format und IS-12/14-Mapping-Notiz (Schritt A8)

**Format:** `docs/descriptor-v0.schema.json` (JSON Schema draft-07) — ein
Node beschreibt sich über `parameters[]` (name, type ∈
{number,boolean,enum,string}, unit, range, readonly) und `methods[]`
(name, args[]). Bewusst flach, kein Objektbaum — Fallback-Klausel
`ARCHITECTURE.md` §8 ("einfacheres eigenes JSON-Schema-basiertes
Self-Describe-Format mit klarer Migrationsschiene zu IS-12/14").

**Mapping-Notiz nach IS-12/14 (MS-05-02 Control Framework)**, für die
spätere Migration:
- Ein Node-Descriptor entspricht künftig einem Root-`NcBlock`
  (`ARCHITECTURE.md` §11.1); jeder `parameter` wird zu einer
  `NcProperty` eines `NcWorker`-Members, jede `method` zu einer
  `NcMethod`.
- `type: number` mit `range.min/max` → `NcParamConstraintNumber`;
  `type: enum` mit `range.values` → `NcParamConstraintString`/enum-artige
  Einschränkung; `readonly` → `NcPropertyConstraints`/fehlende
  Setter-Methode.
- `unit` hat in MS-05-02 keine 1:1-Entsprechung als eigenes Feld
  (Einheiten stecken dort meist in der Property-Semantik/Dokumentation
  der jeweiligen Standardklasse) — bleibt in v0 als eigenes,
  migrationsfreundliches Feld erhalten.
- **Bewusst nicht jetzt umgesetzt:** Standardklassen-Wiederverwendung
  (`ARCHITECTURE.md` §11.1 Punkt 2), Class-IDs, Authority-Key — das ist
  P1-Arbeit an der echten Playout-Node (Schritt C1), nicht am Mock.

**Schema-Validierung:** `github.com/santhosh-tekuri/jsonschema/v6`
(Apache-2.0) als Test-Only-Dependency in `nodes/mock` — Standardbibliothek
hat keinen JSON-Schema-Validator; eine Handschrift-Prüfung der immer
gleichen Feldnamen im Go-Code selbst hätte gegenüber der Schema-Datei
driften können, ohne dass ein Test das bemerkt. Validiert sowohl, dass
der echte Mock-Descriptor dem Schema genügt, als auch, dass das Schema
offensichtlich falsche Descriptoren tatsächlich ablehnt (kein
All-erlaubend-Schema).

**Orchestrator-Proxy:** Neues Feld `NodeView.APIBaseURL`
(`orchestrator/internal/registry`), aus dem ersten `api.endpoints`-Eintrag
des IS-04-Node-Resource konstruiert (Standardfeld, keine Node-Typ-
Kenntnis). `GET /api/v1/nodes/<id>/descriptor`,
`GET|PATCH /api/v1/nodes/<id>/params/<name>`,
`POST /api/v1/nodes/<id>/methods/<name>` sind reine HTTP-Passthrough-
Proxies (`orchestrator/internal/httpapi/proxy.go`) — der Orchestrator
parst den Descriptor nicht, validiert ihn nicht gegen das Schema und
kennt keine Parameter-/Methodennamen.

## 2026-07-07 — Resource-Aware Placement & Live-Migration: geprüft, geparkt
(vor Schritt A9)

**Kontext:** Nutzer-Anforderung, dass der Orchestrator jederzeit
Ressourcenmetriken aller Hosts/VMs kennen und überlastete Nodes
proaktiv per Make-before-break (neue Instanz starten, verifizieren,
IS-05-Umschaltung, dann Teardown) auf einen anderen Host migrieren soll,
bevor ein Audio-/Video-Ausfall entsteht (Beispiel: überlasteter DVE-Node).

**Vorgehen:** Anforderung von Claude Fable gegen `ARCHITECTURE.md` prüfen
lassen (unabhängige Zweitmeinung vor einer Architekturänderung).
Ergebnis: passt philosophisch zu EBU DMF/Node-Lifecycle, erweitert die
Orchestrator-Rolle aber von „Lifecycle + Routing" zu „Scheduler" — echte
Erweiterung, keine Detailarbeit. Fehlende Bausteine: Host-Telemetrie
(über NATS, kein neues Transportmittel), eine Placement-Engine (reines
Custom-Design, zunächst advisory statt automatisch), ein
Make-before-break-Protokoll (State-Export/Import + Readiness-Signal als
Node-Contract-Erweiterung). Auf dem Single-Host-Dev-Rechner (kein
zweiter Host, kein 2110-Netz) nur das Protokoll simulierbar, nicht der
Ausfallfreiheits-Anspruch selbst.

**Entscheidung:** Anforderung akzeptiert, Timing geparkt.
- `ARCHITECTURE.md` §5 (Node-Contract) um Punkt 6 ergänzt: State-Export/
  Import + „media-ready"-Signal — **jetzt** in die Spec aufgenommen, weil
  SDK v1 (Ende Phase C) den Contract für Community-Nodes einfriert;
  nachträgliches Ergänzen wäre ein Breaking Change.
- `ARCHITECTURE.md` neuer Abschnitt §6.1 „Resource-Aware Placement &
  Live-Migration (geplant, ab P2)" dokumentiert Konzept, Bausteine,
  Standards-Abdeckung und Testbarkeits-Grenzen.
- `UMSETZUNG.md` Phase D um Punkt D6 (geplant, nicht detailliert)
  ergänzt.
- **Keine** A–C-Schritte ändern dadurch ihren Scope; A9 (CI-Grundgerüst)
  läuft wie geplant weiter.

## 2026-07-07 — CI: GitHub Actions statt nur `make ci` (Schritt A9)

Repo hat bereits einen GitHub-Remote (`origin` →
`github.com/infantilo/open-media-platform`, `gh auth status` bestätigt
eingeloggt) — daher laut `UMSETZUNG.md` A9 GitHub-Actions-Workflow
(`.github/workflows/ci.yml`) statt nur lokalem `make ci` gebaut. Ein Job
(`check`) führt `make ci` aus (Go vet/test beider Module + `deno check`,
inkl. Descriptor-Schema-Validierung aus A8 — kein separater Schritt
nötig, da bereits Teil von `nodes/mock`s `go test`). Zweiter Job
(`amwa-nmos-testing`) als deaktivierter Platzhalter (`if: false`) für
Schritt D2. Verifiziert per frischem `git clone` in ein Temp-Verzeichnis
+ `make ci` (lokal, ohne GitHub) — funktioniert, da alle Tests
selbstständig sind (keine laufende Registry/NATS-Container nötig) und
der Schema-Pfad in `nodes/mock/internal/descriptor/schema_test.go` über
`runtime.Caller` relativ zur Testdatei aufgelöst wird, nicht über das
Arbeitsverzeichnis.

**Noch nicht gepusht:** Die lokalen Commits (inkl. A1–A9) liegen noch
nicht auf `origin` — der Workflow läuft also erst in GitHub Actions,
sobald gepusht wird. Push ist eine sichtbare Aktion auf einem geteilten
Remote, daher bewusst nicht automatisch ausgeführt; separate
Nutzer-Entscheidung.

## 2026-07-07 — IS-05-Feldnamen aus der Spezifikation; Scope-Grenzen (B1)

**Spezifikation nachgeschlagen** (Arbeitsregel §0.6): IS-05 v1.1-Schemas
aus `AMWA-TV/is-05` (Branch `v1.1.x`) — `sender-receiver-base.json`,
`receiver-stage-schema.json`, `receiver-response-schema.json`,
`activation-schema.json`, `receiver-transport-file.json`,
`receiver_transport_params.json`. Bestätigt: Receiver-Resource (staged
**und** active) hat die Form `{sender_id, master_enable, activation,
transport_file, transport_params}`; `activation.mode` kennt u. a.
`"activate_immediate"`; `transport_params` darf `[{}]` sein, wenn kein
Transport-Detail zu setzen ist.

**Scope-Grenzen bewusst gezogen** (nur was B1 tatsächlich braucht):
- Nur der **Receiver**-seitige Connection-Endpoint wurde im Mock-Node
  implementiert (`nodes/mock/internal/connection`) — Kanten werden laut
  `UMSETZUNG.md` B1 ausschließlich aus Receiver-Active-Endpoints
  abgeleitet und per PATCH auf den Receiver hergestellt/getrennt.
  Sender-seitige Connection-Endpoints (die ein vollständiger
  IS-05-Node zusätzlich bräuchte) sind nicht Teil dieses Schritts.
- Nur `staged`/`active` implementiert, nicht `constraints/` oder
  `transporttype/` — die Basis-Discovery-Endpunkte
  (`/single/receivers/`, `/single/receivers/<id>/`) fehlen ebenfalls.
  Kann bei Bedarf für echte IS-05-Konformität (Schritt D2, AMWA NMOS
  Testing Tool) nachgezogen werden.
- Der Mock-Node-eigene PATCH-Endpoint akzeptiert immer alle drei Felder
  (`sender_id`, `master_enable`, `activation`) statt echter
  Teil-Updates wie im vollen IS-05-Standard — ausreichend, weil nur der
  eigene Orchestrator-Proxy diesen Endpoint anspricht, kein
  Drittanbieter-Controller.

**Edge-ID = Receiver-ID:** IS-05 kennt keine Kanten-IDs; da ein Receiver
immer höchstens eine aktive Connection hat, ist die Receiver-ID eine
natürliche, eindeutige Edge-ID ohne zusätzliches Datenmodell im
Orchestrator.

**Graph-Aufbau ist live, nicht gecacht:** `GET /api/v1/graph` fragt bei
jedem Request die Active-Endpoints aller Receiver frisch ab (ein
HTTP-Call pro Receiver), statt auf den 2s-Registry-Poller (A5)
aufzusetzen — passt zu "kompletter **Ist**-Zustand" aus der
Schrittbeschreibung. Bei wachsender Node-Zahl ggf. später cachen/
parallelisieren; für Mock-Maßstab unkritisch.

## 2026-07-07 — TS-im-Browser-Problem gelöst: `deno bundle` (Schritt B2)

**Problem:** `ARCHITECTURE.md` §4.5 fordert vanilla TS + nativen
`import()` ohne npm-Build, aber Browser können `.ts`-Dateien nicht
ausführen (keine Type-Erasure zur Laufzeit). Der Go-Orchestrator liefert
`ui/` unverändert als statische Dateien aus (`http.FileServer`) — ohne
Übersetzungsschritt bricht `<script type="module" src=".../*.ts">` im
Browser.

**Lösung:** `deno bundle` (in Deno 2.9 wiedereingeführt, als
„experimental" markiert) übersetzt `ui/graph/flow-canvas.ts` +
importierte Module zu einer einzigen ESM-JS-Datei
(`ui/dist/flow-canvas.js`, nicht versioniert, `.gitignore`s bestehende
`dist/`-Regel greift bereits). Kein Node/npm beteiligt — passt zur
„ein Werkzeug pro Aufgabe"-Linie (Deno wird sowieso schon für
Type-Checking/Tests genutzt). Neuer `make ui`-Target (Abhängigkeit von
`make build`) erzeugt das Bundle; `docs/descriptor-v0.schema.json`-Stil
„Quelle bleibt .ts, Artefakt ist Build-Output" wird damit für die UI
fortgesetzt. Da `deno bundle` als experimentell markiert ist: falls es
in einer künftigen Deno-Version entfernt/geändert wird, ist der
Fallback ein winziges eigenes Skript auf Basis von `deno_emit`/`esbuild`
via `npm:`-Import (immer noch kein installiertes Node/npm nötig, da
Deno npm-Pakete selbst auflöst).

**`deno.json` am Repo-Root ergänzt:** Deno nimmt standardmäßig eine
Nicht-Browser-Umgebung an (`lib` ohne `dom`). Ohne Konfiguration schlägt
`deno check` bei jeder Nutzung von `document`/`HTMLElement`/etc. fehl.
Config-Datei musste am **Repo-Root** liegen (nicht in `ui/`), weil Denos
automatische Config-Suche beim Aufruf `deno check ui/**/*.ts` vom
aktuellen Arbeitsverzeichnis (Repo-Root) aus nur nach oben sucht, nicht
in Unterverzeichnisse hinein.

## 2026-07-07 — Browser-Verifikation in dieser Sandbox nicht möglich (B2)

Chromium (`apt install chromium`) für eine automatisierte
Headless-Verifikation installiert, um über die reine `deno test`-Logik
hinaus auch das tatsächliche Rendering zu prüfen. Chromium stürzt in
dieser Ausführungsumgebung reproduzierbar ab (`Trace/breakpoint trap,
core dumped`), unabhängig von der Flag-Kombination (`--no-sandbox`,
`--disable-dev-shm-usage`, `--disable-setuid-sandbox`,
`--single-process`, `--no-zygote`, `--headless=old`,
`--disable-seccomp-filter-sandbox`) — vermutlich eine
Sandbox-/Seccomp-Einschränkung der Claude-Code-Ausführungsumgebung
selbst, kein Code-Problem.

**Stattdessen verifiziert:**
- `deno check`/`deno test` grün (reine Geometrie-Logik).
- Mit laufendem Orchestrator + 2 Mock-Nodes: `GET /api/v1/graph`
  liefert exakt die von `flow-canvas.ts` erwartete Form (`nodes[].id/
  label/inputs[]/outputs[]/health`, `edges[]`).
  `GET /` liefert das neue `index.html` mit `<omp-flow-canvas>`,
  `GET /dist/flow-canvas.js` liefert das Bundle mit korrektem
  `Content-Type: text/javascript`; `node --check` bestätigt gültige
  JS-Syntax des Bundles.
- **Nicht verifiziert:** tatsächliches Rendering, Pan/Zoom-Interaktion,
  Node-Drag, `localStorage`-Persistenz über Reload — das erfordert
  einen echten Browser. Bleibt als manuelle Checkliste für den Nutzer
  offen (siehe Antwort im Chat), passend zur in `UMSETZUNG.md` Phase B
  ohnehin vorgesehenen Nutzer-Browser-Verifikation.

## 2026-07-07 — B3: Format-Feld im Graph-API, bekannte Mock-Limitation

`graph.Port` bekommt ein `Format`-Feld (aus `registry.SenderView.Format`/
`ReceiverView.Format`, unverändert durchgereicht) — Grundlage für die
Port-Kompatibilitätsprüfung beim Drag & Drop. Reine Logik in
`ui/graph/compatibility.ts` (`portsCompatible`), per `deno test` geprüft
(5 Tests): gleiches Format kompatibel, unterschiedliches Format
inkompatibel, ein unbekanntes (leeres) Format auf einer Seite wird als
kompatibel behandelt statt vorsorglich zu blockieren.

**Bekannte Einschränkung der aktuellen Mock-Nodes:** Sender-Formate sind
immer `""` (unbekannt), weil der Mock-Node laut A5/A7-Entscheidung
bewusst keinen Flow registriert (Format eines Senders wird nur über den
referenzierten Flow aufgelöst). Dadurch ist mit den aktuellen
Mock-Nodes **kein** Format-Mismatch zwischen Sender und Receiver
provozierbar — das Ausgrauen inkompatibler Ports lässt sich im Browser
also aktuell nicht sichtbar demonstrieren, nur die zugrundeliegende
Logik (`portsCompatible`) ist getestet. Sollte in einem späteren Schritt
(z. B. wenn Mock-Nodes optional Flows registrieren, oder spätestens mit
der echten Playout-Node in Phase C) nachprüfbar werden.

Drag & Drop selbst (Verbindung ziehen, Kante serverseitig anlegen,
Kante auswählen + Entf löschen, Fehler-Toast bei abgelehntem Server-Call)
folgt demselben Muster wie Node-Drag/Pan aus B2 (Pointer-Events,
`stopPropagation` zur Unterscheidung von Port-/Node-/Hintergrund-Klicks).
Serverseitig verifiziert (curl): `POST .../graph/edges` → 200, Kante
erscheint in `GET .../graph`, `DELETE .../graph/edges/<id>` → 200,
Kante verschwindet wieder. Die eigentliche Browser-Interaktion
(Ziehen, Ausgrauen, Kante anklicken+löschen) erfordert wie in B2 eine
manuelle Nutzer-Verifikation (Chromium-Sandbox-Problem weiterhin
ungelöst).

## 2026-07-07 — Routing-Loop-Erkennung ergänzt (Nutzer-Feedback nach B3)

**Anlass:** Nutzer wies nach der B3-Verifikation darauf hin, dass eine
Erkennung für Routing-Feedback-Schleifen vorgesehen werden sollte (Node A
→ Node B → ... → zurück zu Node A). Direkt umgesetzt statt nur als
Backlog-Punkt notiert, weil es sich sauber und generisch in
`graph.Service.Connect` einfügt, ohne Node-Typ-Wissen zu brauchen.

**Ansatz:** Konservative Annahme — jeder Node mit Ein- **und**
Ausgängen wird so behandelt, als würden seine Ausgänge von seinen
Eingängen abhängen (nicht node-typ-spezifisch geprüft, da der
Orchestrator laut Architektur nichts über Node-Interna wissen soll).
Vor jedem `Connect()` wird aus den **bestehenden** Kanten ein
Node-zu-Node-Signalfluss-Graph gebaut (`buildNodeSignalGraph`); die
neue Verbindung wird abgelehnt (`ErrRoutingLoop`, HTTP 409), wenn die
Ziel-Node im bestehenden Graphen bereits die Quell-Node erreichen kann
(dann würde die neue Kante die Schleife schließen) — inklusive
Selbst-Loop (Node verbindet sich mit sich selbst).

**Getestet:** Selbst-Loop, Zwei-Knoten-Schleife (A→B, dann B→A
versucht), Drei-Knoten-Schleife (A→B→C, dann C→A versucht) sowie ein
erlaubter loop-freier Fall (A→B, dann B→C). Zusätzlich live gegen zwei
echte Mock-Nodes verifiziert (curl): beide Schleifen-Versuche liefern
HTTP 409, nur die gültige Verbindung bleibt bestehen.

**Bekannte Grenze:** Die Prüfung ist pro `Connect()`-Aufruf live (fragt
`buildEdges` erneut ab, ein IS-05-Call pro Receiver) — bei sehr vielen
Nodes/Receivern skaliert das linear mit der Node-Zahl. Für Mock-Maßstab
unkritisch, bei Bedarf später cachen (gleiche Überlegung wie beim
Graph-Aufbau selbst, siehe B1-Eintrag oben).

## 2026-07-07 — B4: Offline schneller als Registry-Expiry; Tally-Subject
neu definiert

**Problem:** Die Verifikation verlangt „Mock-Node killen → Kachel wird
binnen ~10s als offline markiert" — die IS-04-Registry entfernt eine
tote Node aber erst nach vollen 12s (`registration_expiry_interval`,
deploy/nmos/registry.json) komplett aus dem Query-API-Ergebnis. Eine
entfernte Node hätte gar keine Kachel mehr, auf der man „offline"
anzeigen könnte.

**Lösung:** Neuer `internal/health.Tracker` im Orchestrator merkt sich,
wann zuletzt ein NATS-Health-Event (`omp.health.<id>`, A7) für eine Node
eingetroffen ist (`Touch`, ausgelöst über einen neuen `onHealth`-Callback
in `eventbus.Connect`). Der Registry-Poller (A5/A6) markiert eine Node
als offline (`Online = false`), sobald ihr letztes Health-Event länger
als `HealthStaleAfter` (10s, `main.go`) zurückliegt — **bevor** die
Registry sie nach 12s ganz entfernt. Da `Online` bereits Teil des
diffbaren `NodeView` ist, erzeugt das automatisch ein reguläres
`node.updated`-SSE-Event über die bestehende A6-Diff-Logik — keine neue
Event-Art nötig. Live verifiziert: Mock-Node getötet →
`node.updated` mit `online:false` nach ~10s, `node.removed` nach ~12s;
Neustart → wieder `online:true`.

**Tally-Subject `omp.tally.<id>` neu definiert:** Weder
`ARCHITECTURE.md` noch `UMSETZUNG.md` legen einen NATS-Subject für
Tally-Events fest (A7 nennt nur `omp.health.<id>` für Health). Analog
dazu `omp.tally.<id>` mit Body `{"on": bool}` gewählt — passt zum
bestehenden Namensschema, wird vom generischen `omp.>`-Abo (A6) bereits
mitgeliefert, keine Orchestrator-Änderung nötig, nur Frontend-seitiges
Auswerten des SSE-Event-Typs. Live verifiziert:
`nats pub omp.tally.<id> '{"on":true}'` erscheint im SSE-Stream.

**Frontend:** `flow-canvas.ts` abonniert `/api/v1/events` per
`EventSource`; `node.added/updated/removed` lösen ein Neuladen des
Graphen aus (einfacher und robuster als Client-seitiges Patchen
einzelner Felder), `omp.tally.<id>` färbt die betroffene Kachel rot
(Vorrang vor der Health-Randfarbe). Reconnect mit exponentiellem Backoff
(1s → 15s, zurückgesetzt bei erfolgreichem `onopen`) statt
`EventSource`s festem Standard-Retry-Intervall.

**Browser-Verifikation deckte ein Timing-Problem auf:**
`registration_expiry_interval` stand bei 12s (A3) — nur 2s nach dem
10s-Health-Staleness-Schwellwert. Die Kachel wurde zwar korrekt als
offline markiert, verschwand aber praktisch gleichzeitig wieder
(`node.removed` bei 12s) — im Browser real getestet: nicht sichtbar
als „wurde grau", sondern nur als „ist verschwunden". Behoben durch
`deploy/nmos/registry.json`: `registration_expiry_interval` von 12 auf
**60s** erhöht — Health-Staleness (10s) und Registry-Expiry (60s) sind
jetzt weit genug auseinander, damit die Offline-Kachel tatsächlich eine
Weile sichtbar bleibt, bevor sie ganz verschwindet. Nebeneffekt (kein
Bug): Da jeder Mock-Node-Neustart eine neue zufällige ID bekommt,
erscheinen nach Kill+Neustart kurzzeitig zwei Kacheln mit demselben
Label (eine grau/tot, eine grün/neu), bis die tote Registrierung nach
60s aus der Registry fällt — im Browser bestätigt und als erwartetes
Verhalten erkannt.

## 2026-07-07 — B5: Gruppen-Datenmodell, Layout-API, Port-Promotion ohne
Edge-IDs im Orchestrator

**Datenmodell (`ui/graph/groups.ts`):** Gruppenbaum als flache Map
(`Record<string, GroupNode>`), jede Gruppe kennt ihre direkten Kinder
(`nodeIds`/`groupIds`) und ihren `parentId` (null = Top-Level). Reine
Funktionen: `topLevelItems` (welche Nodes/Gruppen sind an einer
gegebenen Szene sichtbar — Top-Level-Nodes werden implizit aus „nicht in
irgendeiner Gruppe" abgeleitet, nicht extra gespeichert),
`flattenMembers` (rekursive Mitgliederliste für Port-Promotion),
`createGroup`/`dissolveGroup`, `breadcrumbPath`, `promotedPorts`. Port-
Promotion-Regel: ein Port ist sichtbar (promotet), außer seine einzige
Verbindung verläuft komplett innerhalb der Gruppe — unverbundene Ports
gelten als nach außen offen. 25 `deno test`-Fälle, inklusive
verschachtelter Gruppen (Edge zwischen zwei Untergruppen ist aus Sicht
der gemeinsamen Elterngruppe intern, aus Sicht der einzelnen Untergruppe
aber extern).

**Kein `effectiveTileId`/Baum-Traversal beim Rendern nötig:** Ursprünglich
geplant, um zu bestimmen, auf welcher sichtbaren Kachel ein Port bei
verschachtelten Gruppen landet. Stattdessen baut `flow-canvas.ts` bei
jedem Render eine `portLocation`-Map ausschließlich aus den an der
aktuellen Szene tatsächlich sichtbaren Kacheln (echte Nodes + `promotedPorts`
jeder sichtbaren Gruppe) — ein Port, der in keiner sichtbaren Kachel
auftaucht, ist automatisch „tiefer verschachtelt, hier nicht relevant",
eine Kante mit beiden Enden auf derselben Kachel ist automatisch
„intern auf dieser Ebene". Einfacher als Baum-Traversal und ergibt sich
direkt aus der ohnehin nötigen Render-Vorbereitung.

**Orchestrator (`internal/layouts`):** Datei-Backend für benannte
JSON-Blobs (`GET|PUT /api/v1/layouts/<name>`), Struktur des Blobs ist dem
Orchestrator unbekannt (reines Opak-Speichern, `ui/graph/flow-canvas.ts`
schreibt `{positions, groups}`). Name-Validierung
(`^[a-zA-Z0-9_-]+$`) schützt vor Path-Traversal — getestet mit
`../escape`, `a/b`, `a\b`, leerem String, Leerzeichen. Neuer
`OMP_DATA_DIR` (Default `../data`, analog zu `OMP_UI_DIR`).
`localStorage`-Positionspersistenz aus B2 vollständig durch diesen
Server-Endpunkt ersetzt (fixer Layout-Name `"default"` — mehrere
benannte Layouts/Umschalten ist Sache späterer Schritte, z. B. B7
Snapshots).

**Bug beim Browser-Test gefunden und behoben:** Doppelklick zum Öffnen
einer Gruppe funktionierte zunächst nicht. Ursache: `#onTilePointerDown`
und der Hintergrund-`#onPointerDown` riefen bei **jedem** Klick
unbedingt `#render()` auf (auch ohne Auswahländerung), was
`viewportGroup.replaceChildren()` ausführt und damit den angeklickten
DOM-Knoten durch einen neuen ersetzt — der Browser erkennt einen
Doppelklick aber nur, wenn beide Klicks denselben DOM-Knoten treffen.
Zusätzlich löste jede noch so kleine Mausbewegung während eines Klicks
(„Jitter") im Node-Drag-Zweig von `#onPointerMove` ebenfalls einen
Re-Render aus. Behoben durch: (1) `#render()` nur noch aufrufen, wenn
sich die Auswahl tatsächlich ändert, (2) eine 3px-Bewegungsschwelle
(`DRAG_THRESHOLD_PX`) im Node-Drag-Zweig, unterhalb derer keine
Positionsänderung/kein Re-Render ausgelöst wird. Im Browser verifiziert:
Mehrfachauswahl, Gruppieren (3 Nodes → 1 Kachel mit 3 promoteten
Inputs/Outputs, da unverbunden), Doppelklick zum Öffnen, Breadcrumb
zurück zu Root, Gruppe auflösen, Reload behält Gruppen+Positionen.

## 2026-07-07 — B6: Parameter-Panel + Node-UI-Bundles

**Klick-vs-Drag-Unterscheidung wiederverwendet:** Die B5-Bewegungsschwelle
(`DRAG_THRESHOLD_PX`) trägt jetzt zusätzlich das `moved`-Flag auf
`DragState` (sowohl „node" als auch „pan"). Ein Node-Klick ohne
nennenswerte Bewegung öffnet das Parameter-Panel, ein Klick auf leere
Fläche schließt es — ohne die bereits eingebaute Klick-Toleranz doppelt
zu verwalten.

**Descriptor→Control-Mapping** (`ui/graph/controls.ts`): reine Funktion
`controlKindFor` (number→Slider, boolean→Toggle, enum→Select,
string→Textfeld, `readonly` überschreibt den Typ, unbekannte Typen
fallen auf schreibgeschützte Anzeige zurück statt ein falsches
Steuerelement zu bauen), plus `numberRange`/`enumValues` zur
Wertebereich-Extraktion. 12 `deno test`-Fälle.

**Optimistisches UI mit Rollback:** Ein Steuerelement übernimmt den
Client-Wert sofort (z. B. Slider-Drag), der PATCH läuft im Hintergrund.
Bei Fehlschlag wird **nicht** der zuletzt versuchte Wert zurückgesetzt,
sondern der tatsächliche Server-Wert per erneutem `GET .../params/<name>`
abgefragt und die Zeile damit neu aufgebaut — „Server-Wert ist die
Wahrheit" (UMSETZUNG.md B6) gilt auch für den Rollback-Fall, nicht nur
für den Erfolgsfall.

**Node-UI-Bundle-Proxy:** `GET /api/v1/nodes/<id>/ui/manifest.json` und
`/ui/bundle.js` sind zwei weitere Registrierungen des bereits aus A8
bestehenden generischen `handleNodeProxy`-Helpers — keine neue
Proxy-Logik nötig. Frontend probiert bei jedem Panel-Öffnen zuerst das
Manifest (404 → generisches Panel); die in `ARCHITECTURE.md` §4.5
erwähnte Alternative (Manifest-Präsenz als Extension-Tag direkt am
IS-04-Node-Resource ablesen, um das Probing zu vermeiden) ist bewusst
zurückgestellt — bei Bedarf später als Optimierung nachrüstbar, ohne
den Proxy-Mechanismus zu ändern.

**Manifest-Schema selbst festgelegt:** Weder `ARCHITECTURE.md` noch
`UMSETZUNG.md` spezifizieren den exakten Inhalt von `manifest.json`.
Gewählt: `{name, version, tag}` — `tag` ist der Custom-Element-Name, den
die Shell nach dem `import()` des Bundles instanziiert
(`document.createElement(manifest.tag)`). Das Bundle selbst schützt
seine `customElements.define`-Aufrufe mit einer `get()`-Prüfung, damit
mehrere Node-Instanzen mit demselben Tag-Namen (unterschiedliche
Bundle-URLs, gleicher Tag) nicht kollidieren.

**Mock-Node-Beispiel-Bundle:** `--ui-bundle`-Flag (Default aus) hält die
meisten Mock-Instanzen beim generischen Panel, damit dessen Slider/
Toggle/Select-Pfad weiterhin browser-testbar bleibt; eine geflaggte
Instanz demonstriert den Bundle-Pfad (eigenes Custom Element mit Shadow
DOM, `+1 dB`/`-1 dB`-Buttons auf `gain`). Dateien eingebettet via
`go:embed` (`nodes/mock/internal/uibundle`).

Verifiziert: Slider-Änderung an Mock A landet nachweislich am Server
(`curl` bestätigt `-6`); Mock mit `--ui-bundle` zeigt sein eigenes
Element statt des generischen Panels; Klick auf leere Fläche schließt
das Panel.

## 2026-07-08 — B7: Snapshots/Szenen + zwei Frontend-Refresh-Bugs

**Backend** (`orchestrator/internal/snapshots`): Erfassung/Wiederherstellung
laufen ausschließlich über bestehende Standard-Endpunkte (Graph-API,
generischer Parameter-Proxy aus A8) — kein Sonderwissen über Node-Typen.
`Service.Create` sammelt Kanten (`graph.Service.Graph`) und alle
schreibbaren Parameterwerte aller erreichbaren Nodes (Descriptor →
Namen filtern → je Name `GET`); `Service.Apply` stellt in der Reihenfolge
Parameter-zuerst-dann-Kanten wieder her und sammelt Fehler statt beim
ersten abzubrechen (`ApplyResult.Errors`, nie `null`). Datei-Store wie
schon bei `layouts` (D1 macht später PostgreSQL daraus).

**Bug-Report nach Browser-Test:** neuer Snapshot-Chip erschien erst nach
vollständigem Seiten-Reload; nach Snapshot-Apply zeigte das
Parameter-Panel erst nach erneutem Anklicken des Nodes die
wiederhergestellten Werte.

**Erste Hypothese (falsch, aber nicht schädlich):** Browser-HTTP-Caching
der GET-Antworten. `noStoreForAPI`-Middleware (`Cache-Control: no-store`
für alle `/api/v1/*`) ergänzt und verifiziert (per `curl`), Nutzer
bestätigte aber unverändertes Verhalten — Hypothese damit widerlegt.
Middleware bleibt trotzdem drin (schadet nicht, ist für generische
GET-Endpunkte ohnehin korrektes Verhalten), war aber nicht die Ursache.

**Tatsächliche Ursachen (beide reine Frontend-Logik-Bugs,
`ui/graph/flow-canvas.ts`):**
1. `#applySnapshot()` rief nach dem Apply nur `#fetchAndRender()` auf
   (aktualisiert Graph/Kacheln), aber nie das ggf. offene
   Parameter-Panel — Werte blieben sichtbar veraltet, bis
   `#openParameterPanel()` durch erneutes Anklicken neu lief. Fix: nach
   `#fetchAndRender()` zusätzlich `#openParameterPanel(this.#panelNodeId)`
   erneut aufrufen, falls ein Panel offen ist.
2. Die Chip-Liste der Snapshot-Leiste hatte kein `min-width:0`/
   `flex-shrink:0`, wodurch ein neu angehängter Chip im horizontal
   scrollenden Container außerhalb des sichtbaren Bereichs landen konnte,
   ohne dass der Nutzer einen Hinweis auf einen neuen Eintrag hatte. Fix:
   Flex-Sizing korrigiert, Liste scrollt nach jedem Render automatisch
   zum neuesten Chip.

Lehre: Ein rein Backend-seitiger Fix-Versuch (Cache-Control) an einem
Frontend-Logik-Bug retestet zwangsläufig „unverändert" — das ist selbst
schon ein Signal gegen die Caching-Hypothese, nicht nur ein neutrales
Nichtergebnis.

Verifiziert: `make check` grün (Go + Deno, alle Module); Backend-Flow
End-to-End per `curl` bestätigt (Create → Get → List → Apply); Browser-
Retest beim Nutzer ausstehend/bestätigt vor diesem Commit.
## 2026-07-08 — Workflow-Bereitstellung & -Verteilung: geprüft, geparkt
(nach B7, vor Phase C)

**Kontext:** Nutzer-Vergleich mit Vizrt AMPP OS: dort wählt man nach Login
App-Kategorien (Core Apps, Inputs, Play & Record), Klick startet die
Anwendung als Workload dynamisch auf einer verfügbaren Ressource
(Edge-Server oder Cloud-Instanz); ein „Workflow Designer" verdrahtet
Container über Vorlagen statt Handinstallation; ganze Workflows (z. B. ein
Regieplatz) lassen sich manuell oder zeitgesteuert starten/stoppen, um
Ressourcen freizugeben. Zweite, separat gestellte Frage im selben Kontext
(zusammengesetzte Operator-UI für einen Mixer aus mehreren Microservices,
vergleichbar Vizrt VECTAR) wurde ebenfalls von Fable geprüft, aber
**nicht** als neuer Architektur-Abschnitt übernommen — nur als
Diskussionsstand im Gespräch festgehalten (additives
„Repräsentant/Coordinator"-Muster auf der bestehenden Flow-Editor-
Gruppierung, §4.5a; bei Bedarf später erneut aufgreifen).

**Vorgehen:** Beide Anforderungen von Claude Fable gegen `ARCHITECTURE.md`
prüfen lassen (unabhängige Zweitmeinung vor einer Architekturänderung,
wie schon bei §6.1). Ergebnis für die Deployment-Frage: echte Lücke,
klar unterscheidbar von §6.1 (dort Migration bereits laufender
Instanzen, hier Erst-Provisionierung + Bundle-weises Start/Stop zur
Ressourcen-Freigabe). Empfehlung: neues Objekt „Workflow" (Rollen +
Verbindungs-Template + Platzierungs-Hinweise), getrennt von Node
(laufender Prozess) und Snapshot (B7, Zustand bereits laufender Nodes).
Zwei-Stufen-Antwort statt Neubau eines eigenen Schedulers: Cloud-Stufe
nutzt k3s/Helm-Äquivalent + schmale NMOS-Glue (Auto-Wiring bei
`node.added`); Bare-Metal-Stufe zunächst nur Start/Stop vorab platzierter
Quadlet-Units je Bundle (deckt den AMPP-Kernwunsch weitgehend ab), echtes
Placement erst mit demselben Host-Telemetrie-Agenten, der ohnehin für
§6.1 geplant ist (ein Agent, zwei Verben: Metriken melden + Image
starten, statt zwei Subsysteme).

**Entscheidung:** Anforderung akzeptiert, Timing geparkt.
- `ARCHITECTURE.md` neuer Abschnitt §6.2 „Workflow-Bereitstellung &
  -Verteilung (geplant, ab Phase D)" dokumentiert Konzept, die
  Zwei-Stufen-Antwort, Standards-Abdeckung und Testbarkeits-Grenzen.
- **Kein** neuer Punkt in §5 (Node-Contract) jetzt — anders als bei §6.1
  ist der Katalog-Descriptor rein additiv/optional und kann nach dem
  SDK-v1-Freeze ergänzt werden, ohne Community-Nodes zu brechen.
- `ARCHITECTURE.md` §7-Phasenplan-Tabelle: P2-Zeile um „Workflow-
  Bereitstellung & -Verteilung (§6.2)" ergänzt (war zuvor nicht genannt,
  nur implizit über §6.1 vermutbar).
- `UMSETZUNG.md` Phase D um Punkt D7 (geplant, nicht detailliert)
  ergänzt, bewusst zusammen mit D6 sequenziert (gemeinsamer
  Telemetrie-/Start-Agent), nach D4 (2110/MXL).
- **Keine** A–C-Schritte ändern dadurch ihren Scope; Phase C
  (Playout-Node) startet wie geplant als Nächstes.

## 2026-07-09 — C1: Rust-Toolchain, `omp-node-sdk`-Abhängigkeiten,
Workspace-Layout

**Rust-Toolchain:** Kein Debian-Paket verwendet (bookworms `rustc` wäre
veraltet, gleiche Begründung wie bei Go/Deno in A1). Offizieller
`rustup`-Installer (`https://sh.rustup.rs`), Stable-Channel
(`rustc 1.96.1`). Auf dieser Maschine war bereits ein
`~/.rustup`-Settings-File vorhanden (Alt-Installation, vermutlich aus
PIPELINE-CONTROLLER-Arbeit) — `rustup-init` hat den bestehenden Stable-
Channel übernommen statt neu zu wählen, `~/.bashrc` sourcte `~/.cargo/env`
bereits. GStreamer-Dev-Header (`libgstreamer1.0-dev`,
`libgstreamer-plugins-base1.0-dev`, 1.22.0) waren ebenfalls schon
installiert — wird erst ab C2 gebraucht, hier nur geprüft.

**Workspace-Layout:** `nodes/Cargo.toml` als reiner Workspace-Root
(`[workspace] members = ["omp-node-sdk"]`), das SDK-Crate selbst über
`cargo init --lib` erzeugt. `nodes/mock` (Go) bleibt unverändert
außerhalb des Rust-Workspace — zwei Sprachen nebeneinander im selben
`nodes/`-Verzeichnis ist bewusst so vorgesehen (`nodes/README.md`).
`Cargo.lock` wird committet (wie `go.sum`): reproduzierbare Builds für
Beispiel-Binaries/Tests, kein Grund für library-typisches
Nicht-Committen, solange es keine externen Downstream-Konsumenten gibt.

**HTTP-Server (Descriptor-API):** `tiny_http` statt eines
Async-Frameworks (axum/hyper direkt) — vier simple Routen, kein
Streaming, kein Concurrency-kritischer Pfad; ein blockierender Server in
einem eigenen Thread reicht, zusätzliche Framework-Tiefe wäre Overhead
ohne Gegenwert. `tiny_http` unterstützt `PATCH` nativ (`Method::Patch`),
kein Sonderfall nötig.

**HTTP-Client (IS-04-Registrierung/Heartbeat):** `ureq` (mit
`json`-Feature für `send_json`) statt `reqwest` — synchron, deutlich
kleinerer Abhängigkeitsbaum, passt zum "kein Async nötig, wo kein Async
gebraucht wird"-Prinzip: die Registrierung/Heartbeat-Aufrufe sind
seltene (alle 5s), kurze Anfragen, kein Streaming/Concurrency-Bedarf.
`ureq::Error::StatusCode` wird von Haus aus für alle 4xx/5xx geliefert
(Erfolg = 2xx/3xx als `Ok`) — deckt die Go-Unterscheidung "200/201 =
Erfolg" ohne Zusatzcode ab; `404` bei Heartbeat wird explizit auf
`HeartbeatError::NotRegistered` gemappt (Pendant zu `is04.ErrNotRegistered`
im Go-Mock-Node).

**NATS-Client:** `async-nats` — offizieller, aktiv gepflegter Rust-Client,
gleiche Ausnahme von der Minimal-Dependency-Regel wie `nats.go` im Go-Teil
(`docs/decisions.md`, Schritt A6): ein selbst geschriebener NATS-Client
wäre reine Protokoll-Neuimplementierung ohne Gegenwert. Bringt zwangsläufig
`tokio` als Async-Runtime mit (kein sync-natives, gepflegtes NATS-Crate
verfügbar). Um die restliche SDK-Oberfläche trotzdem synchron/einfach zu
halten (Node-Autoren sollen `ParamStore` implementieren können, ohne
Async-Rust zu lernen), läuft nur der NATS-/Heartbeat-Lifecycle
(`node::run`) in einer minimalen `tokio`-Runtime
(`features = ["rt", "time", "macros"]`, bewusst kein `rt-multi-thread`,
kein `net`/`io-util` — nur was der eigene Code direkt nutzt;
Cargo-Feature-Unification zieht, was `async-nats` selbst zusätzlich
braucht, ohnehin automatisch); die blockierenden `ureq`-Aufrufe (Register/
Heartbeat) laufen darin über `tokio::task::spawn_blocking`, damit sie die
Async-Runtime nicht stallen.

**UUID-Generierung:** Eigene, winzige UUIDv4-Implementierung
(`src/idgen.rs`) statt der `uuid`-Crate — 1:1 dieselbe Begründung wie
`nodes/mock/internal/idgen` (Go): Standardverfahren nach RFC 4122 §4.4 ist
~15 Zeilen, keine Library nötig. Einziger echter Unterschied zu Go: Rusts
Standardbibliothek hat (anders als `crypto/rand`) **keine** eingebaute
Zufallsquelle — `getrandom` (Direktabhängigkeit, kein Sammelsurium wie
`rand`) ist der schmalste Ersatz dafür, ein reiner OS-Syscall-Wrapper.

**Logging:** Kein `log`/`env_logger`-Crate — `eprintln!` für Warnungen,
reicht für den aktuellen Umfang (kein strukturiertes Logging-Bedürfnis wie
beim Go-Orchestrator mit `slog`, da hier nur wenige Zeilen Diagnose-Ausgabe
anfallen). Bei Bedarf später leicht nachrüstbar, ohne die SDK-Schnittstellen
zu ändern.

**`cargo deny`/`cargo audit`:** Kein Debian-Paket, per `cargo install
cargo-deny cargo-audit --locked` installiert (Compile-Zeit einmalig,
reines Dev-Tool, keine Projektabhängigkeit). Ab dem ersten Commit in CI
(A9-Workflow wird um Rust-Job erweitert).

**Verifiziert:** `examples/hello_node.rs` (Parameter `label`/`gain`,
Methode `reset` — bewusst identisch zum Go-Mock-Node) registriert sich
bei der laufenden Registry, erscheint in `GET /api/v1/nodes` des
Orchestrators; Descriptor/Param-Get/Patch/Method-Invoke über den
generischen Proxy (A8) funktionieren identisch zum Go-Node; NATS-
Health-Event läuft nachweislich bis in den SSE-Stream
(`omp.health.<id>` sichtbar auf `/api/v1/events`). `cargo test` grün.

**Blocker (klein, geparkt): Projektlizenz noch nicht entschieden.**
`cargo deny check` verlangt ein `license`-Feld für jedes Crate,
einschließlich der eigenen Workspace-Crates — bislang existiert weder eine
`LICENSE`-Datei noch eine dokumentierte Lizenzentscheidung für
OpenMediaPlatform. Das betrifft nicht nur `omp-node-sdk`, sondern das
gesamte "Call for Nodes"-Community-Modell (§7.3 Kritischer
Erfolgsfaktor: Community-Geschwindigkeit) — Drittanbieter brauchen eine
klare Lizenzbasis, bevor sie eigene Nodes beitragen.
- **Optionen:** (a) Apache-2.0 (Muster in fast der ganzen bisherigen
  Rust-Abhängigkeitskette, patentfreundlich, in Broadcast-/Rundfunk-Umfeld
  üblich); (b) MIT (einfachste, permissivste Wahl, aber kein
  Patentschutz); (c) MIT OR Apache-2.0 Dual-Lizenz (Rust-Ökosystem-Standard,
  z. B. von `serde`/`tokio` selbst verwendet — passt zur bereits gewählten
  Sprache/Tech-Stack-Kultur).
- **Empfehlung:** (c), da es sich nahtlos in die bereits genutzte
  Rust-Crate-Landschaft einfügt und Beitragenden keine Wahl aufzwingt.
- **Vorläufige Umgehung (nicht die Entscheidung selbst):** `publish =
  false` in `nodes/omp-node-sdk/Cargo.toml` + `[licenses.private] ignore
  = true` in `nodes/deny.toml` — verhindert ein versehentliches
  crates.io-Publish und nimmt das Crate bis zur Entscheidung von der
  Lizenzprüfung aus, ändert aber nichts an der eigentlichen Frage. Nutzer
  entscheidet, dann `LICENSE`-Datei(en) + `license`-Feld ergänzen und
  `ignore` zurück auf `false` setzen.

## 2026-07-09 — C2: GStreamer-Grundpipeline, SDK-Erweiterung
`start()`/`NodeHandle`, async-nats-Flush-Bug

**GStreamer-Pipeline** (`nodes/playout/src/pipeline.rs`): zwei einfache
Ketten, `videotestsrc ! capsfilter(framerate=<konfigurierbar>) ! fakesink`
und `audiotestsrc ! fakesink`, beide mit `sync=true` — ohne `sync=true`
spielt `fakesink` so schnell wie die CPU erlaubt statt im
Pipeline-Takt, dann wäre eine "gemessene Bildrate" bedeutungslos.
Bildratenmessung über eine Pad-Probe (`PadProbeType::BUFFER`) am
Video-Fakesink, die einen `AtomicU64`-Zähler erhöht; ein 1s-Poll-Takt
liest ihn aus (`swap(0, ...)`) und ergibt direkt Buffer/s = FPS.
Video-/Audio-Element-Namen und Framerate sind über
`OMP_PLAYOUT_VIDEO_ELEMENT`/`OMP_PLAYOUT_AUDIO_ELEMENT`/
`OMP_PLAYOUT_FRAMERATE` konfigurierbar — absichtlich, damit die in
`UMSETZUNG.md` C2 geforderte Verifikation ("ungültiges Element per Env")
ohne Code-Änderung reproduzierbar ist.

**Bus-Fehler laufen auf einem eigenen `std::thread`**, nicht in der
Tokio-Runtime: `Bus::timed_pop_filtered` blockiert für die Dauer des
Timeouts, das darf die async Registrierungs-/Heartbeat-Schleife des SDK
nicht stören. Kommunikation zurück zum async Haupt-Task über einen
`tokio::sync::mpsc`-Kanal (`pipeline::Event::{Fps, Error}`).

**SDK-Erweiterung, keine Playout-spezifische Lösung:** C2 brauchte eine
Möglichkeit, aus dem Node-eigenen Code heraus (nicht nur aus dem SDK
selbst) zusätzliche Events über dieselbe NATS-Verbindung zu
veröffentlichen (Alarme, `omp.alert.<id>`). Das ging mit der bisherigen
`omp_node_sdk::run()`-Signatur nicht (blockierte für immer, gab dem
Aufrufer nie die Kontrolle zurück). Deshalb `node.rs` umgebaut:
- **`start()`** (neu) baut/registriert alles wie bisher, startet
  Heartbeat/Health-Publish aber als Hintergrund-`tokio::spawn`-Task und
  gibt sofort ein **`NodeHandle`** zurück (`node_id` + `publish_alert()`).
- **`run()`** bleibt für einfache Nodes ohne eigene Nutzlast
  (`hello_node`) als dünner Wrapper: `start()` + `pending().await`.
- `health.rs` bekommt `Alert{node_id, message}` +
  `Publisher::publish_alert()` (Subject `omp.alert.<id>`) — der
  Orchestrator braucht dafür **keine** Änderung, `internal/eventbus`
  abonniert bereits generisch `omp.>` und leitet jedes Subject 1:1 an den
  SSE-Hub weiter (verifiziert: Alarm erscheint unverändert als
  `omp.alert.<id>`-Event auf `/api/v1/events`).

**Bug gefunden+gefixt: async-nats puffert Publishes, `flush()` fehlte.**
Erster Alarm-Test: Log zeigte "pipeline error"/Alarm-Code lief durch,
NATS-Subscriber (`nats sub omp.alert.>`) empfing aber nichts — reiner
Timing-Bug, kein Logikfehler. `async_nats::Client::publish()` schreibt
nur in einen internen Puffer, ein Hintergrund-Task sendet ihn erst
später über den Socket; da der Alarm oft das Letzte ist, was ein Node
vor dem Beenden tut (hier: `timeout`-Prozessende direkt nach dem
Error-Pfad), kam der Hintergrund-Task nie mehr zum Zug. Health-Publish
(periodisch, jeder Tick holt Rückstand von selbst auf) war davon nicht
sichtbar betroffen, aber prinzipiell derselben Race unterworfen. Fix:
`Publisher::publish_alert()` ruft nach `publish()` zusätzlich
`client.flush().await` — danach im NATS-Subscriber wie im
SSE-Endpunkt nachweislich sichtbar.

**`fps`-Parameter statt reiner Log-Zeile:** `PlayoutStore` (ParamStore-
Trait-Implementierung) exponiert `fps` als readonly-Zahl-Parameter —
zusätzlich zum geforderten Log-Output, weil der Trait ohnehin
implementiert werden muss und ein sichtbarer Wert im generischen
Parameter-Panel (B6) die Verifikation im Browser genauso unterstützt.
`reset`-Methode ist ein No-Op-Platzhalter (kein Playlist-Zustand vor C4),
nur damit der Node schon jetzt eine Methode im Panel zeigt.

**Verifiziert:** `cargo run -p playout` registriert sich, Health "ok" auf
`/api/v1/events`; `params/fps` liefert über den generischen Proxy Werte
≈24–26 (Ziel "≈ 25/50" laut `UMSETZUNG.md`); `OMP_PLAYOUT_VIDEO_ELEMENT`
auf einen erfundenen Namen gesetzt → Pipeline-Aufbau schlägt sofort fehl,
Alarm erscheint sowohl über direktes NATS-Subscribe als auch über
`/api/v1/events`, der Node-Prozess bleibt dabei voll funktionsfähig
(registriert, Descriptor/Heartbeat laufen weiter) — "Prozess bleibt
kontrollierbar" erfüllt. `cargo test`, `cargo clippy -D warnings`,
`cargo deny check`, `cargo audit` grün.

## 2026-07-09 — C3: Netz-Ausgang (RTP), Sender-seitiges IS-05,
Orchestrator-Erweiterung

**IS-05-Feldnamen aus der Spezifikation nachgeschlagen** (Arbeitsregel
§0.6, AMWA-TV/is-05 Branch v1.1.x): `sender-stage-schema.json`
(`receiver_id`, `master_enable`, `activation`, `transport_params` — kein
`transport_file` im staged/active-Body, anders als zunächst vermutet),
`sender_transport_params_rtp.json` (`destination_ip`, `destination_port`,
`rtp_enabled`), `ConnectionAPI.raml` (`/single/senders/{id}/transportfile`
liefert die SDP direkt oder per Redirect — hier: direkt).

**Größte offene Frage vor der Umsetzung:** Die bestehende
Flow-Editor-Verkabelung (B1/B3) PATCHt beim Verbinden ausschließlich den
**Receiver** (`sender_id` + `master_enable`) — der Sender selbst hat bisher
gar keine eigene Connection-API (`nodes/mock/internal/connection` ist
bewusst nur Receiver-seitig, siehe A7/B1-Eintrag oben). Damit ein
IS-05-PATCH über den Flow-Editor den echten RTP-Ausgang des Playout-Node
tatsächlich scharf schaltet, musste der Orchestrator selbst erweitert
werden. Entschieden: `graph.Service.Connect`/`Disconnect` schalten
**zusätzlich** (best-effort, siehe unten) den Sender-eigenen
`master_enable` — die Ziel-Adresse bleibt dabei node-eigene Konfiguration
(Env-Var-Default + direktes IS-05-PATCH), der Orchestrator handelt sie
nicht dynamisch aus. Begründung: in einem reinen Multicast-2110-Szenario
(der letztlich angestrebte Normalfall, `ARCHITECTURE.md` §6) kennt der
Sender sein Ziel ohnehin fest/über seine eigene SDP — eine volle
Receiver-getriebene Unicast-Zieladress-Aushandlung wäre Vorgriff auf einen
späteren Schritt und hier nicht nötig, um "Start/Stop übers Flow-Editor"
ehrlich zu erfüllen.

**Orchestrator-Änderungen** (`internal/is05/client.go`,
`internal/graph/graph.go`): neue `PatchSenderStaged(ctx, baseURL,
senderID, masterEnable)`. `Connect` PATCHt wie bisher zuerst den Receiver,
danach zusätzlich (falls der Sender im aktuellen Registry-Snapshot
auflösbar ist und eine `APIBaseURL` hat) den Sender auf
`master_enable=true` — ein Fehler dabei ist **nicht fatal** (nur
geloggt), da die meisten bestehenden Nodes (Mock-Node) gar keine
Sender-Connection-API haben und das nicht brechen darf. `Disconnect`
liest vorher per `GetActive` die zuletzt verbundene Sender-ID aus und
schaltet sie (ebenso best-effort) auf `master_enable=false`. Neue Tests:
`TestServiceConnectAlsoEnablesSender`,
`TestServiceConnectSucceedsEvenIfSenderHasNoConnectionAPI`,
`TestServiceDisconnectAlsoDisablesPreviousSender`.

**omp-mediaio (neues Crate):** Transport-Abstraktion
(`ARCHITECTURE.md` §10 Punkt 1, dort als "§10.1" referenziert) — ein
`Output`-Trait (`set_active`, `set_destination`, `is_active`,
`destination`) und heute genau eine Implementierung,
`rtp::RtpVideoOutput`. Kein Node spricht GStreamer-RTP-Elemente direkt;
eine spätere 2110/MXL-Implementierung ersetzt nur `rtp.rs`, ohne
Playout-Code zu ändern.

**Pipeline-Erweiterung** (`nodes/playout/src/pipeline.rs`): ein `tee`
nach dem Framerate-Capsfilter speist zwei unabhängige Zweige — den
bestehenden FPS-/Health-Zweig (`fakesink`, C2, unverändert) und den neuen
RTP-Zweig. Der RTP-Zweig braucht zwingend `videoconvert` **und**
`videoscale` vor dem festen Ziel-Format (UYVY, 640×480): `videoconvert`
wandelt nur den Farbraum, ohne `videoscale` schlägt die
Caps-Verhandlung fehl, sobald die native Auflösung der Quelle (z. B.
`videotestsrc`) von 640×480 abweicht — **Bug beim ersten Live-Test
gefunden**: Pipeline lief fehlerfrei (keine Bus-ERROR-Message, FPS-Zweig
unbeeinträchtigt), aber am Empfänger kamen nachweislich keine Pakete an;
`videoscale` ergänzt hat es behoben (verifiziert per `gst-launch-1.0 -v
udpsrc port=5004 ! fakesink silent=false`, das `chain`-Nachrichten mit
tatsächlichen Byte-Zahlen zeigt).

**omp-node-sdk-Erweiterung — generische Sender-Connection-API**
(`src/connection.rs`, neu): `SenderConnection<C, S>` verwaltet
staged/active-Zustand für genau einen Sender und delegiert Wirkung
(`SenderControl::apply`) und SDP-Erzeugung (`SenderSdp::sdp`) an den
Node. Kein HTTP-Wissen im Modul selbst — angebunden über
`ParamStore::extra_route` (neuer Default-Trait-Method-Fallback in
`server.rs`, nach den vier generischen Routen, vor dem endgültigen 404;
bestehende `ParamStore`-Implementierungen brauchen keine Änderung).
`RawResponse` transportiert die Antwort transportunabhängig (kein
`tiny_http`-Typ in der Trait-Signatur).

**Henne-Ei-Problem gelöst — `SenderSpec`:** `manifest_href`
(`.../senders/<id>/transportfile`) braucht die eigene Sender-ID, die
bisher aber erst *innerhalb* von `node::start()` generiert wurde. Statt
eines Sonderfalls für Playout: `NodeConfig.senders` ist jetzt
`Vec<SenderSpec>` (`id: Option<String>`, `manifest_href: Option<String>`)
statt einer bloßen Anzahl — ein Node kann seine Sender-ID selbst vorab
erzeugen (`omp_node_sdk::idgen::new_v4()`), bevor `start()` aufgerufen
wird, und sie referenzieren. Ohne beides verhält sich ein Sender wie
zuvor (auto-generierte ID, kein Manifest) — `hello_node.rs` unverändert
im Verhalten, nur `SenderSpec::default()` statt `senders: 1`.

**Verifiziert (gegen die echte Registry/NATS, per curl/gst-launch, kein
Browser nötig für die Kernlogik):**
- `GET .../senders/<id>/staged` und `.../transportfile` liefern
  korrektes JSON bzw. eine SDP, die exakt zum echten Ausgang passt
  (Ziel, Format, Framerate).
- Direktes `PATCH .../staged` (destination + `master_enable`) schaltet
  den echten RTP-Ausgang nachweislich scharf/stumm: bei `master_enable:
  true` wächst die Empfänger-Mitschnittdatei kontinuierlich, bei `false`
  bleibt sie exakt stehen (Größenvergleich über 2 s), erneutes `true`
  lässt sie sofort weiterwachsen.
- `POST /api/v1/graph/edges` (identischer Aufruf wie das Flow-Editor-
  Drag&Drop, B3) schaltet den Sender **automatisch** scharf, `DELETE
  .../edges/<id>` wieder ab — ohne dass am Playout-Node selbst etwas
  manuell nachgeholfen werden musste.
- `MockReceiver` (keine eigene Sender-API) bleibt durch die
  Orchestrator-Änderung unbeeinträchtigt (bereits in A7/B1 etabliertes
  Verhalten unverändert, zusätzlich durch die neuen Go-Tests abgesichert).
- `cargo test`, `cargo clippy -D warnings`, `cargo deny check`, `cargo
  audit` (Rust) sowie `go test ./...` (Orchestrator) grün.

## 2026-07-09 — MXL-Zeitpunkt: geprüft (Fable), Timing bewusst anders
entschieden als empfohlen

**Kontext:** Nutzer-Anforderung: Inter-Node-Medientransport muss beim
Vorführen des Projekts über MXL-Zero-Copy laufen, nicht über Netzwerk
(RTP, wie in C3 gebaut). Von Claude recherchiert:
`github.com/dmf-mxl/mxl`, v1.0.1 (Mai 2026), Linux Foundation + EBU +
NABA, Apache-2.0, C++-Kern mit C-API und Rust-Bindings, Build über
CMake+vcpkg (nicht auf crates.io) — `cmake`/`vcpkg` fehlen auf dieser
Maschine.

**Fable-Review (unabhängige Zweitmeinung) ergab zwei Teile:**
1. **Channel-Chain-Granularität:** Player/Mixer/Grafik sollten getrennte
   Nodes bleiben (unabhängig wiederverwendbar/ersetzbar). Freeze/Failover
   und Branding dagegen **nicht** trennen — ein gemeinsamer
   "Master-Control-Node", da beide am selben Einfügepunkt sitzen und
   mehr Prozessgrenzen hier die Ausfallsicherheit senken statt erhöhen
   (der Freeze-Switch muss die letzte Inline-Stufe sein; ein Prozess
   dahinter wäre ein neuer Single Point of Failure). Freeze/Black-
   Erkennung kann trotzdem ein eigener, abstürzsicherer Probe-Node sein
   (MXL-Multi-Reader liest kostenlos mit, kein zusätzlicher Hop). Zu
   Grass Valley AMPP als Vergleich: öffentlich bestätigt ist nur
   Shared-Memory-Austausch ("FrameCache", auf MXL zulaufend) und dass
   Playout X/Master Control als **ein** Produkt verkauft wird
   (Switching+Keying+Branding gebündelt) — die genauen internen
   Prozessgrenzen sind nicht öffentlich, Fable hat das explizit als
   Beobachtung aus der Produktgrenze gekennzeichnet, nicht als
   bestätigte Architektur.
2. **Empfehlung (nicht so übernommen, siehe Entscheidung unten):** MXL
   sofort vorziehen als neue Schritte C4a (Toolchain + `MxlVideoOutput`)
   und C4b (zweiter Node `omp-monitor` als MXL-Consumer, macht Zero-Copy
   erst vorführbar), vor C4 (Playlist-Engine).

**Entscheidung des Nutzers:** Phase C läuft **wie ursprünglich geplant**
weiter — C4 (Playlist-Engine v0) ist der nächste Schritt, keine
C4a/C4b-Einschübe jetzt. MXL wird konkret dann implementiert, **wenn die
OGraf-Grafik-Integration in den Playout-Node gebaut wird** (aktuell in
`ARCHITECTURE.md` §7-Phasenplan als P4 "Minimal-Grafik-Node" vermerkt,
noch kein konkreter `UMSETZUNG.md`-Schritt) — Video-Compositing zwischen
Playout und einem Grafik-Node ist auch technisch der naheliegendste
erste Zero-Copy-Anwendungsfall (enges Frame-für-Frame-Zusammenspiel
zweier Prozesse), nicht der reine Netz-Ausgang aus C3.

**Konsequenz:**
- `ARCHITECTURE.md` P4-Zeile ergänzt: OGraf-Integration nennt jetzt
  explizit MXL als vorgesehenen Transport.
- Kein neuer C4a/C4b-Schritt in `UMSETZUNG.md`; C3s RTP-Ausgang bleibt
  bis zur OGraf-Integration der tatsächlich genutzte Transport-Pfad des
  Playout-Node.
- Die Granularitäts-Empfehlung (Player/Mixer/Grafik getrennt,
  Freeze+Branding gemeinsam) ist hier dokumentiert, aber **noch nicht**
  als eigener ARCHITECTURE.md-Abschnitt formalisiert (anders als §6.1/
  §6.2) — bei Bedarf nachholen, sobald diese Node-Typen tatsächlich
  angegangen werden.

**Diese Entscheidung ist durch den Eintrag unten (2026-07-09, „MXL-Timing
per Nutzer-Machtwort vorgezogen") überschrieben** — MXL wird jetzt sofort
gebaut, nicht erst bei OGraf.

## 2026-07-09 — MXL-Timing per Nutzer-Machtwort vorgezogen; C4 (Playlist)
verworfen zugunsten einer MXL-Demo-Trias

**Kontext:** Während C4 (Playlist-Engine v0, Zwei-Slot-`input-selector`-
Pipeline im Playout-Prozess) trat ein GStreamer-Bug auf (Buffer-Stillstand
nach ~1 s ohne Bus-Fehler nach einem Slot-Wechsel). Die Fehlersuche verlief
als eskalierende Kette von Ad-hoc-Versuchen (`sync-streams=false`,
`leaky=downstream` — verursachte einen echten Crash —,
`sync_state_with_parent()`, `Latency`-Bus-Message-Handling), ohne
Konsultation von `/home/infantilo/PIPELINE CONTROLLER`, obwohl dessen
`CLAUDE.md`-Verweis genau dafür existiert.

**Nutzer-Intervention (wörtlich):** *"stop guessing. im projekt pipeline
controller ist alles schon korrekt enthalten was du brauchen würdest!! du
befolgst nicht die arbeitsanweisungen! NIE raten! aber wichtiger: fabel
soll den plan ändern: zum testen und als demo für das projekt möchte ich
folgende microservices, die ich auch mehrfach starten können muss: test
video source->MXL (ball,smpte,..auswählbar), test video switcher (MXL am
Eingang, er zeigt dynamisch alle gefundenen sourcen als inputs an, bietet
dafür buttons (videomixer) und schaltet die gewünscht auf seinen
ausgang->MXL, test viewer (MXL am Eingang und zeigt das Bild an). Die
services müssen über die gui gestartet/gestoppt werden können."*

Das ist zweierlei: (a) eine Arbeitsregel — vor GStreamer-Fehlersuche per
Trial-and-Error immer erst PIPELINE CONTROLLER konsultieren (jetzt in
`UMSETZUNG.md` §0 als Punkt 9 aufgenommen); (b) eine neue, konkrete
Anforderung, die den Playlist-Weg aus C4 ersetzt.

**Fable-Review (vollständiger Plan, Auftrag: PIPELINE-CONTROLLER-Muster
konsultieren statt neu zu raten) behauptete eine zentrale technische
Entdeckung — MXL bringe ein eigenes GStreamer-Plugin mit
(`rust/gst-mxl-rs`, Elemente `mxlsink`/`mxlsrc`, zur Laufzeit über
`GST_PLUGIN_PATH` geladen, kein Cargo-Dependency).**

**Diese Behauptung war falsch und wurde beim tatsächlichen Bauen von
MXL (siehe Eintrag unten, „MXL-GStreamer-Integration richtiggestellt")
widerlegt** — weder Fable noch PIPELINE CONTROLLERs eigene (dort nie
tatsächlich gebaute) Doku-Kommentare hatten das am realen Repo verifiziert.
Die zunächst hierher übernommene Konsequenz („kein Cargo-Dependency, kein
CMake/vcpkg im Rust-Build") ist damit ebenfalls hinfällig — siehe unten für
den korrigierten Stand.

**Entscheidung des Nutzers:** Fables vollständigen Plan wie vorgelegt
übernehmen (`UMSETZUNG.md` entsprechend umgeschrieben — siehe dortige
Phase C). Kernpunkte:
- Der Zwei-Slot-`input-selector`-Ansatz aus dem C4-Versuch wird **komplett
  verworfen**, nicht gefixt — das Grundmuster war falsch. Richtig (aus
  PIPELINE CONTROLLERs `MasterPipeline.js`/`PlayerPipeline.js`): jede
  Quelle läuft **durchgehend als eigene, nie dynamisch ge-/entsperrte
  Pipeline**; ein Selector/Switcher konsumiert von außen
  (`intervideosrc … do-timestamp=true` dort, MXL hier).
- `playlist.rs` (reine Playlist-Logik, 12 Tests, kein GStreamer-Wissen)
  ist weiterhin gute Arbeit und wird für den späteren echten
  Playout-Umbau (C10/C11) wiederverwendet — liegt bis dahin auf dem
  Branch `c4-playlist-wip`, nicht auf `main`.
- Drei debuggte Lehren aus dem C4-Versuch, die den Revert überleben
  müssen (standen nur als Kommentare im jetzt verworfenen `pipeline.rs`):
  (a) ein Bus-Poller, der nur auf `ERROR` filtert, muss auch
  `Latency`-Messages behandeln (`pipeline.recalculate_latency()`);
  (b) `leaky=downstream` an Queues ist **nicht grundsätzlich
  crash-gefährlich** (MasterPipeline.js nutzt es durchgehend und sicher —
  der eigene Crash war setup-spezifisch, vermutlich Interaktion mit
  gleichzeitig leaky Zweigen an einem `tee`); (c) die eigentliche
  Bug-Klasse ist das dynamische (Re-)Aktivieren eines zuvor
  `locked_state`-gesperrten Elements in einer laufenden Pipeline — das
  ist zu **vermeiden**, nicht zu patchen (Topologie-Änderungen nur per
  komplettem Pipeline-Neuaufbau oder über durchgehend laufende,
  vorab-provisionierte Zweige).
- Neue Schrittfolge C4–C11 ersetzt die alte C4–C6 (Details siehe
  `UMSETZUNG.md` Phase C). „Demo 2" wird neu definiert als die
  Source/Switcher/Viewer-Trias; die alte Demo-2-Definition (echtes
  Playout) wird zu „Demo 3" nach C10/C11.
- Offene, ehrlich unbeantwortete Frage (kein Raten): wie sich MXLs
  Grain-/TAI-Epoch-Zeitmodell auf GStreamer-Timestamps abbilden lässt —
  wird in C4 explizit per Loopback-Test geklärt, nicht angenommen (siehe
  unten: die Form dieses Tests hat sich geändert, da es kein `mxlsrc`-
  Element gibt, das man per `gst-launch` einhängen könnte).

**Konsequenz:**
- `ARCHITECTURE.md` P4-Zeile korrigiert (MXL nicht mehr "erst bei OGraf",
  sondern ab C4 vorhanden; OGraf-Kompositing nutzt es dann einfach mit).
- `ARCHITECTURE.md` §6.2 um einen Absatz „Stufe 0 (Dev/Single-Host):
  Instanz-Launcher" ergänzt (die GUI-Start/Stop-Anforderung ist die
  kleinste, jetzt schon nötige Ausbaustufe von §6.2, D7 bleibt der volle
  Zielzustand).
- `UMSETZUNG.md` §0 Punkt 9 (neu): vor GStreamer-Fehlersuche immer erst
  PIPELINE CONTROLLER konsultieren.
- Commit-Split durchgeführt: `[C4-prep] SDK: Methoden-Argumente im
  generischen Method-Dispatch` auf `main` (Methoden-Argumente im
  Descriptor-Dispatch, unabhängig von C4 nützlich, u.a. für
  `switcher.select(senderId)`); der volle C4-Zwischenstand (Playlist +
  verworfene Pipeline) als Referenz-Commit auf Branch `c4-playlist-wip`.

## 2026-07-09 — MXL-GStreamer-Integration richtiggestellt (am realen v1.0.1-Tag verifiziert)

**Kontext:** Direkt beim Start von C4 (MXL-Fundament) stellte sich beim
tatsächlichen Klonen/Bauen von `github.com/dmf-mxl/mxl@v1.0.1` heraus,
dass die im Eintrag oben übernommene Fable-Behauptung („MXL bringt ein
eigenes GStreamer-Plugin `rust/gst-mxl-rs` mit `mxlsink`/`mxlsrc`-
Elementen, zur Laufzeit über `GST_PLUGIN_PATH` geladen") **nicht
zutrifft** — weder Fable noch die (nie tatsächlich gebauten)
Kommentare in PIPELINE CONTROLLERs `lib/MxlSource.js` hatten das an
echtem Code verifiziert. Per Arbeitsregel (`UMSETZUNG.md` §0 Punkt 6/9:
nicht raten, nachschlagen) wurde das jetzt am tatsächlichen Checkout
geprüft, statt die Behauptung weiterzutragen.

**Tatsächlicher Befund** (verifiziert: `git log`/`git status` des Clones,
`tools/mxl-gst/CMakeLists.txt`, `grep -r GST_PLUGIN_DEFINE`,
erfolgreicher Build + Loopback-Test):
- Es existiert **kein** `rust/gst-mxl-rs`-Verzeichnis und **kein**
  installierbares GStreamer-Element `mxlsink`/`mxlsink`. Das einzige im
  gesamten Repo per `GST_PLUGIN_DEFINE`/`gst_element_register`
  registrierte Element ist `looping_filesrc`
  (`utils/gst-looping-filesrc/`) — unabhängig von MXL-Flows, ein
  generisches Datei-Loop-Utility.
- `tools/mxl-gst/` enthält drei **eigenständige C++-Kommandozeilen-
  programme** (`add_executable`, nicht `add_library MODULE`):
  `mxl-gst-testsrc` (Testmuster → MXL-Flow, intern `videotestsrc ! … !
  appsink`, schreibt Grains über die C-API), `mxl-gst-sink` (MXL-Flow →
  `autovideosink`/`autoaudiosink`, fix verdrahtet, keine Kopfloses-
  Display-Option), `mxl-gst-looping-filesrc` (Datei → MXL-Flow, loop).
  Nützlich als Verifikations-/Debug-Werkzeuge, nicht als Baustein für
  `omp-mediaio` (kein MJPEG-/Headless-Ausgang, keine Laufzeit-
  Parametrisierbarkeit für unsere Descriptor-API).
- Die tatsächliche Rust-Anbindung sind die mitgelieferten Crates
  `rust/mxl-sys` (FFI: `bindgen` generiert Bindings gegen
  `lib/include/mxl/*.h`, `libloading` lädt `libmxl.so` **zur Laufzeit
  per `dlopen`** — mit Feature `mxl-not-built` läuft nicht einmal CMake
  im `cargo build` selbst mit) und `rust/mxl` (sicherer Wrapper:
  `FlowWriter`/`FlowReader`, `GrainWriter`/`GrainReader`,
  `SamplesWriter`/`SamplesReader`). Für `omp-mediaio` heißt das: eine
  echte (Pfad-)Cargo-Dependency auf `third_party/mxl/rust/mxl`, hinter
  einem Feature-Flag `mxl` (Default aus), keine Pipeline-Element-Syntax
  — unsere Nodes bauen die appsink/appsrc-Brücke selbst (siehe
  `UMSETZUNG.md` C4, korrigierter Abschnitt).
- `libmxl.so` selbst **braucht weiterhin CMake+vcpkg zum einmaligen
  Bauen** (nicht Teil des Rust-Builds, nur von `deploy/dev/install-mxl.sh`
  ausgeführt) — das war schon im allerersten Eintrag (oben, „MXL-Zeitpunkt
  geprüft") richtig vermutet und wurde jetzt konkret: `cmake --preset
  Linux-GCC-Release` erwartet `$HOME/vcpkg` (gebootstrapt,
  `bootstrap-vcpkg.sh --disableMetrics`); `vcpkg.json` zieht u. a.
  `pcapplusplus` (Linux), was transitiv `bison`/`flex` als Build-Tools
  braucht (auf dieser Maschine gefehlt, ergänzt in
  `deploy/dev/install-mxl.sh`). `ninja` war schon vorhanden.

**Konkret durchgeführt und verifiziert:**
- `deploy/dev/install-mxl.sh` korrigiert (vcpkg-Bootstrap ergänzt,
  `bison`/`flex` zu den apt-Paketen ergänzt, `gst-mxl-rs`-Abschnitt
  entfernt, schreibt jetzt `MXL_INFO_BIN`/`MXL_GST_TESTSRC_BIN`/
  `MXL_GST_SINK_BIN` statt `GST_PLUGIN_PATH`).
- Vollständiger Build erfolgreich: `libmxl.so` (+ `.so.1`/`.so.1.0`),
  `tools/mxl-info/mxl-info`, `tools/mxl-gst/mxl-gst-{testsrc,sink,
  looping-filesrc}`.
- Loopback-Test: `mxl-gst-testsrc -d /dev/shm/omp-mxl -v
  lib/tests/data/v210_flow.json -p smpte` erzeugt einen Flow;
  `mxl-info -d /dev/shm/omp-mxl -l` listet ihn korrekt
  (`mxl-gst-testsrc-group: mxl:///dev/shm/omp-mxl?id=…`). Log zeigt
  intern u. a. `videotestsrc … is-live=true do-timestamp=true … !
  textoverlay ! clockoverlay ! videoconvert ! videoscale ! queue !
  appsink` und `DiscreteFlow: Set initial grain index to … (bufferTs=…
  ns)` — bestätigt, dass Grains einen aus der Schreib-Pipeline
  stammenden Buffer-Timestamp mitführen (relevant für die in C4 noch
  offene Timestamp-Frage beim Lesen).
- `mxl-gst-sink` (Lese-Referenz) nicht headless testbar (fest verdrahtet
  auf `autovideosink`/`autoaudiosink`) — für den eigenen `GrainReader`-
  Loopback-Test in C4 wird stattdessen direkt gegen die Rust-`mxl`-Crate
  getestet, nicht gegen dieses Tool.

**Konsequenz:**
- `UMSETZUNG.md` C4-Abschnitt umgeschrieben (Anweisung + Verifikation),
  Verweise auf `MxlVideoOutput`/`MxlVideoInput` als Pipeline-Kurzform in
  C5/C6 mit einem Klarstellungssatz versehen.
- `deploy/dev/install-mxl.sh` korrigiert (siehe oben) und erfolgreich
  gegen dieses Dev-System durchlaufen.
- Keine Änderung an den höherstufigen Entscheidungen aus dem Eintrag
  oben (drei Services, GUI-Launch, C4–C11-Schrittfolge, „Demo 2"-
  Neudefinition) — nur die Baustein-Ebene „wie genau spricht Rust mit
  MXL" war falsch und ist jetzt korrigiert.

## 2026-07-09 — C4 (MXL-Fundament) fertig: `omp-mediaio::mxl` + SDK-Erweiterung, End-to-End verifiziert

**Umgesetzt** (siehe `nodes/omp-mediaio/src/mxl.rs`,
`nodes/omp-node-sdk/src/is04.rs`, `nodes/omp-node-sdk/src/node.rs`):

- `Output`-Trait wie geplant abgespeckt (nur noch `set_active`/
  `is_active`); `RtpVideoOutput::set_destination`/`destination` sind jetzt
  inhärente Methoden statt Trait-Methoden (Aufrufstelle in
  `playout/src/main.rs` unverändert, da Methodenauflösung inhärente
  Methoden mitfindet).
- `omp-mediaio` bekommt ein Feature `mxl` (default aus): Pfad-Abhängigkeiten
  auf `third_party/mxl/rust/mxl` + `rust/mxl-sys` (Feature
  `mxl-not-built`, damit `cargo build` **nicht** selbst nochmal CMake
  aufruft — das erledigt einmalig `install-mxl.sh`), plus
  `gstreamer-app`/`serde_json`.
- `MxlVideoOutput`: `videoconvert ! videoscale ! videorate !
  capsfilter(v210) ! valve ! appsink`, dahinter ein Schreib-Thread
  (`mxl::GrainWriter`). **Vereinfachung ggü.
  `tools/mxl-gst/testsrc.cpp`** (dokumentiert im Code, kein Rätselraten):
  kein TAI-Clock-Alignment der Pipeline und keine PTS→Index-Umrechnung —
  stattdessen wird der Grain-Index einmalig per `get_current_index()`
  initialisiert und pro Sample um 1 erhöht. Korrekt, solange Samples nahe
  am konfigurierten Takt ankommen (gegeben bei `videotestsrc`/
  `videorate`), ohne Drift-Selbstkorrektur — für die Test-Trias (C5–C7)
  ausreichend, bei Bedarf später auf das PTS-basierte Verfahren wechselbar.
- `MxlVideoInput`: liest die Flow-Definition eines fremden Flows per
  `get_flow_def()` (JSON, liefert Breite/Höhe/Rate — kein hartkodiertes
  Wissen nötig), dahinter ein Lese-Thread (`mxl::GrainReader`), der Grains
  in ein `appsrc do-timestamp=true` schiebt.
- **Offene C4-Frage beantwortet (nicht angenommen, sondern durch die
  Architektur der Lösung entschieden):** Für den Lese-Pfad übernimmt
  `appsrc do-timestamp=true` exakt die Rolle von PIPELINE CONTROLLERs
  `intervideosrc … do-timestamp=true` — verwirft die ursprüngliche
  Grain-Herkunftszeit, stempelt mit der Laufzeit der lesenden Pipeline neu.
  Für den Schreib-Pfad wird die PTS-Frage durch die oben genannte
  Vereinfachung umgangen (kein PTS-Grain-Index-Mapping nötig, da über
  `get_current_index()` statt Timestamp-Konversion gearbeitet wird).
- `omp-node-sdk::is04`: `TRANSPORT_MXL`-Konstante, neue `Source`-/
  `Flow`-Resources (Felder gegen `specs.amwa.tv`/`AMWA-TV/is-04` v1.3.x
  `resource_core.json`+`source_core.json`+`source_generic.json` bzw.
  `flow_core.json`+`flow_video.json` verifiziert, nicht geraten).
  `SenderSpec` bekommt `transport`/`flow: Option<FlowSpec>`; bei
  gesetztem `flow` registriert `start()` automatisch eine passende
  Source+Flow und setzt `sender.flow_id` — Konvention Flow-UUID ==
  MXL-`flow-id` (`FlowSpec.id` sollte vom Aufrufer auf die tatsächliche
  MXL-`flow-id` gesetzt werden).

**Zwei weitere, beim Bauen entdeckte Toolchain-Lücken** (in
`deploy/dev/install-mxl.sh` behoben, nicht vorher bekannt/dokumentiert):
`libclang-dev`+`clang` fehlten (nötig für `mxl-sys`s `bindgen`-Build-Skript,
sonst "Unable to find libclang"). Zusätzlich musste MXLs Flow-JSON einen
Pflicht-Tag `urn:x-nmos:tag:grouphint/v1.0` im Format
`<group-name>:<role-in-group>` tragen (sonst "Invalid or missing group
hint tag" bzw. "Invalid group hint value ..." — Format aus der
Fehlermeldung + dem mitgelieferten `v210_flow.json`-Beispiel abgeleitet,
nicht geraten).

**Verifikation bestanden:** `cargo test -p omp-mediaio --features mxl`
(mit `source deploy/dev/mxl.env`) — echter End-to-End-Test
(`mxl::tests::write_then_read_loopback`): schreibt ~50 `videotestsrc`-
Frames über `MxlVideoOutput` in einen Flow, liest ihn über einen zweiten,
unabhängigen `MxlContext` (simuliert einen zweiten Prozess) über
`MxlVideoInput` zurück, zählt über eine Pad-Probe angekommene Buffer am
`fakesink` — grün. `cargo build`/`cargo clippy`/`cargo test` für den
gesamten Workspace (mit und ohne `--features mxl`) sowie `cargo deny
check` bleiben grün.

C4 damit abgeschlossen. Weiter mit C5 (`omp-source`).

## 2026-07-09 — C5 (`omp-source`) blockiert: Flow-Registrierung schlägt an nmos-cpp fehl

**Stand:** `nodes/omp-source/` implementiert (Crate + `pipeline.rs` +
`main.rs`, siehe `UMSETZUNG.md` C5), baut/lintet sauber
(`cargo build`/`clippy`/`fmt` grün), aber **noch nicht committet** (Regel
§0.3/0.4: kein Commit ohne bestandene Verifikation) — liegt unverändert im
Arbeitsverzeichnis für die nächste Sitzung. `nodes/Cargo.toml` (neues
Workspace-Mitglied) und `nodes/Cargo.lock` sind bereits als Änderung
vorhanden, ebenfalls uncommitted.

**Fehler:** Zwei `omp-source`-Instanzen (Ports 9320/9321, Pattern
`smpte`/`ball`) starten, aber `omp-node-sdk: registration failed, retrying:
register: unexpected status 400` in Dauerschleife. Registry-Log
(`podman logs omp-nmos-registry`) zeigt die genaue Ursache:

```
warning: JSON error: schema validation failed at root - no subschema has
succeeded, but one of them is required to validate JSON -
{"data":{"colorspace":"BT709","description":"","device_id":"...",
"format":"urn:x-nmos:format:video","frame_height":480,"frame_width":640,
"grain_rate":{"denominator":1,"numerator":25},"id":"...",
"interlace_mode":"progressive","label":"Source A Sender 1","parents":[],
"source_id":"...","tags":{},"version":"..."},"type":"flow"}
```

Node/Device/Source-Registrierung geht durch (Log zeigt "Registration
requested for unchanged source: ..." ohne Fehler) — **nur die
Flow-Resource** (`is04::Flow`, `nodes/omp-node-sdk/src/is04.rs`) wird von
nmos-cpp abgelehnt. `tags: {}` (leeres Objekt) fällt auf: anders als bei
Sender/Receiver (die den Grouphint-Tag nicht brauchen) könnte die
Flow-Resource denselben Pflicht-Tag brauchen, den `mxl.rs`s
`video_flow_def` fürs MXL-eigene Flow-JSON schon kennt
(`urn:x-nmos:tag:grouphint/v1.0`, Format `<name>:<rolle>` — siehe
C4-Eintrag oben) — das ist aber eine MXL-Eigenheit, keine IS-04-Pflicht;
für die **NMOS**-Flow-Resource selbst nicht ungeprüft übernehmen. Nicht
geraten, sondern in der nächsten Sitzung zuerst zu klären:

1. Direktes `curl -X POST http://localhost:8010/x-nmos/registration/v1.3/resource`
   mit exakt obigem Flow-JSON (aus dem Log kopiert) — liefert nmos-cpp im
   400-Response-Body vermutlich eine präzisere Fehlermeldung als das
   Log allein.
2. Gegen `specs.amwa.tv`/`AMWA-TV/is-04` v1.3.x `flow_video.json` +
   `flow_core.json` + `resource_core.json` abgleichen, welches Feld exakt
   fehlt/falsch ist (Kandidaten: `tags` könnte trotzdem ein Pflichtformat
   brauchen, oder ein in `resource_core.json` gefordertes Feld fehlt in
   `is04::Flow`, das in `Sender`/`Receiver` schon vorhanden ist, z. B.
   ein Versions- oder Format-Detail).
3. Erst nach behobenem Fehler: Rest der C5-Verifikation (2 Instanzen →
   2 Flows in `mxl-info` + 2 MXL-Sender in der Registry; `pattern` per
   PATCH ändern → sichtbar im Loopback) durchführen, dann committen.

**Cleanup am Sitzungsende:** beide `omp-source`-Testinstanzen sowie ein
zu Testzwecken laufender Orchestrator-Prozess (`go run .`) beendet;
NATS-/NMOS-Registry-Podman-Container (`omp-nats`, `omp-nmos-registry`)
bewusst weiterlaufen gelassen (persistente Dev-Infrastruktur, kein
Sitzungs-Task).

## 2026-07-10 — C5-Blocker behoben: `flow.json` verlangt `flow_video_raw.json`,
nicht `flow_video.json`

**Ursache gefunden über Schritt 1+2 des Blocker-Eintrags** (curl-Direkttest
gegen die laufende Registry + Abgleich gegen die AMWA-Spec, nicht geraten):
Das Registration-API-Schema `registrationapi-resource-post-request.json`
validiert eine `"type":"flow"`-Resource gegen `flow.json`. Dieses referenziert
aber **nicht** `flow_video.json` direkt, sondern (`anyOf`)
`flow_video_raw.json`/`flow_video_coded.json`/`flow_audio_*.json`/
`flow_data.json`/… — `flow_video_raw.json` selbst ist ein `allOf` aus
`flow_video.json` **plus** zwei weiteren Pflichtfeldern: `media_type`
(enum, hier `"video/raw"` bzw. für kodierte Formate ein anderer Wert) und
`components` (Array je Farbebene mit `name`/`width`/`height`/`bit_depth`).
`is04::Flow` (`nodes/omp-node-sdk/src/is04.rs`) implementierte nur
`flow_video.json`s Feldsatz — deshalb „no subschema has succeeded": keine
der `anyOf`-Alternativen passte, weil `media_type`/`components` in jeder
Alternative Pflicht sind (nicht nur bei `raw`). Per curl bestätigt: mit
Dummy-UUIDs + `media_type`/`components` ergänzt wechselt die Fehlermeldung
von „schema validation failed" zu „unknown parent device" (referentielle
Prüfung, nicht mehr Schema) — sauberer Beleg, dass genau diese zwei Felder
gefehlt haben.

**Fix:** `Flow` bekommt `media_type: String` und `components: Vec<FlowComponent>`
(`{name, width, height, bit_depth}`). `Flow::new_video` befüllt beide mit
`"video/v210"` und Y (voll)/Cb/Cr (halbe Breite) bei 10 bit — **identisch**
zu `omp-mediaio::mxl::video_flow_def`s bereits bestehendem MXL-eigenen
Flow-JSON (C4), weil beide Resources denselben tatsächlichen, über MXL
laufenden Videostrom beschreiben (kein zweites, unabhängig geratenes
Layout).

**Verifiziert (End-to-End, `deploy/dev/mxl.env` gesourced):**
- `cargo build`/`clippy`/`fmt --check`/`test --workspace` grün (inkl.
  `omp-mediaio`s `write_then_read_loopback`), `omp-mediaio --no-default-features`
  weiterhin baubar, `cargo deny check` grün.
- Zwei `omp-source`-Instanzen (Port 9320/„Source A"/`smpte`, Port
  9321/„Source B"/`ball`) registrieren ohne Retry-Loop
  (`omp-node-sdk: node registered: …`), FPS-Log zeigt stabile ~25 fps.
- `GET .../x-nmos/query/v1.3/flows` liefert beide Flows mit `media_type`/
  `components`; `GET .../senders` zeigt beide mit
  `transport: urn:x-omp:transport:mxl`; `mxl-info -l` listet beide
  Flow-IDs — identisch zwischen NMOS-Flow-`id` und MXL-`flow-id`
  (Konvention aus C4 hält).
- `PATCH .../params/pattern` (Source B → `checkers-1`) liefert HTTP 200,
  Pipeline läuft danach fehlerfrei mit unverändert ~25 fps weiter.
  **Nicht geprüft:** der tatsächliche Bildinhalt/Testbild-Typ selbst
  (bräuchte `omp-viewer`, C6, oder ein Ad-hoc-GStreamer-Sink-Tool — auf
  Nutzerentscheidung zurückgestellt, bleibt wie die Browser-Interaktion in
  B2/B3 eine offene visuelle Prüfung, hier bis C6). PATCH-Erfolg +
  fehlerfreier Weiterlauf der Pipeline gelten als ausreichender Beleg,
  dass die Property tatsächlich gesetzt wurde.

C5 damit abgeschlossen. Beide Test-Instanzen und der `nodes/omp-source`-
Build-Output am Sitzungsende beendet/aufgeräumt; NATS-/NMOS-Registry-
Container bleiben laufen (persistente Dev-Infrastruktur).

## 2026-07-10 — C6 (`omp-viewer`): SDK-Erweiterung für IS-05-Receiver-Connections
+ MJPEG-Preview

**Ziel erreicht:** Zweiter Demo-Service (`UMSETZUNG.md` C6) — zeigt einen
per Flow-Editor-Drag&Drop (B3) gewählten MXL-Flow headless über
MJPEG-über-HTTP an, ohne jede Orchestrator-Änderung.

**SDK-Erweiterungen (Voraussetzung, bevor `omp-viewer` selbst geschrieben
werden konnte):**
- `omp-node-sdk::node`: `NodeConfig.receivers` war bisher nur `usize`
  (reine Anzahl, auto-generierte IDs, RTP-Transport-Default) — für einen
  Receiver mit eigener IS-05-Connection-API muss die ID aber schon vor
  `start()` feststehen (gleiches Henne-Ei-Problem wie `SenderSpec::id`/
  `manifest_href` bei C3). Neuer Typ `ReceiverSpec { id, transport,
  media_types }`, `NodeConfig.receivers: Vec<ReceiverSpec>` (Breaking
  Change für die drei bestehenden Aufrufer — `playout`/`omp-source`
  `receivers: 0` → `vec![]`, `hello_node`-Beispiel `receivers: 1` →
  `vec![ReceiverSpec::default()]` — vor dem SDK-v1-Freeze unproblematisch,
  siehe `ARCHITECTURE.md` §5 Punkt 6/§6.1-Notiz).
- `omp-node-sdk::connection`: `ReceiverConnection<C>`/`ReceiverControl`
  als Receiver-seitiges Pendant zu C3s `SenderConnection`/`SenderControl`
  — Rust-Fassung von `nodes/mock/internal/connection` (Go), aber bewusst
  ohne dessen getrennte staged-/active-Zustandsführung: der Flow-Editor
  PATCHt laut `orchestrator/internal/is05/client.go` ohnehin immer mit
  `activation.mode=activate_immediate`, eine Staging-Zwischenstufe hätte
  keinen Aufrufer (gleiche Vereinfachung wie `SenderConnection` schon für
  C3 trifft — ein `state`, beide GET-Endpunkte liefern ihn).
- `omp-node-sdk::is04::RegistryClient::get_sender`: erster Query-API-Call
  von Rust aus (`GET .../x-nmos/query/v1.3/senders/<id>`, gleiche
  Registry-Basis-URL wie die Registration-API, siehe
  `orchestrator/internal/registry/client.go`) — Grundlage für die
  Quellwahl: der Receiver kennt aus dem PATCH-Body nur `sender_id`, muss
  daraus `flow_id` ableiten (Konvention Flow-UUID == MXL-`flow-id`, C4).

**`omp-viewer`-Pipeline (`pipeline.rs`):** `MxlVideoInput` (liefert
bereits `appsrc ! videoconvert ! videoscale ! videorate`, C4) → `tee` →
MJPEG-Zweig (PIPELINE CONTROLLERs `PreviewPipeline.js`-Muster 1:1
übernommen: `videoscale 640×360 ! videorate 5/1 ! jpegenc quality=70 !
appsink sync=false`) + optionaler `autovideosink`-Zweig
(`OMP_VIEWER_SINK`). Bei jedem Quellwechsel (IS-05-Receiver-PATCH →
`ViewerControl::apply` → Registry-Query → neue `flow_id`) wird die
**gesamte Pipeline neu aufgebaut** (alte `ActivePipeline` gedroppt, State
Null stoppt den `appsrc`, `MxlVideoInput`s Reader-Thread bricht daraufhin
selbst aus seiner `push_buffer`-Schleife) statt dynamischem
Pad-Relinking — bewusst dieselbe, einfachere Antwort, die
`MasterPipeline.js` für einen geänderten Live-Quellen-Satz nutzt (hier auf
einen einzelnen Input übertragen), keine neu erfundene Technik.

**MJPEG-Ausgabe (`preview.rs`):** zweiter, unabhängiger
`tiny_http`-Listener (`OMP_VIEWER_PREVIEW_PORT`, Default 9341) — bewusst
**nicht** über `omp_node_sdk::server`s bestehenden Descriptor-Server
(dessen Accept-Loop ist single-threaded; eine dauerhaft offene
MJPEG-Antwort würde sie für alle weiteren Requests blockieren), stattdessen
ein Thread pro Verbindung. Nutzt `tiny_http::Request::into_writer()` (roher
Stream-Zugriff, wie im `php-cgi`-Beispiel des Crates) statt
`Request::respond()`, um Status-Zeile/Header selbst zu schreiben und
danach beliebig lange weitere `--frame`-Chunks nachzuschieben — Rust-
Äquivalent zu Node.js' `res.write()`-Pattern in PIPELINE CONTROLLERs
`server.js`/`PreviewPipeline.js`. Ein `Broadcaster` verteilt jedes vom
appsink-Callback gezogene JPEG an alle verbundenen Clients (Channel pro
Client) und hält das letzte Frame vor, damit neu verbindende Clients
sofort ein Bild sehen; bei Disconnect (`ReceiverControl::apply` ohne
aktiven Sender) wird das vorgehaltene Frame verworfen.

Auch das eigene `/ui/manifest.json`+`/ui/bundle.js` (`ARCHITECTURE.md`
§4.5) zeigt direkt auf diesen zweiten Listener, nicht über den
Orchestrator-Proxy: `orchestrator/internal/httpapi/proxy.go`s
`handleNodeProxy` macht nur kurzlebige Einzel-Request-Weiterleitungen
(Descriptor/Params/Methods/UI-Bundle), kein Streaming — das `<img>` im
Bundle bekommt seine Quelle über den generischen `previewUrl`-Parameter
(absolute URL zum Preview-Port) und lädt sie direkt vom Browser aus, ohne
den Orchestrator zu berühren (funktioniert nur, weil Dev-Setup und Browser
denselben Host sehen — für ein echtes Multi-Host-Deployment bräuchte das
einen richtigen Streaming-Proxy oder direkte Netzerreichbarkeit, hier
bewusst nicht vorgezogen).

**Verifikation bestanden (End-to-End, `deploy/dev/mxl.env` gesourced,
NATS+Registry liefen bereits, Orchestrator + `omp-source` + `omp-viewer`
frisch gestartet):**
- `cargo build`/`clippy --all-targets`/`fmt --check`/`test --workspace`
  (inkl. `omp-mediaio`s `write_then_read_loopback`) sowie `cargo deny
  check` grün für den gesamten Workspace (jetzt 5 Members).
- Beide Nodes erscheinen in `GET /api/v1/nodes` (Viewer mit 1 MXL-Receiver,
  `caps.media_types=["video/v210"]`); `POST /api/v1/graph/edges`
  (Source-Sender → Viewer-Receiver) liefert 200, `GET /api/v1/graph` zeigt
  die Kante als `active`.
- `connectedFlowId` (Parameter-Proxy) wechselt von `""` auf die
  tatsächliche MXL-`flow-id` des Source-Flows.
- `GET http://127.0.0.1:9341/preview` liefert einen echten
  `multipart/x-mixed-replace`-Strom; ein extrahiertes JPEG-Frame zeigt
  sichtbar das SMPTE-Farbbalkenbild — **visuell bestätigt** (Bild
  betrachtet, nicht nur Byte-Länge geprüft), schließt damit die in C5
  zurückgestellte offene Prüfung ("bräuchte omp-viewer, C6") mit ab.
- `PATCH .../params/pattern` (Source A → `ball`) **ohne** manuellen
  Eingriff am Viewer: ein danach gezogenes Frame zeigt sichtbar den
  springenden Ball statt der Farbbalken — bestätigt, dass die Property-
  Änderung durch den bestehenden MXL-Flow durchgereicht wird, ohne
  Pipeline-Neuaufbau auf der Source-Seite.
- `DELETE /api/v1/graph/edges/<id>` trennt: `connectedFlowId` fällt auf
  `""` zurück, `GET /api/v1/graph` zeigt 0 Kanten; erneutes `POST` derselben
  Kante verbindet wieder (`connectedFlowId` zeigt erneut die richtige
  `flow-id`) — Broadcaster-Reset/Pipeline-Teardown/-Neuaufbau beide Wege
  fehlerfrei, keine Fehler-Log-Zeilen in `omp-viewer`s Ausgabe.

**Nicht Teil von C6 (bewusst zurückgestellt):** kein `master_enable`-
getrenntes Verhalten über die reine Connect/Disconnect-Semantik hinaus;
kein Multi-Receiver-Support (ein Receiver pro Viewer-Instanz, wie
spezifiziert); Terminal-Sichtprüfung über `OMP_VIEWER_SINK`
(`autovideosink`) nicht separat getestet, da die MJPEG-Prüfung bereits den
vollständigen Pfad bis zum sichtbaren Bild abdeckt.

C6 damit abgeschlossen. Alle drei Testprozesse (Orchestrator, `omp-source`,
`omp-viewer`) am Sitzungsende beendet; NATS-/NMOS-Registry-Container
bleiben laufen (persistente Dev-Infrastruktur).

## 2026-07-10 — C7 (`omp-switcher`): Discovery-getriebener Rebuild braucht
Absturzschutz gegen verwaiste Registry-Einträge

**Ziel erreicht:** Dritter und letzter Demo-Service (`UMSETZUNG.md` C7) —
Videomixer mit dynamischer, rein IS-04-discovery-basierter Quellenliste
und Button-Auswahl, ohne Orchestrator-Änderung (0 Receiver in v0, wie
spezifiziert).

**SDK-Erweiterung:** `omp-node-sdk::is04::RegistryClient::list_senders`
(`GET .../senders`, gleiche Query-API wie C6s `get_sender`) — einziger
neuer Baustein, alles andere (Descriptor/Methoden-Dispatch mit
Argumenten, IS-04-Sender+Flow-Registrierung mit vorab bekannter ID) war
bereits aus C3/C4-prep/C5 vorhanden.

**Pipeline (`pipeline.rs`), 1:1 aus `MasterPipeline.js` übernommen:**
`input-selector name=isel sync-streams=false`, `sink_0` permanent
Schwarzbild (`videotestsrc pattern=black`), ein Zweig pro entdeckter
Quelle (`MxlVideoInput ! videoconvert!videoscale!videorate!capsfilter(feste
Maße) ! isel.sink_N`, harmonisiert auf dieselben festen Maße/Framerate wie
`omp-source`, damit `input-selector` nur zwischen bereits kompatiblen Caps
umschaltet), danach `isel ! MxlVideoOutput` unter einer über Neuaufbauten
hinweg konstanten `flow_id`. Zwei getrennte Änderungsarten: eine geänderte
Quellenmenge (`Command::SetInputs`, aus dem 2s-Discovery-Poll in `main.rs`)
baut die **gesamte Pipeline neu** auf; ein Button-Klick
(`Command::Select`) ändert nur `isel`s `active-pad`-Property auf der
laufenden Pipeline, kein Neuaufbau.

**Beim Verifizieren gefunden und behoben (echter Bug, kein Verifikations-
Sonderfall):** Ein Rebuild kann fehlschlagen, wenn die Registry
kurzzeitig einen verwaisten Sender-Eintrag zurückgibt (Node-Prozess
beendet, aber `registration_expiry_interval` noch nicht abgelaufen) —
`MxlVideoInput::new` schlägt dann mit "Flow not found" fehl, weil der
referenzierte MXL-Flow mit dem Schreiber-Prozess verschwunden ist.
Ursprüngliche Implementierung brach in diesem Fall die gesamte
Pipeline-Thread-Schleife ab → der komplette `omp-switcher`-Prozess
beendete sich (`main.rs`s `events`-Future endet, `main()` kehrt zurück) —
Widerspruch zum Kernanspruch aus C7 ("Ausgang läuft auch bei null
Quellen") und zur MXL-Flow-Konstanz-Garantie ("Viewer weiter
angeschlossen bleiben können"), die tote Prozesse gar nicht erst
gewährleisten kann. **Fix:** Schlägt der Rebuild mit den entdeckten
Quellen fehl, fällt der Pipeline-Thread auf einen garantiert baubaren
Schwarzbild-Only-Rebuild zurück statt sich zu beenden; `current_inputs`
wird trotzdem auf den (fehlgeschlagenen) Versuch gesetzt, damit nicht bei
jedem 2s-Poll erneut derselbe kaputte Stand versucht wird, bis die
Registry sich selbst korrigiert (beobachtet: deutlich unter 60s, da
nmos-cpp verwaiste Einträge offenbar proaktiv aufräumt, nicht erst lazy
bei Zugriff).

**Verifiziert (End-to-End, sauberer Neustart nach `mxl-info -g`, um
Altlasten aus vorherigen Debug-Läufen dieser Sitzung auszuschließen):**
- `cargo build`/`clippy --all-targets`/`fmt --check`/`test --workspace`
  (inkl. `omp-mediaio`s Loopback-Test) sowie `cargo deny check` grün
  (Workspace jetzt 6 Members).
- 2 `omp-source` + 1 `omp-switcher` + 1 `omp-viewer`: Switcher entdeckt
  beide Quellen automatisch (`GET .../params/inputs` zeigt beide Labels),
  ohne dass der Switcher neugestartet werden musste.
- Switcher-Ausgang → Viewer im Graph verkabelt: Schwarzbild-Fallback läuft
  von Anfang an (~5 fps MJPEG, sichtbar schwarzes Bild) — bestätigt "läuft
  auch bei null aktiver Auswahl".
- `POST .../methods/select` (Source A) → **visuell bestätigtes** SMPTE-
  Farbbalkenbild im Viewer, danach (Source B) → springender Ball, danach
  (leere `senderId`) → zurück zu Schwarz — jeweils ohne Pipeline-Neuaufbau
  auf Viewer-Seite, volle ~5 fps Streaming-Rate (487 KB/5s bzw. 114 KB/4s,
  keine Verzögerung/kein Hängenbleiben mehr, nachdem der Absturz-Fix stand).
- Ein während der Verifikation reproduzierter, durch Sitzungs-Prozess-
  Churn ausgelöster verwaister Registry-Eintrag löste den Fallback-Pfad
  tatsächlich aus (Log-Zeile "falling back to black") — der Switcher blieb
  am Leben und lieferte danach mit dem korrigierten Quellenstand normal
  weiter, **live beobachtet**, kein rein hypothetischer Test.

C7 damit abgeschlossen. Alle vier Testprozesse (Orchestrator, 2×
`omp-source`, `omp-switcher`, `omp-viewer`) am Sitzungsende beendet;
`mxl-info -g` räumt testbedingte verwaiste Flows auf; NATS-/NMOS-Registry-
Container bleiben laufen (persistente Dev-Infrastruktur).

## 2026-07-10 — Bugfix (Nutzer gemeldet): Kanten erscheinen im Flow-Editor
erst nach Reload, nicht live

**Gemeldet vom Nutzer:** Beim Zuschauen während der C7-Tests erschien der
neu gestartete `omp-switcher`-Node live in der UI, die per `curl`
gezogenen Kanten (Switcher→Viewer) aber erst nach manuellem Reload.

**Ursache:** `ui/graph/flow-canvas.ts`s SSE-Handler (B4) löst ein
Neuladen des Graphen nur bei `node.added`/`node.updated`/`node.removed`
aus (`registry.Poller`, A5/A6). Für Kanten-Änderungen
(`POST`/`DELETE .../graph/edges`) gab es **kein** SSE-Event — der
Orchestrator kennt Kanten nur als Projektion der IS-05-Active-Endpoints
der Receiver (B1), nicht als eigenes, im Poller beobachtetes
Registry-Objekt. Zog der Nutzer selbst per Drag & Drop eine Kante, sah er
sie trotzdem sofort, weil `#createEdge`/`#removeEdge` nach dem eigenen
POST/DELETE direkt selbst `#fetchAndRender()` aufrufen (rein
client-seitiges Nachziehen, kein Server-Broadcast) — eine von *außen*
erzeugte Kante (anderer Client, Skript, oder wie hier: `curl` während der
Verifikation) blieb im offenen Tab unsichtbar, bis zufällig ein
Node-Event oder ein manueller Reload den Graphen neu lud. Bestehende
Lücke aus B4 (dort nur Health/Tally/Node-Erscheinen als Live-Kriterium
spezifiziert), keine Regression aus C7 — durch C6/C7s programmatische
Kantenerzeugung (nicht nur Drag & Drop) aber deutlich sichtbarer
geworden.

**Fix:**
- `orchestrator/internal/graph`: neues `EventPublisher`-Interface
  (`Broadcast(sse.Event)`, implementiert von `*sse.Hub` — optional, darf
  `nil` sein, gleiches Muster wie `registry.Poller.OnChange`).
  `Service.Connect`/`Disconnect` publizieren nach erfolgreichem
  IS-05-PATCH `"edge.added"`/`"edge.removed"` (Payload nur `{"id":
  <receiverId>}` — die UI reagiert ohnehin mit vollem `GET /api/v1/graph`,
  der Event-Inhalt ist nur Trigger, keine Datenquelle, analog zu den
  bestehenden Node-Events).
- `orchestrator/main.go`: `graph.NewService(store, is05.NewClient(nil),
  hub)` — Hub wird jetzt auch hier verdrahtet.
- `ui/graph/flow-canvas.ts`: `NODE_INVENTORY_EVENT_TYPES` →
  `GRAPH_REFRESH_EVENT_TYPES`, um `edge.added`/`edge.removed` erweitert.
- Neue Tests (`graph_test.go`, `fakeEventPublisher`): Connect/Disconnect
  publizieren die passenden Events, ein fehlgeschlagenes `Connect`
  (`ErrUnknownReceiver`) publiziert nichts.

**Verifiziert:**
- `go build ./... && go vet ./... && go test ./...` (Orchestrator) grün,
  `deno check ui/**/*.ts && deno test ui/` grün, `make ui` (Neubau von
  `ui/dist/flow-canvas.js` — Browser führt kein `.ts` aus, siehe
  Makefile) ausgeführt.
- End-to-end: zwei Mock-Nodes (`nodes/mock`, echte IS-05-Receiver-
  Connection-API) + Orchestrator gestartet, SSE-Stream per `curl -N`
  mitgeschnitten, Kante per `curl` (nicht per Browser) gezogen und wieder
  getrennt — Stream zeigt `{"type":"edge.added","data":{"id":"..."}}`
  bzw. `"edge.removed"` **tatsächlich live**, keine Annahme.

Kein eigener UMSETZUNG.md-Schritt — Bugfix an bereits abgeschlossenem B4/
B1, gemeldet und freigegeben vom Nutzer während der C7-Sitzung. Test-
Mock-Nodes und Orchestrator-Testprozess am Ende beendet; NATS-/
NMOS-Registry-Container bleiben laufen.

## 2026-07-10 — C8 (Instanz-Launcher): GUI-Launch der MXL-Demo-Trias,
zwei echte Bugs beim Verifizieren gefunden

**Ziel erreicht:** Die drei Demo-Services (und jeder künftige Katalog-
Eintrag) lassen sich aus der GUI heraus starten/stoppen, mehrfach
instanziierbar, ohne Terminal (`ARCHITECTURE.md` §6.2 Stufe 0).

**Umsetzung (wie spezifiziert, keine Abweichungen):**
- `deploy/catalog.json`: `{type, label, runner, command[], env{}}` für
  `omp-source`/`omp-switcher`/`omp-viewer`; `runner` immer `"process"`
  (Feld nach ARCHITECTURE.md §6.2 bewusst schon vorhanden, nur dieser
  eine Wert unterstützt).
- `orchestrator/internal/launcher` (neues Paket): `LoadCatalog`,
  `Launcher.Start/Stop/List/Catalog`. Start spawnt `os/exec`-Subprozess
  mit `OMP_INSTANCE_ID`/`OMP_LABEL`/`OMP_PORT=0`/Registry-/NATS-URLs
  (immer Vorrang vor geerbter/Katalog-`env`, als Map gemergt statt
  Slice, um doppelte `envp`-Keys zu vermeiden). Stop: SIGTERM, 3s Grace
  (Polling alle 100ms), danach SIGKILL. Persistenz `{id,type,pid}` unter
  `<dataDir>/instances.json`; `New()` prüft jede geladene PID per Signal
  0 und verwirft tote Einträge — ein Orchestrator-Neustart erkennt noch
  laufende Kind-Prozesse wieder (jetzt als Waisen, von init reparented,
  aber weiterhin per PID signalisierbar).
- `omp-node-sdk`: `server::spawn` bindet bei Port 0 einen freien Port
  und liefert ihn zurück; `node::start` registriert mit dem
  *tatsächlichen* Port, nicht dem angefragten — macht `OMP_PORT=0`
  praktikabel für Multi-Instanz. Neuer IS-04-Node-Tag
  `urn:x-omp:instance` (Konstante `is04::INSTANCE_TAG`) aus
  `NodeConfig.instance_id`. `omp-viewer`s zweiter Preview-Port
  (`OMP_VIEWER_PREVIEW_PORT`) auf denselben Port-0-Mechanismus
  umgestellt (Default jetzt `"0"` statt `"9341"`) — sonst hätten sich
  mehrere vom Launcher gestartete Viewer einen festen Port geteilt;
  `previewUrl` macht den tatsächlichen Port ohnehin schon dynamisch
  sichtbar, ein fester Default hatte keinen Mehrwert mehr.
- Orchestrator-API: `GET /api/v1/catalog`, `GET/POST /api/v1/instances`,
  `DELETE /api/v1/instances/{id}` (`internal/httpapi/launcher_handlers.go`).
  `registry.NodeView`/`graph.Node` bekommen `InstanceID` (aus dem IS-04-
  Tag) für die UI.
- UI (`flow-canvas.ts`): linke Katalog-Palette (`GET /api/v1/catalog` +
  Start-Button pro Typ) sowie ein Stop-Control (⏹) an Kacheln mit
  `instanceId`. Der Launcher fasst den Graphen selbst nicht an —
  Instanzen erscheinen über die normale Selbstregistrierung (bestätigt:
  kein SSE-/Graph-Sonderfall nötig, `edge.added`/`node.added` aus den
  vorherigen Schritten reichen).

**Bug 1 (gefunden + behoben): Kacheln stapelten sich auf derselben
Default-Position, wenn mehrere Instanzen kurz hintereinander erscheinen.**
`ui/graph/flow-canvas.ts#assignMissingPositions` berechnete den Index für
`defaultPosition(index)` aus der Position eines Nodes *innerhalb des
aktuellen `/api/v1/graph`-Antwort-Arrays* — dessen Reihenfolge ist nicht
stabil (nmos-cpps Query-API sortiert praktisch nach letzter Aktivität,
nicht nach Registrierungsreihenfolge). Erscheint jede neue Instanz in
einem eigenen `#fetchAndRender()`-Lauf (typisch beim Instanz-Launcher:
Nodes registrieren nacheinander, nicht im selben Batch), ist der jeweils
einzige neue Eintrag in diesem Lauf fast immer der zuletzt aktive und
landet dadurch bei Index 0 — vier per GUI gestartete Instanzen stapelten
sich beobachtbar alle auf `(40,40)`. **Fix:** Index startet bei
`Object.keys(this.#positions).length` (Gesamtzahl bereits bekannter
Positionen), nicht bei 0 pro Aufruf — monoton wachsend über beliebig viele
getrennte Aufrufe hinweg, keine Kollision mehr möglich. Zusätzlich
`#fetchAndRender()`-Aufrufe über eine Promise-Kette (`#renderQueue`,
`#queueFetchAndRender()`) serialisiert, um echte Überlappung bei sehr
dicht aufeinanderfolgenden SSE-Events strukturell auszuschließen (war im
konkreten Fall nicht die Ursache, aber ein reales Risiko für dieselbe
Symptomatik). Zusätzlich musste die SVG-Zeichenfläche selbst um die
Breite der neuen Palette (160px) nach rechts versetzt werden
(`svg.style.left`), sonst landeten frisch platzierte Kacheln (nahe world
x=0) optisch unter der Palette. Gefunden und verifiziert per
Chromium-Headless (CDP, `/tmp/.../scratchpad/cdp.mjs`), echte
Browser-Klicks und -Drags, nicht nur curl-Simulation.

**Bug 2 (gefunden, tief untersucht, bewusst nicht in diesem Schritt
behoben): MXL-Read-Livelock — `omp-viewer` empfängt nach einer Quellwahl
manchmal dauerhaft keine neuen Frames mehr, ein Thread bleibt bei ~100%
CPU.** Kein C8-Regressions-Bug — dieselbe Symptomatik trat bereits
während der C7-Verifikation auf (dort als vermeintlich "session-bedingt,
durch `mxl-info -g` behoben" fehlgedeutet; C8 hat gezeigt, dass es
reproduzierbar ist).

*Diagnose (Sub-Agent-Recherche gegen den vendorten MXL-C++-Quellcode
unter `third_party/mxl`, nicht geraten):* "Grain count"/"Commit batch
size"/"Sync batch size" haben nichts mit dem Symptom zu tun (Batch-Size-
Hints sind reine Metadaten, `PosixDiscreteFlowWriter::commit()`
committet unbedingt bei jedem Aufruf). Der tatsächliche Root Cause ist
ein TOCTOU-Fenster in `waitUntilChanged` (`lib/internal/src/Sync.cpp`):
liest der Code den Sync-Zähler, bevor er den Futex-Wait betritt, und
committet der Writer in genau diesem Fenster erneut, kehrt der Aufruf
mit "Bedingung erfüllt" zurück, *ohne* je zu warten — `getGrain`s eigene
`while(true)`-Schleife (C++-intern, nicht die Rust-Schleife) ruft darauf
sofort erneut `getGrainImpl` auf. Per `/proc/<pid>/task/*/stat`
verifiziert: ein Thread bei durchgehend ~100% CPU, "Last read time" des
betroffenen Flows friert dauerhaft ein (in einem Testlauf >230s,
selbstheilt nicht).

*Versuchter Fix (nicht ausreichend, aber beibehalten):*
`nodes/omp-mediaio/src/mxl.rs`s `read_loop` bekam einen 5ms-Backoff im
`Timeout`/`OutOfRangeTooEarly`-Zweig — **behebt den beobachteten
Extremfall nicht**, weil die Retry-Schleife des Livelocks *innerhalb*
des einzelnen `get_complete_grain`-FFI-Aufrufs liegt (C++-eigenes
`while(true)`), die Kontrolle in diesem Fall über Minuten hinweg gar
nicht zu Rust zurückkehrt und der Sleep folglich nie erreicht wird
(empirisch bestätigt: CPU-Last unverändert ~100% nach dem Fix). Bleibt
trotzdem im Code, weil er den milderen Fall (Aufruf kehrt normal mit
einem Fehler zurück) korrekt entschärft.

*Offen für eine künftige Sitzung* (nicht C8-Scope — betrifft
`omp-mediaio`, gebaut in C4, von C5/C6/C7 mitgenutzt): entweder (a) Patch
im vendorten MXL-C++ (Sync.cpp; Risiko: `third_party/mxl` ist
gitignored/wird per `install-mxl.sh` neu geklont, ein Patch bräuchte
einen eigenen Anwendungsschritt im Install-Skript), oder (b) Rust-seitige
Umgehung — z. B. für den Preview-Anwendungsfall (der keine strikt
sequenzielle Zustellung braucht) regelmäßig das *neueste* verfügbare
Grain pollen statt einen exakten fortlaufenden Index zu verlangen, was
den betroffenen Codepfad in `getGrainImpl` eventuell ganz umgeht. Bis
dahin: Symptom ist intermittierend (nicht bei jeder Quellwahl), C6/C7s
eigene Verifikationen zeigten bereits erfolgreiche Bild-Zustellung unter
denselben Umständen — die MXL-Demo-Trias ist nicht durchgehend defekt,
nur nicht 100% zuverlässig.

**Verifiziert (End-to-End, komplett über echte Browser-Interaktion, kein
curl-Ersatz für die GUI-Schritte selbst):** Chromium Headless über das
Chrome-DevTools-Protokoll (rohe WebSocket-JSON-RPC über Node.js' native
`fetch`/`WebSocket`, kein Playwright/Puppeteer verfügbar/installiert;
Skript unter `/tmp/.../scratchpad/cdp.mjs`, nicht Teil des Repos).
- `cargo build/clippy/fmt/test --workspace`, `cargo deny check`, `go
  build/vet/test ./...`, `deno check`/`deno test` grün; `make ui`
  (Bundle neu gebaut), `make nodes` (neuer Target, baut alle
  Katalog-Binaries).
- Echter Button-Klick (`.click()` auf das tatsächliche DOM-Element, nicht
  simulierter Fetch) auf "+ Source" → Subprozess startet, registriert
  sich, erscheint im Graph; Stop-Klick (⏹) → Prozess sauber beendet,
  verschwindet aus `/api/v1/instances`.
- Komplette Trias (2× Source, 1× Switcher, 1× Viewer) nur per
  Palette-Klicks gestartet; Switcher→Viewer-Kante per echtem simuliertem
  Maus-Drag (`Input.dispatchMouseEvent`-Sequenz auf die tatsächlichen
  SVG-Port-Koordinaten) gezogen, serverseitig als aktive Kante bestätigt.
  Switcher-Kachel angeklickt → eigenes UI-Bundle (C7) öffnet sich korrekt
  eingebettet in der Palette-erweiterten Shell; Quellwahl-Button-Klick →
  `activeInput` ändert sich nachweisbar.
- Orchestrator-Prozess während laufender Instanzen hart beendet (`kill
  -9`) und neu gestartet: Instanz bleibt am Leben (jetzt von init
  reparented), erscheint weiter in `/api/v1/instances`
  (`instances.json`-Persistenz + PID-Check bestätigt), lässt sich
  danach weiterhin sauber stoppen.
- Alle vier GUI-gestarteten Instanzen am Ende per echtem Stop-Klick
  beendet; Chromium/Orchestrator-Testprozess beendet, `mxl-info -g`
  räumt testbedingte verwaiste Flows auf; NATS-/NMOS-Registry-Container
  bleiben laufen (persistente Dev-Infrastruktur).

C8 damit funktional abgeschlossen; der MXL-Read-Livelock (Bug 2) bleibt
als bekanntes, dokumentiertes, nicht C8-eigenes Problem offen.

## 2026-07-10 — C9 (Contract-Konformitätstest): `tools/contract-check`,
zwei weitere echte Bugs gefunden (Host-Matching + omp-source-Roundtrip)

**Ziel erreicht:** Der Node-Contract (`ARCHITECTURE.md` §5) ist jetzt
maschinell prüfbar — `tools/contract-check` (eigenständiges drittes
Go-Modul neben `orchestrator`/`nodes/mock`, kein `go.work`, dieselbe
Praxis wie die bestehenden zwei Module) prüft gegen einen laufenden Node:

1. **IS-04-Registrierung**: Query-API der Registry nach einem Node
   durchsucht, dessen `api.endpoints`-Host:Port zu `NODE_URL` passt (wie
   `orchestrator/internal/registry.apiBaseURL`, nur umgekehrt) — kein
   Node-Typ-Sonderwissen.
2. **Descriptor-Schema**: `GET /descriptor.json` gegen
   `docs/descriptor-v0.schema.json` validiert, per
   `github.com/santhosh-tekuri/jsonschema/v6` — bewusst dieselbe
   Dependency wie `nodes/mock/internal/descriptor/schema_test.go` (A9),
   keine neue Bibliotheksentscheidung nötig.
3. **Param-Roundtrip**: ersten beschreibbaren Parameter im Descriptor
   PATCHt (Testwert je nach Typ synthetisiert, bei `number`/`enum` unter
   Beachtung von `range`), GET danach muss denselben Wert liefern. Kein
   beschreibbarer Parameter vorhanden (omp-viewer, omp-switcher, Playout
   haben nur readonly-Parameter) → SKIP, nicht FAIL — sonst wäre "grün
   für alle fünf Node-Typen" (Verifikationskriterium) unerfüllbar.
4. **UI-Manifest** (optional laut §5 Punkt 3): fehlt `/ui/manifest.json`
   (404) → SKIP; vorhanden → `tag`-Feld + `/ui/bundle.js` müssen beide
   valide sein.
5. **IS-05 (informativ, nie FAIL)**: pro deklariertem Sender/Receiver
   wird `.../staged` abgefragt und als "vorhanden"/"nicht implementiert"
   reportet, geht aber nie in den Gesamt-Status ein — der aktuelle
   Node-Fleet ist hier bewusst uneinheitlich (`omp-source`/`omp-switcher`
   haben trotz deklarierter Sender **kein** IS-05 implementiert, siehe
   C3/C5/C7; ein hartes "IS-05 vorhanden"-Kriterium wäre für zwei der
   fünf Zieltypen unerfüllbar gewesen). Diese Interpretation der
   Anweisung ("optional UI-Manifest, IS-05 vorhanden") ist eine bewusste
   Auslegungsentscheidung, keine geratene — dokumentiert statt still
   angenommen (§0.8).

**`make contract NODE_URL=…`** neues Makefile-Target;
`OMP_REGISTRY_URL` optional (Default `http://localhost:8010`), bewusst
nicht vom Makefile-Target selbst gesetzt (Gefahr, einen leeren Wert zu
exportieren und den Go-seitigen Fallback zu überschreiben), sondern vom
Aufrufer vor `make contract` exportiert, falls gebraucht.

**Beim Verifizieren zwei weitere echte Bugs gefunden** (nicht in
`tools/contract-check` selbst, sondern von ihm aufgedeckt — genau der
Zweck des Tools):

1. **contract-check-Bug (eigener Code, sofort behoben):**
   `findNodeByURL` verglich Hosts als reine Strings — ein Node
   registriert sich mit `OMP_HOST=127.0.0.1` (Default), ein Nutzer tippt
   für `NODE_URL` aber naheliegend `localhost`; beides wurde als
   unterschiedlich behandelt, jeder Check schlug mit "kein Node ...
   gefunden" fehl. Fix: `hostsMatch` löst beide Seiten per
   `net.LookupIP`/`net.ParseIP` auf und vergleicht die tatsächlichen
   Adressen, Fallback auf String-Vergleich nur falls Auflösung
   fehlschlägt.
2. **omp-source-Bug (vorbestehend seit C5, von contract-check
   aufgedeckt):** `SourceStore::get()` kannte den Parameter `"pattern"`
   nicht (nur `set()` war implementiert) — `PATCH /params/pattern` gab
   200 zurück (setzte die GStreamer-Property korrekt), ein
   anschließendes `GET /params/pattern` lieferte aber 404. Verletzt den
   generischen Parameter-Proxy-Vertrag (A8: `GET|PATCH
   /api/v1/nodes/<id>/params/<name>` symmetrisch für jeden
   nicht-readonly Parameter). Fix: aktueller Pattern-Wert zusätzlich in
   `Arc<Mutex<String>>` nachgehalten (gleiches Muster wie `fps`),
   `get()` liefert ihn jetzt zurück.

**CI-Scope bewusst nicht vollständig umgesetzt** (§0.8, keine stille
Lücke): Die Anweisung nennt "In CI für Mock-, Playout-, omp-source-,
omp-viewer- und omp-switcher-Node ausführen". Drei der fünf Typen
(omp-source/omp-viewer/omp-switcher) brauchen zur Laufzeit `libmxl.so`
(dlopen, `omp-mediaio`-Feature `mxl`) — ein `install-mxl.sh`-Lauf in
GitHub-Actions-CI wäre ein mehrminütiger, neuer Infrastruktur-Baustein
(vcpkg-Bootstrap + volle C++-Kompilation), und selbst Mock/Playout
bräuchten laufende NATS-/Registry-Container in CI, die der bestehende
`ci.yml`-Workflow aktuell gar nicht startet. Exakt dieselbe fehlende
Infrastruktur ("laufende Registry-/Node-Container") wurde beim
AMWA-NMOS-Testing-Tool-Platzhalter bereits explizit auf D2 verschoben
(`.github/workflows/ci.yml`, "Platzhalter für Schritt D2") — C9s
CI-Wiring folgt konsistent derselben Verschiebung, statt sie in dieser
Sitzung halbfertig nachzubauen. Stattdessen: `tools/contract-check`
selbst vollständig mit `httptest`-Fakes getestet (`go test ./...` grün,
Teil von `make check`/`make ci`), und **alle fünf Node-Typen manuell
gegen echte, lokal laufende Instanzen verifiziert** (nächster Absatz) —
das erfüllt das wörtliche Verifikationskriterium ("`make contract
NODE_URL=…` grün für alle fünf Node-Typen"), auch ohne GitHub-Actions-
Integration.

**Verifiziert:**
- `cargo build/clippy/fmt/test --workspace`, `cargo deny check`, `go
  build/vet/test ./...` (jetzt 3 Module: `orchestrator`, `nodes/mock`,
  `tools/contract-check`), `deno check`/`deno test` grün (`make check`).
- `tools/contract-check`s eigene Testsuite (`httptest`-Fakes, kein
  echter Node/Registry nötig): valider Node → alle Checks PASS/SKIP wie
  erwartet; unregistrierter Node → IS-04-Check FAIL; Node ohne
  beschreibbaren Parameter → Param-Roundtrip SKIP; **absichtlich
  kaputter Descriptor (ungültiger `type`-Wert) → Descriptor-Schema FAIL
  mit klarer, auf das Feld zeigender Meldung** (deckt
  UMSETZUNG.md C9s explizite Negativ-Verifikation ab); IS-05 fehlend →
  informativ "nicht implementiert", Gesamtstatus bleibt PASS.
- Alle fünf echten Node-Typen gleichzeitig gestartet (Mock, Playout,
  omp-source, omp-viewer, omp-switcher) und einzeln per `make contract
  NODE_URL=…` geprüft — **alle fünf grün** (Exit-Code 0), inkl. der
  beiden oben beschriebenen Fixes, die dafür nötig waren.

C9 damit abgeschlossen. **Meilenstein „Demo 2" erreicht**: Test-Quellen,
Switcher und Viewer werden aus der GUI gestartet, per MXL Zero-Copy
verschaltet und live geschaltet (Bug aus C8, MXL-Read-Livelock,
weiterhin offen — intermittierend, kein Totalausfall) — der Node-
Contract ist ab jetzt maschinell geprüft, Grundstein für Community-
Nodes. Testprozesse (Mock/Playout/omp-source/omp-viewer/omp-switcher der
eigenen Verifikation) am Ende beendet — laufende Instanzen aus einer
parallelen Nutzer-Sitzung (GUI-gestartete Viewer/Switcher-Instanzen)
bewusst nicht angetastet; NATS-/NMOS-Registry-Container bleiben laufen.

## 2026-07-10 — Architektur-Review (Fable): sieben Nutzeranforderungen
gegen ARCHITECTURE.md geprüft und eingeordnet

**Kontext:** Der Nutzer nannte sieben Anforderungen/Fragen (teils
erwartete Dopplungen zu bereits behandelten Themen). Jede wurde gegen den
aktuellen Stand von `ARCHITECTURE.md`/`UMSETZUNG.md`/diesem Log geprüft
(Duplikat / Erweiterung / neu) und `ARCHITECTURE.md` entsprechend
fortgeschrieben — reine Doku-Arbeit, kein Code, keine Änderung an den
`UMSETZUNG.md`-Schritten (nur die §7-Phasenplan-Tabelle in
ARCHITECTURE.md, wie schon bei §6.1/§6.2 praktiziert):

1. **User-Management (lokal + AD, Rollen mit Workflow-Scope): neu** —
   IS-10/mTLS (§2/§4.6, D3) ist Client-/Node-Auth, kein Nutzer-/
   Rollen-/AD-Modell. Neuer Abschnitt **§12**.
2. **OGraf-Microservice: Konflikt mit P4-Scope, aufgelöst als explizite
   Aufwertung** — P4 sagte „Minimal-Grafik-Node (kein volles OGraf
   nötig)". Neuer Abschnitt **§11.2** (vollwertiger OGraf-Node als
   Referenzknoten nach §11.1-Methodik, Know-how-Transfer aus
   PIPELINE CONTROLLERs GrafixEngine/Grafik-API/OGraf-Templates,
   manuell ab Tag 1, Playout-Steuerung später über dieselben
   IS-12/14-Methoden), P4-Zeile in §7 angepasst.
3. **Regieplatz-Definition (vorab konfigurieren, manuell/zeitgesteuert
   starten/stoppen, Stop-Bestätigung, Ressourcen-Vorprüfung):
   größtenteils Duplikat des Workflow-Objekts, drei echte Lücken** —
   Scheduler, `confirm_stop`, Placement als harte Start-Vorbedingung.
   Als **Erweiterung in §6.2** ergänzt (Umsetzung D7, unverändert
   sequenziert).
4. **DeckLink-/SDI-IP-Karten als zuweisbare Ressource: Erweiterung von
   §6.1** — Telemetrie/Placement kannte nur CPU/RAM/GPU/NIC; jetzt
   Geräte-Inventar + Claim/Release für diskrete, exklusive Ressourcen +
   Migrations-Grenze („nicht migrierbar ohne äquivalente Karte" als
   ehrlicher Befund).
5. **Reaktives Failover (Service stirbt ≠ Workflow stirbt): neu** —
   §6.1 ist explizit proaktiv, 2022-7 nur Netzpfad. Neuer Abschnitt
   **§6.3** (Erkennung via bestehender Health-Staleness + media-flowing,
   Restart-in-place, Degradation nach dem gelebten C7-Schwarzbild-Muster
   als SDK-Leitlinie, Hot-Standby N+1 pro Workflow-Rolle;
   break-before-make ehrlich benannt).
6. **Microservices über die UI installieren/versionieren/entfernen:
   neu** — Angebotsform OCI-Images + Registry (bestehender
   Podman/k3s-Stack, `runner`-Feld aus §6.2 Stufe 0), Digest-Pinning,
   Signaturpflicht (Vertrauensanker bewusst getrennt von step-ca),
   contract-check (C9) als Aufnahme-Gate. Neuer Abschnitt **§6.4**.
7. **Gesamtziel Sendezentrum (mehrere Regieplätze, 24/7- vs. temporäre
   Sendeabwicklungen, Redundanz): Zusammenfassung der Punkte 3–5 plus
   §1-Vision** — als „Zielbild"-Absatz in **§1** verankert
   (Redundanz-Klassen nur angedeutet, Ausarbeitung P2/P3).

§7-P2-Zeile um §6.3/§6.4/§12 ergänzt; §11-Intro („keine offenen
Grundsatzentscheidungen mehr") korrigiert — es gibt jetzt drei (Lizenz
aus C1 plus die zwei folgenden).

**Entschieden (2026-07-10): Identitätslösung für §12 — Option (c),
eigenes Minimal-User-Management + direkter LDAP-Bind.**
- *Problem war:* IS-10 braucht eine OAuth2-Token-Ausstellung, die lokale
  Konten **und** AD/LDAP bedient. Ein ausgewachsener Identity Provider
  wäre der schwerste Fremdbaustein des gesamten Stacks.
- *Verworfene Optionen:* (a) Voll-IdP einbetten (Keycloak o. ä.) — alles
  fertig (OIDC, LDAP-Federation, UI), aber Java-Runtime/Betriebsgewicht,
  klarer Bruch mit der Ein-Binary-Linie; (b) schlanker Go-Ein-Binary-IdP
  (z. B. Dex/ZITADEL-Klasse) — OIDC + LDAP-Connector bei moderatem
  Gewicht, aber ein zusätzlicher Prozess/Fremd-Betriebsteil, den der
  Nutzer für den heutigen Ein-Kanal-/Kleinst-Sendezentrum-Scope nicht
  will.
- *Entschieden:* Nutzer/Gruppen im Orchestrator selbst (PostgreSQL,
  §4.4) verwalten, direkter LDAP(S)-Bind gegen AD für die
  Verzeichnis-Anbindung, Token-Ausstellung IS-10-konform (OAuth2) vom
  Orchestrator selbst. Kleinster Fußabdruck, passt zur
  Ein-Binary-Linie des gesamten Stacks — im Gegenzug trägt der
  Orchestrator die volle Verantwortung für sicherheitskritischen Code
  (Passwort-Hashing, Token-Ausstellung/-Widerruf); das ist bei D3
  entsprechend sorgfältig zu implementieren (etablierte Bibliotheken
  für Hashing/JWT nutzen, nicht selbst kryptografisch entwerfen).
  Rückfallebene (b) bleibt gedanklich offen, falls bei der
  D3-Umsetzung echte OIDC-Föderationsbedürfnisse (mehrere externe
  Identitätsquellen, SSO über OMP hinaus) sichtbar werden — dann neu
  bewerten, kein Automatismus.

**Entschieden (2026-07-10): Render-Technik des OGraf-Nodes (§11.2) —
Option (b), GStreamer `wpesrc` (WPE WebKit), zuerst per Praxistest
verifizieren.**
- *Problem war:* OGraf-Templates sind Web-Tech (HTML/JS/Custom
  Elements) — irgendein Browser-Renderer muss Frames in die
  GStreamer-Pipeline liefern.
- *Verworfene/zurückgestellte Option:* (a) Headless-Chromium als
  Begleitprozess — exakt das in PIPELINE CONTROLLER produktiv bewährte
  Muster (GrafixEngine: Screenshots → appsrc), volle
  Web-Kompatibilität, aber die dickste denkbare Dependency; bleibt
  **Fallback**, falls (b) an den vorhandenen Templates scheitert.
- *Entschieden:* `wpesrc` zuerst — rendert nativ als Pipeline-Element
  mit echtem Alpha-Kanal, deutlich schlanker und näher an der
  GStreamer-Linie (4.1a) als ein separater Chromium-Prozess. Risiko
  bewusst eingegangen: WebKit- statt Chromium-Engine kann bei
  einzelnen der ~45 vorhandenen PIPELINE-CONTROLLER-Templates
  inkompatibel sein (Custom-Element-/CSS-Eigenheiten). Verifikation
  bei P4-Beginn: alle vorhandenen Templates gegen `wpesrc` durchtesten,
  bevor der OGraf-Node darauf festgelegt wird; bei Scheitern einzelner
  Templates erst Template-seitig fixen (meist Web-Standard-Cross-Browser-
  Aufwand), erst wenn das nicht reicht auf (a) zurückfallen — kein
  Blind-Commit ohne diesen Test.

## 2026-07-11 — Architektur-Review: acht Nutzerfragen zum Regieplatz
(Bildmischer, Audiomischer, Bedienoberflächen, Hardware-Panels, Latenz,
Kapazitätsplanung) gegen ARCHITECTURE.md geprüft und eingeordnet

**Kontext:** Der Nutzer stellte acht zusammenhängende Fragen/Anforderungen
zum Bild eines fertigen Regieplatzes. Jede wurde gegen den aktuellen Stand
von `ARCHITECTURE.md`/`UMSETZUNG.md`/diesem Log geprüft (Duplikat/
Erweiterung/neu) und `ARCHITECTURE.md` entsprechend fortgeschrieben — reine
Doku-Arbeit, kein Code, keine Änderung an den `UMSETZUNG.md`-A–C-Schritten
(nur die §7-Phasenplan-Tabelle in ARCHITECTURE.md, wie schon bei
§6.1–§6.4/§12/§11.2 praktiziert):

1. **„Virtuelles Pult" für Bildmeister/Tonmeister, ohne Workflow editieren
   zu dürfen: größtenteils bereits durch §12 abgedeckt (Rollen-Scope),
   aber keine Antwort, WIE ein reiner Operator dort hinkommt** — neuer
   Abschnitt **§14**: Console-Ansicht der bestehenden Shell, die bei
   `operate`-only-Rollenbindungen direkt auf das/die UI-Bundle(s) der
   zugewiesenen Node-Rolle(n) springt, kein Graph sichtbar, kiosk-fähige
   Route pro Node-Rolle. Kein neuer Node-Contract-Punkt (Rollen bleiben
   orchestrator-seitig durchgesetzt, wie in §12 Punkt 3 bereits
   festgelegt).
2. **Bildmischer: ein Node oder Switcher+DVE+Keyer+Freeze als separate
   Nodes: neu, Grundsatzentscheidung** — neuer Abschnitt **§13.1**:
   entschieden **ein Prozess pro M/E-Bank**, DVE/Keyer/Still als
   `NcWorker` im selben `NcBlock` (§11.1-Methodik), nicht als separate
   MXL-verkettete Nodes — Begründung: jeder MXL-Hop ist ein zusätzlicher
   Latenz-/Ausfall-Posten für eine im Sendebetrieb atomar erlebte
   Operation (Crosspoint+DVE+Keyer gleichzeitig in einer Transition).
   Skalierung „mehrere Ebenen" = mehrere Node-**Instanzen**, nicht mehr
   `NcWorker` pro Prozess.
3. **Audiomischpult mit dynamischer Kanalzahl + Audio-Follow-Video: neu**
   — neuer Abschnitt **§13.2**: ein Node pro Konsole (gleiche
   Latenz-/Kopplungs-Begründung wie beim Bildmischer),
   `addChannel()`/`removeChannel()` machen die Kanalzahl zur
   Laufzeit-Eigenschaft, Audio-Follow-Video hängt sich an den
   **bestehenden** Tally-NATS-Bus (B4) des gekoppelten Videomixer-Node —
   kein neuer Sync-Mechanismus.
4. **Musik-/Jingle-Player, Videoplayer: neu, aber Wiederverwendung von
   C10/C11 statt drei neuer Node-Typen** — neuer Abschnitt **§13.3**:
   ein gemeinsames Crate `omp-player` (Verallgemeinerung des geplanten
   Playout-`PlaylistController`), Unterschied nur UI-Bundle-Variante +
   Default-Konfigurationsprofil + Katalog-Rolle. Hinweis für die
   spätere C10/C11-Detaillierung vermerkt, `UMSETZUNG.md` selbst nicht
   geändert.
5. **Live-Quellen: Duplikat, bereits abgedeckt** — kurzer Abschnitt
   **§13.4** bestätigt nur die bestehende Antwort (NMOS-Fremdgeräte /
   Ingest-Node über §6.1-I/O-Karten-Ressource), keine neue Idee.
6. **Microservice-Katalog in Kategorien (Input/Output/Audio/Video/Daten):
   additive Erweiterung von §6.2/§6.4** — neuer Abschnitt **§13.5**: Feld
   `category` im Katalog-Descriptor, rein UI-Gruppierung, kein Pflichtfeld,
   robust gegen ältere Einträge ohne das Feld.
7. **Würde ein physisches Grass-Valley-„Connected Switcher"-Bedienpult
   (Hardware) mit OMP funktionieren: neu, per Websuche recherchiert statt
   geraten** — neuer Abschnitt **§15**: Signal-/Routing-Ebene (GV
   K-Frame/AMPP Edge unterstützen laut Datenblättern NMOS IS-04/IS-05)
   funktioniert bereits heute ohne Adapter; die Panel→Engine-Steuerebene
   selbst ist proprietäres GV-Protokoll, nirgends offen dokumentiert
   gefunden (Indiz: auch die Bitfocus-Companion-Community listet
   GV-Switcher-Steuerung nur als offenen Wunsch, kein fertiger offener
   Adapter) — direkte Panel-Steuerung eines OMP-Mixers also **nicht** ohne
   GV-seitige SDK-Freigabe möglich. Konsequenz für §13.1: die
   IS-12/14-Methoden des Videomixers bleiben generisch genug, dass jeder
   künftige Adapter-Node (GV oder günstigere Alternativen) sie wie ein
   UI-Bundle-Klick aufrufen kann — Anwendung des bereits in §9 genannten
   Adapter-Node-Musters, keine neue Idee. Quellen in §15 verlinkt.
8. **A/V/Daten-Synchronität unabhängig von der Node-Kette, AMPP-Vorbild
   „5 Frames Zielband": komplett neu, größte fehlende Fähigkeit** — neuer
   Abschnitt **§16**: Per-Node-Latenzdeklaration im Descriptor (additiv,
   Empfehlung Richtung SDK v1, kein Zwang vor dem Freeze), Workflow-Feld
   `targetLatencyFrames`, Budget-Rechnung als Teil der bestehenden
   Ressourcen-Vorprüfung (§6.2 Punkt 3), Delay-Ausgleich per
   `setOutputDelay()`, PTP- vs. Grain-Sequenznummer-Referenz sauber nach
   Deployment-Stufe getrennt (gleiche Unterscheidung wie die C4-offene
   Timestamp-Frage, hier auf Workflow-Ebene hochskaliert), Audio-/
   Daten-Pfade separat vom Video-Budget gerechnet, Audio-Follow-Video
   (§13.2) als verwandtes, aber anderes Problem klar abgegrenzt.

Zusätzlich zwei vom Nutzer mitgenannte, aber bereits ganz oder größtenteils
vorhandene Punkte als Erweiterungen statt neuer Abschnitte eingeordnet:

9. **Zeitliche Ressourcenplanung „geht sich das aus" über mehrere geplante
   Regieplätze hinweg: Erweiterung von §6.2** (der Einzelstart-Check dort
   deckt nur „jetzt", nicht die vorausschauende Mehr-Workflow-Sicht) —
   neuer Abschnitt **§17**: Vorschau-API `GET /api/v1/capacity`, simuliert
   Claim/Release-Zeitstrahl mehrerer geplanter Workflows über die
   bestehende Placement-Engine, Kalender-UI mit Konflikt-Markierung.
   Bewusst **keine** Reservierungssperre — nur Frühwarnung, der scharfe
   Check bleibt der bestehende Start-Zeitpunkt-Mechanismus.
10. **Detaillierter Monitoring-Plan: Bündelung bestehender Bausteine +
    eine konkrete neue Stellschraube** — neuer Abschnitt **§18**: knüpft an
    die bereits am 2026-07-09 geäußerte Priorität „frame-genaues
    Monitoring ist Kernaufgabe" an; macht den bisher globalen
    Health-Staleness-Schwellwert (§6.3, 10 s) **pro Workflow-Rolle
    konfigurierbar**, damit On-Air-kritische Rollen schneller erkannt
    werden können (Kompromiss mit NATS-Traffic ehrlich benannt). Zwei
    Dashboard-Sichten (Engineering vollständig, Operator-Console
    scope-beschränkt) als reine Zusammensetzung vorhandener Bausteine.

§7-P2-Zeile um §14/§16/§18 ergänzt, §7-P4-Zeile um §13/§17 ergänzt — sonst
keine Änderung an bestehenden Abschnitten außer einem einzeiligen
Cross-Reference-Hinweis in §6.2 (Katalog-`category`-Feld zeigt auf §13.5).

## 2026-07-11 — Vier weitere Nutzerfragen: Resequenzierung, Zeitplan-
Realitätscheck, Remote-Host-Erkennung, Orchestrator-Redundanz

**Kontext:** Direkte Folgefrage zum selben Tag. Vier Punkte, dieses Mal mit
echter Rückwirkung auf `UMSETZUNG.md` (nicht nur `ARCHITECTURE.md`), weil
zwei der vier Punkte explizite Reihenfolge-Entscheidungen im Umsetzungsplan
sind (gleiche Kategorie wie „MXL-Timing per Nutzer-Machtwort vorgezogen",
2026-07-09).

1. **Playout-Automation-Demo nach hinten, kleiner Regieplatz zuerst.**
   Begründung des Nutzers („Automatisation wird ohnehin einen Teil davon
   nutzen") deckt sich exakt mit der bereits in §13.1–§13.3 festgelegten
   Regel „dieselben IS-12/14-Methoden, keine zweite API" — Playout vor den
   eigentlichen Regieplatz-Nodes zu bauen hieße, den Aufrufer vor der
   Sache zu bauen, die er aufruft. **`UMSETZUNG.md` Phase C umsortiert:**
   `C10/C11 „Playout v1"` ersetzt durch `C10–C13` (Bildmischer-,
   Audiomischer-, Player-Minimalausbau, Operator-Console — „Demo 3"),
   Playout-Automation-Controller wird zu `C14/C15` („Demo 4"). Der
   C1–C3-RTP-Referenz-Node bleibt unverändert im Repo. Neuer
   `ARCHITECTURE.md`-Abschnitt **§7.4** dokumentiert die Begründung; §2-
   und Status-Tabelle in `UMSETZUNG.md` angepasst.
2. **Zeitplan an bisheriges Tempo anpassen: gemessen statt geschätzt.**
   Git-Log-Zeitstempel zeigen Phase A+B+C(bis C9) in **vier
   Arbeitssitzungen/≈20 Stunden über vier Kalendertage** (2026-07-07 bis
   2026-07-10) statt der in §2 veranschlagten 11–20 Monate — Faktor
   ~20–40×. **Bewusst nicht linear auf alle Restarbeit hochgerechnet**
   (§7.4): Tempo-getriebene Solo-Software-Arbeit (weitere
   Regieplatz-Nodes, Host-Agent-Grundbau, SDK-Doku) plausibel im selben
   Tempo fortsetzbar; extern-getriebene Arbeit (Community-Nodes, echte
   Multi-Host-/2110-Verifikation, echte Sendezentrum-Redundanz) bleibt
   unverändert von Menschen/Hardware begrenzt, nicht von
   Sitzungsgeschwindigkeit — §7.3s Community-Flaschenhals-Aussage gilt
   dadurch stärker, nicht schwächer. §7.1/§7.2-Zeitschätzungen bewusst
   **nicht** umgerechnet, gelten neu als Worst-Case statt Erwartungswert
   — neuer Abschnitt **§7.4**.
3. **Wie erkennt der Server eine entfernte Maschine, um dort
   Nodes/Services zu starten: Detaillierung eines bereits als „noch
   nicht detailliert" angekündigten Bausteins** (§6.1 Punkt 1/§6.2 „ein
   Agent, zwei Verben") — neuer Abschnitt **§19**: eigenständiges Binary
   `omp-host-agent`, Agent-initiiertes Bootstrap („Phone Home" statt
   Server-Scan, funktioniert identisch LAN/VM/WAN), einmaliges
   Bootstrap-Token + step-ca-mTLS-Zertifikatsausgabe als
   Sicherheitsgrenze, Telemetrie/Inventar über den bestehenden
   NATS-Bus, Instanz-Launcher (§6.2 Stufe 0) wird um einen
   Remote-Kommandokanal erweitert statt neu gebaut, klare Abgrenzung zu
   k3s (nur für Bare-Metal/kleine Cluster nötig). Wegen Punkt 2
   (community-unabhängig, selbst testbar) als realistisch früherer
   Baustein eingeordnet als die ursprüngliche P2-Zuordnung — P2-Zeile in
   §7 ergänzt, `UMSETZUNG.md` D6-Bullet verweist jetzt auf §19.
4. **Redundanzkonzept für den Orchestrator selbst: brauchen wir das?**
   — bisher nur als „Bewusstes Nicht-Ziel v1" ohne Begründung/Plan in
   §6.3 vermerkt. Neuer Abschnitt **§20**: **aktuell nein** (Prozess-
   Restart via systemd/Quadlet reicht, weil Nodes bei Orchestrator-
   Ausfall ohnehin weiterlaufen, §4.1 — nur Steuerung fehlt kurz, kein
   Medien-Ausfall), **später ja** für das 24/7-Sendezentrum-Zielbild
   (§1). Skizze für dann: Active-Passive über die ohnehin vorhandene
   Postgres/NATS-Basis, Leader-Wahl per Postgres-Advisory-Lock statt
   neuem Konsens-Tool, NATS-Clustering früh (nativ einfach),
   Postgres-HA bewusst zurückgestellt (eigenes, teures Thema), einzige
   echte neue Fremd-Komponente ist ein schlanker VIP/Proxy vor den
   Instanzen. Kein Umsetzungsschritt jetzt — P3-Anmerkung in §7 ergänzt.

**Keine Änderung an A1–C9 selbst** (bereits erledigt, unverändert gültig).
`UMSETZUNG.md` Phase-C-Fortsetzung (vormals C10/C11) sowie die D6-Notiz
sind die einzigen inhaltlichen Umsetzungsplan-Änderungen; alles andere ist
`ARCHITECTURE.md`-Fortschreibung wie beim 2026-07-10- und ersten
2026-07-11-Review.

## 2026-07-11 — Einfacher Start/Stop für den Orchestrator + Handbuch

**Kontext:** Bisher gab es keinen dokumentierten Weg, den Orchestrator mit
einem Befehl zu starten (nur `go run ./orchestrator` von Hand, aus dem
richtigen Arbeitsverzeichnis heraus, ohne Healthcheck/Log/PID-Verwaltung).
Nutzeranforderung: einfaches Start-Script + ein erstes Handbuch.

- **`deploy/dev/start-omp.sh`** (`make start`): `make up`
  (NATS+Registry) → UI-Bundle bauen → Orchestrator-Binary bauen
  (`bin/omp-orchestrator`) → im Hintergrund starten → auf `/healthz`
  warten. **`deploy/dev/stop-omp.sh`** (`make stop`) stoppt ihn wieder
  (SIGTERM, Fallback SIGKILL nach 5 s), `make status` zeigt den Zustand
  von Orchestrator/NATS/Registry.
- **Bug beim Bauen gefunden und gefixt:** Die erste Fassung startete den
  Prozess über `( cd orchestrator && nohup BIN & echo $! )`, um die
  relativen Config-Defaults (`OMP_UI_DIR=../ui` etc.) aufzulösen. Ein
  backgroundetes `cd X && CMD &` backgroundet aber die **ganze**
  `&&`-Kette in einer Subshell, wodurch `$!` auf deren Wrapper-PID zeigt,
  nicht auf den tatsächlichen Prozess — `make stop` killte damit den
  falschen Prozess, während der eigentliche Orchestrator weiterlief und
  den Port belegt hielt. Gefixt durch **absolute Pfade als Env-Vars**
  (`OMP_UI_DIR`/`OMP_DATA_DIR`/`OMP_CATALOG_PATH`) statt `cd` — kein
  Subshell-Wrapper mehr nötig, `$!` ist jetzt korrekt. Zusätzliche
  Absicherung in beiden Scripts: vor dem Start wird geprüft, ob Port 8000
  bereits antwortet (verwaister Prozess aus einer früheren Sitzung würde
  sonst den Healthcheck des NEUEN, eigentlich fehlgeschlagenen Starts
  „erfolgreich" erscheinen lassen — genau das ist beim Testen passiert
  und wurde erst durch `ss -ltnp` sichtbar).
- **Zweiter, verwandter Bug in `orchestrator/main.go` gefunden und
  gefixt:** `signal.NotifyContext` erzeugte zwar einen bei SIGTERM/
  SIGINT abbrechbaren Context, aber `http.ListenAndServe` lief direkt
  (blockierend) und reagierte nie auf `ctx.Done()` — der Server ließ
  sich also grundsätzlich nur per SIGKILL beenden, nicht per SIGTERM,
  unabhängig vom Start-Script. Gefixt: expliziter `http.Server` +
  `srv.Shutdown(ctx)` in einem `select` auf `ctx.Done()`, 5 s
  Shutdown-Timeout, Fallback `srv.Close()`. Verifiziert: `make stop`
  beendet den Prozess jetzt sauber per SIGTERM in < 1 s (vorher: SIGTERM
  wirkungslos, immer SIGKILL nötig).
- **`docs/HANDBUCH.md`** (neu): Voraussetzungen, Schnellstart, erste
  Schritte in der GUI (Instanz-Launcher-Katalog), Troubleshooting
  (verwaister Prozess auf Port 8000, transiente „registry poll failed"-
  Warnung, fehlendes `libmxl.so` bei `cargo test`). `README.md` bekommt
  einen kurzen Quickstart-Verweis und einen aktualisierten Status-Absatz
  (der alte Text „frisch initialisiert, Tech-Stack offen" war seit
  Wochen falsch).
- **Verifikation:** `make start`/`make status`/`make stop` mehrfach
  end-to-end durchgespielt (inkl. der beiden oben beschriebenen
  Fehlerfälle), PID-Datei stimmt jetzt mit dem tatsächlichen
  Port-Owner überein, Port ist nach `make stop` zuverlässig frei.
  `make check`: Go-/Deno-Teile grün; `cargo test -p omp-mediaio`
  schlägt weiterhin (unverändert, nicht durch diese Änderung verursacht)
  fehl, weil `libmxl.so` in dieser Umgebung nicht installiert ist
  (`deploy/dev/install-mxl.sh` nicht gelaufen) — dokumentiert im
  Handbuch-Troubleshooting statt stillschweigend übergangen.

## 2026-07-11 — Grass-Valley-/AMPP-Referenzen aus ARCHITECTURE.md entfernt, ARCHITECTURE.html gelöscht

**Kontext:** Nutzeranforderung: jede Referenz auf Grass Valley und die
AMPP-Plattform aus `ARCHITECTURE.md` entfernen; `ARCHITECTURE.html`
(veraltet) löschen.

- **§1 (Vision):** „Alternative zu Grass Valley AMPP / Matrox Origin" →
  „Alternative zu proprietären Cloud-Produktionsplattformen (z. B. Matrox
  Origin)" — Matrox-Erwähnung blieb, war nicht Teil der Anforderung.
- **§4.5a:** „(AMPP-artig)"/„vergleichbar mit AMPP-Flows / Node-RED" →
  nur noch „vergleichbar mit Node-RED".
- **§6.2:** Die Anforderungsbeschreibung nannte „Vizrt AMPP OS" als
  Vorbild (Attribution war ohnehin falsch — AMPP ist eine
  Grass-Valley-Plattform, nicht Vizrt) → generalisiert zu „Vergleichbare
  Cloud-Produktionsplattformen"; „AMPP-Kernwunsch" → „Kernwunsch".
- **§9/§10 (Marktkompatibilität/Zukunftssicherheit):** Grass Valley aus
  der Tiger-Team-Vendor-Liste entfernt (6 → 5 Großvendoren: Matrox, Lawo,
  Riedel, Intel, NVIDIA), Satz über „Grass Valley AMPP integriert MXL
  bisher nur in R&D-Demos" gestrichen. Andere Vendoren (Matrox, Lawo,
  Riedel, Intel, NVIDIA, IPMX/AIMS) blieben unverändert — nicht Teil der
  Anforderung.
- **§15 „Hardware-Bedienpult-Integration (Beispiel Grass Valley Connected
  Switcher)" komplett entfernt**, nicht nur umformuliert: der gesamte
  Abschnitt (Anforderung, Recherche, Ergebnis, Quellen) war inhaltlich
  eine GV-Fallstudie — ohne den Vendor bliebe nur eine unbelegte
  Restaussage übrig, die zudem bereits als generisches
  Adapter-Node-Prinzip in §9 steht („Für Fremdgeräte ohne IS-12/14
  braucht es pragmatisch Adapter-Nodes"). Löschen statt Generalisieren,
  um keine unbequellten Vendor-Aussagen unter anonymisiertem Deckmantel
  stehen zu lassen (verletzt sonst das „nicht raten"-Prinzip des
  Projekts).
- **§16 (jetzt §15, Fixed-Latency-Modell):** „Vorbild AMPP"/„AMPPs
  Latenz-Budget"/„AMPPs 5-Frames-Beispiel" durchgehend durch
  vendor-neutrale Formulierungen ersetzt — die Konzept-Substanz
  (Latenzbudget, Delay-Ausgleich) ist unverändert, nur ohne Zuschreibung
  an ein bestimmtes kommerzielles Produkt.
- **Renumerierung:** Durch das Löschen von §15 verschieben sich §16→15,
  §17→16, §18→17, §19→18, §20→19 (inkl. aller Unterabschnitte, z. B.
  §18.1–18.7 Host-Agent, §19.1–19.3 Orchestrator-Redundanz) — alle
  Querverweise im Dokument (§7-Phasenplan-Tabelle, §7.4, §13.1 u. a.)
  entsprechend nachgezogen und verifiziert (kein verwaister §16–§20-Verweis
  mehr im Dokument).
- **`ARCHITECTURE.html` gelöscht** (veraltet, Stand 2026-07-03, keine
  Referenz darauf im Repo).
- **Bewusst nicht angefasst:** `UMSETZUNG.md` (zwei beiläufige
  „AMPP-artig"-Erwähnungen in B3/B5) und dieses Log selbst — die
  Anforderung bezog sich explizit auf „das Architektur-Dokument"
  (`ARCHITECTURE.md`), und `docs/decisions.md` ist ein Verlauf, der nicht
  rückwirkend umgeschrieben wird.

## 2026-07-11 — MXL-Grain-Index ist TAI-Zeit, nicht Ersatztakt (Fable-Konsultation, am gevendorten Spec-Stand verifiziert); OGraf/Demo-3-Scope-Unschärfe offen

**Kontext:** Zwei Nutzerfragen vor dem Start von C10. (1) Fehlt der
OGraf-Grafik-Node für den „kleinen Regieplatz"-Test? (2) Gibt jeder
verarbeitende Node den Original-Timestamp der Quelle durch, oder wie
sonst wird A/V/Metadaten-Synchronität sichergestellt — insbesondere auf
der MXL/DMF-Metadatenebene? Fable wurde konsultiert (Projektregel:
Standards nicht raten) und hat dafür statt zu spekulieren den
gevendorten `third_party/mxl`-Quellstand (v1.0.1, insb.
`docs/Timing.md`, `lib/include/mxl/{flow,time}.h`, `lib/tests/data/*.json`,
`rust/mxl/src/instance.rs`) sowie den tatsächlichen OMP-Code
(`nodes/omp-mediaio/src/mxl.rs`, `omp-node-sdk/src/is04.rs`) gelesen,
nicht nur `ARCHITECTURE.md`.

**Befund 1 (Kernkorrektur, in §15.1 Punkt 4 eingearbeitet):** Der
MXL-Grain-Index ist **keine lokale Ersatz-Sequenznummer**, sondern
absolute TAI-Zeit seit der ST-2059-1-Epoche (`Timing.md`: „Index 0 is
defined to be index at the beginning of the epoch"). ST-2110-Pfade
(PTP-referenziert) und MXL-Single-Host-Pfade teilen sich damit
**dieselbe** Zeitreferenz in unterschiedlichen Einheiten, keine zwei
grundsätzlich verschiedenen Fälle, wie §15.1 Punkt 4 bisher unterschied.
Der Delay-Ausgleich aus §15 konkretisiert sich dadurch zu
„Ausgangs-Grain(N) = Eingangs-Grain(N) + D" — Ursprungsbezug und
Latenzbudget sind dieselbe Mechanik.

**Befund 2 (Implementierungslücke, noch offen):** Die aktuelle
OMP-Implementierung erhält diesen Ursprungsbezug **nicht**:
`MxlVideoInput` schiebt Grains über `appsrc do-timestamp=true` (verwirft
die Herkunftszeit, C4-Entscheidung), `MxlVideoOutput::write_loop` holt den
Start-Index einmalig per `get_current_index()` und zählt danach nur +1
(kein PTS/TAI-Re-Anchor). Für A–C (reiner Funktionsnachweis) bewusst
tragbar — für §15 (P2/D) und für frame-genaue Metadaten-Attribution
nicht. **Wird nicht in C10 behoben** (Scope-Disziplin, `UMSETZUNG.md` §0
Punkt 2: ein Schritt pro Sitzung, C10 ist Deskriptor/Pipeline/Crosspoint,
nicht Timing-Rearchitektur) — aber C10 ist der erste Node mit
echtem simultanem Multi-Input-Compositing (Crossfade + Keyer-Layer
gleichzeitig aktiv), wo die Lücke erstmals praktisch relevant wird.
**Empfehlung:** PTS/TAI-verankerte Index-Berechnung spätestens vor der
D5-SDK-v1-Doku bzw. vor dem ersten §15-Umsetzungsschritt nachziehen,
nicht weiter aufschieben.

**Befund 3 (Metadatenebene, in §15.1 nach Punkt 5 eingearbeitet):**
Frame-genaue Begleitdaten (Timecode, Captions, künftig
Grafik-Steuerdaten) gehören als eigener MXL-Datenflow (`format:
urn:x-nmos:format:data`, Beispiel `video/smpte291`/ST-2110-40 liegt im
Spec-Testfundus, `lib/tests/data/data_flow.json`) mit `grain_rate` =
Videorate modelliert — Korrelation läuft automatisch über den identischen
Grain-Index, kein Zusatzfeld nötig (`mxlGrainInfo` hat ohnehin kein
Nutzdaten-Korrelationsfeld, nur reservierte Bytes). Für Steuerkommandos
ohne Medien-Flow-Charakter (z. B. ein frame-genau auszuführender
IS-12-Methodenaufruf) ist ein optionales `executeAtIndex`-Argument im
generischen Methoden-Dispatch (seit C4-prep vorhanden) der vorgesehene
Ort, sonst ist Automation nur „so schnell wie der
Control-Plane-Roundtrip".

**Befund 4 (SDK-Konventionen, additiv, nicht jetzt umgesetzt):**
`grouphint` wird aktuell v0-behelfsmäßig mit der Flow-ID gefüllt
(`omp-mediaio/src/mxl.rs`, als Workaround kommentiert) statt „Instanzname:
Rolle" — laut `flow.h`-Kommentar „essential for flow discovery by higher
level applications", also mittelfristig zu korrigieren. `parents`
(`omp-node-sdk/src/is04.rs`) bleibt bei abgeleiteten Flows (Switcher-/
künftig Mixer-Ausgang) konstant leer — sollte gesetzt werden, ersetzt
aber keine frame-genaue Attribution (reine Herkunfts-Lineage). Beide
Punkte: additive Aufräumarbeit, kein Blocker für C10.

**Offen (Nutzerentscheidung aussteht):** OGraf-Node laut §7.4 Teil von
Demo 3, aber kein eigener Schritt in der `UMSETZUNG.md` C10–C13-Liste —
Widerspruch, nicht stillschweigend aufgelöst. In §11.2 als
„Scope-Unschärfe" vermerkt, zwei Optionen genannt (OGraf-Schritt in
C10–C13 aufnehmen vs. §7.4-Erwähnung bewusst auf Demo 4 verschieben).
**Nicht Teil dieser Sitzung** (C10 läuft wie in `UMSETZUNG.md` geplant
weiter, unabhängig vom Ausgang dieser Frage).

**Beifang:** `third_party/mxl/lib/tests/data/v210a_flow.json` zeigt
`media_type: "video/v210a"` — die in §11.2 offene Alpha-Transport-Frage
für den OGraf-Node hat damit einen ersten Beleg (kein Pixelformat mit
Alpha ist bloße Annahme), muss bei der Umsetzung aber trotzdem gegen den
dann aktuellen Spec-Stand bestätigt werden.

## 2026-07-11 — C10-Verifikation gefunden: Instanz-Launcher (C8) bricht seit dem Start/Stop-Tooling-Commit, `deploy/catalog.json`-Pfade behoben

**Kontext:** Beim End-to-End-Verifikationslauf von C10 (zwei
`omp-source` + `omp-video-mixer-me` im Katalog starten) schlug
`POST /api/v1/instances` für **jeden** Katalog-Eintrag fehl (nicht nur
den neuen), mit `fork/exec ../nodes/target/debug/omp-source: no such
file or directory` — ein Regressions-Bug, kein C10-spezifisches
Problem, aber ein Blocker für dessen Verifikation.

**Ursache:** `deploy/catalog.json`s `command`-Pfade
(`"../nodes/target/debug/<binary>"`) sind relativ zum
**Katalog-Verzeichnis** (`deploy/`) geschrieben, wurden von
`orchestrator/internal/launcher/launcher.go`s `Start()` aber unverändert
an `exec.Command()` durchgereicht — relativ zum tatsächlichen **cwd des
Orchestrator-Prozesses**. Das ging nur solange gut, wie der Prozess
zufällig aus `orchestrator/` gestartet wurde (der alte, von
`orchestrator/internal/config/config.go`s Default-Kommentaren
implizierte Zustand: „OMP_UI_DIR=../ui etc. sind relativ zum cwd
gedacht"). Der jüngste Start/Stop-Tooling-Commit (`deploy/dev/
start-omp.sh`, git-Historie 2026-07-11) stellte `OMP_UI_DIR`/
`OMP_DATA_DIR` bewusst auf absolute Pfade um, genau um diese
Cwd-Abhängigkeit loszuwerden („so kann der Prozess ohne umschließende
cd-Subshell gestartet werden") — dabei aber `deploy/catalog.json`s
relative Kommando-Pfade nicht mitgezogen, wodurch der Launcher (C8,
2026-07-10 verifiziert, **vor** diesem Commit) seitdem kaputt war, ohne
dass ein Schritt das bemerkt hätte (C8s eigene Verifikation prüft
Start/Stop einer Instanz, wurde aber nicht nach dem Tooling-Commit
erneut gegen `make start` durchlaufen).

**Fix:** `LoadCatalog()` (`orchestrator/internal/launcher/catalog.go`)
löst Pfad-Kommandos (enthalten `/`, nicht bereits absolut) jetzt beim
Laden gegen das Katalog-Verzeichnis auf (`filepath.Join(filepath.Dir(
path), cmd)`) — bare Kommandos ohne Pfadtrenner (PATH-Lookup, z. B.
`"true"`, künftig `"podman"`) bleiben unverändert. Drei neue Tests
(`catalog_test.go`): Auflösung relativer Pfade, bare Kommandos
unverändert, bereits absolute Pfade unverändert. Kein Eintrag in
`UMSETZUNG.md` geändert — reiner Bugfix an bereits abgeschlossenem C8,
gleiche Einordnung wie der B4/Health-Staleness-Fix vom 2026-07-09.

**Nicht behoben:** `deploy/catalog.json` selbst bleibt unverändert
(die relativen Pfade sind jetzt korrekt interpretiert, kein Grund sie
auf absolute Pfade umzustellen — das wäre weniger portabel).

## 2026-07-11 — C11 (`omp-audio-mixer`): MXL-Audio-Fundament im SDK, Scope-Entscheidung „interne Testtöne statt externer MXL-Audio-Eingang", zwei Discovery-Bugfixes

**Kontext:** C11 (`ARCHITECTURE.md` §13.2) verlangt dynamische
Kanalzahl, Gain/EQ, Audio-Follow-Video gegen C10s Tally-Bus. Anders als
C10 (baute auf bereits vorhandenem MXL-Video-Fundament, C4) gab es für
Audio noch **kein** MXL-Fundament (`omp-mediaio` kannte nur
`MxlVideoInput`/`MxlVideoOutput`) und keinen einzigen MXL-Audio-
erzeugenden Node im System — beides musste in diesem Schritt mit
entstehen, nicht nur der Mischer selbst.

**Scope-Entscheidung: Kanal-Audioquelle intern (`audiotestsrc`), nicht
extern-MXL.** Ein `ChannelStrip` liest keinen externen MXL-Audio-Eingang
— es gibt keinen Node, der einen liefern könnte (`omp-source`, C5, ist
reines Video), das wäre ein Henne-Ei-Problem. Jeder Kanal bekommt
stattdessen einen internen Testton (`audiotestsrc`, Frequenz je Kanal
unterschiedlich) — Software-Testmittel-Linie wie überall sonst
(`UMSETZUNG.md` §0 Punkt 7). Der **Ausgang** ist trotzdem ein echter
MXL-Audio-Flow, keine Simulation.

**MXL-Audio-Fundament (`omp-mediaio::mxl::MxlAudioOutput`), am
offiziellen Muster verifiziert, nicht geraten:** MXL behandelt Audio
grundsätzlich anders als Video — „continuous"-Ringpuffer
(Sample-basiert, `SamplesWriter`/`open_samples`/`channel_data_mut`) statt
„discrete"-Grains (`third_party/mxl/docs/Architecture.md`: „Discrete
ringbuffers are used for granular data types such as video ...
Continuous ringbuffers are used for audio"). Portiert nach dem
offiziellen `write_samples`-Beispiel (`third_party/mxl/rust/mxl/
examples/flow-writer.rs`) — Aufruf-Muster `open_samples(index,
batch_size)`, danach `index += batch_size`, 1:1 übernommen, nur mit
echten Pipeline-Samples statt synthetischer Testbytes. `audiobuffersplit`
(GStreamer, `output-buffer-duration=1/100`) erzwingt die feste
Batch-Größe (10ms, gleicher Default wie im MXL-Beispiel), die
`open_samples` pro Aufruf vorab kennen muss — **Fallstrick dabei
gefunden**: `audiobuffersplit` akzeptiert laut `gst-inspect-1.0
audiobuffersplit` nur `layout=interleaved` auf Sink **und** Src, MXLs
`channel_data_mut` braucht aber non-interleaved (planare) Kanaldaten —
deshalb zwei `audioconvert`-Stufen (interleaved bis inklusive
`audiobuffersplit`, non-interleaved erst danach), nicht eine.

**IS-04-Audio-Resources gegen die Spec verifiziert, nicht geraten**
(`AMWA-TV/nmos-discovery-registration`, `APIs/schemas/{source_audio,
flow_audio,flow_audio_raw}.json`, GitHub-API statt Gedächtnis): `Source`
bekommt ein optionales `channels`-Feld (`skip_serializing_if`, damit
Video-Sources exakt dasselbe JSON wie bisher senden, keine Regression am
C5-verifizierten Pfad). `Flow` wird **nicht** mit optionalen Audio-Feldern
überladen (dessen Felder wie `frame_width`/`components`/`colorspace`
sind zwingend video-spezifisch) — stattdessen ein eigener `AudioFlow`-Typ
plus `#[serde(untagged)] enum FlowResource` für die generische
`register("flow", …)`-Stelle. `node::FlowSpec` wurde von einem
Video-only-Struct zu einem `Video`/`Audio`-Enum — **Breaking Change am
SDK**, alle drei bestehenden Aufrufer (`omp-source`, `omp-switcher`,
`omp-video-mixer-me`) auf `FlowSpec::Video { … }` umgestellt (mechanisch,
keine Verhaltensänderung). Vertretbar, weil das SDK weiterhin
projektintern ist (kein externer Konsument vor D5/SDK-v1-Dokument).

**Zwei Discovery-Bugs gefunden und behoben (betreffen C7 **und** C10,
nicht nur C11):** Sobald ein MXL-Sender mit `format=audio` im Netz
erscheint, versuchten `omp-switcher`s und `omp-video-mixer-me`s
Discovery-Loops (beide filtern bisher nur `transport==MXL`) ihn als
Video-Eingang zu öffnen — Rebuild schlug mit `flow_def: frame_width
fehlt` fehl, fiel aber dank C7s/C10s bestehendem Schwarzbild-Fallback
nicht komplett aus. Fix: neue `RegistryClient::get_flow_format(flow_id)`
(liest nur das `format`-Feld, kein voller `Flow`/`AudioFlow`-Typ nötig,
beide haben das Feld unter demselben Namen), beide Discovery-Loops
filtern jetzt zusätzlich auf `format == is04::FORMAT_VIDEO`. War vor C11
nicht beobachtbar, weil es schlicht keinen zweiten MXL-Format-Typ im
System gab.

**Audio-Follow-Video-Minimalausbau:** `followMode` ∈ {off, cut,
crossfade}, aber keine pro-Kanal-konfigurierbare Crossfade-Dauer (fest
500ms/12 Schritte, `FOLLOW_CROSSFADE_MS`/`_STEPS` in `main.rs`) — §13.2
nennt `crossfadeMs` als Konzept, nicht als Pflicht-Parameter; volle
Konfigurierbarkeit bleibt wie Kompressor/Limiter/Aux/Gruppen
Community-Vertiefung (`UMSETZUNG.md` C11-Text).

**Standardklassen geprüft, nicht angenommen** (`AMWA-TV/ms-05-02`,
`models/classes/*.json`, GitHub-API): der komplette MS-05-02-
Kernklassenbaum umfasst nur sechs Klassen (`NcObject`/`NcBlock`/
`NcWorker`/`NcManager`/`NcDeviceManager`/`NcClassManager`) — keine
`NcGain`/`NcMute`/EQ-Klasse. Die AES70/OCA-Erwähnung in
`ARCHITECTURE.md` §11.1/§13.2 ist eine Analogie zu einem verwandten,
separaten Standardmodell, keine im MS-05-02-Kern tatsächlich
vorhandene Klasse. Eigene `gain`/`mute`/`eq*`-Properties pro Kanal sind
damit nach §11.1 Punkt 3 korrekt.

**Contract-Check (C9) fand einen echten Deskriptor-Fehler:** alle
`channel.<id>.*`-Parameter waren ursprünglich als `readonly: false`
deklariert, obwohl `set()` (wie bei C10s Nodes) durchgehend
`SetError::ReadOnly` liefert — Zustandsänderungen laufen nur über die
`channel.<id>.set*`-Methoden (Range-/`followMode`-Validierung).
`tools/contract-check`s Param-Roundtrip-Test schlug entsprechend fehl;
behoben durch `readonly: true` auf allen Kanal-Parametern, danach PASS.

## 2026-07-11 — C11-Nachtrag: echte Kanalquellwahl (`MxlAudioInput` + Discovery), non-interleaved-Puffer-Bug gefunden und behoben

**Kontext:** Nutzerfrage nach dem C11-Abschluss: „wie bestimme ich die
Source des Kanals?" — zu dem Zeitpunkt gar nicht, jeder Kanal hatte nur
den internen Testton (bewusste Scope-Entscheidung, s. Eintrag oben). Auf
Nachfrage entschieden, echte Quellwahl jetzt nachzuziehen statt als
separaten Schritt zu verschieben.

**Ergänzt:**
- `omp_mediaio::mxl::MxlAudioInput` — Lese-Gegenstück zu `MxlAudioOutput`
  (C11), nach demselben offiziellen `read_samples`-Beispiel-Muster
  (`third_party/mxl/rust/mxl/examples/flow-reader.rs`) wie der
  Schreibpfad nach `write_samples`. Anders als `MxlVideoInput`
  (Aufrufer baut bei jeder Quellenänderung die ganze Pipeline neu) legt
  `MxlAudioInput` seine Elemente (`pub elements: Vec<gst::Element>`)
  offen, weil `omp-audio-mixer` einzelne Kanal-Zweige chirurgisch
  aus einer laufenden Pipeline entfernt (C11-Grundprinzip), nicht die
  ganze Pipeline neu aufbaut.
- `channel.<id>.setSource(senderId)` + `availableSources`-Discovery
  (gleicher Poll-Stil wie C7/C10, zusätzlich `get_flow_format`-gefiltert
  auf `format==audio` — dieselbe Notwendigkeit, die C7/C10 bereits beim
  ursprünglichen C11-Abschluss traf). `senderId=""` schaltet zurück auf
  den internen Testton (Frequenz bleibt über den Kanal-Lebenszyklus
  stabil, `internal_freq` in `ChannelState`). Bereits konfigurierte
  Gain/Mute/EQ-Werte werden nach einem Quellwechsel erneut angewendet
  (der neue Pipeline-Zweig startet sonst bei Neutral-Werten) —
  Reihenfolge garantiert durch den einen mpsc-Kommandokanal der Pipeline
  (FIFO), kein Extra-Synchronisationsmechanismus nötig.

**Bug gefunden und behoben (nicht vorab erkannt, erst beim Testlauf):**
`MxlAudioInput` schob anfangs einen non-interleaved-`GstBuffer`
(`Buffer::from_slice`, von Hand aus den pro Kanal getrennten MXL-Byte-
Slices zusammengesetzt) in ein `appsrc`, dessen Caps `layout=non-
interleaved` deklarierten — das crashte nicht, produzierte aber lautlos
gar keinen Ton mehr: `GStreamer-Audio-CRITICAL
gst_audio_buffer_map`-Assertion, danach blieb der komplette
Ausgabe-Flow des konsumierenden Mixers stehen (Head-Index eingefroren,
per `mxl-info` verifiziert). Ursache: ein non-interleaved-`GstBuffer`
braucht zwingend ein begleitendes `GstAudioMeta`, das eine echte
GStreamer-Transformation (z. B. `audioconvert`) automatisch mitgibt —
ein von Hand per `Buffer::from_slice` gebauter Puffer hat das nicht.
`MxlAudioOutput`s Schreibpfad hatte dasselbe Problem nie, weil dort ein
echter `audioconvert` den non-interleaved-Puffer erzeugt (Kommentar in
`audio_caps`), nicht Handarbeit. Behoben durch Umkehren des Ansatzes:
`MxlAudioInput` verwebt die MXL-Byte-Slices jetzt selbst zu einem
**interleaved** Puffer (`interleave_samples()`, neue Funktion in
`mxl.rs`) — interleaved ist der Meta-freie Default-Fall, `appsrc`
deklariert entsprechend `layout=interleaved`. End-to-End verifiziert
(zwei `omp-audio-mixer`-Instanzen, eine als Quelle für die andere,
`mxl-info`: Head-Index des Konsumenten wächst kontinuierlich, keine
neuen CRITICAL-Meldungen mehr), `tools/contract-check` PASS.

## 2026-07-12 — C12 (`omp-player`): zwei feste Cue/Take-Slots statt N dynamischer Zweige, eine Codebasis für Video-/Jingle-Profil

**Entschieden:** `ARCHITECTURE.md` §13.3 verallgemeinert den für Playout
vorgesehenen `PlaylistController`-Baustein (§11.1) zu einer gemeinsamen
Codebasis für Musik-/Jingle-Player und Videoplayer. Umsetzung als neues
Crate `omp-player`, Profil-Umschaltung ausschließlich über
`OMP_PLAYER_PROFILE=video|jingle` (steuert nur, ob ein Video-MXL-Sender
registriert wird — Audio-Sender immer, auch beim Videoplayer, als
Slate-Ton-Ersatz). Deskriptor/Methoden (`append`/`load`/`remove`/
`cue`/`take`) sind für beide Profile identisch; nur die UI-Bundle-
Variante unterscheidet sich (zwei kompilierte Paare Manifest/Bundle,
`uibundle.rs` wählt zur Laufzeit anhand von `has_video`).

**Pipeline-Architektur — bewusst zwei feste Slots (A/B), keine N
dynamischen Zweige wie C7/C10/C11:** ein Cue/Take-Paar hat strukturell
immer genau zwei Rollen (on air, cued), deshalb zwei feste
`input-selector`-Sink-Pads pro Medienart, deren Pad-Objekte über die
gesamte Prozesslaufzeit bestehen bleiben. `cue(itemId)` ersetzt nur den
Elementzweig hinter dem jeweils NICHT-on-air-Pad (`replace_slot`, analog
zu C11s `add_channel_branch`/`remove_channel_branch`, aber ohne
Pad-Request/-Release, weil die Pads selbst fix bleiben). `take()`
schaltet ausschließlich `active-pad` um (kein Rebuild, gleiche Technik
wie C7s `apply_selection`) — danach ist der bisherige On-Air-Slot frei
für den nächsten `cue()`. Reihenfolge von `cue()` (asynchrones
`LoadSlot`-Kommando) und einem direkt danach aufgerufenen `take()`
(`SetActive`-Kommando) ist durch denselben `std::sync::mpsc`-Kanal FIFO
garantiert — gleiche Verlässlichkeit wie C11s `setSource`-gefolgt-von-
`setGain`, kein Zusatzsynchronisationsmechanismus nötig. Das nutzt auch
das Jingle-Cart-Wall-UI aus (Klick = `cue()` + `take()` sequentiell).

**Clips sind bewusst reine Software-Testmittel** (`UMSETZUNG.md` §0
Punkt 7): jedes Item ist ein `videotestsrc`-Pattern (nur Video-Profil)
plus ein `audiotestsrc`-Ton (immer), beide ohne `num-buffers`-Limit
dauerhaft laufend. `durationMs` ist bewusst nur Metadaten für die
`playheadPositionMs`-Anzeige (Wanduhr-Differenz seit dem letzten
`take()`, kein GStreamer-Query nötig), kein erzwungenes Clip-Ende —
automatisches Vorrücken am Clip-Ende ist Automations-Scope (C14/C15).
Ein EOS-Pfad für den on-air-Zweig hätte hier nur Fehlerrisiko ohne
Gegenwert eingebaut.

**Verifiziert:** `cargo build --workspace --bins`/`test --workspace`/
`cargo deny check`/`cargo audit` grün (5 Crates + neues `omp-player`).
Zwei Instanzen aus dem Katalog gestartet (`omp-player-video`,
`omp-player-jingle`), `append`/`cue`/`take` über die generische
Node-Proxy-API auf beiden durchgespielt (Playlist wächst, `cuedItemId`/
`currentItemId`/`mode`/`playheadPositionMs` verhalten sich korrekt),
`tools/contract-check` PASS auf beiden inkl. korrektem UI-Manifest-Tag
pro Profil (`omp-player-video-panel`/`omp-player-jingle-panel`). MXL-
Video-Flow (640×480@25, `video/v210`) korrekt im Domain-Verzeichnis
angelegt, IS-05-Verbindung Player-Sender → `omp-viewer`-Receiver
erfolgreich hergestellt (`active`/`staged` zeigen die richtige
`sender_id`), CPU-Last des verbundenen Viewers steigt sichtbar
gegenüber einer unverbundenen Vergleichsinstanz (89 % vs. 0,5 %) — starkes
Indiz für tatsächlich fließende Frames.

**Nicht abschließend visuell bestätigt (gefundenes, nicht selbst
verursachtes Problem):** `omp-viewer`s separater MJPEG-Preview-HTTP-
Server (`preview.rs`, seit C6 unverändert) beantwortet in dieser Sitzung
keine einzige Anfrage (`curl`/Python-`http.client`/Rohsocket, alle mit
TCP-Connect-Erfolg, aber 0 Bytes empfangen) — reproduzierbar auch an
einer frisch gestarteten, nie zuvor kontaktierten, unverbundenen
Viewer-Instanz (0,5 % CPU, kein Verbindungszustand), also unabhängig von
`omp-player`. Laut `docs/decisions.md` (C6-Eintrag) funktionierte
derselbe Mechanismus damals per `curl`. Ursache nicht ermittelt (out of
scope für C12) — separater Diagnoseschritt empfohlen, bevor der nächste
Schritt sich auf visuelle Viewer-Verifikation verlässt.

## 2026-07-12 — §20 (24/7 Broadcast-Grade Hardening, Gap-Analyse) ergänzt; AMPP-Namensfrage geklärt

**Kontext:** Nutzer möchte die Redundanz-Frage vom selben Tag (siehe C12-
Nachtrag oben, `omp-video-mixer-me`-Failover) zu echter Genlock-
Äquivalenz (Option b) aufwerten und das gesamte Projekt so professionell
wie Grass Valley AMPP ausbauen, inkl. Look-and-Feel und einem
dynamischen, installier-/importier-/versionier-/sortier-/durchsuchbaren
Microservice-Katalog. Das kollidiert auf den ersten Blick mit der
Nutzeranforderung vom 2026-07-11 (siehe Eintrag oben, "Grass-Valley-/
AMPP-Referenzen aus ARCHITECTURE.md entfernt") — dem Nutzer vorgelegt,
zwei Fragen geklärt:

1. **AMPP-Namensnennung:** bleibt bei der 2026-07-11-Entscheidung —
   AMPP/vergleichbare Plattformen dienen weiter nur als **interner**
   Recherche-/Qualitätsmaßstab (z. B. für eine `fable`-Konsultation zur
   Genlock-Frage), keine Vendor-Namen zurück in `ARCHITECTURE.md`.
2. **Vorgehen beim großen 24/7-Professionalisierungs-Wunsch:** zuerst ein
   neuer Gap-Analyse-/Fahrplan-Abschnitt (§20, keine Umsetzung, keine
   Phasenplan-Änderung), der Nutzer priorisiert danach, erst priorisierte
   Punkte werden zu regulären `UMSETZUNG.md`-Schritten.

**§20 fasst zusammen:** Instanz-/Prozess-Redundanz jenseits von §6.3
(Genlock-Äquivalent, Entscheidung hängt von einer parallel laufenden
`fable`-Konsultation ab), dynamischer durchsuchbarer Katalog (größtenteils
schon durch §6.4/§13.5 abgedeckt, echte Lücke nur die Such-/Filter-UX),
Design-System/Look-and-Feel (neu, kompatibel mit der bestehenden
Vanilla-TS/Custom-Elements-Linie, kein Framework-Wechsel nötig),
Security/Auth-Hardening-Priorität (D3 nicht beliebig aufschieben, sobald
Mehrpersonen-Betrieb ansteht), Verweis auf das bestehende
Control-Plane-HA-Konzept (§19), neu identifizierte Betriebs-/Compliance-
Themen (Sendeprotokoll-Pflicht, Loudness-Konformität, NOC-Eskalation,
Backup/Restore-Prozedur, Soak-Tests, Multi-Standort-Betrieb) sowie eine
explizite Bestätigung, dass MAM/Traffic/Radio-Automation weiterhin per
P3-Entscheidung "nach 2029" außerhalb des Zielbilds bleiben.

## 2026-07-12 — C13 (Operator-Console): Rollen-Stub statt §12/D3, Instanz-ID als stabile "Rolle", Bundler-Bug per Browser-Test gefunden

**Rollen-Stub-Design:** Da §12 (Nutzer-/Rollenmodell) und D3 (Auth) noch
nicht existieren, löst ein neues Orchestrator-Package
`internal/consoles` Bindungen aus einer handgepflegten
`data/role-bindings.json` (Format: `{userId, nodeId, verb}`, `nodeId`
kann `"*"` sein) gegen den aktuellen Node-Bestand auf — bewusst simpel,
keine CRUD-UI (D3-Scope). **Wichtige Design-Entscheidung:** als
`nodeRoleId` dient die vom Instanz-Launcher vergebene `instance_id`
(`UMSETZUNG.md` C8), nicht die pro Prozessneustart neu erzeugte IS-04-
Node-ID — sonst würde jede Rollenbindung nach einem Node-Neustart
verwaisen. `GET /api/v1/me/consoles` liefert deshalb bewusst
`{hasEngineeringAccess, consoles: [...]}` statt der in `ARCHITECTURE.md`
§14 wörtlich beschriebenen reinen Array-Antwort — eine kleine,
pragmatische Erweiterung, weil die Shell sonst kein Signal hätte, ob sie
trotz vorhandener `operate`-Bindungen auf Engineering statt Console
starten soll (§14: "Hat der Nutzer zusätzlich configure/admin
irgendwo..."). `uiBundleUrl` ist bewusst die Proxy-Basis-Route
(`/api/v1/nodes/<aktuelle-node-id>`, kein `/ui/manifest.json`-Suffix),
damit die stabile `nodeRoleId` nicht mit der flüchtigen aktuellen
Node-ID verwechselt wird.

**Shell-Umbau:** `ui/shell/shell.ts` ist jetzt der einzige Bundle-
Einstiegspunkt (`Makefile`s `ui`-Target bündelt `shell.ts` statt
`flow-canvas.ts` direkt); dieser importiert `flow-canvas.ts` als
Seiteneffekt und entscheidet zwischen Engineering- (`<omp-flow-canvas>`)
und Console-Ansicht (`<omp-console-view>`, neu). Die node-eigene
UI-Bundle-Lade-Logik (`fetch .../ui/manifest.json` +
`import(".../ui/bundle.js")`) war bisher eine private Methode auf
`FlowCanvas` — extrahiert nach `ui/shell/ui-bundle.ts`, von beiden
Ansichten genutzt statt dupliziert. Kiosk-Route
`/console/<workflowId>/<nodeRoleId>` (§14: "direkt verlinkbar/
bookmarkbar") läuft server-seitig über einen SPA-Fallback
(`spaFallback` in `httpapi/server.go`: `/console/...`-Pfade liefern
`index.html` statt eines 404 vom generischen Datei-Server, die Shell
wertet `location.pathname` client-seitig aus). "Aktueller Nutzer" ist
ein trivial spoofbarer Stub (`X-OMP-Stub-User`-Header/`?user=`-Query-
Param/`localStorage`, Default `"admin"` — bewahrt das vor C13 einzig
existierende Verhalten, solange keine Rollenbindungen gepflegt sind:
sowohl bei fehlender `role-bindings.json` als auch bei einem Nutzer ohne
jede Bindung fällt die Shell auf Engineering zurück, nicht auf eine
leere Console-Ansicht).

**Bug per Browser-Test gefunden, den `curl`/API-Tests nicht sehen
konnten:** `tools/contract-check`-artige HTTP-Prüfungen zeigten alles
korrekt (Endpunkt liefert die richtige JSON-Struktur), aber Chromium
headless (`--dump-dom`, mit Browser-Konsolen-Logging) zeigte
`Uncaught (in promise) TypeError: view.setEntries is not a function` —
`shell.ts` importierte `ConsoleView` gemischt mit einem `type`-Import
(`import { ConsoleView, type ConsoleEntry } from "./console-view.ts"`),
nutzte `ConsoleView` selbst aber nur in Typposition (`as ConsoleView`).
Der Bundler (deno bundle) erkannte daraus "nur als Typ gebraucht" und
eliminierte den gesamten Import — inklusive des Modul-Seiteneffekts
`customElements.define("omp-console-view", ConsoleView)`. Das Custom
Element blieb dadurch unregistriert, `document.createElement(...)`
lieferte ein `HTMLUnknownElement` ohne `setEntries`. Behoben durch einen
expliziten, getrennten Seiteneffekt-Import (`import "./console-view.ts"`)
neben dem reinen Typ-Import. Lehre: ein rein `curl`-/API-basierter Test
hätte diesen Fehler nie gefunden — Grund, bei UI-Änderungen tatsächlich
einen Browser (auch headless) zu befragen, nicht nur die REST-Schicht.

**End-to-End verifiziert** (Chromium headless, zwei echte Node-
Instanzen, zwei Rollenbindungen): Default-Nutzer weiterhin Flow-Editor;
Ein-Bindung-Nutzer landet direkt und ausschließlich auf dem zugewiesenen
Panel (kein Graph sichtbar); Zwei-Bindungen-Nutzer zeigt die erwartete
Tab-Leiste, sortiert nach Label; Kiosk-Route liefert dieselbe Konsole
direkt. `go vet`/`go test`/`deno check`/`deno test` grün.

## 2026-07-12 — Drei kurze Nachträge: omp-source-Audio, Kachel-Inline-Vorschau, omp-multiviewer; MJPEG-Preview-Extraktion nach omp-mediaio; zwei weitere Browser-Test-Bugs gefunden

**Kontext:** Nutzeranforderung nach der C13-Sitzung, drei zuvor nur
angesprochene Lücken sofort als kurze Schritte umzusetzen (nicht
nummerierte C-Schritte, additive Ergänzungen zu bestehenden Nodes/UI).

**1. `omp-source`-Audio-Begleitton:** zweiter, fester `audiotestsrc`-
Zweig (330 Hz, akustisch unterscheidbar von C11/C12s 220-Hz-Vielfachen)
+ `MxlAudioOutput` + zweiter Sender in der `NodeConfig`, exakt gleiches
Muster wie `omp-player` (C12). Damit haben Testquellen jetzt einen
echten externen Audio-Testton statt nur den internen Tönen von
Audiomischer/Player.

**2. Kachel-Inline-Vorschau (`flow-canvas.ts`):** jeder Node mit einem
`previewUrl`-Parameter (bisher nur `omp-viewer`, jetzt auch
`omp-multiviewer`) zeigt sein Bild jetzt direkt auf der Graph-Kachel
(`<foreignObject><img></foreignObject>`, `MJPEG multipart/x-mixed-
replace` aktualisiert sich selbst, kein Polling nötig), nicht nur im
geöffneten Parameter-Panel. Bewusst kein Eingriff in `nodeHeight()`/
Port-Geometrie — das Vorschaubild überragt bei kleinen Kacheln sichtbar
den Kachel-Rahmen, statt Layout von einer erst asynchron bekannten
previewUrl-Verfügbarkeit abhängig zu machen. Einmalige Abfrage pro
Node-ID (`#previewUrlById`-Cache), kein Re-Fetch bei jedem Render-Tick.

**3. `omp-multiviewer` (neuer Node):** dynamische Eingangszahl wie
`omp-switcher` (C7, IS-04-Discovery alle 2s, `inputs_changed`-Diffing
gegen unnötige Rebuilds bei unverändertem Discovery-Tick), aber ein
`compositor`-Grid statt `input-selector` — alle entdeckten MXL-Video-
Sender gleichzeitig sichtbar (Rasterlayout `ceil(sqrt(n))` Spalten,
gleiche `xpos`/`ypos`/`width`/`height`-Pad-Property-Technik wie C10s
DVE-Kompositing). Reiner Monitor: kein MXL-Sende-Ausgang, nur MJPEG-
über-HTTP wie `omp-viewer` — ein Multiviewer speist in der Praxis eine
Bedienplatz-Anzeige, kein weiterverkettbares Programmsignal.

**Refactor als Voraussetzung für 3:** `omp-viewer`s `preview.rs`
(Broadcaster + `tiny_http`-Server + die `build_mjpeg_branch`-
Encode-Kette) nach `omp-mediaio` verschoben (neues Feature `preview`),
damit `omp-multiviewer` sie sich teilt statt zu duplizieren — komplett
node-agnostisch (kein Wissen über Pipeline-Interna), `omp-viewer` selbst
unverändert im Verhalten, nur der Aufrufpfad geändert.

**Zwei weitere Bugs per Browser-Test gefunden (nicht durch `curl`/API-
Tests sichtbar), zusätzlich zum C13-Fund:**
- `ui/shell/shell.ts`s `consoles.length === 0`-Fallback-Check crashte mit
  `TypeError: Cannot read properties of null (reading 'length')`, sobald
  `GET /api/v1/me/consoles` tatsächlich `"consoles": null` lieferte (Gos
  `encoding/json` serialisiert einen nie befüllten Slice als `null`, nicht
  `[]`) — der Fall trat aber genau bei jedem Nutzer ohne jede
  Rollenbindung auf, also dem De-facto-Standardfall vor dem ersten
  Pflegen von `data/role-bindings.json`. Doppelt behoben: `shell.ts`
  normalisiert `consoles` jetzt einmalig beim Fetch auf `[]`, UND
  `orchestrator/internal/consoles/resolve.go` initialisiert `Result.
  Consoles` von vornherein als leeren (nicht nil) Slice, damit die API
  selbst nie wieder `null` statt `[]` liefert.
- **Testmethodik-Erkenntnis:** `chromium --headless=old --dump-dom`
  (mit und ohne `--virtual-time-budget`) erwies sich in dieser Sitzung
  als unzuverlässig für Seiten mit mehreren sequenziellen
  `fetch()`-Ketten (`/api/v1/me/consoles` vor der `<omp-flow-canvas>`-
  Erzeugung, danach deren eigene `#init()`-Kette) — reproduzierbar leerer
  Graph-Viewport selbst mit vollständig zurückgesetztem, bekannt
  funktionierendem Dateistand (per `git stash` verifiziert, um einen
  echten Produkt-Bug auszuschließen). Zuverlässige Alternative in dieser
  Sandbox: `chromium --headless=new --remote-debugging-port=<port>` +
  eine kleine Node.js-Skript-gesteuerte CDP-WebSocket-Session
  (`Page.navigate` + echtes `setTimeout`-Warten + `Runtime.evaluate`)
  statt `--dump-dom`/`--screenshot`. Für künftige Browser-Verifikationen
  in dieser Umgebung diesen CDP-Weg bevorzugen.

**End-to-End verifiziert** (CDP-Session, zwei `omp-source`- + eine
`omp-multiviewer`-Instanz): Multiviewer entdeckt beide Quellen
(`GET .../params/inputs`), Kachel-Grid zeigt genau eine Inline-Vorschau
(die des Multiviewers, `imgSrc` zeigt korrekt auf dessen eigene
MJPEG-URL), `GET .../preview` liefert echte JPEG-Bytes (`ffd8 ffe0`
JFIF-Magic-Bytes per Rohbyte-Prüfung), `tools/contract-check` PASS,
`cargo build/test/deny`, `go vet/test`, `deno check/test` alle grün.

## 2026-07-12 — MXL-Origin-Index-Erhalt (§15), vier UI-Bugfixes, zwei per Live-Test gefundene Laufzeit-Abstürze

**MXL-Origin-Index-Erhalt (`omp-mediaio::mxl`):** Nutzerfrage — löst das
Durchreichen des ursprünglichen Zeitstempels das A/V/Daten-
Synchronitätsproblem (§15) UND das Redundanz-/Havarie-Problem? Dritte
Fable-Konsultation, Ergebnis: **beides teilweise, ja, jetzt umgesetzt.**
Für §15 zwingend nötig (die bisherige „get_current_index()+Zähler"-
Variante hat weder kontrollierbaren Versatz noch Drift-Schutz und kodiert
ohnehin die falsche Zeit — Emission statt Ursprung). Für Redundanz
notwendig, aber nicht hinreichend (Zustands-Synchronität/Rebind-Zeit
bleiben offen). Umgesetzt exakt nach Fables Skizze: Lesepfade
(`read_loop`/`read_audio_loop`) hängen die TAI-Ursprungszeit als
`GstReferenceTimestampMeta` an (`do-timestamp=true` bleibt unverändert),
Schreibpfade (`write_loop`/`write_audio_loop`) lesen sie aus und schreiben
am Ursprungs-Index (Monotonie-Schutz `max(Ursprung, letzter+1)`), sonst
unverändert per Zähler-Fallback — rein additiv, kein Breaking Change.
Zwei neue Unit-Tests (`origin_timestamp_meta_round_trips_to_same_index`,
`origin_index_from_buffer_returns_none_without_meta`) verifizieren den
Mechanismus direkt auf Buffer-Ebene. `ARCHITECTURE.md` §15 Punkt 4 und
§20.1 entsprechend nachgezogen.

**Vier UI-Bugfixes (Nutzerfund, Live-Test im Flow-Editor):**
1. **Kacheln nach Reload außerhalb des sichtbaren Bereichs:** zwei
   zusammenwirkende Ursachen. (a) Viewport (Pan/Zoom) wurde nie
   persistiert — jetzt Teil des Layout-Blobs (`ui/api/v1/layouts/<name>`),
   gespeichert bei Pan-Ende/debounced bei Zoom. (b) **Eigentliche
   Grundursache:** `#assignMissingPositions()`s Index zählte alle
   *jemals* gespeicherten Positions-Einträge, auch für längst gestoppte
   Instanzen — über viele Sitzungen wuchs das unbegrenzt (im konkreten
   Fall: 75 verwaiste Einträge), wodurch neue Kacheln immer weiter nach
   unten/rechts platziert wurden und auch die neue Fit-to-Content-
   Berechnung (Fallback ohne gespeicherten Viewport) durch die verwaisten
   Einträge verzerrt wurde. Behoben durch `#pruneStalePositions()` (läuft
   vor Default-Zuweisung/Fit, entfernt Einträge ohne zugehörigen Node/
   Gruppe) plus sorgfältige Reihenfolge (Fit-Berechnung nutzt den bereits
   bereinigten Bestand, ein einziger konsolidierter Save statt mehrerer
   Zwischen-Saves mit noch unfertigem Viewport).
2. **Beide Ports einer Quelle (Video-Sender, Audio-Sender) gleichfarbig:**
   Port-Füllfarbe war nur nach input/output codiert, nicht nach Format —
   nicht unterscheidbar, wenn ein Node zwei Ausgänge hat. Jetzt primär
   nach IS-04-Format-URN eingefärbt (Video blau, Audio orange, Daten
   violett, unbekannt grau), input/output weiterhin über die Randfarbe.
3. **Inline-Vorschaubild überragte den Kachel-Rahmen:** `nodeHeight()`
   (geometry.ts) reserviert jetzt zusätzlichen Platz (`PREVIEW_HEIGHT`),
   wenn ein Node ein `previewUrl` hat, statt die Geometrie unverändert zu
   lassen und das Bild überstehen zu lassen.
4. **Kein Quell-Label im Viewer/Multiviewer sichtbar:** UMD-artiges
   `textoverlay` (IS-04-Sender-Bezeichnung der Quelle) vor dem MJPEG-Zweig
   in `omp-viewer` bzw. pro Kachel vor dem Compositor in
   `omp-multiviewer`.

**Zwei Laufzeit-Abstürze per Live-Test gefunden (nicht durch `cargo
build`/`deno check` sichtbar):**
- `textoverlay`s `valignment`/`halignment` sind GEnums
  (`GstBaseTextOverlayV/HAlign`), keine Strings — `.property("valignment",
  "bottom")` kompiliert, schlägt aber zur Laufzeit fehl
  ("expected GstBaseTextOverlayVAlign, got gchararray"), sobald der Node
  tatsächlich ein Signal verarbeitet. `omp-viewer`/`omp-multiviewer`
  stürzten beim ersten echten Connect ab. Behoben durch
  `set_property_from_str` statt `.property()` (gleiche Konvention wie
  `videotestsrc`s `pattern`-Property an anderer Stelle im Code).
- Einmaliger OOM-Kill von `omp-multiviewer` (5,75 GB RSS) beobachtet,
  **nicht reproduzierbar** trotz gezielter Nachstellung (stabile Nutzung
  über mehrere Sekunden/mehrere Rebuild-Zyklen, auch bei nahezu
  gleichzeitigem Start mehrerer Quellen). Wahrscheinlichste Erklärung:
  Ressourcen-Engpass durch einen frischen `cargo build --workspace`
  unmittelbar zuvor auf einer Maschine mit nur 6,5 GB RAM, keine
  reproduzierbare Code-Ursache gefunden — im Blick behalten, aber nicht
  als Bug verbucht.

**Nebenbefund:** `nodes/omp-mediaio/src/mxl.rs`s Loopback-Test nutzt einen
**festen** Domain-Pfad (`/tmp/omp-mxl-test-domain`) statt eines pro Testlauf
isolierten Verzeichnisses — wiederholte manuelle Testläufe/unterbrochene
Läufe können ihn in einen inkonsistenten Zustand bringen (fehlende
`data`-Datei einer Flow), was den Test dann fälschlich als Regression
erscheinen lässt. Workaround: `rm -rf /tmp/omp-mxl-test-domain*` vor dem
nächsten Lauf. Nicht behoben (kein Umsetzungsschritt, nur Testhygiene) —
Kandidat für später (z. B. `tempfile`-Crate für einen echten Pro-Test-
Domain).

**Verifiziert:** `cargo build/test/deny` (inkl. der zwei neuen
mxl.rs-Tests), `deno check/test`, `go vet/test`, End-to-End per Live-
Browser-Test (Chromium CDP) mit echten Instanzen — alle vier UI-Bugfixes
und beide Absturz-Fixes am tatsächlich laufenden Node bestätigt, nicht
nur am kompilierten Code.

## 2026-07-13 — Großer Konzept-Ausbau (fable-Konsultation): Microservice-Distribution, Metrics/Auto-Migration, Ausfallsicherheit, professionelles UI, NDI/RTSP/RDMA, MXL/DMF-Metadatenebene

**Kontext:** Nutzeranforderung, ein detailliertes Konzept (für spätere
Umsetzung durch Sonnet) für mehrere, teils bereits als Lücke benannte
(§20), teils komplett neue Themen zu erarbeiten: Microservice-/Container-
Import/Versionierung/Verwaltung/Distribution auf gemischte Remote-Hosts
(eigene und Drittanbieter), Metriken-Sammlung über lokale/remote/Cloud-
Maschinen für automatisierte Migration bei Ausfällen/Engpässen,
Ausfallsicherheits-Gesamtkonzept, professionelles UI (Menüs,
UI-Verwaltung, Workflow-Katalog mit Definieren/Konfigurieren/Speichern/
Laden/Starten/Stoppen, Screenshot-Thumbnail, Titel/Beschreibung,
Suche), gemischter Betrieb Bare-Metal/VM (lokaler Cluster)/Cloud (z. B.
AWS), NDI/RTSP/RDMA fertig definieren, MXL/DMF-Metadatenebene — mit der
durchgehenden Leitlinie „so dynamisch wie möglich, so wenig hartkodiert
wie möglich".

**Vorgehen:** Kein neues Subsystem-Wildwuchs — jedes Thema wurde zuerst
gegen bereits bestehende Bausteine (§6.1–§6.4, §11.1, §13.5, §17–§20)
geprüft und nur die tatsächlich fehlende Konkretisierung ergänzt, nicht
dupliziert. Kurze Web-Recherche (fable) zu zwei Fakten, die sonst geraten
worden wären: `gst-plugin-ndi` ist Teil von `gst-plugins-rs`
(MPL-2, aktiv gepflegt) — passt direkt in den Rust-Node-Stack, NDI selbst
bleibt trotzdem eine bewusste, isolierte Lizenz-Ausnahme (proprietäre
Laufzeit-SDK); die EBU-DMF-Referenzarchitektur v2.0 (April 2026)
bestätigt das bereits gebaute Node-Contract-/Katalog-Modell und dass MXL
bereits eine Grain-/Timing-/Metadaten-Struktur mitbringt, definiert aber
keinen Asset-Metadaten-Standard.

**Ergebnis in `ARCHITECTURE.md`:**
- **§6.5/§6.6 (neu):** NDI/RTSP-Interop-Gateways als weitere
  `omp-mediaio`-Transporte (gerichtete Gateway-Nodes, NDI-Lizenz-Ausnahme
  explizit benannt); RDMA/RoCEv2-Aktivierungspfad konkretisiert
  (`transportHint`, `rdmaFabricId`-Claim/Release, weicher Fallback statt
  Start-Ablehnung).
- **§6.1-Erweiterung:** Metrics-Föderation über Bare-Metal/VM/Cloud (ein
  Schema, drei Quell-Adapter, kein AWS-SDK im Kern) + Eskalationsstufen
  `advisory`/`auto-confirm-window`/`auto` für automatisierte Migration,
  pro Workflow-Rolle konfigurierbar (gleiches Muster wie §17.1); Cloud-
  Kostenfaktor als optionaler weicher Scoring-Faktor.
- **§6.4-Erweiterung:** Registry-Föderation (mehrere Quellen, granulares
  Publisher-Vertrauen pro Quelle), Lazy-Pull vs. explizites Pre-Pull für
  Bare-Metal-Standorte mit schmaler Anbindung, Versions-/Rollback-
  Historie, Air-Gap als Konsequenz statt Sonderfall.
- **§18.8/§18.9 (neu):** Host-Klassen-Taxonomie Bare-Metal/VM/Cloud (Klasse
  ergibt sich aus Inventar-Signalen, kein hartkodiertes Feld); AWS-
  Ausbaustufen (Einzel-EC2 → k3s/EKS → ECR als Registry-Quelle), bewusst
  kein AWS-SDK/Terraform-Modul im Projekt.
- **§21 (neu):** Ausfallsicherheits-Gesamtkonzept — konsolidierende
  Tabelle über alle bisherigen Redundanz-Ebenen (§6.3/§6.1/§19/§20.1),
  neue Standort-/Regionsredundanz-Ebene (Config-Replikation günstig,
  echte Zweitstandort-Sendefähigkeit bewusst Nicht-Ziel), Empfehlung zur
  offenen §20.1-Frage (Option c, Zwischenlösung, als pragmatischer
  Standardweg — weiterhin Nutzer-Entscheidung, keine Festlegung).
- **§22 (neu):** Professionelles UI-Gesamtkonzept — Navigations-/Menü-
  Struktur, Design-System (Tokens, `ui/kit/`, Theming inkl.
  „Studio-Dark"), Workflow-Katalog als neue Kern-UI-Fläche (Rollen-
  basierter Designer-Modus des bestehenden Graph-Editors,
  Screenshot-Thumbnail per Wiederverwendung des MJPEG-Preview-
  Mechanismus, Titel/Beschreibung/Tags, Kachel-Grid, Volltextsuche),
  Node-Katalog-UI parallel dazu — durchgehend additive Felder, keine
  neue Node-Contract-Pflicht.
- **§23 (neu):** MXL/DMF-Metadatenebene — vier bisher vermischte
  Metadaten-Bedeutungen sauber getrennt (Flow-technisch/MXL,
  Node-Selbstbeschreibung/IS-12/14, Ancillary-Daten, neu: Asset-/
  Content-Metadaten), DMF-Recherche-Einordnung, bewusste Grenze zu MAM
  (bleibt §20.8-Nicht-Ziel).
- §20.1/§20.2/§20.3 bekommen Verweise auf §21/§22 (kein Duplikat,
  Priorisierungsfrage bleibt offen); §7-Phasenplan (P2-Zeile) um die
  neuen Abschnitte ergänzt, keine Zeitplan-Zahl geändert.

**Bewusst nicht getan:** keine neuen `UMSETZUNG.md`-C/D-Schritte (gleiches
Vorgehen wie bei §13/§19/§20 — erst Konzept, dann bei tatsächlicher
Priorisierung/Umsetzung als nummerierter Schritt konkretisieren); keine
Umbenennung/Renummerierung bestehender Abschnitte (alle neuen Inhalte als
neue §6.5/§6.6/§18.8/§18.9/§21–§23 bzw. datierte „Erweiterung"-Absätze in
§6.1/§6.4, um die vielen bestehenden Querverweise nicht zu brechen); keine
Entscheidung der offenen §20.1-Genlock-Frage, nur eine begründete
Empfehlung.

## 2026-07-13 — C13-Nachtrag 3: Instanz-Crash-Erkennung fertiggestellt (uncommitted Stand vorgefunden), C14/C15 als nächster Schritt aufgenommen

**Kontext:** Nutzeranforderung „fahre mit der Umsetzung fort, arbeite
eigenständig durch". Working Tree enthielt bereits einen vollständigen,
aber nicht committeten Stand für Instanz-Crash-Erkennung
(`internal/launcher`: `Crashed`/`CrashMessage` + `instance.crashed`-SSE-
Broadcast, `ui/graph/flow-canvas.ts`: Toast + rote Instanz-Zeile in der
Palette + „Entfernen", dazu unabhängig ein „Alle einpassen"-Button) —
offenbar Ergebnis einer vorherigen, nicht abgeschlossenen Sitzung. Statt
blind zu committen: zuerst regulär durch den Verifikationspfad aus
`UMSETZUNG.md` §0 geschickt.

**Verifikation:** `go vet/test` (orchestrator, inkl. neuem
`TestLauncherMarksUnexpectedExitAsCrashedAndBroadcasts`) grün; `deno
check/test` grün. Zusätzlich End-to-End im echten Dev-Setup
(`make start`, Podman-NATS/-Registry): ein temporärer, nicht committeter
Katalog-Eintrag (`exit 1` nach `sleep 1`) über die GUI gestartet, per
Chromium-CDP-Session (headless, `--remote-debugging-port` + Node-
WebSocket, wie in den C13-Nachträgen 1/2 etabliert — `--dump-dom` bleibt
für Mehrfach-fetch-Seiten unzuverlässig) verifiziert: Toast erscheint,
rote Instanz-Zeile mit `exit status 1: boom-from-test` erscheint,
„Entfernen" löscht serverseitig UND clientseitig, „Alle einpassen"
klickbar ohne Fehler. `deploy/catalog.json` danach auf den
Ausgangsstand zurückgesetzt (Diff-Check: keiner). Dokumentiert als
`UMSETZUNG.md` „C13-Nachtrag 3" (gleiches Format wie Nachtrag 1/2).

**Nächster Schritt:** C14/C15 (Playout-Automation-Controller) ist der
einzige noch offene Eintrag der Status-Checkliste — wird im Anschluss
mit einem Detailplan begonnen (`UMSETZUNG.md` verlangt das explizit „zu
Beginn von C14").

## 2026-07-13 — C14/C15 (`omp-playout-automation`): Playlist-Controller ohne eigene Pipeline, Detailplan + Umsetzung

**Kontext:** Letzter offener Eintrag der Status-Checkliste. Die
Kurzfassung in `UMSETZUNG.md` ließ bewusst einen Detailplan für den
Beginn von C14 offen — vier echte Design-Entscheidungen mussten dafür
zuerst am Code verifiziert werden (nicht geraten): Wie sind
`omp-player`s (C12) eigene Methoden/Items tatsächlich geformt (Code
gelesen: `append`/`load`/`remove`/`cue`/`take` bereits vollständig **im
Player selbst** vorhanden, Items sind Testmuster mit `durationMs`, kein
EOS-Konzept)? Wie löst `omp-video-mixer-me` (C10) Tally aus (Code
gelesen: nur über `crosspoint.select`+`crosspoint.cut`, das
`ProgramChanged`-Event, nicht über den Player)? Wie adressiert man einen
anderen, bereits laufenden Node ohne Orchestrator-Umweg (Code gelesen:
jeder Node hat seinen eigenen Descriptor-HTTP-Server, `href` aus IS-04)?
Wie bekommt die Automation ihre Ziel-Instanzen, ohne den Instanz-Launcher
zu ändern (Katalog kennt nur ein festes `env`, keine Start-Parameter)?

**Entscheidungen** (Details siehe `UMSETZUNG.md` C14/C15-Detailplan):

1. Ziel-Player/-Mixer über zwei neue **beschreibbare** Parameter
   (`targetPlayerLabel`/`targetMixerLabel`, PATCH über den bestehenden
   generischen Proxy) statt Launcher-/Katalog-Änderung — periodisch
   (2 s) per IS-04-Label-Discovery zu `href` aufgelöst, selbstheilend.
2. `playlist.rs` aus `c4-playlist-wip` wiederverwendet, aber
   umgedeutet: Items sind jetzt die vom Ziel-Player selbst vergebenen
   IDs (per `GET items`-Rückfrage gelernt, da die generische
   Methoden-Antwort keinen Rückgabewert liefert), nicht mehr
   Clip-URIs. Eine neue, additive `replace_all()`-Methode (mit Tests)
   ergänzt das Original, dessen `load()` nur ein einzelnes Item kannte.
3. `take()`/Auto-Advance treiben **beide** Ziele: Player-`cue`+`take`
   fürs Bild/Ton-Umschalten am Player selbst, danach
   Mixer-`crosspoint.select`+`crosspoint.cut`, weil Tally
   ausschließlich vom Mixer kommt (Player hat keinen eigenen
   Tally-Mechanismus) — sonst hätte `take()` den Player umgeschaltet,
   aber nie ein Tally-Event ausgelöst.
4. Auto-Advance über einen eigenen 200 ms-Dauer-Timer (`durationMs` pro
   Item), da der Player selbst kein EOS/Auto-Ende kennt (Items laufen
   endlos bis zum nächsten Cue/Take) — `playlist.rs`s `advance()`
   unverändert wiederverwendet.
5. Neuer, node-zu-node direkter HTTP-Client (`src/remote.rs`,
   `PeerClient`) statt Orchestrator-Umweg — jeder Node bringt seinen
   Descriptor-Server bereits mit; `RegistryClient::list_nodes()` neu in
   `omp-node-sdk::is04` für die Label→href-Auflösung.

**Verifiziert — mit echten Prozessen, nicht nur Mocks:**
`cargo build/test/deny`, `cargo audit` grün (14 neue Playlist-Unit-Tests
+ bestehende Suite inkl. `omp-mediaio`-MXL-Tests). End-to-end:
`omp-video-mixer-me` + `omp-player-video` + `omp-playout-automation` +
`omp-viewer` aus der GUI gestartet, Ziel-Labels per PATCH gesetzt
(`connected` → `true`), zwei Items per `append()` angelegt (IDs korrekt
vom Player übernommen — per `GET items`-Diff bestätigt), `take()`
geprüft: Mixer-`crosspoint.programInput` zeigt danach exakt die
Sender-ID des Ziel-Players (Take hat den Mixer nachweisbar
umgeschaltet, löst den bereits bestehenden Tally-Mechanismus aus).
Auto-Advance im `auto`-Modus über beide Playlist-Einträge bestätigt
(Player landet am Ende bei `currentItemId = item2`, `mode = onair`),
Ende-der-Liste stoppt korrekt ohne Loop. UI-Bundle live gegen den
echten Node gemountet (Chromium-CDP): zeigt „verbunden", Item-Liste,
Cue/Gecued-Zustand, gesetztes Ziel-Player-Label korrekt.

**Zwei Blocker beim Testaufbau gefunden, keine C14/C15-Bugs:** (a) der
Instanz-Launcher (Nachtrag 3, selber Tag) zeigte live, dass MXL-nutzende
Nodes ohne `deploy/dev/mxl.env` im selben Shell wie `make start`
abstürzen (`libmxl.so` nicht im `LD_LIBRARY_PATH`) — bereits bekannter
Dev-Gotcha, hier nur die Crash-Anzeige selbst erstmals live gesehen; (b)
ein zuvor mit `rm -rf` gelöschtes `/dev/shm/omp-mxl` muss als leeres
Verzeichnis existieren, bevor MXL eine Instanz erzeugen kann („Domain
path is not a directory"), sonst „Failed to create MXL instance" — reine
Testhygiene, kein Code-Fix.

**Ergebnis:** Meilenstein „Demo 4" (Regieplatz mit UND ohne
Automatisation vorführbar) erreicht. Damit ist die
`UMSETZUNG.md`-Status-Checkliste bis C15 vollständig abgehakt.

## 2026-07-13 — D1 (PostgreSQL für Layouts/Snapshots): Scope-Entscheidung + zwei echte Bugs gegen eine echte DB gefunden

**Kontext:** Phase C ist mit C15 vollständig abgeschlossen; `UMSETZUNG.md`
§6 sah „Detail-Schritte werden am Ende von Phase C konkretisiert" vor —
D1 war der einzige der sieben D-Bullets, der schon konkret genug
beschrieben war, um ohne weitere Rückfrage direkt begonnen zu werden
(„PostgreSQL für Layouts/Snapshots/Config statt Datei-Backend;
Migrationen; Verifikation: Neustart-Persistenz").

**Scope-Entscheidung („Config"):** Code gelesen, nicht geraten —
`internal/consoles/store.go` dokumentiert `role-bindings.json`
ausdrücklich als „handgepflegt, analog zu deploy/catalog.json … echte
Durchsetzung folgt mit D3", der Instanz-Launcher-Zustand
(`instances.json`) ist PID-Liveness-gebundenes Laufzeit-Bookkeeping,
kein Metadaten-Persistenz-Fall. Beide bleiben datei-basiert; „Config"
aus der D1-Kurzfassung hat aktuell keine konkrete Entsprechung jenseits
von Layouts/Snapshots — nichts stillschweigend übersprungen, nur nichts
erfunden, das es noch nicht gibt.

**Umsetzung:** `lib/pq` (reiner Postgres-Wire-Treiber, keine
Transitiv-Deps) als einzige neue Go-Dependency — dieselbe Ausnahme-
Kategorie wie `nats.go` (Schritt A6). Migrationen als embedded
`.sql`-Dateien + eigener, sehr kleiner Runner
(`orchestrator/internal/db`) statt eines Frameworks (golang-migrate/
goose) — für „ein paar sequenzielle Dateien, kein Down-Migrations-
Bedarf" unverhältnismäßig. `layouts.Store`/`snapshots.Store` intern auf
SQL umgestellt, öffentliche Methodensignaturen (`Get`/`Put`/`List`)
unverändert — keine Anpassung an Aufrufern (`httpapi`,
`snapshots.Service`) nötig, nur `NewStore(*sql.DB)` statt
`NewStore(dir)`. Podman-Dev-Fallback (`make up`) + Quadlet-Referenzdatei
nach demselben Muster wie NATS/Registry.

**Zwei echte Bugs, nur durch Testen gegen eine echte Postgres-Instanz
gefunden** (mit Mocks/Interfaces unsichtbar geblieben, wie schon bei
mehreren Live-Test-Funden in Phase C):

1. **Migrations-Race:** `go test ./...` startet jedes Go-Paket als
   eigenen Prozess — `db`-, `layouts`- und `snapshots`-Tests riefen
   `Migrate()` parallel gegen dieselbe Dev-Datenbank auf, was in ca.
   30–40 % der Läufe mit „duplicate key value violates unique
   constraint 'pg_type_typname_nsp_index'" fehlschlug: `CREATE TABLE IF
   NOT EXISTS` ist in Postgres nicht race-frei gegen gleichzeitige
   Erstversuche (der implizite Zeilentyp pro Tabelle kollidiert). Das
   wäre potenziell auch ein Produktions-Risiko (z. B. zwei gleichzeitig
   hochfahrende Orchestrator-Prozesse) gewesen, kein reines Test-Artefakt.
   Behoben mit `pg_advisory_lock` um die gesamte `Migrate()`-Funktion,
   auf einer einzelnen per `db.Conn()` gezogenen Verbindung (advisory
   locks sind session-gebunden — über den `*sql.DB`-Pool direkt hätte
   die Sperre nicht zuverlässig gewirkt). Dieselbe Technik ist bereits
   für Orchestrator-HA vorgesehen (`ARCHITECTURE.md` §19.3:
   Leader-Wahl über eine Postgres-Advisory-Lock) — hier schon einmal in
   echtem Einsatz. Über fünf Wiederholungsläufe danach durchgehend
   grün.
2. **JSONB kanonisiert, bricht Byte-Treue:** `TestPutOverwritesExisting`
   (layouts) schlug fehl — `Get()` lieferte `{"v": 2}` (mit Leerzeichen)
   statt der gespeicherten `{"v":2}`. Postgres' `JSONB`-Typ formatiert
   beim Speichern um (Whitespace, ggf. Schlüsselreihenfolge), anders als
   das ursprüngliche Datei-Backend, das rohe Bytes exakt zurückgab —
   für `layouts.Store`, dessen eigener Docstring „reines Opak-Speichern"
   verspricht, ein unbeabsichtigter Verhaltensbruch. Behoben durch
   Wechsel der Spalte auf `JSON` (bewahrt die Eingabe-Bytes exakt, keine
   Kanonisierung) — bewusst nur für `layouts`, nicht für `snapshots`:
   dort liest der Store den Inhalt ohnehin immer über Go-Structs
   (`json.Unmarshal`), Byte-Treue ist irrelevant, JSONBs kompaktere
   Binärspeicherung bleibt dort der bessere Default. Da diese Migration
   noch nirgends produktiv gelaufen war (erster Commit dieses Schemas),
   wurde `0001_init.sql` direkt korrigiert statt einer nachgeschobenen
   Fixup-Migration — nach einem echten Release wäre das nicht mehr
   zulässig.

**Nebenbefund, nicht behoben (kein D1-Bug):**
`TestLauncherStopSendsSigkillIfSigtermIgnored` (bereits aus C8, von
diesem Schritt nicht berührt) flackert unabhängig von D1 — vermutlich
zu knapp bemessene 500-ms-Warteschwelle unter Systemlast. Fünf
Wiederholungsläufe isoliert vom Rest der Suite: 4/5 grün, 1/5 rot.
Kandidat für später (Grace-Period erhöhen oder auf Polling statt
Einzelcheck umstellen), nicht Teil dieses Schritts.

**Verifiziert:** `go vet`/`go test` (gesamtes Orchestrator-Modul, gegen
echtes Postgres via `make up`) grün, mehrfach wiederholt zur
Race-Bestätigung. End-to-End: Layout + Snapshot über die laufende API
angelegt, Orchestrator-Prozess neu gestartet (Postgres läuft durch),
beide exakt wie gespeichert wieder abrufbar. Fail-Fast bei gestopptem
Postgres bestätigt (klare Fehlermeldung + Prozessabbruch statt stillem
Weiterlaufen ohne Persistenz).

## 2026-07-13 — D2 (AMWA NMOS Testing Tool): echten Tool-Lauf statt Doku-Zitat verwendet, Scope auf Registry begrenzt

**Kontext:** `UMSETZUNG.md` A9 hatte bereits einen deaktivierten
CI-Platzhalter-Job (`amwa-nmos-testing`, `if: false`) explizit auf D2
verschoben; C9 verschob den `tools/contract-check`-CI-Anschluss aus
demselben Grund ebenfalls hierher ("laufende Registry-/Node-Container").
Arbeitsregel §0.6/§0.9 verlangt, Tool-/Spezifikationsverhalten
nachzuschlagen bzw. **live zu verifizieren**, nicht aus der
Doku-Zusammenfassung zu übernehmen — deshalb das echte Image gezogen und
gegen die echte, laufende Registry + einen echten Mock-Node
durchgespielt, bevor irgendetwas in CI geschrieben wurde.

**Drei am echten Tool-Lauf widerlegte/bestätigte Annahmen aus der
Doku-Recherche:**

1. **Docker-Image-Entrypoint ignoriert CLI-Argumente.** Die offizielle
   Doku beschreibt `docker run … amwa/nmos-testing python3 nmos-test.py
   suite …` als gültige Non-Interactive-Aufrufform. Tatsächlich
   (`Dockerfile`/`run_nmos_testing.sh` von GitHub gelesen): der
   `ENTRYPOINT` ist `run_nmos_testing.sh`, das intern hart `python3
   nmos-test.py` **ohne** `"$@"` aufruft — jedes CMD-Argument wird
   stillschweigend verworfen, der Container startet immer den
   interaktiven Web-Server. Non-Interactive-Aufrufe brauchen
   `--entrypoint python3 … nmos-test.py suite …` (Entrypoint
   überschreiben), sonst hängt der Container als Server statt Tests
   auszuführen und zu beenden.
2. **IS-04-01/IS-05-01 gegen eigene Nodes: sofortiger Abbruch, nicht nur
   Teilausfall.** Erwartung vor dem Test: „einige Tests werden wegen der
   bekannten B1-Scope-Lücken fehlschlagen". Tatsächlich (IS-05-01 gegen
   den echten `nodes/mock`-Prozess, Port 9001): `GET
   /x-nmos/connection/v1.1/ → 404`, Testlauf endet sofort mit „No API
   found", 0 von N Tests ausgeführt — der fehlende Basis-Discovery-
   Endpunkt ist eine Voraussetzung für die gesamte Suite, kein einzelner
   Testfall darunter. Ergebnis: IS-04-01/IS-05-01 (und IS-05-02, das
   dieselbe Node-API-Voraussetzung teilt) aus dem CI-Scope genommen,
   nicht mit einer erwartungsgemäß roten, aber wertlosen Testliste
   „erledigt" markiert.
3. **`test_27`-Fehlschlag: Ursache durch Gegenexperiment belegt, nicht
   vermutet.** Erster Lauf gegen die reguläre `registry.json`
   (`registration_expiry_interval: 60`) zeigte `test_27` („Registry
   entfernt Ressourcen nicht nach Heartbeat-Timeout") als Fail.
   Quellcode von `IS0402Test.py::test_27` gelesen: der Test wartet nur
   `CONFIG.GARBAGE_COLLECTION_TIMEOUT + 1` Sekunden
   (`nmostesting/Config.py`: 12) und prüft dann auf 404 — bei 60 s
   Ablaufzeit prüft der Test zwangsläufig zu früh. **Gegenprobe:**
   Registry testweise mit `registration_expiry_interval: 12` neu
   gestartet, IS-04-02 erneut gelaufen — `test_27` war grün. Damit
   bestätigt, nicht nur vermutet: die Ursache ist ausschließlich der
   Config-Unterschied, kein Registry-Bug. Konsequenz bewusst gezogen:
   **60 s bleibt der Produktions-/Dev-Wert** (Toleranz gegen
   Heartbeat-Aussetzer wichtiger als AMWA-Tool-Kompatibilität), `test_27`
   wird als dokumentierte, begründete Abweichung geführt statt die
   Konfiguration für den Test zu verschlechtern. Nebenbefund aus
   demselben Gegenexperiment: bei 12 s Ablaufzeit tauchten mehrere neue
   „Could Not Test"-Ergebnisse auf (Fixtures liefen der restlichen Suite
   mitten im Testlauf ab) — ein zusätzlicher Beleg, dass 12 s für den
   **gesamten** Testlauf ungeeignet wäre, nicht nur eine für `test_27`
   isoliert bessere Einstellung.

**Ergebnis:** `tools/nmos-conformance-check` (neues Go-Modul, eigenes
`go.mod` wie `tools/contract-check`) wertet die AMWA-JSON-Ausgabe
gegen eine explizite Allow-Liste aus (`--allow
"testname=Begründung"`), Exit-Code 1 bei jedem nicht gelisteten Fail.
CI-Job `amwa-nmos-testing` nicht mehr `if: false`, startet Registry +
Testing-Tool-Container, lädt IS-04-02, wertet mit den drei oben
begründeten Ausnahmen aus, sichert die Rohdaten als Artefakt.

**Verifiziert:** `go vet`/`go test` für `tools/nmos-conformance-check`
(7 Tests, inkl. Fixture-Daten aus dem echten Tool-Lauf) grün; das Tool
selbst gegen die beiden real erzeugten JSON-Ausgaben (60 s- und
12 s-Lauf) durchgespielt — liefert ohne Allow-Liste Exit 1 mit den drei
erwarteten Fails, mit der finalen Allow-Liste Exit 0. Die
GitHub-Actions-YAML selbst konnte in dieser Umgebung nicht durch einen
echten Workflow-Run verifiziert werden (kein GitHub-Actions-Runner
lokal verfügbar) — alle darin verwendeten Einzelbefehle (Registry-Start,
Entrypoint-Override, Tool-Aufruf, Auswertung) sind aber exakt die zuvor
lokal gegen Podman verifizierten Befehle, nur mit `docker` statt
`podman` (auf GitHub-Actions-Ubuntu-Runnern vorinstalliert) — der erste
tatsächliche Push/PR-Lauf ist die verbleibende Nagelprobe.

## 2026-07-13 — D3 Teil 1 (mTLS Orchestrator↔Nodes): Scope-Split begründet, drei echte Bugs im Live-Test gefunden

**Kontext:** Letzter offener Punkt der Status-Checkliste war D3 („step-ca
+ mTLS Orchestrator↔Nodes, IS-10/OAuth2 für die UI"). Vor Beginn geprüft:
bündelt drei große, unabhängige Themen (mTLS-Transport, IS-10/OAuth2-
Nutzer-Auth, §12-Rollenmodell). Arbeitsregel „genau ein Schritt pro
Sitzung" plus die reale Größe jedes Einzelthemas (mTLS allein berührt
zwei Sprachen × N Node-Typen) sprachen gegen einen Versuch, alles auf
einmal zu bauen.

**Scope-Split-Begründung:** `ARCHITECTURE.md` §18.3 (Host-Agent-
Bootstrap, für D6/D7 vorgesehen) setzt step-ca bereits als gegeben
voraus („bekommt … ein mTLS-Client-Zertifikat von step-ca ausgestellt —
dasselbe … Muster, das step-ca für Orchestrator↔Node ohnehin schon
vorsieht") — mTLS ist damit eine Voraussetzung für spätere Schritte.
IS-10/OAuth2 und das §12-Rollenmodell blockieren dagegen nichts
Bestehendes: die C13-Rollen-Stub-Prüfung funktioniert unverändert weiter.
Deshalb: dieser Schritt deckt nur mTLS Orchestrator↔Nodes ab, IS-10/
OAuth2 + §12 bleiben als D3 Teil 2 offen (`UMSETZUNG.md` aktualisiert).

**Weitere, während der Umsetzung gezogene Scope-Grenze:** nur die
Go-Seite (Orchestrator-Client, `nodes/mock`-Server). Der
Rust-`omp-node-sdk`-Server nutzt `tiny_http`, das kein TLS eingebaut hat
— eine echte Lösung bräuchte entweder eine TLS-Terminierungsschicht
davor oder einen Bibliothekswechsel, und würde potenziell alle zehn
Rust-Node-Typen gleichzeitig berühren (hohes Blast-Radius-Risiko für
bereits verifizierte Demo-1–4-Flows). Bewusst nicht in dieser Sitzung
riskiert, klar als Restscope dokumentiert statt still ausgelassen.

**Design-Entscheidung „opt-in, Default aus":** `OMP_MTLS_ENABLED` schützt
alle bisher verifizierten Flows — ohne die Variable verhält sich der
Orchestrator exakt wie vor D3. Der Orchestrator-Client wählt automatisch
zwischen mTLS und Klartext anhand des Schemas im Node-`href`
(`http://`/`https://`), ein gemischter Bestand aus mTLS- und
Klartext-Nodes (unvermeidlich, solange nur `nodes/mock` mTLS kann)
funktioniert dadurch ohne Sonderfall-Code gleichzeitig.

**Drei reale Probleme, alle erst durch echten Live-Test sichtbar
geworden** (Muster wiederholt sich aus früheren Schritten — Mocks/
Unit-Tests allein hätten keinen davon gefunden):

1. **Rootless-Podman-Bind-Mount-Berechtigung:** step-ca lief als
   nicht-root-Nutzer im Container, konnte aber nicht in das
   host-bind-gemountete `.run/step-ca` schreiben
   (`/entrypoint.sh: line 53: /home/step/password: Permission denied`,
   in einer Endlosschleife). Ursache: UID-Mismatch zwischen Container-
   internem Nutzer und Host-Nutzer bei rootless Podman ohne explizite
   User-Namespace-Abbildung. Behoben mit `--userns=keep-id` (Standard-
   Podman-Fix für genau diesen Fall) — sowohl beim step-ca-Container
   selbst als auch beim separaten Wegwerf-Container in
   `mtls-issue-cert.sh` (derselbe Fehler trat dort für das **Lesen**
   der CA-Konfiguration erneut auf, bis auch dort gesetzt).
2. **step-ca lehnt lange Zertifikatslaufzeiten ab:** ein Versuch mit
   `--not-after 2160h` (90 Tage) wurde mit „more than the authorized
   maximum certificate duration of 24h1m0s" abgelehnt —
   `authority.claims.maxTLSCertDuration` in `ca.json` steht per Default
   auf 24h. Skript auf `--not-after 23h` angepasst; eine echte
   Erneuerungs-Automatik (`step ca renew --daemon` o. Ä.) oder eine
   angehobene `maxTLSCertDuration` bleiben für einen Produktionsbetrieb
   offener Scope, für eine Dev-/Verifikationssitzung reicht das
   knapp-24h-Zertifikat.
3. **Echter Bug, kein Test-Artefakt — SAN/Hostname-Mismatch:** das
   erste ausgestellte Node-Zertifikat trug nur das Label
   ("mock-node") als Subject/SAN. Ein `curl`-Test **vor** der
   Erfolgsmeldung (nicht danach, um genau diese Art Fehler nicht zu
   übersehen) deckte auf: „SSL: no alternative certificate subject
   name matches target host name 'localhost'" — dasselbe Problem hätte
   den echten Orchestrator-Proxy identisch getroffen, da Go's
   `crypto/tls` genauso den `ServerName` gegen die Zertifikats-SANs
   prüft. Behoben durch zusätzliche `--san localhost --san 127.0.0.1`-
   Parameter im Ausstellungs-Skript (`mtls-issue-cert.sh` nimmt jetzt
   optionale Extra-SAN-Argumente).

**Verifiziert (echte Prozesse, nicht nur curl-Simulation):**
1. Unautorisierter Zugriff: `curl -k` ohne Client-Zertifikat gegen
   einen mTLS-aktivierten Mock-Node → TLS-Verbindungsabbruch
   (`bad certificate` serverseitig geloggt).
2. Autorisierter Zugriff **über den echten Orchestrator-Proxy-
   Codepfad**, nicht nur curl-Emulation: `GET
   /api/v1/nodes/<id>/descriptor` und `PATCH
   /api/v1/nodes/<id>/params/gain` über den laufenden Orchestrator
   (mit `OMP_MTLS_ENABLED=true`) gegen den mTLS-Node erfolgreich.
3. Gemischter Bestand: derselbe mTLS-aktivierte Orchestrator sprach
   gleichzeitig erfolgreich einen **Klartext**-Mock-Node an (kein
   Sonderfall-Code nötig, `http.Transport` wählt TLS nur für
   `https://`-Ziele).
4. Default (mTLS aus): Orchestrator ohne `OMP_MTLS_ENABLED` verhält
   sich exakt wie vor D3 (kein „mtls enabled"-Log, Klartext-Node
   weiterhin erreichbar) — keine Regression für die bereits
   verifizierten Demo-1–4-Flows.
5. `go vet`/`go test` für `orchestrator` und `nodes/mock` grün,
   inklusive neuer `internal/mtls`-Pakete (Zertifikate für Unit-Tests
   zur Laufzeit selbst erzeugt, kein externer step-ca nötig, um die
   Kernlogik zu testen).

**Ergebnis:** `orchestrator/internal/mtls` (Client-TLS),
`nodes/mock/internal/mtls` (Server-TLS, `ClientAuth:
RequireAndVerifyClientCert`), `make mtls-up`/`mtls-down`/
`mtls-issue-certs` (von `make up`/`down` bewusst getrennt, da opt-in),
`deploy/dev/mtls-issue-cert.sh`, `deploy/quadlets/omp-step-ca.container`
als Produktions-Referenz. D3 Teil 2 (IS-10/OAuth2, §12-Rollenmodell)
bleibt offener, noch nicht terminierter Schritt.

## 2026-07-13 — D4 (`omp-mediaio::st2110` + `omp-srt-gateway`): Payload-Format am echten gst-launch-Lauf verifiziert, dann erst Rust geschrieben; echter ffmpeg-Interop-Nachweis

**Kontext:** Letzter offene Punkt vor D5. Anweisung: "2110-Implementierung
(Software, st2110-fähige GStreamer-Elemente) + SRT-Gateway-Node;
Verifikation soweit ohne Spezial-Hardware möglich (Loopback, Interop mit
ffmpeg/OBS)". Vor dem Schreiben von Rust-Code erst geprüft, was
tatsächlich schon da ist: `rtp.rs` (C3) nutzt bereits `rtpvrawpay` —
GStreamers RFC-4175-Payloader, dieselbe Payload-Struktur, auf der SMPTE
ST 2110-20 aufbaut — nur fest auf 640×480 verdrahtet und nur Sender,
keine Empfänger-Seite. Statt das zu duplizieren: neues Modul
`st2110` generalisiert (konfigurierbare Auflösung/Framerate) und
ergänzt die fehlende Empfänger-Seite; `rtp.rs` bleibt für den
Playout-Node (C1–C3) unverändert.

**Arbeitsweise (Standards nicht raten, §0.6):** Vor jeder Zeile Rust-Code
das exakte Payload-/Caps-Format per `gst-inspect-1.0`/echtem
`gst-launch-1.0`-Lauf verifiziert statt aus dem Gedächtnis anzunehmen —
u. a. dass `width`/`height`/`depth` in den RTP-Caps als **String**-Felder
kodiert sind (nicht int), und dass `rtpvrawdepay` die Framerate NICHT
zuverlässig aus dem RTP-Strom rekonstruiert (`framerate=(fraction)0/1`)
— deshalb ein zusätzliches `videorate`+`capsfilter` auf der
Empfänger-Seite, das die bekannte Ziel-Framerate erzwingt.

**Scope-Entscheidungen** (dokumentiert, s. `UMSETZUNG.md` D4 für die
volle Begründung): kein Audio (ST 2110-30), keine PTP-Zeitbasis (Free-
Run, `ARCHITECTURE.md` §8 tolerierte das bereits explizit), keine
dynamische IS-05-Verbindungsverwaltung für die 2110-/SRT-Seite des
Gateways (Prozess-Start-Konfiguration statt Drag&Drop, analog zu
`omp-switcher`s "0 Receiver in v0", C7) — `omp-srt-gateway` registriert
sich deshalb ohne IS-04-Sender/-Receiver, was `tools/contract-check`
bereits als dokumentierten Skip-Fall kennt (nicht neu erfunden).

**`omp-srt-gateway`-Design:** gerichtet je Instanz
(`OMP_SRT_GATEWAY_DIRECTION=uplink|downlink`, Profil-Muster wie
`omp-player`s `OMP_PLAYER_PROFILE`). Uplink nutzt `St2110VideoInput`
unverändert (liefert `tail` = rohes Videosignal) und hängt selbst
`rtpvrawpay ! srtsink` an — RTP-über-SRT ist ein reales, in der
Rundfunk-Branche übliches Contribution-Muster, keine Erfindung dieses
Projekts. Downlink baut `srtsrc ! rtpjitterbuffer ! rtpvrawdepay` und
übergibt das letzte Element als `upstream` an
`St2110VideoOutput::new` — beide Richtungen maximieren Wiederverwendung
von `st2110`, keine eigene RTP-Logik im Gateway-Node selbst.

**Echter Interop-Nachweis mit ffmpeg (nicht nur GStreamer-intern):**
`St2110VideoOutput::sdp()` erzeugt eine SDP-Datei; ffmpeg (mit
`-protocol_whitelist file,rtp,udp`) las sie, erkannte Auflösung/Format/
Framerate korrekt aus den `a=fmtp`-Parametern und dekodierte reale
PNG-Frames aus einem laufenden GStreamer-Sender — der SMPTE-Farbbalken
im Ergebnisbild visuell bestätigt, nicht nur am Exit-Code. Ein
zeitkritischer Fallstrick dabei gefunden (kein Protokoll-Bug): startete
ffmpeg NACH dem Sender, kamen 0 Frames an, weil die ersten UDP-Pakete
vor dem Binden des Empfänger-Sockets verloren gingen — mit Empfänger
zuerst (dieselbe Reihenfolge-Regel wie beim `st2110`-Unit-Test) liefen
alle Frames sauber durch.

**`omp-srt-gateway` end-to-end mit echten Prozessen verifiziert:**
Uplink (2110→SRT) — ein unabhängiger GStreamer-SRT-Listener empfing über
20.000 echte SRT-Pakete aus einem eingespeisten 2110-Strom. Downlink
(SRT→2110), vollständiger Rundweg — ein simulierter „Remote"-SRT-Sender
(GStreamer, `mode=listener`, unser Gateway ruft als `caller` an) →
unser Gateway → ein unabhängiger 2110-UDP-Empfänger, Caps korrekt bis
zum `fakesink` verhandelt. `make contract NODE_URL=...` PASS gegen eine
echte laufende Instanz.

**Verifiziert:** `cargo build/test` (Workspace, inkl. neuem
`st2110`-UDP-Loopback-Test, mehrfach wiederholt — kein `libmxl.so`
nötig, reines GStreamer), `cargo deny check`/`cargo audit` grün, keine
neue Dependency (SRT-Elemente sind bereits Teil der vorhandenen
GStreamer-Installation, `srtsink`/`srtsrc` mit Rank "primary").

## 2026-07-14 — D3 Teil 2 (Nutzer-/Rollenmodell, ARCHITECTURE.md §12): echte Anmeldung statt Stub-Header, Rollenbindungen von Datei nach Postgres

**Kontext:** Letzter offene D3-Restscope (mTLS war Teil 1, 2026-07-13).
Löst den seit C13 bekannten, dokumentierten Zustand ab: der "aktuelle
Nutzer" war ein per Header/Query-Param/localStorage trivial spoofbarer
Stub, keine echte Zugriffskontrolle. Umgesetzt: lokale Nutzerkonten +
Token-Ausstellung (§12 Punkt 1, ohne AD), Rollenbindungs-Tripel-
Durchsetzung zentral im Orchestrator (§12 Punkt 2/3), Audit-Log (§12
Punkt 4).

**Scope-Entscheidung — AD/LDAP nicht in dieser Runde:** §12 Punkt 1
nennt AD/LDAP(S) als zweite Identitätsquelle. Es gibt auf der
Single-Host-Dev-Maschine keinen echten Verzeichnisdienst, gegen den sich
ein LDAP-Bind sinnvoll verifizieren ließe — genau der in `UMSETZUNG.md`
§0 Punkt 7 ausgeschlossene Fall ("nichts einbauen, das nur mit
Infrastruktur testbar wäre, die hier nicht existiert"). `internal/auth`
kapselt die Nutzerquelle hinter einem schmalen Store-Typ, den `httpapi`
nur über ein Interface (`AuthService`) kennt — eine zweite,
LDAP-bindende Implementierung ist additiv möglich, ohne Rest anzufassen.
Bleibt offener D3-Restscope, dokumentiert statt stillschweigend
ausgelassen.

**Bootstrap-Muster aus PIPELINE CONTROLLER übernommen:** "Auth
deaktivierbar solange kein Nutzer angelegt ist" — genau das dort
bewährte Muster (`docs/decisions.md`/`ARCHITECTURE.md` §12 zitiert es
bereits als Vorbild). Umgesetzt als automatischer Bypass in
`internal/httpapi/auth_middleware.go:authGate.authenticate`:
`UserCount()==0` lässt jede Anfrage ungeprüft durch. Ergebnis: alle
bisher verifizierten Demo-1–4-Flows laufen unverändert weiter, solange
niemand einen Nutzer anlegt — kein Regressionsrisiko für die bestehende
Dev-Nutzung. `POST /api/v1/auth/users` ist deshalb im Bootstrap-Fall
unauthentifiziert erreichbar (sonst Henne-Ei-Problem: niemand könnte
sich je den ersten Zugang verschaffen); der Handler selbst vergibt dem
allerersten angelegten Nutzer automatisch eine Wildcard-`admin`-Bindung.

**Passwort-Hashing: bcrypt (`golang.org/x/crypto/bcrypt`), keine
Eigenbau-KDF.** Ausnahme von der Minimal-Dependency-Regel (§0 Punkt 5),
aber die richtige: Go hat keine Salting/Cost-Factor-KDF in der
Standardbibliothek, ein eigenes PBKDF2/Scrypt-Äquivalent aus
`crypto/sha256` zusammenzusetzen wäre genau das in §0 Punkt 6/9
ausgeschlossene "an Standards raten". `golang.org/x/crypto` war zudem
bereits transitive Abhängigkeit (`nats.go`) — nur direkt importiert,
keine neue Abhängigkeitswurzel (`go.mod`-Diff: eine Zeile von
`// indirect` zu direkt verschoben).

**JWT: handgebautes minimales HS256 (`internal/auth/jwt.go`), keine
Bibliothek.** Anders als bei bcrypt hier die umgekehrte Abwägung: der
gebrauchte Umfang ist ein Algorithmus, ein festes Claim-Set, keine
JWKS/Multi-Issuer-Rotation — HS256-Sign/Verify ist mit `crypto/hmac` +
`encoding/json` + `encoding/base64` aus der Standardbibliothek in unter
100 Zeilen korrekt umsetzbar (Lehrbuch-HMAC-Anwendung, kein
KDF-Design wie bei Passwort-Hashing), eine externe Bibliothek
(`golang-jwt/jwt` o. Ä.) wäre hier Overhead ohne Gegenwert. Token-TTL 12h
(eine typische Sendeschicht), kein Refresh-Mechanismus (bräuchte
Revocation-Zustand, der noch nicht existiert — bewusster Scope-Schnitt).

**Rollenbindungen: `data/role-bindings.json` → Postgres
(`role_bindings`-Tabelle, `db/migrations/0002_auth.sql`).** Gleiche
Bindungs-Semantik wie der C13-Stub (Subject/NodeID/Verb), jetzt per
Admin-API verwaltbar (`GET/POST /api/v1/admin/role-bindings`, `DELETE
.../{id}`) statt Handbearbeitung einer Datei. `internal/consoles`
bezieht Bindungen jetzt über ein `BindingLoader`-Interface von
`internal/authz` statt über einen dateibasierten `Store` — reiner
Quellwechsel, `Resolver.Resolve`s Logik unverändert.

**Verb-Zuordnung pro Endpunkt-Gruppe** (§12 Punkt 2: view/operate/
configure/admin), umgesetzt in `internal/httpapi/server.go`:
- Node-gescoped (`params`/`methods`-PATCH/POST, A8): `operate` auf der
  Node-Rolle (`consoles.NodeRoleID`, dieselbe stabile Instanz-ID wie
  bei der Operator-Console, §14 — eine Bindung deckt beides ab).
- Global auf einer `"*"`-Bindung (kein Node-Bezug, da es noch keine
  echten Workflow-Objekte gibt, D7): Graph-Verkabelung, Layouts,
  Snapshots erstellen/anwenden → `configure`; Instanz-Launcher
  (Start/Stop), Nutzer-/Rollenbindungs-Verwaltung, Audit-Log-Lesen →
  `admin` (deckungsgleich mit der bereits in ARCHITECTURE.md §6.4
  getroffenen Aussage "Katalog-Verwaltung ist eine administrative
  Rolle").
- Alle sonstigen GETs (Node-Liste, Graph, Layouts, Snapshots, Katalog,
  Instanzen, Konsolen) verlangen nur eine gültige Anmeldung, keinen
  spezifischen Verb/Node-Scope — es gibt aktuell nur den einen
  impliziten Workflow (`consoles.StubWorkflowID`), feingranulare
  Sichtbarkeits-Filterung ist erst mit echten Workflow-Objekten (D7)
  sinnvoll (§12 Punkt 3 erlaubt das ausdrücklich: "Filterung ist
  Komfort, Durchsetzung bleibt beim Orchestrator").

**SSE-Endpunkt (`/api/v1/events`) braucht eine zweite Token-Quelle:**
die Browser-`EventSource`-API kann keine eigenen Header setzen (Web-
Plattform-Einschränkung, kein Design-Fehler). `bearerToken()` akzeptiert
deshalb zusätzlich `?access_token=` als Fallback — dieselbe, in der
Praxis übliche Lösung für Streaming-/WebSocket-Endpunkte mit
Token-Auth.

**UI (`ui/shell/auth.ts`):** globaler `fetch()`-Wrapper statt Anpassung
der >15 direkten `fetch(...)`-Aufrufe in `flow-canvas.ts`/
`console-view.ts`/`ui-bundle.ts` — hängt den Bearer-Header für jede
`/api/v1/`-Anfrage an, ein Einstiegspunkt statt vieler Änderungsstellen,
im Kommentar ausdrücklich als bewusste Entscheidung markiert (sähe sonst
wie ein Versehen aus). Login-Overlay ersetzt das C13-Stub-Nutzer-Widget;
erscheint nur, wenn `GET /api/v1/auth/whoami` `authRequired: true`
meldet — im Bootstrap-Zustand (kein Nutzer angelegt) bleibt die Shell
optisch exakt wie vor diesem Schritt.

**Verifiziert (echte Prozesse, nicht nur Unit-Tests):** `go build/vet/
test` (alle Pakete inkl. neuer `internal/auth`/`internal/authz`/
`internal/audit`, Postgres-Tests bewusst gegen eine echte, per `make up`
gestartete Instanz laufen lassen, nicht nur mit `t.Skip` durchgewunken —
beim ersten Anlauf liefen sie tatsächlich in den Skip-Zweig, weil die
Podman-Container seit der letzten Sitzung nur `Created`, nicht
`Up` waren; nach `make up` erneut mit `-count=1` verifiziert, dass sie
wirklich laufen, nicht nur cachen), `deno check`/`deno test` grün.
End-to-end per `curl` gegen eine echte laufende Orchestrator-Instanz:
Bootstrap-Zustand offen (`whoami` → `authRequired:false`, `GET
/api/v1/nodes` ohne Token → 200); erster Nutzer per unauthentifiziertem
`POST /api/v1/auth/users` angelegt → Durchsetzung schaltet sich
automatisch scharf (`GET /api/v1/nodes` ohne Token jetzt → 401); Login
liefert Token, damit wieder 200; zweiter Nutzer ohne Bindung bekommt 403
auf einen Node-PATCH, nach `admin`-erteilter `operate`-Bindung auf
dieselbe Node-Rolle 404 (Node existiert nicht, aber die Autorisierung
lässt jetzt durch — der Unterschied zwischen 403 und 404 beweist die
Durchsetzung), 403 auf `configure`-Endpunkte (nur `operate` gebunden)
und auf Admin-Endpunkte; Audit-Log zeigt alle Schreibzugriffe korrekt
mit Nutzername/Status/NodeID; SSE mit `?access_token=` verbindet, ohne
Token 401; falsches Passwort 401, doppelter Nutzername 409. Browser-Test
per CDP (Chromium headless + Node-WebSocket, gleiche Methode wie
C13-Nachtrag 1–3): Zero-User-Zustand zeigt weiterhin direkt den
Flow-Editor ohne Login-Formular; nach Bootstrap eines Nutzers zeigt ein
Reload das Login-Formular statt des Editors; Formular ausfüllen +
Absenden lädt den Flow-Editor, zeigt "Angemeldet als …" und legt das
Token in `localStorage` ab; keine Konsolen-Fehler/Exceptions während des
gesamten Ablaufs. Kein Bug gefunden (anders als bei den meisten
vorherigen Schritten) — Testkonten nach der Verifikation wieder aus der
DB entfernt, damit die Standard-Dev-Umgebung wie vor diesem Schritt ohne
Login startet, bis jemand bewusst einen echten Nutzer anlegt.

**Offener D3-Restscope:** AD/LDAP-Anbindung (s. o.), Token-Refresh/
-Revocation, feingranulare Sichtbarkeits-Filterung pro Workflow (wartet
auf D7).

## 2026-07-14 — D5-prep: „media-ready"-Signal im Node-Contract (ARCHITECTURE.md §5 Punkt 6), bevor die SDK-Doku (D5) geschrieben wird

**Kontext:** Vor D5 (SDK-Doku + Node-Tutorial) geprüft, ob der Node-
Contract wirklich stabil genug ist, um dokumentiert zu werden.
`UMSETZUNG.md`s D6-Übersicht flaggt explizit: „Node-Contract-Grundlage
(State-Export/Import + Readiness-Signal, §5 Punkt 6) muss vor dem
SDK-v1-Freeze (Ende Phase C) stehen … Nachrüsten nach SDK-Freeze wäre
ein Breaking Change für alle Community-Nodes." Phase C ist fertig, das
Signal fehlte noch — genau der in §5 beschriebene, noch nicht
eingelöste Punkt. Da es noch keine echten Community-Nodes gibt (P2 noch
nicht erreicht), ist das Risiko eines Breaking Change aktuell gleich
null, aber genau deshalb der günstigste Zeitpunkt, es sauber
nachzuholen, bevor D5 die Doku dazu schreibt.

**Scope-Klärung:** §5 Punkt 6 nennt zwei Dinge — (a) „vollständigen
Parameterzustand über den bestehenden Descriptor exportier- und
reimportierbar machen" ist bereits erfüllt: der generische Descriptor +
GET/PATCH-Params-Mechanismus (A8) macht das für jeden Node-Typ ohne
Sondercode möglich, `internal/snapshots` (B7) ist der laufende Beweis
(liest/schreibt exakt so den kompletten Parameterzustand). Kein
Zusatzcode nötig. (b) das „media-ready"-Signal existierte dagegen
nirgends (`grep` über Rust/Go/TS bestätigt) — das ist der tatsächlich
neue Teil dieses Schritts.

**Design: drei Zustände statt eines optionalen Flags mit Default
„bereit".** `omp_node_sdk::MediaReadySource` (`nodes/omp-node-sdk/src/
node.rs`):
- `NotApplicable` — kein Medien-I/O (Control-Plane-Node, `senders`/
  `receivers` leer, z. B. `omp-playout-automation`) → sofort `true`.
- `Unknown` — hat Medien-I/O, aber noch keine Probe verdrahtet →
  konservativ immer `false`, um keine ungeprüfte Bereitschaft
  vorzutäuschen.
- `Probe(Arc<dyn Fn() -> bool + Send + Sync>)` — echte Abfrage bei jedem
  Health-Tick.

Ein einzelnes `Option<Probe>` mit `None ⇒ true` (analog zu anderen
optionalen SDK-Feldern) wäre hier die falsche Default-Richtung gewesen:
für einen echten Medien-Node hieße "nicht verdrahtet" dann fälschlich
"sofort bereit" — eine Lüge, die das ganze Signal wertlos machen würde.
Die dritte Variante (`Unknown`) verhindert das, erzwingt aber, dass
jeder der zwölf `NodeConfig`-Konstruktionsorte sich bewusst einordnet
(Rust-Exhaustiveness macht das nicht optional).

**Transportweg: NATS-Health (`omp.health.<id>`), nicht Descriptor.**
`ARCHITECTURE.md` §6.1 Punkt 3 trennt "Health" und "tatsächlich
fließende Medien" ohnehin als zwei verschiedene Prüfungen einer
künftigen Make-before-break-Migration — das Signal passt inhaltlich zum
bestehenden, periodisch gepushten Health-Herzschlag (`health::Status`,
identisches Schema in Rust-SDK und Go-Mock-Node), nicht zum Descriptor
(der ist Pull-basiert und für Parameter/Methoden gedacht, nicht für
einen Liveness-artigen Zustand). Kein neues Transportmittel, kein
Orchestrator-Code geändert (der abonniert `omp.>` bereits generisch).

**Konkrete Probe: „mindestens ein Buffer ist geflossen", nicht
byte-genaue Grain-Bestätigung.** Für `omp-source` (als erster, echt
verdrahteter Nachweis) wiederverwendet: der bereits seit C2/C5
existierende FPS-Mess-Buffer-Zähler an der internen `fakesink`-Abzweigung
(`video_buffers: Arc<AtomicU64>`) bekommt ein zusätzliches, nicht
zurückgesetztes Sticky-Flag (`video_flowed: Arc<AtomicBool>`), das beim
ersten beobachteten Buffer einmalig auf `true` kippt — dieselbe
`tee`-Abzweigung speist gleichzeitig den tatsächlichen MXL-Ausgang, der
Video-Zweig ist also ein ehrlicher Indikator für "die Pipeline produziert
wirklich Bild" (kein `pipeline.set_state()`-Rückgabewert, der nur
"Übergang angestoßen" bedeutet, nicht "läuft tatsächlich"). Der
Audio-Zweig wird nicht separat geprüft (dokumentierte Vereinfachung,
gleicher Umfang wie die bestehende FPS-Messung).

**Bewusst nicht in diesem Schritt:** Probes für die übrigen acht
Medien-Node-Typen (`playout`, `omp-switcher`, `omp-player`,
`omp-video-mixer-me`, `omp-audio-mixer`, `omp-multiviewer`, `omp-viewer`,
`omp-srt-gateway`) — alle bekommen `MediaReadySource::Unknown` (meldet
ehrlich „noch nicht geprüft", nicht „bereit"), Verdrahtung ist
mechanische Folgearbeit nach demselben `omp-source`-Muster, mangels
Zeit in dieser Sitzung nicht für alle acht einzeln durchgeführt (jede
Pipeline hat leicht unterschiedliche interne Struktur, hätte
oberflächliches Copy-Paste ohne echtes Lesen jeder Datei bedeutet).
`tools/contract-check` (C9) bleibt unverändert — es ist ein reiner
HTTP-/Registry-Checker, eine `media_ready`-Prüfung würde einen
NATS-Client darin brauchen; ebenfalls dokumentierte Folgearbeit, kein
stiller Gap.

**Verifiziert (echte Prozesse):** `cargo build/test --workspace`
(inkl. `omp-mediaio`-MXL-Tests, `deploy/dev/mxl.env` gesourct), `cargo
deny check`/`cargo audit` grün; Go-Mock-Node `go build/vet/test` grün.
Live gegen drei echte, gleichzeitig laufende Prozesse per NATS-
Subscription auf `omp.health.>` bestätigt, dass alle drei
`MediaReadySource`-Varianten das erwartete, unterschiedliche Ergebnis
liefern (kein hartkodiertes `true`): `omp-source` (`Probe`, echter
Buffer-Fluss) → `media_ready:true`; `omp-playout-automation`
(`NotApplicable`, kein Medien-I/O) → `media_ready:true`; `omp-viewer`
(`Unknown`, Medien-I/O aber unverdrahtet) → `media_ready:false`.
`make contract NODE_URL=…` weiterhin PASS gegen eine echte
`omp-source`-Instanz (Descriptor/IS-04/Param-Roundtrip unverändert,
keine Regression durch die health-seitige Ergänzung).

## 2026-07-14 — D5 (SDK-Doku + Node-Tutorial): Tutorial selbst durchgespielt statt nur beschrieben

**Kontext:** Letzter Schritt vor Phase D bis zum aktuellen Stand
(D6/D7 folgen als eigene, größere Bausteine). Ziel laut `UMSETZUNG.md`:
„eine dritte Person schafft es nur mit der Doku" (in ~1 Stunde zum
eigenen Node). Vorbedingung war D5-prep (2026-07-14, dieselbe Sitzung
davor): der Node-Contract musste stabil sein, bevor er dokumentiert
wird.

**Kein Duplikat von `hello_node.rs`.** Das SDK hat mit
`nodes/omp-node-sdk/examples/hello_node.rs` bereits ein vollständiges,
funktionierendes Minimalbeispiel. Statt ein zweites, redundantes
Beispiel zu schreiben, erklärt `docs/NODE-TUTORIAL.md` dessen Teile
(`ParamStore`-Trait, `NodeConfig`) im Kontext des Node-Contracts (§5)
und geht dann darüber hinaus zu dem, was `hello_node.rs` bewusst nicht
zeigt: ein **eigenständiges** Crate (nicht nur ein `cargo example`
innerhalb von `omp-node-sdk`) und **echtes Medien-I/O** (Verweis auf
`omp-source` als Referenz, inkl. der `MediaReadySource`-Anleitung aus
D5-prep).

**Ehrliche Einschränkung dokumentiert, nicht verschwiegen:**
`omp-node-sdk` ist nicht auf crates.io veröffentlicht — der heute
tatsächlich funktionierende Weg für einen neuen Node ist ein
Workspace-Member mit Pfad-Abhängigkeit (`{ path = "../omp-node-sdk" }`),
kein `cargo add` von außerhalb des Repos. Das Tutorial sagt das explizit,
statt einen nicht existierenden Publish-Workflow zu erfinden.

**Verifikation: das Tutorial selbst nachgespielt, nicht nur
geschrieben.** Vor dem Schreiben der finalen Doku-Version real
durchgeführt, mit echten Kommando-Ausgaben in den Text übernommen (keine
erfundenen Beispiel-Outputs):
1. `cargo run --example hello_node` gegen die echte, per `make up`
   laufende Registry — Registrierung, `GET /descriptor.json`,
   `PATCH /params/gain`, `POST /methods/reset`, alles wie im Tutorial
   beschrieben.
2. Über den echten Orchestrator-Proxy (`make start`) bestätigt: Node
   erscheint in `GET /api/v1/nodes` und — per Chromium-CDP-Browser-Test
   (gleiche Methode wie C13-Nachtrag 1–4) — als Kachel im Flow-Editor.
3. `make contract NODE_URL=…` → PASS.
4. **Schritt 3 (eigenständiges Crate) komplett neu nachgebaut:**
   `cd nodes && cargo new --bin tutorial-scratch-node` (fügt sich
   automatisch als Workspace-Member ein, wie im Tutorial beschrieben),
   `Cargo.toml` exakt wie im Tutorial-Snippet, ein neuer, vom Tutorial-
   Autor nicht aus `hello_node.rs` kopierter `ParamStore` (andere
   Parameternamen/Methode, um echtes Nachbauen statt Abtippen zu
   simulieren) — kompilierte und registrierte sich **beim ersten
   Versuch**, `make contract` PASS, Kachel im Flow-Editor per CDP
   bestätigt. Kein Nacharbeiten am Tutorial-Text nötig, weil die
   Anleitung schon beim ersten Durchlauf stimmte. Scratch-Crate danach
   vollständig entfernt (`nodes/Cargo.toml`/`Cargo.lock` zurück auf den
   committeten Stand, per `git diff` verifiziert) — reine
   Verifikationsübung, kein dauerhafter Repo-Zusatz.

**Verlinkung:** `docs/HANDBUCH.md` §5 und `nodes/README.md` verweisen
jetzt auf `docs/NODE-TUTORIAL.md` — bewusst **nicht** in `README.md`
verlinkt, weil dort ein nicht von dieser Sitzung stammender,
uncommitteter Textentwurf liegt, den diese Sitzung nicht anfasst.

## 2026-07-14 — D6 Teil 1 (Remote-Host-Erkennung, ARCHITECTURE.md §18): Bootstrap + Telemetrie, bewusst ohne Kommandokanal/Placement/mTLS

**Kontext:** Nächster Schritt laut `UMSETZUNG.md`s eigener Einordnung
("realistisch der nächste, weil community-unabhängige Baustein nach dem
kleinen Regieplatz"). §18 beschreibt den vollen Umfang (Bootstrap,
Telemetrie, Kommandokanal, Placement-Integration, I/O-Karten-Inventar,
UI) — das ist mehrjährige Detailarbeit, kein Ein-Sitzungs-Schritt.
Analog zum D3-Schnitt (mTLS zuerst, IS-10/§12 später) hier ein expliziter
Teil-1-Schnitt: **Hosts erkennen und sichtbar machen**, nicht **Hosts als
Platzierungsziele nutzen**. Das deckt sich mit der ursprünglichen
Nutzeranforderung von §18 wörtlich ("was müssen wir bauen, damit unser
Server eine entfernte Maschine **erkennt**") — Teil 1 löst genau das,
nicht mehr.

**In dieser Runde:**
- `db/migrations/0003_hosts.sql`: `hosts` + `host_bootstrap_tokens`
  (nur der SHA-256-Hash des Tokens wird gespeichert, gleiches Prinzip
  wie `users.password_hash`).
- `internal/hosts`: Token-Ausstellung/-Verbrauch (§18.3 Punkt 1/3,
  atomarer `UPDATE … WHERE used_at IS NULL AND expires_at > now()`
  gegen Race zwischen zwei gleichzeitigen Registrierungsversuchen mit
  demselben Token), Host-Store, In-Memory-Telemetrie-Tracker (gleiches
  Muster wie `internal/health.Tracker`, B4).
- `internal/eventbus`: `Connect()` bekommt einen zweiten optionalen
  Callback (`onHostMetrics`) neben dem bestehenden `onHealth` — ein
  Subject-Präfix mehr im selben, bereits abonnierten `omp.>`-Strom,
  keine zweite NATS-Verbindung nötig.
- `internal/httpapi`: `POST /api/v1/admin/hosts/bootstrap-tokens`
  (admin-only), `POST /api/v1/hosts/register` (bewusst **außerhalb**
  von `authGate` — der registrierende Host-Agent ist kein angemeldeter
  Nutzer, seine Zugriffskontrolle ist das Bootstrap-Token selbst, nicht
  ein Bearer-Token aus D3 Teil 2), `GET /api/v1/hosts` (authentifiziert,
  merged Host-Stammdaten mit der zuletzt gesehenen Telemetrie).
- **Neues Top-Level-Go-Modul `host-agent/`** (analog `nodes/mock`,
  `tools/contract-check` — kein neuer Sprachstack, §4.1): registriert
  sich einmalig mit Bootstrap-Token, merkt sich die vom Orchestrator
  vergebene Host-ID lokal (`internal/state`, JSON-Datei) — ein
  Prozess-Neustart registriert sich **nicht** erneut (das Token wäre
  ohnehin verbraucht), sondern nimmt die Telemetrie unter derselben
  Host-ID wieder auf. `internal/telemetry` misst CPU/RAM über
  `/proc/stat`/`/proc/meminfo` (Linux-Standardtechnik: zwei
  `/proc/stat`-Samples mit kurzem Intervall, Differenzbildung für die
  CPU-Auslastung; `MemTotal - MemAvailable` für RAM, genauer als
  `MemTotal - MemFree`).
- UI: `<omp-hosts-view>` (`ui/shell/hosts-view.ts`), per Knopf
  ein-/ausblendbares Panel — bewusst **kein** Teil eines größeren
  Engineering-Dashboards (§17.2 existiert noch nicht), nur die in §18.7
  geforderte Grundsichtbarkeit (Label/Hostname/CPU/RAM/zuletzt gesehen).
  Nur in der Engineering-Ansicht sichtbar, nicht in der
  Operator-Console (§14) — Host-Verwaltung ist kein
  Operator-Anliegen.

**Bewusst nicht in dieser Runde (dokumentierte Scope-Grenze, kein
stiller Gap):**
- **mTLS-Zertifikatsausstellung über step-ca für den Host-Agent** (§18.3
  Punkt 3). Das Bootstrap-Token selbst ist bereits eine echte
  Zugriffskontrolle (einmalig, zeitlich begrenzt, nur von einem
  angemeldeten Admin ausstellbar) — die Registrierung ist also nicht
  "ungesichert-anonym" (§18.3 Punkt 4 wörtlich erfüllt), auch ohne
  Zertifikat. Die Telemetrie danach läuft unverschlüsselt über NATS,
  exakt wie der bestehende Node-Health-Kanal seit A7 — kein
  Sicherheits-Rückschritt gegenüber dem Ist-Zustand, nur (noch) keine
  zusätzliche Absicherung. Programmatische step-ca-Integration
  (`orchestrator` müsste selbst Zertifikate ausstellen können, nicht
  nur das manuelle `deploy/dev/mtls-issue-cert.sh`-Skript aus D3 Teil 1
  nutzen) ist eigene Recherche wert, nicht nebenbei zu erledigen.
- **GPU/NIC-Telemetrie, I/O-Karten-Inventar** (§18.4/§6.1 Punkt 1) —
  herstellerspezifisch, §18.4 nennt das selbst explizit als
  "Eigenrecherche bei der D6-Umsetzung", nicht zu raten.
- **Kommandokanal** (§18.5: Instanz-Launcher wird remote-fähig) — Hosts
  sind nach diesem Schritt sichtbar, aber noch keine nutzbaren
  Platzierungsziele. Das ist der größte verbleibende Teil von D6.
- **Placement-Engine** (§6.1 Punkt 2) — baut auf dem Kommandokanal auf.
- k3s/Cloud-Host-Klassen (§18.6/§18.8/§18.9).

**Verifiziert (echte Prozesse, nicht nur Unit-Tests):** `go build/vet/
test` für `orchestrator` und das neue `host-agent`-Modul grün (inkl.
eines gegen das echte `/proc` dieser Maschine laufenden
Telemetrie-Tests, kein Mock-Dateisystem — `/proc`s Format ist
Kernel-ABI, keine Simulation nötig), `deno check/test` grün. End-to-end
mit echten Prozessen: Bootstrap-Token ausgestellt, zwei simulierte
"Hosts" (zwei `omp-host-agent`-Prozesse mit unterschiedlichem Label/
State-Datei auf derselben Dev-Maschine, dokumentierte Simulation ohne
echte zweite Maschine — exakt der in §18 "Testbarkeit" beschriebene,
heute schon realistischere Testweg) registrierten sich erfolgreich,
`GET /api/v1/hosts` zeigte beide mit echter, live aktualisierender
CPU/RAM-Telemetrie; Wiederverwendung eines bereits eingelösten Tokens
scheiterte mit 401 (Single-Use-Garantie bestätigt); ein neu gestarteter
Host-Agent-Prozess mit vorhandener State-Datei registrierte sich nicht
erneut, sondern nahm die Telemetrie unter derselben Host-ID wieder auf
(Neustart-Idempotenz bestätigt). Browser-Test per CDP: „Hosts"-Knopf
öffnet das Panel, zeigt beide Hosts mit denselben Live-Werten wie die
API. Nach der Verifikation: Test-Hosts/-Tokens aus der DB entfernt
(dieselbe Aufräum-Disziplin wie bei D3 Teil 2/D5).

## 2026-07-14 — D5-prep-2: die verbleibenden acht `MediaReadySource::Unknown`-Nodes real verdrahtet (Nachtrag zu D5-prep)

**Kontext:** D5-prep (2026-07-14, frühere Sitzung) hatte das
"media-ready"-Signal (§5 Punkt 6) nur für `omp-source` echt verdrahtet;
die übrigen acht Medien-Node-Typen meldeten ehrlich `Unknown` statt einer
geratenen Bereitschaft — als dokumentierte, bewusste Folgearbeit
markiert. Diese Sitzung schließt das ab.

**Zentrale Design-Entscheidung: `MediaFlow`-Trait in `omp-mediaio` statt
Pad-Probes in jedem einzelnen Node.** Erste Durchsicht der acht
verbleibenden `pipeline.rs`-Dateien zeigte: nur `playout` hatte (aus C2)
bereits einen wiederverwendbaren Buffer-Zähler wie `omp-source`; die
übrigen sieben hatten gar keine solche Infrastruktur. Statt in jedem
Node einzeln eine Probe zu bauen, bekam `omp-mediaio` (das jeder Node
ohnehin für seinen echten Medien-Pfad nutzt) einen neuen Trait
`MediaFlow { fn has_flowed(&self) -> bool }`, implementiert für alle
fünf Transport-Typen:
- **MXL** (`mxl.rs`): `MxlVideoOutput`/`MxlAudioOutput`/`MxlVideoInput`/
  `MxlAudioInput` bekommen je ein `flowed: Arc<AtomicBool>`, gesetzt auf
  `true` beim ersten erfolgreichen Grain-/Samples-Commit bzw.
  `push_buffer` in den bereits bestehenden Schreib-/Lese-Threads (kein
  neuer Codepfad, nur eine zusätzliche Zeile in bestehenden `match`-Armen).
- **RTP/ST 2110** (`rtp.rs`/`st2110.rs`): `RtpVideoOutput`/
  `St2110VideoOutput`/`St2110VideoInput` haben keinen eigenen
  Schreib-Thread (reine GStreamer-Elementketten) — hier ein
  selbstentfernender Pad-Probe (`PadProbeType::BUFFER`,
  `PadProbeReturn::Remove` nach dem ersten Treffer).

**Gefundene, wichtige Detail-Falle: Probe auf dem Valve-**Src**-Pad,
nicht dem Sink-Pad.** Ein `valve` mit `drop=true` (IS-05 noch nicht
aktiviert) lässt Buffer trotzdem an seinem Sink-Pad ankommen — sie werden
erst intern verworfen. Ein Sink-Pad-Probe hätte "media-ready" gemeldet,
obwohl der Ausgang stumm geschaltet ist und nichts das Netz erreicht —
genau die Art von geratener/falscher Bereitschaft, die dieses Signal
verhindern soll. Live am `playout`-Node bestätigt (s. Verifikation
unten): `media_ready` blieb `false`, bis die IS-05-Sender-Connection
tatsächlich `master_enable: true` aktivierte.

**Zweite Ergänzung: `flowed_handle()` — ein klonbarer Griff aufs
Flag, nicht nur `has_flowed(&self)`.** Für Nodes, deren
`MxlVideoOutput`/`MxlAudioOutput`/`MxlVideoInput` nur innerhalb einer
internen, bei jedem Discovery-Update komplett neu gebauten
`ActivePipeline`-Struktur lebt (nicht über die gesamte Prozesslaufzeit
erreichbar, z. B. `omp-switcher`/`omp-video-mixer-me`/`omp-multiviewer`/
`omp-player`), reicht `&self`-Zugriff nicht — der Aufrufer (`main.rs`)
braucht das Flag, nachdem das Objekt selbst schon wieder verworfen sein
kann. `flowed_handle() -> Arc<AtomicBool>` löst das: ein eigenständiger,
klonbarer Griff, der unabhängig von der Objekt-Lebensdauer weiterlebt.

**Pro-Node-Verdrahtung (unterschiedliche Muster je nach
Pipeline-Architektur, keine Einheitslösung erzwungen):**
- **`playout`**: hielt den `Arc<RtpVideoOutput>` bereits über den
  gesamten Prozess (IS-05-`SenderConnection`) — direkte `has_flowed()`-
  Abfrage, keine neue Infrastruktur nötig.
- **`omp-viewer`**: rebuildet seine Pipeline bei jedem IS-05-Connect/
  Disconnect (C6) — `PipelineHandle` bekommt ein eigenes, bei
  `connect()`/`disconnect()` explizit zurückgesetztes `Arc<AtomicBool>`,
  das `build()` per Pad-Probe auf `input.tail`s Src-Pad füllt. Verhindert,
  dass nach einem Quellwechsel kurzzeitig noch die Bereitschaft der
  *alten* Quelle gemeldet wird.
- **`omp-srt-gateway`**: `PipelineHandle` hält jetzt ein `ActiveEndpoint`-
  Enum (`Uplink(St2110VideoInput)`/`Downlink(St2110VideoOutput)`) statt
  den Rückgabewert von `build_uplink`/`build_downlink` zu verwerfen —
  vorher wären die Objekte (und damit ihre Pad-Probes/Flags) beim
  Verlassen der Build-Funktion nutzlos geworden, obwohl die zugehörigen
  Pipeline-Elemente weiterliefen.
- **`omp-player`** (Video-**und**-Audio-Ausgang): `media_ready` = Audio
  IMMER erforderlich UND Video nur, wenn das Profil einen Video-Sender
  hat (`config.has_video` — Jingle-Profil hat keinen).
- **`omp-audio-mixer`**: ein `MxlAudioOutput`, gebaut genau einmal
  (`ActivePipeline` lebt über die gesamte Prozesslaufzeit, Kanäle werden
  chirurgisch an-/abgebaut, kein Pipeline-Rebuild) — `flowed_handle()`
  einmalig gezogen, reicht. Live bestätigt: `false`, solange 0 Kanäle
  existieren (GStreamers `audiomixer` produziert ohne Sink-Pads keinen
  Output), kippt auf `true` exakt beim ersten `addChannel()`.
- **`omp-switcher`**/**`omp-video-mixer-me`**: rebuilden die **gesamte**
  Pipeline bei jeder Änderung der entdeckten Quellenmenge (C7/C10) — ein
  `Arc<Mutex<Option<Arc<AtomicBool>>>>` wird nach jedem erfolgreichen
  (Re-)Build neu befüllt (`flowed_handle()` des jeweils neuen
  `MxlVideoOutput`). Beide haben einen permanenten Schwarzbild-Fallback
  im `input-selector`, der Ausgang produziert also so gut wie immer
  etwas — `media_ready` wird kurz nach jedem Rebuild `true`, auch ganz
  ohne externe Quellen (korrekt: §5 Punkt 6 verlangt "produziert
  tatsächlich Medien", ein gültiges Schwarzbild ist Produktion, keine
  Lücke).
- **`omp-multiviewer`**: hat **keinen** MXL-Ausgang (reiner
  MJPEG-Monitor, dokumentierte C13-Nachtrag-Entscheidung) — `media_ready`
  bewertet stattdessen die Menge der `MxlVideoInput`s: leer (keine
  Quellen deklariert) gilt vakuos als bereit (nichts abzuwarten,
  Schwarzbild-Fallback), sonst genügt **mindestens eine** tatsächlich
  fließende Kachel — ein einzelner ausgefallener Zubringer soll den
  Monitor nicht als "nicht bereit" erscheinen lassen, solange er noch
  irgendetwas zeigt.

**Verifiziert (echte Prozesse, nicht nur Unit-Tests):** `cargo build/
test/deny/audit` (Workspace, alle 12 `NodeConfig`-Konstruktionsorte)
grün. Live-Verifikation gegen sieben gleichzeitig laufende, echte
Node-Prozesse (`omp-source`, `omp-switcher`, `omp-video-mixer-me`,
`omp-multiviewer`, `omp-player`, `omp-audio-mixer`, `playout`) plus
separat `omp-viewer`, per NATS-Health-Subscription:
- Alle sieben zeigten im eingeschwungenen Zustand `media_ready:true`
  (jeder produziert im Normalbetrieb echte Medien).
- **Drei gezielte Zustandswechsel-Beweise, dass das Signal reagiert,
  nicht nur hartkodiert `true` ist:** `omp-audio-mixer` `false → true`
  exakt beim ersten `addChannel()`-Aufruf; `playout` `false → true` exakt
  bei echter IS-05-`master_enable: true`-Aktivierung (vorher trotz
  laufender interner Pipeline `false`, weil der Netzausgang stumm
  geschaltet war — bestätigt die Sink-Pad-vs-Src-Pad-Design-Entscheidung
  oben); `omp-viewer` `false → true` bei IS-05-Connect **und** wieder
  zurück auf `false` bei Disconnect.
- `make contract` PASS gegen `omp-switcher` und `omp-player` (keine
  Descriptor-/IS-04-Regression).
- **Unabhängiger, vorbestehender Befund (kein D5-prep-2-Bug):** `omp-video-
  mixer-me` zeigte während des Tests wiederholt `get_complete_grain …
  Unknown error: 11` beim Lesen eines fg/bg-Eingangs (Discovery-Race
  oder MXL-Read-Timing, vermutlich verwandt mit dem bereits
  dokumentierten "C8 — MXL-Read-Livelock"-Befund); der **Ausgang** blieb
  davon unberührt (Schwarzbild-Fallback), `media_ready` zeigte
  durchgehend korrekt `true`. Nicht in dieser Sitzung untersucht/behoben
  — orthogonal zum media-ready-Signal, betrifft die
  Discovery-/Input-Robustheit.

Test-Prozesse und -Registrierungen danach beendet (Registry-Einträge
laufen über `registration_expiry_interval` selbständig aus, gleiche
Praxis wie in vorherigen Sitzungen).

## 2026-07-14 — D6 Teil 2 (Kommandokanal, ARCHITECTURE.md §18.5): Instanz-Launcher wird Remote-fähig, Katalog als Vertrauensgrenze statt Signierung

**Kontext:** Direkte Fortsetzung von D6 Teil 1 — Hosts sind seitdem
sichtbar, aber noch keine nutzbaren Platzierungsziele. §18.5 verlangt
genau das: der Instanz-Launcher (C8) soll Nodes nicht nur lokal, sondern
auch auf einem registrierten Remote-Host starten/stoppen können. Analog
zum bisherigen Teil-Schnitt (Teil 1: Hosts erkennen, nicht platzieren)
hier wieder ein expliziter Teilschritt: **manuelle** Host-Auswahl über
den Kommandokanal, **keine** automatische Placement-Engine (§6.1 Punkt
2 bleibt zurückgestellt — baut logisch auf diesem Schritt auf, ist aber
eigene Entscheidungslogik, kein Nebenprodukt).

**Sicherheitsentwurf (zentrale Entscheidung dieser Runde):** Statt den
Kommandokanal per NATS-Message-Signierung (HMAC + Schlüsselverteilung
an jeden Host-Agent) abzusichern, verschiebt sich die Vertrauensgrenze
auf den **Host-Agent selbst**: der Orchestrator schickt über
`omp.host.<hostId>.cmd` nur einen `type`-Namen, nie einen ausführbaren
Befehl. Der Host-Agent löst diesen Namen gegen seinen **eigenen,
host-lokal konfigurierten** Katalog auf (`host-agent/internal/catalog`
— strukturell identisch zu `orchestrator/internal/launcher/catalog.go`,
aber bewusst dupliziert statt importiert: die Pfade im
Orchestrator-Katalog sind orchestrator-dateisystem-relativ und auf
einer anderen Maschine bedeutungslos, und die Duplizierung selbst ist,
was die Grenze "nur freigegebene Katalogeinträge, nie freie Befehle" an
der tatsächlichen Vertrauensgrenze durchsetzt). Eine kompromittierte
oder unauthentifizierte NATS-Nachricht kann damit höchstens einen dort
vorab freigegebenen Node-Typ auslösen, nie beliebigen Code — dieselbe
Garantie wie beim bestehenden lokalen Launcher (C8), nur pro Host statt
zentral. Das deckt sich mit dem bereits für Telemetrie (D6 Teil 1) und
Node-Health (seit A7) akzeptierten Sicherheitsstand ("NATS ist ein
vertrauenswürdiger Transport, kein zusätzlich abgesicherter Kanal")
statt eine neue, inkonsistente Ausnahme einzuführen.

**In dieser Runde:**
- `host-agent/internal/catalog`: host-lokaler Katalog, JSON-Datei über
  `OMP_HOST_AGENT_CATALOG_PATH` (leerer Pfad → leerer Katalog, kein
  Fehler — ein frisch gebootstrapter Host ohne konfigurierten Katalog
  kann dann zwar Kommandos empfangen, aber keinen einzigen Typ
  ausführen, fail-closed statt fail-open).
- `host-agent/internal/commands`: `Executor.Handle` verarbeitet
  Start-/Stop-Requests; Start validiert Katalogeintrag + Runner +
  `InstanceID`, setzt `OMP_INSTANCE_ID`/`OMP_LABEL`/`OMP_PORT=0`/
  `OMP_REGISTRY_URL`/`OMP_NATS_URL` aus der **eigenen** Umgebung des
  Host-Agents (nicht vom Orchestrator durchgereicht — sonst würde ein
  vom Orchestrator gesetztes `localhost` auf einer anderen Maschine
  falsch zeigen); Stop schickt SIGTERM, pollt bis zu 3s, SIGKILL-
  Fallback, idempotent bei unbekannter Instanz-ID. Eine gestartete
  Instanz wird per Hintergrund-Goroutine (`cmd.Wait()`) auf Absturz
  überwacht, aber **nicht** an den Orchestrator zurückgemeldet
  (dokumentierte Lücke, s. u.).
- `orchestrator/internal/launcher`: `Start`/`Stop` bekommen ein neues
  `hostID`-Argument bzw. lesen `Instance.HostID`; leer → unverändertes
  lokales Verhalten seit C8, gesetzt → `startRemote`/`stopRemote`
  schicken die Anfrage über ein neues `NATSRequester`-Interface
  (Request/Reply, 5s Timeout) an `omp.host.<hostId>.cmd`.
  `startRemote` validiert den Typ bewusst **nicht** gegen den
  orchestrator-eigenen Katalog — die Prüfung passiert, wie oben
  beschrieben, erst host-seitig; ein orchestrator-seitiger Vor-Check
  wäre nur Komfort, keine zusätzliche Sicherheit, und könnte bei
  unterschiedlichen Katalogen pro Host sogar falsch-negativ ablehnen.
- `internal/httpapi`: `POST /api/v1/instances` akzeptiert optionales
  `{"hostId": "..."}`; neuer Fehlerfall `ErrRemoteUnavailable` (503),
  falls der Orchestrator selbst keine NATS-Verbindung hat.
- UI (`ui/graph/flow-canvas.ts`): pro Katalogeintrag ein `<select>`
  (nur sichtbar, wenn `GET /api/v1/hosts` mindestens einen Host liefert
  — im heutigen Normalfall ohne Host-Agents bleibt die Palette optisch
  unverändert), Default „(lokal)". Instanz-Zeilen zeigen bei gesetzter
  `hostId` das Host-Label an.

**Bewusst nicht in dieser Runde (dokumentierte Scope-Grenze, kein
stiller Gap):**
- **NATS-Nachrichtensignierung (HMAC)** — durch das Katalog-als-
  Vertrauensgrenze-Design ersetzt, s. o. Kein Sicherheits-Rückschritt
  gegenüber dem übrigen Stack, aber auch keine zusätzliche Härtung, die
  über den bestehenden NATS-Vertrauensstand hinausgeht.
- **Remote-Absturzerkennung** — ein auf einem Remote-Host abgestürzter
  Prozess wird vom dortigen Host-Agent zwar per `cmd.Wait()` erkannt,
  aber nicht an den Orchestrator zurückgemeldet; anders als bei lokalen
  Instanzen (C13-Nachtrag 3) bleibt eine remote abgestürzte Instanz also
  bis zum manuellen Entfernen als "laufend" gelistet. Braucht einen
  Rückkanal (z. B. `omp.host.<hostId>.crashes`-Subscription im
  Orchestrator) — eigene Recherche wert, kein Nebenprodukt.
- **Placement-Engine** (§6.1 Punkt 2) — automatische Zielhost-Wahl nach
  Ressourcenlage; dieser Schritt liefert nur die manuelle Grundlage
  (Dropdown), auf der eine Engine später aufsetzen könnte.
- **mTLS für den Kommandokanal** — wie Teil 1, bleibt am bestehenden
  Gesamt-mTLS-Opt-in (D3 Teil 1) hängen, kein Alleingang für diesen
  einen Kanal.

**Verifiziert (echte Prozesse, nicht nur Unit-Tests):** `go build/vet/
test` für `orchestrator` und `host-agent` grün (inkl. neuer Tests mit
echtem `sleep`-Prozess für Start/Stop/Idempotenz in
`commands_test.go` und einem Fake-`NATSRequester` in
`launcher_test.go`), `deno check/test` und `deno bundle` grün.
End-to-end mit echten Prozessen: zwei simulierte Remote-Hosts (zwei
`omp-host-agent`-Prozesse mit eigenem Katalog/State auf derselben
Dev-Maschine, wie schon in Teil 1) gegen den laufenden Orchestrator
registriert; `POST /api/v1/instances` mit `hostId` startete einen
echten `nodes/mock`-Prozess auf dem simulierten Remote-Host (PID auf
dem Host-Agent-Prozess bestätigt, nicht auf dem Orchestrator), der sich
korrekt bei der NMOS-Registry registrierte und im Orchestrator-Graph
erschien; `DELETE /api/v1/instances/<id>` beendete ihn remote sauber
(Prozess verifiziert beendet, Instanzliste leer). Browser-Test per CDP:
Palette zeigt pro Katalogeintrag ein Host-`<select>` mit beiden echten
Hosts; ein Klick mit ausgewähltem Remote-Host löste den POST mit
korrekter `hostId` aus. **Sicherheitsgrenze live bestätigt statt nur
gelesen:** derselbe Klick mit einem Katalogtyp, der auf dem Ziel-Host
**nicht** freigegeben war (`omp-source` gegen einen Host mit
`omp-mock`-only-Katalog), wurde vom Host-Agent mit `"unknown catalog
type"` abgelehnt, nicht etwa vom Orchestrator durchgewunken — bestätigt,
dass die Durchsetzung tatsächlich host-seitig greift und nicht nur
dokumentiert ist. Nach der Verifikation: Test-Prozesse beendet,
Test-Hosts aus der DB entfernt (gleiche Aufräum-Disziplin wie D6 Teil
1).

## 2026-07-14 — D7 Teil 1 (Workflow-Bereitstellung, ARCHITECTURE.md §6.2): das Workflow-Objekt selbst + Bundle-Start/-Stop mit Auto-Verkabelung, kein Scheduler/keine Placement-Vorprüfung; zwei echte UI-Race-Bugs per CDP gefunden

**Kontext:** Nächster offener Schritt laut `UMSETZUNG.md`-Statustabelle
nach D6 Teil 2. §6.2 beschreibt den vollen Umfang (Workflow-Katalog,
Zeitsteuerung, Stop-Sicherheitsabfrage, Ressourcen-Vorprüfung gegen die
Placement-Engine) — wieder ein expliziter Teil-Schnitt, analog zu D3/D6:
**das Workflow-Objekt anlegen und als Bündel starten/stoppen**, nicht
**automatisch planen, wo/wann**. §6.2 nennt selbst explizit, dass diese
Stufe auf dem in C8/D6 Teil 2 bereits vorhandenen Instanz-Launcher
aufbaut ("Stufe 0 … D7 baut darauf zum vollen Workflow-Objekt aus").

**Einordnung:** Ein Workflow ist eine benannte Menge von Node-**Rollen**
(Name + Katalog-Typ + optionale Host-ID) plus ein **Rolle→Rolle**-
Verbindungs-Template (§6.2 wörtlich: nicht Port→Port) und ein
Lifecycle-Status (stopped/starting/started/stopping/failed). Start
provisioniert jede Rolle über den bestehenden Launcher (lokal oder
remote, unverändert seit D6 Teil 2), wartet, bis die erwarteten
Instanzen sich selbst in der NMOS-Registry registriert haben (Korrelation
über den bestehenden `OMP_INSTANCE_ID`-Tag, C8), und löst danach das
Verbindungs-Template automatisch in echte IS-05-Connections auf — auf
den jeweils **ersten** Sender/Receiver jeder Rolle (dokumentierte
Vereinfachung: kein Port-genaues Template in Teil 1).

**In dieser Runde:**
- `db/migrations/0004_workflows.sql` + `internal/workflows`: neues
  Paket, ein Blob pro Workflow (`data JSONB`, gleiches Muster wie
  `snapshots.data`, D1), `status`/`updated_at` zusätzlich als echte
  Spalten. `Service.Start`/`Stop` laufen **asynchron im Hintergrund**
  (eigene Goroutine): der HTTP-Handler liefert sofort den
  Zwischenzustand ("starting"/"stopping"), der eigentliche Fortschritt
  ist per `GET /api/v1/workflows/{id}`-Poll oder dem neuen
  SSE-Event-Typ `workflow.updated` sichtbar — nötig, weil reale
  GStreamer-Pipelines mehrere Sekunden zum Hochfahren brauchen und ein
  synchroner Handler den Request-Timeout riskiert hätte.
  Registrierungs-Wartezeit endlich begrenzt (`registrationTimeout`,
  20s) statt unbegrenzt zu hängen, falls eine Rolle nie erscheint.
  Fehler bei einzelnen Rollen werden gesammelt statt beim ersten Fehler
  abzubrechen (gleiches Muster wie `snapshots.Service.Apply`) — ein
  Teil-Start bleibt **absichtlich** laufen statt automatisch
  zurückgerollt zu werden (volle Ressourcen-Vorprüfung, die das
  verhindern würde, ist §6.2s "harte Vorbedingung", braucht die noch
  zurückgestellte Placement-Engine, §6.1).
- `internal/httpapi/workflow_handlers.go` + `server.go`:
  `GET/POST /api/v1/workflows`, `GET/DELETE /api/v1/workflows/{id}`,
  `POST /api/v1/workflows/{id}/start`, `POST .../stop`. Definieren ist
  "configure" (wie Graph-Kanten/Layouts/Snapshots), Start/Stop ist
  "admin" (wie der Instanz-Launcher selbst — ein Workflow-Start ist
  nichts anderes als mehrere gebündelte Instanz-Starts).
- UI: `ui/shell/workflows-view.ts` (`<omp-workflows-view>`, per Knopf
  ein-/ausblendbares Panel, gleiches Muster wie `hosts-view.ts`) — Liste
  mit Status-Farbe, Start/Stop/Löschen pro Workflow, sowie ein
  Formular zum Anlegen (Rollen-Zeilen mit Katalog-Typ- und
  Host-Auswahl, Verbindungs-Zeilen mit Rollen-Dropdowns aus den
  aktuell eingetragenen Rollennamen).
- **`nodes/mock`-Lücke gefunden und behoben:** der Go-Mock-Node (bisher
  nur von Hand mit expliziten Flags gestartet, nie über den Launcher)
  setzte den `urn:x-omp:instance`-Tag aus `OMP_INSTANCE_ID` nie —
  `registry.NodeView.InstanceID` blieb dadurch für jede launcher-/
  workflow-gestartete Mock-Instanz leer, die Start-Korrelation in
  `awaitRegistration` konnte sie nie finden. Ohne den Fix hätte kein
  Workflow mit Mock-Rollen je "started" erreicht — sauber als Timeout
  mit Fehlermeldung sichtbar geworden (kein stiller Hänger), aber eben
  nicht funktional. Ein-Zeilen-Fix in `nodes/mock/main.go`.

**Zwei echte UI-Bugs per CDP-Klick-Test gefunden (nicht nur per
API-curl, das hätte beide verdeckt):**
1. `<omp-workflows-view>` rief `#render()` nie synchron in
   `connectedCallback()` auf, sondern nur nach dem ersten aufgelösten
   Poll — das Panel war beim Öffnen kurzzeitig komplett leer (auch der
   "+ Neu"-Button fehlte), unauffällig bei einem menschlichen Klick mit
   sichtbarer Verzögerung, aber ein handfester Bug. Fix: sofortiger
   synchroner `#render()`-Aufruf vor dem ersten Poll (Muster aus
   `hosts-view.ts` übernommen, das diesen Fehler nie hatte).
2. **Subtiler:** der "+ Verbindung"-Button war `disabled`, solange
   weniger als zwei Rollen benannt waren — aber Rollennamen werden über
   ein Text-Input gepflegt, das bewusst **kein** Re-Render bei jedem
   Tastendruck auslöst (sonst ginge der Cursor beim Tippen verloren).
   Ohne einen anderen, zufälligen Re-Render-Auslöser (z. B. eine weitere
   Rolle hinzufügen) blieb der Button für einen Nutzer, der einfach nur
   zwei Rollen benennt und dann eine Verbindung ziehen will, **für immer
   deaktiviert** — dieselbe Falle traf auch die zugehörigen
   Verbindungs-Dropdowns (Rollenliste stammt ebenfalls nur aus dem
   letzten Render). Fix: Rollennamen-Feld feuert zusätzlich ein
   `"change"`-Event (nicht `"input"`, kein Cursor-Verlust während des
   Tippens) und löst darüber gezielt ein Re-Render aus. Verwandter,
   dritter Fund: `#loadStatic()` (Katalog/Hosts-Fetch) löste nach dem
   Auflösen nie ein Re-Render aus — wenn das Anlegen-Formular schon
   offen war, bevor der Fetch zurückkam, blieb die Node-Typ-Auswahl
   dauerhaft leer. Fix: `#render()` zusätzlich nach `#loadStatic()`,
   falls das Formular zu dem Zeitpunkt offen ist.

**Bewusst nicht in dieser Runde (dokumentierte Scope-Grenze, kein
stiller Gap):**
- **Zeitsteuerung** (start_at/stop_at, §6.2 Erweiterung 2026-07-10) —
  eigener Scheduler-Baustein, keine Abhängigkeit dieser Runde.
- **Stop-Sicherheitsabfrage** (`confirm_stop`) — reine UI-/API-Ergänzung,
  ohne funktionale Abhängigkeit nachrüstbar.
- **Ressourcen-Vorprüfung als harte Start-Vorbedingung** — braucht die
  noch zurückgestellte Placement-Engine (§6.1); Start in Teil 1 ist
  best-effort mit gesammelten Fehlern statt Alles-oder-Nichts.
- **Port-genaues Verbindungs-Template** (mehrere Sender/Receiver pro
  Rolle) — Teil 1 verkabelt nur den jeweils ersten Sender/Receiver;
  reicht für alle heutigen Katalog-Nodes im Regieplatz-Kontext.
- **Cloud/k3s-Helm-Äquivalent, Quadlet-Bundle-Start** (§6.2 Zwei-Stufen-
  Antwort) — diese Runde deckt nur den Dev-/Bare-Metal-Prozess-Pfad ab,
  der bereits über den bestehenden Launcher läuft.

**Verifiziert (echte Prozesse, nicht nur Unit-Tests):** `go build/vet/
test` für `orchestrator` (inkl. neuem `internal/workflows`-Paket, Store-
Tests gegen echtes Postgres, Service-Tests mit Fakes inkl. simulierter
Registrierungs-Timeouts) und `nodes/mock` grün, `deno check/test/
bundle` grün. End-to-end mit echten Prozessen: zwei Katalog-Einträge auf
denselben `nodes/mock`-Build mit unterschiedlichen Ports, ein Workflow
mit zwei Rollen + einer Verbindung per **echtem API-Aufruf** gestartet
— beide Prozesse liefen, registrierten sich, die Verbindung wurde
automatisch als aktive IS-05-Connection sichtbar (`GET /api/v1/graph`
zeigte die Kante), Stop beendete beide Prozesse sauber. Danach
**derselbe Ablauf noch einmal komplett per echtem CDP-Klick-Test**
(Formular ausfüllen, Rollen/Verbindung setzen, Anlegen/Start/Stop
klicken, Status-Anzeige im Panel bis "started"/"stopped" verfolgt) —
dabei die drei oben genannten UI-Bugs gefunden und behoben, danach mit
demselben Klick-Test erneut grün bestätigt. Test-Prozesse, -Workflow und
zwei versehentlich geleakte Chromium-Tabs (falscher `Target.
closeTarget`-Aufruf in einem Wegwerf-Testskript, nicht im Produktcode)
danach aufgeräumt.

## 2026-07-14 — D6 Teil 3 (Resource-Aware Placement, ARCHITECTURE.md §6.1): advisory-only Ausbaustufe, kein Make-before-break

**Kontext:** Letzter offener D6-Baustein. `ARCHITECTURE.md` §6.1 nennt
drei Bausteine (Telemetrie, Placement-Engine, Make-before-break-
Protokoll) und ist explizit: „Erste Ausbaustufe bewusst advisory (Alarm
+ Vorschlag), nicht sofort automatisch migrierend." Telemetrie existiert
bereits seit D6 Teil 1. Dieser Schritt liefert ausschließlich Baustein
2 (Scoring/Alarm/Vorschlag) — Baustein 3 (tatsächliche Migration) ist
bewusst zurückgestellt: eine automatische Ausführung ohne vorherige,
gezielte Prüfung des Make-before-break-Zustandsautomaten wäre das
riskantere Feature zuerst gebaut, nicht das sicherere zuerst („kleinste
sicher lieferbare Scheibe zuerst", Haus-Stil). D7 Teil 2
(Ressourcen-Vorprüfung) wartete explizit auf diesen Baustein
(`UMSETZUNG.md` D7 Teil 1: „braucht die noch zurückgestellte
Placement-Engine").

**Kernentscheidung — advisory bleibt advisory, keine Eskalationsstufen
in dieser Runde:** §6.1 Erweiterung 2026-07-13 beschreibt bereits
pro-Rolle konfigurierbare Eskalationsstufen (`advisory` /
`auto-confirm-window` / `auto`). Diese Konfiguration ergibt aber erst
Sinn, sobald *irgendeine* automatische Ausführung existiert, gegen die
sich die Stufen unterscheiden lassen — mit nur `advisory` implementiert
wäre ein Eskalationsstufen-Feld reine Attrappe (ein Konfigurationsfeld,
das nichts an tatsächlichem Verhalten ändern kann). Bewusst nicht
gebaut, bis Baustein 3 existiert.

**Implementierung:**
- Neues Paket `orchestrator/internal/placement` (`Engine`, keine
  Postgres-Anbindung — reiner In-Memory-Rechenschritt über bereits
  vorhandene Daten aus `internal/hosts` und `internal/launcher`, kein
  eigener Store nötig). `HostLister`/`MetricsReader`/`InstanceLister`/
  `EventPublisher` als schmale Interfaces (gleiches Entkopplungsmuster
  wie überall sonst im Orchestrator — `*hosts.Store`, `*hosts.Tracker`,
  `*launcher.Launcher`, `*sse.Hub` erfüllen sie ohne Adapter).
- `Engine.Run(ctx)` bewertet alle 5s (`EvaluateInterval`, bewusst
  identisch zur Host-Agent-Telemetrie-Sendefrequenz aus
  `host-agent/main.go`, kein Rätselraten über ein sinnvolles Intervall
  nötig). Ein überlasteter, aber instanzloser Host löst **keinen**
  Alarm aus („niemandes Problem"); ein lokal (ohne `hostId`) gestarteter
  Node zählt nicht als migrierbare Instanz.
- Scoring: `CPUPercent`/`MemPercent` (Alarm-Schwellwerte, Default 85%/
  90%) vs. `HealthyCPUPercent`/`HealthyMemPercent` (Ausweichziel-
  Eignung, Default 60%/70%, bewusst mit Abstand zu den Alarm-
  Schwellwerten — ein Kandidat knapp unter der Alarmschwelle wäre kein
  sinnvoller Vorschlag). Kein Ausweichhost unter den Healthy-
  Schwellwerten gefunden → `SuggestedHostID` bleibt leer, ein
  ehrlicher „nicht migrierbar"-Befund statt eines stillen Fallbacks auf
  irgendeinen Host (gleiches Prinzip wie die I/O-Karten-Migrations-
  grenze in §6.1, nur hier bereits für den reinen CPU/RAM-Fall
  vorweggenommen).
- **Kein SSE-Dauerfeuer bei stabiler Last:** `publishChanges`
  vergleicht (`reflect.DeepEqual`, da `Advice.InstanceIDs` ein Slice
  ist und `Advice` deshalb nicht `==`-vergleichbar ist) den neuen
  gegen den vorherigen Alarm-Stand pro Host und broadcastet nur bei
  tatsächlicher Änderung. Dafür musste `DetectedAt` explizit über
  Bewertungsläufe hinweg stabil gehalten werden (aus dem vorherigen
  Advice übernommen, falls der Alarm bereits bestand) — sonst hätte
  jeder Tick einen neuen Zeitstempel und damit über den DeepEqual-
  Vergleich ein neues Event erzeugt, obwohl sich am Zustand nichts
  geändert hat. Ein bei einem Lauf verschwundener Alarm broadcastet
  ein `{Reason: "cleared"}`-Event, damit UI-Clients ohne vollständigen
  Re-Poll wissen, welcher Alarm weg ist.
- API: `GET /api/v1/placement/advice` (`internal/httpapi/
  placement_handlers.go`) — view-artig wie `GET /api/v1/hosts`, kein
  eigener Verb-Scope (die Engine führt selbst nichts aus, es gibt
  nichts zu autorisieren außer Lesezugriff).
- Config: `OMP_PLACEMENT_CPU_THRESHOLD`/`_MEM_THRESHOLD`/
  `_HEALTHY_CPU_THRESHOLD`/`_HEALTHY_MEM_THRESHOLD` — Defaults in
  `internal/config` bewusst als Zahlen dupliziert statt
  `placement.DefaultThresholds` zu importieren (config bleibt frei von
  Business-Logik-Abhängigkeiten, gleiches Duplikations-Muster wie
  `remoteCommand` zwischen `launcher` und `host-agent`, D6 Teil 2).
- UI (`ui/shell/hosts-view.ts`): zusätzlicher Poll gegen
  `/api/v1/placement/advice` im selben Intervall wie der bestehende
  Hosts-Poll (kein SSE-Sonderfall nur für dieses eine Panel, gleiche
  Begründung wie beim ursprünglichen Hosts-Poll selbst), Alarm-Banner
  pro überlastetem Host oberhalb der Host-Tabelle.

**Bewusst nicht in dieser Runde (dokumentierte Scope-Grenze, kein
stiller Gap):**
- Make-before-break-Protokoll (§6.1 Punkt 3) — Start einer
  Ersatzinstanz, Betriebsbereitschaftsprüfung, IS-05-Umschaltung,
  Drain, Teardown. Der größte verbleibende §6.1-Baustein, eigene
  Zustandsautomatik, kein Nebenprodukt dieser Runde.
- Eskalationsstufen advisory/auto-confirm-window/auto (§6.1 Erweiterung
  2026-07-13 Punkt 2) — s. Kernentscheidung oben, wartet auf
  Make-before-break.
- I/O-Karten-Claim/Release (§6.1 Erweiterung 2026-07-10) — braucht ein
  noch nicht existierendes Geräte-Inventar im Host-Agent.
- GPU/NIC-Telemetrie (§18.4, herstellerspezifisch) und Cloud-
  Kostenfaktor (§6.1 Punkt 4).
- D7 Teil 2 (Ressourcen-Vorprüfung als harte Workflow-Start-
  Vorbedingung) — kann jetzt auf `placement.Engine` aufsetzen, ist aber
  ein eigener, noch nicht terminierter Schritt (Workflow-Start bleibt
  bis dahin best-effort wie in D7 Teil 1).

**Verifiziert (echte Prozesse, nicht nur Unit-Tests):** `go build/vet/
test -race` für `orchestrator` (neues `internal/placement`-Paket, acht
Tabellen-artige Szenarien: kein Alarm unter Schwellwert, kein Alarm bei
instanzlosem Host, Alarm mit Ausweichhost-Vorschlag, Alarm ohne
verfügbaren Ausweichhost, stabiler Alarm republiziert nicht über
mehrere Ticks, behobener Alarm broadcastet ein "cleared"-Event,
RAM-Grund-Erkennung, lokale Instanzen ohne `hostId` werden ignoriert)
grün, `go vet` sauber; `deno check/test/bundle` grün (Custom-Element-
Registrierung im Bundle per `grep` auf `omp-hosts-view` bestätigt,
gleiche Vorsicht wie bei jeder UI-Änderung seit dem D5-prep-Fund zur
Deno-Bundle-Typ-Import-Elision).

End-to-end mit echten Prozessen (kein Mock der Placement-Engine
selbst): zwei echte `omp-host-agent`-Prozesse mit je einer echten
`nodes/mock`-Instanz registriert (gleiches Zwei-Host-Muster wie D6 Teil
1/2). Baseline ohne Alarm bestätigt (`GET /api/v1/placement/advice` →
`[]`, beide Hosts real bei ~5% CPU). Einen Host-Agent-Prozess gestoppt
(damit dessen reale Telemetrie keine fingierten Werte mehr
überschreibt) und für dessen Host-ID direkt eine fingierte
Überlast-Nachricht (97,5% CPU) auf `omp.host.<id>.metrics` publiziert
— exakt die Simulationsart, die `ARCHITECTURE.md` §6.1 für die
Single-Host-Dev-Maschine ohne zweiten echten Host vorschlägt ("zwei
Podman-„virtuelle Hosts" mit fingierten Metriken"). Ergebnis: Alarm mit
`reason: "cpu"` und korrektem `suggestedHostId` (dem gesunden zweiten
Host) erschien binnen einer Bewertungsrunde. Per SSE (`curl -N
/api/v1/events`) über ca. 14s (≈3 Bewertungsläufe) bei unverändert
hoher Last mitgelesen: **genau ein** `placement.advice`-Event, keine
Wiederholung — bestätigt, dass die Änderungserkennung tatsächlich
greift, nicht nur im Unit-Test. Anschließend Entlastung simuliert (10%
CPU publiziert): Alarm verschwand aus `GET .../advice`, ein
zusätzliches `placement.advice`-Event mit `reason: "cleared"` per SSE
beobachtet. Browser-Test per echtem CDP (Node-WebSocket gegen
`chromium --headless --remote-debugging-port`, `/json/list` für das
Page-Target statt des Browser-weiten `/json/version`-Sockets — letzterer
kennt `Runtime.evaluate` nicht, nur Zielseiten-Sockets tun das): echter
Klick auf den bestehenden "Hosts"-Button, danach das Alarm-Banner mit
Host-Label, Grund, CPU-/RAM-Werten und Ausweichhost-Vorschlag im
tatsächlichen DOM gelesen — dabei einen kleinen Textfehler gefunden
("CPU: CPU 98%…", doppelte Grund-/Wert-Bezeichnung durch
`reasonLabel()` + hartkodiertes "CPU" im Template) und auf "Grund:
CPU, CPU 98% / RAM 7%" korrigiert, danach erneut per CDP bestätigt.

Danach aufgeräumt: verwaisten `omp-mock`-Prozess des gestoppten
Host-Agents manuell beendet (kein Elternprozess mehr, der ihn stoppen
konnte), zweite Instanz reguläre über den noch laufenden Host-Agent per
`DELETE /api/v1/instances/<id>` remote gestoppt, zweiten Host-Agent
beendet, Chromium beendet, beide Test-Hosts + deren bereits verbrauchte
Bootstrap-Tokens per SQL aus Postgres entfernt (kein `DELETE
/api/v1/hosts/<id>`-Endpunkt vorhanden — Hosts sind seit D6 Teil 1
bewusst nur lesend über die API exponiert, Löschen ist bisher kein
UI-/API-Anwendungsfall).

## 2026-07-14 — Entscheidungssitzung END-GOAL-FEATURES Kapitel 10: alle zehn offenen Fragen entschieden

**Kontext:** `docs/END-GOAL-FEATURES.md` (Commit `665ba4a`) listet in
Kapitel 10 zehn konsolidierte Entscheidungspunkte, die vor
Implementierungsbeginn der neun Endziel-Kapitel (K1–K9) zu klären
waren. Direkt im Anschluss an D6 Teil 3 durchgegangen, auf expliziten
Wunsch des Projektinhabers ("bevor wir weitermachen, entscheidungen aus
end-goal-features treffen"). Vollständiges Ergebnis steht jetzt in
`docs/END-GOAL-FEATURES.md` Kapitel 10 selbst (als verbindliche
Kurzfassung, die Kapitel-Unterabschnitte 1.5–9.6 wurden nicht
nachträglich umgeschrieben) — hier nur die Punkte, die von der
Dokument-Empfehlung **abweichen** oder zusätzlichen Kontext brauchen,
den Kapitel 10 selbst knapp hält.

**Abweichungen von der im Dokument vorgeschlagenen Empfehlung** (bewusst
hervorgehoben, damit spätere Sitzungen nicht versehentlich zur
Dokument-Empfehlung zurückfallen):
- **K1 Sprache:** Englisch als Primärsprache mit DE-Umschaltung statt
  "DE belassen" — mehr i18n-Aufwand, aber vom Projektinhaber
  ausdrücklich gewählt (nicht die von der Doku empfohlene sparsamere
  Variante).
- **K1 Panels:** Vollansichten mit Tabs statt andockbare Panels —
  größerer Umbau von `shell.ts` als die "kleinerer Umbau"-Empfehlung.
- **K2 Medienverzeichnis:** pro Instanz konfigurierbar statt global
  pro Host — mehr Parameter-Fläche akzeptiert.
- **K4 Solo/PFL:** wird gebaut (Monitor-Summe + lokale Wiedergabe)
  statt "Metering reicht".
- **K8 Mehrgeräte-Fall:** jetzt mitdenken statt Ein-Geräte-Annahme für
  v1 — WebHID-Mehrgeräte-Handling gehört von Anfang an ins Design,
  nicht nachträglich reingeflickt.

**Die (a)/(b)/(c)-Redundanz-Grundsatzfrage** ([[project_redundancy_
failover_question]] in der Memory, offen seit 2026-07-12) ist damit
entschieden: **(c) als nächste Stufe, (b) bleibt das Endziel** — keine
Alternative, sondern eine Sequenz. Der bereits in `ARCHITECTURE.md`
§20.1 dokumentierte fünfstufige (b)-Fahrplan (Grain-Index-Struktur →
schneller sichtbarer Cut → PTP-Basis → Command-Mirroring/
`omp-seamless-switch` → Determinismus-Härtung) bleibt unverändert die
Zielrichtung; (c) (Standby läuft parallel, Downstream friert bei
Umschaltung das letzte Bild ein) wird als eigene, frühere Stufe davor
eingeschoben, wo bisher direkt zu Stufe 2 ("schneller sichtbarer Cut")
gesprungen worden wäre. `ARCHITECTURE.md` §20.1 ist an dieser Stelle
noch **nicht** nachgeführt — das ist Folgearbeit für die Sitzung, die
K7-Teil-1/-2 tatsächlich umsetzt, nicht Teil dieser reinen
Entscheidungssitzung.

**K7-Teil-4 (Placement-Engine-Priorisierung) ist gegenstandslos
geworden:** Kapitel 10 Punkt 8 fragte ursprünglich, ob D6 Teil 3
(Placement-Engine) wegen K7-Teil-4 (Hot-Standby) gezielt vorgezogen
werden soll — diese Frage stellte sich nicht mehr, weil D6 Teil 3 in
genau dieser Sitzung direkt vorher bereits fertiggestellt wurde (s.
Eintrag oben, "D6 Teil 3"). Keine Entscheidung nötig, nur zur Kenntnis
genommen.

**Nicht in dieser Sitzung geklärt (bewusst, kein stiller Gap):** welche
Video-Essenz PIPELINE CONTROLLER konkret nutzt (K2-Codec-Entscheidung
verweist darauf, die tatsächliche Identifikation ist Recherchearbeit
der K2-Umsetzungssitzung, nicht dieser Entscheidungssitzung); die
konkrete Werte-Wahl für "8–12" bei K3 (Bank-Größe) ist als Spanne
entschieden, kein exakter Wert; der Render-Spike für K5 (wpesrc vs.
Chromium/CDP) bleibt bewusst offen bis zum tatsächlichen Spike.

**Nächster Schritt (nicht Teil dieser Sitzung):** die gewählte
Reihenfolge (K1-Teil-1 zuerst) als regulären Schritt in `UMSETZUNG.md`
aufnehmen, sobald die Umsetzung beginnt — `docs/END-GOAL-FEATURES.md`
bleibt bis dahin reine Design-Referenz, keine Statuszeile in
`UMSETZUNG.md` Abschnitt 7.

## 2026-07-14 — K1-Teil-1 (Verbindungsschicht + App-Bar mit Tabs, END-GOAL-FEATURES.md §1.3a/b/d): ein per Live-Test gefundener und behobener Degraded-Hänger

Erste Umsetzungs-Scheibe aus Kapitel 10 (s. Eintrag oben), als
regulärer Schritt `UMSETZUNG.md` §6a aufgenommen und in derselben
Sitzung umgesetzt. Volle Beschreibung dort; hier nur der Teil, der über
eine reine Statuszeile hinaus Kontext braucht.

**Architektur-Entscheidung — ein geteilter ConnectionMonitor statt
Verbindungslogik pro Komponente:** die bisherige SSE-Reconnect-Logik
(exponentielles Backoff) steckte ausschließlich in `flow-canvas.ts`
(`#connectEvents`/`#scheduleReconnect`, seit B4). Sie zieht komplett in
ein neues Modul `ui/shell/connection.ts` um: ein einziges
`EventTarget`-basiertes `ConnectionMonitor`-Singleton mit
`connected|degraded|disconnected`, `start()` idempotent (sowohl die
neue App-Bar als auch `flow-canvas.ts` rufen es in ihrem jeweiligen
`connectedCallback()` auf, ohne eine zweite `EventSource` zu öffnen).
Begründung: mit der App-Bar als eigenständigem, immer sichtbarem
Custom Element (anders als vorher, wo nur `flow-canvas.ts` je existierte)
hätte jede Komponente sonst ihre eigene Verbindung gebraucht, um den
Zustand fürs Pill/Banner zu kennen — unnötige zweite SSE-Verbindung pro
Tab-Wechsel.

**Der eigentliche Fund — ein per CDP-Stop/Start-Zyklus entdeckter
Bug, nicht nur eine Design-Vermutung:** die erste Implementierung
verband „degraded" (Sekundärsignal, ein einzelner `apiFetch()`-
Fehlschlag während die SSE noch lebt) nur einseitig mit Erholung:
`reportApiSuccess()` heilt „degraded" zurück auf „connected", aber
nichts löste je einen neuen, erfolgreichen `apiFetch()`-Aufruf aus,
wenn gerade niemand eine Nutzeraktion auf dem Flow-Editor-Tab ausführte
(der Tab hat anders als `hosts-view.ts`/`workflows-view.ts` kein
periodisches Poll). Beim ersten echten Stop/Start-Testzyklus (Node-
CDP-Client, echter `.run/orchestrator.log`-Prozess gestoppt/neu
gestartet) blieb die Pill dauerhaft auf „degraded" hängen, obwohl der
Orchestrator längst wieder lief und die SSE-Verbindung sich bereits
sauber neu aufgebaut hatte. Per Chrome-DevTools-Protocol-`Network`-
Domain-Trace (nicht Vermutung) belegt: ein `apiFetch()`-Aufruf, der
schon **vor** dem Verbindungsabbruch losgeschickt worden war
(`#maybeFetchPreviewUrl` in `flow-canvas.ts`, ausgelöst beim
ursprünglichen Seitenaufbau, `t≈0.1s`), löste sich in einem
beobachteten Lauf erst bei `t≈68.7s` mit einem 5xx auf — die SSE-
Verbindung war zu dem Zeitpunkt bereits seit `t≈18.7s` wieder
„connected". Dieser einzelne, längst veraltete Fehlschlag warf den
Zustand zurück auf „degraded", ohne dass je wieder etwas ihn
korrigierte.

**Fix:** `reportApiFailure()` startet jetzt einen leisen Recovery-Probe
gegen `/healthz` (unauthentifiziert, bereits von `deploy/dev/
stop-omp.sh` als Liveness-Check genutzt) alle drei Sekunden, solange
der Zustand „degraded" bleibt — der Probe läuft über denselben
`apiFetch()`-Pfad wie jeder andere Aufrufer (kein Sonderfall, keine
zweite Fehlerbehandlung). Erreicht `apiFetch()` dabei irgendwann
`res.ok`, heilt `reportApiSuccess()` ganz normal zurück auf
„connected", der Probe-Timer stoppt sich selbst (`#setState()` räumt
ihn bei jedem Nicht-„degraded"-Übergang auf).

**Verifikationsentscheidung:** die konkrete 68-Sekunden-Verzögerung war
beim zweiten Testlauf (nach dem Fix) nicht reproduzierbar — der
zugrunde liegende, sehr späte 5xx auf eine vor dem Abbruch gestartete
Anfrage ist ein nichtdeterministisches Netzwerk-Timing-Artefakt, kein
zuverlässig auslösbares Live-Szenario. Statt eines zweiten Zufallstreffers
abhängig zu sein: ein deterministischer Unit-Test
(`ui/shell/connection_test.ts`, `@std/testing`s `FakeTime` +
gestubbtes `globalThis.fetch`, drei Fälle) deckt den exakten Mechanismus
ab — Selbstheilung nach einem Fehlschlag, wiederholtes Retry über
mehrere 3s-Zyklen bis zum tatsächlichen Erfolg, 4xx zählt nicht als
Konnektivitätsproblem. Der Live-CDP-Test selbst deckte danach den
architektonisch geforderten Kernfall sauber ab (Stop → Pill
„disconnected" binnen ~12s, Banner mit Countdown, Content gesperrt →
Start → SSE reconnected binnen ~18s, Pill „connected", Banner weg,
aktiver Tab frisch neu gemountet).

**Scope-Grenze (§1.4-Phasenplan, nicht in dieser Sitzung):**
Settings-Menü (Teil 3, inkl. des in §1.3b erwähnten Zahnrads —
Teil 1 liefert nur Pill + Tabs), `ui/kit`-Bausteine und Node-Bundle-
Migration auf Tokens (Teil 2), Nutzer-Präferenzen in Postgres +
Sprachumschaltung (Teil 4). SVG-Canvas/Breadcrumb/Snapshot-Bar/Palette
in `flow-canvas.ts` bewusst nicht auf Design-Tokens umgezogen — §1.4
nennt für Teil 1 nur App-Bar, Hosts-/Workflows-View, Toasts und das
Parameter-Panel als „Shell-eigene Flächen".

## 2026-07-14 — K2 Teil 2 (MXF) Vorrecherche: Codec-Essenz aus PIPELINE CONTROLLER identifiziert (reine Recherche, kein Code)

Zeitlich knappe Sitzung (Nutzer-Vorgabe: 30 Minuten bis Feierabend,
Kontextfenster schon bei 83%) — kein neuer Implementierungsschritt
begonnen, stattdessen die in `docs/END-GOAL-FEATURES.md` §2.5 Punkt 1
offen gebliebene Recherchefrage geklärt, damit die nächste K2-Sitzung
direkt mit Teil 1 (MP4) starten kann, ohne diese Frage zwischendurch
nachzuholen.

**Befund:** `/home/infantilo/PIPELINE CONTROLLER/lib/PlayerPipeline.js`
behandelt MXF mit **MPEG-2-Video (`mpeg2video`)** nicht nur beiläufig,
sondern codec-spezifisch verzweigt — `PlayerPipeline.js:244–245`
(`if (!/mpeg2video/.test(codec)) return null;`, im Kontext des
NVDEC-Hardware-Decode-Pfads, Zeilen 133/139). Das README (`README.md`
„⚠️ Note on Codecs") nennt H.264/MPEG-2/AC-3/DTS als die lizenzrelevanten,
tatsächlich genutzten Codecs aus `gst-plugins-bad`/`-ugly`. Damit ist
MPEG-2 die einzige durch einen erprobten Referenzpfad belegte
MXF-Video-Essenz — AVC-Intra/DNxHD sind nicht abgedeckt.

**Für K2 Teil 2:** MPEG-2 als Pflicht-Essenz behandeln,
`gstreamer1.0-libav`/`-ugly` als Pflicht-Systemdependency in `deploy/`
dokumentieren (inkl. desselben Lizenz-Hinweises wie im
PIPELINE-CONTROLLER-README). Ohne Bedeutung für K2 Teil 1 selbst
(MP4/H.264, testdatei-generiert, kein MXF-Sonderweg).
`docs/END-GOAL-FEATURES.md` §2.5 entsprechend aktualisiert (Punkt 1
beantwortet, Punkte 2/3 als bereits durch Kapitel 10 entschieden
markiert statt weiter als offen zu stehen).

**Nächster Schritt:** K2 Teil 1 (Datei-Playback MP4/MOV in
`omp-player`) als eigene, vollständige Sitzung mit Live-Verifikation —
nicht in dieser verkürzten Sitzung begonnen, um keinen unfertigen
Zwischenstand zu hinterlassen.

## 2026-07-15 — K2 Teil 1: `omp-player` Datei-Playback (MP4/MOV)

Umsetzung von `docs/END-GOAL-FEATURES.md` §2.4 Teil 1 (Kapitel-10-
Reihenfolge `K1-Teil-1 → K2-Teil-1 → …`, `UMSETZUNG.md` §6a). Volle
Beschreibung der Änderungen dort; hier nur die Entscheidungen/der
gefundene Bug, die über die reine Umsetzung hinausgehen.

**Neue Abhängigkeit `gstreamer-pbutils` (0.25.2, nicht 0.25.3 —
letztere existiert für dieses Crate auf crates.io noch nicht,
`gstreamer` selbst schon):** für `Discoverer`-basierte Dauer-Probe.
Minimal-Dependency-Regel erfüllt — Teil von gst-plugins-base wie
`gstreamer` selbst, keine neue Systemdependency, kein sinnvoller
Eigenbau (Dauer-Ermittlung braucht denselben Demux-Stack wie die
Wiedergabe).

**`gst::glib::filename_to_uri` statt manueller String-Konkatenation**
für die `file://`-URI: löst Leerzeichen-/Umlaut-Kodierung in
Dateinamen korrekt (per-Segment-Percent-Encoding). `PlayerPipeline.js`
(`file://${abs}`) hat das Problem trotz der `UMSETZUNG.md` §0 Punkt
9 zitierten Doku-Zeile tatsächlich nie gelöst (nachgeprüft: kein
`encodeURIComponent` im referenzierten Code) — der Rust-/glib-Weg ist
hier strukturell besser, nicht nur übernommen.

**Path-Traversal-Schutz für `file`-Argument** (`resolve_media_path`,
`main.rs`): `OMP_MEDIA_DIR.join(rel).canonicalize()` +
`starts_with(OMP_MEDIA_DIR.canonicalize())`. Ohne diese Prüfung hätte
`{"file":"../../../etc/passwd"}` (oder jede andere Datei außerhalb des
Medienverzeichnisses) über die Descriptor-API dekodiert werden können —
klassischer Path-Traversal/Arbitrary-File-Read, hier bewusst
geschlossen statt "vertrauenswürdiger Operator" anzunehmen.

### Gefundener Bug: `gst_mini_object_unref`-Crash beim EOS-Drop-Pad-Probe

**Symptom:** `GStreamer-CRITICAL: gst_mini_object_unref: assertion
'mini_object != NULL' failed`, reproduzierbar bei jedem `cue()` eines
Datei-Items. In normalem Betrieb nicht fatal (Prozess lief über
mehrere Cue/Take/EOS-Zyklen zuverlässig weiter, alle Funktionstests
bestanden), aber ein echtes Refcounting-Symptom, das nicht einfach
ignoriert werden sollte.

**Diagnose:** `G_DEBUG=fatal-criticals` + `gdb -batch -ex run -ex bt`
gegen einen manuell gestarteten `omp-player`-Prozess (Registry/NATS/
MXL-Domain unverändert, eigener Port) — Backtrace zeigte den Crash tief
in einer rekursiven `gst_pad_push_event`/`gst_pad_forward`-Kette auf
Thread `multiqueue1:src`, ausgelöst exakt dann, wenn der ursprüngliche
`EVENT_DOWNSTREAM`-Pad-Probe (auf dem Src-Pad des `capsfilter`s direkt
hinter der Konform-Kette, ohne Thread-Grenze zu `uridecodebin`) ein
EOS-Event per `PadProbeReturn::Drop` verwarf. Bestätigt per A/B-Test:
Probe komplett deaktiviert → kein Crash über mehrere Zyklen; Probe
aktiv → reproduzierbar bei jedem Cue.

**Ursache (Hypothese, durch das Verhalten gestützt, nicht per
GStreamer-Quellcode verifiziert):** `uridecodebin`s internes
`multiqueue` verteilt EOS rekursiv an seine eigenen Ghost-/Proxy-Pads
über `gst_pad_forward` — mein Probe lag ohne Thread-Grenze auf
demselben Streaming-Thread wie dieser interne Mechanismus und geriet
mit dessen eigenem Unref des Event-Objekts in einen Race.

**Fix:** ein `queue`-Element zwischen Konform-Kette und isel-Pad
eingefügt (pro Datei-Zweig, Video wie Audio), Probe auf dessen Src-Pad
verschoben — Standardtechnik, um einen Zweig unabhängig von seiner
Quelle EOS-behandeln zu können (echte Thread-Grenze statt geteilter
Streaming-Thread). Nach dem Fix: unter `G_DEBUG=fatal-criticals`/gdb
kein Crash mehr über mehrere Zyklen (inkl. Neu-Cuen nach EOS in
denselben Slot, was die `uridecodebin`-Teardown-Ownership im
Audio-Branch übt).

**Bekannte Restwarnung (nicht weiter verfolgt):** eine einzelne
GStreamer-CRITICAL-Zeile tritt weiterhin kurz nach `cue()` auf,
zeitlich nicht mehr mit dem tatsächlichen EOS korreliert (eher
`uridecodebin`/`decodebin3`-interne Multiqueue-Startlogik in
GStreamer 1.22 als Ursache vermutet). Kein beobachtbarer Funktions-
oder Stabilitätseffekt in allen Tests dieser Sitzung. Empfehlung:
beobachten, nicht blockierend für K2-Teil-2/-3 — bei künftigen
GStreamer-Versions-Updates erneut prüfen, ob sie verschwindet.

**Verifikationsprotokoll:** `cargo build/test --workspace` grün.
Testdatei per neuem `deploy/dev/make-test-media.sh` erzeugt (H.264/AAC-
MP4, 640×480@25, SMPTE + 440 Hz, per `gst-launch-1.0`, kein Asset-
Beschaffungs-Blocker). Echter `omp-player`-Prozess: `append`/`cue`/
`take` per API, `durationMs=5000` korrekt von `Discoverer` geprobt.
Über `POST /api/v1/graph/edges` mit einem echten `omp-viewer`
verbunden — MJPEG-Preview zeigte visuell bestätigt die SMPTE-
Farbbalken aus der Datei (Screenshot geprüft, nicht nur "Bytes
empfangen"), nicht das alte Testmuster. `omp.player.<id>.itemEnded
{"item_id":"item1"}` exakt ~5 s nach `take()` per `nats sub`
beobachtet. Mehrere Cue/Take-Zyklen inkl. Neu-Cuen nach EOS in
denselben Slot ohne Absturz (normaler Betrieb, ohne
`G_DEBUG=fatal-criticals`). Test-Instanzen/-Prozesse danach entfernt.

**Nächster Schritt:** K3/K4-Teil-1 (nach Kapitel-10-Reihenfolge) oder
K2-Teil-2 (MXF) — beide unabhängig startbar, Nutzer entscheidet.

## 2026-07-15 — K5-Teil-0: OGraf-Render-Spike — klares Go für wpesrc, `docs/decisions.md` 2026-07-07 (B2) zu Chromium-Sandbox-Crash überholt

`docs/END-GOAL-FEATURES.md` §5.4 Teil 0 verlangt vor jedem
`omp-ograf`-Node-Code einen Render-Spike mit Go/No-Go-Entscheidung
zwischen Variante A (`wpesrc`, nativ in der Pipeline) und Variante B
(Headless-Chromium als Kindprozess, CDP-Screencast → `appsrc`) — Risiko
laut §5.3 explizit benannt: „`wpesrc` ist auf Debian/Crostini oft nicht
paketiert, und Chromium crasht in der Claude-Sandbox (decisions B2)".
Beide Annahmen empirisch geprüft statt übernommen:

**`wpesrc`-Paketierung:** `gst-inspect-1.0 wpesrc` meldete zunächst
„No such element" — aber `apt-cache search wpe` zeigt das Paket
`gstreamer1.0-wpe` (Version 1.22.0-4+deb12u7, exakt passend zur
installierten `gstreamer1.0-plugins-bad`-Version) als verfügbar, nur
nicht installiert. Nach `apt-get install gstreamer1.0-wpe
libwpebackend-fdo-1.0-1` registriert `gst-inspect-1.0 wpesrc`
erfolgreich (`GstWpeSrc`, `location`-Property für die URL,
`draw-background`-Property für Alpha-Hintergrund) — die
Paketierungs-Sorge war auf diesem Dev-System unbegründet.

**Chromium-Sandbox-Crash (B2, 2026-07-07):** seit mehreren späteren
Sitzungen (K1-Teil-1, K2-Teil-1, K3/K4-Teil-1, alle per
`chromium --headless=new --no-sandbox --disable-gpu` + Node-CDP-
WebSocket-Client) läuft Chromium in dieser Umgebung reproduzierbar
stabil — der B2-Befund war entweder umgebungsspezifisch (andere
Claude-Code-Ausführungsumgebung damals) oder durch seither geänderte
Flags (`--headless=new` statt `--headless=old`, kein `--single-process`)
gelöst. **B2 ist damit für den aktuellen Stand überholt** (dort selbst
nicht mehr korrigieren — Sitzungsprotokoll bleibt unverändert, dieser
Eintrag ist die Richtigstellung).

**Test-Aufbau (5 echte Templates aus `PIPELINE CONTROLLER`, wie von
§5.4 gefordert):** `digital-clock-top-left`, `breaking-news`,
`flat-design-lower-third`, `scorebug`, `ticker` (Verzeichnisse 1:1
kopiert nach `/tmp/.../ograf-spike/`, **nicht** ins Repo — Lizenzfrage
§5.5 Punkt 4 weiterhin offen). Generische Test-Harness (`harness.html`)
nachgebaut, die exakt den in §5.2 beschriebenen EBU-OGraf-v1-Lifecycle
fährt: Manifest per `fetch()` laden, `main`-ES-Modul per `import()`
laden, `default export`-Klasse (extends `HTMLElement`) per
`customElements.define()` registrieren, Instanz anhängen,
`load({renderType:"realtime", data: <Schema-Defaults>})` →
`playAction({skipAnimation:true})` — **wichtiger Formfund:** `main` ist
keine bereits registrierte Custom-Element-Datei, sondern ein
**default-exportierter Klassen-Konstruktor**, den die Host-Seite selbst
registrieren muss (ohne `customElements.define()` wirft der Browser
„Illegal constructor" bei `new`) — in §5.3 nicht explizit so
festgehalten, wichtig für den echten Node-Host-Seiten-Code (Teil 1).
Über `python3 -m http.server` bereitgestellt (nicht `file://` — ES-
Modul-`import()` scheitert dort an fehlenden CORS-Headern, dasselbe
Muster wie die node-eigene HTTP-Auslieferung in Teil 1 ohnehin vorsieht).

**Ergebnis:** alle 5 Templates rendern über `wpesrc` (WPE WebKit 2.38.6)
pixelidentisch zur Chromium-Kontrollprobe (Chromium 150, per CDP-
Screenshot) — inklusive anspruchsvoller CSS-Features, die eine ältere
WebKit-Engine potenziell unterschiedlich behandeln könnte
(`clip-path`-Polygone + `repeating-linear-gradient` bei
„Breaking News", `backdrop-filter: blur` + `env(safe-area-inset-top)`
bei der Uhr, live `setInterval`-Zeitaktualisierung). **Alpha-Kanal
pixelgenau verifiziert, nicht nur angenommen:** `wpesrc
draw-background=false ! videoconvert ! video/x-raw,format=BGRA !
... ! pngenc` liefert PNG mit Colortype 6 (RGBA); `ffmpeg`-Pixelsonde
zeigt Hintergrund `rgba(0,0,0,0)` (vollständig transparent) und einen
Content-Pixel mit `rgba(17,34,102,217)` bei CSS-Vorgabe
`rgba(20,40,120,0.85)` — Rundungsdifferenz im Bereich der 8-Bit-
Quantisierung, keine strukturelle Abweichung.

**MXL-`video/v210a`-Alpha-Flow (§11.2-Auflage, „gegen aktuellen
MXL-Spec-Stand verifizieren"):** `third_party/mxl/lib/internal/src/
FlowParser.cpp` behandelt `media_type == "video/v210a"` explizit
(inkl. Validierung „Invalid video height for interlaced v210a. Must be
even."), eigene Test-Flow-Definition
(`lib/tests/data/v210a_flow.json`) — die installierte MXL-Bibliothek
unterstützt den in §5.3 vorgesehenen nativen Alpha-Flow-Typ bereits,
keine Fallback-Lösung (getrennte Fill+Key-Flows) nötig.

**Go/No-Go-Entscheidung (§5.5 Punkt 2 hiermit beantwortet): Variante A
(`wpesrc`)**, wie in `ARCHITECTURE.md` §11.2 ursprünglich vorgesehen —
ein Prozess statt Node+Chromium-Kindprozess+CDP-Screencast-appsrc-Weg,
kein Zusatzprozess, kein Screencast-Encoding-Umweg, und das
Paketierungsrisiko hat sich als nicht bestehend herausgestellt. Variante
B wurde bewusst nicht zusätzlich als Pipeline aufgebaut (nur als
Chromium-Kontrollprobe für den visuellen Vergleich) — §5.5 Punkt 2 sieht
den Zusatzaufwand nur vor, „falls der Spike beide Varianten grün zeigt"
UND eine Abwägung nötig ist; hier ist A eindeutig vorzuziehen, B liefert
keinen zusätzlichen Erkenntniswert.

**Nicht Teil dieses Spikes (bewusst, gehört zu K5-Teil-1+):** Node-
Prozess-Integration (`nodes/omp-ograf`), MXL-Ausgang, Descriptor,
Mixer-DSK-Anschluss, Hotkeys/Children/Variablen-Auflösung, Lizenzklärung
der Templates (§5.5 Punkt 4, weiterhin offen). `gstreamer1.0-wpe` ist
nur auf dieser Dev-Maschine installiert — gehört für reproduzierbare
Deploys in `deploy/dev/install-mxl.sh` oder ein neues
`deploy/dev/install-wpe.sh` (Teil 1).

**Nächster Schritt:** K5-Teil-1 (Kern-Node: Template-Scan, `show`/`hide`
eines Templates, Alpha-MXL-Ausgang) — eigene Sitzung, wie im Phasenplan
vorgesehen. Lizenzfrage (§5.5 Punkt 4) sollte vor der Template-Übernahme
ins Repo (Teil 1) geklärt werden.

## 2026-07-16 — K5-Teil-1: `omp-ograf`-Kern-Node fertig verifiziert — echter Wurzelursache-Fund zum Dauerstillstand aus der WIP-Sitzung (2026-07-15)

Fortsetzung von Commit `d4a8597` ("[K5-1 WIP] ... noch NICHT end-to-end
live verifiziert"). Der End-to-end-Live-Test aus dieser Sitzung deckte
auf, dass die dortige Diagnose ("eigener Thread konkurriert mit WPEs
GLib-Hauptschleife") eine **Fehldiagnose** war — der tatsächliche Bug lag
woanders, in drei Teilen:

1. **Preroll-Deadlock durch fehlendes `async=false`.** Mit `gdb -p <pid>
   -batch -ex "thread apply all bt"` (ptrace erlaubt in dieser Sandbox,
   `sudo -n gdb` reicht) blieben alle drei `appsink`s der Pipeline (Fill-
   Ausgang, Key-Brücke, Key-Ausgang) dauerhaft in
   `gst_base_sink_wait_preroll()` hängen — bestätigt durch
   `GST_DEBUG=GST_STATES:5`: keiner der drei erreichte je "completed
   state change to PLAYING", obwohl jedes Nicht-Sink-Element (inkl.
   `wpesrc`) das längst gemeldet hatte. **Root cause, per Konsultation von
   `PIPELINE CONTROLLER/lib/PlayerPipeline.js`/`MasterPipeline.js`
   gefunden (`UMSETZUNG.md` §0 Punkt 9 — hätte zuerst passieren müssen,
   nicht erst nach stundenlangem Trial-and-Error):** jeder Tee-Zweig-Sink
   dort trägt explizit `sync=false async=false`; unsere drei Appsinks
   hatten nur `sync=false`. Ohne `async=false` muss ein Sink erst einen
   Puffer empfangen, bevor sein PAUSED→PLAYING-Übergang als
   abgeschlossen gilt — bei drei Sinks an einem `tee` genügt ein einziger
   Zweig mit minimal abweichendem Timing, um die gesamte Pipeline
   dauerhaft in ASYNC hängen zu lassen. Fix: `async=false` auf alle drei
   Appsinks (`omp_mediaio::mxl::MxlVideoOutput`, `spawn_alpha_key_bridge`).
2. **`is-live=true` auf dem Alpha-Brücken-`appsrc` war falsch.** Ein
   `appsrc`, der mitten in der Pipeline manuell per `push_buffer()`
   gefüttert wird, ist keine echte Live-Quelle — mit `is-live=true`
   liefert er laut GstBaseSrc-Vertrag aber keinerlei Daten, solange die
   Pipeline nur PAUSED ist ("no preroll for live sources"), was den
   dahinterliegenden Key-`MxlVideoOutput`-Sink nie prerollen ließ. Fix:
   `is-live` auf dem GStreamer-Default `false` belassen (Property
   entfernt).
3. **Henne-Ei-Problem beim Node-Start.** `wpesrc` lädt die Harness-Seite
   schon beim Pipeline-Aufbau (`Pipeline::build`) — der reguläre
   Descriptor-HTTP-Server (`omp_node_sdk::start()`) startet aber erst
   *danach* (er braucht den fertigen `PipelineHandle` für `OgrafStore`).
   Per `GST_DEBUG=*:3` beobachtet: `wpeview ... error: Failed to load
   http://127.0.0.1:9330/ograf-harness.html (Could not connect to
   127.0.0.1: Connection refused)`. Fix: `main.rs` startet jetzt einen
   eigenen, minimalen `HarnessOnlyStore`-HTTP-Server (nur
   `templates::route`, sonst leere Descriptor/Params/Methods) auf einem
   OS-zugewiesenen Port **vor** dem Pipeline-Aufbau
   (`omp_node_sdk::server::spawn` bindet synchron, Verbindungen warten im
   Kernel-Backlog bis die Accept-Loop läuft) — der reguläre
   Descriptor-Server bedient dieselben Pfade zusätzlich, sobald er später
   verfügbar ist.

Zusätzlich (kleinere, aus (1) folgende Anpassung): `Pipeline::build`
macht den State-Wechsel jetzt zweistufig PAUSED→(`get_state`)→
PLAYING→(`get_state`), weil `wpevideosrc0` (Live-Quelle in `wpesrc`)
`NO_PREROLL` statt `ASYNC`/`SUCCESS` meldet (GStreamers Vertrag für Live-
Quellen), was sich bis zum Pipeline-Objekt selbst hochpflanzt
(`gst_bin_change_state_func`: "we have NO_PREROLL elements SUCCESS ->
NO_PREROLL") — ein einzelner `set_state(Playing)`-Aufruf ohne
begleitendes `get_state()` verarbeitet GStreamers interne
Zustands-Buchhaltung dafür nicht zuverlässig; `gst-launch-1.0` (als
Kontrollprobe durchgehend funktionsfähig) fährt intern denselben
zweistufigen Ablauf.

**`spawn_alpha_key_bridge` blieb bei einem eigenen Thread + blockierendem
`try_pull_sample()`** (statt der WIP-Sitzung eigenem `AppSinkCallbacks`-
Versuch) — das ist das bewährte, von acht anderen Nodes seit C4
verwendete Muster aus `tools/mxl-gst/testsrc.cpp`; mit `async=false`
gelöst ist kein Callback-Umbau nötig.

**Verifiziert (echte Prozesse, kein Mock):** `cargo build/test
--workspace` grün (inkl. der 4 `omp-mediaio::mxl`-Tests), `cargo deny
check`/`cargo audit` grün. End-to-end per echtem `omp-ograf`-Prozess
(über den Instanz-Launcher gestartet, `make contract` läuft grün gegen
den echten `api_base_url`): `show("hello-lower-third", {title,
subtitle, accentColor})` → Fill-MXL-Flow zeigt die Bauchbinde mit den
übergebenen Werten (per `omp-viewer`-MJPEG-Preview, JPEG-Frame aus dem
Multipart-Stream extrahiert und visuell bestätigt: korrekter Titel,
Untertitel, roter/grüner Akzentbalken je nach Testlauf) — Key-MXL-Flow
zeigt zeitgleich die passende Alpha-Maske (heller Kasten dort, wo das
Fill-Bild deckend ist, transparent/schwarz drumherum, weicher
Kantenverlauf durch den halbtransparenten Kasten-Hintergrund). `hide()`
setzt den Key-Flow zurück auf vollständig transparent (per Preview
bestätigt). Beide MXL-Flows laufen nach dem Fix durchgehend mit realer
Framerate (`mxl-info -f <flow>` zeigt kontinuierlich wachsenden
`Last write time`/`Head index`, nicht nur einen einzelnen Frame) — vor
dem Fix blieb `Head index` nach exakt einem Frame stehen.

**Bekannte, nicht blockierende Einschränkung (vorbestehend seit C4,
nicht neu):** `omp_mediaio::mxl::write_loop`s Grain-Index wird beim
ersten Puffer einmalig per `get_current_index()` gesetzt und danach nur
noch lokal hochgezählt (Datei-Doku: "ohne Selbstkorrektur bei Drift").
Ein Reader, der sich erst **deutlich** nach dem ersten Puffer an einen
Flow anschließt (z. B. nach einer sehr langen interaktiven
Debug-Sitzung), kann dadurch einen zu weit in der Zukunft liegenden
Index erwarten und dauerhaft "TOO EARLY" melden — reproduziert an einem
absichtlich sehr spät verbundenen `mxl-gst-sink`/`omp-viewer` gegen den
Key-Flow dieser Sitzung. Ein frisch gestarteter Node mit sofort
verbundenem Reader (normaler Betriebsfall) zeigt das Problem nicht (per
zweitem, sauberem Testlauf bestätigt). Nicht in dieser Sitzung behoben
(betrifft den gemeinsamen `omp-mediaio::mxl`-Code, nicht `omp-ograf`
spezifisch, und ist kein K5-Teil-1-Blocker) — Kandidat für eine spätere
PTS-basierte Selbstkorrektur, falls Drift in Produktion beobachtet wird.

**Nebenbefund, nicht Teil dieser Scheibe:** während dieser Sitzung
(hoher gleichzeitiger `wpesrc`/`WPEWebProcess`-Ressourcenverbrauch bei
vielen Neustart-Iterationen auf der nur 6,5-GB-RAM-Dev-Maschine) hat der
Linux-OOM-Killer den persistenten `omp-video-mixer-me`-Instanzprozess
des laufenden Regieplatz-Demo-Setups beendet (`dmesg`: `Out of memory:
Killed process ... (omp-video-mixer)`, `total-vm:8004248kB,
anon-rss:5575152kB` — ein ungewöhnlich hoher RSS-Wert, der separat
untersucht werden sollte). `omp-source`/`omp-player-video` verschwanden
im selben Zeitraum ebenfalls aus dem Launcher (vermutlich derselbe
Ressourcendruck). Alle drei wurden über den Instanz-Launcher neu
gestartet, die Mixer→Viewer-Kante neu verbunden; die ursprüngliche
Crosspoint-/Tally-Konfiguration des Mixers ist NICHT wiederherstellbar
(kein Snapshot vorhanden, `GET /api/v1/snapshots` war leer) — der
Projektinhaber sollte das beim nächsten UI-Besuch neu einrichten.

**Status-Checkliste:** K5-Teil-1 erledigt.

## 2026-07-16 (Nachtrag) — `omp-video-mixer-me`: Regieplatz-Nachwirkung des OOM-Vorfalls behoben, `crosspoint.take` (PGM-Hot-Cut) neu, §3.5 offene Frage 1 beantwortet

Direkte Fortsetzung derselben Sitzung wie K5-Teil-1 oben — der
Projektinhaber meldete nach dem OOM-Vorfall drei Punkte am
wiederhergestellten Regieplatz-Demo.

**1. Source→Mixer→Viewer zeigte Schwarzbild.** Kein neuer Bug — der
Mixer-Ausgang selbst (`ActivePipeline`) war unauffällig, aber der
FG/BG-Eingangs-Lesepfad hatte den bereits dokumentierten
**„MXL-Read-Livelock"** getroffen (`docs/decisions.md` 2026-07-09/2026-
07-14, TOCTOU-Fenster in `third_party/mxl/lib/internal/src/Sync.cpp`s
`waitUntilChanged`, seit C8 offen, nicht in dieser Sitzung behoben —
weiterhin „eigene künftige Sitzung" laut damaliger Einschätzung).
Verifiziert per `gdb -p <pid> -batch -ex "thread apply all bt"` +
Vergleich der `utime`-Werte aus `/proc/<pid>/task/*/stat` zwischen zwei
Zeitpunkten (kein einzelner Thread bei durchgehend 100 %, aber
`crosspoint.programInput` korrekt gesetzt und Ausgang trotzdem
byte-identisch schwarz über mehrere Minuten — passt zu „Reader-Pad
bekommt nie ein erstes Bild" statt zu einem generischen Pipeline-
Fehler). Empirisch reproduziert: Neuwahl + `cut()` blieb wirkungslos,
ein kompletter Neustart der Mixer-Instanz behob es sofort (etabliertes
Recovery-Muster aus den C7-Sitzungen). Traf während der Verifikation
**erneut** bei einer frischen Instanz auf (bestätigt „intermittierend,
nicht bei jeder Quellwahl" aus der ursprünglichen Diagnose) — zweiter
Neustart behob es wieder. Kein Fix in dieser Sitzung (bewusst, s. o.),
nur Diagnose + Workaround angewendet.

**2. Frage: wann kommt das Settings-Menü?** `docs/END-GOAL-FEATURES.md`
§1.4 K1-Teil-3 (Settings-Panel, Theme-Umschaltung) — kommt planmäßig
*nach* K1-Teil-2 (`ui/kit`-Migration aller fünf bestehenden Node-
Bundles auf Tokens, bisher nur teilweise nebenbei in K3/K4-Teil-1
passiert, nicht als eigener abgeschlossener Schritt). Kein Termin
vergeben — beide Teile sind unpriorisiert offen, keine Kapitel-10-
Reihenfolge-Entscheidung deckt sie ab (die deckte nur die Teil-1-Scheiben
der Kapitel 1/2/3+4/5 ab).

**3. PGM/PST-Bus-Feedback, per Rückfrage geklärt (§3.5 offene Frage 1
hiermit beantwortet):**
- **PGM-Hot-Cut gewünscht** (nicht „nur Anzeige" wie bisher, s. K3/K4-
  Teil-1). Neue Node-Methode `crosspoint.take(senderId)`
  (`nodes/omp-video-mixer-me/src/pipeline.rs::Command::Take`): schaltet
  `isel`/`isel_bg` sofort auf `senderId`, identischer fg/bg-Alpha-
  Mechanismus wie `Cut`, aber **ohne** `preset`/`PresetChanged`
  anzurühren — der ursprüngliche Grund für „nur Anzeige" (ein
  impliziter `select+cut`-Umweg hätte die gestagte Preset-Auswahl
  überschrieben) ist damit strukturell vermieden, kein Kompromiss
  nötig. UI (`ui/bundle.js::makeBusButton`): PGM-Tasten rufen jetzt
  `crosspoint.take`, PST-Tasten weiterhin `crosspoint.select`.
  **Verifiziert:** `crosspoint.take` schaltet PGM sofort um
  (MJPEG-Preview zeigt den Ballwechsel ohne Take-Zwischenschritt);
  anschließendes `crosspoint.select` auf eine andere Quelle ändert
  nachweisbar nur `presetInput`, `programInput` bleibt unverändert
  (curl-Roundtrip auf beide Parameter nach jedem Aufruf bestätigt).
- **PST-Vorschau-Ausgang gewünscht** (zweiter, optional zuschaltbarer
  MXL-Sender mit dem Preset-Bild, damit der Bildmeister vor dem Take
  sieht, worauf er schneidet) — **explizit auf die nächste Sitzung
  verschoben** (Projektinhaber-Entscheidung): `isel_bg` spiegelt außerhalb
  einer Transition das *Programm*, nicht das Preset (Invarianten-
  Kommentar in `pipeline.rs`) — ein echter PST-Tap braucht einen neuen,
  dritten `input-selector`-Zweig plus einen zweiten `MxlVideoOutput`,
  keine reine UI-Änderung.
- **Per-Bus-Button-Thumbnails** (Low-Res-Vorschau direkt auf jedem
  Crosspoint-Button) als eigene, größere Anfrage benannt, bewusst nicht
  mitgeplant — bräuchte einen Preview-Mechanismus pro Eingang (N
  Mini-Decodes oder Server-Thumbnails), keine Erweiterung des
  PST-Ausgangs. Kandidat für eine eigene künftige Sitzung, evtl.
  zusammen mit dem `omp-multiviewer`-Node.
- §3.5 offene Frage 2 (Button-Bank-Verhalten bei vielen Quellen/Zeilen-
  Umbruch) bleibt offen — hängt mit dem vom Projektinhaber beobachteten
  „PST/PGM wirkt nicht horizontal"-Eindruck zusammen (`.bus-buttons`
  hat `flex-wrap: wrap`; mit den während dieser Sitzung angesammelten
  Registry-Leichen aus mehreren Neustarts sprangen die Reihen sichtbar
  auf zwei Zeilen um — nach Bereinigung der Alt-Einträge wieder eine
  Zeile). Nicht eigenständig behoben, da unklar ob echtes Layout-
  Problem oder nur ein Nebeneffekt der Registry-Leichen dieser Sitzung.

**Verifiziert:** `cargo build/test --workspace` grün (inkl. neuer
`Command::Take`-Pfad). Live per echtem Prozess über den Instanz-
Launcher, MJPEG-Preview-Frames extrahiert und visuell verglichen (nicht
nur Parameter-Werte). Test-Instanzen (mehrere Mixer/Source/Player-
Neustarts zur Livelock-Diagnose) am Ende bereinigt, Demo-Vierergespann
(Source/Videoplayer/Mixer/Viewer) läuft wieder gesund, Speicher
unauffällig (~700 MB von 6,5 GB).

**Nächster Schritt (Vorschlag, nicht vom Projektinhaber priorisiert):**
PST-Vorschau-Ausgang (zweiter `MxlVideoOutput` vom Preset-Zweig) als
eigener Schritt, dann optional Per-Button-Thumbnails.

## 2026-07-16 (Nachtrag 2) — PST-Vorschau-Ausgang versucht, wieder verworfen: zwei reale, schwerwiegende Befunde für die künftige Sitzung

Direkte Fortsetzung nach "fahre fort" — Versuch, den oben vertagten
PST-Vorschau-Ausgang (zweiter, zuschaltbarer MXL-Sender mit dem
Preset-Bild) umzusetzen. Implementiert (`isel_pst` + eigener
`MxlVideoOutput`, `preview.enabled`-Param/-Methode, UI-Toggle „PST
OUT"), aber **wieder vollständig verworfen (`git checkout --`)**, weil
die Live-Verifikation zwei ernste, echte Probleme aufdeckte statt einer
bloßen Kleinigkeit:

1. **Deutlich häufigeres Auftreten des bekannten MXL-Read-Livelocks
   ([[feedback_mxl_read_livelock_restart_workaround]]).** Ein erster
   Entwurf öffnete einen dritten, unabhängigen `MxlVideoInput` pro
   Crosspoint-Eingang (fg+bg+pst statt fg+bg) — der PST-Zweig hing
   danach bei 4 von 4 frischen Testläufen fest (Lesethread bei
   70–96 % CPU, `Head index` des Ausgangs bewegte sich nicht), während
   derselbe Prozess für PGM zuverlässig lief. Fix versucht: `bg` und
   `pst` teilen sich über ein `tee` + zwei `queue`s einen einzigen
   Reader statt einen dritten zu öffnen (senkt die MXL-Last pro
   Eingang wieder auf das fg+bg-Niveau) — das TEE-Muster selbst
   funktionierte, hat das Livelock-Symptom aber nicht sauber behoben
   (weiterhin gelegentliches Einfrieren beobachtet).
2. **Neuer, schwerwiegenderer Fund während der Verifikation: ein
   OOM-Kill des Mixer-Prozesses** (`dmesg`: zweiter `Killed process ...
   (omp-video-mixer)`-Eintrag dieser Sitzung, `anon-rss:5772456kB` —
   für einen 640×480-Mixer grotesk hoch). Auslöser laut
   `crashMessage` des Launchers: ein **Registry-Geist** — ein
   IS-04-Sender-Eintrag einer bereits gelöschten Mixer-Instanz war noch
   in der NMOS-Registry sichtbar (Registry-Ablauf ist unabhängig vom
   MXL-`mxl-info -g`, das den zugehörigen Flow bereits entfernt hatte),
   der Discovery-Loop nahm ihn als Crosspoint-Eingang auf,
   `MxlVideoInput::new` scheiterte mit „Flow not found", die Pipeline
   fiel auf Schwarzbild zurück — und **irgendwo in diesem
   Fehlschlag-Zyklus wuchs der Speicherverbrauch auf über 5 GB**, bevor
   der Kernel eingriff. Nicht abschließend rootursächlich geklärt
   (vermutet: wiederholte, sich gegenseitig überlagernde
   Rebuild-Versuche durch flackernde Registry-Sichtbarkeit desselben
   Geist-Eintrags — jeder Fehlschlag baut laut Code-Pfad eine komplette
   zweite Fallback-`ActivePipeline` zusätzlich zur bereits
   fehlgeschlagenen auf, ohne dass ersichtlich wäre, wo genau dabei
   Ressourcen nicht freigegeben werden).

**Deshalb bewusst NICHT committet** — beide Befunde sind gravierender
als „noch nicht ganz fertig" und hätten das ohnehin schon fragile
Discovery/MXL-Zusammenspiel dieses Nodes weiter destabilisiert, statt
es nur um ein Feature zu erweitern. Der Code-Stand vor diesem Versuch
(`[K3-Nachtrag]`-Commit, PGM-Hot-Cut) ist unverändert gut und bleibt so.

**Für die nächste Sitzung, falls der PST-Ausgang erneut versucht
wird:**
- Das Tee/Queue-Muster (bg+pst teilen sich einen Reader) beibehalten —
  strukturell richtig, senkt die MXL-Last, auch wenn es das Livelock-
  Symptom allein nicht gelöst hat.
- Der Registry-Geist-Bug ist wahrscheinlich **unabhängig vom
  PST-Feature selbst** (jeder Discovery-basierte Node mit
  `inputs_changed`-Rebuild-Logik — `omp-switcher`, `omp-video-mixer-me`
  — könnte ihn treffen, sobald eine Instanz gelöscht wird, deren
  MXL-Flow schneller verschwindet als ihr Registry-Eintrag abläuft);
  verdient eine eigene, gezielte Untersuchung mit Speicher-Profiling
  (z. B. `heaptrack`/`valgrind --tool=massif` gegen einen absichtlich
  herbeigeführten Geist-Eintrag), bevor irgendein neues Feature auf
  demselben Discovery-Mechanismus aufbaut.
- Diskussionswert: sollte die Discovery-Loop-Fehlerbehandlung einen
  Sender, dessen Flow nicht auflösbar ist, für einige Zyklen aus der
  Kandidatenliste ausschließen (Backoff), statt bei jedem Poll erneut
  einen vollen Rebuild-Versuch zu riskieren?

Umgebung danach bereinigt: abgestürzte/verwaiste Instanzen entfernt,
`mxl-info -g` aufgeräumt, Demo-Vierergespann (Source/Videoplayer/
Mixer/Viewer) neu gestartet und per 26-Frame-Live-Test (`curl
--max-time 5`, MD5-Vielfalt der MJPEG-Frames) als gesund bestätigt.
Speicher wieder unauffällig (~700 MB von 6,5 GB).

## 2026-07-16 (Nachtrag 3) — Flow-Editor: immer sichtbare Port-Labels + Key/Alpha-Farbe

Nutzerfund: Ports (die Kreise an Node-Kacheln) trugen ihren Namen nur
als SVG-`<title>`-Hover-Tooltip, nicht sichtbar ohne Maus-Hover — an
einer Kachel mit mehreren gleichartigen Ports (Bildmischer-Programm-/
Vorschau-Ausgang, `omp-ograf`s Fill/Key) war von außen nicht erkennbar,
welcher Port welches Signal führt. Zusätzlich gewünscht: Farbcodierung
nach Signalart (Video/Audio/Daten/Key-Alpha) — Video/Audio/Daten gab es
bereits (`portColor()`, seit B2), Key/Alpha fehlte.

**Zwei Teile:**

1. **`omp-node-sdk::node::{SenderSpec, ReceiverSpec}`** bekommen ein
   neues `label: Option<String>`-Feld — überschreibt das bisher einzig
   mögliche generische `"<NodeLabel> Sender N"`/`"... Receiver N"`.
   `None` verhält sich unverändert (rückwärtskompatibel, alle
   bestehenden `..Default::default()`-Aufrufstellen brauchten keine
   Änderung; eine einzige Stelle — `omp-viewer`s `ReceiverSpec`-Literal
   — war exhaustiv und musste um `..Default::default()` ergänzt
   werden). Angewendet: `omp-video-mixer-me`s einziger Sender heißt
   jetzt `"PGM"` statt `"VideoMixerME Sender 1"`; `omp-ograf`s beide
   Sender heißen `"<Label> Fill"`/`"<Label> Key"` statt `"... Sender
   1"`/`"... Sender 2"`.
2. **`ui/graph/flow-canvas.ts`:** `#renderPort()` rendert jetzt
   zusätzlich zum Kreis ein immer sichtbares `<text>`-Kurzlabel
   (`pointer-events:none`, damit Drag/Click weiter exklusiv am Kreis
   hängen). `portColor()` bekommt Key/Alpha: `format=video` **und**
   Label passt auf `/\bkey\b/i` → eigene Farbe (Pink/Magenta
   `#e05de0`) statt der normalen Video-Farbe — IS-04 kennt kein
   eigenes Key/Alpha-Format (Fill+Key sind beides ganz normale
   `urn:x-nmos:format:video`-Sender, nur inhaltlich verschieden), daher
   die Label-Heuristik statt einer Protokollerweiterung; robust genug,
   weil die einzige Quelle für "Key" im Label `SenderSpec::label` ist,
   das die Nodes selbst setzen, kein Match auf beliebigen Fremdtext.

  **Live-Test-Fund während der Verifikation:** der erste Entwurf von
  `portShortLabel()` kappte einfach von vorne auf 10 Zeichen — zeigte
  für `"OGraf Grafik (id) Fill"` und `"... Key"` (gleicher langer
  Node-Name als Präfix) für BEIDE Ports identisch `"OGraf Gra…"` und
  verlor genau das unterscheidende letzte Wort. Fix: das letzte Wort
  bevorzugen (meist die eigentliche Rolle), außer es ist eine nackte
  Zahl (generischer `"... Sender N"`-Fallback ohne eigenes Label) —
  dann die letzten zwei Wörter (`"Sender 1"`), damit wenigstens die
  Nummer sichtbar bleibt (Farbe unterscheidet Video/Audio zusätzlich).

  **Verifiziert:** `deno check`/`deno test ui/` (weiterhin 40/40),
  `cargo build/test --workspace`, `cargo deny check` grün. Live per CDP
  (Chromium headless, Node-WebSocket-Client, Screenshot statt
  `--dump-dom`): `omp-ograf`-Kachel zeigt "Fill" (blauer Port) und
  "Key" (pinker Port) sichtbar ohne Hover; `omp-video-mixer-me`-Kachel
  zeigt "PGM" (blau); `omp-player`-Kachel ohne eigenes Label zeigt
  weiterhin "Sender 1"/"Sender 2" (blau/orange) als sinnvollen
  Fallback. Bestehende Kante (Mixer-PGM → Viewer) blieb nach einer
  Kachel-Verschiebung per simuliertem Maus-Drag intakt (kein
  Seiteneffekt auf die IS-05-Verbindung). Test-Instanz (`omp-ograf`)
  danach entfernt, Demo-Dreiergespann läuft weiter gesund.

## 2026-07-16 (Nachtrag 4) — Flow-Editor: Format-Kürzel (V/A/D/K) explizit im Port-Label

Direktes Nutzer-Feedback auf Nachtrag 3: „ich kann anhand des Labels
noch nicht erkennen, ob es ein Video-, Audio- oder Daten-Ein-/Ausgang
ist" — die Farbcodierung allein verlangt, eine Legende auswendig zu
kennen, und war offenbar nicht selbsterklärend genug.

**Fix:** `#renderPort()` stellt dem Rollen-Text jetzt ein fett
gedrucktes, in der Port-Farbe eingefärbtes Format-Kürzel voran (neue
Funktion `formatAbbrev()`, gleiche Erkennung wie `portColor()` — dafür
`isKeyPort()` aus beiden Funktionen herausgezogen, damit sie nicht
auseinanderlaufen):
- `urn:x-nmos:format:video` → **V**
- `urn:x-nmos:format:audio` → **A**
- `urn:x-nmos:format:data` → **D**
- Key/Alpha (Label passt auf `/key/i`, s. Nachtrag 3) → **K**
- unbekannt → **?**

Umgesetzt über zwei `<tspan>`s im selben `<text>` (Kürzel fett + in
Portfarbe, Rollen-Text weiterhin grau) statt zwei getrennter
Text-Elemente — einfachere Positionierung, ein Element pro Port.

**Verifiziert:** `deno check`/`deno test ui/` (40/40) grün. Live per
CDP-Screenshot (Chromium headless): Mixer-PGM-Port zeigt jetzt „V PGM"
(blaues V), `omp-ograf`s Ports zeigen „V Fill" und „K Key" (pinkes K),
Videoplayer ohne eigenes Label zeigt „A Sender 2"/„V Sender 1" — das
Format ist jetzt direkt aus dem Text lesbar, nicht mehr nur aus der
(ggf. schwer unterscheidbaren) Kreisfarbe. Test-Instanz danach
entfernt.

## 2026-07-16 (Nachtrag 5) — Registry-Geist-OOM: Root Cause gefunden + gefixt

Fortsetzung von Nachtrag 2 (dort nur Symptom + Verdacht dokumentiert,
„nicht abschließend rootursächlich geklärt"). Root Cause jetzt
gefunden, während der Untersuchung sogar ein **frischer, echter
OOM-Kill live in diesem Environment mitgeschnitten** (nicht künstlich
provoziert): `dmesg` zeigte während der Recherche
`oom-kill: ... task=omp-video-mixer,pid=29907, anon-rss:5772456kB` —
harte Bestätigung, dass der in Nachtrag 2 vermutete Mechanismus real
und akut ist, nicht nur ein einmaliger Testartefakt.

**Root Cause:** `omp-mediaio::mxl::{MxlVideoInput, MxlVideoOutput,
MxlAudioInput, MxlAudioOutput}::new()` fügen ihre GStreamer-Elemente
(`appsrc`/`videoconvert`/… bzw. `.../appsink`) per `pipeline.add()`
hinzu und verlinken sie, **bevor** die eigentlich MXL-spezifischen
Schritte (`create_flow_reader`/`to_grain_reader` bzw.
`create_flow_writer`/`to_grain_writer`, sowie der `dynamic_cast` auf
`AppSrc`/`AppSink`) versucht werden. Schlägt einer dieser späteren
Schritte fehl — exakt der Fall bei einem Registry-Geist-Sender: die
Sender-Registrierung existiert in der NMOS-Registry noch (deren
Lebensdauer hängt an `registration_expiry_interval`/Heartbeat), aber
die zugehörige MXL-Shared-Memory-Flow wurde bereits unabhängig davon
abgebaut (Prozess beendet/gecrasht) —, gibt die Funktion über `?`
einen `Err` zurück, **ohne die bereits hinzugefügten Elemente wieder
aus der Pipeline zu entfernen**. Der Rust-Drop der lokalen
Element-Handles senkt nur den *Rust-seitigen* Referenzzähler; der
`pipeline`-Bin hält selbst noch einen Owning-Ref (durch `.add()`), die
Elemente bleiben also für die Lebensdauer der (bei `omp-video-mixer-me`/
`omp-switcher` inzwischen oft langlebigen, weil nicht mehr komplett
verworfenen) Pipeline im Speicher hängen. Jeder erneute Build-Versuch
gegen denselben persistenten Geist-Sender (ausgelöst durch *irgendeine*
andere, unabhängige Eingangsänderung, da der 2s-Discovery-Poll die
komplette Eingangsliste neu bewertet) akkumuliert weitere verwaiste
Elemente — daraus der beobachtete unbegrenzte Speicherwuchs bis zum
OOM-Kill.

**Fix, zwei Ebenen:**

1. **`omp-mediaio::mxl`** (Ort des eigentlichen Lecks): alle vier
   Konstruktoren bekommen einen `cleanup_partial`-Abschluss, der bei
   jedem Fehlschlag NACH dem `pipeline.add()`/Link-Schritt die eigenen
   Elemente per `set_state(Null)` + `pipeline.remove()` wieder entfernt,
   bevor `Err` zurückgegeben wird — symmetrisch für alle vier
   Konstruktoren (Video/Audio × Input/Output), nicht nur den
   ursprünglich beobachteten Video-Input-Fall (Audio-Sender sind seit
   `omp-audio-mixer`, C11, derselben Geist-Registrierungs-Gefahr
   ausgesetzt).
2. **`omp-video-mixer-me::pipeline` + `omp-switcher::pipeline`**
   (identisches C7/C10-Baumuster, beide betroffen): `build()` riss
   bisher komplett ab (`?`), sobald **ein einziger** Eingang fehlschlug
   — Folge: der gesamte Mixer/Switcher fiel auf Schwarzbild zurück,
   obwohl alle anderen Eingänge gesund waren, UND der Aufrufer danach
   zwingend einen zweiten vollen Build-Versuch (`build(..., &[])`)
   unternahm. Neue Funktion `build_one_input()` (bzw. dasselbe Muster
   in `omp-switcher`) baut jeden Eingang einzeln und räumt bei einem
   Fehlschlag alles, was sie selbst für DIESEN Eingang bereits angelegt
   hat (Branch-Elemente, angeforderte `isel`-Pads), vollständig wieder
   ab, statt es in der (durch die anderen Eingänge weiterhin
   erfolgreichen) Pipeline verwaisen zu lassen. `build()` gibt jetzt
   `(ActivePipeline, Vec<String>)` zurück — die Warnungen laufen als
   `Event::Error` durch denselben Kanal wie andere Fehler. Ein kaputter
   Eingang wird damit übersprungen und geloggt, statt den ganzen Mixer/
   Switcher lahmzulegen; der schon vorhandene Schwarzbild-Fallback
   bleibt als Sicherheitsnetz für strukturelle Fehler (z. B.
   `input-selector`/`compositor` selbst lässt sich nicht anlegen), nicht
   mehr für einzelne kaputte Quellen.

**Verifiziert:** `cargo build --workspace` grün. Live-Reproduktion per
absichtlich per NMOS-Registrierungs-API angelegtem Geist-Sender
(`flow_id` ohne je geschriebene MXL-Flow, also garantiertes „Flow not
found" bei `get_flow_def`): frischer `omp-video-mixer-me` fasste ihn in
seine Eingangsliste, Log zeigte `pipeline error: input
deadbeef-...-0002 (GHOST-TEST-SENDER) übersprungen: MxlVideoInput(fg,
...): get_flow_def(...): Flow not found` — **kein**
Fallback-auf-Schwarzbild, die zwei echten Eingänge (Source, Videoplayer)
blieben live, RSS blieb über ~45s beobachtet flach (~90MB, keine
Wachstumstendenz). Instanz + Test-Registrierung danach entfernt (Geist-
Registrierung läuft ohnehin ohne Heartbeat in wenigen Sekunden ab).

**Nicht Teil dieses Fixes (separat, während der Verifikation erneut
live beobachtet):** die MXL-Read-Livelock (busy-loop im vendorten
MXL-C++, s. 2026-07-10 "C8" und `read_loop`-Kommentar in
`omp-mediaio::mxl`) trat während eines Testlaufs mit echten Eingängen
erneut auf (ein Lese-Thread mit ~100% CPU über Minuten, RSS wuchs
dabei auf mehrere GB) — bestätigt als eigenständiges, weiterhin
ungelöstes Problem, nicht durch diesen Fix berührt. Dieser Testlauf
wurde abgebrochen, bevor er erneut OOM auslöste.

## 2026-07-17 — MXL-Read-Livelock (C8, s. 2026-07-10 und 2026-07-16
"Nachtrag 2") root-caused und behoben: `get_grain_non_blocking` statt
blockierendem `get_complete_grain`

Auf Anweisung gezielt an diesem seit 2026-07-10 bekannten, nie
root-ursächlich geklärten Bug weitergearbeitet (bisher nur Workaround:
Node neu starten, [[feedback_mxl_read_livelock_restart_workaround]]).

**Reproduktion (Diagnose-Test, `omp-mediaio::mxl::tests::
three_readers_livelock_diagnostic`, `#[ignore]`):** ein Writer schreibt
~16s Frames auf einen Flow, drei unabhängige `MxlContext`s (simulieren
drei getrennte Prozesse, wie `omp-video-mixer-me`s fg/bg/pst-Zweige es
real täten) lesen ihn gleichzeitig über den bisherigen blockierenden
Pfad (`GrainReader::get_complete_grain`, 500ms-Timeout je Aufruf). Der
Prozess hängt zuverlässig weit über jede plausible Gesamtlaufzeit
hinaus (mehrfach reproduziert: 40s/65s/90s-`timeout`-Läufe, alle per
SIGKILL beendet, nie sauber fertig) — mit einem Reader reicht dasselbe
Setup dagegen jedes Mal (bestätigt per `write_then_read_loopback`).

**Root Cause, per `gdb -p <pid> -batch -ex "thread apply all bt"`
(braucht `sudo`, da `/proc/sys/kernel/yama/ptrace_scope=1` in dieser
Umgebung; per `dangerouslyDisableSandbox` am Sandbox-Default vorbei,
siehe unten zur Sandbox-Frage) am hängenden Prozess bestätigt:** alle
drei Reader-Threads stecken *gleichzeitig* im selben Frame — einem
rohen `syscall()` (dem `FUTEX_WAIT`-Aufruf aus
`third_party/mxl/lib/internal/src/Sync.cpp::do_wait`), aufgerufen über
`waitUntilChanged` → `PosixDiscreteFlowReader::getGrain` →
`mxlFlowReaderGetGrainSlice` — deutlich länger als das an `getGrain`
übergebene `timeoutNs` (500ms). Der Writer war zu diesem Zeitpunkt
längst fertig (der Haupt-Thread wartete bereits in `pthread_join` auf
die Reader), CPU-Last dabei niedrig (kein Busy-Spin) — die Threads sind
also echt blockiert, nicht in einer enger Retry-Schleife gefangen.

Ausgeschlossene Erklärungen (per gezielten Mini-Reproduktionen
verifiziert, nicht nur vermutet):
- **Sandbox/Kernel-Artefakt dieser Crostini-Entwicklungsumgebung:**
  widerlegt — derselbe Diagnose-Test hängt identisch mit
  `dangerouslyDisableSandbox` (also außerhalb der Werkzeug-Sandbox).
- **`FUTEX_WAIT` respektiert generell keinen Timeout hier:** widerlegt
  — ein minimaler C-Probe (`syscall(SYS_futex, ..., FUTEX_WAIT, ...)`)
  auf privatem Speicher, auf `MAP_SHARED`-Dateispeicher unter `/tmp`
  und unter `/dev/shm` (tmpfs, wie MXLs echte Domain) liefert jeweils
  korrekt `ETIMEDOUT` nach der angeforderten Zeit.
- **Duration/Timepoint-Einheiten-Bug** (`third_party/mxl/lib/internal/
  include/mxl-internal/Timing.hpp`): geprüft, alle Umrechnungen
  (`asTimeSpec`/`asDuration`/Clock-Offsets) korrekt, `Clock::Realtime`
  wird konsistent für Deadline-Berechnung und -Vergleich verwendet.
- **Genereller Fehler im Retry-Muster "N Waiter + 1 Writer auf
  gemeinsamem Futex-Wort":** widerlegt — ein Rust-freier C-Mimic mit
  exakt diesem Muster (3 Waiter-Threads + 1 Writer-Thread, `fetch_add`
  + `FUTEX_WAKE` pro "Frame", identische `waitUntilChanged`-Logik
  nachgebaut) läuft sauber durch, jeder Aufruf bleibt nahe am
  500ms-Budget.

Die exakte Byte-genaue Ursache *innerhalb* der echten MXL-Shared-
Memory-Struktur (`FlowState`/`DiscreteFlowData`, vermutlich ein
Zusammenspiel aus der ungeschützten `flow->state.syncCounter++`
(nicht-atomarer Schreibzugriff neben `std::atomic_ref`-Lesern in
`PosixDiscreteFlowWriter::commit`) mit mehreren `MxlInstance`s, die
denselben Flow parallel öffnen) wurde **nicht** weiter isoliert — der
Aufwand dafür (Instrumentierung/Nachbau der echten `DiscreteFlowData`-
Struktur) stand in keinem Verhältnis zum Nutzen, sobald ein sauberer
Workaround feststand.

**Fix (statt Patch am vendorten C++, das mit `install-mxl.sh` bei
jedem Rebuild verlorenginge):** `omp-mediaio::mxl`s `read_loop`
(Video) und `read_audio_loop` (Audio) rufen jetzt
`GrainReader::get_grain_non_blocking` bzw. `SamplesReader::
get_samples_non_blocking` auf statt der blockierenden Varianten. Diese
durchlaufen im vendorten C++ nachweislich (`flow.cpp`,
`mxlFlowReaderGetGrainSliceNonBlocking` → `PosixDiscreteFlowReader::
getGrain(index, minValidSlices, grainInfo, payload)`, die *zweite*,
nicht-blockierende Überladung) den `waitUntilChanged`/`FUTEX_WAIT`-Pfad
gar nicht — reine Speicherprüfung, kein Syscall. Das komplette
Poll-Timing (5ms-Backoff bei `OutOfRangeTooEarly`, Sprung auf den
aktuellen Index bei `OutOfRangeTooLate`) liegt jetzt vollständig und
nachweisbar korrekt in Rust.

**Verifiziert:**
- Neuer Regressionstest `three_concurrent_readers_same_flow_do_not_hang`
  (echter Produktionspfad: drei `MxlVideoInput`-Instanzen mit je
  eigenem `MxlContext`, echte GStreamer-`appsrc`/`appsink`-Pipelines,
  kein Mock) — vor dem Fix reproduzierbar hängend (mit der blockierenden
  API testweise gegengeprüft), nach dem Fix `ok` in 5,6s, alle drei
  Reader mit ~124-125 von ~125 erwarteten Frames.
- Ein dabei gefundener Bug im *Test selbst* (nicht im Fix): das erste
  Test-Layout hielt `MxlVideoInput` nicht im `ReaderHandle` am Leben —
  `Drop` setzt `running=false` und beendet `read_loop` sofort, alle drei
  Reader bekamen dadurch 0 Frames. Klassischer Hinweis, spontane
  0-Ergebnisse bei allen Readern gleichzeitig immer erst auf
  Lifetime-Bugs im Testaufbau zu prüfen, bevor man den Fix selbst
  verdächtigt.
- `three_readers_livelock_diagnostic` bleibt als `#[ignore]`-Test
  erhalten (dokumentiert den historischen Bug über die alte
  blockierende API, dient als Regressionswächter, falls der Blocking-
  Pfad je wieder verwendet wird).
- `cargo build --workspace` und `cargo test --workspace` grün, `cargo
  fmt --check`/`cargo deny check` ohne neue Befunde (13 vorbestehende
  `fmt`-Abweichungen in `omp-mediaio` unverändert, nicht Teil dieser
  Änderung).

**Offen / für später:** der PST-Vorschau-Ausgang
(2026-07-16 "Nachtrag 2") kann jetzt erneut versucht werden — sein
Haupt-Blocker war genau dieser Livelock bei einem dritten Reader pro
Crosspoint-Eingang. Das dort empfohlene Tee/Queue-Muster (bg+pst teilen
sich einen Reader) ist mit diesem Fix wahrscheinlich nicht mehr nötig
(die Livelock-Ursache lag nicht an der MXL-Last, sondern am
blockierenden Lesepfad selbst), sollte aber trotzdem probiert werden,
falls die non-blocking-Polling-Latenz (5ms) für PST spürbar wird.

## 2026-07-17 (Nachtrag) — `frage an fabel.txt` ausgearbeitet: sieben
Punkte in `docs/END-GOAL-FEATURES.md` als neue/erweiterte Kapitel

Direkte Fortsetzung nach dem MXL-Livelock-Fix, auf Anweisung: die Datei
`/home/infantilo/frage an fabel.txt` (sieben vom Projektinhaber
notierte Fragen/Feature-Wünsche, Punkt 6 doppelt nummeriert) wurde
recherchiert (vier parallele Recherche-Fork-Agenten: Property-Panel-UI,
Audio-Mixer-Ist-Zustand, Katalog-UI + Multi-Res-Streams, MXL-Fabrics/
RDMA) und in `docs/END-GOAL-FEATURES.md` ausgearbeitet, jeweils im
bestehenden Kapitel-Format (Ist-Zustand/Referenz/Ziel-Design/
Phasenplan/Offene Fragen) oder als Nachtrag zu bereits bestehenden,
thematisch passenden Kapiteln, statt Dopplungen zu erzeugen:

- **§1.6** (neu) — Property-Panel-Breite (280px hardcoded) ist der
  Grund für den gemeldeten „Buttons vertikal statt horizontal"-Bug im
  Bildmischer, **nicht** ein separater/unfertiger UI-Pfad (per
  Code-Lesen bestätigt: Property-Panel und Operator-Konsole laden
  dasselbe UI-Bundle über `mountUIBundle()`). Plus „Als Operator
  ansehen"-Button-Design (Route existiert bereits:
  `/console/<workflowId>/<nodeRoleId>`).
- **§4.6** (neu, Nachtrag zu Kapitel 4) — vier konkrete Lücken über den
  bestehenden Audio-Mixer-Plan hinaus: EQ-Upgrade auf
  `equalizer-nbands` (parametrisch: Gain/Güte/Frequenz),
  `audiodynamic`-Realitätscheck (kein Attack/Release/Makeup-Gain),
  Audio-Follow-Video-Pegel statt nur Mute, Mixer-Presets (Empfehlung:
  bestehenden Snapshot-Mechanismus node-skopiert wiederverwenden).
- **§7.6** (neu, Nachtrag zu Kapitel 7) — „ein redundantes Service
  definieren" ist bereits vollständig beantwortet (K7-Teil-1,
  entschieden 2026-07-14, **noch nicht begonnen**); neuer Aspekt: die
  Operator-Konsolen-Route muss über einen Prozess-Restart/Failover
  hinweg stabil auf die aktuelle Instanz auflösen, sonst schaut der
  Operator nach einem Failover auf ein totes UI — Kapitel 7 hatte
  bisher nur die Medien- (IS-05), nicht die UI-Wiederverkabelung im
  Blick.
- **Kapitel 14, Einleitung** (Nachtrag) — ehrliche Antwort auf „ist das
  System ressourcen-/stabilitäts-optimal": Placement-Engine (D6-3) ist
  fertig aber nur advisory, Kapitel 14 selbst (Ressourcen-Historie/
  Vorprüfung) ist die noch fehlende zweite Hälfte — kein neuer
  Recherchebedarf, nur Umsetzung bereits entworfener Teile.
- **Kapitel 15** (neu) — Multi-Resolution-Streams: heutige
  "Lowres-Vorschau" ist Transcode-on-Demand von der Highres-Pipeline
  (`omp-mediaio::preview`), **kein** eigener Lowres-MXL-Flow;
  Bildmischer/Multiviewer öffnen für jede Kachel volle Highres-Reader
  — kein Bandbreiten-/CPU-Vorteil auf der Empfangsseite. Ziel-Design:
  zweiter, echter MXL-Sender in niedriger Auflösung je Quelle,
  Kachel-/Vorschau-Reader bevorzugen ihn, PGM bleibt highres; neues
  `Settings`-Feld am Workflow-Objekt für die Auflösungs-Konfiguration.
- **Kapitel 16** (neu) — wichtigster Einzelfund der Sitzung: MXL bringt
  bereits eine vollständige, vendorte, aber ungenutzte
  libfabric-Bibliothek (`third_party/mxl/lib/fabrics/ofi/`,
  `tools/mxl-fabrics-demo`) für echten One-Sided-RDMA-Remote-Memory-
  Zugriff zwischen Hosts mit — inkl. eines reinen Software-
  TCP-Providers (`MXL_SHARING_PROVIDER_TCP`), der **ohne RDMA-Hardware
  testbar ist** (`mxl-fabrics-demo --provider tcp`, direkte Antwort auf
  die im Nutzertext selbst gestellte Testbarkeits-Frage). Aktuell nicht
  gebaut (`MXL_ENABLE_FABRICS_OFI=OFF`). Steht in Konkurrenz zu
  `ARCHITECTURE.md` §6.6s bereits geplantem, eigenständigem
  `rdma-core`-Modul — Empfehlung (dort + in Kapitel 16 als offene Frage
  16.5.1 markiert): MXL-native Fabrics statt eigenem RDMA-Modul,
  Entscheidung liegt beim Projektinhaber. `ARCHITECTURE.md` §6.6 hat
  einen entsprechenden Cross-Referenz-Nachtrag bekommen.
- **Kapitel 17** (neu) — Katalog-UI: Beschreibungen/vermutete
  Ressourcen (klein), Laufende-Instanzen-Tab + Alarm-View (baut auf
  Kapitel 14 bzw. bereits existierenden NATS-Events), Import/
  Versionierung/Löschen fremder Microservices als eigene, deutlich
  größere Ausbaustufe (braucht einen Podman-Runner jenseits des
  heutigen reinen Prozess-Runners + eine Katalog-Schreib-API +
  Vertrauensmodell) bewusst zurückgestellt.
- **Kapitel 18** (neu) — konsolidierte Priorisierung aller sieben
  Punkte mit Begründung (Kurzfassung: §1.6 zuerst — kleinster Aufwand,
  vollständig geklärt, direkter UI-Qualitäts-Treffer; K7-Teil-1
  danach — bereits entschieden, nur nicht begonnen; dann Katalog-UI/
  Audio-Mixer; Multi-Res und Fabrics als größere, cross-cutting/
  entscheidungsabhängige Punkte danach; Microservice-Import zuletzt).

**Nicht in AMPP/Grassvalley-Terminologie geschrieben** (Vorgabe aus dem
Nutzertext befolgt — beide Namen kommen in keinem der neuen Abschnitte
vor, per Grep bestätigt).

**Nächster Schritt, direkt im Anschluss:** §1.6 umsetzen (Property-
Panel-Breite + Operator-Ansicht-Button) — kleinster, unabhängig
verifizierbarer Schritt aus Kapitel 18s Priorisierung, passend zur
Vorgabe „achte auf ein schönes UI bei der Umsetzung".

## 2026-07-17 (Nachtrag 2) — §1.6 umgesetzt: Property-Panel resizable,
„Als Operator ansehen"-Button

Direkte Fortsetzung, `ui/graph/flow-canvas.ts`:

- Fest verdrahtete Panel-Breite (280px) durch **resizable** Panel
  ersetzt: neuer Drag-Handle am linken Rand (`#onPanelResizeStart`/
  `#onPanelResizeMove`/`#onPanelResizeEnd`, `PointerEvent` +
  `setPointerCapture`), Default jetzt 420px (Grenzen 240–900px),
  Breite in `localStorage` (`omp.parameterPanelWidth`) persistiert und
  beim nächsten Öffnen wiederhergestellt.
- Damit `replaceChildren()`-Aufrufe beim Neu-Rendern des Panel-Inhalts
  den Resize-Handle nicht mit wegwischen: neues, stabiles
  `#panelContent`-Element als einziges Ziel dieser Aufrufe, `panel`
  selbst (mit Handle) bleibt über die gesamte Panel-Lebensdauer intakt.
- Neuer „Als Operator ansehen ↗"-Link neben dem Schließen-Button
  (`#panelButtonBar`), verlinkt `/console/default/<nodeRoleId>`
  (`nodeRoleId` = `node.instanceId || nodeId`, spiegelt
  `orchestrator/internal/consoles/resolve.go`s `NodeRoleID`-Logik auf
  der Frontend-Seite).

**Verifiziert:** `deno check`/`deno test ui/` (40/40) grün. Live per
CDP (Node-`WebSocket`-Client gegen `chromium --headless=new
--remote-debugging-port`, da die Claude-in-Chrome-Erweiterung in dieser
Sitzung nicht verfügbar war): `omp-video-mixer-me`-Instanz gestartet,
Node-Kachel angeklickt — Panel öffnet jetzt bei 420px mit dem
Bildmischer-Bundle in **horizontaler** PGM/PST/CUT/AUTO/MIX-WIPE-
Anordnung (vorher bei 280px umgebrochen), „Als Operator ansehen"-Link
sichtbar mit korrektem Href. Resize-Handle-Logik separat per
direkt dispatchten `PointerEvent`s verifiziert (420→570px, inkl.
`localStorage`-Persistenz und Wiederherstellung nach Reload) — der
erste Versuch über CDPs `Input.dispatchMouseEvent` zeigte dabei eine
bekannte Eigenheit synthetischer Headless-Maus-Eingaben (kein
durchgängiges `setPointerCapture` über simulierte Events hinweg), kein
Bug im UI-Code.

**Nebenbefund, klein, gleich mitbehoben:** `/dev/shm/omp-mxl`
(MXL-Domain-Verzeichnis) existierte zu Sitzungsbeginn nicht (tmpfs,
überlebt einen Neustart/eine Bereinigung nicht) — jeder MXL-Node-Start
schlug mit „Domain path is not a directory" fehl, bis das Verzeichnis
manuell angelegt wurde. `deploy/dev/start-omp.sh` legt es jetzt selbst
an (`mkdir -p "${OMP_MXL_DOMAIN:-/dev/shm/omp-mxl}"`), statt sich auf
einen vorherigen Lauf zu verlassen.

## 2026-07-17 (Nachtrag 3) — K7-Teil-1 umgesetzt: Prozess-Auto-Restart,
Crash-Loop-Bremse, automatische IS-05-Wiederverkabelung, Restart-Zähler
im UI

Direkte Fortsetzung, wie in Kapitel 18 der `frage an fabel.txt`-
Priorisierung vorgesehen (zweiter Schritt nach §1.6): das seit
2026-07-14 vollständig entworfene, aber nie begonnene K7-Teil-1
(`docs/END-GOAL-FEATURES.md` §7.3a/§7.4) umgesetzt.

**`orchestrator/internal/launcher`:**
- `startLocal`s bisherige "einmal starten, bei Absturz nur markieren"-
  Goroutine ersetzt durch `supervise()`: startet einen abgestürzten
  lokalen Prozess automatisch in **derselben Instanz-ID** neu (nicht
  als neue Instanz), solange die Crash-Loop-Bremse das erlaubt.
  `execEntry()` kapselt den Subprozess-Start als wiederverwendbaren
  Kern für Erst- und Neustart.
- Crash-Loop-Bremse als Paket-Variablen (`maxCrashRestarts=5`,
  `crashRestartWindow=60s`, `crashRestartBackoff=2s`, fester Delay
  nach PIPELINE-CONTROLLER-Vorbild `supervisor.js:183–192`) — Werte
  aus der Entscheidungssitzung 2026-07-14 (Kapitel 10, Punkt 8).
  Bewusst **kein** `restartPolicy`-Feld pro Katalog-Eintrag/Rolle in
  diesem Schritt (Ziel-Design nennt es als spätere Ausbaustufe) — eine
  einheitliche Policy deckt die verlangte Verifikation ab, pro-Typ-
  Konfigurierbarkeit ist dokumentierte Folgearbeit.
- Neues `Instance.RestartCount`-Feld, neuer `instance.restarted`-SSE-
  Event-Typ (`publishRestarted`, analog `publishCrash`).
- Neues `RestartObserver`-Interface + `SetRestartObserver()` — vom
  Launcher nach jedem erfolgreichen automatischen Neustart aufgerufen,
  implementiert von `*workflows.Service`.

**`orchestrator/internal/workflows`:**
- `Service.InstanceRestarted()` (erfüllt `launcher.RestartObserver`)
  generalisiert den bisher nur an `Start()` gebundenen `node.added`-
  Glue: sucht die laufende Workflow-Rolle mit passender Instanz-ID,
  wartet auf ihre Neu-Registrierung und wendet alle sie betreffenden
  Connections neu an.
- **Echter, live gefundener Bug unterwegs, nicht nur vermutet:** die
  naheliegende erste Fassung nutzte `awaitRegistration` (dieselbe
  Funktion wie beim Workflow-Start) — funktioniert dort, weil vor
  einem Start garantiert keine Registrierung existiert, aber beim
  Neustart-Fall kann die **alte** NMOS-Registrierung des per SIGKILL
  beendeten Prozesses (keine Chance zur Selbstabmeldung) noch bis zu
  ihrem Heartbeat-Timeout neben der neuen weiterleben.
  `findByInstanceID` liefert dabei immer den *ersten* Treffer in der
  Liste zurück — bei einem `kill -9`-Live-Test blieb die Connection
  dadurch auf den (kurz danach als "offline" markierten, dann ganz
  verschwindenden) Sender der alten Registrierung stehen, obwohl der
  neue Prozess längst lief. Gefixt mit einer dedizierten
  `awaitFreshRegistration(ctx, instanceID, excludeNodeID)`, die gezielt
  über *alle* Knoten mit passender Instanz-ID iteriert (nicht nur den
  ersten Treffer) und die zuvor bekannte Node-ID ausschließt. Ohne den
  Live-Test (reine Unit-Tests mit Fakes hätten das mit einer zu
  freundlichen Fake-Registry-Reihenfolge leicht übersehen können) wäre
  dieser Bug vermutlich erst in einem echten Mehrfach-Restart-Szenario
  aufgefallen.

**UI (`ui/graph/flow-canvas.ts`):** `instance.restarted`-Event zeigt
einen (unaufdringlicheren als "instance.crashed") Toast; Katalog-
Paletten-Zeile zeigt bei `restartCount > 0` einen Restart-Zähler
("↻ N× automatisch neu gestartet") — auch wenn die Instanz gerade
läuft, damit eine flatternde (wiederholt abstürzende) Instanz erkennbar
bleibt, nicht nur eine aktuell tote (§7.2-Prinzip, PIPELINE-CONTROLLER-
Vorbild `supervisor.js:412`).

**Verifiziert:**
- `go build ./...`/`go test ./...` (ganzer Orchestrator) grün,
  `go vet` sauber. Zwei neue Launcher-Tests
  (`TestLauncherAutoRestartsCrashedInstanceInPlace`,
  `TestLauncherCrashLoopBrakeStopsAutoRestarting`) und zwei neue
  Workflow-Tests (`TestInstanceRestartedRewiresAffectedRole` — mit der
  oben beschriebenen absichtlich harten Race-Bedingung als
  Regressionswächter, `TestInstanceRestartedIgnoresInstanceOutsideAnyWorkflow`).
  Drei bestehende Launcher-Tests, die einen Prozess bewusst enden
  lassen und das alte "bleibt einfach crashed"-Verhalten prüfen,
  bekamen `disableAutoRestart(t)` (maxCrashRestarts=0), damit sie ihre
  ursprüngliche Bedeutung behalten statt inkorrekt zu werden.
- **Live, echter Orchestrator, kein Mock:** Workflow mit zwei Rollen
  (omp-source → omp-viewer) gestartet, `kill -9` auf den Source-
  Prozess. Innerhalb der 2s-Backoff-Zeit neu gestartet (neue PID,
  gleiche Instanz-ID, `restartCount:1`), IS-05-Verbindung automatisch
  auf den neuen Sender umgehängt (per `/api/v1/graph` bestätigt: alte
  Node-Registrierung als "offline" sichtbar, aktive Kante zeigt auf den
  neuen Sender), Restart-Zähler live per CDP/Headless-Chromium im
  Katalog-Panel sichtbar ("↻ 1× automatisch neu gestartet"). Genau die
  im Phasenplan verlangte Verifikation.

**Nicht Teil dieses Schritts (dokumentierte Folgearbeit, wie im
Ziel-Design vorgesehen):** Degradation-Leitlinie in
`docs/NODE-TUTORIAL.md` (Teil 2), ST-2022-7-Dual-Path (Teil 3),
Hot-Standby (Teil 4, wartet auf D6 Teil 3 — bereits fertig, könnte
also als nächstes angegangen werden), pro-Katalog-Eintrag/Rolle
konfigurierbare `restartPolicy`, Remote-Instanzen (HostID gesetzt) —
Crash-Erkennung dafür existiert laut §7.1 weiterhin nicht.

## 2026-07-17 (Nachtrag 4) — §17 Teil 1 umgesetzt: Katalog-
Beschreibungen + vermutete Ressourcen

Dritter Schritt der Kapitel-18-Priorisierung. `orchestrator/internal/
launcher.CatalogEntry` bekommt zwei neue, additive/optionale Felder:
`Description` (kurzer Fließtext) und `ExpectedResources` (bewusst
Freitext statt strukturiertem Schema — „~5% CPU · ~40 MB RAM"-Stil
wäre eine vorgezogene, geratene Zahl; Kapitel 14 liefert später echte
Messwerte, ein striktes Schema jetzt wäre Wegwerf-Aufwand). Beide
Felder in `deploy/catalog.json` für alle zehn Node-Typen befüllt,
Texte auf Basis der jeweiligen `main.rs`-Modulkommentare geschrieben
(nicht geraten). `ui/graph/flow-canvas.ts`s Katalog-Palette zeigt
beides jetzt sichtbar unter jedem „+ Typ"-Button (vorher nur der reine
Label-Text), zusätzlich weiterhin im Tooltip.

**Abhängigkeits-Fund beim Schreiben:** §17 Teil 2 (Laufende-Instanzen-
Tab) sagt im Ziel-Design-Text selbst „baut direkt auf Kapitel-14-
Datenmodell" — Kapitel 14 (Host-/Microservice-Ressourcen-Historie)
existiert aber noch nicht (eigener Ist-Zustand dort: „noch nicht
gebaut"). Teil 2 ist also nicht wie ursprünglich in Kapitel 18
angenommen direkt im Anschluss an Teil 1 startbar, sondern braucht
zuerst einen Kapitel-14-Schritt. Kapitel 18 entsprechend präzisiert.
Teil 3 (Alarm-View, baut nur auf bereits existierenden Events) bleibt
unabhängig davon offen und direkt startbar.

**Verifiziert:** `go build`/`go test ./...` (Orchestrator) grün, `deno
check`/`deno test ui/` (40/40) grün. Live: `/api/v1/catalog` liefert
die neuen Felder korrekt, per Headless-Chromium/CDP-Screenshot
bestätigt, dass die Palette Beschreibung + Ressourcen-Hinweis für alle
zehn Einträge lesbar anzeigt.

## 2026-07-17 (Nachtrag 5) — §17 Teil 3 umgesetzt: genereller Alarm-View

Vierter Schritt der Kapitel-18-Priorisierung, direkt nach Teil 1 (Teil
2 übersprungen wegen der in Nachtrag 4 gefundenen Kapitel-14-
Abhängigkeit). Neuer App-Bar-Tab „Alarme" (`ui/shell/alarm-view.ts`,
`app-shell.ts`s `TABS`-Liste um `alarms`/`omp-alarm-view` erweitert) —
exakt wie im Ziel-Design (§17.3c) gefordert **kein neuer Alarm-
Erzeuger**, nur ein zentraler Konsument dreier bereits bestehenden
Endpunkte:

- `GET /api/v1/instances` — `crashed` (kritisch) und `restartCount > 0`
  ohne `crashed` (Warnung, „flatternde" Instanz, K7-Teil-1).
- `GET /api/v1/placement/advice` — Host-Ressourcen-Ampel (Warnung, D6
  Teil 3).
- `GET /api/v1/workflows` — `status === "failed"` (kritisch).

Gleiches Poll-Muster (4s, `apiFetch`) wie `hosts-view.ts`, bewusst
keine SSE-Sonderbehandlung (Verzögerung für eine Alarm-Übersicht
unkritisch, Konsistenz mit dem bereits etablierten Muster wichtiger
als Echtzeit-Anspruch für diesen speziellen Tab).

**Abwägung, dokumentiert statt stillschweigend entschieden:** der
Ziel-Design-Text sagt „an einer Stelle **statt verteilt**" — wörtlich
genommen würde das verlangen, `hosts-view.ts`s bestehendes Placement-
Advice-Banner zu entfernen. Bewusst **nicht getan**: das Banner ist
kontextuell weiterhin nützlich, wenn man sich ohnehin die Host-Ansicht
anschaut, und Entfernen ist ein unnötiges Risiko für bereits
funktionierende, getestete UI. Der neue Tab ist als zusätzlicher,
zentraler Gesamtüberblick zu verstehen, nicht als Ablösung der
kontextuellen Einzelanzeige — leichte Redundanz akzeptiert.

**Verifiziert:** `go build`/`go test ./...` grün, `deno check`/`deno
test ui/` (40/40) grün. Live: leerer Zustand („✓ Keine aktiven
Alarme.") per CDP-Screenshot bestätigt; anschließend zwei echte Alarme
erzeugt — ein einmaliger `kill -9` auf eine laufende Instanz (Warnung,
„1× automatisch neu gestartet") und ein **echter Crash-Loop**
(`/dev/shm/omp-mxl` kurzzeitig entfernt, `omp-source` gestartet: 5
automatische Neustarts in ~4s, dann Eskalation — bestätigt zugleich
erneut die K7-Teil-1-Crash-Loop-Bremse) — beide erscheinen korrekt
sortiert (kritisch vor Warnung) mit passender Farbe im Alarm-Tab.

## 2026-07-17 (Nachtrag 6) — §4.6 umgesetzt: Audio-Mixer EQ-
Parametrisierung + Kompressor + Master-Limiter

Fünfter Schritt der Kapitel-18-Priorisierung. `nodes/omp-audio-mixer`:

**EQ-Parametrisierung.** `equalizer-3bands` → `equalizer-nbands`
(`num-bands=3`). Per Live-Introspektion verifiziert, nicht geraten
(`UMSETZUNG.md` §0 Punkt 6, Python/PyGObject-Probe gegen das echte
Element): bei `num-bands=3` weisen sich die drei `GstIirEqualizerBand`-
Kindobjekte automatisch Low-Shelf/Peak/High-Shelf zu (Index 0/1/2) —
passt exakt auf die bestehende Low/Mid/High-Benennung, jetzt mit
einstellbarer `freq`/`bandwidth` zusätzlich zum bisherigen `gain`.
Zugriff über `GstChildProxy` (`gst::ChildProxy`, `dynamic_cast_ref`
nötig — `gst::Element` erfüllt die Trait-Bounds nicht statisch, da
`ChildProxy` ein dynamisches GObject-Interface ist). Defaults: Low
100 Hz/200 Hz, Mid 1000 Hz/1000 Hz, High 8000 Hz/4000 Hz.

**Kompressor (Kanal) + Limiter (Master).** `audiodynamic` pro Kanal
(zwischen EQ und dem bisherigen Metering-`level`) sowie einmal auf dem
Master-Bus (zwischen `audiomixer` und dem bisherigen `level-master`).
Realitätscheck aus dem §4.6-Nachtrag vom 2026-07-17 (Vortag) bestätigt:
`audiodynamic` hat **kein** Attack/Release, **keine** Makeup-Gain-
Eigenschaft, `threshold` ist **linear** 0..1 (nicht dB, per
`gst-inspect-1.0 audiodynamic` verifiziert) — Threshold-dB→linear-
Umrechnung ergänzt, plus ein eigenes `volume`-Element direkt danach
für Makeup-Gain. `enabled=false` erzwingt `ratio=1.0` (No-Op,
unabhängig vom Threshold) statt eines Pipeline-Umbaus — Kompressor/
Limiter bleiben dauerhaft in der Kette, kein dynamisches Ein-/
Ausklinken nötig.

**Deskriptor:** pro Kanal sechs neue `eq{Low,Mid,High}{Freq,Width}`-
Parameter + `channel.<id>.setEqBand(band,freq,width)` (Gain bleibt im
unveränderten `setEq(low,mid,high)`), vier neue `comp*`-Parameter +
`channel.<id>.setComp(enabled,thresholdDb,ratio,makeupDb)`. Master:
vier neue `masterLimiter*`-Parameter + `setMasterLimiter(...)` auf
Node-Ebene (kein `channel.<id>.`-Namensraum, da einmalig).

**UI-Bundle** (`nodes/omp-audio-mixer/ui/bundle.js`, Hand-JS ohne
Build-Schritt, `include_str!` in `uibundle.rs`): neue aufklappbare
`<details>`-Abschnitte "EQ Freq/Q" und "Comp" pro Kanalzug (gleiches
Muster wie das bestehende AFV-`<details>`), "Limiter" beim Master —
bewusst aufklappbar statt dauerhaft sichtbar, damit der Normalfall
"kurz am Gain drehen" nicht mit zusätzlichen Reglern überladen wird.

**Verifiziert:**
- `cargo build --workspace`/`cargo test -p omp-audio-mixer` grün,
  `cargo deny check` ohne neue Befunde.
- Live gegen eine echte, über den Orchestrator gestartete Instanz:
  `channel.ch1.setEqBand`/`setComp`/`setMasterLimiter` per curl
  gesetzt, alle Werte per `GET .../params/<name>` korrekt
  zurückgelesen, Instanz blieb dabei durchgehend am Leben (kein
  Crash/Restart) — bestätigt, dass die `ChildProxy`-Zugriffe und die
  neuen `audiodynamic`/`volume`-Elemente in einer bereits laufenden
  PLAYING-Pipeline sauber funktionieren.
- **Echte DSP-Wirkung bestätigt, nicht nur Wire-Format:** `/levels`-
  SSE-Stream (roher `curl`) zeigte messbar veränderte RMS/Peak-Werte
  nach Aktivieren von Kompressor (Threshold -18 dB, Ratio 4, Makeup
  +6 dB) und Master-Limiter (Threshold -6 dB, Ratio 10, Makeup +2 dB)
  — der Signalpfad reagiert hörbar/messbar, nicht nur die gespeicherten
  Parameterwerte.
- `tools/contract-check` (C9) gegen die laufende Instanz: PASS
  (IS-04-Registrierung, Descriptor-Schema, UI-Manifest).
- Live per CDP-Screenshot: alle drei neuen `<details>`-Abschnitte
  aufgeklappt, zeigen exakt die per API gesetzten Werte (Mid-Band
  2500 Hz/800 Hz, Comp -18/4/+6, Limiter -6/10/+2), Meter zeigen
  Aktivität.

**Offen aus §4.6, bewusst nicht Teil dieses Schritts:**
Audio-Follow-Video-Pegel (weiterhin nur Mute/Unmute, kein
konfigurierbarer Off-Pegel) und Mixer-Presets (Wiederverwendung des
Snapshot-Mechanismus, node-skopiert) — beide im Nachtrag vom Vortag
bereits als eigenständig umsetzbar identifiziert, für eine künftige
Sitzung.

## 2026-07-17 (Nachtrag 7) — Kapitel 15 Teil 1 begonnen: Workflow-
Auflösungs-Setting (Orchestrator/UI vollständig, `omp-source` als
erster Node)

Sechster Schritt der Kapitel-18-Priorisierung. Bei der Umsetzung
gefunden: Teil 1 ist **größer als im Phasenplan als „kleinster Schritt"
eingeschätzt** — `WIDTH`/`HEIGHT` sind in `omp-source`/`omp-switcher`/
`omp-player`/`omp-video-mixer-me` je ein `pub const`, das direkt in
GStreamer-Caps-Konstruktion und MXL-Flow-Registrierung einfließt (bei
`omp-video-mixer-me` zusätzlich in `KEYER_WIDTH`/`KEYER_HEIGHT`-
Folgekonstanten und zur Laufzeit gesetzten Pad-Properties, nicht nur
beim Pipeline-Aufbau) — kein reiner Konfigurationswert, den man an
einer Stelle ändert, sondern ein kleines Refactoring pro Node
(Konstante → `Config`-Feld → alle Verwendungsstellen). Deshalb bewusst
die Orchestrator-/UI-Infrastruktur **vollständig** umgesetzt, aber nur
an **einem** Node (`omp-source`, vom Nutzer selbst in
`frage an fabel.txt` als „Testquelle" genannt) bis zum Ende
durchgezogen und live verifiziert — die übrigen drei Nodes sind
dieselbe, jetzt etablierte Mechanik als direkte Folgearbeit, kein
stiller Gap (gleiches Muster wie die Kapitel-14-Abhängigkeit bei §17
Teil 2: Umfang beim Schreiben ehrlich neu bewertet statt stur am
ursprünglichen Phasenplan festgehalten).

**`orchestrator/internal/workflows`:** `Settings{ProgramWidth,
ProgramHeight uint32}` (0 = Node-eigener Default) als Feld von
`Definition` (nicht `Workflow` selbst — Settings sind Teil des vom
Nutzer festgelegten, unveränderlichen Anteils, wie Roles/Connections).

**`orchestrator/internal/launcher`:** `Start(nodeType, hostID string,
extraEnv map[string]string)` — `extraEnv` überschreibt den
Katalog-eigenen `env`-Block, gewinnt aber nie gegen die fünf
Launcher-eigenen OMP_*-Variablen (Instanz-ID/Label/Port/Registry-/
NATS-URL). **Nur lokal wirksam:** der Remote-Pfad (§18.5) schickt laut
seiner eigenen Sicherheitsgrenze nur einen Typnamen an den Host-Agent,
keine freien Parameter — `extraEnv` wird dort dokumentiert ignoriert,
gleiche Einschränkungsklasse wie die fehlende Remote-Crash-Erkennung
aus D6 Teil 2/K7-Teil-1. `supervise()`s automatischer Neustart nach
einem Absturz (K7-Teil-1) reicht dasselbe `extraEnv` weiter, damit ein
neu gestarteter Prozess dieselbe Workflow-Auflösung behält statt auf
die Katalog-Defaults zurückzufallen.

**`orchestrator/internal/workflows::runStart`:** baut `extraEnv` aus
`wf.Definition.Settings` (`OMP_WIDTH`/`OMP_HEIGHT`, nur gesetzt wenn
>0) und reicht es an jeden Rollen-`Start()`-Aufruf weiter.

**UI (`ui/shell/workflows-view.ts`):** neues „Auflösung (optional)"-
Feldpaar im Anlegen-Formular, `settings` im POST-Body nur gesetzt, wenn
mindestens ein Wert eingetragen wurde; laufende Workflows mit
gesetzter Auflösung zeigen sie in der Liste (`960×540`), Workflows
ohne Settings zeigen nichts zusätzlich an.

**`nodes/omp-source`:** `WIDTH`/`HEIGHT` → `DEFAULT_WIDTH`/
`DEFAULT_HEIGHT` (Fallback) + neue `Config::width`/`height`-Felder,
`main.rs` liest `OMP_WIDTH`/`OMP_HEIGHT` (ungültig/fehlend → Default,
kein Fehler), reicht sie an `pipeline::Config` und die
`FlowSpec::Video`-Deskriptor-Angabe weiter statt der alten Konstanten.

**Verifiziert:**
- `go build`/`go test ./...` (ganzer Orchestrator) grün, `go vet`
  sauber, zwei neue Tests
  (`TestLauncherStartExtraEnvOverridesCatalogButNotReservedVars`,
  `TestStartPassesResolutionSettingsAsExtraEnv` — Letzterer prüft
  explizit auch den Negativfall: ein Workflow ohne Settings erzeugt
  kein `OMP_WIDTH`/`OMP_HEIGHT`).
- `cargo build --workspace`/`cargo test -p omp-source` grün, `deno
  check`/`deno test ui/` (40/40) grün.
- **Live, echter Orchestrator + echter Node, bis zur IS-04-Registry
  durchverifiziert:** Workflow mit `settings:{programWidth:960,
  programHeight:540}` angelegt und gestartet — Subprozess-Environment
  bestätigt `OMP_WIDTH=960`/`OMP_HEIGHT=540`
  (`/proc/<pid>/environ`), und (entscheidender als der reine
  Env-Var-Nachweis) die tatsächlich in der NMOS-Registry sichtbare
  Video-Flow-Registrierung zeigt `frame_width=960, frame_height=540`
  statt der alten festen 640×480 — die Pipeline hat den Wert also
  wirklich für Caps/MXL-Flow verwendet, nicht nur entgegengenommen.
  Gegenprobe: ein zweiter Workflow ganz ohne `settings` registrierte
  seinen Flow weiterhin mit den unveränderten 640×480 (keine
  Regression für den Default-Fall). UI-Formular + Auflösungs-Anzeige
  in der Workflow-Liste per CDP-Screenshot bestätigt.

**Offen, direkte Folgearbeit (kein stiller Gap):** denselben Umbau
(Konstante → `Config`-Feld → `OMP_WIDTH`/`OMP_HEIGHT` lesen) auf
`omp-switcher`, `omp-player`, `omp-video-mixer-me` anwenden. Kapitel-
15-Teile 2–4 (echter Lowres-MXL-Sender, Bildmischer/Multiviewer lesen
bevorzugt Lowres) bleiben unverändert offen, wie im Kapitel selbst
geplant.

## 2026-07-17 (Nachtrag 8) — Kapitel 11 Teil 1 umgesetzt: Admin-Tab,
Nutzer-/Rollenbindungs-Verwaltung, Audit-Log-Ansicht — Login damit
erstmals über die UI erreichbar

Ausgelöst durch direkte Nutzerfrage (nicht Teil der `frage an
fabel.txt`-Priorisierung): „es gibt immer noch kein allgemeines
Settings-Menü, Benutzerverwaltungs-Menü, Login…". Recherche bestätigte
den Befund vollständig — das D3-Teil-2-Backend (Nutzer, Rollen-
bindungen, Audit-Log, Bootstrap-Bypass) existierte bereits komplett,
aber ohne jede UI: `ui/shell/auth.ts` konnte nur einloggen, nie den
allerersten Nutzer anlegen. Da `authRequired` im Bootstrap-Fall
(`UserCount()==0`) bewusst `false` liefert (ARCHITECTURE.md §12: „Auth
deaktivierbar solange kein Nutzer angelegt ist"), gab es ohne diesen
Schritt keinen UI-Weg, der je einen ersten Nutzer erzeugt hätte — Login
war architektonisch vorhanden, aber praktisch unerreichbar. Nutzer
wählte auf Nachfrage explizit „Kapitel 11 zuerst" (statt Settings-Menü
oder Doku-only), weil das den Login-Zugang automatisch mit freischaltet.

**Backend (`orchestrator/internal/auth`):** `Store.List`/`Delete`/
`SetPasswordHash` + `ErrUserNotFound`, `Service.ListUsers`/`DeleteUser`/
`SetPassword` — reine Ergänzungen neben dem bestehenden `Create`/
`ByUsername`, keine Änderung an vorhandenem Verhalten.

**Backend (`internal/httpapi`):** drei neue admin-only+auditierte
Routen — `GET /api/v1/auth/users`, `DELETE /api/v1/auth/users/{name}`,
`PUT /api/v1/auth/users/{name}/password`. `handleWhoami` bekommt ein
zusätzliches `isAdmin`-Feld (true bei admin-Verb ODER Bootstrap-Modus)
— das Signal, mit dem die Shell entscheidet, ob der Administration-Tab
gerendert wird (§22.1-Regel „Navigationspunkte ohne passende Rolle
werden nicht gerendert", hier zusätzlich um den Bootstrap-Sonderfall
erweitert, sonst könnte niemand je den ersten Nutzer anlegen).
**Selbstschutz** (§11.3b: „der letzte verbleibende admin kann sich
nicht selbst löschen/entrechten") in `handleDeleteUser` UND
`handleDeleteRoleBinding` über eine gemeinsame `globalAdminSubjects`-
Hilfsfunktion — beide lesen `authzStore.Load()`, zählen Subjects mit
einer `*`-admin-Bindung, und lehnen nur dann ab, wenn das betroffene
Subject sich selbst betrifft (`principalFromContext`) UND das einzige
verbleibende ist. Fremde Admins dürfen sich gegenseitig weiterhin
löschen/entrechten — die Sperre schützt nur vor versehentlichem
Selbst-Aussperren, kein generelles „Admins sind unlöschbar".

**UI (`ui/shell/admin-view.ts`, neu):** drei Abschnitte — Nutzer
(Liste, Anlegen, Passwort-Reset inline pro Zeile, Löschen), Rollen-
bindungen (Liste, Anlegen mit Node-Datalist aus `GET /api/v1/nodes`,
Löschen), Audit-Log (reine Anzeige, pollt alle 5s). Bewusst **kein**
Poll-Timer für Nutzer/Bindungen (anders als `hosts-view.ts`/
`workflows-view.ts`): ein offenes Formular hätte bei jedem Poll-
Rerender Fokus/Cursor verloren — stattdessen einmaliges Laden + gezielt
nach jeder Mutation neu geladen, nur das rein lesende Audit-Log pollt.
`ui/shell/app-shell.ts`: `BASE_TABS` (vier bestehende Tabs) + separater
`ADMIN_TAB`, der erst nach einem asynchronen `whoami()`-Aufruf bei
`isAdmin===true` angehängt wird — Tab-Button-Erzeugung dafür in
`#buildTabButton()` ausgelagert, `#switchTab` liest jetzt aus einer
Instanzvariable `#tabs` statt der alten Modul-Konstante.

**Ein reale Lücke beim Entwerfen gefunden, nicht erst im Live-Test:**
ohne besondere Behandlung hätte das Anlegen des allerersten Nutzers
über das Admin-Tab-Formular die eigene, noch token-lose Bootstrap-
Sitzung ausgesperrt — `UserCount()` springt in diesem Moment von 0 auf
1, der Bootstrap-Bypass greift ab der nächsten Anfrage nicht mehr, aber
der Browser hatte nie ein Token bekommen (er lief die ganze Zeit ohne
Anmeldung). `admin-view.ts#createUser()` prüft deshalb nach
erfolgreichem Anlegen, ob `getToken()` leer ist (⇒ wir liefen im
Bootstrap-Bypass) und loggt sich in diesem Fall automatisch mit den
gerade eingegebenen Zugangsdaten ein, bevor die Seite neu lädt — der
neu angelegte erste Nutzer hat durch `handleCreateUser`s bestehende
Bootstrap-Logik ohnehin schon automatisch die Wildcard-admin-Bindung
bekommen.

**Verifiziert:**
- `go build`/`go vet`/`go test ./...` (ganzer Orchestrator) grün,
  9 neue Tests in `internal/httpapi/auth_handlers_test.go`
  (Nutzerliste mit `isAdmin`-Markierung, Selbstschutz beim Löschen —
  sowohl blockiert als letzter Admin als auch erlaubt mit einem
  zweiten Admin oder beim Löschen eines fremden Nutzers, Selbstschutz
  bei Rollenbindungen, Passwort-Reset, `whoami`s `isAdmin` in allen
  drei Fällen Bootstrap/authentifiziert-mit-Bindung/authentifiziert-
  ohne-Bindung).
- `deno check`/`deno test ui/` (40/40) grün, `deno bundle` bestätigt
  `omp-admin-view` im Bundle (kein Wiederholen des Nachtrag-Bugs aus
  D3 Teil 2, s. `feedback_deno_bundle_type_only_import_elision`).
- **Live, echter Orchestrator + echter Postgres, per CDP-Klicks (nicht
  nur `curl`):** frischer Bootstrap-Zustand bestätigt
  (`whoami` → `authRequired:false, isAdmin:true`), Administration-Tab
  im DOM sichtbar. Ersten Nutzer „admin" über das UI-Formular angelegt
  → automatischer Login bestätigt (`whoami` danach:
  `authenticated:true, isAdmin:true, username:"admin"`). Als admin
  einen zweiten Nutzer „operator1" angelegt, eine `operate`-Bindung auf
  eine echte laufende `omp-audio-mixer`-Instanz für ihn erzeugt (Node-
  ID über die Datalist aus der echten `/api/v1/nodes`-Antwort gewählt).
  Audit-Log per direktem API-Check bestätigt: `POST
  /api/v1/admin/role-bindings` von `admin`, Status 201. Login als
  „operator1" landet direkt in der Console-Ansicht exakt dieser Mixer-
  Instanz, ganz ohne App-Bar/Administration-Tab (C13-Pfad bestätigt,
  Screenshot). `PATCH` auf eine zweite, nicht gebundene Instanz liefert
  403; derselbe Aufruf gegen die eigene gebundene Instanz kommt bis zum
  Node-Proxy durch (404 auf einen falsch geratenen Parameternamen,
  nicht 401/403 — die Autorisierung selbst greift also korrekt).
  Selbstschutz zusätzlich direkt gegen den echten Server verifiziert:
  `DELETE /api/v1/auth/users/admin` als einziger Admin → 409 „cannot
  delete the last remaining admin"; danach den Testnutzer „operator1"
  regulär gelöscht (204). Test-Instanzen nach Abschluss gestoppt, `admin`
  bleibt als echter Erstnutzer für künftige Sitzungen bestehen.

**Offen, direkte Folgearbeit (kein stiller Gap):** Kapitel 11 Teil 2
(Export/Import), Teil 3 (Settings-Registry, wartet auf Antwort zu
offener Frage 2 „was ist mit Latenz gemeint"), Teil 4 (Workflow-Scope-
Spalte, Passwort-Selbstservice, AD/LDAP) bleiben wie geplant offen.


## 2026-07-17 (Nachtrag 9) — Grundsatzentscheidung Kapitel 16.5.1/16.5.3:
Inter-Host-Fabrics (RDMA/Remote Memory) entschieden

Zwei offene Fragen aus `docs/END-GOAL-FEATURES.md` §16.5, gestellt
direkt durch den Nutzer (kein Teil einer laufenden Implementierungs-
sitzung, reine Entscheidungsfrage):

1. **16.5.1 (Grundsatzentscheidung):** MXL-native Fabrics (vendorte
   libfabric-Bibliothek `third_party/mxl/lib/fabrics/ofi/`, echtes
   One-Sided-RDMA-Write, TCP-Software-Provider sofort ohne
   RDMA-Hardware testbar) statt eines eigenständigen, in
   `ARCHITECTURE.md` §6.6 skizzierten `rdma-core`/`libibverbs`-Moduls.
   **Entschieden: MXL-native Fabrics**, wie in §16.3 empfohlen —
   weniger eigener Code/Wartung (gleiche Begründung wie C4s „MXL statt
   eigenem Zero-Copy-Transport", 2026-07-09), sofort ohne
   Sonder-Hardware verifizierbar, gleicher Migrationspfad zu echter
   RoCEv2-Hardware bleibt über einen reinen Provider-Wechsel
   (`--provider tcp` → `verbs`/`efa`) erhalten, keine Architekturschwenk
   nötig.
2. **16.5.3 (Hardware-Ausblick):** Nutzer bestätigt, dass echte
   RoCEv2-Hardware für den Regelbetrieb **fest eingeplant** ist — der
   TCP-Software-Provider ist damit ausdrücklich nur die Übergangslösung
   für Demo-/Testphasen ohne verfügbare NICs, nicht die dauerhafte
   Zielarchitektur. Das schärft §16.4 Teil 4 (`verbs`/`efa`-Provider)
   von „später, falls Hardware verfügbar" zu einem festen, nicht
   optionalen Phasenplan-Punkt.

**Folgearbeit (dokumentiert, noch nicht umgesetzt):**
`ARCHITECTURE.md` §6.6 auf diese Entscheidung umgeschrieben (eigenes
`rdma-core`-Modul durch `omp-mediaio::fabrics` auf libfabric-Basis
ersetzt, TCP-Provider jetzt / Hardware-Beschaffung für Regelbetrieb
bereits fest vorgesehen), `docs/END-GOAL-FEATURES.md` §16.5 als
beantwortet markiert. Die eigentliche Implementierung (Kapitel 16.4
Teil 0: Build aktivieren + Spike) ist damit **nicht** gestartet —
bleibt eigene Sitzung, gated auf Priorität laut Kapitel 18.


## 2026-07-17 (Nachtrag 10) — S1: Graph-Edge-Cache
(docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md), erster Umsetzungsschritt
aus dem Review-Arbeitsvorrat

Erster tatsächlicher Implementierungsschritt aus dem zweiten aktiven
Arbeitsvorrat ([[project_review_2026_07_17_s_steps]]), gewählt nach der
dortigen Reihenfolge-Empfehlung „S1 → S2 → S3" — größte Einzelwirkung
auf Skalierung: `GET /api/v1/graph` machte bisher pro Aufruf einen
IS-05-`GetActive`-Roundtrip für jeden Receiver jeder Node (N×M),
`graph.go:222-245` vor dieser Änderung.

**Umsetzung (`orchestrator/internal/graph/graph.go`):**
`graph.Service` hält jetzt einen Edge-Cache (`map[string]Edge`,
Schlüssel = Receiver-ID, mutexgeschützt). `Graph()` liest nur noch den
Cache (`snapshotEdges()`, sortiert nach ID für stabile UI-Reihenfolge)
— keine IS-05-Aufrufe mehr pro Request. Der Cache wird gehalten durch:
- **`Service.Run(ctx)`** (neu, analog `registry.Poller.Run`): initialer
  Full-Rebuild (`reconcileOnce`, derselbe teure N×M-Durchlauf wie
  früher, jetzt aber nur einmal beim Start), danach alle
  `ReconcileInterval` (60s) erneut — Netz gegen extern (an OMP vorbei)
  geschaltete Connections, mit Logging der erkannten Abweichungen
  (`logEdgeDivergence`).
- **`Connect`/`Disconnect`** mutieren den Cache direkt
  (`setEdge`/`deleteEdge`) statt wie bisher für die Loop-Erkennung
  (`Connect`) bzw. den vorherigen Sender (`Disconnect`) einen weiteren
  Live-IS-05-Call zu machen — beide lesen jetzt ebenfalls aus dem
  Cache, ein zusätzlicher Nebengewinn (weniger IS-05-Traffic insgesamt,
  nicht nur bei `GET /api/v1/graph`).
- **`Service.HandleNodeEvent(ctx, eventType, node)`** (neu, verdrahtet
  in `main.go` an `registry.Poller.OnChange`, vor dem bestehenden
  SSE-Broadcast): `node.removed` entfernt alle Kanten der
  verschwundenen Node ohne jeden IS-05-Call; `node.added` gleicht
  gezielt nur die Receiver der neuen Node ab (kein voller Rebuild).
  `node.updated` bleibt unbehandelt — ein Receiver-Satz-Wechsel auf
  einer bestehenden Node wird spätestens vom nächsten periodischen
  Reconcile erfasst, bewusste Vereinfachung, keine stille Lücke.

`main.go` musste umsortiert werden: `graphSvc` wird jetzt vor
`poller.OnChange` konstruiert (statt danach), damit die Closure
`graphSvc.HandleNodeEvent` aufrufen kann; `go graphSvc.Run(ctx)` läuft
jetzt wie `go poller.Run(ctx)` als eigene Goroutine.

**Tests:** sieben bestehende Tests in `graph_test.go` mussten auf das
neue Modell umgestellt werden (Cache muss vor der Prüfung per
`svc.reconcileOnce(ctx)` befüllt werden — vorher lasen `Graph`/`Connect`/
`Disconnect` live von `client.active`). Sechs neue Tests decken das
eigentliche S1-Verhalten ab: `TestGraphDoesNotCallIS05PerRequest`
(5× `Graph()` nach einem `reconcileOnce` erhöht `getActiveCalls`
nicht), `TestHandleNodeEventRemovedDeletesEdges`,
`TestHandleNodeEventAddedPopulatesEdgesWithoutFullReconcile` (belegt
gezielt genau 1 statt N×M `GetActive`-Aufrufe),
`TestReconcileOnceCatchesExternallyMadeConnection`,
`TestDisconnectReadsPreviousSenderFromCacheNotIS05`. `go build`/
`go vet`/`go test ./...` (ganzer Orchestrator) grün.

**Live verifiziert** (echter Orchestrator, Postgres, NATS, NMOS-Registry,
drei echte Node-Instanzen `omp-source`/`omp-switcher`/`omp-viewer` via
Launcher gestartet):
- `GET /api/v1/graph`-Latenz durchweg <15ms (0.9–14.7ms über mehrere
  Messungen vor und nach einer Connection) — cache-basiert, nicht mehr
  proportional zur Node-/Receiver-Zahl.
- `Connect` (Source-Video-Sender → Viewer-Receiver) erscheint sofort im
  Graph, `Disconnect` entfernt sie sofort wieder — beide ohne
  zusätzlichen Live-IS-05-Call für die Cache-Aktualisierung selbst.
- **Externe Connection, an Connect() vorbei:** direkter IS-05-PATCH am
  Viewer-Node selbst (`PATCH .../receivers/<id>/staged`) — Kante fehlt
  im Graph bis zum nächsten periodischen Reconcile, taucht danach
  automatisch auf; Log bestätigt `"graph reconcile: edge appeared
  outside Connect/Disconnect"`.
- **Node-Kill:** `kill -9` auf den Viewer-Prozess. Kollidierte
  interessant mit K7-Teil-1s Auto-Restart (`docs/decisions.md`
  Nachtrag 3): der Launcher startete die Instanz sofort mit neuer
  NMOS-Node-Registrierung neu, die alte (jetzt verwaiste)
  Node-Registrierung blieb bis zu ihrem regulären IS-04-Expiry
  (`registration_expiry_interval: 60` in `deploy/nmos/registry.json`)
  im Registry-Snapshot sichtbar — der Graph zeigte in diesem Fenster
  konsequenterweise kurzzeitig zwei „Viewer"-Kacheln mit derselben
  `instanceId` und die alte, jetzt tote Kante weiter (kein Bug: die
  Kante gehörte einem Node, der laut Registry-Snapshot noch existierte,
  der Cache spiegelte den damaligen Ist-Zustand korrekt). Nach Ablauf
  der 60s verschwand die verwaiste Node-Registrierung aus dem
  Registry-Snapshot, `HandleNodeEvent("node.removed", …)` entfernte
  ihre Kante ohne weiteren IS-05-Call — Graph zeigte danach korrekt nur
  noch die vier echten Nodes und keine verwaiste Kante mehr.

**Nicht Teil dieser Sitzung (nächste Schritte laut Reihenfolge):** S2
(SSE-first-UI + Lost-Events-Signal), danach S3 (Remote-Parität für
Instanzen).


## 2026-07-17 (Nachtrag 11) — S2: SSE-first-UI + Lost-Events-Signal
(docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md), zweiter Umsetzungsschritt
aus dem Review-Arbeitsvorrat

Zweiter Schritt aus [[project_review_2026_07_17_s_steps]], nach S1
(Graph-Edge-Cache). `workflows-view.ts`/`hosts-view.ts`/`alarm-view.ts`/
`admin-view.ts` (Audit) pollten bisher alle 3–5s; jetzt reagieren sie
auf SSE-Events, Poll bleibt nur als 30s-Fallback (Reconnect/verpasstes
Event).

**Backend (`orchestrator/internal/sse/hub.go`):** `Hub` merkt sich pro
Client (`dropped map[chan Event]bool`), ob seit dem letzten
erfolgreichen Empfang mindestens ein Event verloren ging (voller
16er-Puffer). Sobald wieder Platz ist, bekommt der Client zuerst ein
synthetisches `{"type":"lost-events"}` zugestellt (nicht blockierend,
gleiches Best-effort-Muster wie der Rest von `Broadcast`), erst danach
das eigentliche Event — Views laden bei Empfang einmal voll nach statt
still auf veraltetem Stand zu bleiben. `Subscribe`s cancel-Closure in
eine eigene `unsubscribe`-Methode ausgelagert (räumt jetzt auch
`dropped` auf, verhindert einen Map-Leak; nebenbei nötig, damit
Whitebox-Tests einen Client ohne den narrowenden `<-chan`-Rückgabetyp
von `Subscribe` registrieren/abmelden können). Sechs neue Tests in
`hub_test.go`.

**Backend, fehlende Events ergänzt (geprüft, was schon publiziert
wird, bevor etwas Neues erfunden wurde — `workflow.updated`,
`instance.crashed`/`.restarted`, `placement.advice` und die per NATS-
Subject-Passthrough bereits vorhandenen `omp.host.<id>.metrics`
existierten alle schon):**
- `audit.appended` (`internal/audit/audit.go`): `Store` bekommt einen
  optionalen `EventPublisher` (`NewStore(db, events)`, gleiches Muster
  wie `graph.Service`), broadcastet nach jedem erfolgreichen
  `Log()`-Aufruf. Reiner Trigger ohne Nutzdaten — das Admin-Tab lädt
  bei Empfang einmal `GET /api/v1/admin/audit-log` neu.
- `host.registered` (`internal/httpapi/host_handlers.go`):
  `EventSubscriber`-Interface um `Broadcast(sse.Event)` erweitert
  (dieselbe Konkretion `*sse.Hub` implementiert ohnehin beides),
  `handleRegisterHost` broadcastet nach erfolgreicher Registrierung.

**Live-CDP-Test fand einen echten, vorbestehenden Lücken-Bug (nicht
nur ein UI-Problem):** `workflows.Service.Create()` und `.Delete()`
riefen `s.publish()` nie auf — nur `Start`/`Stop`/die Restart-Rewire
taten es. Ein Workflow, der nicht über `workflows-view.ts`s eigenes
`#createWorkflow()`/`#deleteWorkflow()` (die nach ihrem eigenen POST/
DELETE ohnehin selbst `#poll()` aufrufen) sondern extern angelegt/
gelöscht wurde, blieb dadurch in jedem anderen offenen Tab bis zum
30s-Fallback unsichtbar — beim ersten Live-Test tatsächlich
reproduziert (3s-Timeout ohne sichtbare Zeile), erst danach beide
fehlenden `s.publish()`-Aufrufe ergänzt. Zwei neue Tests
(`TestCreatePublishesWorkflowUpdated`, `TestDeletePublishesWorkflowUpdated`)
in `internal/workflows/service_test.go`.

**UI (`ui/shell/*.ts`):** vier Views bekommen je einen
`#onSseMessage`-Listener auf `connectionMonitor` (gleiches Muster wie
`flow-canvas.ts`), der bei einem passenden Event-Typ (oder
`lost-events`) den bestehenden `#poll()`/`#loadAudit()` aufruft. Alle
vier `POLL_INTERVAL_MS`-Konstanten (3–5s) auf
`POLL_FALLBACK_INTERVAL_MS`/`AUDIT_POLL_FALLBACK_INTERVAL_MS` = 30s
umbenannt/erhöht. `admin-view.ts`s Nutzer-/Rollenbindungs-Abschnitte
bewusst unverändert (kein Poll/SSE-Refresh dort seit jeher, offenes
Formular würde Fokus verlieren — nur das rein lesende Audit-Log
reagiert).

**Verifiziert:**
- `go build`/`go vet`/`go test ./...` (ganzer Orchestrator, inkl. der
  neuen Hub-/Audit-/Workflow-Tests) grün, `deno check`/`deno test ui/`
  (40/40) grün, `deno bundle` erfolgreich.
- **Live, echter Orchestrator, per CDP (Node, eingebauter WebSocket-
  Client statt npm-Paket — kein `chromium --dump-dom`, s.
  `feedback_browser_verification_cdp_over_dump_dom`):** Leerlauf-
  Messung über 35s mit allen vier Views gleichzeitig gemountet (plus
  dem ohnehin schon SSE-getriebenen Flow-Editor-Tab) ergab 1–4
  `/api/v1/*`-Requests insgesamt — vorher wären es allein für diese
  vier Views over 35s rechnerisch ~36+ gewesen (Workflows alle 3s,
  Hosts/Alarme alle 4s, Audit alle 5s). Ein per direktem API-Aufruf
  (nicht über die UI) angelegter Workflow erschien nach dem
  `publish()`-Fix nach 68ms in der Workflow-Liste, eine per direktem
  API-Aufruf registrierte Host nach 195ms in der Host-Liste — beide
  ohne jeden Poll, weit unter der 1s-Vorgabe.
- Das Lost-Events-Overflow-Verhalten selbst (Hub-Puffer voll → Drop →
  `lost-events` beim nächsten freien Platz) ist deterministisch in
  `hub_test.go` abgedeckt (`TestHubBroadcastSignalsLostEventsOnNextRoomAvailable`
  u. a.); ein echter >16-Event-Burst wurde bewusst **nicht** zusätzlich
  live im Browser erzwungen — das wäre eine Race-Bedingung ohne
  zusätzlichen Erkenntnisgewinn gegenüber dem deterministischen
  Unit-Test.

**Nicht Teil dieser Sitzung (nächster Schritt laut Reihenfolge):** S3
(Remote-Parität für Instanzen — Host-Agent-Crash-Events über NATS,
Auto-Restart, `extraEnv`-Allowlist).


## 2026-07-17 (Nachtrag 12) — S3: Remote-Parität für Instanzen
(docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md), dritter Umsetzungsschritt
aus dem Review-Arbeitsvorrat — größte einzelne 24/7-Lücke geschlossen

Dritter Schritt aus [[project_review_2026_07_17_s_steps]], nach S1
(Graph-Edge-Cache) und S2 (SSE-first UI). Bisher (D6 Teil 2,
2026-07-14) galt dokumentiert: ein auf einem Remote-Host abgestürzter
Prozess wurde vom dortigen Host-Agent per `cmd.Wait()` zwar erkannt,
aber nie an den Orchestrator zurückgemeldet — anders als lokale
Instanzen (K7-Teil-1) blieb eine remote abgestürzte Instanz bis zum
manuellen Entfernen als "laufend" gelistet, keine Crash-Loop-Bremse,
kein Auto-Restart, keine Workflow-Rewire. Dieser Schritt schließt genau
diese Lücke, symmetrisch zum lokalen Pfad.

**Host-Agent (`host-agent/internal/commands/commands.go`):**
`Executor` bekommt `hostID`/`nc Publisher` (`Publisher` = schmales
Interface `Publish(subject string, data []byte) error`, von `*nats.Conn`
implizit erfüllt — Testbarkeit ohne echte NATS-Verbindung, gleiches
Muster wie `launcher.NATSRequester`). Ein Prozess, der nicht über
`stop()` beendet wurde (neue `stopping map[string]bool`-Buchführung
unterscheidet erwartetes von unerwartetem Ende), löst `publishExit()`
aus: `ExitEvent{instanceId, exitCode, stderrTail}` auf
`omp.host.<hostId>.events`. `exitCode` ist -1 bei Signal-Beendigung
(Go-Konvention `ProcessState.ExitCode()`). stderr wird jetzt zusätzlich
in einen `tailBuffer` gespiegelt (identische Logik zu
`orchestrator/internal/launcher.tailBuffer`, bewusste kleine
Duplikation wie schon `buildEnv`) — Grundlage für `stderrTail`.
`Request.ExtraEnv` (S3) wird gegen eine feste Allowlist
(`allowedExtraEnvKeys`, zunächst `OMP_WIDTH`/`OMP_HEIGHT`) geprüft;
jeder nicht gelistete Schlüssel lässt die gesamte Start-Anfrage
scheitern — dieselbe Sicherheitsgrenze wie beim Node-Typ selbst ("der
Agent-lokale Katalog entscheidet, was läuft"), nur für
Umgebungsvariablen.

**Orchestrator (`internal/launcher/launcher.go`):** neue
`Instance.ExtraEnv`-Feld (bei lokalen Instanzen nur zur
Vollständigkeit — der eigentliche lokale Neustart-Pfad liest extraEnv
weiterhin aus der `supervise()`-Goroutine-Closure; bei entfernten
Instanzen ist dieses Feld die **einzige** Quelle, aus der ein
automatischer Neustart extraEnv erneut mitschicken kann, weil es dort
keine langlebige Supervisor-Goroutine gibt). `startRemote` nimmt jetzt
`extraEnv` entgegen und schickt es im `remoteCommand`-Payload mit
(`workflows.Service.runStart` reichte extraEnv schon immer
hostID-unabhängig durch — nur `startRemote` hat es bisher stillschweigend
ignoriert, jetzt behoben). Neue `Launcher.HandleRemoteExit(hostID
string, payload []byte)` — Remote-Pendant zu `supervise()`s lokalem
`cmd.Wait()`-Ende: gleiche Crash-Loop-Bremse (`recordRestartLocked`),
gleiche `instance.crashed`/`instance.restarted`-Events, Neustart als
`remoteCommand{Action:"start"}` statt eines lokalen `os/exec`-Aufrufs,
inkl. derselben Race-Absicherungen (Stop() während Backoff, Stop()
exakt während des Neustart-Kommandos → frisch gestarteten Ersatzprozess
wieder stoppen). `hostID` kommt aus dem NATS-Subject, nicht aus dem
Payload — ein Host kann laut Subject-Konvention nur für sich selbst
Events veröffentlichen (Vertrauensgrenze, s. neuer Test
`TestHandleRemoteExitIgnoresEventFromWrongHost`).

**`main.go`:** eigene `nc.Subscribe("omp.host.*.events", …)`-Registrierung
nach `launcherSvc`s Konstruktion (nicht über `eventbus.Connect`s
generischen `onHostMetrics`-Callback-Mechanismus erweitert — der wird
weit vor `launcherSvc` aufgerufen, `HandleRemoteExit` existiert zu dem
Zeitpunkt noch nicht; eine eigene, spätere Subscription vermeidet jede
Ordnungs-Race und hält `eventbus.go` unverändert). Der bereits
bestehende `omp.>`-Passthrough leitet dieselbe Nachricht zusätzlich als
rohes, von der UI ignoriertes SSE-Event weiter — harmlose Doppelnutzung
derselben NATS-Nachricht, keine doppelte Geschäftslogik.

**Tests:** Host-Agent — sechs neue Tests in `commands_test.go`
(`fakePublisher`-Test-Double, u. a. `TestUnexpectedExitPublishesExitEvent`,
`TestExpectedStopDoesNotPublishExitEvent`,
`TestStartRejectsNonAllowlistedExtraEnvKey`,
`TestStartAllowsAllowlistedExtraEnvKeys`). Orchestrator — sechs neue
Tests in `launcher_test.go`
(`TestHandleRemoteExitRestartsInPlaceAndNotifiesObserver`,
`TestHandleRemoteExitCrashLoopBrakeStopsAutoRestarting`,
`TestHandleRemoteExitIgnoresUnknownInstance`,
`TestHandleRemoteExitIgnoresEventFromWrongHost`,
`TestHandleRemoteExitStopDuringBackoffSkipsRestart`). `go build`/
`go vet`/`go test ./...` für beide Module grün (`-p 1` zur Bestätigung,
s. u.).

**Live verifiziert** (echter Orchestrator, Postgres, NATS, NMOS-Registry,
zweiter echter `omp-host-agent`-Prozess auf derselben Dev-Maschine als
simulierter Remote-Host, gleiches Zwei-Host-Testmuster wie D6 Teil 1/2 —
eigener Katalog/State/Label, registriert über ein echtes
Admin-Bootstrap-Token):
- Remote-`omp-source`-Instanz gestartet, echter PID auf dem
  Host-Agent-Prozess bestätigt, NMOS-Selbstregistrierung bestätigt.
- `kill -9` auf den echten Prozess → Host-Agent-Log zeigt
  `instance exited unexpectedly` mit `exit_code:-1`, Orchestrator-Log
  zeigt `remote instance exited unexpectedly, restarting` →
  `GET /api/v1/instances` zeigt dieselbe Instanz-ID mit neuer PID und
  `restartCount:1`, neuer Prozess läuft nachweislich (`ps`), neue
  NMOS-Registrierung mit demselben `urn:x-omp:instance`-Tag — exakte
  Parität zum lokalen K7-Teil-1-Verhalten.
- Workflow mit `settings.programWidth/Height = 960×540` und einer Rolle
  mit `hostId` auf den Remote-Host gestartet → NMOS-Registry zeigt den
  Sender-Flow mit `frame_width:960, frame_height:540` — bestätigt, dass
  die extraEnv-Allowlist (`OMP_WIDTH`/`OMP_HEIGHT`) end-to-end
  durchgereicht wird, nicht nur im Unit-Test.
- Die Allowlist-Ablehnung selbst (nicht gelisteter Schlüssel) ist
  deterministisch in `commands_test.go` abgedeckt
  (`TestStartRejectsNonAllowlistedExtraEnvKey`); ein zusätzlicher
  Live-Test dafür wurde als redundant bewertet (identischer Codepfad,
  kein zusätzlicher Erkenntnisgewinn).
- Nach der Verifikation: Test-Instanzen/-Workflow gestoppt und
  gelöscht, zweiter Host-Agent-Prozess beendet, Test-Host aus der DB
  entfernt (gleiche Aufräum-Disziplin wie D6 Teil 1/2).

**Beobachtet, nicht Teil dieser Änderung:** `TestLauncherStopSendsSig
killIfSigtermIgnored` schlägt gelegentlich fehl, wenn `go test ./...`
alle Pakete parallel laufen lässt (CPU-Kontention zwischen mehreren
gleichzeitig echte Subprozesse startenden Testpaketen) — mit `-p 1`
oder isoliert (`go test ./internal/launcher/...`, mehrfach wiederholt)
durchweg grün. Der Diff dieser Sitzung fasst keine Zeile SIGTERM/
SIGKILL-Logik an; vorbestehende Lastempfindlichkeit, keine Regression,
nicht behoben (außerhalb des S3-Scopes).

**Nicht Teil dieser Sitzung (nächster Schritt laut Reihenfolge):**
S5/S9/S10 (klein, hygienisch), danach S4 (instances.json → Postgres).


## 2026-07-17 (Nachtrag 13) — S5: Audit-Retention + Cursor-Pagination
(docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md), vierter Umsetzungsschritt
aus dem Review-Arbeitsvorrat

Vierter Schritt aus [[project_review_2026_07_17_s_steps]] — laut
Reihenfolge-Empfehlung der erste der drei "kleinen, hygienischen"
Schritte nach S1-S3. `GET /api/v1/admin/audit-log` lieferte bisher ein
festes 200er-Fenster ohne Blättern und ohne jede Löschung — die Tabelle
wächst unbegrenzt.

**Backend (`internal/audit/audit.go`):** `Store.List` von `List(limit
int)` auf `List(before int64, limit int)` umgestellt — Cursor über die
BIGSERIAL-PK `id` (nicht `occurred_at`: Zeitstempel können bei schnell
aufeinanderfolgenden Schreibzugriffen Duplikate haben, die ID nie).
`before == 0` liefert die erste Seite, `before > 0` nur Zeilen mit
`id < before`; das Ende der Liste erkennt der Aufrufer daran, dass
weniger als `limit` Zeilen zurückkommen (kein zusätzliches
`COUNT(*)`). Neue `Store.PurgeOlderThan(retentionDays int) (int64,
error)` (parametrisierte `interval`-Multiplikation, keine
String-Interpolation) und `Store.RunRetention(ctx, retentionDays)` —
gleiches `Run(ctx)`-Muster wie `graph.Service.Run`/`registry.Poller.Run`:
ein Lauf sofort beim Start, danach täglich
(`RetentionInterval = 24h`). `retentionDays <= 0` deaktiviert die
Löschung (kein überraschendes "alles löschen").

**Config:** neues `Config.AuditRetentionDays`
(`OMP_AUDIT_RETENTION_DAYS`, Default 90, `getEnvInt`-Helfer neu in
`config.go`).

**HTTP (`internal/httpapi/auth_handlers.go`):** `GET
/api/v1/admin/audit-log?before=<id>&limit=` — `AuditReader`-Interface
entsprechend erweitert. Ungültige/negative Query-Parameter fallen
still auf die Defaults zurück (`defaultAuditLogLimit=50`,
`maxAuditLogLimit=200`, letzteres das alte feste Fenster jetzt als
Obergrenze statt einziger Option) statt eines 400 — dieselbe
Nachsichtigkeit wie bei anderen lesenden List-Endpunkten.

**`main.go`:** `go auditStore.RunRetention(ctx, cfg.AuditRetentionDays)`
neben der bestehenden `auditStore`-Konstruktion.

**UI (`ui/shell/admin-view.ts`):** `#loadAudit()` lädt jetzt immer nur
die erste Seite (bei SSE-`audit.appended`/Fallback-Poll — neue Zeile(n)
seit dem letzten Stand), neue `#loadMoreAudit()` hängt per Cursor
(kleinste bisher geladene ID) die nächste Seite an, ausgelöst durch
einen neuen "Mehr laden"-Button, der nur erscheint, solange die letzte
Seite exakt `AUDIT_PAGE_LIMIT` (50) Zeilen enthielt. Überschrift zeigt
bewusst "N geladen" statt einer nackten Zahl, um nicht wie ein
Gesamtstand auszusehen.

**Tests:** vier neue Postgres-Integrationstests in `audit_test.go`
(`TestListCursorPaginatesThroughAllEntries` — 25 neue Zeilen über
mehrere 10er-Seiten blättern, keine Duplikate/Lücken, strikt
absteigende IDs; `TestPurgeOlderThanDeletesOnlyOldRows`,
`TestPurgeOlderThanZeroOrNegativeIsNoOp`), fünf neue Handler-Tests in
`auth_handlers_test.go` für die Query-Parameter-Randfälle
(fehlend/negativ/ungültig/über der Obergrenze). `go build`/`go vet`/
`go test ./...` grün, `deno check`/`deno test ui/` (40/40) grün.

**Live verifiziert** (echter Orchestrator, Postgres, per CDP + direktem
SQL):
- 249 echte Audit-Zeilen erzeugt (80 Rollenbindungs-Anlage/Löschungs-
  Zyklen über die echte API, je zwei auditierte Aufrufe) — deutlich über
  der im Review verlangten 200er-Schwelle.
- Administration-Tab zeigte initial "Audit-Log (50 geladen)" mit
  sichtbarem "Mehr laden"-Button; ein Klick lud die nächste Seite nach
  (Überschrift → "100 geladen", keine doppelten/fehlenden Zeilen, Cursor
  korrekt aus der zuletzt geladenen ID abgeleitet).
- Retention: eine Zeile per direktem SQL-`UPDATE` künstlich auf 100 Tage
  gealtert, Orchestrator neu gestartet → Log zeigt `"audit retention
  purge completed" deleted=1 retention_days=90`, die gealterte Zeile
  danach nachweislich weg, alle frischen Zeilen unverändert vorhanden.
- Nach der Verifikation: alle für diesen Test erzeugten Audit-Zeilen aus
  der DB entfernt (Tabelle zurück auf den Vorher-Stand, 89 Zeilen).

**Nicht Teil dieser Sitzung (nächste Schritte laut Reihenfolge):** S9
(Backup/Restore), S10 (UI-Baustein-Konsolidierung), danach S4
(instances.json → Postgres).


## 2026-07-17 (Nachtrag 14) — S9: Backup/Restore
(docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md), fünfter Umsetzungsschritt
aus dem Review-Arbeitsvorrat — ein Restore wurde einmal echt
durchgeführt, nicht nur geschrieben

Fünfter Schritt aus [[project_review_2026_07_17_s_steps]]. Bisher gab
es kein Backup-Verfahren für den gesamten Orchestrator-Zustand
(Postgres: Nutzer, Rollenbindungen, Audit-Log, Layouts, Snapshots,
Workflows, Hosts) — ein Datenverlust wäre unwiederbringlich gewesen.

**`deploy/dev/backup-omp.sh`:** `podman exec omp-postgres pg_dump -U
omp --clean --if-exists omp` (kein lokal installiertes
`postgresql-client`-Paket vorausgesetzt, gleiches "Tool-Container statt
Host-Installation"-Muster wie `mtls-issue-cert.sh`), lokal mit `gzip`
komprimiert nach `.backups/omp-<UTC-Zeitstempel>.sql.gz`. `--clean
--if-exists` fügt DROP-Anweisungen vor jedem CREATE ein, damit
`restore-omp.sh` den Dump gegen eine bereits befüllte Datenbank
abspielen kann (vollständiger Ersatz statt Fehlschlag wegen
existierender Tabellen) — keine separate `dropdb`/`createdb`-Runde
nötig. Schreibt erst in eine `.tmp`-Datei und benennt danach um (ein
abgebrochener Dump darf keine unvollständige Datei unter dem finalen
Namen hinterlassen). Rotation: die letzten 14 Sicherungen bleiben,
ältere werden nach einem erfolgreichen neuen Dump gelöscht (nicht
vorher — ein fehlgeschlagener Dump darf nie die letzte funktionierende
Sicherung kosten).

**`deploy/dev/restore-omp.sh <datei>`:** verlangt (1) eine interaktive
Bestätigung (exakt `yes` eingeben) und (2) dass der Orchestrator
gestoppt ist (Port-8000-Check, gleiches Muster wie `start-omp.sh`) —
offene Verbindungen während eines Restores mit DROP-Anweisungen wären
undefiniertes Verhalten. Ohne Argument listet das Skript die
vorhandenen Sicherungen in `.backups/` auf. `Makefile`:
`make backup`/`make restore ARGS=<datei>` als Einstiegspunkte, gleiches
Muster wie `make start`/`make stop`. `.backups/` neu in `.gitignore`
(enthält Passwort-Hashes/Audit-Daten, gehört nicht ins Repo).

**`docs/HANDBUCH.md`:** neuer Abschnitt 5 "Backup & Restore" (Abschnitte
5/6 "Troubleshooting"/"Mehr Kontext" auf 6/7 verschoben).

**Live durchgeführt, nicht nur gelesen/geschrieben** (echter
`omp-postgres`-Container, echter Orchestrator) — genau der vom Review
verlangte Rundlauf:
1. `make backup` → `.backups/omp-20260717T203529Z.sql.gz` (8.0K)
   geschrieben, Rotation meldete korrekt "nichts zu entfernen" (erste
   Sicherung).
2. Orchestrator gestartet, neuen Nutzer `s9-restore-test-user` über
   `POST /api/v1/auth/users` angelegt, `GET /api/v1/auth/users`
   bestätigte ihn neben `admin`.
3. Orchestrator gestoppt, `make restore
   ARGS=.backups/omp-20260717T203529Z.sql.gz` mit `yes` bestätigt —
   `psql -v ON_ERROR_STOP=1` lief fehlerfrei durch (Standard-`pg_dump`-
   Restore-Ausgabe: `set_config`/`setval`-Zeilen, keine Fehler).
4. Orchestrator neu gestartet: `GET /api/v1/auth/users` zeigte nur noch
   `admin` — `s9-restore-test-user` war weg, exakt wie vom Backup-
   Zeitpunkt erwartet. `admin`-Login funktionierte weiterhin (Restore
   hat den Nutzer selbst nicht mit gelöscht). `/healthz`,
   `GET /api/v1/workflows`, `GET /api/v1/hosts` bestätigten den
   Orchestrator insgesamt funktionsfähig nach dem Restore, nicht nur
   die Auth-Tabelle isoliert getestet.

**Kein Go-Code geändert** — reine Shell-/Doku-/Makefile-Änderung,
`go build`/`go vet`/`go test ./...` trotzdem zur Regressions-Kontrolle
erneut grün gelaufen (unverändert, wie erwartet).

**Nicht Teil dieser Sitzung (nächste Schritte laut Reihenfolge):** S10
(UI-Baustein-Konsolidierung), danach S4 (instances.json → Postgres).


## 2026-07-17 (Nachtrag 15) — S10: UI-Baustein-Konsolidierung
(docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md), sechster und letzter der
drei "kleinen, hygienischen" Umsetzungsschritte aus dem
Review-Arbeitsvorrat

Sechster Schritt aus [[project_review_2026_07_17_s_steps]], letzter
der als "klein, hygienisch" gruppierten drei (nach S5, S9).
`workflows-view.ts` nutzte `alert()` für Fehlermeldungen,
`admin-view.ts` `confirm()` fürs Nutzer-Löschen — beide blockieren den
ganzen Tab (inkl. der SSE-Verbindung im Hintergrund) und sehen wie ein
browser-eigener Fremdkörper statt Teil der Shell aus.
Rollenbindungs-Löschen hatte gar keine Sicherheitsabfrage.

**Neu in `ui/kit`:** `<omp-toast>` (`omp-toast.ts`) — Stil 1:1 aus dem
bisherigen `#showToast()` in `ui/graph/flow-canvas.ts` extrahiert
(fixed unten mittig, Fehlerfarbe, 4s Auto-Dismiss); `showToast(message,
opts?)` erzeugt bei jedem Aufruf ein neues Element, hängt es an `host`
(Default `document.body`) und entfernt es selbst wieder. `<omp-confirm>`
(`omp-confirm.ts`) — modales, per `Promise<boolean>` auswertbares
Overlay (Hintergrund-Klick/Escape/„Abbrechen" = false, „Bestätigen" =
true) statt des blockierenden `window.confirm()`; `confirmDialog(message,
opts?)` kapselt die Promise-Erzeugung, das Element entfernt sich nach
der Antwort selbst. Beide registriert in `ui/kit/index.ts`, `flow-
canvas.ts` selbst bleibt unverändert (kein Teil dieses Schritts).

**`workflows-view.ts`:** beide `alert()`-Aufrufe (Anlegen-/Lösch-
Fehlschlag) durch `showToast()` ersetzt — zusätzlich beide Aufrufstellen
in `try/catch` gefasst, was vorher fehlte: `apiFetch()` wirft bei einem
Netzwerkfehler (z. B. Orchestrator gestoppt), nicht nur bei einer
abgeschlossenen Antwort mit Fehlerstatus (`!res.ok`) — ohne den
try/catch wäre ein Netzwerkfehler eine stille unbehandelte Promise-
Ablehnung gewesen, kein sichtbarer Toast (echte, beim Live-Test
gefundene Lücke, nicht nur eine kosmetische alert()-Ersetzung).

**`admin-view.ts`:** `confirm()` beim Nutzer-Löschen durch `await
confirmDialog(...)` ersetzt. `#deleteBinding` bekommt eine neue
Bestätigung (vorher keine) — Signatur auf die volle `RoleBinding`
umgestellt (statt nur der ID), damit die Dialog-Nachricht Subjekt/Node/
Verb nennen kann statt nur einer nichtssagenden ID.

**`ui/index.html`:** `lang="en"` → `lang="de"`.

**Sprachdurchsicht (S10: "eine Sprache, Deutsch"):** ein echter Fund in
`app-shell.ts`s Disconnected-Banner — `retryBtn.textContent =
"Reconnect now"` und das Countdown-Label `"Connection to orchestrator
lost — retrying in ${secs}s"` waren komplett auf Englisch, obwohl
`connection.ts`s eigener Kommentar bereits "Jetzt verbinden"-Knopf" als
beabsichtigten deutschen Text dokumentierte — eine echte
Diskrepanz zwischen Doku-Absicht und ausgeliefertem String, nicht nur
eine kosmetische Übersetzung. Beide auf Deutsch korrigiert
("Jetzt verbinden" / "Verbindung zum Orchestrator verloren — neuer
Versuch in ${secs}s"). Restliche Durchsicht über alle
`ui/shell/*.ts`/`ui/graph/*.ts`-Textstellen ergab keine weiteren
Englisch-Reste (nur unauffällige, im gesamten Projekt übliche
Fachbegriff-Leihwörter wie „Snapshot"/„Host"/„Descriptor").

**Tests:** `deno check`/`deno test ui/` (40/40) grün, `deno bundle`
erfolgreich (23 statt vorher 21 Module — die beiden neuen
`ui/kit`-Bausteine sind mit im Bundle).

**Live verifiziert per CDP** (echter Orchestrator, drei getrennte
Testläufe plus ein gezielter Orchestrator-Stop-Testlauf):
- Rollenbindung angelegt, gezielt (per Zeileninhalt, nicht der ersten
  Fundstelle) auf „Löschen" geklickt → `<omp-confirm>` erschien mit der
  korrekten Nachricht (Subjekt, Node, Verb genannt); „Abbrechen" ließ
  die Bindung unangetastet, ein zweiter Löschen-Klick + „Löschen"-
  Bestätigung entfernte sie tatsächlich.
- Testnutzer angelegt, gezielt gelöscht (erster Versuch traf versehentlich
  „admin" statt des Testnutzers — ein reiner Verifikationsskript-Fehler,
  keine Anwendungs-Ursache; **die Selbstschutz-Logik aus K11-Teil-1
  griff live und lehnte die versehentliche Selbstlöschung des letzten
  Admins korrekt ab**, `admin` blieb unversehrt) — beim gezielten
  zweiten Versuch zeigte der Dialog korrekt den Testnutzernamen,
  Bestätigung löschte ihn, `admin` blieb unverändert bestehen.
- **Kernverifikation des Reviews** ("Orchestrator gestoppt → Toast
  statt alert"): Seite bei laufendem Orchestrator geladen, Orchestrator
  per `make stop` beendet (Seite blieb offen, keine Neu-Navigation),
  Workflow-Anlage-Formular ausgefüllt und „Anlegen" geklickt →
  `<omp-toast data-role="toast">` erschien mit „Anlegen fehlgeschlagen:
  TypeError: Failed to fetch" — der Netzwerkfehler-Pfad (nicht nur der
  `!res.ok`-Pfad) funktioniert wie vorgesehen.
- Nach der Verifikation: keine Test-Artefakte übrig (Nutzerliste nur
  `admin`, Rollenbindungen nur die schon vor der Sitzung vorhandenen,
  Workflow-Liste leer).

**Damit sind alle drei "kleinen, hygienischen" Schritte (S5, S9, S10)
abgeschlossen.** Nächster Schritt laut Reihenfolge-Empfehlung: **S4**
(instances.json → Postgres), danach S6 (größter Brocken, Kapitel-12-
Einstieg), S7/S8 nach Bedarf.


## 2026-07-18 (Nachtrag 16) — S4: Launcher-Zustand + Instanz-Inventar
nach Postgres (docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md), siebter
Umsetzungsschritt aus dem Review-Arbeitsvorrat, nach den drei "kleinen,
hygienischen" Schritten (S5/S9/S10)

Siebter Schritt aus [[project_review_2026_07_17_s_steps]], laut
Reihenfolge-Empfehlung direkt nach S5/S9/S10. `data/instances.json`
(UMSETZUNG.md C8) war die letzte verbliebene datei-basierte Persistenz
für Bestandsdaten des Orchestrators außerhalb von Postgres (Layouts/
Snapshots/Workflows/Hosts/Audit-Log waren schon vorher migriert).

**Migration `internal/db/migrations/0005_instances.sql`:** neue Tabelle
`instances (id TEXT PRIMARY KEY, data JSONB NOT NULL)` — ein Blob pro
Instanz, gleiches Muster wie `workflows` (0004): der Orchestrator
interpretiert das JSON in Go, die DB kennt nur "irgendeine Instanz mit
dieser ID". Kein Sortier-/Filterbedarf in SQL, `List()` liefert immer
den kompletten Bestand.

**Neu `internal/launcher/store.go`:** `Store` (Put/Delete/List) analog
`workflows.Store`. **`internal/launcher/launcher.go`:** neues
unexportiertes `instanceStore`-Interface (gleiches Muster wie
`workflows.workflowStore`) — der Launcher hält intern die schmale
Interface-Sicht, `New()` nimmt weiterhin den konkreten `*Store` als
Parameter (Bequemlichkeit für `main.go`), ein neues unexportiertes
`newWithStore` dahinter erlaubt Tests, einen In-Memory-Fake statt einer
echten Datenbank einzusetzen, ohne dass Tests, denen es nicht um die
Persistenz selbst geht, eine echte Postgres-Verbindung brauchen.
`loadState()` liest jetzt `store.List()` statt einer Datei und löscht
tote Einträge (PID nicht mehr lebendig) aktiv aus der DB
(`store.Delete`) statt sie nur stillschweigend zu verwerfen. Das
bisherige `saveState()` (dumpte bei **jeder** Änderung den kompletten
Instanz-Bestand neu) ist durch ein gezieltes `persistInstanceLocked(id)`
ersetzt — ein Upsert nur der einen geänderten Instanz, an allen neun
bisherigen `saveState()`-Aufrufstellen (`startLocal`, `supervise`
dreifach, `startRemote`, `HandleRemoteExit` dreifach, `Stop` — dort
`store.Delete(id)` statt eines Puts, da die Instanz dort ja entfernt
wird).

**`main.go`:** `launcher.New(catalog, cfg.RegistryURL, cfg.NatsURL,
launcher.NewStore(database), hub, launcherNATS)` statt `cfg.DataDir`.
**`internal/config/config.go`:** `Config.DataDir`/`OMP_DATA_DIR`
komplett entfernt — nach dieser Änderung von nichts mehr referenziert
(Rollenbindungen waren schon mit D3 Teil 2 durch die authz-Tabelle
ersetzt, das war der letzte andere Nutzer des Datei-Backends unterhalb
von DataDir). `deploy/dev/start-omp.sh`s `OMP_DATA_DIR`-Export
entsprechend gestrichen. `data/instances.json` (leer, `[]`) lokal
gelöscht — reines Aufräumen, war nie versioniert (`.gitignore: /data/`).

**`docs/HANDBUCH.md`:** neuer Absatz in Abschnitt 3 (Anmeldung) — ohne
gesetztes `OMP_AUTH_JWT_SECRET_FILE` landet das beim ersten Start
auto-generierte Token-Secret auf einem ggf. vergänglichen Datenträger;
für ein echtes Deployment muss der Pfad auf einen dauerhaften,
gesicherten Speicherort zeigen, sonst werden alle Anmelde-Tokens nach
jedem Neustart ungültig.

**Tests:** neues `internal/launcher/store_test.go` (vier Tests gegen
echtes Postgres, gleiches Muster wie `workflows/store_test.go`:
Put/List-Rundlauf, Put überschreibt, leere Liste initial, Delete
idempotent). `launcher_test.go`: neuer `fakeInstanceStore` (In-Memory,
gleiches Muster wie `workflows_test.go`s `fakeStore`) für die 21 Tests,
denen es nicht um die Persistenz selbst geht; die zwei tatsächlichen
Neustart-Persistenz-Tests
(`TestLauncherReloadsStillRunningInstanceAfterRestart`,
`TestLauncherDropsDeadInstanceAfterRestart`) laufen jetzt wie vom
Review verlangt ("auf DB umgestellt") gegen eine echte, migrierte
Postgres-Datenbank statt gegen eine temporäre JSON-Datei. `go build`/
`go vet`/`go test ./...` grün (`-p 1`, gleiche vorbestehende
Lastempfindlichkeit von `TestLauncherStopSendsSigkillIfSigtermIgnored`
wie schon bei S3 dokumentiert — reproduzierbar nur unter Systemlast
während dieser Sitzung, in Isolation und bei wiederholten Einzelläufen
durchweg grün, kein Zusammenhang mit dieser Änderung).

**Live verifiziert, mit einem interessanten Befund unterwegs:** echter
Orchestrator, echtes Postgres, echte `omp-source`-Instanz gestartet —
Zeile in der `instances`-Tabelle bestätigt (PID, Typ korrekt). Beim
Versuch, einen echten Prozess-Neustart des Orchestrators bei
weiterlaufender Instanz zu simulieren (der ursprüngliche Verifikations-
plan: "Instanz starten → Orchestrator neu starten → Instanz wird wieder
adoptiert"), stellte sich heraus, dass die gestartete Kind-Instanz in
dieser Sandbox-Umgebung beim Beenden des Orchestrator-Prozesses
**immer mitstirbt** — auch nach `setsid`+`disown`-Entkopplung in eine
eigene Session/Prozessgruppe, unabhängig vom Signalziel (nur die
Orchestrator-PID, nicht die Gruppe). Wahrscheinlichste Erklärung: ein
Prozessbaum-Aufräummechanismus der Sandbox selbst (nicht Teil dieses
Orchestrators/dieser Änderung — `main.go` stoppt beim Shutdown
nachweislich keine Instanzen aktiv, das Shutdown-Log zeigt nur
"draining"/"nats disconnected", keine Launcher-Aktivität). Statt dessen
live bestätigt: der **andere** Zweig derselben Logik — `loadState()`
erkannte die jetzt tote PID beim nächsten echten Orchestrator-Prozess
korrekt (Postgres-Zeile weiterhin vorhanden, Kind-Prozess tot) und
löschte sie aktiv aus der `instances`-Tabelle (`SELECT count(*) FROM
instances` fiel von 1 auf 0) — ein echter, funktionierender
Cross-Prozess-Beweis, dass `loadState()` tatsächlich Postgres liest,
nicht mehr die alte Datei. Der "noch lebende Instanz wird wieder
adoptiert"-Zweig selbst ist durch
`TestLauncherReloadsStillRunningInstanceAfterRestart` (echtes Postgres,
zwei unabhängig konstruierte `*Launcher` auf derselben Verbindung,
echter `sleep`-Prozess) bereits strukturell bewiesen — dort tritt das
Sandbox-Artefakt nicht auf, weil kein zweiter echter Orchestrator-
Prozess beteiligt ist. Nach der Verifikation: `instances`-Tabelle und
laufende Test-Prozesse aufgeräumt (leer bestätigt).

**Nicht Teil dieser Sitzung (nächster Schritt laut Reihenfolge):** S6
(Workflow-Kontext in der Shell — Kapitel-12-Einstieg, größter
verbleibender Brocken aus dem Review), S7/S8 nach Bedarf dazwischen.

## 2026-07-18 (Nachtrag 17) — S6 / Kapitel 12 Teil 1: port-genaues
Verbindungs-Template + Crosspoint-Verkabelung für Mischer/Switcher

**Befund vor der Umsetzung (Blocker, dem Nutzer vorgelegt):** Kapitel
12 Teil 1s eigene Verifikation ("Workflow ‚Regieplatz 1' mit drei
`omp-source`-Rollen + einem Switcher/Mixer") ist mit dem heutigen
Node-Code nicht durchführbar. Code gelesen (nicht angenommen): nur
`omp-viewer` registriert einen statischen IS-04-Receiver
(`nodes/omp-viewer/src/main.rs:210`). `omp-switcher`,
`omp-video-mixer-me`, `omp-audio-mixer`, `omp-player`,
`omp-multiviewer`, `omp-srt-gateway`, `omp-ograf` haben alle
`receivers: vec![]` — sie entdecken jeden MXL-Sender im Netz über
einen eigenen `discovery_loop` (Poll alle 2 s,
`nodes/omp-video-mixer-me/src/main.rs:378`) und wählen den aktiven
Eingang über eine Node-eigene Crosspoint-Methode
(`crosspoint.take`/`select`), nicht über IS-05 Connect. Das
`graph.Connect(fromSender, toReceiver)`-Template aus D7 Teil 1 scheitert
also schon heute mit "role has no receiver" für genau den im Kapitel
wörtlich beschriebenen Fall. Dem Nutzer drei Optionen vorgelegt (A:
Teil 1 wie geplant + Lücke dokumentiert / B: Scope um
Crosspoint-Verkabelung erweitern / C: nur dokumentieren, kein Code) —
Entscheidung: **B**.

**Umsetzung Teil 1 (wie ursprünglich geplant):**
`workflows.Connection` um optionale `fromSender`/`toReceiver`-Labels
erweitert (`types.go`) — leer = bisheriges Verhalten (erster
Sender/Receiver, Kompatibilitäts-Fallback). Auflösung in
`findSender`/`findReceiver` (`service.go`) nach Label statt Index.
`PUT /api/v1/workflows/{id}` (`workflows.Service.Update`, nur im
Zustand `stopped`, §22.3 Punkt 2) ergänzt. `ui/shell/workflows-view.ts`:
Sender-/Receiver-Label-Freitextfelder pro Connection-Zeile (kein
Dropdown — verfügbare Port-Labels sind heute nirgends als
Katalog-Metadaten abgelegt, nur im jeweiligen Rust-Quelltext; ein
Label-Katalog ist dokumentierte Folgearbeit), "Bearbeiten"-Knopf pro
gestopptem Workflow (öffnet dasselbe Formular vorbefüllt, sendet PUT
statt POST).

**Umsetzung Erweiterung (Crosspoint, Option B):** neue
`crosspointByNodeType`-Tabelle (`service.go`, Node-Typ →
Methodenname + Sender-ID-Argumentname + Name des
Eingangs-Listen-Parameters), direkt aus dem jeweiligen Rust-Quelltext
übernommen, nicht geraten (§0 Punkt 6): `omp-switcher` → `select`,
`omp-video-mixer-me` → `crosspoint.take` (setzt PGM sofort, ohne den
gestagten Preset-Wert zu berühren — bewusst gewählt statt
`select`+`cut`). `applyConnection()` entscheidet pro Connection: hat
die Zielrolle einen Receiver → IS-05 Connect (Teil-1-Pfad); sonst,
falls der Zielrollen-Typ in `crosspointByNodeType` bekannt ist → ein
Methodenaufruf mit dem aufgelösten Sender als aktivem Eingang; sonst
ein verständlicher Fehler statt eines stillen No-Op.
`omp-audio-mixer` bewusst **nicht** in der Tabelle: dessen Eingänge
hängen an dynamisch angelegten Kanälen (`addChannel` +
`channel.<id>.setSource`), das bräuchte zusätzlich Kanal-Anlage im
Workflow-Template — dokumentierte Folgearbeit, nicht Teil dieser
Sitzung. `validate()` lehnt mehr als eine eingehende Connection auf
dieselbe Crosspoint-Zielrolle ab (unauflösbare Mehrdeutigkeit, welcher
Sender beim Start gewinnt).

**Live-Fund unterwegs, live behoben:** der erste Live-Test (echter
`omp-source` + echter `omp-video-mixer-me`, Workflow gestartet) landete
in `started`, aber `crosspoint.programInput` blieb leer — der
Node-eigene `discovery_loop` (2 s Poll) hatte den frisch gestarteten
Sender zum Zeitpunkt des `crosspoint.take`-Aufrufs noch nicht selbst
entdeckt; `switch_isel()` (`pipeline.rs:407`) findet dann keinen Pad
und **verwirft die Auswahl endgültig** (setzt `program` auf `None`,
kein Selbstheilungs-Mechanismus für später erscheinende Pads,
bestätigt durch Quelltext-Lesen). Fix: `waitForCrosspointInput()`
pollt vor dem eigentlichen Methodenaufruf den Node-eigenen
Eingangs-Listen-Parameter (`crosspoint.inputs`/`inputs`, je nach
Node-Typ, gleiches `[{senderId, label}, …]`-Format bei beiden), bis
der gewählte Sender darin erscheint — Timeout gebunden an denselben
`registrationTimeout`, den auch die NMOS-Registrierung nutzt. Zweiter
Live-Test (frische Instanzen, `omp-video-mixer-me` "PGM"-Sender →
`omp-switcher`, stabiles statisches Label statt eines der
instabil-benannten `omp-source`-Sender, s. u.) endete in `started`,
`GET .../params/activeInput` am Switcher bestätigte exakt die
PGM-Sender-ID des Mixers.

**Zweiter, dokumentierter Live-Fund (nicht behoben, Folgearbeit):**
`omp-source`s zwei Sender (Video/Audio) setzen kein `SenderSpec.label`
— der SDK-Fallback (`omp-node-sdk/src/node.rs:272`) generiert dann
`"<config.label> Sender <n>"`, und `config.label` ist bei
`omp-source` das `OMP_LABEL`, das der Launcher **pro Instanz
individuell** setzt (zur UI-Unterscheidbarkeit mehrerer gleichzeitig
laufender Instanzen desselben Typs). Ergebnis: der Sender-Label-Wert
ist über einen Neustart der Rolle hinweg **nicht stabil** — im
Gegensatz zur types.go-Doku-Annahme "Labels sind pro Node-Typ stabil",
die für Nodes mit explizitem statischem Label (`omp-video-mixer-me`
"PGM", `omp-ograf` "Fill"/"Key") zutrifft, aber nicht für Nodes mit
Default-Label. Live reproduziert: ein `fromSender`-Wert, der beim
Anlegen des Workflows vom Label einer bereits laufenden Instanz
übernommen wurde, passte nicht mehr, nachdem die Rolle über den
Workflow neu gestartet wurde (neue Instanz, neues `OMP_LABEL`) —
`waitForCrosspointInput()` griff korrekt (Timeout + verständlicher
Fehler statt stiller Fehlverkabelung), aber das ist trotzdem eine
Lücke: für `omp-source`-artige Mehrfach-Sender-Nodes ohne explizites
Label ist die Kapitel-12-Label-Auflösung heute praktisch nicht
nutzbar. Sauberster Fix (nicht Teil dieser Sitzung): `SenderSpec.label`
bei allen Mehrfach-Sender/-Receiver-Nodes explizit statisch setzen
(z. B. `omp-source`: "Video"/"Audio", mechanischer Rollout analog
D5-prep-2s MediaFlow-Ausrollung über acht Nodes) — dann verhält sich
jeder Node-Typ wie `omp-video-mixer-me`/`omp-ograf` heute schon.

**Tests:** `orchestrator/internal/workflows/service_test.go` — sechs
neue Tests (Label-Auflösung, Crosspoint-Methodenaufruf inkl.
Wait-Mechanismus Erfolgs- und Timeout-Pfad, fehlende
Receiver/Crosspoint-Zuordnung, Validierungsregel für mehrfache
Crosspoint-Ziel-Connections). `internal/httpapi`: `fakeWorkflowService`
um `Update` ergänzt. `go build`/`go vet`/`go test ./...` grün
(orchestrator, inkl. echter Postgres-Store-Tests). `deno check
ui/**/*.ts` grün.

**Live verifiziert:** zwei Szenarien gegen echten Orchestrator + echte
Rust-Nodes (s. o., PGM→Switcher-Crosspoint mit
`activeInput`-API-Nachweis). UI-Pfad separat per CDP-Session (Node
`fetch`+`WebSocket`, kein `chromium --dump-dom` — Login-Token direkt in
`localStorage` gesetzt, dann Formular-Interaktion): Workflow über das
Formular inkl. Sender-Label-Feld angelegt, per API gegengeprüft
(`fromSender` rundet korrekt), "Bearbeiten" vorbefüllt exakt die
zuvor gesetzten Werte, Umbenennen + Speichern löst tatsächlich ein PUT
aus und persistiert. Alle Test-Workflows/-Instanzen danach entfernt.

**Nicht Teil dieser Sitzung:** `omp-audio-mixer`-Crosspoint (Kanal-
Anlage nötig), stabile statische Sender-Labels für `omp-source`
(s. o.), Kapitel 12 Teil 2 (Editor-Brücke "Gruppe als Workflow
speichern") und die weiteren Teile 3–6.

## 2026-07-18 (Nachtrag 18) — Kapitel 12 Teil 2: Editor-Brücke
"Gruppe als Workflow speichern" + Workflow-Rahmen im Flow-Editor

**Umsetzung, wie in §12.3b/§12.4 Teil 2 spezifiziert:**

a) **"Als Workflow speichern"** (`ui/graph/flow-canvas.ts`, neuer
Knopf in der Breadcrumb-Leiste neben "Gruppe auflösen", nur sichtbar
innerhalb einer Gruppe): leitet aus den (rekursiven) Gruppenmitgliedern
über `node.instanceId` → `GET /api/v1/instances` die Rollen ab
(Rollenname = Node-Typ, bei Mehrfachvorkommen mit Suffix
disambiguiert); Nodes ohne Launcher-Instanz brechen mit einer
verständlichen Toast-Fehlermeldung ab, statt still ausgelassen zu
werden (`missing`-Liste). Aus den gruppeninternen Kanten (beide
Endpunkte Gruppenmitglieder) wird das Connection-Template abgeleitet
und per `POST /api/v1/workflows` gespeichert.

**Bewusste Verfeinerung ggü. der wörtlichen Spezifikation:**
`fromSender`/`toReceiver` werden nur gesetzt, wenn der jeweilige Node
zum Exportzeitpunkt **mehr als einen** Port auf dieser Seite hat — bei
genau einem Port bleibt der Kompatibilitäts-Fallback (erster
Sender/Receiver) unangetastet. Grund: das in Nachtrag 17 dokumentierte
Label-Instabilitätsproblem (nicht-explizite `SenderSpec.label`s hängen
vom Launcher-vergebenen `OMP_LABEL` ab, das sich mit jedem
Rollen-Neustart ändert) würde sonst bei JEDEM Export ein Label
einfrieren, das nach dem ersten Workflow-Start (frische Instanzen)
nicht mehr passt — auch bei eigentlich unbenutzten Einzel-Port-Nodes.
Mit der Verfeinerung betrifft die Instabilität nur noch echte
Mehrfach-Port-Fälle (z. B. `omp-source` Video/Audio), nicht mehr den
Normalfall.

**Bekannte, bewusste Grenze:** Kanten werden ausschließlich aus
`/api/v1/graph`s IS-05-Kanten abgeleitet — eine Crosspoint-Zuordnung
zwischen zwei manuell (nicht über einen Workflow) laufenden Instanzen
(z. B. ein Bildmischer, dessen `crosspoint.take` bereits manuell auf
eine bestimmte Kamera zeigt) ist für den Orchestrator nirgends als
"Kante" sichtbar und kann von "Als Workflow speichern" daher nicht
erfasst werden — exakt dieselbe strukturelle Lücke, die Nachtrag 17
schon für den umgekehrten Weg (Workflow-Start → Crosspoint) beschreibt.
Für den Export bedeutet das: eine Zielrolle ohne IS-04-Receiver (also
ein Crosspoint-Ziel) taucht im exportierten Template nur dann mit einer
Connection auf, wenn zufällig eine andere, unabhängige IS-05-Kante
denselben Node betrifft — praktisch meist gar nicht. Kein Bug, sondern
dieselbe Grenze wie beim manuellen Verkabeln vor diesem Kapitel.

b) **Workflow-Rahmen** (`#buildWorkflowFrames()`,
`#render()`/`#fetchAndRender()`): `/api/v1/workflows` wird zusätzlich
zu `/api/v1/graph` abgerufen (bei jedem Refresh, zusätzlich ausgelöst
durch das neu zu `GRAPH_REFRESH_EVENT_TYPES` hinzugefügte
`workflow.updated`-SSE-Event — sonst bliebe ein Rahmen nach
Start/Stop bis zum nächsten Node-Event veraltet). Für jeden Workflow
mit mindestens einem aufgelösten `runtime[role].nodeId` wird ein
gestrichelter Rahmen um die Bounding-Box seiner Runtime-Kacheln
gezeichnet (Statusfarbe wie im Workflows-Tab), aber **nur**, wenn
ALLE seine Runtime-Nodes gerade als eigene Kachel im aktuellen Scope
sichtbar sind — sonst still übersprungen (kein Teil-Rahmen). Rein
additiv/lesend, kennt `#groupTree` nicht (bewusste Trennung der zwei
Konzepte, §12.1).

**Tests:** `deno check ui/**/*.ts` und `deno test ui/` grün (keine
neuen `.ts`-Unit-Tests — die neue Logik ist DOM-/Fetch-lastig, nicht
in reiner Datenmodell-Form wie `groups.ts`; Verifikation stattdessen
live, s. u.).

**Live verifiziert, Trias-Szenario genau wie in §12.4 Teil 2
gefordert** (CDP-Session, Node `fetch`+`WebSocket`, echter
Orchestrator + drei echte Rust-Nodes): `omp-video-mixer-me`
("PGM") → `omp-viewer` real per Drag&Drop-Äquivalent
(`POST /api/v1/graph/edges`) verkabelt, `omp-switcher` unverbunden
dazugenommen — bewusst diese drei statt "3 Kameras" gewählt, weil
jede hier nur einen relevanten Port hat und die Verifikation damit
nicht in die bekannte `omp-source`-Label-Instabilität läuft (s. o.).
Drei Kacheln per synthetischem Shift-Pointerdown ausgewählt, „g"
gruppiert (`window.prompt` überschrieben, da Headless-Chrome Prompts
sonst auto-dismisst), Gruppe per Doppelklick betreten, „Als Workflow
speichern" geklickt → API bestätigt genau die erwarteten drei Rollen
+ eine Connection (mixer→viewer, ohne eingefrorenes Label, wie von der
Verfeinerung vorgesehen). Workflow gestartet (frische Instanzen,
neue Node-IDs) → nach Reload: grüner gestrichelter Rahmen
„▭ Regieplatz Live-Test (started)" exakt um die drei neuen Kacheln,
`GET /api/v1/graph` bestätigt die reale IS-05-Kante zwischen den
frischen Instanzen. Alle Test-Workflows/-Instanzen/-Layout-Einträge
danach entfernt (Layout auf leer zurückgesetzt).

**Nicht Teil dieser Sitzung:** Kapitel 12 Teil 3 (Pause-Zustand,
Export/Import-Datei), Teil 4 (Workflow-Scope-AuthZ), Teil 5
(Operator-Einstieg), Teil 6 (Rollen-Designer/Katalog-Grid);
D7 Teil 2 (Zeitsteuerung + Ressourcen-Vorprüfung), laut §12.4
empfohlen zwischen Teil 2 und Teil 3.

## 2026-07-18 (Nachtrag 19) — D7 Teil 2: Zeitsteuerung, Stop-
Sicherheitsabfrage, Ressourcen-Vorprüfung — inkl. eines live gefundenen
und behobenen Nebenläufigkeits-Bugs

**Umsetzung wie in ARCHITECTURE.md §6.2-Erweiterung 2026-07-10
spezifiziert, alle drei Punkte:**

**1. Zeitsteuerung.** `workflows.Schedule` (types.go): `kind`
(`once`/`daily`/`weekly`), `action` (`start`/`stop`), je nach `kind`
`at` (RFC3339), `timeOfDay` ("HH:MM") und/oder `weekday` (0–6). Neuer
`workflows.Scheduler` (scheduler.go, eigene Hintergrund-Schleife wie
`registry.Poller`/`placement.Engine`, Tick alle 20 s) wertet pro
Workflow jeden Schedule aus und ruft `Start()`/`Stop()` auf, sobald der
berechnete Ist-Zeitpunkt innerhalb eines 90-s-Fensters liegt.
**Nachhol-Regel bei verpassten Zeitpunkten — explizit entschieden
(ARCHITECTURE.md nennt die Wahl offen, "Detail in D7"): verfallen
lassen, nicht nachholen.** Begründung: ein Stunden später nachgeholter
Start/Stop kann mit zwischenzeitlicher manueller Bedienung kollidieren;
für Sendebetrieb ist ein sichtbar ausgefallener Zeitplan sicherer als
eine überraschende verspätete Aktion. Implementiert über `LastFiredAt`
pro Schedule-Eintrag plus das 90-s-Fenster — ein länger zurückliegender
Zeitpunkt fällt aus dem Fenster heraus und feuert nie nachträglich.

**2. Stop-Sicherheitsabfrage.** `Settings.ConfirmStop`; `Stop()` bekommt
einen `confirm bool`-Parameter, lehnt ohne Bestätigung mit
`ErrConfirmationRequired` (409) ab, wenn `ConfirmStop` gesetzt ist.
`POST /api/v1/workflows/{id}/stop` akzeptiert jetzt optional
`{"confirm": true}`. **Verhältnis zeitgesteuerter Stop ↔ confirm_stop —
explizit entschieden (ARCHITECTURE.md nennt auch das offen):** der
Scheduler ruft `Stop()` immer mit `confirm=true` auf, unabhängig von
`ConfirmStop` — die Bestätigung ist beim Anlegen des Zeitplans bereits
erfolgt, nicht erst um 03:00 nachts (ARCHITECTURE.md wörtlich).

**3. Ressourcen-Vorprüfung.** `workflows.ResourcePrecheck`-Interface,
implementiert von `*placement.Engine.CheckHost()` (neue Methode,
wiederverwendet dieselben Alarm-Schwellwerte wie die advisory-only
Placement-Engine aus D6 Teil 3 — bewusst kein drittes
Schwellwert-Konzept). `Start()` prüft **vor** jeder Provisionierung für
jede Rolle mit gesetzter `HostID` den Ziel-Host; schlägt eine Prüfung
fehl, bricht `Start()` sofort mit `ErrResourcesUnavailable` (503) ab,
ohne dass auch nur eine Rolle gestartet wurde (kein Teil-Start). Rollen
mit leerer `HostID` (lokal) sind bewusst **nicht** Teil der Prüfung —
der Orchestrator hat für "sich selbst" keine Telemetrie (nur
registrierte Remote-Hosts senden welche); ein neu registrierter Host
ohne Messwerte gilt als "ok" (fail-open, gleiche Haltung wie die
advisory-Engine bei fehlenden Daten).

**Live gefundener und behobener Nebenläufigkeits-Bug (der eigentliche
Kern dieser Sitzung).** Erster Live-Test (echter Orchestrator, "once"-
Schedule 35 s in der Zukunft): Log zeigte drei `"scheduled action
fired"`-Einträge für **dieselbe** Occurrence, im exakten 20-s-
Tick-Abstand — der Workflow wurde teilweise doppelt gestartet.
Root Cause: `runStart()`/`runStop()`/`rewireAfterRestart()`/`fail()`
laufen als Hintergrund-Goroutinen über mehrere Sekunden (echte
GStreamer-Node-Startzeit + NMOS-Registrierung) und schreiben dabei
wiederholt den *gesamten*, zu ihrem eigenen `Start()`-Aufruf erfassten
`Workflow`-Stand per `Store.Put()` zurück — inklusive eines veralteten
`Definition.Schedules` (vor jeder Scheduler-Änderung erfasst). Der
Scheduler selbst schrieb `LastFiredAt` ursprünglich per Get()+Put()
(`persistSchedule()`) — genau dieses spätere, blinde `Put()` einer
Hintergrund-Goroutine hat die frisch gesetzte `LastFiredAt`-Markierung
wieder verworfen, woraufhin der nächste Tick erneut feuerte. Fix in
zwei Teilen, beide als Postgres-JSONB-Partial-Updates statt Get()+Put()
(`internal/workflows/store.go`):
- `Store.UpdateSchedules(id, schedules)` — `jsonb_set` nur auf
  `{definition,schedules}`, vom Scheduler genutzt.
- `Store.UpdateRuntime(wf)` — schreibt Status/Error/Runtime wie `Put()`,
  bewahrt aber den *aktuell in der DB stehenden*
  `definition.schedules`-Pfad statt ihn mit dem (potenziell veralteten)
  `wf`-Stand des Aufrufers zu überschreiben; ersetzt `Put()` an allen
  sieben Stellen in `service.go`, die nur Status/Runtime ändern wollen
  (`Start()`, `runStart()` zweimal, `fail()`, `Stop()`, `runStop()`,
  `rewireAfterRestart()`). `Create()`/`Update()` bleiben bei `Put()` —
  dort *ist* eine neue `Definition` (inkl. `schedules`) die gewollte,
  vom Nutzer stammende Änderung.

**Tests:** `orchestrator/internal/workflows/scheduler.go` (neu) +
`scheduler_test.go` (neu, 9 Tests: `parseTimeOfDay`/`occurrenceAt` pur,
Fire-Window-Erfolgs-/Zu-früh-/Verfallen-Pfad, confirm=true bei
zeitgesteuertem Stop, sowie `TestSchedulerLastFiredAtSurvives
ConcurrentRunStart` — reproduziert den Live-Bug gegen den echten
`*Service` mit einer absichtlich verzögerten Registrierung und beweist,
dass ein zweiter Tick nach `runStart`-Abschluss nicht erneut feuert).
`service_test.go`: 9 neue Tests (confirm_stop Erfolgs-/Ablehnungspfad,
Ressourcen-Vorprüfung inkl. "lokale Rolle wird nicht geprüft",
Schedule-Validierung). `store_test.go`: 4 neue Tests gegen echtes
Postgres, darunter zwei, die exakt die Blind-Overwrite-Reihenfolge des
Live-Bugs nachstellen. `placement_test.go`: 4 neue `CheckHost()`-Tests.
`go build`/`go vet`/`go test ./...` grün (inkl. echter
Postgres-Store-Tests). `deno check`/`deno test` grün.

**UI** (`ui/shell/workflows-view.ts`): Zeitplan-Zeilen im
Anlegen-/Bearbeiten-Formular (Kind-/Aktions-Select, je nach Kind
datetime-local- bzw. Zeit-(+Wochentags-)Feld, "+ Zeitplan"), Checkbox
"Sicherheitsabfrage beim Stoppen verlangen"; Stop-Knopf zeigt bei
gesetztem `confirmStop` einen `omp-confirm`-Dialog (S10-Baustein) statt
direkt zu stoppen. `#editWorkflow()` übernimmt `lastFiredAt`
unverändert aus der API-Antwort — ein Bearbeiten-Speichern-Zyklus ohne
Schedule-Änderung darf ein bereits gefeuertes "once"-Schedule nicht
erneut scharfschalten.

**Live verifiziert (echter Orchestrator, echte `omp-source`-Instanz):**
"once"-Schedule 10 s in der Zukunft angelegt, **eine** Minute über drei
Tick-Grenzen hinweg beobachtet — Log zeigt genau einen
`"scheduled action fired"`-Eintrag, `GET` bestätigt `status: started`
und ein stabil gesetztes `lastFiredAt` über alle folgenden Ticks
hinweg (vor dem Fix: drei Fires, teilweiser Doppelstart). `confirm_stop`:
Stop ohne `confirm` → 409 + Workflow bleibt `started`; Stop mit
`confirm: true` → 200. UI-Pfad separat per CDP-Session: Zeitplan-Zeile
(täglich 08:30) + Sicherheitsabfrage-Checkbox im Formular gesetzt,
Workflow angelegt, per API gegengeprüft (`schedules`/`settings.
confirmStop` runden korrekt), "Bearbeiten" zeigt exakt dieselben Werte
vorbefüllt. Alle Test-Workflows/-Instanzen danach entfernt.

**Nicht Teil dieser Sitzung:** Kapitel 12 Teil 3 (Pause-Zustand,
Export/Import-Datei) — jetzt der nächste empfohlene Schritt laut
§12.4, da D7 Teil 2 (dort als Zwischenschritt vor Teil 3 vorgesehen)
abgeschlossen ist.

## 2026-07-18 (Nachtrag 20) — Kapitel 12 Teil 3: Pause-Zustand +
Export/Import

**Zwei offene Fragen aus §12.5 bewusst mit den im Dokument bereits
genannten Vorschlägen beantwortet, ohne Rückfrage** (beide sind als
"reicht die vorgeschlagene X, oder..." formuliert, keine echte
Weggabelung — die Sitzung ist damit nicht blockiert):
- **Frage 1 (Pause vs. Stop):** die vorgeschlagene Unterscheidung
  (identische Ressourcen-Wirkung, nur Editor-Sichtbarkeit/Absicht
  unterschiedlich) umgesetzt. Der zusätzlich gestellte Unterfall
  ("soll paused zusätzlich Zustand konservieren, z. B. Zeitpläne
  ausgesetzt statt gelöscht?") ist durch die D7-Teil-2-Umsetzung
  bereits beantwortet, ohne dass diese Sitzung dafür etwas Neues bauen
  musste: `Definition.Schedules` wird von `Stop()`/`Pause()` nie
  angefasst (nur `Status`/`Runtime`/`Error`) — ein Zeitplan überlebt
  sowohl Stop als auch Pause unverändert, es gibt also keinen
  Unterschied zu konservieren.
- **Frage 2 (Export-Umfang):** bewusst **nicht** die volle
  Spezifikation (Definition + Layout + Parameter-Snapshot), sondern
  nur die Definition — Begründung unten (Positions-/Snapshot-Mitnahme
  hat einen echten technischen Haken, kein bloßes Zeitsparen).

**Umsetzung:**

a) **`paused`-Zustand.** Neue Status `paused`/`pausing`;
`Service.Pause(ctx, id, confirm)` — technisch identisch zu `Stop()`
(gleiche `runStop()`-Routine, jetzt um einen `targetStatus`-Parameter
erweitert), landet aber in `paused`; `confirm_stop` (D7 Teil 2) gilt
für Pause genauso wie für Stop. `Start()` akzeptiert `paused` als
Vorzustand — "Resume = normaler Start" braucht dafür keinen eigenen
Codepfad, da `Pause()` dieselben Prozesse wie `Stop()` beendet und
`Start()` bei jedem Aufruf ohnehin frisch provisioniert.
`Update()`/`Delete()` akzeptieren `paused` zusätzlich zu `stopped`
(§12.3c wörtlich).

b) **Platzhalter-Rendering** (`ui/graph/flow-canvas.ts`). Bewusste
Design-Entscheidung, ohne die im Dokument angedeutete
Positions-Vererbung über `wf.Runtime[role].NodeID`: ein pausierter
Workflow hat **keine** Runtime-Node-IDs mehr (Pause leert `Runtime`
genau wie Stop, s. o.) — es gibt also keine natürliche ID, an die sich
eine Position hängen ließe, ohne `Runtime` beim Pausieren absichtlich
NICHT zu leeren (hätte `#pruneStalePositions()` unterlaufen müssen,
mehr Sonderfall-Code). Stattdessen: synthetische Tile-IDs
(`paused:<workflowId>:<role>`, `pausedPlaceholderId()`), die am
*bestehenden* Positions-Zuweisungs-/Pruning-Mechanismus
(`#assignMissingPositions`/`#pruneStalePositions`) teilnehmen wie jede
echte Node-/Gruppen-ID — Platzhalter-Positionen sind damit über
Reloads stabil, ohne eine zweite Positions-Infrastruktur zu erfinden.
Kachel: Rollenname + Node-Typ, gestrichelter Rahmen, keine Ports (ein
pausierter Workflow hat keinen laufenden Node, der welche liefern
könnte). Verbindungen: gestrichelte Linien Kachelmitte-zu-Kachelmitte
(ohne Port-Geometrie, die gibt es ohne laufenden Node nicht) für jeden
`definition.connections`-Eintrag. Der bereits in Kapitel 12 Teil 2
gebaute Workflow-Rahmen wurde erweitert, um auch um diese
Platzhalter-Kacheln zu zeichnen (Status "paused" umgeht dabei die
Teil-2-Bedingung "Node muss gerade eine sichtbare Kachel sein", die
für echte Runtime-Nodes gilt, aber auf Platzhalter nicht zutrifft).

c) **Export/Import** (`GET /api/v1/workflows/{id}/export`,
`POST /api/v1/workflows/import`). **Bewusst nur `{version, name,
definition}`** — kein `layoutFragment`, kein `parameterSnapshot` aus
der vollen §12.3d-Spezifikation. Grund, nicht nur Zeitersparnis: ein
`parameterSnapshot` würde die bestehende Snapshot/Apply-Maschinerie
(B7) wiederverwenden müssen, die node-ID-gescopt ist — nach einem
Import (oder auch nur einem Neustart) hat jede Rolle zwangsläufig
**neue** Node-IDs, ein Snapshot müsste also erst rollenbewusst
umgemappt werden, eine Fähigkeit, die es heute nicht gibt (dokumentierte
Folgearbeit). `layoutFragment` ist mit der Platzhalter-Lösung aus b)
ohnehin überholt: die Platzhalter-Position ist rein client-seitiges
Zustand (im Layout-Blob, nicht im Workflow-Objekt) — ein
`layoutFragment` im Export wäre eine dritte Positions-Quelle, die mit
dem bestehenden Positions-Zuweisungs-Mechanismus konkurrieren würde,
ohne einen zusätzlichen Nutzen zu bieten (die Kernverifikation
"Export → Delete → Import → Start → identisches Verhalten" prüft
Funktion, nicht Pixel-Position). Import validiert jede Rolle gegen den
Launcher-Katalog (`Launcher.Catalog()`, neue Interface-Methode) —
unbekannter `nodeType` → `ErrValidation` statt Import-Torso;
Namenskollision → automatischer Suffix `" (2)"`, `" (3)"`, … (Vorschlag
aus §12.3d gewählt: "Suffix oder Fehler").

**Tests:** `service_test.go` — 11 neue Tests (Pause-Erfolgs-/Ablehnungs-/
Bestätigungs-Pfad, Resume aus "paused", Delete/Update erlauben
"paused", Export-Rundlauf + unbekannte ID, Import lehnt unbekannten
Katalog-Typ ab, Import legt gestoppten Workflow an, Import
dedupliziert Namenskollision). `go build`/`go vet`/`go test ./...`
grün. `deno check`/`deno test` grün (keine neuen `.ts`-Unit-Tests —
Platzhalter-Rendering ist DOM-lastig, Verifikation live per CDP, s. u.).

**Live verifiziert (echter Orchestrator, echte `omp-source`/
`omp-viewer`-Instanzen), exakt die in §12.4 Teil 3 geforderte
Verifikation:**
- Workflow mit zwei Rollen + einer Connection gestartet (zwei echte
  Prozesse, `ps` bestätigt), pausiert → `GET` zeigt `status: paused`,
  `runtime` leer, **`ps` bestätigt keine Prozesse mehr**. CDP-Session:
  genau zwei Platzhalter-Kacheln ("src"/"omp-source",
  "view"/"omp-viewer"), eine gestrichelte Verbindungslinie, ein
  Workflow-Rahmen mit Label "▭ Pause Test (paused)".
- Resume (`POST .../start` aus "paused"): frische Instanzen, `status:
  started`, echte Prozesse laufen.
- **Export → Delete → Import → Start → identisches Verhalten:**
  Export-JSON abgerufen, Workflow gelöscht (`GET` bestätigt 404),
  Import aus der Export-Datei erzeugt einen neuen `stopped`-Workflow
  mit identischer Definition, Start liefert zwei frische, korrekt
  verkabelte Instanzen (`GET /api/v1/graph` bestätigt die reale
  IS-05-Kante).

Alle Test-Workflows/-Instanzen/-Layout-Einträge danach entfernt.

**Nicht Teil dieser Sitzung:** rollenbewusstes Parameter-Snapshot-Remapping
für Export/Import (s. o., Folgearbeit für B7); Kapitel 12 Teil 4
(Workflow-Scope-AuthZ) — nächster empfohlener Schritt laut §12.4.

## 2026-07-18 (Nachtrag 21) — Kapitel 12 Teil 4: Workflow-Scope-AuthZ
(§12 Punkt 2 vervollständigt)

**Warum das mehr als "nice to have" ist, live entdeckt:** beim
Entwerfen fiel auf, dass die bisherige, instanz-ID-basierte
Rollenbindung (`consoles.NodeRoleID`, D3 Teil 2) für Workflow-Rollen
bereits heute strukturell fragil ist — `Launcher.Start()` vergibt bei
jedem Workflow-Start/-Resume (Stop→Start, Pause→Resume) eine **neue**
Instanz-ID (live in dieser wie in früheren Sitzungen beobachtet: nach
Pause→Resume in Kapitel 12 Teil 3 hatte dieselbe Rolle "src" zwei
unterschiedliche `instanceId`-Werte). Eine an die alte Instanz-ID
gebundene Bedienrechte-Zusage würde also nach jedem Neustart der Rolle
still ins Leere laufen. Dieses Kapitel behebt also nicht nur den in
§12.5 offen benannten Bildmeister-Fall, sondern eine bereits
existierende Robustheits-Lücke.

**Umsetzung wie in §12.3e spezifiziert:**

`authz.Binding` bekommt ein optionales `WorkflowID`-Feld (Migration
`0006`, `role_bindings.workflow_id`, Default `''` = unverändertes
Vor-Kapitel-12-Teil-4-Verhalten). Ist `WorkflowID` gesetzt, ist
`NodeID` **kein** Instanz-/Node-ID-Wert mehr, sondern ein Rollenname
aus `workflows.Definition.Roles` (stabil über beliebig viele
Rollen-Neustarts) — oder `"*"` für den ganzen Workflow (der
Bildmeister-Fall: "nur den Bildmischer in Regieplatz 1" =
`{workflowId: "regie-1", nodeId: "mixer", verb: "operate"}`).

Zwei getrennte Store-Methoden statt eines dritten `Check()`-Parameters
(`authz.Store.Check`/`CheckWorkflow`): die beiden Wirkungsbereiche
haben unterschiedliche Identitäts-Räume für "nodeID" (Instanz-ID vs.
Rollenname) — eine gemeinsame Methode hätte das Risiko geschaffen,
dass ein zufällig gleichlautender Rollenname mit einer Instanz-ID
kollidiert. `Check()` filtert deshalb explizit `workflow_id = ''`.

Neue `workflows.Service.FindRoleForNode(nodeID)`-Methode (Runtime-
Lookup über alle Workflows) verbindet eine konkrete, aktuell laufende
Node-ID mit ihrem (Workflow, Rolle)-Wirkungsbereich — genutzt an
**beiden** in §12.3e genannten Durchsetzungsstellen:

1. `httpapi.requireVerbOnNode` (PATCH params/POST methods, der
   generische Node-Proxy): erst die bestehende globale/Node-gescopte
   Prüfung (unverändert); schlägt die fehl, zusätzlich prüfen, ob der
   Ziel-Node gerade eine Rolle in einem Workflow erfüllt, für die
   subject eine passende `CheckWorkflow`-Bindung hat. `g.workflows`
   (neues `WorkflowRoleFinder`-Interface) darf `nil` sein
   (Rückwärtskompatibilität für bestehende Tests, die `authGate` ohne
   dieses Feld konstruieren) — dann entfällt die Zusatzprüfung
   ersatzlos.
2. `consoles.Resolve` (Operator-Console-Auflösung, `GET
   /api/v1/me/consoles`): löst pro Node jetzt die echte Workflow-ID/
   -Label auf (`FindRoleForNode`) statt immer `consoles.StubWorkflowID`
   zurückzugeben — der Stub bleibt nur noch der begründete
   Ausweichwert für Nodes, die zu keinem bekannten Workflow gehören
   (z. B. manuell über den Katalog gestartete Instanzen).

**Offene Frage 3 aus §12.5 (Start/Stop bei Workflow-`operate`) bewusst
nicht in dieser Sitzung entschieden:** Lifecycle-Endpunkte
(`POST .../start`/`.../stop`/`.../pause`) bleiben bei
`requireVerbGlobal(VerbAdmin)` — Workflow-`operate` erlaubt weiterhin
nur das Bedienen laufender Rollen, nicht das Hoch-/Runterfahren des
ganzen Regieplatzes. Echte, im Dokument selbst als "praxisnah gibt es
beide Betriebsmodelle" benannte Ermessensfrage, keine mit vertretbarem
Aufwand recherchierbare — für den Projektinhaber offengelassen statt
geraten.

**UI** (`ui/shell/admin-view.ts`): neuer Workflow-Select im
Bindungs-Formular ("(Global)" = unverändert, ein gewählter Workflow
schaltet das Node-ID-Feld von "Instanz-ID" auf "Rollenname" um, mit
einer aus `workflow.definition.roles` gespeisten Datalist). Tabellen-
Spalte "Node" → "Bereich" umbenannt, zeigt für Workflow-gescopte
Bindungen `"<Workflow> → <Rolle>"` bzw. `"<Workflow> (ganzer
Workflow)"`.

**Tests:** `authz/store_test.go` — 3 neue Tests gegen echtes Postgres
(`CheckWorkflow` Erfolg/Rollen-Isolation/Workflow-Isolation,
Wildcard-Deckung, sowie ein expliziter Test, dass `Check()` nie in den
Workflow-Scope hineinleckt). `httpapi/auth_middleware_test.go` — 4 neue
Tests (Workflow-Scope greift, wenn die globale Prüfung fehlschlägt;
403, wenn keiner der beiden Bereiche passt; `CheckWorkflow` wird gar
nicht erst aufgerufen, wenn der Node zu keinem Workflow gehört; `nil`
`workflows`-Feld führt zu keinem Panic). `consoles/resolve_test.go` —
5 neue Tests (Rollen-Isolation, Workflow-Isolation, Wildcard,
Stub-Fallback). `workflows/service_test.go` — 2 neue Tests für
`FindRoleForNode`. `go build`/`go vet`/`go test ./...` grün (inkl.
echter Postgres-Migrations-/Store-Tests). `deno check` grün.

**Live verifiziert, exakt das in §12.4 Teil 4 geforderte Szenario**
(echter Orchestrator, zwei echte laufende Workflows "Regieplatz 1"
[Rollen `mixer`/`audio`] und "Regieplatz 2" [Rolle `mixer`], Test-Nutzer
"bildmeister" mit `operate` auf Rolle `mixer` in Regieplatz 1):
- `PATCH .../nodes/<mixer-node-von-Regieplatz-1>/params/test` → 404
  (Node lehnt den unbekannten Parameter ab — **nicht** 403, die
  Autorisierung war also erfolgreich).
- `POST .../nodes/<mixer-node-von-Regieplatz-1>/methods/crosspoint.cut`
  → 200 (echte erfolgreiche autorisierte Aktion).
- `PATCH .../nodes/<audio-node-von-Regieplatz-1>/params/test` → 403
  (falsche Rolle, gleicher Workflow).
- `PATCH .../nodes/<mixer-node-von-Regieplatz-2>/params/test` → 403
  (gleicher Rollenname "mixer", aber anderer Workflow — beweist die
  Rollen-Isolation, nicht nur Node-Isolation).
UI-Pfad separat per CDP-Session: Bindung mit Workflow-Scope über das
Formular angelegt, Tabellenzeile zeigt korrekt "CDP Scope Test → mixer"
in der Bereich-Spalte. Alle Test-Nutzer/-Bindungen/-Workflows danach
entfernt.

**Nicht Teil dieser Sitzung:** Kapitel 12 Teil 5 (Operator-Einstieg:
Workflow-Auswahl nach Login + Mehr-Rollen-Konsolen-Ansicht) — nächster
empfohlener Schritt laut §12.4.

## 2026-07-18 (Nachtrag 22) — Kapitel 12 Teil 5: Operator-Einstieg
(Workflow-Auswahl nach Login)

**Kleinster Schritt der bisherigen Kapitel-12-Reihe** — die eigentliche
Rechte-Durchsetzung und die Mehr-Rollen-Tab-Leiste existierten schon
(`consoles.Resolve` seit Teil 4, `ConsoleView`s Tab-Mechanismus seit
C13); es fehlte nur die Gruppierung nach Workflow **vor** der
Konsolen-Ansicht, wenn ein Nutzer Rollen in mehreren Workflows bedienen
darf.

**§12.5 offene Frage 5 mit dem im Dokument vorgeschlagenen Verhalten
beantwortet** ("Kachel-Auswahl nach jedem Login (Vorschlag) oder
automatisch der zuletzt benutzte Workflow mit Umschalter?"): Kachel-
Auswahl bei jedem Einstieg, kein Persistieren einer zuletzt genutzten
Wahl — einfachste Variante, keine neue Client- oder Server-seitige
Zustandshaltung nötig.

**Umsetzung** (`ui/shell/shell.ts`, rein clientseitig — "Filterung ist
Komfort in der Shell, Durchsetzung bleibt beim Orchestrator" gilt
unverändert, `consoles` enthält ohnehin nur bereits autorisierte
Einträge aus Kapitel 12 Teil 4):

- Neue Route `WORKFLOW_CONSOLE_ROUTE` (`/console/<workflowId>`, ohne
  feste Rolle) neben der bestehenden Ein-Rollen-Kiosk-Route
  `/console/<workflowId>/<nodeRoleId>` — beide werden vom
  Orchestrator-seitigen `spaFallback` (unverändert, reiner
  Pfad-Präfix-Check `/console/`) bereits korrekt mit `index.html`
  bedient, keine Backend-Änderung nötig.
- `renderShell()`s bisheriger "operate-only, kein Kiosk"-Zweig gruppiert
  `consoles` jetzt nach `workflowId`: genau ein (oder gar kein)
  Workflow → direkt hinein wie bisher (kein unnötiger Auswahl-Umweg für
  den heute noch häufigsten Fall); mehrere Workflows → neue
  `renderWorkflowPicker()`-Kachel-Ansicht ("die schmale Vorstufe des
  §22.3-Katalog-Grids", wörtlich aus §12.3f); Klick auf eine Kachel ist
  eine normale `<a href="/console/<id>">`-Navigation (kein
  Client-Router nötig, echter Seitenwechsel + Re-Boot von `shell.ts`
  reicht).
- Punkte 1+2 aus §12.3f ("Gruppierte Sektionen", "Zwei Tab-Ebenen
  sauber trennen") sind laut Dokument selbst "kein neuer Scope-Punkt,
  keine offene Frage" — reine Präzisierung des bereits bestehenden
  `ConsoleView`-Tab-Mechanismus für künftige Bundle-Autoren, kein
  Code-Änderungsbedarf in dieser Sitzung.

**Tests:** keine neuen `deno test`-Unit-Tests (DOM-lastiger
Navigations-/Rendering-Code, gleiches Muster wie `flow-canvas.ts` —
Verifikation live per CDP, s. u.). `deno check`/`deno test ui/` grün
(unverändert, nichts an bestehender Logik angefasst).

**Live verifiziert per CDP-Session** (echter Orchestrator, zwei echte
laufende Workflows "Regieplatz A"/"Regieplatz B", Test-Nutzer
"regieop" mit `operate` auf die `mixer`-Rolle in beiden):
- Nach Login: Kachel-Auswahl "Regieplatz wählen" mit genau 2 Kacheln
  ("Regieplatz A · 1 Rolle", "Regieplatz B · 1 Rolle"), kein
  Engineering-App-Shell sichtbar.
- Klick auf "Regieplatz A" → echte Navigation zu
  `/console/<Regieplatz-A-ID>`, `<omp-console-view>` zeigt exakt eine
  Tab-Kachel ("Video Mixer M/E") — Regieplatz Bs Mixer taucht nicht
  auf (Workflow-Scope-Filterung korrekt).
- Regressionscheck: derselbe Nutzer mit nur noch einer verbliebenen
  Bindung (zweite testweise entfernt) landet beim nächsten Login direkt
  in der Konsolen-Ansicht, keine Kachel-Auswahl mehr sichtbar.
Alle Test-Nutzer/-Bindungen/-Workflows/-Layout-Einträge danach entfernt.

**Nicht Teil dieser Sitzung:** Kapitel 12 Teil 6 (Endausbau: Rollen-
Designer + Katalog-Kachel-Grid mit Thumbnail/Suche, deckungsgleich mit
§22.3) — laut §12.4 der letzte Teil der Kapitel-12-Reihe, explizit als
"Endausbau" eingestuft, kein dringender nächster Schritt.

## 2026-07-18 (Nachtrag 23) — Kapitel 12 Teil 6, Unterteil 1:
Katalog-Metadaten (Titel/Beschreibung/Tags/Kategorie) + Kachel-Grid

Teil 6 ("Endausbau, deckungsgleich mit §22.3") ist laut §22.3 selbst
mehrteilig (Punkte 1–9: Designer, Speichern/Laden, Start/Stop,
Metadaten-Felder, Thumbnail-Mechanik, Katalog-Kachel-Grid, Kategorie,
Suche/Filter, Scoping) — Punkte 2/3/9 sind bereits vollständig durch
bestehenden Code abgedeckt (PUT/GET/Lifecycle-Endpunkte, §12 Teil 4).
Dieser erste Unterteil deckt Punkte 4+6+7 ab (additive
Metadaten-Felder + einfaches Kachel-Grid); Punkt 5 (Thumbnail-Capture
über den MJPEG-Preview-Mechanismus), Punkt 8 (Volltextsuche/Facetten)
und Punkt 1 (echter Rollen-Designer als Graph-Editor-Variante) bleiben
eigene Folgeschritte — zu unterschiedlich in Aufwand/Risiko, um sie in
einem Schritt zu bündeln (Thumbnail braucht einen neuen
Ereignis-Listener + `bytea`-Spalte im Orchestrator, Suche eine eigene
UI-Komponente, der Designer denselben Graph-Editor-Code mit einer
zweiten Datenquelle).

**Design-Entscheidung — Metadaten leben in `Definition`, nicht in
einem neuen Objekt/einer neuen Service-Signatur:** `Title`,
`Description`, `Tags`, `Category` wurden als zusätzliche Felder auf
`workflows.Definition` ergänzt (orchestrator/internal/workflows/
types.go) statt als eigenes `Metadata`-Objekt mit geänderter
`Create()`/`Update()`-Signatur. Begründung: wie `Roles`/`Connections`
sind sie nutzerseitig gesetzt und nur per `Update()` änderbar (§22.3
Punkt 2 gilt bereits) — eine geänderte Funktionssignatur hätte alle
~40 bestehenden `svc.Create(name, def)`-Testaufrufe berühren müssen,
ohne einen Mehrwert zu bieten. Als Nebeneffekt wandern die Metadaten
jetzt automatisch durch `GET .../export`/`POST .../import` (Kapitel 12
Teil 3) mit, ohne das Export-Wire-Format anzufassen — live per API
verifiziert (Export eines Workflows mit gesetzten Metadaten liefert
sie unverändert im JSON zurück). `Category` erweitert den
§13.5-Node-Kategorien-Enum um `regieplatz` (§22.3 Punkt 7 wörtlich),
serverseitig bewusst nicht validiert (gleiche Robustheits-Haltung wie
§13.5: unbekannter/leerer Wert ist kein Fehler, nur ein Darstellungs-
Unterschied in der UI).

**Zusätzlich (kleiner Bonus, direkt aus dem neuen Feld ableitbar):**
`Service.FindRoleForNode` (Kapitel 12 Teil 4) liefert jetzt
`Definition.Title` statt `Name` als `workflowName`, sofern gesetzt —
die Operator-Konsolen-Auswahl (Kapitel 12 Teil 5, `renderWorkflowPicker`)
zeigt dadurch automatisch den Katalog-Titel statt des internen
Workflow-Namens, ohne dass `consoles.Resolve` oder `shell.ts`
angefasst werden mussten.

**Umsetzung UI (`ui/shell/workflows-view.ts`):** Anlegen-/Bearbeiten-
Formular um Titel-/Beschreibungs-/Tags-/Kategorie-Felder erweitert
(Tags als kommagetrennter Freitext, keine eigene Chip-UI für die
erwartete Größenordnung); `#editWorkflow()` befüllt sie beim
Bearbeiten vor. Die bisherige Zeilen-Liste (`#render()`) ist einem
CSS-Grid gewichen (`repeat(auto-fill,minmax(240px,1fr))`) — jede Kachel
zeigt jetzt Titel (Fallback: Name), Status-Badge, Kategorie-Badge
(Text statt Icon — kein Icon-Katalog vorhanden, gleiche Zurückhaltung
wie beim Thumbnail-Platzhalter in §22.3 Punkt 5), Beschreibung
(2-zeilig abgeschnitten), Tag-Pills, dieselben Rollen-/Auflösungs-/
Zeitplan-Zeilen und Aktions-Buttons wie zuvor (keine Funktions-
Regression, reines Layout-/Darstellungs-Update).

**Tests:** keine neuen `deno test`-Unit-Tests (reiner DOM-Rendering-
Code, gleiches Muster wie bei Kapitel 12 Teil 5 — Verifikation live per
CDP). `go build`/`go vet`/`go test ./...` (orchestrator) und
`deno check`/`deno test ui/` (40 bestanden, 0 fehlgeschlagen) beide
grün, keine bestehenden Tests mussten wegen der additiven Felder
angepasst werden.

**Live verifiziert:**
- Per CDP: Workflow über das Formular mit Titel „Regieplatz
  Katalog-Test", Beschreibung, zwei Tags und Kategorie „regieplatz"
  angelegt → die entstandene Kachel zeigt exakt diesen Titel (nicht
  den internen Namen „CDP Katalog Test"), das Kategorie-Badge
  „Regieplatz", beide Tag-Pills und die Beschreibung; Eltern-Container
  bestätigt per `getComputedStyle` als `display:grid`.
- Per API: ein Workflow mit allen vier Metadaten-Feldern angelegt,
  exportiert — `GET .../export` liefert `title`/`description`/`tags`/
  `category` unverändert im `definition`-Objekt zurück (Export-Mitnahme
  ohne Zusatzcode bestätigt).
Test-Workflows danach über die API gelöscht, `make stop` ausgeführt.

**Nicht Teil dieser Sitzung:** §22.3 Punkt 5 (Thumbnail-Capture),
Punkt 8 (Volltextsuche/Facetten) und Punkt 1 (Rollen-Designer als
eigene Graph-Editor-Datenquelle) — die noch offenen Unterteile von
Kapitel 12 Teil 6, s. o.

## 2026-07-18 (Nachtrag 24) — Kapitel 12 Teil 6, Unterteil 2:
Volltextsuche + Kategorie-/Status-Facetten im Workflow-Katalog

Deckt §22.3 Punkt 8 ab ("Volltext über title/description/tags[] ...
Postgres-Volltextsuche/ILIKE reicht für die erwartete Größenordnung
... plus Facetten"). Verbleibende Unterteile von Teil 6: Punkt 5
(Thumbnail-Capture) und Punkt 1 (Rollen-Designer).

**Design-Entscheidung — clientseitig statt neuem Backend-Such-
Endpunkt:** die Workflow-Liste wird bereits vollständig geladen (SSE-
getrieben, `#workflows` hält immer den kompletten Bestand, kein
Pagination-Konzept existiert für `GET /api/v1/workflows`) — ein
serverseitiger `ILIKE`-Query hätte für "Dutzende bis wenige Hunderte"
Workflows (§22.3 Punkt 8 wörtlich) einen neuen Query-Parameter, eine
neue Store-Methode und einen zweiten Filterpfad (Backend zusätzlich
zum ohnehin nötigen clientseitigen Re-Rendering) bedeutet, ohne einen
beobachtbaren Vorteil bei dieser Größenordnung. „Von mir zuletzt
bearbeitet" (in Punkt 8 als dritte Facette genannt) ist bewusst nicht
umgesetzt: dafür fehlt ein `updatedBy`/Autoren-Feld am Workflow-Objekt
komplett — kein bestehender Code liefert diese Information (anders als
bei Kategorie/Status, die bereits existieren) — dokumentierte
Folgearbeit, kein Bestandteil dieses Schritts.

**Umsetzung (`ui/shell/workflows-view.ts`):** `#matchesFilter(wf)`
prüft Kategorie-Facette, Status-Facette und einen Volltext-Substring
über Titel (Fallback: Name)/Beschreibung/Tags — alle drei Filter leer
= unverändertes Verhalten (kein Bruch für den bisherigen Anwendungsfall
ohne aktiven Filter). Die neue Filterleiste (`#renderFilterBar()`)
erscheint nur ab zwei oder mehr Workflows (bei einem einzelnen wäre sie
reiner Leerraum). Eine Besonderheit gegenüber dem sonstigen
Formular-Muster: das Sucheingabefeld löst bei jedem Tastendruck
(„input") bewusst **nicht** das volle `#render()` aus (das würde den
Fokus mitten im Tippen verlieren, gleiches Problem wie bei den
Rollennamen-Feldern im Anlege-Formular, dort mit „change" statt
„input" gelöst — hier geht das nicht, Live-Suche soll ja bei jedem
Zeichen filtern). Stattdessen aktualisiert `#refreshGrid()` gezielt nur
den Inhalt zweier mit `data-role` markierter, dauerhaft im DOM
vorhandener Container (`workflow-grid`, `workflow-filter-empty`) — die
Facetten-`<select>`-Elemente lösen dagegen weiterhin ein volles
`#render()` über „change" aus (kein Fokus-Problem bei Selects).

**Tests:** keine neuen `deno test`-Unit-Tests (reiner DOM-Rendering-/
Filter-Code, gleiches Muster wie die übrigen Kapitel-12-Teile —
Verifikation live per CDP). `deno check`/`deno test ui/` weiterhin grün
(40 bestanden, 0 fehlgeschlagen); `go build`/`go vet`/`go test ./...`
unverändert grün (dieser Schritt ist rein clientseitig, keine
Backend-Änderung).

**Live verifiziert per CDP** (drei echte Workflows über die API
angelegt: „Alpha Regie"/Kategorie `regieplatz`/Tag `news`, „Beta
Grafik"/Kategorie `graphics`/Tag `sport`, „Gamma Regie"/Kategorie
`regieplatz`/Tags `news,live`):
- Ausgangszustand: alle 3 Kacheln sichtbar.
- Textsuche „regie" → genau „Alpha Regie" + „Gamma Regie" (nicht „Beta
  Grafik" — Titel-Substring-Treffer).
- Textsuche „sport" → genau „Beta Grafik" (Tag-Substring-Treffer, nicht
  im Titel enthalten — bestätigt, dass Tags tatsächlich durchsucht
  werden).
- Kategorie-Facette „regieplatz" (Suchfeld zurückgesetzt) → genau
  „Alpha Regie" + „Gamma Regie".
- Sinnloser Suchbegriff → 0 Kacheln, Leer-Hinweis „Kein Workflow
  entspricht dem aktuellen Filter." sichtbar statt eines leeren Grids.
Alle drei Test-Workflows danach über die API gelöscht, `make stop`
ausgeführt.

**Nicht Teil dieser Sitzung:** §22.3 Punkt 5 (Thumbnail-Capture) und
Punkt 1 (Rollen-Designer als eigene Graph-Editor-Datenquelle) — die
verbleibenden Unterteile von Kapitel 12 Teil 6. Ebenfalls offen:
„von mir zuletzt bearbeitet"-Facette (fehlendes Autoren-Feld, s. o.).

## 2026-07-18 (Nachtrag 25) — Kapitel 12 Teil 6, Unterteil 3:
Thumbnail-Capture (§22.3 Punkt 5)

Letzter inhaltlicher Unterteil von Teil 6 vor dem eigentlichen
Rollen-Designer (§22.3 Punkt 1, weiterhin offen — der größte
verbleibende Brocken, eigene Graph-Editor-Datenquelle statt neuer
Persistenz/API).

**Migration 0007** (`ALTER TABLE workflows ADD COLUMN thumbnail
BYTEA`) — eigene Spalte statt Teil des JSONB-`data`-Blobs: ein
JPEG-Frame als Base64 im JSON hätte jeden `Put()`/`UpdateRuntime()`
unnötig aufgebläht (+33 %) und wäre in denselben Lifecycle-
Schreib-Wettlauf geraten, den `UpdateSchedules()`/`UpdateRuntime()`
(D7 Teil 2) gerade erst vermeiden gelernt haben — `Store.SetThumbnail`/
`GetThumbnail` sind bewusst eigene, schmale Methoden auf derselben
Zeile.

**previewUrl-Wiederverwendung wörtlich nach §22.3 Punkt 5:** neuer
`captureThumbnail()` (orchestrator/internal/workflows/thumbnail.go)
verbindet sich mit dem bestehenden MJPEG-Endpunkt eines Nodes
(`omp-mediaio::preview`, `previewUrl`-Parameter — dieselbe URL, die
`ui/graph/flow-canvas.ts` seit C6 für Node-Vorschaubilder im
Flow-Editor nutzt), liest per `mime/multipart` **ein** Teilbild und
schließt die Verbindung sofort wieder (kein Dauerabo). Klarstellung
gegenüber dem Dokumenttext: der Endpunkt liefert tatsächlich
`multipart/x-mixed-replace`, nicht "ohnehin einzelne JPEGs" — für den
Zweck (ein Standbild) macht das keinen Unterschied, nur die
Leseimplementierung ist entsprechend ein Multipart-Reader statt eines
rohen Bytes-Reads.

**Offene Design-Lücke im Dokument selbst gefüllt — "Program-Bus-Rolle"
existiert im Workflow-Objekt nicht:** §22.3 Punkt 5 setzt "die
Program-Bus-Rolle" voraus, §22.4 nennt genau das selbst als fehlende
Voraussetzung ("braucht eine echte Program-Bus-Rolle für sinnvolle
Thumbnails"). Es gibt aber keinen Rollentyp-Marker "das ist der
Ausgang" im `Role`-Typ. Pragmatischer Ersatz statt eines geratenen
neuen Schemafelds: `captureWorkflowThumbnail()` versucht die Rollen in
Definitionsreihenfolge und nimmt die erste, deren laufender Node
tatsächlich einen `previewUrl` liefert — kein neues Konzept, kein
Schema-Wachstum, funktioniert mit dem heute einzigen
previewUrl-fähigen Konsumenten-Node (`omp-viewer`, plus
`omp-multiviewer`).

**Auslöser: nach erfolgreichem Start, nicht bei "Speichern".** Das
Dokument nennt zwei Auslöser ("bei Speichern ... und optional
automatisch bei jedem start, sobald ... 'media-ready'"). "Bei
Speichern" wurde bewusst weggelassen: `Create()`/`Update()` laufen
immer an einem noch nicht gestarteten Workflow, ein Capture-Versuch
dort wäre in jedem Fall ein No-op (kein laufender Node in keiner
Rolle) — kein Mehrwert für zusätzlichen Code. Ein dediziertes
"media-ready"-Event existiert im System nicht; pragmatischer Ersatz:
`runStart()` startet `go s.captureWorkflowThumbnail(wf)` unmittelbar
nach erfolgreicher Verkabelung — der Preview-Broadcaster
(`omp-mediaio::preview::serve_client`) blockiert einen frisch
verbundenen Client ohnehin bis zum ersten tatsächlich publizierten
Frame, es gibt also kein Rennen gegen eine noch nicht produzierende
Pipeline, nur einen (mit `thumbnailCaptureTimeout` = 5 s begrenzten)
Wartepunkt. Eigene Goroutine, damit ein langsamer/hängender
Preview-Endpunkt `runStart()` selbst nicht verzögert.

**Neuer Endpunkt `GET /api/v1/workflows/{id}/thumbnail`** liefert das
rohe JPEG (kein JSON), 404 ohne Capture — hinter `requireAuth()` wie
der Rest der Workflow-API (Live-Vorschaubilder sind kein öffentlicher
Inhalt). Das bedeutet: ein einfaches `<img src="...">` kann nicht
authentifizieren (kein Authorization-Header bei einem `<img>`-Tag).
`ui/shell/workflows-view.ts` löst das identisch zu `#exportWorkflow()`
(bereits bestehendes Muster in derselben Datei): `apiFetch()` als
Blob, `URL.createObjectURL()`, `<img src>` auf die Object-URL — mit
Cache (`#thumbnailUrlById`, dieselbe Drei-Zustände-Logik wie
`ui/graph/flow-canvas.ts` `#previewUrlById`: kein Eintrag = ungeprüft,
`null` = geprüft/keins vorhanden, String = Object-URL) und Revoke
sowohl beim Verlassen des Tabs (`disconnectedCallback`) als auch beim
gezielten Invalidieren pro Workflow-ID, sobald `#poll()` einen frischen
Übergang in `"started"` sieht (dann hat `runStart()` ggf. gerade neu
erfasst).

**Nebenfund, nicht behoben (außerhalb des Scopes dieser Sitzung, aber
real und dokumentiert):** `findSender()`/`applyConnection()`
(orchestrator/internal/workflows/service.go) wählen ohne explizites
`fromSender`-Label `node.Senders[0]` — bei `omp-source` (registriert
sowohl einen Video- als auch einen Audio-Sender) ist diese Reihenfolge
**nicht deterministisch stabil** (live beobachtet: mal Video, mal
Audio zuerst). Betrifft sowohl die IS-05-Verkabelung
(`quelle → omp-viewer`) als auch Crosspoint-Ziele
(`quelle → omp-video-mixer-me`) gleichermaßen — die Crosspoint-
Discovery-Loops filtern zwar bereits korrekt auf `format==video`
(Fix von C11/C-Nachtrag, s. Nachtrag zu den zwei Discovery-Bugs weiter
oben in dieser Datei), aber `applyConnection()` wählt den (ggf.
falschen) Sender bereits **vor** diesem Filter. Bei der Live-
Verifikation dieses Schritts reproduzierbar aufgetreten
("`flow_def: frame_width fehlt`" bzw. Timeout beim Warten auf den
Sender im Crosspoint-`inputs`-Param) — umgangen durch manuelles
Verkabeln über `POST /api/v1/graph/edges` mit der live aus der
Registry gelesenen Sender-ID, um den eigentlichen Thumbnail-Pfad
isoliert zu testen. Korrekter Fix wäre, `findSender()` bei fehlendem
Label auf den ersten **video**-formatigen Sender einzuschränken
(analog dem bereits vorhandenen Discovery-Loop-Filter) — nicht in
dieser Sitzung behoben, da es kein Kapitel-12-Teil-6-Thema ist,
sondern das ältere, allgemeinere Connection-Template-Fundament aus
Kapitel 12 Teil 1 betrifft.

**Tests:** zwei neue Store-Regressions-Interface-Methoden
(`SetThumbnail`/`GetThumbnail`) auf `fakeStore` gespiegelt (gleiches
Muster wie bei D7 Teil 2); keine dedizierte Unit-Test-Datei für
`thumbnail.go` (reiner HTTP-/Multipart-Client-Code, echte
Verifikation ergibt nur gegen einen echten Preview-Endpunkt Sinn — s.
Live-Verifikation). `go build`/`go vet`/`go test ./...` grün (ein
`TestLauncherStopSendsSigkillIfSigtermIgnored`-Flake unter Last isoliert
reproduziert und als unabhängig vom `launcher`-Paket bestätigt, in
Einzelausführung grün). `deno check`/`deno test ui/` weiterhin grün
(40 bestanden, 0 fehlgeschlagen).

**Live verifiziert, echte Pipeline, kein Mock:** `omp-source` +
`omp-viewer` gestartet (Debug-Binaries, bereits gebaut), Verkabelung
wegen des oben beschriebenen Nebenfunds manuell per
`POST /api/v1/graph/edges` mit der live aus der NMOS-Registry gelesenen
Video-Sender-ID hergestellt (Python-Skript löste Instanz-IDs → Sender-/
Receiver-IDs innerhalb von ~0,3 s auf, drei Verbindungsversuche nötig,
bis die Connection-API des frisch gestarteten Viewer-Nodes bereit war).
Ergebnis: `GET /api/v1/workflows/{id}/thumbnail` lieferte nach ca. 2 s
ein echtes 640×360-JPEG (SOI/EOI-Marker geprüft, 21 KB) — bestätigt den
kompletten Pfad `runStart` → `captureWorkflowThumbnail` →
`captureThumbnail` (Multipart-Read) → `Store.SetThumbnail` →
HTTP-Endpunkt. Per CDP zusätzlich bestätigt: die Katalog-Kachel zeigt
das Bild als `<img>` mit `blob:`-Quelle (authentifizierter Fetch,
`naturalWidth=640`); ein nie gestarteter Workflow zeigt stattdessen den
Kategorie-Text-Platzhalter ("Video"), kein `<img>`-Element. Alle
Test-Workflows über die API gestoppt/gelöscht, verbliebene Node-
Prozesse manuell beendet (kein sauberer `make stop`-Durchlauf wegen der
Test-Choreografie mit mehreren manuellen Start/Stop-Zyklen),
Orchestrator beendet.

**Nicht Teil dieser Sitzung:** §22.3 Punkt 1 (Rollen-Designer) — der
letzte verbleibende Unterteil von Kapitel 12 Teil 6 und damit von ganz
Kapitel 12. Ebenfalls offen (dokumentierter Nebenfund, s. o.): die
nicht-deterministische `findSender()`-Fallback-Auswahl bei Nodes mit
mehreren Sendern unterschiedlichen Formats.

## 2026-07-18 (Nachtrag 26) — Kapitel 12 Teil 6, Unterteil 4 (letzter):
grafischer Rollen-Designer (§22.3 Punkt 1) — Kapitel 12 damit vollständig

Vor Beginn per `AskUserQuestion` nachgefragt, da dieser Schritt sich
qualitativ von den bisherigen Kapitel-12-Unterschritten unterscheidet
(neues, eigenständiges interaktives Subsystem statt einer additiven
Erweiterung, im Dokument selbst als "Endausbau" markiert): volle
grafische Variante gewählt (nicht die klick-basierte Zwischenstufe oder
"hier abschließen").

**Architektur-Entscheidung — eigenes zweites Custom Element statt
"Design-Modus"-Flag in `<omp-flow-canvas>`:** `flow-canvas.ts` trennt
laut eigenem Kopfkommentar bereits reine, DOM-freie Koordinaten-/
Kompatibilitäts-/Gruppenlogik (`geometry.ts`/`compatibility.ts`/
`groups.ts`, per `deno test` geprüft) von einem DOM-/Fetch-/
EventSource-bindenden Rest. §22.3 Punkt 1 verlangt "derselben
Zeichen-/Gruppierungs-Code (`ui/graph/*`)" — genau diese reine
Koordinatenlogik (Pan/Zoom, Kachel-/Port-Layout aus `geometry.ts`)
wird vom neuen `<omp-role-designer>` (`ui/graph/role-designer.ts`)
eins zu eins wiederverwendet. Ein zweiter Datenquellen-Pfad
(Live-Registry vs. Workflow-Definition) *innerhalb* derselben,
2400+-Zeilen-SSE-gekoppelten `flow-canvas.ts`-Klasse hätte ein
erheblich größeres Regressionsrisiko für die produktiv genutzte
Live-Ansicht bedeutet als der Nutzen einer einzigen gemeinsamen
Klasse — dokumentierte, bewusste Abweichung von einer wörtlichen
Lesart des Dokuments.

**Scope-Abgrenzung:** der Designer deckt Rollen + Rolle→Rolle-
Verbindungs-Template ab (die "Graph"-Substanz). Titel/Beschreibung/
Tags/Kategorie/Auflösung/Zeitpläne/Sicherheitsabfrage bleiben beim
bestehenden Text-Formular (`ui/shell/workflows-view.ts`, Kapitel 12
Teil 1/6) — derselbe Workflow lässt sich abwechselnd grafisch
(Topologie) und per Formular (Metadaten) bearbeiten, keine zweite
Formular-UI für bereits vollständig vorhandene Felder. Ebenfalls
bewusst vereinfacht: "aus dem Katalog ziehen" (§22.3 Punkt 1 wörtlich)
wurde als Klick-zum-Hinzufügen-dann-Ziehen-zum-Positionieren umgesetzt,
nicht als natives HTML5-Drag-and-Drop von einer Paletten-Liste auf die
Canvas — das Ergebnis (eine platzierte, frei verschiebbare
Rollen-Kachel) ist dasselbe, das Eingabemuster ein UX-Detail, kein
funktionales Muss. Positionen der Rollen-Kacheln werden bewusst nicht
serverseitig persistiert (gleiche Haltung wie beim Export/Import-Scope
aus Kapitel 12 Teil 3: reines UI-Layout, nicht Teil der
Definition) — ein neu geöffneter Designer positioniert per
`defaultPosition()`-Raster neu.

**Code-Struktur (neue Dateien, `ui/graph/`):**
- `roles.ts` (+`roles_test.ts`): `uniqueRoleName()`, aus `flow-canvas.ts`
  herausgelöst und dort durch einen Import ersetzt (Kapitel 12 Teil 2s
  "Gruppe als Workflow speichern" und der neue Designer nutzen jetzt
  exakt dieselbe Ableitungsregel statt einer Kopie).
- `role-designer-logic.ts` (+`role-designer-logic_test.ts`): reine
  Entwurfs-Logik (`removeRole`, `addConnection` — Selbstschleifen- und
  Duplikat-Ablehnung), DOM-frei. Eigene Datei, nicht Teil von
  `role-designer.ts` selbst: Letzteres definiert das Custom Element
  (`extends HTMLElement`) und ist damit unter `deno test` nicht
  importierbar (per Testlauf gefunden: "document is not defined" via
  eines transitiv mitgezogenen `ui/kit/omp-toast.ts`) — dasselbe
  Trennungsmuster, das `geometry.ts`/`compatibility.ts`/`groups.ts`
  bereits für `flow-canvas.ts` etabliert haben.
- `role-designer.ts`: das eigentliche `<omp-role-designer>`
  Custom Element — Pan/Zoom/Tile-Drag/Verbindungs-Drag als eigene,
  kleinere Kopie von `flow-canvas.ts`s Zustandsmaschine (kein
  "select"/Gruppen-Fall, dafür `fromRole` statt `fromPortId`) statt
  einer geteilten Basisklasse — bei nur zwei Nutzern dieser Logik wäre
  eine Abstraktion mehr Aufwand als Ersparnis gewesen.

**Wiring (`ui/shell/workflows-view.ts`):** neuer Button "Grafisch
entwerfen" (leerer Entwurf) neben "+ Neu", neuer Button "Grafisch
bearbeiten" pro Zeile (gleiche `isIdle`-Voraussetzung wie das
bestehende "Bearbeiten" — PUT nur in stopped/paused). Beide öffnen ein
Vollbild-Overlay (`position:fixed;inset:0`, gleiches Muster wie
`ui/shell/auth.ts#showLoginOverlay`) mit dem Designer; "Speichern"
ruft denselben `POST`/`PUT /api/v1/workflows`-Endpunkt wie das
Text-Formular — keine Backend-Änderung in diesem Schritt nötig.

**Live-Test-Fund, echter Bug — Rubber-Band-Linie blockierte den
eigenen Ziel-Port:** beim ersten Live-Verifikationslauf scheiterte
jede Verbindung lautlos (0 Kanten trotz korrektem Drag). Ursache: die
Vorschau-Linie während des Verbindungs-Drags (`#renderRubberBand`) hat
standardmäßig eine Hit-Test-Fläche entlang ihres Strichs; ihr Endpunkt
folgt exakt dem Mauszeiger, liegt beim Loslassen also *exakt* über dem
Ziel-Port — `document.elementFromPoint()` in `#finishConnect` trifft
dadurch die Linie statt den darunterliegenden Eingangs-Anker. Fix:
`pointer-events:none` auf der Vorschau-Linie. **Dieselbe, strukturell
identische Rubber-Band-Logik existierte unverändert seit B3 in
`flow-canvas.ts`s echtem Verbindungs-Drag** — dort denselben
Ein-Zeilen-Fix zurückübertragen (docs/decisions.md-Konvention: ein bei
Gelegenheit gefundener, trivial sicherer Bugfix wird nicht liegen
gelassen). Vermutlich in der Praxis selten beobachtet, weil ein Nutzer
selten die *exakte* Pixel-Mitte eines Ports als letzten Mausposition
vor dem Loslassen trifft — bei den in dieser Sitzung genutzten
CDP-Mausereignissen (`Input.dispatchMouseEvent`, präzise Koordinaten)
reproduzierbar bei praktisch jedem Versuch.

**Zweiter Fund (Test-Methodik, keine Code-Änderung nötig):**
JS-seitig per `element.dispatchEvent(new PointerEvent(...))`
synthetisierte Pointer-Events erzeugen keine für `setPointerCapture()`
gültige aktive Pointer-Sitzung ("NotFoundError: No active pointer") —
der Fehler wird von `addEventListener`-Handlern verschluckt (kein
Reject bei `dispatchEvent()`), der Drag-Start bricht dadurch still ab,
ohne dass der Testcode es bemerkt. Für Drag-Gesten braucht eine
CDP-Verifikation echte Eingaben über `Input.dispatchMouseEvent`
(mousePressed/mouseMoved/mouseReleased), nicht synthetische
Seiten-Events — Erkenntnis für künftige Interaktions-Tests dieser Art.

**Tests:** `role-designer-logic_test.ts` (7 Fälle: Rollen-Entfernung
inkl. Kanten-Aufräumen, Verbindung hinzufügen inkl. Selbstschleifen-/
Duplikat-Ablehnung) und `roles_test.ts` (3 Fälle) neu — beide grün.
`deno check`/`deno test ui/` gesamt: 50 bestanden, 0 fehlgeschlagen
(vorher 40). `go build`/`go vet`/`go test ./...` unverändert grün
(reiner Frontend-Schritt, keine Backend-Änderung).

**Live verifiziert per CDP** (echte Maus-Interaktion über
`Input.dispatchMouseEvent`, nicht nur Klicks): "Grafisch entwerfen"
geöffnet → Name gesetzt → zwei Rollen-Kacheln über die Werkzeugleiste
hinzugefügt → eine Kachel per echtem Drag verschoben (Position
`translate(40,40)` → `translate(100,80)` bestätigt) → Verbindung per
echtem Drag vom Output-Anker der einen zum Input-Anker der anderen
Kachel gezogen (1 Template-Kante im DOM bestätigt) → "Anlegen" →
Overlay schließt, Backend-Objekt per API geprüft: exakt 2 Rollen, 1
Verbindung in korrekter Richtung. Anschließend "Grafisch bearbeiten"
auf demselben Workflow geöffnet: Name/Rollen/Kante korrekt
vorbefüllt, per "Schließen" ohne Änderung verlassen. Separat: Rollen-
Kachel-Entfernen-Button geprüft (Kachel verschwindet aus dem DOM).
Test-Workflow über die API gelöscht, Chromium/Orchestrator beendet.

**Damit ist Kapitel 12 (docs/END-GOAL-FEATURES.md §12, alle Teile 1–6
inkl. aller Unterteile) vollständig umgesetzt.**

## 2026-07-18 (Nachtrag 27) — S6: Workflow-Auswahl in der App-Bar +
Flow-Editor-Filter (docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md)

Mit Kapitel 12 vollständig abgeschlossen war der letzte inhaltliche
Rest von S6 ("Workflow-Kontext in Shell + Rechte") noch offen: die
Review nennt drei Teilstücke — Konsolen-Route real (Kapitel 12 Teil 5,
bereits erledigt), Workflow-Scope im Rollenmodell (Kapitel 12 Teil 4,
bereits erledigt) und **Flow-Editor-Filter auf die Nodes des gewählten
Workflows, globale Sicht als "Alle" wählbar** — dieser dritte Teil war
bisher nicht gebaut (Kapitel 12 Teil 2 zeichnet Workflow-**Rahmen** um
alle gleichzeitig sichtbaren Workflows, filtert aber nicht auf einen
einzelnen). Mit diesem Schritt ist S6 vollständig; von der
Fable-Review-Zehnerliste (docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md)
bleiben nur noch S7 (Remote-Zugriff/Reverse-Proxy-Doku) und S8
(Metrics-Endpunkt) offen.

**Umsetzung:**
- `ui/shell/app-shell.ts`: neues `<select data-role="workflow-filter-
  select">` in der App-Bar (rechts, vor dem Verbindungs-Pill),
  befüllt aus `GET /api/v1/workflows` (Label: `definition.title ||
  name`, gleicher Fallback wie überall seit Kapitel 12 Teil 6),
  aktualisiert bei `workflow.updated`/`lost-events` (SSE, gleiches
  Muster wie `ui/shell/workflows-view.ts`). Die Auswahl selbst lebt in
  der App-Bar, nicht in `<omp-flow-canvas>` — die Kachel wird bei jedem
  Tab-Wechsel per `replaceChildren` neu erzeugt (`#switchTab`), eine
  dort gehaltene Auswahl ginge sonst bei jedem Verlassen des
  Flow-Editor-Tabs verloren. `#switchTab("flow")` wendet die zuletzt
  gewählte Filter-ID nach dem (Wieder-)Mounten erneut an.
- `ui/graph/flow-canvas.ts`: neue öffentliche Methode
  `setWorkflowFilter(workflowId: string | null)`. Bei aktivem Filter
  umgeht `#buildTilesAtScope()` den B5-Gruppenbaum komplett und zeigt
  ausschließlich die flachen Node-Kacheln der tatsächlichen
  Runtime-Instanzen des gewählten Workflows (`wf.runtime[...].nodeId`)
  — bewusst orthogonal zu `#scope` (Gruppen-Zoom bleibt B5s eigenes,
  workflow-unabhängiges Konzept, s. Abgrenzung in Kapitel 12 Teil 2).
  `#buildWorkflowFrames`/`#buildPausedPlaceholderTiles`/
  `#buildPausedPlaceholderEdges` laufen jetzt über eine neue
  `#workflowsInScope()`-Hilfsfunktion, die bei aktivem Filter nur den
  einen ausgewählten Workflow liefert — sonst blieben fremde
  Workflow-Rahmen/Pause-Platzhalter im gefilterten Bild sichtbar,
  obwohl die Node-Kacheln selbst schon gefiltert wären (widersprüchliches
  Bild sonst). `#pausedPlaceholderIds()` (Positions-Bookkeeping für
  `#assignMissingPositions`/`#pruneStalePositions`) bleibt bewusst
  ungefiltert — Positionszuweisung ist ein Persistenz-, kein
  Render-Zeit-Anliegen.

**Kleiner Begleit-Fund/-Fix:** `uniqueRoleName()` war bereits in
`flow-canvas.ts` privat definiert (Kapitel 12 Teil 2); für den
Rollen-Designer (Nachtrag 26) wurde sie in ein eigenes `roles.ts`
ausgelagert. Keine Wirkung auf diesen Schritt, nur zur Einordnung: kein
Duplikat mehr zwischen beiden Dateien.

**Tests:** keine neuen `deno test`-Unit-Tests (reiner DOM-/Fetch-Code,
gleiches Muster wie die übrigen App-Bar-/Canvas-Schritte). `deno
check`/`deno test ui/` weiterhin grün (50 bestanden). `go build`/`go
vet`/`go test ./...` unverändert grün (reiner Frontend-Schritt).

**Live verifiziert per CDP — exakt das von S6 verlangte
Zwei-Workflows-Szenario:** zwei echte, laufende Workflows angelegt
("Regie A" mit 2 `omp-source`-Rollen, "Regie B" mit 1) — bewusst ohne
Verbindungen, um den bereits dokumentierten, unabhängigen
`findSender()`-Nebenfund (Nachtrag 25) nicht erneut zu berühren.
Ungefiltert: alle Node-Kacheln beider Workflows sichtbar (plus die
registrierte NMOS-Registry selbst als vierter, workflow-loser Node —
korrekt in keinem Filter enthalten). Filter auf "Regie A": exakt deren
2 Kacheln, keine aus "Regie B". Filter auf "Regie B": exakt deren 1
Kachel, kein Überlapp mit "Regie A" geprüft. Zurück auf "Alle": wieder
alle Kacheln. Tab-Wechsel weg vom Flow-Editor und zurück: Filter-
Auswahl bleibt erhalten (App-Bar-State, nicht Kachel-State,
bestätigt). Workflows über die API gestoppt/gelöscht, Chromium/
Orchestrator beendet.

## 2026-07-18 (Nachtrag 28) — S7: Remote-Zugriff dokumentiert absichern
(TLS-Reverse-Proxy)

Reines Deployment/Doku-Thema (kein neuer Orchestrator-Code außer der
geprüften `X-Forwarded-*`-Frage, s. u.) — `deploy/dev/Caddyfile` +
`make proxy-up`/`proxy-down` + `docs/HANDBUCH.md` Abschnitt 6.

**`X-Forwarded-*`-Verträglichkeit geprüft statt geraten:** der
Orchestrator-Code wurde nach `r.Host`/`r.TLS`/`SetCookie`/CORS-Headern
durchsucht — keine Treffer außerhalb von Tests. Die gesamte Auth läuft
über ein selbsttragendes Bearer-Token (Header oder
`?access_token=`-Query-Param für `<img>`/`EventSource`), das
unabhängig von Schema/Host gültig bleibt — ein Reverse-Proxy davor
ändert am Verhalten nichts. Kein Code-Beitrag nötig (die Review selbst
nennt diesen Punkt "optional").

**Caddy statt nginx:** automatisches TLS (`tls internal` für lokale
Zertifikate, ein späterer Domain-Wechsel auf `example.org:8443`
bekäme automatisch echtes Let's-Encrypt-TLS ohne weitere Config) —
kein manueller `openssl`-Zertifikats-Schritt für den Dev-Fall, im
Gegensatz zu einer nginx-Variante. Als Podman-Container gestartet
(`make proxy-up`), gleiches Grundmuster wie `make up`/`make mtls-up` —
bewusst **nicht** Teil von `make up` selbst (Remote-Zugriff ist
opt-in, der normale lokale Workflow bleibt Klartext-http unverändert).
`--network=host`, damit der Container den bare-Prozess-Orchestrator
auf `127.0.0.1:8000` direkt erreicht, ohne einen Podman-Bridge-
Host-Gateway-Alias zu brauchen.

**Zwei echte Live-Fehlschläge beim ersten Versuch, kein reines
Copy-Paste-Rezept:**
1. Caddys automatisches HTTP→HTTPS-Redirect versucht **zusätzlich**
   Port 80 zu binden (auch wenn nur `:8443` im Caddyfile steht) —
   scheiterte im rootless-Podman-Container ohne
   `CAP_NET_BIND_SERVICE` mit "permission denied", der ganze
   Caddy-Prozess kam nicht hoch. Fix: globale Option `auto_https
   disable_redirects` (nur der Redirect-Listener entfällt, das
   automatische Zertifikat-Management für `:8443` bleibt aktiv).
2. Ein hostloser Site-Block (`:8443` ohne Domain) lässt Caddy nicht
   wissen, für welchen Hostnamen es ein `tls internal`-Zertifikat
   ausstellen soll — TLS-Handshakes scheiterten mit "TLS alert:
   internal error" (Curl: `SSL routines::tlsv1 alert internal error`).
   Fix: `localhost:8443` als expliziter Site-Host im Caddyfile (für
   echten Fernzugriff ohnehin durch die eigene Domain zu ersetzen, s.
   HANDBUCH.md).

**`flush_interval -1`** (kein Antwort-Puffern) im `reverse_proxy`-Block
— ohne das hätte SSE (`GET /api/v1/events`) im ungünstigsten Fall
spürbar verzögerte Updates gezeigt; live per Verbindungs-Pill
bestätigt, dass sie trotzdem sofort "Connected" zeigt (kein
Nachweis-Bedarf einer *ohne* das Flag verzögerten Variante, das Flag
folgt der Caddy-eigenen SSE-Empfehlung direkt).

**Tests:** kein neuer `deno test`/Go-Test (reines Deployment-Artefakt).
`go build`/`go vet` unverändert grün (kein Go-Code geändert).

**Live verifiziert, echter Caddy-Container vor dem echten
Orchestrator** — alle drei von S7 verlangten Pfade über
`https://localhost:8443` (selbstsigniertes Zertifikat,
`--ignore-certificate-errors` im Test-Chromium):
- **Login:** `POST /api/v1/auth/login` liefert ein gültiges Token
  (per `curl -k` bestätigt — Node.js' eigenes `fetch()` vertraut dem
  selbstsignierten Zertifikat nicht, anders als der über CDP
  gesteuerte, entsprechend konfigurierte Chromium; kein Widerspruch
  zur eigentlichen Verifikation, nur eine Werkzeug-Einschränkung des
  Testskripts selbst).
- **SSE:** die App-Bar-Verbindungs-Pill zeigt nach dem Laden über HTTPS
  "● Connected" — bestätigt, dass `EventSource`/SSE-Streaming durch
  den Proxy durchgereicht wird, nicht nur einzelne Requests.
- **Node-UI-Bundle:** ein echter `omp-viewer`-Node gestartet,
  `GET /api/v1/nodes/{id}/ui/bundle.js` über den Proxy abgerufen — `200
  text/javascript` (derselbe generische `handleNodeProxy`-Pfad wie im
  Klartext-Betrieb, zusätzlich getestet, weil er als einziger der drei
  Pfade einen ausgehenden Orchestrator→Node-Request beinhaltet, den
  reine API-Handler nicht haben).
Test-Node gestoppt, Caddy-Container/Orchestrator beendet.

**Von der Fable-Review-Zehnerliste bleibt nur noch S8** (Metrics-
Endpunkt + Soak-Grundlage) offen — dessen eigene Verifikation
("1-h-Soak lokal ohne monotonen Anstieg") sprengt den Rahmen einer
einzelnen Sitzung und wird als eigener Schritt behandelt.

## 2026-07-18 (Nachtrag 29) — S8: Metrics-Endpunkt + Soak-Grundlage

Letzter Punkt der Fable-Review-Zehnerliste (docs/REVIEW-2026-07-17-
SKALIERUNG-24-7.md). Bauen + Format-Verifikation + ein kurzer Smoke-Lauf
sind in dieser Sitzung erledigt; die eigentliche, im Review verlangte
**1-Stunden-Verifikation** ("ohne monotonen Anstieg") ist bewusst nicht
Teil dieser Sitzung — das würde eine einzelne Sitzung sprengen, s.
docs/HANDBUCH.md Abschnitt 7 für die dokumentierte Folgearbeit.

**Handgeschrieben, kein `prometheus/client_golang`**
(`orchestrator/internal/httpapi/metrics.go`) — konsequent zur
Minimal-Dependency-Regel, die S8 selbst zitiert: `writeMetric()`
schreibt `# HELP`/`# TYPE`/Sample-Zeilen direkt als Text, keine
Registry-Abstraktion. Bewusst `strconv.FormatFloat(value, 'f', -1, 64)`
statt Gos `%v`-Default für float64 — **live gefunden**: `%v` wechselt
ab einer gewissen Größenordnung (Heap-Bytes im niedrigen
Megabyte-Bereich) stillschweigend in wissenschaftliche Notation
(`8.02816e+06`), technisch gültiges Prometheus-Format, aber unnötig
schwer lesbar und ließ die eigene Formatprüfung im Test zunächst
fehlschlagen.

**Kennzahlen-Quellen — überall vorhandene Objekte erweitert statt
neuer Infrastruktur:**
- Go-Runtime: `runtime.NumGoroutine()`/`runtime.ReadMemStats()` direkt,
  keine Sammlung nötig.
- Registry: `registry.Store` bekam `SetPollDuration()`/`PollDuration()`
  (vom `Poller` nach jedem Poll gesetzt) — bewusst auf dem Store selbst
  statt auf `*Poller`, weil der Store (nicht der Poller) bereits als
  `NodeLister` in `httpapi.NewHandler` injiziert wird; ein zusätzlicher
  Konstruktor-Parameter nur für diesen einen Wert wäre unnötig gewesen.
  Nodes online/gesamt direkt aus `Store.List()` gezählt.
- SSE: `sse.Hub` bekam `ClientCount()` und einen neuen kumulativen
  `totalDrops`-Zähler (jeder fehlgeschlagene Zustellversuch, nicht nur
  der aktuelle Pro-Client-"dropped"-Zustand, der zurückgesetzt wird,
  sobald der Client wieder aufholt).
- Launcher: **bewusst kein** simpler Summen-Wert über die aktuell
  bekannten `Instance.RestartCount`-Felder für "Neustarts gesamt" —
  das sänke fälschlich, sobald eine Instanz gestoppt/entfernt wird
  (kein gültiger Prometheus-Counter mehr). Stattdessen ein neuer,
  eigener `Launcher.totalRestarts`-Zähler (atomic), einmal in
  `recordRestartLocked()` inkrementiert — dem einzigen Ort, durch den
  sowohl lokale (`supervise`) als auch Remote-Neustarts
  (`HandleRemoteExit`) laufen, also ein einziger, garantiert
  vollständiger Erfassungspunkt.
- HTTP: neuer `requestCounters` (atomic, nach Status-Klasse 2xx/3xx/
  4xx/5xx), gefüllt von einer neuen `countRequests`-Middleware, die den
  gesamten Mux umschließt (zählt auch 404s und von `authGate`
  abgelehnte Requests).

**Live-Regression gefunden und behoben — SSE brach unter der neuen
Zähl-Middleware:** `countRequests` wickelt jeden Request in den
bereits bestehenden `statusRecorder` (bisher nur von
`requireVerbOnNode`/`-Global` fürs Audit-Log genutzt, `GET
/api/v1/events` lief bisher nie durch einen solchen Wrapper). Ein per
Interface-Embedding eingebetteter `http.ResponseWriter` bringt dessen
zusätzliche Fähigkeiten (hier: `http.Flusher`) **nicht** automatisch
mit — Go promotet nur Methoden des statischen Feld-Typs
(`http.ResponseWriter` kennt nur Header/Write/WriteHeader). Der
bestehende Test `TestHandleEventsStreamsBroadcastEvents` schlug
prompt mit "streaming unsupported" fehl, bevor das je live getestet
wurde — genau der Fall, für den dieser Test ursprünglich geschrieben
wurde. Fix: `statusRecorder.Flush()` ergänzt, leitet an den
zugrundeliegenden Writer weiter, sofern der `http.Flusher`
unterstützt — behebt beide Nutzer des Wrappers einheitlich, kein
Sonderfall für die SSE-Route nötig.

**`make soak` / `deploy/dev/soak-omp.sh`:** kein `jq`/`python3` (S8
zitiert die Minimal-Dependency-Regel explizit, kein bestehendes
`deploy/dev/*.sh`-Skript verwendet eines von beiden für
JSON-Verarbeitung) — reines `grep`/`awk` sowohl für die schlanke
Login-/Instanz-Start-Antwort (`grep -o '"token":"[^"]*"' | cut -d'"'
-f4`) als auch für die Extraktion aus dem eigenen, bereits
handgeschriebenen `/metrics`-Textformat. Startet den Stack (falls
nötig) + 2 `omp-source`-Instanzen als Grundlast, schreibt alle
`SOAK_INTERVAL`-Sekunden (Default 60, S8 wörtlich) eine CSV-Zeile nach
`.run/soak/soak-<UTC-Zeitstempel>.csv`; `trap cleanup EXIT` räumt die
Test-Nodes auch bei Strg+C zuverlässig weg.

**Abbruchkriterium dokumentiert, nicht automatisiert** (§S8: "…
monoton steigend über N Stunden = Befund"): bewusst kein
Trend-Erkennungscode im Skript — eine robuste "monoton wachsend trotz
GC-Sägezahn-Rauschen"-Heuristik über wenige Messpunkte wäre selbst
fehleranfällig (falsch-positiv bei einem einzelnen ungünstig getakteten
Sample). Die Bewertung macht ein Mensch anhand der CSV, Kriterium in
docs/HANDBUCH.md Abschnitt 7 festgehalten.

**Tests:** neue `metrics_test.go` — `TestHandleMetricsWellFormed`
prüft sowohl die Prometheus-Text-Grundform (Regex je Zeile, jede
Sample-Zeile hat eine vorangehende HELP/TYPE-Zeile und umgekehrt) als
auch echte Werte einiger Kennzahlen gegen Test-Doubles mit bekannten
Eingaben (kein promtool auf dieser Maschine installiert, s. Review-Text
"sonst Formatprüfung im Test"). `TestCountRequestsRecordsStatusClass`
und `TestCountRequestsDoesNotBreakFlushing` (Regressionswächter für den
oben beschriebenen Fund) neu. Alle bestehenden `EventSubscriber`/
`NodeLister`/`LauncherService`-Test-Doubles (`fakeNodeLister`,
`fakeEventSubscriber`, `fakeEventPublisher`, `fakeLauncherService`) um
die neuen Interface-Methoden erweitert. `go build`/`go vet`/`go test
./...` grün.

**Live verifiziert, echter Orchestrator, kein Mock:**
- `curl /metrics` gegen den echten, laufenden Orchestrator: alle neun
  Kennzahlengruppen mit plausiblen Werten (u. a. `omp_registry_nodes 1`
  im Leerlauf — die NMOS-Registry selbst zählt als Node).
- `make soak 150 30` (kurzer Smoke-Lauf statt der vollen Stunde, s. o.):
  Stack lief bereits, 2 `omp-source`-Instanzen automatisch gestartet,
  5 CSV-Zeilen über 150s gesammelt, jede mit den erwarteten 17 Spalten
  — Goroutinen (23→36→36→34→34) und Heap
  (1,59 MB→2,16 MB→3,17 MB→1,80 MB→3,11 MB) zeigen das erwartete
  Sägezahnmuster (GC-Zyklen), kein monotoner Anstieg über den kurzen
  Beobachtungszeitraum. Test-Nodes automatisch aufgeräumt (`ps aux`
  bestätigt keine verbliebenen Prozesse), keine verbliebenen
  Instanzen laut `GET /api/v1/instances`.
- Ein während dieses Smoke-Laufs beobachteter, stetig wachsender
  `omp_http_requests_total{status="4xx"}`-Zähler (11→43→72→101→131 in
  150s) wurde **nicht abschließend geklärt** — mehrere gezielte
  Nachtests (Einzelinstanz-Start, `ss -tnp`-Verbindungsprüfung) deuten
  eher auf einen Artefakt der eigenen, sehr umfangreichen manuellen
  `curl`-Testtätigkeit dieser Sitzung auf demselben lang laufenden
  Orchestrator-Prozess hin als auf ein echtes Anwendungsproblem (kein
  einziger WARN/ERROR-Log-Eintrag im Orchestrator-Log während der
  gesamten Sitzung) — der Zähler selbst arbeitet nachweislich korrekt
  (s. Tests), die *Quelle* der 4xx-Antworten blieb aber ungeklärt.
  Dokumentierter Beobachtungspunkt für den echten 1-Stunden-Lauf: dort
  mit einem frisch gestarteten, sonst unberührten Orchestrator
  gegenprüfen, ob der Trend sich wiederholt.

**Nicht Teil dieser Sitzung:** die eigentliche 1-Stunden-Soak-
Verifikation selbst (s. o.) — Bau- und Format-Verifikation sind
abgeschlossen, der lange Beobachtungslauf ist dokumentierte
Folgearbeit. Mit diesem Schritt ist die komplette Fable-Review-
Zehnerliste (S1–S10) bearbeitet.

## 2026-07-18 (Nachtrag 30) — Kapitel 15 Teil 1, Rest: `OMP_WIDTH`/
`OMP_HEIGHT` auch in `omp-switcher`, `omp-player`, `omp-video-mixer-me`

**Ziel:** `docs/END-GOAL-FEATURES.md` §15.4 Teil 1 war am 2026-07-17
bewusst nur für `omp-source` abgeschlossen worden — der etablierte
Handgriff (env lesen → `Config`-Feld → `WIDTH`/`HEIGHT`-Konstante an
jeder Stelle durch den Konfigurationswert ersetzen) fehlte noch bei
den drei übrigen Video-Nodes. Alle drei nachgezogen, mechanisch nach
demselben Muster:

- `omp-switcher`: `Config::width/height`, `video_caps()` und
  `MxlVideoOutput::new` parametrisiert.
- `omp-player`: `Config::width/height`, `video_caps()` sowie beide
  Aufrufstellen (`TestPattern`-Zweig `build_video_branch`,
  `File`-Zweig `build_file_branches`); `ActivePipeline` trägt
  `width`/`height` selbst, damit `replace_slot()` (kein `Config`-
  Zugriff) sie kennt.
- `omp-video-mixer-me` (der laut §15.4 als „größer als ursprünglich
  eingeschätzt" markierte Fall): `KEYER_WIDTH`/`KEYER_HEIGHT` waren
  `const`, aus `WIDTH`/`HEIGHT` abgeleitet — mussten zu
  Laufzeitwerten werden (`(config.width / 3) as i32` in `build()`).
  `DveBox::full_frame()` (Vollbild-Default für die DVE-Box) hing
  ebenfalls an der festen Auflösung; jetzt `full_frame(width,
  height)`, mit `impl Default for DveBox` als expliziter Fallback auf
  `DEFAULT_WIDTH`/`DEFAULT_HEIGHT` für den einzigen Aufrufer ohne
  Config-Kontext. `main.rs`s eigener `DveBox`-State (Anzeige, bevor
  der erste `DveBoxChanged`-Event eintrifft) auf `full_frame(width,
  height)` umgestellt statt `Default::default()` — vermeidet eine
  sonst neu eingeführte kurze UI-Inkonsistenz zwischen Node-Default
  und tatsächlicher Workflow-Auflösung.

**Verifiziert (echte Prozesse, kein Mock):** `cargo build --workspace`
und `cargo clippy --workspace --all-targets` grün (keine neuen
Warnungen, nur vorbestehende in unberührten Dateien). Alle vier
betroffenen Nodes (`omp-source`, `omp-switcher`, `omp-player`,
`omp-video-mixer-me`) mit `OMP_WIDTH=800 OMP_HEIGHT=600` gegen einen
echten, per `make start` laufenden Orchestrator/Registry-Stack
gestartet: `GET /x-nmos/query/v1.3/flows` zeigt alle vier
Video-Flows mit `frame_width=800`/`frame_height=600` (PGM, TestSwitcher
Sender 1, TestPlayer Sender 1, TestSrc Sender 1). `mxl-info -f
<mixer-flow>` zeigt einen kontinuierlich wachsenden `Head index`
(PGM-Ausgang läuft trotz Laufzeit-Keyer-Geometrie). `GET
/params/dve.box` am Mixer liefert `{"width":800,"height":600,...}` —
bestätigt, dass sowohl der Pipeline-interne als auch der
`main.rs`-seitige Vollbild-Default die tatsächliche
Workflow-Auflösung tragen, nicht mehr die alte 640×480-Konstante.
Test-Instanzen danach beendet (`ps aux` bestätigt keine verbliebenen
Prozesse), Orchestrator gestoppt.

**Damit ist Kapitel 15 Teil 1 vollständig** (nur `omp-ograf` bleibt
bewusst ausgenommen, s. §15.4-Begründung: Template-Auflösung statt
generischer Testauflösung). Teil 2 (zweiter, echter Lowres-MXL-Sender
in `omp-mediaio::mxl`) ist die nächste offene Kapitel-15-Arbeit.

## 2026-07-19 (Nachtrag 31) — Kapitel 14 Teil 1: Host-Gesamt-Historie
(Sparkline + Min/Ø/Max)

**Ziel:** `docs/END-GOAL-FEATURES.md` §14.4 Teil 1 — kleinste
präsentationswirksame Scheibe von Kapitel 14 (Ressourcen-Historie):
der Orchestrator hielt bisher nur den zuletzt empfangenen
Host-Telemetrie-Wert (`hosts.Tracker`), keine Historie. Grundlage für
§17 Teil 2 (Ressourcen-Sicht im Katalog) und spätere D7-Teil-2-
Verfeinerung (Vorprüfung mit echten Profilen statt nur Momentwerten).

**Umsetzung** (Go-Backend + UI, ein Rechenweg, kein neues Framework):
- `orchestrator/internal/hosts/history.go`: neuer Typ `History` —
  zweistufiger Ringpuffer pro Host, genau wie in §14.3a entworfen:
  Roh-Samples (`rawCapacity` = 720 bei angenommenen 5s-Intervall ≈ 1h)
  plus abgeschlossene 1-Minuten-Aggregate (`aggregateCapacity` = 1440
  ≈ 24h, Min/Ø/Max pro Bucket). `Window(hostID, window)` liefert
  Rohpunkte für `window <= 1h`, sonst abgeschlossene Aggregate (der
  gerade offene Eimer ist bewusst nicht enthalten — noch nicht
  min/avg/max-stabil). Bewusst in-memory (§14.5 offene Frage 2,
  Empfehlung "für jetzt" übernommen) — Orchestrator-Neustart leert die
  Kurve, dokumentiertes Verhalten, keine Postgres-Persistenz in dieser
  Teilscheibe.
- `main.go`: `hostHistory := hosts.NewHistory()`, im selben
  NATS-Callback wie `hostMetricsTracker.Touch` befüllt (nach Touch()
  einmal `Get()` statt den Payload ein zweites Mal zu parsen).
- `GET /api/v1/hosts/{id}/metrics/history?window=<Go-Duration>` (neuer
  Handler + `HostHistoryReader`-Interface in `host_handlers.go`),
  nachsichtig wie `handleListAuditLog` (ungültiges/fehlendes `window`
  fällt auf 1h zurück, kein 400; unbekannte Host-ID liefert ein leeres
  Fenster statt 404 — der Aufrufer kennt gültige IDs bereits über
  `GET /api/v1/hosts`).
- `hosts-view.ts`: zwei neue Spalten ("Verlauf (1h)", "Min/Ø/Max CPU")
  — Sparkline als einzelnes Inline-SVG-`<path>` (keine feste
  0–100%-Skala-Normalisierung auf den beobachteten Min/Max, damit
  Zeilen verschiedener Hosts optisch vergleichbar bleiben; kein
  Chart-Framework, Minimal-Dependency-Regel). Ein `GET
  .../metrics/history?window=1h` pro Host und Poll-Zyklus (parallel via
  `Promise.all`, gleiches Muster wie der bestehende
  hosts+advice-Fetch) — bei der Ziel-Größenordnung "etliche Hosts"
  bewusst kein gebündelter Endpunkt, §14.3a spezifiziert ohnehin genau
  diese Pro-Host-Route.
- `NewHandler(...)` bekam einen zusätzlichen `hostHistory
  HostHistoryReader`-Parameter — alle 33 Testaufrufstellen in
  `server_test.go` mechanisch per `sed` um `fakeHostHistory{}`
  ergänzt (gleiches Muster wie der Parameter selbst: einfache
  Positions-DI, keine Builder-Refaktorierung).

**Verifiziert (echte Prozesse, kein Mock):** `go build ./...`, `go vet
./...`, `go test ./...` grün (neue Tests: `history_test.go` mit
eingespeisten Zeitstempeln für Bucket-Schluss/Trimmen/Clamping,
`host_handlers_test.go` für den neuen Handler); `deno check ui/**/*.ts`
+ `deno test ui/` grün; `cargo test --workspace` grün (mit
`deploy/dev/mxl.env` — die vier `omp-mediaio`-Testfehler bei einem
bloßen `make check` ohne gesourctes Env sind der bekannte
`LD_LIBRARY_PATH`-Umgebungs-Gotcha, keine Regression).

Live-Ende-zu-Ende gegen einen echten, per `make start` laufenden
Orchestrator: ein echter `omp-host-agent`-Prozess (Bootstrap-Token
direkt über `hosts.Store.CreateBootstrapToken` gemintet, temporäres
`orchestrator/cmd/devtool` — nicht Teil des Repos, nach Gebrauch
gelöscht) lief real gegen NATS/Registry. `GET
.../metrics/history?window=1h` zeigte nach ~45s sieben echte
Roh-Samples mit korrektem Min/Ø/Max; nach realem Warten über eine
volle Minute hinaus zeigte `?window=2h` genau einen abgeschlossenen
1-Minuten-Aggregat-Bucket (`resolution: "aggregate"`) mit demselben
Min/Ø/Max wie zuvor über die Rohdaten — Aggregat-Schluss-Logik damit
nicht nur unit-getestet, sondern auch mit echter Wanduhrzeit bestätigt.
UI per Node-CDP-WebSocket (`feedback_browser_verification_cdp_over_dump_dom`-
Muster) gegen einen echten headless Chromium verifiziert: Hosts-Tab
zeigt die neue Sparkline (SVG-`<path>` mit sichtbaren, plausiblen
Punkten) und die Min/Ø/Max-Spalte ("3 / 8 / 14%") für den echten
Host-Agent-Prozess. Alle Testartefakte danach entfernt: Prozesse
(host-agent, Chromium) gekillt, temporärer Test-Admin-Nutzer und
Test-Host aus Postgres gelöscht, `orchestrator/cmd/devtool` gelöscht,
Orchestrator gestoppt. Anmerkung: die im DB verbliebene, aus einer
früheren Sitzung stammende synthetische "admin"-Testzeile war bereits
vor dieser Sitzung ohne bekanntes Passwort verwaist — für den
Auth-Pfad dieses Tests entfernt und durch einen eigenen Test-Nutzer
ersetzt (ebenfalls aufgeräumt); die Postgres-Nutzertabelle ist jetzt
leer (Bootstrap-Modus), kein Datenverlust realer Nutzerdaten.

**Nicht Teil dieser Scheibe** (laut Phasenplan direkte Folgearbeit):
Teil 2 (Pro-Instanz-Telemetrie per `/proc/<pid>`), Teil 3
(Typ-Profile + Start-Warnung), Teil 4 (Anbindung an D7-Teil-2 und
§16-Kapazitäts-Zeitstrahl).

## 2026-07-19 (Nachtrag 32) — Kapitel 14 Teil 2: Pro-Instanz-Telemetrie
(CPU%/RSS per `/proc/<pid>`)

**Ziel:** `docs/END-GOAL-FEATURES.md` §14.4 Teil 2 — additive
Pro-Instanz-Messung neben der Host-Gesamt-Historie aus Teil 1: für jede
verwaltete Instanz CPU%/RSS aus `/proc/<pid>` messen und anzeigen.
Direkte Voraussetzung für §17 Teil 2 (Laufende-Instanzen-Tab), das laut
§17.3b explizit "Kapitel-14-Ressourcenwerte" **pro Instanz** braucht —
Teil 1 (nur Host-Gesamtwert) reicht dafür nicht, dieser Schritt liefert
die fehlende Auflösung.

**Umsetzung** (zwei unabhängige Messpfade, ein Anzeigeort):
- **Host-Agent** (`host-agent/internal/telemetry`): neuer
  `ProcessSampler` — misst utime+stime-Delta aus `/proc/<pid>/stat`
  (comm-Feld robust hinter der letzten `)` weiterparsen, USER_HZ=100 per
  `getconf CLK_TCK` auf der Dev-Maschine verifiziert, nicht geraten) und
  VmRSS aus `/proc/<pid>/status`. Bewusst **kein** blockierendes
  `time.Sleep` pro PID (anders als der Host-Gesamtwert in `Take()`) —
  nutzt stattdessen den ohnehin vorhandenen 5s-Telemetrie-Tick als
  Delta-Fenster; der erste Sample einer PID liefert deshalb noch kein
  CPU%, `Prune()` entfernt den Zustand einer nicht mehr laufenden PID
  (verhindert unbegrenztes Wachstum, verhindert ein falsches Delta bei
  PID-Wiederverwendung). `commands.Executor.Instances()` liefert die
  dafür nötige {InstanceID, PID}-Momentaufnahme. `Sample.Instances`
  (additiv, `omitempty`) hängt am bestehenden NATS-Metrik-Payload.
- **Orchestrator** (`orchestrator/internal/launcher`): identische
  `/proc`-Parsing-Logik noch einmal implementiert (`procstat.go`, gleiche
  bewusste kleine Duplikation zwischen den beiden eigenständigen
  Go-Modulen wie bei `buildEnv`/`tailBuffer`) — für lokal laufende
  Instanzen (`HostID==""`), da der Launcher hier selbst der "Agent" ist.
  `Launcher.Run(ctx)` (neuer 5s-Ticker, `go launcherSvc.Run(ctx)` in
  `main.go`, gleiches Muster wie `placement.Engine.Run`) ruft
  `sampleLocalResources()`. Wichtige Entscheidung: das Ergebnis landet
  **nicht** direkt in `l.instances[id]`, sondern in einer separaten
  `resourceSamples`-Map, die `List()` erst beim Lesen einmischt — sonst
  würde jeder `store.Put()` (Neustart, Stop) eine flüchtige
  Telemetrie-Momentaufnahme in Postgres einfrieren (`instances`-Tabelle
  ist für Wiederanlauf-Zustand gedacht, nicht für Zeitreihen).
  `Instance.CPUPercent`/`RSSBytes` sind `*float64`/`*uint64` (Pointer,
  nicht Wert) — ein echter 0%-Idle-Wert muss von "noch kein Sample"
  unterscheidbar bleiben, sonst zeigt die UI direkt nach dem Start
  fälschlich "0%" statt "noch unbekannt".
- **Entfernte Instanzen** bekommen ihren Wert nicht vom Launcher (der
  kennt das `hosts`-Paket bewusst nicht, keine neue Paketabhängigkeit
  nur für eine Anzeige-Ergänzung), sondern werden in
  `httpapi.handleListInstances` nachträglich mit der zuletzt vom
  Host-Agent gemeldeten `hosts.Metrics.Instances` gemischt
  (`mergeInstanceMetrics`) — der Handler kennt ohnehin schon beide
  Services (`LauncherService` und `HostMetricsReader`).
- **UI:** eine einzige Anzeigestelle statt zwei (§14.3b nennt
  "hosts-view-Detail **bzw.** Palette-Instanzzeile" als Alternativen,
  nicht als Pflicht-Duplikat) — `ui/graph/flow-canvas.ts`s
  Katalog-Palette (`#renderInstanceRow`) zeigt "CPU x% · RAM y MB" als
  zusätzliche Zeile, sobald `cpuPercent` vorhanden ist (lokale wie
  entfernte Instanzen landen im selben `GET /api/v1/instances`-Response,
  kein UI-Unterschied nötig). `hosts-view.ts` bewusst unangetastet
  gelassen — eine Instanz-Detailansicht pro Host ist inhaltlich Teil des
  in §17.4 separat geplanten "Laufende-Instanzen-Tab" (Teil 2 dort), kein
  Vorgriff hier.

**Verifiziert (echte Prozesse, kein Mock):** `go build`/`go vet`/`go
test` grün in beiden Go-Modulen (neue Tests: `ProcessSampler` gegen den
eigenen Testprozess inkl. Prune-Verhalten, `Executor.Instances()`-
Snapshot, `Launcher.sampleLocalResources()`/`List()`-Mischung inkl.
Prune-nach-Stop, `httpapi`-Merge-Test mit einer entfernten und einer
lokalen Instanz); `deno check`/`deno test` grün (neues
`cpuPercent`/`rssBytes`-Feld typgeprüft). Live-Ende-zu-Ende gegen einen
echten, per manuell gestartetem Binary laufenden
Orchestrator/Registry/NATS/Postgres-Stack (Katalog-Override auf einen
harmlosen `sleep 600`-Testeintrag, damit kein MXL/GStreamer-Aufbau
nötig ist): eine lokal gestartete Instanz zeigte nach zwei
5s-Sample-Ticks `cpuPercent:0, rssBytes:~1.9MB` in `GET
/api/v1/instances` (vorher, direkt nach dem Start, fehlten beide Felder
korrekt statt fälschlich 0 zu zeigen); ein echter, separat gestarteter
`omp-host-agent`-Prozess mit einer entfernten Instanz zeigte dieselben
Werte sowohl unter `GET /api/v1/hosts` (`metrics.instances[]`) als auch
gemischt unter `GET /api/v1/instances`. UI per Node-CDP-WebSocket
gegen einen echten headless Chromium bestätigt (`feedback_browser_verification_cdp_over_dump_dom`-Muster; `/json/new`
brauchte inzwischen `PUT` statt `GET`, neuere Chromium-Version) — beide
Palette-Zeilen (lokal und entfernt) zeigten "CPU 0% · RAM 2 MB". Alle
Testartefakte danach entfernt: Instanzen gestoppt, Host-Agent/
Chromium/Test-Orchestrator-Prozesse gekillt, Test-Host-Zeile aus
Postgres gelöscht, der bereits vorhandene dokumentierte `admin`-Nutzer
(HANDBUCH.md §3) unangetastet gelassen.

**Beiläufig beobachtet, nicht Teil dieser Änderung:** `cargo test
--workspace -p omp-mediaio` zeigte während der Verifikation einmal einen
SIGSEGV in den MXL-Tests (`three_concurrent_readers_same_flow_do_not_hang`
lief davor noch "ok"), auf einem Wiederholungslauf ohne jede Änderung
lief derselbe Test wieder grün durch — eine bereits vorbestehende
Flakiness im nativen MXL-Test-Binary, unabhängig von diesem Schritt
(keine Rust-Datei wurde in dieser Sitzung angefasst). Nicht
weiterverfolgt (außerhalb des Schritt-Scopes), aber hier vermerkt statt
stillschweigend übergangen.

**Nicht Teil dieser Scheibe:** Teil 3 (Typ-Profile in Postgres +
Start-Warn-Ampel) und Teil 4 (Anbindung an D7-Teil-2/§16) bleiben offen,
ebenso §17 Teil 2 selbst (der jetzt auf dieser Datengrundlage aufsetzen
kann).

## 2026-07-19 (Nachtrag 33) — §17 Teil 2: „Laufende Instanzen"-Tab

**Ziel:** `docs/END-GOAL-FEATURES.md` §17.3b/§17.4 Teil 2 — zentrale
Übersicht aller laufenden Node-Instanzen mit Status, Kapitel-14-
Ressourcenwerten (CPU%/RSS) und Crash-/Restart-Zähler. Laut Phasenplan
bewusst **keine neue Backend-Logik** ("baut direkt auf
Kapitel-14-Datenmodell") — reiner UI-Schritt, `GET /api/v1/instances`
liefert seit Kapitel 14 Teil 2 (Nachtrag 32, selbe Sitzung) bereits
alle nötigen Felder (`crashed`/`crashMessage`/`restartCount` seit
K7-Teil-1, `cpuPercent`/`rssBytes` seit Teil 2).

**Umsetzung:** neuer fünfter App-Bar-Tab „Instanzen"
(`ui/shell/instances-view.ts`, `<omp-instances-view>`) nach demselben
Baukasten wie `alarm-view.ts` (SSE-first, `apiFetch`, `escapeHtml`,
Custom-Element-Skeleton) — Tabelle mit Instanz/Typ, Status, Host
(hostId→Label-Auflösung wie `flow-canvas.ts#renderInstanceRow`), CPU,
RAM, PID, Neustarts. Zwei bewusste Abweichungen vom Alarm-View-Muster:
(a) Poll-Intervall 5s statt der sonst üblichen 30s-SSE-Fallback-Kadenz
— es gibt kein SSE-Event für "CPU%/RSS haben sich geändert" (die Werte
ändern sich mit jedem 5s-Sample-Tick, s. Nachtrag 32), eine als "live"
beworbene Ressourcenansicht muss deshalb selbst im Sample-Takt pollen;
SSE (`instance.crashed`/`instance.restarted`) deckt nur den
zusätzlichen Sofort-Refresh bei einem Status-Sprung ab. (b) explizite
Sortierung nach Label+ID im Client — `launcher.Launcher.List()`
iteriert eine Go-Map ohne Reihenfolge-Garantie, ohne eigene Sortierung
würden Zeilen bei jedem Poll scheinbar zufällig die Plätze tauschen.
`app-shell.ts`: `TabId`-Union + `BASE_TABS`-Eintrag ergänzt (mechanisch,
gleiche drei Stellen wie beim Alarm-View-Tab zuvor).

**Verifiziert (echte Prozesse, kein Mock):** `deno check`/`deno test`
grün, `make ui` bündelt das neue Modul (27 statt 26 Module). Live gegen
einen echten, per manuell gestartetem Binary laufenden Orchestrator
(gleicher `sleep 600`-Katalog-Override wie in Nachtrag 32, kein
MXL/GStreamer nötig): CDP-Browser-Check (Login → Tab-Klick auf
`[data-tab-id="instances"]` → gerenderte Tabelle) zeigte die echte
Instanz mit CPU/RAM/PID. Danach die Instanz per `kill -9` (nicht über
die Stop-API — ein echter unerwarteter Abbruch) beendet: der Launcher
startete sie automatisch neu (K7-Teil-1), die bereits offene Browser-
Session zeigte binnen des nächsten 5s-Polls ohne Reload die neue PID
und „↻ 1×" im Neustarts-Feld — bestätigt den vollen Kreis
Crash→Auto-Restart→SSE/Poll→UI-Update für eine bislang ungetestete
Kombination (frühere K7-Teil-1-Verifikation prüfte nur die
Palette-Zeile in `flow-canvas.ts`, nicht diesen neuen Tab). `make
check` grün (inkl. `cargo test --workspace`, kein Wiederauftreten der
in Nachtrag 32 vermerkten MXL-Test-Flakiness in diesem Lauf). Alle
Testartefakte danach entfernt: Instanz gestoppt, Chromium/Test-
Orchestrator-Prozesse gekillt, Postgres unverändert (nur der
dokumentierte `admin`-Nutzer, keine Test-Instanzen übrig).

**Nicht Teil dieser Scheibe:** §17 Teil 4/5 (Podman-Runner + Katalog-
Schreib-API für Import/Versionierung fremder Microservices) bleiben
bewusst zurückgestellt, wie in der Priorisierung (Kapitel 18)
festgehalten.

## 2026-07-19 (Nachtrag 34) — §7.6: stabile Konsolen-Rolle über einen
Prozess-Restart hinweg

**Ziel:** `docs/END-GOAL-FEATURES.md` §7.6-Nachtrag — der zweite,
bisher offen gebliebene Teil der Priorität #2 (K7-Teil-1 selbst war
bereits am 2026-07-17 erledigt). Lücke laut Doku: ein Operator mit
offener Kiosk-Konsole (`/console/<workflowId>/<nodeRoleId>`) verliert
nach einem Prozess-Restart (K7-Teil-1: gleiche Launcher-Instanz-ID,
aber neue NMOS-Node-ID) unbemerkt die Verbindung zum jetzt toten alten
Node — „das Operator-UI muss der Übernahme unmerklich folgen", tut es
aber bislang nicht.

**Root Cause (Code gelesen, nicht vermutet):** `consoles.NodeRoleID`
ist bereits korrekt die stabile Launcher-Instanz-ID
(`orchestrator/internal/consoles/resolve.go:98-103`), und
`GET /api/v1/me/consoles` löst bei jedem Aufruf frisch auf — das
Backend war nie das Problem. Der Bruch lag rein im Client:
`ui/shell/shell.ts`s `renderShell()` rief `fetchConsoles()` genau
einmal beim Seitenaufbau auf, danach nie wieder; `console-view.ts`s
`setEntries()` prüfte nur, ob die aktive `nodeRoleId` noch in der
(neuen) Liste vorkommt (`stillValid`) — nicht, ob sich deren
`uiBundleUrl` (trägt die aktuelle Node-ID) geändert hat. Nach einem
Restart blieb die Rolle also "gültig", die längst tote alte
`uiBundleUrl` aber unverändert gemountet.

**Umsetzung:**
- `ui/shell/console-logic.ts` (neu, reine Logik + `console-logic_test.ts`,
  6 Fälle): `pickActiveEntry(entries, activeNodeRoleId, previousUrl,
  preselectNodeRoleId)` — entscheidet, ob/welche Rolle (neu) aktiviert
  werden muss. Aus `console-view.ts#setEntries` herausgezogen, damit
  die eigentliche Entscheidung `deno test`-prüfbar ist (DOM/Netzwerk
  bleiben in der Komponente selbst, gleiches Trennungsmuster wie
  `ui/graph/groups.ts`).
- `console-view.ts#setEntries`: vergleicht jetzt `uiBundleUrl` der
  aktiven Rolle vor/nach dem Aufruf; bei Änderung remountet
  `#activate()` das Bundle. Kurzer „Lädt …"-Platzhalter während des
  `mountUIBundle()`-Awaits, statt einer leeren Fläche.
- `shell.ts`: neue `watchConsoleEntries()` — SSE-first
  (`node.added`/`node.removed`/`lost-events`, Registry-Poller feuert
  diese bereits) mit 30s-Poll-Fallback (gleiches Muster wie
  `hosts-view.ts`/`alarm-view.ts`), ruft bei jedem Trigger erneut
  `fetchConsoles()` + `view.setEntries(...)` auf. An allen drei
  Stellen verdrahtet, die eine `<omp-console-view>` mounten (Kiosk-
  Route mit festem `nodeRoleId`, Workflow-gescopte Route, "alle
  Konsolen"-Route) — jede mit ihrer eigenen `selectEntries`-
  Filterfunktion, damit ein Refresh dieselbe Teilmenge wie beim
  ursprünglichen Mount neu auflöst. Bewusst **kein** Wechsel des
  gesamten Ansicht-Modus bei einem Refresh (Engineering↔Console,
  Ein-↔Mehr-Workflow-Auswahl) — das behandelt §7.6 nicht, nur "dieselbe
  schon offene Rolle folgt einem Prozesswechsel".

**Verifiziert (echte Prozesse, kein Mock):** `deno check`/`deno test`
grün (56 Tests, davon 6 neu für `pickActiveEntry`), `make ui` bündelt
28 statt 27 Module. Live-Ende-zu-Ende gegen einen echten Orchestrator/
Registry/NATS/Postgres-Stack — bewusst mit `nodes/mock` (nicht dem
`sleep`-Platzhalter aus den vorigen zwei Sitzungen), weil ein echter
IS-04-Registrierungszyklus mit `-ui-bundle` gebraucht wird: Mock-
Instanz über den Launcher gestartet, Test-Operator-Nutzer + `operate`-
Rollenbindung auf die Instanz-ID angelegt, Kiosk-Route in einem echten
headless Chromium geöffnet (eingeloggt als Test-Operator) — Mocks
eigenes Beispiel-UI-Bundle mountete real (`node-id`-Attribut =
ursprüngliche NMOS-Node-ID, per CDP-Netzwerk-Trace bestätigt: echte
`ui/manifest.json` + `ui/bundle.js`-Requests). Dann den Mock-Prozess
per `kill -9` beendet (echter unerwarteter Abbruch, K7-Teil-1 startete
ihn automatisch mit derselben Instanz-ID, aber neuer NMOS-Node-ID neu —
per Registry-Query bestätigt). Ohne jede manuelle Aktion in der bereits
offenen Browser-Session: `node-id`-Attribut wechselte auf die neue
Node-ID, ein zweites Paar `ui/manifest.json`/`ui/bundle.js`-Requests
gegen die neue Node-ID lief auf, und `Page.getNavigationHistory` zeigte
weiterhin genau einen Navigationseintrag — der Wechsel geschah beweisbar
ohne Seiten-Reload, exakt das „unmerklich" aus der Nutzerfrage. Alle
Testartefakte danach entfernt: Instanz gestoppt, Test-Operator-Nutzer +
Rollenbindung gelöscht, Chromium/Mock/Test-Orchestrator-Prozesse
gekillt, Postgres unverändert (nur der dokumentierte `admin`-Nutzer
sowie bereits vorbestehende Bindungen aus früheren Sitzungen, keine
Testartefakte übrig).

**Damit ist §7.6 (Priorität #2 der Kapitel-18-Liste) vollständig** —
K7-Teil-1 (2026-07-17) plus diese Ergänzung. Nicht Teil dieser Scheibe:
ein zukünftiges echtes Hot-Standby-Failover (§7.3d, Teil 4, andere
Instanz-ID) bräuchte eine eigene Auflösung serverseitig
(Rollenbindung → aktuell aktive Instanz einer Redundanzgruppe) — dieser
Schritt deckt nur den bereits existierenden K7-Teil-1-Neustart-Fall
ab, wie in §7.6 selbst abgegrenzt.

## 2026-07-19 (Nachtrag 35) — §4.6 Nachtrag Punkt 3: Audio-Follow-
Video-Pegel

**Ziel:** `docs/END-GOAL-FEATURES.md` §4.6 Nachtrag Punkt 3 — Audio-
Follow-Video kannte bisher nur `mute`/`unmute` (`off`/`cut`/`crossfade`
schalteten ausschließlich den Mute-Zustand); kein definierbarer Pegel
für den „Aus"-Zustand (z. B. -20dB statt Vollstille, für einen
hörbaren, aber leisen Off-Air-Zustand). Priorität #4 der Kapitel-18-
Liste, nächster gut abgegrenzter Teilschritt nach §17/§7.6 (beide
diese Sitzung abgeschlossen) und vor dem größeren Kapitel 15 Teil 2.

**Design-Entscheidung, abweichend vom Doc-Wortlaut:** die Doku schlägt
`afv.offLevelDb` mit Default `-inf`/Mute vor. `serde_json` kann
`-inf`/`NaN` nicht als JSON-Zahl serialisieren (wird sonst
stillschweigend zu `null`) — statt eines nullbaren Sonderfalls zwei
immer JSON-taugliche Felder pro Kanal: `followUseMute: bool` (Default
`true`, unverändertes Verhalten) und `followOffLevelDb: f64` (Default
-20dB, nur wirksam wenn `followUseMute == false`). Klarer als ein
`-inf`-Sentinel, keine Sonderfallbehandlung an der JSON-Grenze nötig.

**Umsetzung** (`nodes/omp-audio-mixer/src/main.rs`, ~150 Zeilen,
`nodes/omp-audio-mixer/ui/bundle.js`):
- `ChannelState` um `follow_use_mute`/`follow_off_level_db` ergänzt,
  zwei neue readonly Deskriptor-Parameter (`followUseMute`,
  `followOffLevelDb`) und ein neuer Setter
  `channel.<id>.setFollowOffLevel(useMute, offLevelDb)` — bewusst
  eigene Methode statt `setFollow` um die zwei neuen Argumente
  erweitert, damit dessen bestehende 2-Argument-Signatur (targetNodeId,
  mode) unverändert bleibt.
- `audio_follow_video_loop`: bei `follow_use_mute == true` (Default)
  **byte-identisches** Verhalten wie vorher (echte Stille über
  `pipeline::set_mute`, sowohl in `cut` als auch `crossfade`). Bei
  `false`: `cut` setzt den Gain direkt auf `follow_off_level_db` bzw.
  den Basis-Pegel, `mute` bleibt durchgehend `false`; `crossfade` rampt
  zwischen `follow_off_level_db` und dem Basis-Pegel statt zwischen
  dem bisherigen hartkodierten `-60.0` und Mute — `mute` wird in dem
  Fall nie angefasst, die "Stille" entsteht rein über den Gain-Pegel.
- `ui/bundle.js`: neue Zeile im AFV-Abschnitt — "Stumm"-Checkbox
  (Default an) + Zahlenfeld (deaktiviert solange "Stumm" aktiv) +
  "Off-Pegel setzen"-Button, gleiches Poll-/Fokus-Guard-Muster wie die
  übrigen Felder (`shadow.activeElement`-Vergleich statt Überschreiben
  während der Eingabe).

**Verifiziert (echte Prozesse, kein Mock):** `cargo build`/`cargo
clippy --all-targets -p omp-audio-mixer` sauber (keine neuen
Warnungen), `node --check ui/bundle.js` syntaktisch gültig. Live gegen
einen echten, per `make start`-Äquivalent laufenden Orchestrator/
Registry/NATS-Stack: `omp-audio-mixer`-Instanz gestartet, ein Kanal
angelegt, `setFollow(target, "crossfade")` + `setFollowOffLevel(false,
-18)` gesetzt, dann ein **echtes** `nats pub omp.tally.<target>
'{"on":false}'` (kein synthetischer Test, derselbe NATS-Subject/Payload
wie `omp-video-mixer-me` ihn im echten Betrieb sendet) — der reale
`/levels`-SSE-Endpunkt (Master-Level, post-Mix) zeigte eine glatte
12-Schritt-Rampe von Peak 0.3 auf exakt 0.0378 (= 0.3 × 10^(-18/20),
rechnerisch exakt der konfigurierte -18dB-Zielpegel, nicht Stille);
`mute` blieb während der gesamten Rampe `false`. `cut`-Modus mit
gleichem Off-Pegel: sofortiger Sprung auf denselben exakten Wert, auch
hier `mute` durchgehend `false`. Rückprobe mit `followUseMute:true`:
exakt der alte Pfad, Peak fällt auf ~3×10⁻¹⁸ (praktisch Null,
Gleitkomma-Rauschen) und `mute` wird wieder `true` — bestätigt
Rückwärtskompatibilität bitgenau. UI-Bundle zusätzlich per echtem
Chromium-Klick verifiziert (Kachel im Flow-Editor angeklickt, echtes
`PointerEvent`-Down/Up-Paar — Selektion läuft über
`setPointerCapture`/einen globalen `pointerup`-Handler auf dem
`&lt;svg&gt;`, kein reines `click`-Event; Checkbox+Zahlenfeld+Button
real bedient): Backend zeigte exakt die per Klick gesetzten Werte
(`followUseMute:false`, `followOffLevelDb:-9`) — bestätigt den vollen
Kreis UI-Klick→Methode→Descriptor. Alle Testartefakte danach entfernt.

**Nicht Teil dieser Scheibe:** Mixer-Presets (§4.6 Punkt 4, Snapshot-
Mechanismus node-skopiert wiederverwenden) sind der nächste
unabhängige, kleine Kapitel-4.6-Rest laut Dokument.

## 2026-07-19 (Nachtrag 36) — Audio-Follow-Video: eigenständiger An-
Pegel + konfigurierbare Transition-Zeit

**Ziel:** Nutzer-Feedback direkt im Anschluss an Nachtrag 35: der
Off-Pegel allein reicht nicht — sowohl An- als auch Aus-Pegel sollen
einstellbar sein (nicht länger "An" = impliziter Kanal-Fader), dazu
eine konfigurierbare Transition-Zeit statt der festen 500ms.

**Design-Entscheidung:** `channel.<id>.setFollowOffLevel` (Nachtrag 35,
gleiche Sitzung, noch kein externer Verwender) direkt zu
`setFollowLevels(useMute, onLevelDb, offLevelDb, transitionMs)`
erweitert statt eine dritte Methode danebenzustellen — bei
`followUseMute == false` übernimmt AFV den Gain jetzt vollständig
eigenständig (der reguläre Kanal-Fader wird währenddessen ignoriert,
beide Pegel sind fest konfiguriert statt einer relativ zum Fader).
`followUseMute == true` bleibt bewusst bitgenau der alte Pfad (Rampe
zwischen Mute und dem aktuellen Fader, feste `FOLLOW_CROSSFADE_MS`) —
die drei neuen Felder sind in dem Fall wirkungslos, kein Rückschritt
für alle, die nur den einfachen Mute-Schalter wollen. Descriptor:
`followOnLevelDb` (Range wie `gain`: -60..12dB), `followTransitionMs`
(0..10000ms) neu, `followOffLevelDb` von 0..-60 auf -60..12 erweitert
(Konsistenz mit `followOnLevelDb`/`gain`).

**Umsetzung** (`nodes/omp-audio-mixer/src/main.rs`,
`nodes/omp-audio-mixer/ui/bundle.js`): `ChannelState` um
`follow_on_level_db`/`follow_transition_ms` ergänzt (Defaults 0dB/500ms
— 500ms deckungsgleich mit der bisherigen festen `FOLLOW_CROSSFADE_MS`,
damit ein frisch angelegter Kanal ohne AFV-Konfiguration exakt wie
vorher klingt, sobald `followUseMute` auf `false` gestellt wird).
`audio_follow_video_loop`: `cut` setzt bei `!follow_use_mute` jetzt
direkt auf `follow_on_level_db`/`follow_off_level_db` (statt vorher auf
den gelesenen `gain_db`); die Crossfade-Rampe im Tokio-Task rampt
zwischen denselben zwei Werten über `follow_transition_ms`/
`FOLLOW_CROSSFADE_STEPS`. UI: dritte Zeile im AFV-Abschnitt um ein
zweites Zahlenfeld ("An-Pegel dB") und ein drittes ("Transition ms")
erweitert, ein gemeinsamer "AFV-Pegel setzen"-Button für alle vier
Werte (mehr im Sinne "eine zusammengehörige Konfiguration" als vier
Einzel-Häkchen).

**Verifiziert (echte Prozesse, kein Mock):** `cargo build`/`cargo
clippy --all-targets -p omp-audio-mixer` sauber, `cargo clippy
--workspace --all-targets` zeigt nur bereits vorbestehende Warnungen in
unberührten Dateien (`omp-video-mixer-me`, `omp-ograf`). `node --check`
für `ui/bundle.js` grün. Live gegen einen echten `omp-audio-mixer`
(echter `nats pub omp.tally.<id>`, derselbe Subject/Payload wie im
Produktivbetrieb): `cut` mit `onLevelDb=-6`/`offLevelDb=-24` zeigte via
`/levels` einen sofortigen exakten Sprung auf `0.3×10^(-24/20) =
0.01893`; `crossfade` mit `transitionMs=1000` zeigte eine glatte
12-Schritt-Rampe **in beide Richtungen** (`0.01893→0.15036` bei „an",
`0.15036→0.01893` bei „aus", jeweils exakt `0.3×10^(±6..24/20)`),
`mute` blieb durchgehend `false`. Ein erster Testlauf zeigte
scheinbar keinerlei Gainänderung — Ursache war ein Timing-Fehler im
Testskript (die `/levels`-SSE-Verbindung stand beim allerersten
Verbindungsaufbau dieser Sitzung noch nicht rechtzeitig, bevor das
Tally-Event schon durchgelaufen war), kein Implementierungsfehler:
ein direkter `setGain`-Test parallel dazu bestätigte den
Pipeline-Pfad selbst als unauffällig, ein Wiederholungslauf mit
etwas Vorlauf zeigte die Rampe sauber. UI-Bundle-Steuerung aller drei
neuen Felder (An-Pegel/Off-Pegel/Transition) per echtem Chromium-Klick
verifiziert, Backend zeigte exakt die gesetzten Werte. Alle
Testartefakte danach entfernt.

## 2026-07-19 (Nachtrag 37) — Kapitel 15 Teil 2: zweiter,
referenzgezählter Lowres-MXL-Sender in `omp-source`

**Ziel:** `docs/END-GOAL-FEATURES.md` §15.4 Teil 2 — ein zweiter, echter
MXL-Video-Sender in fester Lowres-Auflösung, als IS-04-Flow der
Highres-Quelle zugeordnet, statt des heutigen Transcode-on-Demand-
MJPEG-Pfads. Zwei offene Fragen (§15.5) vom Nutzer vorab entschieden:
(1) feste Lowres-Auflösung statt pro Workflow konfigurierbar (Vorschlag
übernommen), (2) Lowres-Sender **nur bei aktivem Vorschau-Bedarf
zugeschaltet** statt immer mitlaufend (Nutzer wählte die aufwendigere,
nicht die empfohlene Option — Referenzzählung nötig, s. u.).

**Recherche vor der Umsetzung** (Work-Rule §0 Punkt 9, IS-04-Spec-
Detail nicht geraten): `urn:x-nmos:tag:grouphint/v1.0` gegen die echte
AMWA-NMOS-Parameter-Registry verifiziert
(`nmos-parameter-registers/tags/grouphint.md`) — Format
`"<group-name>:<role-in-group>[:<group-scope>]"`, laut Spec-Text
("Natural groups applies only to NMOS senders and receivers") ein
**Sender/Receiver**-Tag, **nicht** Flow/Source, obwohl §15.3b/§15.4 des
eigenen Dokuments "IS-04-Flow-Discovery"/"Grouphint-Tag" ohne
Ressourcentyp-Angabe formulieren — hier die Spec befolgt, nicht die
ungenaue Doku-Formulierung, beide betroffenen Sender (Highres +
Lowres) tragen das Tag mit derselben Gruppen-ID (Highres-Flow-UUID)
und den Rollen `high`/`low`.

**Architektur-Erkenntnis, die die Umsetzung geprägt hat:** IS-04-
Ressourcen (Sender+Flow+Source) werden in `omp-node-sdk::node::start()`
einmalig beim Node-Start aus `NodeConfig.senders` gebaut — es gibt
keine SDK-API, Sender/Flows nachträglich zur Laufzeit zu (de-)
registrieren (kein `DELETE`-Aufruf existiert überhaupt im
`RegistryClient`). „Nur bei Bedarf zugeschaltet" kann sich deshalb
nur auf das tatsächliche **Schreiben von MXL-Grains** beziehen, nicht
auf die IS-04-Sichtbarkeit selbst — der Lowres-Sender ist ab Node-Start
immer discoverbar, aber inaktiv. Das trifft sich mit einem bereits
vorhandenen Mechanismus: `MxlVideoOutput`s `valve`-Element startet
bereits mit `drop=true` (inaktiv) per Konstruktor-Default (unabhängig
von diesem Schritt schon so), `Output::set_active`/`is_active` schalten
ihn um (`valve.drop = !active`) — exakt der Aktivierungs-Hebel, der
gebraucht wurde, ohne dass `MxlVideoOutput` selbst geändert werden
musste.

**Umsetzung:**
- `omp-node-sdk/src/node.rs`: `SenderSpec` bekommt ein additives
  `tags: HashMap<String, Vec<String>>`-Feld (Default leer, kein
  Verhaltensunterschied für bestehende Aufrufer), in `start()`s
  Sender-Aufbau nach `is04::Sender::tags` durchgereicht (das Feld
  existierte auf `Sender` selbst bereits, nur `SenderSpec` konnte es
  bisher nicht setzen).
- `nodes/omp-mediaio` unverändert — `MxlVideoOutput` unterstützte
  Mehrfachinstanzen pro Pipeline bereits (Präzedenzfall: `omp-ograf`s
  Fill+Key), kein Singleton-Problem.
- `nodes/omp-source/src/pipeline.rs`: dritter `tee`-Zweig
  (`video_tee → lowres_queue → MxlVideoOutput(320×180)`, `videoscale`/
  `videorate`/`capsfilter` baut `MxlVideoOutput::new` selbst intern
  auf, kein eigener Downscale-Code nötig) — bewusst **nicht**
  `set_active(true)` nach dem Bau, bleibt im Valve-Default (inaktiv).
  `PipelineHandle` bekommt `activate_lowres_preview()`/
  `release_lowres_preview()` (Referenzzählung über `AtomicUsize`,
  `fetch_add`/`fetch_update` mit `saturating_sub`, kein Unterlauf bei
  unbalanciertem Extra-`release`) + `lowres_preview_active()`.
- `nodes/omp-source/src/main.rs`: zweiter `SenderSpec` (Lowres-Flow,
  320×180, `label: "<Label> Lowres"`), beide Video-Sender bekommen das
  `grouphint`-Tag-Paar. Neue readonly Deskriptor-Parameter
  `lowresFlowId`/`lowresActive`, neue Methoden
  `activateLowresPreview`/`releaseLowresPreview` (keine Argumente) —
  erster Methoden-Eintrag überhaupt für `omp-source` (`methods: vec![]`
  vorher).

**Verifiziert (echte Prozesse, kein Mock):** `cargo build`/`cargo
clippy --all-targets` sauber für `omp-node-sdk`/`omp-source`,
`cargo build --workspace` bestätigt: die additive `SenderSpec.tags`
bricht keinen der neun anderen Node-Typen (`..Default::default()`
überall unverändert gültig). Live gegen einen echten, per `make
start`-Äquivalent laufenden Orchestrator/Registry/NATS-Stack: `GET
/x-nmos/query/v1.3/senders` zeigte drei Sender (Highres/Lowres-Video +
Audio), Highres- und Lowres-Sender mit exakt demselben
Gruppen-Präfix (`<flow-id>:high`/`<flow-id>:low`); `mxl-info -l`
zeigte zwei eigenständige Video-Flows. `mxl-info -f <lowres-flow>`
zeigte `Head index: 0`, über 2s Wartezeit unverändert (kein einziges
Grain geschrieben) — der Highres-Flow-Index wuchs im selben Zeitraum
sichtbar weiter, keine Kopplung. Nach `POST .../methods/
activateLowresPreview`: `lowresActive` wechselte auf `true`, der
Lowres-Flow-Index begann sofort zu wachsen. Referenzzählung bestätigt:
zweimal aktiviert, einmal freigegeben → weiterhin aktiv (Index wuchs
weiter); zweites `release` → sofort inaktiv, Index blieb über 1,5s
exakt stehen; ein zusätzlicher, unbalancierter `release`-Aufruf blieb
folgenlos (kein Unterlauf, `lowresActive` weiterhin `false`). Der
Highres-Flow lief währenddessen ununterbrochen weiter (25fps
durchgehend im Log). Alle Testartefakte danach entfernt (Instanz
gestoppt, Orchestrator-Prozess gekillt, `/dev/shm/omp-mxl` geleert —
tmpfs, dokumentiert flüchtig).

**Nicht Teil dieser Scheibe:** Teil 3 (Bildmischer/Multiviewer lesen
bevorzugt lowres — die eigentlichen Konsumenten der hier gebauten
Infrastruktur) und Teil 4 (`omp-ograf`/`omp-player` als weitere
Lowres-Quellen, analoger Handgriff) bleiben offen, wie im Phasenplan
vorgesehen.

## 2026-07-19 (Nachtrag 38) — Kapitel 15 Teil 3: `omp-multiviewer` liest
bevorzugt lowres

**Ziel:** `docs/END-GOAL-FEATURES.md` §15.4 Teil 3 — die eigentliche
Nutzlast der in Teil 2 gebauten Infrastruktur: Vorschau-Kacheln öffnen
bevorzugt den Lowres-MXL-Flow einer Quelle statt Highres+Downscale.
`omp-multiviewer` als Pilot-Node gewählt (nicht `omp-video-mixer-me`/
`omp-switcher`) — kein PGM-/Preview-Unterschied nötig, jede Kachel ist
reines Monitoring, kein dynamisches Hoch-/Runterschalten je nach
Crosspoint-Auswahl wie beim Mischer.

**Architektur-Entscheidung mit größter Tragweite:** referenzgezählte
Aktivierung (Kapitel 15 Teil 2) bedeutet, `omp-multiviewer` muss vor
dem Lesen `activateLowresPreview` **auf dem jeweiligen Quell-Node
selbst** aufrufen — ein Node-zu-Node-HTTP-Aufruf, kein Umweg über den
Orchestrator. Recherche vor der Umsetzung fand echten Präzedenzfall:
`omp-playout-automation/src/remote.rs::PeerClient` (C14/C15) macht
exakt das bereits, mit explizit dokumentierter Begründung
(„kein neuer Mechanismus, nur ein zweiter Client für dieselbe, längst
bestehende API", `ARCHITECTURE.md` §13.1/§13.2/§13.3). Diesen zweiten
Verwender zum Anlass genommen, den Client (`PeerClient::invoke`) plus
eine neue Sender→Device→Node-Auflösung (`resolve_owning_node_href`,
nutzt den neuen `RegistryClient::get_node`, symmetrisch zu
`get_sender`/`get_device`) nach `omp-node-sdk` zu heben (bereits
`ureq`-Abhängigkeit vorhanden, keine neue Abhängigkeit in
`omp-multiviewer`, Minimal-Dependency-Regel) — `omp-playout-
automation`s eigene Kopie bewusst **nicht** angefasst (kein
Regressionsrisiko für einen in dieser Sitzung sonst unberührten,
bereits ausgelieferten Node; die kleine Duplikation bleibt vorerst
bestehen, spätere Aufräumarbeit).

**Umsetzung:**
- `omp-node-sdk`: `RegistryClient::get_node(id)` (neu, mirror von
  `get_sender`/`get_device`), neues Modul `peer.rs`
  (`PeerClient::invoke`, `resolve_owning_node_href`), beide öffentlich
  re-exportiert.
- `nodes/omp-multiviewer/src/pipeline.rs`: `DiscoveredInput` bekommt
  `lowres_sender_id`/`lowres_flow_id` (`Option<String>`, `None` =
  Rückfall auf Highres+Downscale, unverändertes Verhalten). `build()`
  öffnet `MxlVideoInput` auf `lowres_flow_id.unwrap_or(flow_id)` — kein
  weiterer Anpassungsbedarf, `MxlVideoInput` liest die tatsächliche
  Flow-Auflösung ohnehin zur Laufzeit aus dem MXL-Flow-Def (nicht vom
  Konstruktor vorgegeben), jede Kachel skaliert schon heute auf
  `TILE_WIDTH`×`TILE_HEIGHT` herunter.
- `nodes/omp-multiviewer/src/main.rs`: `discovery_loop` baut aus dem
  ohnehin schon geholten vollen Sender-Satz (`list_senders()`, kein
  zusätzlicher Registry-Umlauf) eine `group-name → (Lowres-Sender-ID,
  Lowres-Flow-ID)`-Map aus `urn:x-nmos:tag:grouphint/v1.0`-Tags
  (Format-Parsing wie Nachtrag 37, Sender mit Rolle `low` bekommen
  keine eigene Kachel). Pro Poll: Diff der gewünschten gegen die
  zuletzt aktivierten Lowres-Sender-IDs (`activated_lowres`-State über
  Polls hinweg) — verschwundene werden freigegeben
  (`releaseLowresPreview`), neue aktiviert (`activateLowresPreview`
  nach `resolve_owning_node_href`). Schlägt Auflösung/Aktivierung fehl,
  wird `lowres_*` für genau diese Kachel wieder auf `None` gesetzt
  (Rückfall auf Highres statt einer dauerhaft schwarzen Kachel).
  **Dokumentierte Lücke:** kein Graceful-Release beim Multiviewer-
  Shutdown (der `tokio::select!` in `main.rs` lässt `discovery_loop`
  beim Beenden fallen, kein Cleanup-Pfad) — der Quell-Node bleibt in
  dem Fall bis zu seinem eigenen Neustart aktiviert. Bewusst nicht
  gelöst (kleinerer, klar abgegrenzter nächster Schritt, falls
  relevant), kein stiller Gap.

**Verifiziert (echte Prozesse, kein Mock):** `cargo build`/`cargo
clippy --all-targets` sauber für `omp-node-sdk`/`omp-multiviewer`
(einzige verbleibende Clippy-Warnung war bereits vorher in
unberührtem `omp-mediaio`-Code vorhanden), `cargo build --workspace`
grün. Live gegen einen echten Orchestrator/Registry/NATS-Stack: echte
`omp-source`- + `omp-multiviewer`-Instanzen gestartet — `GET
/x-nmos/query/v1.3/nodes` lieferte den `href` beider Nodes, der
Multiviewer aktivierte den Lowres-Sender der Quelle nachweislich über
einen echten HTTP-Aufruf an **genau diesen** `href` (`lowresActive`
wechselte auf `true`, ohne dass irgendein Test-Skript die Quelle
direkt ansprach). `mxl-info -f <lowres-flow>` zeigte "Last read time"
im Millisekunden-Abstand zur "Last write time" (aktiv gelesen), der
Highres-Flow blieb mit einem ~29s alten "Last read time" unberührt —
der Multiviewer liest nachweislich lowres, nicht highres. Der reale
MJPEG-Vorschau-Stream (`GET .../preview`) lieferte echte, valide
JPEG-Frames (11 Frames in 2s, ~5fps wie konfiguriert) — ein
extrahiertes Frame zeigte visuell die korrekten SMPTE-Farbbalken samt
Sender-Label-Overlay, kein Schwarzbild/Artefakt. Entfernungspfad
geprüft: Quelle per `DELETE /api/v1/instances/<id>` gestoppt, Prozess
bestätigt tot (`ps aux`) — die Registry-Einträge blieben erwartungs-
gemäß bis zum `registration_expiry_interval` (60s, `deploy/nmos/
registry.json`, per Datei nachgeschlagen statt aus einer alten
12s-Erinnerung geraten) bestehen — bekanntes, vorbestehendes
Registry-Geist-Verhalten dieses Systems, keine Regression durch diesen
Schritt. Alle Testartefakte danach entfernt.

**Damit ist Kapitel 15 bis auf Teil 4** (`omp-ograf`/`omp-player` als
weitere Lowres-Quellen, analoger Handgriff wie Teil 2 in `omp-source`)
**und die Übertragung von Teil 3 auf `omp-video-mixer-me`/
`omp-switcher`** (PGM-Pfad bleibt highres, nur Vorschau/Crosspoint-
Buttons lowres — komplexer als der hier gebaute reine Monitor-Fall)
vollständig.

## 2026-07-19 (Nachtrag 39) — Kapitel 15 Teil 4 (teilweise): Lowres-
Sender auch in `omp-player`

**Ziel:** `docs/END-GOAL-FEATURES.md` §15.4 Teil 4 — derselbe Handgriff
wie Teil 2 (`omp-source`) für einen weiteren Video-produzierenden
Node. `omp-player` gewählt (nicht `omp-ograf`) — architektonisch näher
an `omp-source` (ein einzelner MXL-Video-Ausgang), während `omp-ograf`s
Fill+Key-Doppelausgang eine bisher ungeklärte Design-Frage aufwirft
(bräuchte der Konsument einen Lowres-Fill **und** Lowres-Key, oder
reicht Lowres-Fill allein für eine reine Vorschau? Nicht im Dokument
beantwortet, bewusst zurückgestellt statt geraten).

**Struktur-Unterschied zu `omp-source`, der die Umsetzung geprägt
hat:** `omp-player`s PGM-Ausgang wird bisher direkt vom
`input-selector` (`video_isel`) gespeist — anders als `omp-source`s
bereits vorhandener `tee` gibt es hier noch keinen Verzweigungspunkt.
Ein `input-selector`-Src-Pad ist ein normaler Always-Pad (1:1-Link,
kein Fan-out) — ein neuer `tee` direkt hinter `video_isel` war
notwendig, bevor überhaupt ein zweiter (Lowres-)Zweig möglich war.
`ActivePipeline`/`PipelineHandle` werden pro Prozesslebenszeit genau
einmal gebaut (`replace_slot` rebuilt nur die Input-Zweige VOR dem
isel, nie dessen Ausgangsseite) — der Lowres-Ausgang + Referenzzähler
konnten deshalb genauso einmalig wie bei `omp-source` angelegt werden,
unabhängig von Cue/Take-Rebuilds.

**Umsetzung** (`nodes/omp-player/src/pipeline.rs`,
`nodes/omp-player/src/main.rs`): `Config` bekommt
`lowres_video_flow_id`; `build()`s Video-Ausgang-Abschnitt fügt einen
`tee` zwischen `video_isel` und dem bisherigen `MxlVideoOutput` ein,
zwei `queue`-Zweige (Highres unverändert aktiv, Lowres bewusst nicht
`set_active(true)` — Valve-Default bleibt zu). `PipelineHandle`
bekommt `activate_lowres_preview`/`release_lowres_preview`/
`lowres_preview_active` (identische Referenzzählungs-Logik wie
`omp-source`), alle drei No-Ops im Jingle-Profil (`has_video==false`,
kein Video-Ausgang existiert). `main.rs`: zweiter `SenderSpec` +
Grouphint-Tag-Paar (nur wenn `has_video`), neue Deskriptor-Parameter
`lowresFlowId`/`lowresActive` + Methoden `activateLowresPreview`/
`releaseLowresPreview` (nur in `descriptor()` deklariert, wenn
`has_video` — der generische Proxy prüft Aufrufe aber nicht gegen den
Descriptor, harmlos dank der No-Op-Absicherung in `PipelineHandle`).

**Verifiziert (echte Prozesse, kein Mock):** `cargo build`/`cargo
clippy --all-targets -p omp-player` sauber, `cargo build --workspace`
grün. Live gegen einen echten Orchestrator/Registry-Stack:
`omp-player-video` zeigte exakt drei Sender (Highres/Lowres-Video +
Audio) mit korrektem Grouphint-Paar; `omp-player-jingle` zeigte
korrekt **nur** den Audio-Sender, kein Lowres-Video (Profil-Gate
funktioniert). `mxl-info` bestätigte den Lowres-Flow bei `Head index:
0` (dormant) über 2,5s Wartezeit, nach `activateLowresPreview` sofort
wachsend. **Generalisierungs-Bonus:** eine echte `omp-multiviewer`-
Instanz (Kapitel 15 Teil 3, unverändert seit Nachtrag 38) entdeckte
und aktivierte den Player-Lowres-Sender automatisch, **ohne jede
player-spezifische Änderung in `omp-multiviewer`** — `mxl-info` zeigte
"Last read time" erneut im Millisekunden-Abstand zur "Last write
time", identisch zum `omp-source`-Fall — bestätigt, dass die
Grouphint-basierte Discovery aus Teil 3 tatsächlich generisch über
Producer-Typen hinweg funktioniert, nicht nur für den ursprünglichen
Pilot-Node. Cue/Take eines `smpte`-Testbilds bestätigte zusätzlich den
korrekten `mode`/`currentItemId`-Übergang am Player selbst; die
zugehörige Multiviewer-Vorschau-Frame-Extraktion im Ad-hoc-Testskript
zeigte beim zweiten Versuch ein unerwartetes Bild (mutmaßlich ein
Mehrfach-Frame-Grenzen-Fehler im Testskript selbst, nicht im Node-Code
— die entscheidende Kette Aktivierung→aktives Lesen war zu diesem
Zeitpunkt bereits per `mxl-info`-Zeitstempeln zweifelsfrei belegt,
nicht weiterverfolgt). Alle Testartefakte danach entfernt.

**Nicht Teil dieser Scheibe:** `omp-ograf` (Design-Frage Fill/Key
offen, s. o.) bleibt der letzte Kapitel-15-Baustein.

## 2026-07-19 (Nachtrag 40) — §4.6 Punkt 4: Mixer-Presets, Blocker
gefunden + behoben (Node-Contract-Erweiterung `GET`/`POST /state`)

**Blocker (live entdeckt, nicht vorher erkennbar):** Die in Nachtrag
30/§4.6 Punkt 4 vorgeschlagene Umsetzung — Snapshot-Service (B7) per
`nodeIds:[self]` auf einen Node einschränken, denselben Erfassungscode
wiederverwenden — baut technisch (Go: `orchestrator/internal/
snapshots/{types,service,nodeclient}.go`, `httpapi/snapshot_handlers.go`;
TS: `ui/graph/flow-canvas.ts`; alle Unit-Tests grün) und wurde erst beim
echten Live-Test als funktional wirkungslos erkannt: ein soeben
angelegtes Node-Preset für einen echten `omp-audio-mixer` (Kanal-Gain
auf -12dB gesetzt) lieferte `"params": null` — nichts erfasst. Ursache:
`GetWritableParams` (der Erfassungscode) filtert ausschließlich auf
`readonly==false` — `omp-audio-mixer` **und** `omp-video-mixer-me`
erklären aber (C10/C11-Konvention, s. `channel_param`-Doku in
`omp-audio-mixer/src/main.rs`) ausnahmslos **alle** Parameter
`readonly:true`; Mutation läuft nur über eigene `invoke()`-Methoden
(`setGain`, `setComp`, `crosspoint.select`, `dve.setBox`, …). Für diese
beiden Nodes erfasst der generische Parameter-Proxy strukturell nichts
— "Mixer-Presets" hätte leere, wirkungslose Presets erzeugt.

**Nutzer entschieden (AskUserQuestion, drei Optionen vorgelegt):**
Node-Contract um eine optionale, generische `GET`/`POST /state`-Route
erweitern (Empfehlung, gewählt) statt B) `set()` je Einzelfeld
PATCH-fähig nachzurüsten (hätte die C11-Readonly-Entscheidung teilweise
zurückgedreht, pro Feld separate Rekonstruktionslogik in zwei Nodes)
oder C) Scope zurückstellen.

**Umsetzung** — Node-Contract-Erweiterung (`ARCHITECTURE.md` §5-Sinne):
`GET /state` liefert `{"state": <opak, node-eigen>}`, `POST /state`
mit `{"state": ...}` stellt ihn wieder her. Kein Descriptor-Feld nötig
— reines HTTP-Existenz-Discovery (404 = Node unterstützt es nicht).
Implementiert über den bereits vorhandenen `ParamStore::extra_route`-
Erweiterungspunkt (bislang nur für IS-05/SDP genutzt), **keine**
Änderung an der `ParamStore`-Trait-Signatur (hätte jeden Node im
Workspace berührt, wegen `invoke()`s fehlendem Rückgabewert für
Zustandsdaten).

- `omp-audio-mixer/src/main.rs`: `capture_state`/`restore_state` —
  alle Kanäle (Gain/EQ/3-Band-Freq+Width/Kompressor/Quelle/AFV-Felder)
  + Master-Limiter als ein JSON-Objekt (manuell über `serde_json::Value`
  gebaut, kein neuer `serde`-Derive-Dependency — konsistent mit dem
  Rest der Datei). `restore_state` ersetzt die komplette Kanalliste
  (nicht additiv: "genau diese Kanäle mit genau diesen Werten"), baut
  jeden Kanal über dieselben Pipeline-Aufrufe wie die bestehenden
  `channel.<id>.set*`-Methoden neu auf. Eine beim Erfassen vorhandene,
  inzwischen verschwundene externe Quelle fällt still auf den internen
  Testton zurück statt das ganze Preset scheitern zu lassen.
- `omp-video-mixer-me/src/main.rs`: `capture_state`/`restore_state` —
  Program-/Preset-Sender-ID, DVE-Box, Keyer-Enabled. Restore nutzt
  `select_preset` (Preset-Bus) + `take` (PGM-Hot-Cut, berührt Preset
  bewusst nicht, s. Nachtrag zu K3-Teil-2) für unabhängige Wiederher-
  stellung beider Busse — kein UI-Bundle-Anschluss in dieser Scheibe
  (nur Backend-Infrastruktur, analog zum Audiomixer als natürlicher
  Folgeschritt).
- `orchestrator/internal/snapshots/nodeclient.go`: `GetState`/
  `ApplyState` (404 = kein Fehler, "Node kennt /state nicht").
  `service.go::Create` versucht `GetState` je Node zuerst, überspringt
  bei Erfolg die Parameter-Enumeration für diesen Node komplett (auch
  bei workflow-weiten, nicht nur node-skopierten Szenen — kommt allen
  künftigen Voll-Szenen-Snapshots zugute, die einen solchen Node
  enthalten). `Apply` stellt States vor Params/Edges wieder her.
- `nodes/omp-audio-mixer/ui/bundle.js`: "Presets"-Sektion (zuvor kurz
  eingebaut, nach dem Blocker-Fund als nicht-funktional wieder entfernt,
  nach dem Fix erneut hinzugefügt) — "Preset speichern" + Preset-Chips
  zum Anwenden, `nodeIds:[nodeId]`-Scoping wie geplant.

**Verifiziert (echte Prozesse, kein Mock):** `cargo build --workspace`
+ `cargo clippy --all-targets` für beide Nodes sauber (keine neuen
Warnings ggü. Baseline, per `git stash`-Vergleich geprüft). Go:
`go build ./...`, `go vet ./...`, `go test ./...` grün, neue Tests
(`TestCreatePrefersNodeStateOverWritableParams`,
`TestApplyRestoresNodeStateBeforeParams`) decken den `/state`-Vorrang-
Pfad ab. `deno check`/`deno test` (56 grün)/`make ui` sauber. Live
gegen einen echten Orchestrator + echten `omp-audio-mixer`: Kanal
angelegt, Gain auf -12dB, Node-Preset erstellt → `GET /state` direkt am
Node bestätigte die reale -12dB im JSON; Gain auf +3dB geändert, Preset
per API angewendet → Gain wieder exakt -12dB, keine Kanal-Duplikate.
Zusätzlich per echtem Chromium/CDP (Bundle live geladen, Custom
Element im DOM instanziiert, echte Klicks auf "Preset speichern" +
einen Preset-Chip statt nur API-Aufrufe): Presets-Sektion rendert,
Speichern-Klick legt real ein Preset mit dem tatsächlichen Node-Zustand
an, Anwenden-Klick stellt einen zuvor geänderten Gain-Wert korrekt
wieder her (ein erster CDP-Durchlauf zeigte scheinbar 0dB statt -7dB —
Ursache war ein Label-Kollisions-Fehler im eigenen Testskript, zwei
Presets mit identischem Anzeigetext aus einem fehlgeschlagenen
Retry-Versuch, per direktem Preset-ID-Vergleich als Testartefakt
bestätigt, kein Produktfehler). Alle Testartefakte (Snapshots direkt in
Postgres gelöscht, da kein DELETE-Endpunkt für Snapshots existiert;
Instanzen, `/dev/shm/omp-mxl`-Flows, Chromium-Prozesse) danach entfernt.

**Nicht Teil dieser Scheibe:** `omp-video-mixer-me`-UI-Bundle bekommt
noch keine Presets-Sektion (Backend-Infrastruktur ist fertig, UI-Klick-
Pfad wäre ein kleiner, unabhängiger Folgeschritt). Kein DELETE-Endpunkt
für Snapshots — bislang nie gebraucht, in dieser Scheibe erstmals als
Lücke sichtbar geworden (Cleanup ging nur per direktem SQL).

**Nachtrag, gleicher Tag:** `omp-video-mixer-me`-Presets-UI nachgezogen
— identisches Muster wie `omp-audio-mixer/ui/bundle.js` (neue
"Presets"-Sektion, `nodeIds:[nodeId]`-Scoping, Chip pro gespeichertem
Preset). Live verifiziert: echten Keyer aktiviert + DVE-Box gesetzt
(`x:10,y:20,w:200,h:150`), per echtem Chromium/CDP-Klick auf "Preset
speichern" gespeichert, beides über die reale API zurückgesetzt
(Keyer aus, DVE-Reset), per Klick auf den Preset-Chip wiederhergestellt
— `keyer.enabled` und `dve.box` beide exakt wie gespeichert bestätigt.
Testartefakte (Snapshot-Zeile per SQL, Instanz, `/dev/shm/omp-mxl`-Flow,
Chromium-Prozess) danach entfernt. Damit ist §4.6 Punkt 4 für beide
§13-Referenzknoten vollständig (UI-Seite).
