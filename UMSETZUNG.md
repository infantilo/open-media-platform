# OMP — Umsetzungsanleitung für Claude Sonnet (Claude Code, Pro-Plan)

Dieses Dokument ist die Arbeitsanweisung für die Implementierung der
OpenMediaPlatform mit **Claude Sonnet** über **Claude Code** auf dem
**Claude-Pro-Plan**. Architektur-Entscheidungen stehen in `ARCHITECTURE.md`
und werden hier nicht wiederholt — bei Widerspruch gilt `ARCHITECTURE.md`.

---

## 0. Arbeitsregeln für Claude (bei jeder Sitzung befolgen)

1. **Zuerst lesen:** `ARCHITECTURE.md` (mindestens §3, §4, §5 und den
   Abschnitt zum aktuellen Schritt) sowie die Status-Checkliste am Ende
   dieses Dokuments.
2. **Genau einen Schritt pro Sitzung** bearbeiten (Schritte sind auf ein
   5-Stunden-Fenster des Pro-Plans dimensioniert). Nicht vorgreifen, keine
   Features aus späteren Schritten „mitnehmen".
3. **Kein Schritt gilt als fertig ohne bestandene Verifikation.** Jeder
   Schritt hat einen Abschnitt „Verifikation" mit konkreten Kommandos bzw.
   Prüfungen. Schlägt die Verifikation fehl: fixen, nicht weitermachen.
4. **Nach bestandener Verifikation:** Status-Checkliste (Abschnitt 6)
   abhaken, `git commit` mit Message `[Schritt-ID] Kurzbeschreibung`.
5. **Minimal-Dependency-Regel** (aus `ARCHITECTURE.md` §4.1a): vor jedem
   `go get` / `cargo add` / npm-Import begründen, warum die
   Standard-Bibliothek nicht reicht. UI: kein Framework, kein npm-Build —
   vanilla TS/ESM, Typprüfung via Deno (`deno check`).
6. **Standards nicht raten:** Bei IS-04/IS-05/MS-05-02-Detailfragen die
   Spezifikation nachschlagen (specs.amwa.tv) statt aus dem Gedächtnis zu
   implementieren.
7. **Media-Hardware-Realität:** Entwicklung läuft auf einem normalen
   Linux-Rechner (Crostini) ohne PTP-NIC, ohne 2110-Netz. Alle Schritte sind
   so ausgelegt, dass die Verifikation mit Software-Mitteln funktioniert
   (Mock-Nodes, `videotestsrc`, RTP/SRT lokal). Nichts einbauen, das nur mit
   Broadcast-Hardware testbar wäre.
8. **Bei Blockern** (fehlendes Paket, kaputtes Container-Image, unklare
   Spec): Problem + 2–3 Lösungsoptionen kurz dokumentieren
   (`docs/decisions.md`), Empfehlung nennen, Nutzer entscheiden lassen.
9. **Nicht raten, auch nicht bei GStreamer/Medien-Pipelines** (siehe
   `docs/decisions.md`, 2026-07-09): Vor Trial-and-Error-Fehlersuche an
   einer GStreamer-Pipeline immer erst `/home/infantilo/PIPELINE
   CONTROLLER` konsultieren (insb. `lib/MasterPipeline.js`,
   `lib/PlayerPipeline.js`, `lib/PreviewPipeline.js`,
   `scripts/install-mxl.sh`) — Muster übernehmen (nicht Code kopieren,
   andere Sprache/Kontext), statt das Problem empirisch neu herzuleiten.

---

## 1. Rahmenbedingungen Pro-Plan

- Pro bietet pro 5-h-Fenster grob **10–40 Prompts** und pro Woche ca.
  **40–80 aktive Sonnet-Stunden** — für ein Nebenbei-Projekt mit 5–15 h/Woche
  ist damit **die Mensch-Zeit der Engpass, nicht das Abo**.
- Opus steht auf Pro praktisch nicht zur Verfügung → dieses Dokument ist
  bewusst so kleinteilig, dass **Sonnet** jeden Schritt ohne
  Architektur-Eigenleistung umsetzen kann.
- Ein „Schritt" unten ≈ 1 Sitzung (1 × 5-h-Fenster). Mit `(2–3)` markierte
  Schritte brauchen voraussichtlich mehrere Sitzungen — dann pro Sitzung an
  einer sauberen Zwischengrenze (kompilierbar, Tests grün) stoppen.

---

## 2. Phasenübersicht und Kosten

Annahmen: 5–10 h Mensch-Zeit pro Woche; Pro-Abo **20 $/Monat zzgl. MwSt. ≈
21–23 €/Monat** (Jahresabo 17 $/Monat ≈ 18–19 €/Monat). Die Kosten sind
schlicht *Projektdauer × Abopreis* — es gibt keine Zusatzkosten pro Token.

| Phase | Inhalt | Schritte | Dauer (5–10 h/Wo) | Abo-Kosten |
|---|---|---|---|---|
| **A — Fundament** (P0) | Repo, Podman/Quadlets, NATS, NMOS-Registry, Go-Orchestrator, Mock-Node, Descriptor v0 | A1–A9 | 2–4 Monate | ≈ 45–90 € |
| **B — Flow-Editor GUI** | Graph-Canvas, Drag&Drop-Routing, Gruppen/Verschachtelung, Parameter-Panels, Snapshots | B1–B7 | 2–4 Monate | ≈ 45–90 € |
| **C — Playout-Node & MXL-Demo-Trias** (P1-Kern) | Rust + GStreamer, `omp-node-sdk`, RTP-Ausgang (C1–C3), MXL-Fundament + Source/Viewer/Switcher + GUI-Launch (C4–C8), Contract-Test (C9), später echter Playout-Umbau (C10/C11) | C1–C9 (+ C10/C11 später) | 4–6 Monate | ≈ 85–135 € |
| **D — Hardening & SDK-Release** | mTLS/Auth, AMWA-Testing-Tool in CI, SDK-Doku, 2110-Pfad | D1–D5 | 3–6 Monate | ≈ 65–135 € |
| **Gesamt bis demo-fähiger Kern** | | ~30 Schritte | **11–20 Monate** | **≈ 240–450 €** |

