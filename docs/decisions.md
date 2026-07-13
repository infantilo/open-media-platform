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
