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