Einordnung: `ARCHITECTURE.md` §7.1 schätzt P0+P1 konservativ auf ~840 h ohne
detaillierten Schrittplan. Dieses Dokument reduziert das, weil (a) der
GUI-/Kern-Scope hier bewusst enger geschnitten ist (2110/PTP erst in Phase D,
mock-first davor — MXL dagegen wird bereits in Phase C gebraucht, siehe
docs/decisions.md 2026-07-09, da es zur Laufzeit als GStreamer-Plugin geladen
wird und keine Cluster-/PTP-Hardware braucht) und (b) Sonnet den
Boilerplate-Anteil (NMOS-Client, HTTP-Handler, SVG-Canvas) übernimmt. Bei
15–20 h/Woche halbieren sich Dauer und Kosten ungefähr (≈ 5–10 Monate, ≈
120–225 €).

---

## 3. Phase A — Fundament (P0)

### A1 — Repo-Struktur & Werkzeuge

**Ziel:** Arbeitsfähiges Monorepo mit Build-Einstieg.

**Anweisung:** Verzeichnisse `orchestrator/` (Go-Modul `go mod init
github.com/<user>/openmediaplatform/orchestrator`), `ui/` (vanilla TS, kein
package.json), `nodes/` (später Rust-Workspace), `deploy/quadlets/`,
`docs/`. Ein `Makefile` mit Targets `build`, `test`, `check` (Go vet/test +
`deno check ui/**/*.ts`), `up`/`down` (Podman-Quadlets, ab A2). `.gitignore`
ergänzen. `docs/decisions.md` anlegen (leer, mit Kopfzeile).

**Verifikation:**
```sh
make check          # läuft fehlerfrei durch (auch wenn noch fast leer)
git status          # sauber nach Commit
```

### A2 — NATS als Quadlet

**Ziel:** Event-Bus läuft als systemd-verwalteter Podman-Container.

**Anweisung:** `deploy/quadlets/omp-nats.container` (Image `docker.io/nats`,
Ports 4222 + 8222/Monitoring, Restart-Policy). `make up` installiert Quadlets
nach `~/.config/containers/systemd/` und startet via `systemctl --user`.
Fallback dokumentieren, falls Crostini kein systemd-user hat: `podman run`
direkt aus dem Makefile.

**Verifikation:**
```sh
make up
curl -s http://localhost:8222/varz | grep server_id   # NATS antwortet
```

### A3 — NMOS-Registry (nmos-cpp) als Quadlet

**Ziel:** IS-04-Registry/Query-API erreichbar.

**Anweisung:** Quadlet für `rhastie/nmos-cpp` (oder aktuelles
nmos-cpp-Registry-Image; Image-Wahl in `docs/decisions.md` festhalten).
Registration- und Query-API-Ports exportieren, Config als Volume.

**Verifikation:**
```sh
curl -s http://localhost:<query-port>/x-nmos/query/v1.3/nodes   # → []
```

### A4 — Go-Orchestrator-Skeleton

**Ziel:** Ein statisches Go-Binary mit HTTP-Server, das die UI ausliefert.

**Anweisung:** `orchestrator/`: `net/http`-Server (kein Framework),
Endpunkte `GET /healthz` (`{"status":"ok"}`), `GET /api/v1/info`
(Name/Version), statisches Serving von `ui/` unter `/`. Strukturierte Logs
(`log/slog`). Konfiguration über Env-Variablen mit Defaults
(`OMP_LISTEN`, `OMP_REGISTRY_URL`, `OMP_NATS_URL`). Unit-Test für die
Handler.

**Verifikation:**
```sh
go test ./... && go vet ./...        # grün
go run ./orchestrator & curl -s localhost:8000/healthz   # {"status":"ok"}
curl -s localhost:8000/ | grep -i '<html'                # UI-Platzhalter kommt
```

### A5 — Registry-Anbindung: Node-Inventar (2)

**Ziel:** Orchestrator spiegelt die IS-04-Registry als eigene, normalisierte
API.

**Anweisung:** Query-API der Registry pollen (später WebSocket-Subscription,
jetzt Poll alle 2 s reicht) und in einem In-Memory-Store halten. Endpunkt
`GET /api/v1/nodes` liefert normalisierte Liste: id, label, devices, senders
(mit Format), receivers, online-Status. Kein nmos-cpp-Spezialwissen — nur
Standard-IS-04-REST.

**Verifikation:** Fake-Node per Skript registrieren
(`deploy/dev/register-fake-node.sh`, das mit `curl` eine minimale
IS-04-Node/Device/Sender/Receiver-Resource an die Registration-API POSTet;
dieses Skript ist Teil des Schritts):
```sh
./deploy/dev/register-fake-node.sh
curl -s localhost:8000/api/v1/nodes | jq '.[0].label'   # Fake-Node erscheint
```

### A6 — Event-Bus-Anbindung + Live-Updates zur UI

**Ziel:** NATS-Ereignisse erreichen den Browser.

**Anweisung:** Orchestrator subscribed `omp.>` auf NATS (offizieller
nats.go-Client — Ausnahme von der Dependency-Regel, in `docs/decisions.md`
begründen). Endpunkt `GET /api/v1/events` als **SSE-Stream**, der
Bus-Ereignisse + Node-Inventar-Änderungen (`node.added`, `node.removed`,
`node.updated`) als JSON weiterreicht.

**Verifikation:**
```sh
curl -N localhost:8000/api/v1/events &        # Stream offen halten
podman exec omp-nats nats pub omp.health.test '{"ok":true}' \
  || nats pub omp.health.test '{"ok":true}'   # je nach Setup
# → Event erscheint im SSE-Stream; ebenso beim Registrieren des Fake-Nodes
```

### A7 — Mock-Node `omp-mock` (2)

**Ziel:** Ein simulierter Node, mit dem sich alles Weitere ohne echte
Medientechnik testen lässt — das wichtigste Testwerkzeug des Projekts.

**Anweisung:** Kleines Go-Programm `nodes/mock/`: registriert sich per IS-04
bei der Registry (Node/Device/1×Sender/1×Receiver, Heartbeat), publiziert
Health/Tally auf NATS (`omp.health.<id>`, alle 5 s), serviert
`GET /descriptor.json` (siehe A8) und akzeptiert
`PATCH /params/<name>`. Startparameter: `--label`, `--senders N`,
`--receivers N`, `--port`, damit mehrere Instanzen parallel laufen.

**Verifikation:**
```sh
go run ./nodes/mock --label "Mock A" &
go run ./nodes/mock --label "Mock B" --port 9002 &
curl -s localhost:8000/api/v1/nodes | jq length    # ≥ 2, beide online
# SSE-Stream (A6) zeigt Health-Events beider Mocks
```

### A8 — Descriptor v0 (Self-Describe) + generischer Parameter-Proxy (2)

**Ziel:** Der „Hebel gegen Hardcoding" aus `ARCHITECTURE.md` §2/§11.1 in
einer ersten, bewusst einfachen Ausbaustufe.

**Anweisung:** JSON-Schema `docs/descriptor-v0.schema.json` definieren:
Node beschreibt Parameter (name, typ, wertebereich, unit, readonly) und
Methoden (name, args) — als flaches, IS-12/14-**kompatibel gedachtes**
Format (Mapping-Notiz in `docs/decisions.md`, siehe Fallback-Klausel
`ARCHITECTURE.md` §8). Mock-Node liefert einen Beispiel-Descriptor (z.B.
Parameter `gain`, `label`, Methode `reset()`). Orchestrator: generische
Endpunkte `GET /api/v1/nodes/<id>/descriptor`,
`GET|PATCH /api/v1/nodes/<id>/params/<name>`,
`POST /api/v1/nodes/<id>/methods/<name>` — reiner Proxy, **null
Node-Typ-Wissen im Orchestrator-Code**.

**Verifikation:**
```sh
curl -s localhost:8000/api/v1/nodes/<id>/descriptor | \
  jq '.parameters[].name'                          # gain, label, …
curl -sX PATCH localhost:8000/api/v1/nodes/<id>/params/gain \
  -d '{"value":-6}'                                # 200
# Mock-Node loggt die Änderung; erneutes GET liefert -6
go test ./...                                      # inkl. Schema-Validierungstest
```

### A9 — CI-Grundgerüst

**Ziel:** Jeder Commit wird automatisch geprüft.

**Anweisung:** GitHub-Actions-Workflow (oder lokales `make ci`, falls kein
Remote): `make check`, `go test ./...`, Descriptor-Schema-Validierung der
Mock-Descriptoren. Platzhalter-Job für das AMWA NMOS Testing Tool anlegen,
aber noch deaktiviert (kommt in D2).

**Verifikation:** Pipeline/`make ci` läuft grün auf einem frischen Checkout
(`git clone` in Temp-Verzeichnis, dort ausführen).

---

## 4. Phase B — Flow-Editor GUI (`ARCHITECTURE.md` §4.5a)

Alle B-Schritte: vanilla TS Custom Elements + SVG, `deno check` als
Typprüfung, keine Frameworks. Browser-Verifikation dokumentiert Claude als
kurze Checkliste, die der Nutzer in 2 Minuten durchklickt; alles Rechenbare
(Graph-Modell, Hit-Testing, Layout) zusätzlich als `deno test`-Unit-Tests.

### B1 — Graph-API im Orchestrator

**Ziel:** Eine API, die den kompletten Ist-Zustand als Graph liefert.

**Anweisung:** `GET /api/v1/graph` → `{nodes:[{id,label,inputs,outputs,
health}], edges:[{id,fromSender,toReceiver,state}]}`. Kanten aus den
IS-05-Active-Endpoints der Receiver ableiten. `POST /api/v1/graph/edges`
(fromSender/toReceiver) führt den IS-05-PATCH aus, `DELETE
/api/v1/graph/edges/<id>` trennt. Mock-Node bekommt dafür einen minimalen
IS-05-Connection-Endpoint (staged/active), falls noch nicht vorhanden.

**Verifikation:**
```sh
curl -sX POST localhost:8000/api/v1/graph/edges \
  -d '{"from":"<senderId>","to":"<receiverId>"}'       # 200
curl -s localhost:8000/api/v1/graph | jq '.edges|length'  # 1
# Receiver-Active-Endpoint des Mock-Nodes zeigt die Sender-ID
```

### B2 — SVG-Canvas: Kacheln, Pan & Zoom (2)

**Ziel:** `<omp-flow-canvas>` rendert den Graphen.

**Anweisung:** Custom Element, das `/api/v1/graph` lädt und Nodes als
SVG-Gruppen zeichnet: Titelzeile, Input-Ports links, Output-Ports rechts.
Pan (Drag auf Freifläche), Zoom (Mausrad, um Cursor zentriert), Nodes
verschiebbar; Positionen zunächst in `localStorage`. Reine Logik
(Koordinaten-Transformationen, Port-Positionen) in eigenes Modul
`ui/graph/geometry.ts` mit `deno test`.

**Verifikation:** `deno test ui/` grün; Browser-Checkliste: 2 Mock-Nodes
sichtbar, verschiebbar, Pan/Zoom flüssig, Reload behält Positionen.

### B3 — Drag & Drop-Verbindungen (2)

**Ziel:** Routing per Maus — das AMPP-Kern-Erlebnis.

**Anweisung:** Drag von Output-Port zieht eine Gummiband-Linie; Drop auf
kompatiblen Input-Port → `POST /api/v1/graph/edges`; inkompatible Ports
(Format-Mismatch laut Graph-API) werden während des Drags ausgegraut.
Kanten als Bezier-Kurven; Klick auf Kante + `Entf` → DELETE. Fehler vom
Server (z.B. IS-05 abgelehnt) als Toast anzeigen, Kante nicht zeichnen.

**Verifikation:** Browser: Verbindung Mock A → Mock B ziehen; danach per
`curl …/api/v1/graph` prüfen, dass die Kante **serverseitig** existiert
(nicht nur gemalt). Trennen und erneut prüfen (0 Kanten). Unit-Tests für
Port-Kompatibilitätslogik.

### B4 — Live-Status-Overlay

**Ziel:** Der Graph zeigt den Betriebszustand in Echtzeit.

**Anweisung:** SSE-Stream (A6) abonnieren: Health färbt den Node-Rahmen
(ok/warn/offline), Tally färbt rot, neue/entfernte Nodes erscheinen/
verschwinden ohne Reload. Wiederverbindungs-Logik für SSE (Backoff).

**Verifikation:** Mock-Node killen → Kachel wird binnen ~10 s als offline
markiert; neu starten → wieder ok. Tally-Event per `nats pub` → Kachel rot.

### B5 — Gruppen / Verschachtelung (2–3)

**Ziel:** AMPP-artiges Verschachteln: Teilgraphen zu Makro-Blöcken falten.

**Anweisung:** Mehrfachauswahl (Rahmen ziehen / Shift-Klick) → „Gruppieren":
gewählte Kacheln kollabieren zu einem Block, der nur die nach außen
gehenden Ports zeigt. Doppelklick öffnet die Gruppe (Breadcrumb zurück).
Gruppen benennbar, verschachtelbar (Gruppe in Gruppe). Datenmodell als
Baum (`ui/graph/groups.ts`) mit Unit-Tests: Port-Promotion (welche Ports
zeigt der kollabierte Block) ist reine Funktion → gut testbar. Persistenz
der Gruppen+Layout zunächst als JSON via Orchestrator
(`GET|PUT /api/v1/layouts/<name>`, Datei-Backend; Postgres erst in D).

**Verifikation:** `deno test` für Gruppenbaum/Port-Promotion grün.
Browser: 3 Mocks gruppieren, Verbindung von außen an die Gruppe legen,
Gruppe öffnen/schließen, Seite neu laden → Gruppen und Layout bleiben.

### B6 — Parameter-Panel aus Descriptor + Node-UI-Bundles

**Ziel:** Klick auf Kachel → Einstellungen, ohne Node-spezifischen Shell-Code.

**Anweisung:** Seitenpanel generiert Controls generisch aus dem Descriptor
(A8): number→Slider/Feld, bool→Toggle, enum→Select, Methode→Button; Änderung
→ PATCH, Server-Wert ist die Wahrheit (optimistisches UI mit Rollback).
Liefert der Node `/ui/manifest.json` + `/ui/bundle.js` (`ARCHITECTURE.md`
§4.5), wird stattdessen das Custom Element per nativem `import()` geladen
(Shadow DOM). Mock-Node bekommt ein Beispiel-Bundle.

**Verifikation:** Browser: `gain` am Mock über den Slider ändern → `curl` auf
den Param bestätigt den Wert; Mock mit UI-Bundle zeigt das eigene Element.
`deno test` für Descriptor→Control-Mapping.

### B7 — Snapshots/Szenen

**Ziel:** Kompletten Regie-Zustand speichern und abrufen.

**Anweisung:** `POST /api/v1/snapshots` speichert Kanten + alle
schreibbaren Parameterwerte aller Nodes; `POST
/api/v1/snapshots/<id>/apply` stellt beides wieder her (Reihenfolge:
Parameter, dann Kanten; Fehler sammeln und als Report zurückgeben). UI:
Snapshot-Leiste (speichern, benennen, laden).

**Verifikation:**
```sh
# Zustand 1 bauen, Snapshot S1; Kanten trennen, Params ändern; S1 anwenden:
curl -sX POST localhost:8000/api/v1/snapshots/<id>/apply | jq '.errors'  # []
curl -s localhost:8000/api/v1/graph | jq '.edges|length'  # wie in Zustand 1
```

**→ Meilenstein „Demo 1":** Mit A1–B7 existiert eine vorführbare Plattform:
Nodes erscheinen automatisch, werden grafisch verschaltet, gruppiert,
parametriert, Szenen umgeschaltet — alles noch mit Mock-Nodes, aber über
exakt die Schnittstellen, die später echte Media-Nodes benutzen.

---

## 5. Phase C — Playout-Node (Rust + GStreamer)

Know-how-Quelle: `/home/infantilo/PIPELINE CONTROLLER` (Patterns dort
nachlesen, **nicht** Code kopieren — Neu-Implementierung nach bekanntem
Muster, `ARCHITECTURE.md` §4.1a). Voraussetzung: GStreamer-Dev-Pakete
installiert (`gst-launch-1.0 --version`).

### C1 — Rust-Workspace + `omp-node-sdk` Skeleton (2)

**Ziel:** Das Crate, das jeder künftige Node benutzt.

**Anweisung:** `nodes/Cargo.toml` als Workspace; Crate `omp-node-sdk`:
IS-04-Registrierung+Heartbeat, Descriptor-Serving (A8-Schema),
Param/Method-Dispatch als Trait, NATS-Health-Publisher. HTTP minimal halten
(`tiny_http` o.ä. — Begründung in `docs/decisions.md`); `cargo deny` +
`cargo audit` ab dem ersten Commit einrichten.

**Verifikation:** Beispiel-Binary `examples/hello_node.rs` im SDK-Crate
startet, erscheint in Registry **und im Flow-Editor**, Parameter über das
generische Panel änderbar. `cargo test && cargo deny check` grün.

### C2 — GStreamer-Grundpipeline

**Ziel:** Der Playout-Node produziert Bild und Ton.

**Anweisung:** Crate `nodes/playout` auf SDK-Basis: Pipeline
`videotestsrc + audiotestsrc → Ausgang` (Ausgang siehe C3, hier zunächst
`autovideosink` bzw. headless `fakesink` mit FPS-Messung). Sauberer
Start/Stop-Lifecycle, Pipeline-Fehler → NATS-Alarm.

**Verifikation:** Node starten → Health „ok" + gemessene FPS ≈ 25/50 im
Log/NATS; Pipeline absichtlich brechen (ungültiges Element per Env) →
Alarm-Event auf `omp.alert.<id>`, Prozess bleibt kontrollierbar.

### C3 — Netz-Ausgang (RTP, 2110-vorbereitet)

**Ziel:** Output verlässt den Prozess als Netzwerkstrom, empfangbar mit
Standard-Tools.

**Anweisung:** Ausgang als RTP (`rtpvrawpay`/H.264 als pragmatischer
Dev-Codec — Entscheidung dokumentieren) an konfigurierbare Ziel-Adresse;
IS-04-Sender-Resource + SDP bereitstellen, IS-05-Connection-API des Nodes
steuert Ziel/Start/Stop. Hinter dem `omp-mediaio`-Trait kapseln
(`ARCHITECTURE.md` §10.1), damit 2110/MXL später nur eine neue
Implementierung ist.

**Verifikation:**
```sh
gst-launch-1.0 udpsrc port=5004 caps="…" ! … ! autovideosink   # oder ffplay <sdp>
# → Testbild sichtbar. IS-05-PATCH über den Flow-Editor (B3!) startet/stoppt
#   den Strom nachweisbar.
```

Ab hier (C4) ersetzt die **MXL-Demo-Trias** (`omp-source`/`omp-viewer`/
`omp-switcher`) die ursprünglich geplante Playlist-Engine als nächstes Ziel
— Entscheidung + Begründung in `docs/decisions.md`, 2026-07-09
(„MXL-Timing per Nutzer-Machtwort vorgezogen"). Der C1–C3-Playout-Node
bleibt unverändert als RTP-Referenz-Node im Repo; der echte
Playlist-/Playout-Umbau folgt später als C10/C11 und nutzt `playlist.rs`
vom Branch `c4-playlist-wip` (reine Logik, 12 Tests, dort aufbewahrt, weil
der ursprüngliche Zwei-Slot-`input-selector`-Ansatz — im gleichen
Decisions-Eintrag beschrieben — grundsätzlich verworfen wurde, nicht nur
die konkrete Implementierung).

### C4 — MXL-Fundament (2)

**Ziel:** MXL als Zero-Copy-Transport nutzbar machen — Grundlage für C5–C8.

**Wichtige Korrektur ggü. der ursprünglichen Planung** (verifiziert am
tatsächlich geklonten `v1.0.1`-Tag, nicht angenommen — siehe
`docs/decisions.md`, 2026-07-09 „MXL-GStreamer-Integration
richtiggestellt"): MXL bringt **kein** installierbares GStreamer-Plugin
mit `mxlsrc`/`mxlsink`-Elementen. `tools/mxl-gst/` enthält stattdessen drei
eigenständige C++-Kommandozeilenprogramme (`mxl-gst-testsrc`,
`mxl-gst-sink`, `mxl-gst-looping-filesrc`), die selbst intern
`appsink`/`appsrc` + die MXL-C-API verwenden — nützlich nur als
Verifikations-/Debug-Werkzeuge. Die echte Rust-Anbindung läuft über die
mitgelieferten Crates `rust/mxl-sys` (FFI, `bindgen` + `libloading` —
lädt `libmxl.so` zur Laufzeit per `dlopen`, kein statisches Linken) und
`rust/mxl` (sicherer Wrapper: `FlowWriter`/`FlowReader`,
`GrainWriter`/`GrainReader`). `omp-mediaio` bindet diese als
**Pfad-Abhängigkeit** auf `third_party/mxl/rust/mxl` hinter einem Cargo-
Feature `mxl` ein (Default aus, damit Mock/Playout ohne geklontes MXL-Repo
bauen) — unsere Nodes bauen die appsrc/appsink-Brücke selbst, analog zu
`tools/mxl-gst/testsrc.cpp` (Schreiben: `videotestsrc ! … ! appsink`, dann
Rust-Code zieht Samples und schreibt Grains) bzw. `sink.cpp` (Lesen:
Rust-Code liest Grains und schiebt sie in ein `appsrc`, das die Pipeline
weiterspeist).

**Anweisung:** `deploy/dev/install-mxl.sh`, angelehnt an PIPELINE
CONTROLLERs `scripts/install-mxl.sh`, aber **auf Tag `v1.0.1` gepinnt**
(nicht `git pull` auf einem Branch): bootstrapt `vcpkg` (`$HOME/vcpkg`,
vom CMake-Preset erwartet), installiert `bison`/`flex` (Build-Abhängigkeit
von vcpkgs `pcapplusplus`-Paket, unabhängig von unserem Shared-Memory-
Use-Case, aber ein Pflicht-Dependency im MXL-`vcpkg.json`), klont nach
`third_party/mxl` (gitignored), baut libmxl + `tools/` (CMake-Preset
`Linux-GCC-Release`), schreibt `deploy/dev/mxl.env`
(`LD_LIBRARY_PATH`, `OMP_MXL_DOMAIN`, `MXL_INFO_BIN`,
`MXL_GST_TESTSRC_BIN`, `MXL_GST_SINK_BIN`). In `omp-mediaio`:
`Output`-Trait auf reine Aktivierung abspecken (`set_active`/`is_active`,
`set_destination` raus — RTP-spezifisch, bleibt nur an `RtpVideoOutput`);
neues, Feature-gated Modul `mxl` mit `MxlVideoOutput` (GStreamer-seitig
`videoconvert ! videoscale ! videorate ! capsfilter(v210, fix WxH@fps) !
appsink`, dahinter eine `mxl::FlowWriter` + `GrainWriter`-Schreibschleife
auf einem eigenen Thread) und `MxlVideoInput` (`mxl::FlowReader` +
`GrainReader`-Leseschleife auf eigenem Thread, schiebt Buffer in ein
`appsrc`, danach `videoconvert ! videoscale ! videorate`). Kein
generischer `Input`-Trait (verfrüht bei einer einzigen Transport-Art).
`omp-node-sdk`: neue Transport-Konstante `urn:x-omp:transport:mxl`,
`SenderSpec`/Receiver-Override für `transport`, Konvention **Flow-UUID ==
MXL-`flow-id`** (macht Discovery rein IS-04-basiert, siehe C7). Env
`OMP_MXL_DOMAIN` (Default `/dev/shm/omp-mxl`).

**Verifikation:**
```sh
./deploy/dev/install-mxl.sh
source deploy/dev/mxl.env
$MXL_GST_TESTSRC_BIN -d $OMP_MXL_DOMAIN \
  -v third_party/mxl/lib/tests/data/v210_flow.json -p smpte   # erzeugt einen Test-Flow
$MXL_INFO_BIN -d $OMP_MXL_DOMAIN -l                           # zeigt den Flow
cargo test -p omp-mediaio --features mxl                     # Rust-seitiger Loopback-Test:
  # eigener GrainReader liest den von mxl-gst-testsrc geschriebenen Flow
```
Explizit klären und in `docs/decisions.md` festhalten (nicht raten):
(a) wie sich MXLs Grain-/TAI-Zeitmodell auf GStreamer-Timestamps abbilden
lässt, wenn `MxlVideoInput` Buffer in ein `appsrc` schiebt (grain-Metadaten
tragen bereits einen GStreamer-Buffer-Timestamp aus der Schreib-Pipeline,
siehe `mxl-gst-testsrc`-Log: „DiscreteFlow: Set initial grain index to …
(bufferTs=… ns)" — lokal per `do-timestamp`-Äquivalent restempeln oder die
mitgelieferte `bufferTs` übernehmen, per Test entscheiden, nicht annehmen);
(b) Verhalten, wenn der Flow noch nicht existiert oder der Writer neu
startet (Fehler, Block, oder transparente Wiederaufnahme) — bestimmt, ob
C7 Zweige über Quellen-Neustarts hinweg offen halten darf.

### C5 — `omp-source` (Test-Videoquelle → MXL)

**Ziel:** Erster der drei Demo-Services: publiziert ein wählbares
Testbild als MXL-Flow.

**Anweisung:** Neues Crate `nodes/omp-source`. Pipeline: `videotestsrc
is-live=true pattern=<p> ! capsfilter(w,h,fps) ! MxlVideoOutput` (Kurzform
für „… ! appsink, dahinter schreibt `MxlVideoOutput`s Thread die Samples
per `GrainWriter` in den Flow" — siehe C4-Korrektur, kein echtes
GStreamer-Element) — `is-live=true` ist die aus C2 fehlende, in PIPELINE
CONTROLLER bewährte Einstellung. Descriptor: Parameter `pattern` (enum `smpte`/`ball`/
`snow`/`black`/`bars`/…, live per Property gesetzt — Ausnahme von der
sonstigen „nur per Pipeline-Neuaufbau ändern"-Regel, da reine
Property-Änderung, keine Topologie-/Zustandsänderung), readonly `fps`
(C2-Probe wiederverwendet), readonly `flowId`. IS-04: 1 Sender (Transport
`urn:x-omp:transport:mxl`) + Flow. Multi-Instanz über `OMP_LABEL`/
`OMP_PORT` wie beim Mock-Node.

**Verifikation:** Zwei Instanzen mit unterschiedlichem `pattern` starten →
`mxl-info` zeigt 2 Flows, Registry zeigt 2 MXL-Sender; `pattern` per PATCH
ändern → `mxl-info`/Loopback-Test zeigt den neuen Testbild-Typ.

### C6 — `omp-viewer` (MXL → Bild)

**Ziel:** Zweiter Demo-Service, erste vorführbare Zero-Copy-Strecke
(Source → Viewer).

**Anweisung:** Neues Crate `nodes/omp-viewer`. Anzeige headless über
**MJPEG-über-HTTP im eigenen UI-Bundle** — PIPELINE CONTROLLERs bewährtes
Preview-Muster (`PreviewPipeline.js`: `… ! videoscale 640×360 ! videorate
5/1 ! jpegenc quality=70 ! appsink`, ausgeliefert als
`multipart/x-mixed-replace; boundary=frame`). Dafür ein zweiter,
eigenständiger `tiny_http`-Listener auf eigenem Thread
(`OMP_VIEWER_PREVIEW_PORT`), UI-Bundle ist ein simples `<img src=…>`.
Pipeline: `MxlVideoInput ! tee` (Kurzform für „`appsrc`, gespeist von
`MxlVideoInput`s `GrainReader`-Thread, ! tee" — siehe C4-Korrektur) →
MJPEG-Zweig (+ optionaler `autovideosink`-Zweig über `OMP_VIEWER_SINK`
für Terminal-Start),
`sync=false` durchgehend (umgeht die Timestamp-Frage aus C4 für diesen
Pfad vollständig, analog `PreviewPipeline.js`). IS-04: 1 Receiver
(Transport `urn:x-omp:transport:mxl`, `caps.media_types=["video/v210"]`).
**Quellwahl über IS-05-Receiver-PATCH (`sender_id`)**: Viewer löst
Sender→`flow_id` über die Registry-Query-API auf und baut seine Pipeline
neu auf. Dadurch funktioniert **Drag & Drop im bestehenden Flow-Editor
(B3) sofort**, ohne Orchestrator-Änderung. Descriptor: fast leer (readonly
`connectedFlowId`, `previewUrl`).

**Verifikation:** Browser: Kante `omp-source` → `omp-viewer` im
Flow-Editor ziehen → Bild erscheint im Parameter-Panel; `pattern` am
Source ändern → Änderung sichtbar im Viewer, ohne manuellen Eingriff.

### C7 — `omp-switcher` (MXL ×N → Buttons → MXL)

**Ziel:** Dritter Demo-Service: der „Videomixer" — dynamische
Quellen-Auswahl per Button.

**Anweisung:** Neues Crate `nodes/omp-switcher`. Discovery **rein über
IS-04**: alle ~2 s `GET /x-nmos/query/v1.3/senders` pollen, nach
`transport == urn:x-omp:transport:mxl` filtern, eigenen Sender
ausschließen, Flows für Format/Label joinen (gleicher Poll-Stil wie A5,
`OMP_REGISTRY_URL` existiert bereits). Pipeline (aus `MasterPipeline.js`
übernommen, nicht neu erfunden): `input-selector name=isel
sync-streams=false ! MxlVideoOutput`; `sink_0` permanent ein
Schwarzbild-Fallback (`videotestsrc is-live=true pattern=black`), damit
der Ausgang auch bei null Quellen läuft; ein Zweig pro entdeckter Quelle
(`MxlVideoInput(flow) ! isel.sink_N`). **Ändert sich die entdeckte
Quellenmenge, wird die gesamte Pipeline neu aufgebaut** (PIPELINE
CONTROLLERs eigene Antwort auf einen geänderten Live-Quellen-Satz, keine
Erfindung) — die Ausgangs-`flow-id` bleibt über Neuaufbauten konstant,
damit Viewer weiter angeschlossen bleiben können. Descriptor: readonly
`inputs` (`[{senderId, label}]`), readonly `activeInput`, Methode
`select(senderId)` (braucht die C4-prep-Methoden-Argumente aus dem SDK).
UI-Bundle: ein Button pro Input, aktiver hervorgehoben. IS-04: 1
MXL-Sender + Flow; **0 Receiver in v0** — die Auswahl ist interner
Zustand, keine IS-05-Kante (dokumentierte, bewusste Abweichung von
§4.5a — ein diskoverybasierter Mixer mit unbegrenzten Eingängen passt
nicht auf vordeklarierte Receiver; wird beim echten Mixer-Node mit
Fixbudget-Receivern revidiert).

**Verifikation:** 2 `omp-source`-Instanzen + 1 `omp-switcher` + 1
`omp-viewer` starten, im Flow-Editor Switcher-Ausgang → Viewer verkabeln;
Button-Klick am Switcher wechselt nachweisbar das im Viewer sichtbare
Bild.

### C8 — GUI-Launch (Instanz-Launcher, `ARCHITECTURE.md` §6.2 Stufe 0)

**Ziel:** Die drei Demo-Services (und jeder künftige Node-Typ) lassen
sich aus der GUI heraus starten/stoppen, mehrfach instanziierbar.

**Anweisung:** `deploy/catalog.json` (`[{type, label, command[], env{}}]`,
`command` zeigt auf ein vorgebautes Binary; `make nodes` baut sie).
Orchestrator: neues Paket `internal/launcher` + API (`GET
/api/v1/catalog`, `GET /api/v1/instances`, `POST /api/v1/instances
{type}` → spawnt Subprozess mit `OMP_INSTANCE_ID`, `OMP_LABEL`,
`OMP_PORT=0`, Registry-/NATS-URLs; `DELETE /api/v1/instances/{id}` →
SIGTERM, Grace, SIGKILL). Persistenz `{id, type, pid}` im bestehenden
Datenverzeichnis, damit ein Orchestrator-Neustart noch laufende
Kind-Prozesse per PID-Check wiedererkennt statt sie zu verwaisen.
`omp-node-sdk`: `OMP_PORT=0` → an Port 0 binden, tatsächlichen Port lesen
und damit registrieren (macht Multi-Instanz portfrei); neuer IS-04-Tag
`urn:x-omp:instance` aus `OMP_INSTANCE_ID`. Flow-Editor: Palette mit
Katalog-Typen + Start-Button, Stop-Control an Kacheln mit Instanz-Tag;
der Launcher fasst den Graph selbst nicht an (Instanzen erscheinen über
die normale Selbstregistrierung).

**Verifikation:** Browser: komplette Trias (2× `omp-source`, 1×
`omp-switcher`, 1× `omp-viewer`) nur über die GUI starten, verkabeln,
bedienen (Button-Switch) und wieder stoppen — kein Terminal nötig.
Orchestrator neu starten, während Instanzen laufen → sie bleiben am
Leben und erscheinen weiter in `/api/v1/instances`.

### C9 — Contract-Konformitätstest

**Ziel:** Der Node-Contract (`ARCHITECTURE.md` §5) wird maschinell prüfbar —
Grundstein für Community-Nodes.

**Anweisung:** `tools/contract-check/` (Go): prüft gegen einen laufenden
Node alle Contract-Punkte (IS-04-Registrierung, Descriptor valide gegen
Schema, Param-Roundtrip, optional UI-Manifest, IS-05 vorhanden). In CI
für Mock-, Playout-, `omp-source`-, `omp-viewer`- und `omp-switcher`-Node
ausführen.

**Verifikation:** `make contract NODE_URL=…` grün für alle fünf Node-Typen;
absichtlich kaputter Descriptor → Check schlägt mit klarer Meldung fehl.

**→ Meilenstein „Demo 2":** Test-Quellen, Switcher und Viewer werden aus
der GUI gestartet, per MXL Zero-Copy verschaltet und live geschaltet. Ab
hier ist das Projekt öffentlich zeigbar (Call for Nodes) — zeigt die
Plattform-These (modulare Nodes, Standard-Discovery, Zero-Copy-Transport)
direkt, nicht nur ein einzelnes Node-Feature.

### C10/C11 — Playout v1 (später, nach Demo 2)

**Ziel:** Der echte, playlist-fähige Playout-Node, jetzt mit dem
korrekten Pipeline-Muster.

**Anweisung (Kurzfassung, Detailplan zu Beginn von C10):** Player-per-Slot
als eigene, durchgehend laufende Pipelines (analog
`PlayerPipeline.js`/`MasterPipeline.js`), die MXL publizieren; eine
Selector-Stufe konsumiert. `playlist.rs` vom Branch `c4-playlist-wip`
(reine Logik, 12 Tests, unverändert brauchbar) wird wiederverwendet.
Anschließend C5 aus der alten Zählung (Playout-UI-Bundle: Playlist-Liste,
Cue/Take-Buttons, Fortschrittsbalken über die generische Param/Method-API).

**Verifikation:** Wie ursprünglich für C4/C5 vorgesehen (Playlist mit 2
Clips, `take()` schaltet nachweisbar um, automatischer Übergang laut
`mode`, Tally im Graph zeigt On-Air) — plus: kein Buffer-Stillstand über
mehrere Slot-Wechsel hinweg (der C4-Bug, jetzt durch das andere
Pipeline-Muster strukturell ausgeschlossen, nicht nur gefixt).

**→ Meilenstein „Demo 3":** Echtes Playout mit Playlist, grafisch
verschaltet und bedient.

---

## 6. Phase D — Hardening & SDK-Release (Überblick)

Grob geschnitten, Detail-Schritte werden am Ende von Phase C konkretisiert:

- **D1** PostgreSQL (Quadlet) für Layouts/Snapshots/Config statt
  Datei-Backend; Migrationen; Verifikation: Neustart-Persistenz.
- **D2** AMWA NMOS Testing Tool als CI-Container gegen Registry + Nodes;
  Verifikation: definierte Testliste grün, Abweichungen dokumentiert.
- **D3** step-ca + mTLS Orchestrator↔Nodes, IS-10/OAuth2 für die UI;
  Verifikation: unautorisierter Zugriff wird abgewiesen, Flows
  funktionieren mit Token.
- **D4** `omp-mediaio`: 2110-Implementierung (Software, `st2110`-fähige
  GStreamer-Elemente) + SRT-Gateway-Node; Verifikation soweit ohne
  Spezial-Hardware möglich (Loopback, Interop mit ffmpeg/OBS). MXL selbst
  ist **nicht** mehr Teil von D4 — bereits in Phase C (C4) gebaut, siehe
  `docs/decisions.md` 2026-07-09.
- **D5** SDK-Doku + Beispiel-Node-Tutorial („in 1 Stunde zum eigenen Node")
  — Qualitätsmaßstab: eine dritte Person schafft es nur mit der Doku.
- **D6 (geplant, noch nicht detailliert)** Resource-Aware Placement &
  Live-Migration: Host-Telemetrie über NATS, Placement-Engine
  (advisory zuerst), Make-before-break-Migrationsprotokoll —
  Konzept siehe `ARCHITECTURE.md` §6.1. Node-Contract-Grundlage
  (State-Export/Import + Readiness-Signal, §5 Punkt 6) muss vor dem
  SDK-v1-Freeze (Ende Phase C) stehen, auch wenn D6 selbst erst hier
  detailliert und umgesetzt wird — auf dem Single-Host-Dev-Rechner ohnehin
  nur das Protokoll simulierbar, nicht der Ausfallfreiheits-Anspruch
  selbst.
- **D7 (geplant, noch nicht detailliert)** Workflow-Bereitstellung &
  -Verteilung: neues Objekt „Workflow" (Rollen + Verbindungs-Template +
  Platzierungs-Hinweise), Katalog-Descriptor (optional pro Node), Start/
  Stop ganzer Bundles (Quadlets bare-metal, Helm-Äquivalent cloud) —
  Konzept siehe `ARCHITECTURE.md` §6.2. Teilt den Host-Telemetrie-/
  Start-Agenten mit D6, deshalb zusammen mit D6 sequenziert, nach D4
  (2110). Anders als D6 **kein** Node-Contract-Zusatz vor dem
  SDK-Freeze nötig (Katalog-Descriptor ist rein additiv, nachrüstbar).
  „Stufe 0" davon (einfacher Instanz-Launcher, ein Host, Prozesse statt
  Bundles) ist bereits in Phase C (C8) vorgezogen, siehe
  `ARCHITECTURE.md` §6.2 und `docs/decisions.md` 2026-07-09; D7 baut
  darauf zum vollen Workflow-Objekt aus, ersetzt es nicht.

---

## 7. Status-Checkliste (von Claude nach jedem Schritt pflegen)

| Schritt | Status | Commit | Datum |
|---|---|---|---|
| A1 | erledigt | [A1] Repo-Struktur & Werkzeuge | 2026-07-07 |
| A2 | erledigt | [A2] NATS als Quadlet (Dev-Fallback: podman run) | 2026-07-07 |
| A3 | erledigt | [A3] NMOS-Registry (nmos-cpp) | 2026-07-07 |
| A4 | erledigt | [A4] Go-Orchestrator-Skeleton | 2026-07-07 |
| A5 | erledigt | [A5] Registry-Anbindung: Node-Inventar | 2026-07-07 |
| A6 | erledigt | [A6] Event-Bus-Anbindung + Live-Updates | 2026-07-07 |
| A7 | erledigt | [A7] Mock-Node omp-mock | 2026-07-07 |
| A8 | erledigt | [A8] Descriptor v0 + Parameter-Proxy | 2026-07-07 |
| A9 | erledigt | [A9] CI-Grundgerüst | 2026-07-07 |
| B1 | erledigt | [B1] Graph-API im Orchestrator | 2026-07-07 |
| B2 | erledigt | [B2] SVG-Canvas Pan/Zoom | 2026-07-07 |
| B3 | erledigt | [B3] Drag & Drop-Verbindungen | 2026-07-07 |
| B4 | erledigt | [B4] Live-Status-Overlay | 2026-07-07 |
| B5 | erledigt | [B5] Gruppen/Verschachtelung | 2026-07-07 |
| B6 | erledigt | [B6] Parameter-Panel + Node-UI-Bundles | 2026-07-07 |
| B7 | erledigt | [B7] Snapshots/Szenen | 2026-07-08 |
| C1 | erledigt | [C1] Rust-Workspace + omp-node-sdk Skeleton | 2026-07-09 |
| C2 | erledigt | [C2] GStreamer-Grundpipeline | 2026-07-09 |
| C3 | erledigt | [C3] Netz-Ausgang (RTP, 2110-vorbereitet) | 2026-07-09 |
| C4-prep | erledigt | [C4-prep] SDK: Methoden-Argumente im generischen Method-Dispatch | 2026-07-09 |
| C4 | erledigt | [C4] MXL-Fundament (install-mxl.sh + omp-mediaio::mxl + SDK-Transport/Flow) | 2026-07-09 |
| C5 | erledigt | [C5] omp-source: Test-Videoquelle → MXL (+ IS-04-Flow-Schema-Fix) | 2026-07-10 |
| C6 | erledigt | [C6] omp-viewer: MXL → MJPEG-Preview (+ SDK: ReceiverSpec/ReceiverConnection) | 2026-07-10 |
| C7 | erledigt | [C7] omp-switcher: MXL ×N → Buttons → MXL | 2026-07-10 |
| C8 | erledigt | [C8] GUI-Launch: Instanz-Launcher (Katalog, Start/Stop, Restart-Persistenz) | 2026-07-10 |
| C9 | offen | | |
| C10/C11 | offen (später) | | |
