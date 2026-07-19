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
| **C — Playout-Node, MXL-Demo-Trias & kleiner Regieplatz** (P1-Kern) | Rust + GStreamer, `omp-node-sdk`, RTP-Ausgang (C1–C3), MXL-Fundament + Source/Viewer/Switcher + GUI-Launch (C4–C8), Contract-Test (C9), kleiner manuell bedienter Regieplatz — Bildmischer/Audiomischer/Player/Operator-Console (C10–C13, resequenziert 2026-07-11), danach Playout-Automation-Controller (C14/C15) | C1–C9 (+ C10–C15 später) | 4–6 Monate (Schätzung vor Resequenzierung; siehe `ARCHITECTURE.md` §7.4 zum gemessenen Ist-Tempo) | ≈ 85–135 € |
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
Playlist-/Playout-Umbau folgt später als C14/C15 (nach dem kleinen
Regieplatz C10–C13, resequenziert 2026-07-11, siehe unten) und nutzt
`playlist.rs`
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

**Resequenziert (2026-07-11, `docs/decisions.md` und `ARCHITECTURE.md`
§7.4):** Playout-Automation wurde bewusst nach hinten gestellt — sie ruft
architektonisch nur dieselben IS-12/14-Methoden auf, die die manuell
bedienten Regieplatz-Nodes ohnehin brauchen (`ARCHITECTURE.md` §13.1/
§13.2/§13.3), sollte also nicht vor ihnen gebaut werden. Der Rest von
Phase C ist daher umsortiert: zuerst der kleine, manuell bedienbare
Regieplatz (C10–C13), danach die Playout-Automation-Vertiefung (C14/C15,
ehemals C10/C11).

### C10 — `omp-video-mixer-me` (Bildmischer-Minimalausbau)

**Ziel:** Erster §13.1-Referenzknoten — ein M/E-Bank-Prozess mit
Crosspoint + 1–2 DVE-Kanälen + 1 Keyer als `NcWorker` im selben `NcBlock`
(`ARCHITECTURE.md` §13.1/§11.1-Methodik), nicht als separate MXL-verkettete
Nodes. Baut auf `omp-switcher` (C7) als Ausgangspunkt auf (Discovery-Muster,
`input-selector`-Pipeline), erweitert um DVE/Keyer/Freeze und die
IS-12/14-Methodenschicht statt nur Button-Auswahl.

**Anweisung (Kurzfassung, Detailplan zu Beginn von C10):** Deskriptor +
Methoden gegen §13.1-Skizze modellieren, Klassennamen gegen aktuelle
MS-05-02-Spec verifizieren (§11.1 Punkt 2, nicht raten). Volle DVE/Keyer-
Tiefe (Chroma-Keying-Qualität, komplexe DVE-Transformationen) bleibt
Community-Scope (§7 P4-Zeile) — hier nur so viel, dass Take/Cut/AutoTrans/
einfacher Wipe/ein Keyer/ein DVE-Kanal vorführbar sind.

**Verifikation:** Zwei `omp-source`-Instanzen + `omp-video-mixer-me` im
Flow-Editor verkabelt; `take()`/`cut()` schalten nachweisbar um (Tally im
Graph), ein Keyer-Test (z. B. Farbfläche über Hintergrund) sichtbar im
Viewer (C6).

### C11 — `omp-audio-mixer` (Audiomischpult-Minimalausbau)

**Ziel:** §13.2-Referenzknoten — dynamische Kanalzahl
(`addChannel`/`removeChannel`), Gain/EQ-Grundklassen (Standardklassen
zuerst prüfen, §11.1 Punkt 2), Audio-Follow-Video gegen den
Tally-NATS-Bus des gekoppelten `omp-video-mixer-me` (C10).
Kompressor/Limiter/Expander/Aux/Gruppen können wie DVE/Keyer bei C10 als
Community-Vertiefung nachziehen (§7 P4-Zeile) — hier zuerst Gain/EQ/
Audio-Follow-Video als Minimalausbau.

**Verifikation:** Kanal per `addChannel()` zur Laufzeit hinzufügen (Panel
zeigt ihn ohne Neustart, B6-Descriptor-Re-Fetch); Crosspoint-Wechsel an
C10 löst nachweisbar die konfigurierte Audio-Follow-Video-Aktion aus.

### C12 — `omp-player` (Verallgemeinerung, manueller Modus)

**Ziel:** §13.3-Referenzknoten — verallgemeinert den `PlaylistController`-
Baustein (ursprünglich für Playout geplant, siehe `c4-playlist-wip`) zu
einem gemeinsamen Crate, das per UI-Bundle-Variante + Konfigurationsprofil
sowohl als Musik-/Jingle-Player als auch als Videoplayer auftritt.
Manueller Cue/Take-Betrieb zuerst — Automation folgt in C14/C15.

**Verifikation:** Zwei Instanzen (eine im Jingle-Grid-UI-Modus, eine im
Videoplayer-UI-Modus) aus dem Katalog gestartet, beide manuell bedienbar,
beide MXL-Output im Viewer sichtbar.

**Ergebnis (2026-07-12):** Cue/Take-Bedienung auf beiden Instanzen über
die generische Node-Proxy-API durchgespielt (siehe `docs/decisions.md`),
`tools/contract-check` PASS auf beiden inkl. korrektem UI-Manifest-Tag
pro Profil, MXL-Video-Flow korrekt angelegt, IS-05-Verbindung zum
Viewer-Receiver erfolgreich. **Offener Rest:** die visuelle Bestätigung
über `omp-viewer`s MJPEG-Preview-Endpoint war in dieser Sitzung nicht
möglich — ein reproduzierbares, von `omp-player` unabhängiges Problem in
`omp-viewer`s Preview-HTTP-Server (seit C6 unverändert, siehe
`docs/decisions.md` 2026-07-12), nicht Teil dieses Schritts. Vor dem
nächsten Schritt, der sich auf die visuelle Viewer-Prüfung verlässt,
separat diagnostizieren.

### C13 — Operator-Console (`ARCHITECTURE.md` §14)

**Ziel:** Zweite Shell-Ansicht neben dem Flow-Editor — ein Testnutzer mit
nur `operate` auf einer Node-Rolle (§12, sofern D3 zu diesem Zeitpunkt
schon steht — sonst mit einer vereinfachten Rollen-Stub-Prüfung
vorwegnehmen, echte Durchsetzung folgt mit D3) landet nach Login direkt
auf deren UI-Bundle, ohne Graph.

**Verifikation:** `GET /api/v1/me/consoles` liefert die erwartete Liste;
Browser-Test mit Test-Rollenbindung zeigt direkt das Panel von C10/C11/C12
statt des Flow-Editors.

**Ergebnis (2026-07-12):** Neues Orchestrator-Package `internal/consoles`
löst eine vereinfachte Rollen-Stub-Bindung (`data/role-bindings.json`,
handgepflegt wie `deploy/catalog.json`, echte Durchsetzung folgt mit D3)
gegen den Node-Bestand zu Konsolen-Einträgen auf — als stabile "Rolle"
dient die vom Instanz-Launcher vergebene `instance_id` (C8), nicht die
pro Prozessstart neu erzeugte IS-04-Node-ID. `GET /api/v1/me/consoles`
liefert `{hasEngineeringAccess, consoles: [...]}` (kleine, pragmatische
Erweiterung der in `ARCHITECTURE.md` §14 beschriebenen reinen Array-
Antwort um das Engineering/Console-Entscheidungssignal). Neue Shell
(`ui/shell/shell.ts`, jetzt einziger Bundle-Einstiegspunkt statt
`flow-canvas.ts` direkt) entscheidet danach zwischen `<omp-flow-canvas>`
(Engineering) und `<omp-console-view>` (Console, kein Graph, Tab-Leiste
nur bei mehreren Einträgen); Kiosk-Route `/console/<workflowId>/
<nodeRoleId>` per Server-seitigem SPA-Fallback auf `index.html`. Die
UI-Bundle-Lade-Logik wurde aus `flow-canvas.ts` in ein gemeinsames Modul
(`ui/shell/ui-bundle.ts`) extrahiert, das beide Ansichten nutzen.
„Aktueller Nutzer" ist mangels D3 ein reiner, trivial spoofbarer Stub
(Header/Query-Param/`localStorage`, Default `admin` = heutiges
Verhalten unverändert, solange keine Rollenbindungen gepflegt sind).

Per Browser-Test (Chromium headless, `--dump-dom`) end-to-end verifiziert:
Default-Nutzer sieht weiterhin den Flow-Editor; ein Stub-Operator mit
einer Bindung landet direkt und ausschließlich auf dem zugewiesenen
Node-Panel; zwei Bindungen zeigen die erwartete Tab-Leiste; die
Kiosk-Route liefert dieselbe Konsole direkt. Der Browser-Test deckte
dabei einen echten Bug auf (nicht durch `curl`/API-Tests sichtbar): ein
gemischter Werte-/Typ-Import (`import { ConsoleView, type ConsoleEntry }`)
wurde vom Bundler als reiner Typ-Import wegoptimiert, weil `ConsoleView`
im Modul nur in Typposition vorkam — das entfernte auch
`customElements.define(...)`, das Custom Element blieb unregistriert
(„`view.setEntries is not a function`"). Behoben durch einen getrennten
Seiteneffekt-Import.

**→ Meilenstein „Demo 3":** Kleiner, manuell bedienter Regieplatz —
Bildmischer, Audiomischer, Player, Live-Quellen, grafisch verschaltet und
über ein rollen-gescoptes Bedienpult (Operator-Console) statt nur den
Flow-Editor bedient. Mit C13 erreicht.

### C13-Nachtrag — omp-source-Audio, Kachel-Inline-Vorschau, omp-multiviewer (2026-07-12)

Drei kleine, additive Nutzeranforderungen direkt nach C13 umgesetzt
(kein eigener nummerierter Schritt, Details siehe `docs/decisions.md`
2026-07-12):

1. **`omp-source` bekommt einen Audio-Begleitton** (zweiter MXL-Sender,
   gleiches Muster wie `omp-player`, C12) — Testquellen liefern jetzt
   auch echtes Audio, nicht nur Video.
2. **Kachel-Inline-Vorschau im Flow-Editor:** jeder Node mit einem
   `previewUrl`-Parameter zeigt sein Bild jetzt direkt auf der
   Graph-Kachel (nicht nur im geöffneten Parameter-Panel).
3. **Neuer Node `omp-multiviewer`:** dynamische Eingangszahl (IS-04-
   Discovery wie `omp-switcher`, C7), zeigt aber alle entdeckten
   MXL-Video-Quellen gleichzeitig als Grid (`compositor`, C10s DVE-
   Technik) statt einer Auswahl; reiner MJPEG-Monitor, kein MXL-Ausgang.
   `omp-viewer`s MJPEG-Preview-Baustein (`preview.rs`) dafür nach
   `omp-mediaio` verschoben (neues Feature `preview`), damit sich beide
   Nodes ihn teilen.

**Zwei weitere Bugs per Browser-Test gefunden** (zusätzlich zum
C13-Fund): `consoles: null` statt `[]` von `GET /api/v1/me/consoles`
(Gos nie befüllter Slice serialisiert als `null`) crashte
`ui/shell/shell.ts`s Fallback-Check — doppelt behoben (Client
normalisiert, UND die API selbst liefert jetzt `[]`). Außerdem:
`chromium --headless=old --dump-dom` erwies sich für Seiten mit
mehreren sequenziellen `fetch()`-Ketten als unzuverlässig (leerer
Graph-Viewport auch bei nachweislich funktionierendem Dateistand) —
`chromium --headless=new --remote-debugging-port` + eine kleine
Node.js-CDP-WebSocket-Session mit echtem Warten war die zuverlässige
Alternative, für künftige Browser-Verifikationen in dieser Umgebung zu
bevorzugen.

**Verifiziert:** `cargo build/test/deny`, `go vet/test`,
`deno check/test` grün; End-to-End per CDP-Session (zwei Quellen + ein
Multiviewer: Discovery findet beide, Kachel-Grid zeigt genau die
Multiviewer-Inline-Vorschau, `GET .../preview` liefert echte
JPEG-Bytes), `tools/contract-check` PASS auf `omp-multiviewer`.

### C13-Nachtrag 2 — MXL-Origin-Index-Erhalt (§15), vier UI-Bugfixes (2026-07-12)

Details siehe `docs/decisions.md` 2026-07-12 (zweiter Eintrag desselben
Tages):

- **`omp-mediaio::mxl` reicht den Origin-Grain-Index jetzt durch**
  (`GstReferenceTimestampMeta`, additiv, kein Breaking Change) — löst die
  in `ARCHITECTURE.md` §15 Punkt 4 offen gelassene Voraussetzung für
  A/V/Daten-Synchronität; für Redundanz (§20.1) notwendig, aber nicht
  hinreichend. Zwei neue Tests in `omp-mediaio`.
- Vier vom Nutzer per Live-Test gefundene UI-Bugs behoben: Kacheln nach
  Reload außerhalb des Bildbereichs (Grundursache: unbegrenzt wachsende
  verwaiste Positions-Einträge, jetzt per `#pruneStalePositions()`
  bereinigt, plus Viewport-Persistenz), beide Ports einer Quelle
  gleichfarbig (jetzt nach Format statt nur input/output eingefärbt),
  Inline-Vorschau überragte den Kachel-Rahmen (Geometrie reserviert jetzt
  Platz dafür), fehlendes Quell-Label in Viewer/Multiviewer (UMD-
  `textoverlay`).
- **Zwei Laufzeit-Abstürze per Live-Test gefunden**, die `cargo build`
  nicht zeigt: `textoverlay`s `valignment`/`halignment` sind GEnums, kein
  String-Property (`.property()` kompiliert, crasht aber beim ersten
  echten Connect) — behoben mit `set_property_from_str`. Ein einmaliger
  OOM-Kill von `omp-multiviewer` (5,75 GB RSS) trat auf, war aber trotz
  gezielter Nachstellung nicht reproduzierbar — vermutlich
  Ressourcenengpass durch einen parallel laufenden `cargo build` auf
  einer 6,5-GB-RAM-Maschine, kein Code-Bug gefunden.

**Verifiziert:** `cargo build/test/deny` (inkl. neuer mxl.rs-Tests),
`deno check/test`, End-to-End per CDP-Session mit echten Instanzen (alle
vier UI-Fixes und beide Absturz-Fixes am laufenden Node bestätigt),
`tools/contract-check` PASS.

### C13-Nachtrag 3 — Instanz-Crash-Erkennung & Palette-UI, „Alle einpassen" (2026-07-13)

**Ziel (Nutzerfund):** Eine per Instanz-Launcher (C8) gestartete Instanz,
die abstürzt, **bevor** sie sich bei der NMOS-Registry registriert (z. B.
ein Pipeline-Init-Fehler), verschwand bisher spurlos — kein
`node.added`/`node.removed`-Event, also keine Kachel, kein Hinweis in der
UI. „Crash muss angezeigt werden."

**Umsetzung (als uncommitted Stand vorgefunden, in dieser Sitzung
verifiziert und fertiggestellt, kein Neubau):**

- `internal/launcher`: `Instance` bekommt `Crashed`/`CrashMessage`;
  `Launcher.Start()`s Wait()-Goroutine markiert einen Prozess, der ohne
  vorheriges `Stop()` endet, als `Crashed` (persistiert, bleibt in
  `List()` sichtbar statt zu verschwinden) und broadcastet
  `instance.crashed` über ein neues, optionales `EventPublisher`-Interface
  (von `*sse.Hub` erfüllt, `nil`-fähig für Tests — gleiches Muster wie
  `graph.EventPublisher`). `CrashMessage` kombiniert den `Wait()`-Fehler
  mit den letzten 5 stderr-Zeilen der Instanz (neuer `tailBuffer`,
  nebenläufig sicher, kein `bufio.Scanner` nötig, da `cmd.Stderr` nur
  einen `io.Writer` erwartet).
- `ui/graph/flow-canvas.ts`: SSE-Handler für `instance.crashed` zeigt
  einen Toast und rendert die Palette neu; jede laufende/abgestürzte
  Instanz erscheint als eigene Zeile unter ihrem Katalog-Eintrag
  (`data-role="instance-row"`) — rot mit Fehlertext + „Entfernen" bei
  Crash, sonst grün mit „Stop". Start/Stop rendern die Palette jetzt
  explizit neu (vorher verließ sich der Code allein auf den
  `node.added`/`node.removed`-Registry-Pfad, der eine nie registrierte,
  abgestürzte Instanz nie auslöst).
- Zusätzlich (gleicher uncommitted Stand, unabhängiger Nutzerfund): Button
  „Alle einpassen" in der Breadcrumb-Leiste fittet die im aktuellen Scope
  sichtbaren Kacheln in den Viewport (`#fitAllToViewport`, teilt die
  Bounding-Box-Logik mit dem bestehenden Auto-Fit-Fallback über eine neue
  gemeinsame `#fitViewportToIds`-Methode) — Abhilfe für Kacheln, die nach
  vielen Sitzungen mit verwaisten/neuen Positionen optisch außerhalb des
  sichtbaren Bereichs lagen.

**Verifiziert in dieser Sitzung:** `go vet/test` (inkl. neuem
`TestLauncherMarksUnexpectedExitAsCrashedAndBroadcasts`), `deno
check/test` — beides grün. End-to-End per CDP-Session (Chromium headless
+ Node-WebSocket, gleiche Methode wie C13-Nachtrag 1/2) gegen die echte
laufende Dev-Umgebung (`make start`), mit einem temporären
Katalog-Eintrag, der garantiert abstürzt (`exit 1` nach `sleep 1`, nicht
committet): Toast „… abgestürzt: exit status 1: boom-from-test" erscheint,
rote Instanz-Zeile mit derselben Fehlermeldung erscheint unter dem
Katalog-Eintrag, „Entfernen" löscht die Instanz serverseitig
(`GET /api/v1/instances` danach `[]`) und aus der UI; „Alle einpassen"
klickbar ohne Fehler. `deploy/catalog.json` nach dem Test unverändert
wiederhergestellt (Diff-Check gegen Backup: keiner).

### C14/C15 — Playout-Automation-Controller (vormals C10/C11, jetzt danach)

**Ziel:** Dünne Sequenzierungsschicht, die `playlist.rs`
(`c4-playlist-wip`, reine Logik, 12 Tests, unverändert brauchbar)
wiederverwendet, aber **keine eigene Medienpipeline mehr baut** — sie ruft
dieselben IS-12/14-Methoden von C10/C11/C12 auf, die der manuelle
Regieplatz bereits bereitstellt (`ARCHITECTURE.md` §13.1–§13.3: „dieselben
Methoden, keine zweite API"). Der ursprünglich für C1–C3 gebaute
RTP-Referenz-Playout-Node bleibt unverändert im Repo (kein Rückbau) und
zählt als eine mögliche `omp-player`-Instanz.

**Anweisung (Kurzfassung, Detailplan zu Beginn von C14):**
Playlist-Controller-Node, der `load()/append()/remove()/cue()/take()`
gegen die Ziel-Node-Methoden (Player/Mixer) statt gegen eine eigene
Pipeline ausführt; UI-Bundle: Playlist-Liste, Cue/Take-Buttons,
Fortschrittsbalken über die generische Param/Method-API.

**Verifikation:** Playlist mit 2 Clips, `take()` schaltet nachweisbar auf
C12 um, automatischer Übergang laut `mode`, Tally im Graph zeigt On-Air —
plus: kein Buffer-Stillstand über mehrere Slot-Wechsel hinweg (der
C4-Bug, durch das C10-C13-Pipeline-Muster strukturell ausgeschlossen,
nicht nur gefixt).

**→ Meilenstein „Demo 4":** Regieplatz mit UND ohne Automatisation
vorführbar — Playout steuert dieselben Nodes, die der Operator manuell
bedient. Mit C14/C15 erreicht.

**Detailplan (zu Beginn von C14, wie oben verlangt):** neuer Node
`omp-playout-automation`, bewusst **ohne** `omp-mediaio`/GStreamer-
Dependency (senders=[]/receivers=[] im `NodeConfig` — ein reiner
Control-Plane-Node). Kernentscheidungen, die die Kurzfassung offen
gelassen hatte:

1. **Ziel-Auflösung dynamisch statt hartkodiert:** `targetPlayerLabel`/
   `targetMixerLabel` sind zwei neue **beschreibbare** Parameter (PATCH
   über den bestehenden generischen Proxy) statt eines Katalog-Env-Werts
   — der Instanz-Launcher (§6.2 Stufe 0) kennt keine Start-Parameter
   jenseits des festen Katalog-`env`, ein neuer Launcher-Mechanismus wäre
   für diesen Schritt unverhältnismäßig gewesen. Ein neuer,
   IS-04-registry-weiter Discovery-Loop (2 s-Takt, gleiches Muster wie
   C7/C10) löst die Labels laufend zu `href`s auf — selbstheilend, falls
   der Ziel-Node neu startet.
2. **`playlist.rs` reicht Item-**IDs** durch, nicht mehr URIs:** der
   Ziel-`omp-player` (C12) vergibt seine Item-IDs selbst beim
   `append`/`load` — die generische Methoden-Antwort liefert keinen
   Rückgabewert (nur `{"ok":true}`, A8), deshalb liest die Automation
   nach jedem `append`/`load` einmal `GET items` zurück und übernimmt die
   dort vergebenen IDs 1:1 als eigene Playlist-Einträge (Diff gegen den
   vorher bekannten Bestand für `append`, komplette Übernahme für
   `load`). Eine neue, additive `Playlist::replace_all()`-Methode
   (mit Tests) ergänzt das wiederverwendete `playlist.rs`, weil dessen
   ursprüngliches `load()` nur ein einzelnes Item kannte.
3. **`take()` treibt zwei Ziele, nicht nur den Player:** `omp-player`
   selbst hat keinen Tally-Mechanismus — Tally kommt ausschließlich vom
   Ziel-Mixer (`omp-video-mixer-me`, C10), sobald dessen Programmbus
   wechselt. `take()`/Auto-Advance rufen deshalb **beide** Ziele:
   Player-`cue`+`take`, danach Mixer-`crosspoint.select`(Sender-ID des
   Ziel-Players, aufgelöst über dessen `crosspoint.inputs` und den
   `"{Label} Sender"`-Präfix, den `omp-node-sdk::node::start` immer
   vergibt) + `crosspoint.cut` — löst automatisch das bereits bestehende
   Tally-Event aus (`ProgramChanged` in `omp-video-mixer-me`), keine
   eigene Tally-Logik nötig.
4. **Auto-Advance ohne Pipeline-EOS:** `omp-player`s Items laufen
   endlos (kein EOS-Konzept). Die Automation hält deshalb ihren eigenen
   Dauer-Timer (200 ms-Tick, gegen die pro Item deklarierte `durationMs`)
   und ruft bei Ablauf `playlist.rs`s `advance()` — reine
   Fortsetzung des wiederverwendeten Musters, keine neue Sequenzierungs-
   Idee.
5. **Fernaufrufe direkt Node-zu-Node** (`src/remote.rs`, `PeerClient`):
   spricht denselben Descriptor-HTTP-Server jedes Ziel-Nodes
   (`GET/PATCH params/<name>`, `POST methods/<name>`) direkt an dessen
   IS-04-`href` an — kein Umweg über den Orchestrator-Proxy nötig (der
   ist nur die Browser-Fassade derselben API, A8). Neue
   `RegistryClient::list_nodes()` in `omp-node-sdk::is04` für die
   Label→href-Auflösung.

**Verifiziert:** `cargo build/test/deny`, `cargo audit` (Workspace,
inkl. der bereits vorhandenen `omp-mediaio`-MXL-Tests, `deploy/dev/
mxl.env` gesourct) — grün. End-to-end **mit echten laufenden Prozessen**
(nicht nur Mock): `omp-video-mixer-me` + `omp-player-video` +
`omp-playout-automation` + `omp-viewer` aus der GUI gestartet,
`targetPlayerLabel`/`targetMixerLabel` per PATCH gesetzt (`connected`
wurde `true`), zwei Items per `append()` angelegt (IDs korrekt vom
Player übernommen), `take()` geprüft: Player-`currentItemId` wechselt
auf das genommene Item, Mixer-`crosspoint.programInput` zeigt danach
exakt die Sender-ID des Ziel-Players — der Take hat den Mixer
nachweisbar umgeschaltet. Auto-Advance im `auto`-Modus über beide
Playlist-Einträge hinweg bestätigt (Player zeigt am Ende `currentItemId
= item2`, `mode = onair`), Ende-der-Liste stoppt korrekt ohne Loop
(automationseitig `on_air = false`, `cuedItemId` bleibt auf dem letzten
Item stehen — deckungsgleich mit dem aus `playlist.rs` übernommenen,
bereits unit-getesteten Verhalten). UI-Bundle live gegen den echten
Node gemountet (Chromium-CDP, gleiche Methode wie C13-Nachtrag 1–3):
zeigt korrekt „verbunden", Item-Liste mit Label/Pattern/Dauer,
Cue/Gecued-Zustand und das gesetzte Ziel-Player-Label.

**Bekannter, dokumentierter Nebenbefund (kein C14/C15-Bug):** ohne
`deploy/dev/mxl.env` im selben Shell wie `make start` scheitern
MXL-nutzende Nodes beim Start („libmxl.so … cannot open shared object
file") — bereits als Dev-Environment-Gotcha bekannt, hier nur erneut
bestätigt. Zusätzlich: ein zuvor mit `rm -rf` gelöschtes
`/dev/shm/omp-mxl` muss vor dem nächsten Node-Start als (leeres)
Verzeichnis wieder angelegt werden, sonst meldet MXL „Failed to create
MXL instance" — nicht behoben (Testhygiene, kein Code-Fix nötig).

---

## 6. Phase D — Hardening & SDK-Release (Überblick)

Grob geschnitten, Detail-Schritte werden am Ende von Phase C konkretisiert:

- **D1 (erledigt, 2026-07-13)** PostgreSQL (Quadlet-Referenz +
  Podman-Dev-Fallback, gleiches Muster wie NATS/Registry) für Layouts
  (B5) und Snapshots (B7) statt Datei-Backend; embedded SQL-Migrationen
  (`orchestrator/internal/db`, kein Migrations-Framework — Minimal-
  Dependency-Begründung siehe dortiger Docstring). **Scope-Entscheidung:**
  „Config" aus der ursprünglichen Kurzfassung bezieht sich nicht auf
  `role-bindings.json` (bleibt handgepflegt wie `deploy/catalog.json`,
  echte D3-Rollenverwaltung folgt später) oder den Instanz-Launcher-
  Zustand (`instances.json`, PID-gebundenes Laufzeit-Bookkeeping, kein
  Metadaten-Persistenz-Fall) — beide bleiben bewusst datei-basiert, nur
  Layouts/Snapshots wandern nach Postgres. `lib/pq` als einzige neue
  Go-Dependency (reiner Wire-Protocol-Treiber, keine eigenen
  Transitiv-Abhängigkeiten, gleiche Ausnahme-Kategorie wie `nats.go`).
  Verifikation: `go test` grün gegen echtes Postgres (`make up`),
  Neustart-Persistenz live geprüft (Layout + Snapshot über die API
  angelegt, Orchestrator-Prozess neu gestartet, Postgres läuft durch —
  beides exakt byte-/inhaltsgleich wieder da), Fail-Fast bei nicht
  erreichbarem Postgres verifiziert (klare Fehlermeldung + Exit statt
  stillem Weiterlaufen ohne Persistenz). Zwei echte Bugs beim Testen
  gegen eine echte DB gefunden und behoben (Details siehe
  `docs/decisions.md` 2026-07-13): ein `pg_advisory_lock` um
  `Migrate()`, weil `CREATE TABLE IF NOT EXISTS` in Postgres nicht
  race-frei gegen parallele Erstversuche ist (traf `go test ./...`, das
  jedes Go-Paket als eigenen Prozess startet); `layouts.data` als
  `JSON`-Spalte statt `JSONB`, weil JSONB Whitespace/Schlüsselreihenfolge
  kanonisiert und damit die vom Datei-Backend gewohnte Byte-Treue
  gebrochen hätte (für Snapshots unkritisch, dort JSONB belassen).
- **D2 (erledigt, 2026-07-13)** AMWA NMOS Testing Tool
  (`docker.io/amwa/nmos-testing`) in CI gegen unsere nmos-cpp-Registry
  (Suite IS-04-02, Registration+Query API) — **nicht** gegen eigene
  Nodes: am echten Tool-Lauf verifiziert (nicht geraten), dass IS-04-01
  (Node API) und IS-05-01 (Connection API) gegen unsere Nodes sofort mit
  0 ausgeführten Tests abbrechen, weil (a) unsere Nodes bewusst kein
  eigenständiges IS-04-„Node API" implementieren (Registration-API-Push
  statt Peer-to-Peer-Discovery, `ARCHITECTURE.md` §3/§5) und (b) die
  IS-05-Basis-Discovery-Endpunkte (`/x-nmos/connection/v1.1/`,
  `/single/receivers/`) noch fehlen (nur `staged`/`active` pro Receiver,
  Schritt B1) — kein sinnvolles CI-Gate für etwas, das architektonisch
  noch gar nicht existiert. Kandidat für später, sobald diese Endpunkte
  gebaut werden.

  **Definierte Testliste (IS-04-02):** 70 von 73 auswertbaren Tests grün,
  drei begründete, am Tool-Quellcode nachvollzogene Abweichungen (kein
  Raten): `test_01`/`test_02` (mDNS-Advertisement — OMP verbindet über
  eine feste `OMP_REGISTRY_URL`, kein Zero-Config-Discovery, dieselbe
  Design-Entscheidung wie `ARCHITECTURE.md` §18.2 für Host-Discovery),
  `test_27` (Registry-Ressourcen-Ablauf nach Heartbeat-Timeout — unsere
  `registration_expiry_interval` steht bewusst auf 60 s,
  `deploy/nmos/registry.json`, das AMWA-Tool nimmt intern 12 s an,
  `nmostesting/Config.py::GARBAGE_COLLECTION_TIMEOUT`; mit testweise auf
  12 s gesetztem Intervall lief `test_27` tatsächlich grün — die
  Ursache ist damit belegt, nicht vermutet. 60 s bleibt der Produktions-
  /Dev-Wert, kein Kompromiss für den Test). Neues Tool
  `tools/nmos-conformance-check` (Go, eigenes Modul wie
  `tools/contract-check`) wertet die AMWA-JSON-Ausgabe gegen eine
  explizite `--allow "testname=Begründung"`-Liste aus — jede Ausnahme
  einzeln benannt, kein stilles Ignorieren. CI-Job
  `amwa-nmos-testing` (`.github/workflows/ci.yml`) nicht mehr
  deaktiviert, lädt die Ergebnisdatei zusätzlich als Artefakt hoch.
- **D3 (Teil 1: mTLS, erledigt, 2026-07-13)** step-ca + mTLS
  Orchestrator↔Nodes. **Scope-Entscheidung:** D3 bündelte ursprünglich
  drei Themen (mTLS, IS-10/OAuth2 für die UI, §12-Rollenmodell) — dieser
  Schritt deckt nur mTLS ab, weil §18.3 (Host-Agent-Bootstrap) mTLS/
  step-ca bereits als Voraussetzung voraussetzt, während IS-10/§12 nichts
  Bestehendes blockieren (die C13-Rollen-Stub funktioniert weiter unver-
  ändert). IS-10/OAuth2 + §12-Rollenmodell bleiben offener D3-Restscope
  (Teil 2, noch nicht terminiert).

  **Weitere Scope-Grenze innerhalb "mTLS":** nur die Go-Seite
  (Orchestrator-Client + `nodes/mock`-Server) — der Rust-`omp-node-sdk`-
  Server (`tiny_http`, kein eingebautes TLS) bräuchte eine eigene,
  größere Ausbaustufe (TLS-Terminierung + neue Dependency), betrifft
  potenziell alle 10 Rust-Node-Typen gleichzeitig; bewusst nicht in
  diesem Schritt riskiert. mTLS ist durchgehend **opt-in**
  (`OMP_MTLS_ENABLED`, Default aus) — alle bisher verifizierten Flows
  laufen unverändert ohne Zertifikate weiter, ein gemischter Bestand aus
  mTLS- und Klartext-Nodes funktioniert gleichzeitig (der Orchestrator-
  Client wählt automatisch anhand des `http://`/`https://`-Schemas im
  Node-`href`).

  **Umsetzung:** step-ca (`smallstep/step-ca`) als eigener, von `make up`
  getrennter Dev-Service (`make mtls-up`) — getrennt, weil mTLS opt-in
  ist und der normale Dev-Workflow keinen CA-Container braucht.
  `deploy/dev/mtls-issue-cert.sh` stellt Zertifikate über einen
  Wegwerf-Container aus (`step`-CLI ist im offiziellen step-ca-Image
  bereits enthalten, verifiziert — kein `step`-CLI auf dem Host nötig,
  gleiches Muster wie das AMWA NMOS Testing Tool, D2). Neue Pakete
  `orchestrator/internal/mtls` (Client-TLS-Config) und
  `nodes/mock/internal/mtls` (Server-TLS-Config,
  `ClientAuth: RequireAndVerifyClientCert`) — kein Cross-Modul-Import
  (getrennte Go-Module), bewusste kleine Duplikation statt eines dritten
  Moduls.

  **Drei reale Probleme beim Live-Test gefunden, nicht vorhergesehen**
  (Details siehe `docs/decisions.md` 2026-07-13): (1) Rootless-Podman-
  Bind-Mount-Berechtigungsfehler beim Schreiben in `.run/step-ca` —
  behoben mit `--userns=keep-id`. (2) step-ca lehnt Zertifikate länger
  als 24h ab (`maxTLSCertDuration`-Default) — Skript auf 23h angepasst,
  echte Erneuerungs-Automatik bleibt offener Scope. (3) **Echter Bug,
  nicht nur Test-Artefakt:** ein mit dem bloßen Node-Label als Subject
  ausgestelltes Server-Zertifikat hat keine zum tatsächlichen
  Verbindungs-Hostnamen (`127.0.0.1`/`localhost`) passenden SANs — jeder
  TLS-Client (auch der Orchestrator selbst) hätte die Server-Hostname-
  Verifikation verweigert. Gefunden durch einen echten `curl`-Test
  **vor** der Erfolgsmeldung, nicht danach — behoben durch `--san`-
  Parameter im Ausstellungs-Skript.

  **Verifiziert (echte Prozesse, nicht nur Unit-Tests):** unautorisierter
  Zugriff abgewiesen (`curl` ohne Client-Zertifikat gegen einen mTLS-
  Node → Verbindungsabbruch); autorisierter Zugriff über den **echten
  Orchestrator-Proxy-Codepfad** (nicht nur curl-Emulation) erfolgreich
  (GET descriptor, PATCH param); gemischter Bestand aus mTLS- und
  Klartext-Node gleichzeitig funktionsfähig; Default (mTLS aus) exakt
  wie vor D3 — kein Regressionsrisiko für die bereits verifizierten
  Demo-1–4-Flows. `go vet`/`go test` für beide Module grün (neue
  `mtls`-Pakete inkl. Zertifikats-Generierung in den Unit-Tests, kein
  externer step-ca für reine Unit-Tests nötig).
- **D3 (Teil 2: Nutzer-/Rollenmodell, erledigt, 2026-07-14)**
  ARCHITECTURE.md §12 umgesetzt: lokale Nutzerkonten + Token-Ausstellung
  (`internal/auth`, bcrypt + handgebautes HS256-JWT), Rollenbindungen von
  `data/role-bindings.json` (C13-Stub) nach Postgres (`internal/authz`,
  neue Admin-API `/api/v1/admin/role-bindings`), zentrale Durchsetzung
  im Orchestrator (`internal/httpapi/auth_middleware.go`: node-gescopte
  `operate`-Prüfung für den generischen Proxy, globale `configure`/
  `admin`-Prüfung für Graph/Layouts/Snapshots/Launcher/Admin-Endpunkte),
  Audit-Log (`internal/audit`, `GET /api/v1/admin/audit-log`). UI
  (`ui/shell/auth.ts`): Login-Formular ersetzt den C13-Stub-Nutzer-Header,
  globaler `fetch()`-Wrapper hängt den Bearer-Token an.
  **Scope-Entscheidung:** AD/LDAP-Anbindung (§12 Punkt 1) nicht in dieser
  Runde — kein testbarer Verzeichnisdienst auf der Dev-Maschine (§0
  Punkt 7), Identität hinter einem Interface gekapselt, additiv
  nachrüstbar. **Bootstrap-Muster aus PIPELINE CONTROLLER:** "Auth
  deaktivierbar solange kein Nutzer angelegt ist" — solange niemand
  einen Nutzer anlegt, bleibt der Orchestrator exakt wie vor diesem
  Schritt offen, kein Regressionsrisiko für Demo 1–4. Details, Verb-
  Zuordnung pro Endpunkt-Gruppe und vollständiges Live-Verifikations-
  protokoll (curl + Browser-Test per CDP) siehe `docs/decisions.md`
  2026-07-14.
- **D4 (erledigt, 2026-07-13)** `omp-mediaio`: neues Modul
  `st2110` (`St2110VideoOutput`/`St2110VideoInput`) — echtes
  RFC-4175/SMPTE-ST-2110-20-Payload-Format über `rtpvrawpay`/
  `rtpvrawdepay`, konfigurierbare Auflösung/Framerate (anders als das
  unverändert bleibende `rtp.rs` aus C3, dort fest 640×480, nur
  Sender). Neuer Referenz-Node `omp-srt-gateway`
  (`ARCHITECTURE.md` §6: "Cloud-Gateway-Node bridged ST 2110 ⇄
  SRT/RIST") — gerichtet je Instanz (`OMP_SRT_GATEWAY_DIRECTION=
  uplink|downlink`, gleiches Profil-Muster wie `omp-player`), baut auf
  `st2110` auf statt die RTP-Payload-Logik zu duplizieren.

  **Scope-Entscheidung (dokumentiert, nicht stillschweigend
  ausgelassen):** kein Audio (ST 2110-30 — eigene Payloader-Familie,
  eigene Verifikation, separater Baustein), keine PTP-Zeitbasis
  (GStreamer hat eingebaute PTP-Unterstützung, aber echte Synchronität
  lässt sich auf der Single-Host-Dev-Maschine ohne zweiten PTP-Host
  nicht sinnvoll verifizieren — läuft im Free-Run, `ARCHITECTURE.md`
  §8 tolerierte das bereits), keine dynamische IS-05-Verbindungs-
  verwaltung für die 2110-/SRT-Seite des Gateways (Endpunkte sind
  Prozess-Start-Konfiguration, kein Drag&Drop — analog zur bewussten
  Vereinfachung bei `omp-switcher`, C7). `omp-srt-gateway` registriert
  sich deshalb ohne IS-04-Sender/-Receiver — bereits bestehendes,
  dokumentiertes Verhalten von `tools/contract-check`
  ("keine Sender/Receiver deklariert" ist ein Skip, kein Fail, gleiches
  Muster wie bei `omp-switcher`).

  **Verifiziert — durchgehend mit echten Prozessen/echtem Drittanbieter-
  Tool, nicht nur Mocks:**
  - `cargo test` (neuer `st2110`-UDP-Loopback-Test, GStreamer-only, kein
    `libmxl.so` nötig) grün, mehrfach wiederholt.
  - **Echter Interop-Test mit ffmpeg** (nicht nur GStreamer-intern):
    unser `St2110VideoOutput` sendet einen echten SMPTE-Farbbalken-
    Stream, ffmpeg empfängt ihn ausschließlich über die von
    `St2110VideoOutput::sdp()` erzeugte SDP-Datei, erkennt Auflösung/
    Format/Framerate korrekt und dekodiert reale PNG-Frames — visuell
    als korrekter SMPTE-Balken bestätigt (nicht nur "Exit-Code 0").
    Zeitkritischer Fallstrick gefunden: Empfänger muss vor dem Sender
    binden, sonst gehen die ersten UDP-Pakete verloren (verlustfrei
    korrigierbar durch Start-Reihenfolge, kein Protokoll-Bug).
  - `omp-srt-gateway` **uplink** (2110→SRT) end-to-end: echter
    2110-Strom eingespeist, ein unabhängiger GStreamer-SRT-Listener-
    Prozess empfing über 20.000 echte SRT-Pakete.
  - `omp-srt-gateway` **downlink** (SRT→2110) end-to-end, vollständiger
    Rundweg: ein simulierter "Remote"-SRT-Sender → unser Gateway → ein
    unabhängiger 2110-UDP-Empfänger, Caps korrekt bis zum `fakesink`
    verhandelt (640×480 UYVY, exakt wie konfiguriert).
  - `make contract NODE_URL=...` (`tools/contract-check`, C9): PASS
    gegen eine echte laufende `omp-srt-gateway`-Instanz.
  - `cargo deny check`/`cargo audit`: grün, keine neue Dependency nötig
    (SRT/2110-Elemente sind bereits Teil der vorhandenen GStreamer-
    Installation).
- **D5-prep (erledigt, 2026-07-14)** Node-Contract-Grundlage aus §5 Punkt
  6 nachgeholt, bevor D5 die SDK-Doku schreibt (sonst dokumentiert D5
  einen Contract, der sich kurz danach ändert). „State-Export/Import über
  den bestehenden Descriptor" war bereits erfüllt (B7-Snapshots sind der
  laufende Beweis); neu: das „media-ready"-Signal
  (`omp_node_sdk::MediaReadySource`, drei Zustände `NotApplicable`/
  `Unknown`/`Probe(...)`, transportiert über den bestehenden
  NATS-Health-Herzschlag, `media_ready`-Feld in `health::Status`
  Rust+Go). Real verdrahtet für `omp-source` (wiederverwendet den
  C2/C5-FPS-Buffer-Zähler als Sticky-Flag) und alle Control-Plane-Nodes
  (`NotApplicable`); die übrigen acht Medien-Node-Typen bekommen ehrlich
  `Unknown` (nie fälschlich „bereit") statt einer für alle kopierten,
  ungeprüften Probe — Verdrahtung nach demselben Muster ist dokumentierte
  Folgearbeit. Details/Scope-Begründung: `docs/decisions.md` 2026-07-14.
  **Verifiziert:** `cargo build/test/deny/audit` (Workspace), Go-Mock
  `build/vet/test` grün; live per NATS-Subscription gegen drei
  gleichzeitig laufende Prozesse bestätigt, dass alle drei Varianten das
  erwartete, unterschiedliche Ergebnis liefern; `make contract` weiterhin
  PASS (keine Regression im Descriptor/IS-04-Pfad).
- **D5-prep-2 (erledigt, 2026-07-14)** Nachtrag zu D5-prep: die acht
  damals als `MediaReadySource::Unknown` markierten Medien-Node-Typen
  (`playout`, `omp-switcher`, `omp-player`, `omp-video-mixer-me`,
  `omp-audio-mixer`, `omp-multiviewer`, `omp-viewer`, `omp-srt-gateway`)
  real verdrahtet. Zentrale Entscheidung: ein neuer `MediaFlow`-Trait
  (`has_flowed()`) direkt in `omp-mediaio` statt Einzellösungen pro
  Node — implementiert für alle fünf Transport-Typen (MXL/RTP/ST 2110,
  Sender **und** Empfänger). Wichtiger Fund dabei: die Probe muss auf
  dem **Src**-Pad des internen `valve` sitzen, nicht dem Sink-Pad, sonst
  meldet ein stumm geschalteter (IS-05-inaktiver) Ausgang fälschlich
  Bereitschaft — live an `playout` bestätigt. Details, Pro-Node-Muster
  und vollständiges Verifikationsprotokoll (drei gezielte
  Zustandswechsel-Beweise: `omp-audio-mixer`, `playout`, `omp-viewer`):
  `docs/decisions.md` 2026-07-14.
  **Verifiziert:** `cargo build/test/deny/audit` (Workspace) grün; live
  gegen sieben gleichzeitig laufende Node-Prozesse plus separat
  `omp-viewer` per NATS-Health bestätigt (alle `media_ready:true` im
  eingeschwungenen Zustand, drei Zustandswechsel gezielt provoziert und
  bestätigt); `make contract` PASS gegen zwei der Nodes. Ein
  unabhängiger, vorbestehender MXL-Read-Timing-Befund bei
  `omp-video-mixer-me` notiert, nicht behoben (orthogonal zu diesem
  Schritt).
- **D5 (erledigt, 2026-07-14)** SDK-Doku + Beispiel-Node-Tutorial
  (`docs/NODE-TUTORIAL.md`) — Qualitätsmaßstab: eine dritte Person
  schafft es nur mit der Doku. Baut auf dem bereits vorhandenen
  `hello_node.rs`-Beispiel auf (erklärt statt dupliziert), geht darüber
  hinaus zu einem eigenständigen Workspace-Crate (Pfad-Abhängigkeit auf
  `omp-node-sdk`, da noch nicht auf crates.io) und echtem Medien-I/O
  (Verweis auf `omp-source` + die `MediaReadySource`-Anleitung aus
  D5-prep). **Verifikation:** das komplette Tutorial real durchgespielt
  (nicht nur geschrieben) — `hello_node`-Lauf gegen die echte Registry,
  Contract-Check PASS, Kachel im Flow-Editor per CDP-Browser-Test
  bestätigt; Schritt 3 (eigenständiges Crate) zusätzlich als
  eigenständige Scratch-Übung mit einem selbst geschriebenen, nicht aus
  `hello_node.rs` kopierten `ParamStore` nachgebaut — registrierte sich
  beim ersten Versuch, Contract-Check PASS, danach rückstandsfrei
  entfernt. Details: `docs/decisions.md` 2026-07-14.
- **D6 (Host-Agent/Bootstrap jetzt detailliert, Rest noch nicht)**
  Resource-Aware Placement & Live-Migration: Host-Telemetrie über NATS,
  Placement-Engine (advisory zuerst), Make-before-break-Migrationsprotokoll
  — Konzept siehe `ARCHITECTURE.md` §6.1. Die Erkennung/das Bootstrapping
  entfernter Hosts selbst (`omp-host-agent`, Token-Bootstrap über step-ca,
  Kommandokanal) ist konkret in `ARCHITECTURE.md` §18 beschrieben
  (Abschnittsnummer seit einer früheren Notiz verschoben) —
  realistisch der nächste, weil community-unabhängige Baustein nach dem
  kleinen Regieplatz (C10–C13), siehe §7.4. Node-Contract-Grundlage
  (State-Export/Import + Readiness-Signal, §5 Punkt 6, s. D5-prep oben)
  stand vor dem SDK-v1-Freeze (Ende Phase C), auch wenn D6 selbst erst
  hier detailliert und umgesetzt wird — auf dem Single-Host-Dev-Rechner ohnehin
  nur das Protokoll simulierbar, nicht der Ausfallfreiheits-Anspruch
  selbst.

  **D6 Teil 1 (Bootstrap + Telemetrie, erledigt, 2026-07-14):** analog
  zum D3-Schnitt (mTLS zuerst, IS-10/§12 später) hier zuerst „Hosts
  erkennen und sichtbar machen" (§18.1–§18.4/§18.7 wörtlich), nicht
  „Hosts als Platzierungsziele nutzen" (§18.5/§6.1 Placement-Engine —
  Teil 2, noch nicht terminiert). Neues Top-Level-Go-Modul `host-agent/`
  (analog `nodes/mock`): registriert sich einmalig über ein Admin-
  ausgestelltes, einmaliges Bootstrap-Token
  (`POST /api/v1/admin/hosts/bootstrap-tokens`,
  `POST /api/v1/hosts/register`), merkt sich die vergebene Host-ID
  lokal (Neustart-Idempotenz, kein erneutes Registrieren), publiziert
  danach periodisch CPU/RAM-Telemetrie über NATS
  (`omp.host.<hostId>.metrics`, gemessen über `/proc/stat`/
  `/proc/meminfo`). Orchestrator: `internal/hosts` (Token-Store,
  Host-Store, In-Memory-Telemetrie-Tracker nach dem Muster von
  `internal/health.Tracker`), `GET /api/v1/hosts`. UI: `<omp-hosts-view>`
  (`ui/shell/hosts-view.ts`), per Knopf ein-/ausblendbares Panel in der
  Engineering-Ansicht (§18.7 "Sichtbarkeit im UI", noch kein volles
  Engineering-Dashboard, §17.2 existiert noch nicht).
  **Scope-Entscheidung:** mTLS-Zertifikatsausstellung über step-ca für
  den Host-Agent (§18.3 Punkt 3) bewusst nicht in dieser Runde — das
  Bootstrap-Token selbst ist bereits eine echte, einmalige, zeitlich
  begrenzte Zugriffskontrolle (§18.3 Punkt 4 "nie ungesichert-anonym"
  wörtlich erfüllt), die Telemetrie danach läuft unverschlüsselt über
  NATS wie der bestehende Node-Health-Kanal seit A7 — kein
  Sicherheits-Rückschritt, nur (noch) keine zusätzliche Absicherung.
  Ebenfalls nicht in dieser Runde: GPU/NIC-Telemetrie und
  I/O-Karten-Inventar (§18.4: "Eigenrecherche bei der D6-Umsetzung",
  herstellerspezifisch), Kommandokanal (§18.5) und Placement-Engine
  (§6.1) — größter verbleibender D6-Teil, k3s/Cloud-Host-Klassen
  (§18.6/§18.8/§18.9). Details/vollständiges Verifikationsprotokoll:
  `docs/decisions.md` 2026-07-14.
  **Verifiziert (echte Prozesse):** `go build/vet/test` für
  `orchestrator` + neues `host-agent`-Modul (inkl. eines Telemetrie-Tests
  gegen das echte `/proc` der Dev-Maschine), `deno check/test` grün.
  End-to-end: Bootstrap-Token ausgestellt, zwei simulierte Host-Agent-
  Prozesse registrierten sich, `GET /api/v1/hosts` zeigte beide mit
  echter Live-Telemetrie; Token-Wiederverwendung scheiterte mit 401
  (Single-Use bestätigt); Neustart mit vorhandener State-Datei
  registrierte sich nicht erneut (Idempotenz bestätigt); Browser-Test
  per CDP bestätigte das UI-Panel. Test-Hosts/-Tokens danach aus der DB
  entfernt.

  **D6 Teil 2 (Kommandokanal, erledigt, 2026-07-14):** §18.5 — der
  Instanz-Launcher (C8) wird remote-fähig, Hosts sind ab jetzt nutzbare
  Platzierungsziele, aber nur per **manueller** Auswahl (kein
  Placement-Engine-Automatismus, §6.1 Punkt 2 bleibt zurückgestellt).
  `POST /api/v1/instances` akzeptiert optionales `{"hostId": "..."}` —
  gesetzt, schickt `orchestrator/internal/launcher` die Start-/
  Stop-Anfrage per NATS-Request/Reply an `omp.host.<hostId>.cmd`.
  **Sicherheitsentwurf statt Nachrichtensignierung:** der Orchestrator
  schickt nur einen Katalog-`type`-Namen, nie einen ausführbaren
  Befehl; der Host-Agent löst ihn gegen seinen **eigenen, host-lokal
  konfigurierten** Katalog auf (`host-agent/internal/catalog`,
  strukturell wie `orchestrator/internal/launcher/catalog.go`, bewusst
  dupliziert statt importiert). Eine kompromittierte NATS-Nachricht
  kann damit höchstens einen dort freigegebenen Node-Typ auslösen, nie
  beliebigen Code — dieselbe Grenze wie beim lokalen Launcher, nur pro
  Host. UI (`ui/graph/flow-canvas.ts`): pro Katalogeintrag ein
  Host-`<select>` (nur sichtbar, wenn `GET /api/v1/hosts` mindestens
  einen Host liefert), Instanz-Zeilen zeigen das Host-Label.
  **Scope-Entscheidung:** NATS-Nachrichtensignierung (HMAC) bewusst
  nicht eingeführt (s. o., Katalog übernimmt die Rolle); Remote-
  Absturzerkennung noch nicht zurückgemeldet (Host-Agent erkennt
  Abstürze lokal per `cmd.Wait()`, aber kein Rückkanal zum
  Orchestrator — anders als bei lokalen Instanzen, C13-Nachtrag 3);
  Placement-Engine (§6.1) weiterhin zurückgestellt, dieser Schritt
  liefert nur die manuelle Grundlage dafür. Details/vollständiges
  Verifikationsprotokoll: `docs/decisions.md` 2026-07-14 (D6 Teil 2).
  **Verifiziert (echte Prozesse):** `go build/vet/test` für
  `orchestrator` + `host-agent` grün, `deno check/test/bundle` grün.
  End-to-end: zwei simulierte Remote-Hosts registriert, `POST
  /api/v1/instances` mit `hostId` startete einen echten
  `nodes/mock`-Prozess remote (PID auf dem Host-Agent bestätigt),
  NMOS-Registrierung + Erscheinen im Orchestrator-Graph bestätigt,
  `DELETE` beendete ihn remote sauber. Browser-Test per CDP bestätigte
  Host-`<select>` + korrekten `hostId` im POST. Sicherheitsgrenze live
  bestätigt: ein Katalogtyp, der auf dem Ziel-Host nicht freigegeben
  war, wurde vom Host-Agent abgelehnt, nicht vom Orchestrator
  durchgewunken. Test-Prozesse/-Hosts danach entfernt.
  **D6 Teil 3 (Placement-Engine, erledigt, 2026-07-14):** §6.1 —
  erste, bewusst **advisory-only** Ausbaustufe ("Alarm + Vorschlag",
  kein automatischer Eingriff). Neues Paket
  `orchestrator/internal/placement`: `Engine.Run(ctx)` bewertet alle 5s
  (gleicher Takt wie die Host-Agent-Telemetrie-Sendefrequenz) jeden
  Host mit laufenden Instanzen gegen konfigurierbare CPU-/RAM-
  Schwellwerte (`OMP_PLACEMENT_CPU_THRESHOLD` u. a., Default 85%/90%
  Alarm, 60%/70% "gilt als Ausweichziel geeignet") und schlägt bei
  Überlastung den am wenigsten ausgelasteten anderen Host vor, sofern
  einer unter den Healthy-Schwellwerten liegt — sonst ehrlich „kein
  Ausweichhost frei" statt eines stillen Fallbacks. API:
  `GET /api/v1/placement/advice`; Änderungen (neuer Alarm, verändert,
  behoben) gehen zusätzlich als SSE-Event `placement.advice` an alle
  Flow-Editor-Clients — ein unveränderter, fortbestehender Alarm sendet
  bewusst **kein** wiederholtes Event pro Tick (kein SSE-Dauerfeuer).
  UI: bestehendes `hosts-view.ts`-Panel um ein Alarm-Banner pro
  überlastetem Host erweitert (gleiches Poll-Muster wie der
  restliche Panel-Inhalt, kein SSE-Sonderfall nur für dieses eine
  Panel).
  **Scope-Entscheidung:** kein Make-before-break-Protokoll (§6.1 Punkt
  3 — Start/Verifikation/IS-05-Umschaltung/Teardown einer
  Ersatzinstanz), keine pro-Rolle konfigurierbaren Eskalationsstufen
  (advisory/auto-confirm-window/auto, §6.1 Erweiterung 2026-07-13 Punkt
  2 — Eskalationsstufen jenseits von advisory ergeben erst Sinn, sobald
  überhaupt eine automatische Ausführung existiert), keine
  I/O-Karten-Claim/Release-Semantik (§6.1 Erweiterung 2026-07-10 —
  braucht ein noch nicht existierendes Geräte-Inventar), keine
  GPU/NIC-Telemetrie (§18.4, herstellerspezifisch), kein
  Cloud-Kostenfaktor (§6.1 Punkt 4). D7 Teil 2 (Ressourcen-Vorprüfung
  als harte Start-Vorbedingung) kann auf diesem Baustein aufsetzen,
  bleibt aber ein eigener, noch nicht terminierter Schritt.
  **Verifiziert (echte Prozesse, nicht nur Unit-Tests):** `go build/
  vet/test -race` für `orchestrator` (neues `internal/placement`-Paket,
  acht Szenarien inkl. "Alarm ohne Ausweichhost", "stabiler Alarm
  republiziert nicht", "Alarm behoben löst Clear-Event aus") grün,
  `deno check/test/bundle` grün. End-to-end: zwei echte
  `omp-host-agent`-Prozesse (gleiches Zwei-Host-Muster wie D6 Teil 1/2)
  mit je einer echten `nodes/mock`-Instanz registriert, Baseline ohne
  Alarm bestätigt (`GET /api/v1/placement/advice` → `[]`); einen
  Host-Agent gestoppt und für dessen Host-ID über NATS eine fingierte
  Überlast-Telemetrie (97,5% CPU) publiziert (gleiche Simulationsart,
  die `ARCHITECTURE.md` §6.1 für die Single-Host-Dev-Maschine
  vorschlägt) — Alarm mit korrektem Ausweichhost-Vorschlag erschien;
  über ~14s (≈3 Bewertungsläufe) währenddessen exakt ein SSE-Event
  beobachtet, kein Wiederholungsfeuer; Entlastung simuliert → Alarm
  verschwand, ein zusätzliches "cleared"-Event beobachtet. Browser-Test
  per echtem CDP-Klick auf den bestehenden "Hosts"-Button bestätigte
  das Banner mit Host, Grund, CPU/RAM-Werten und Ausweichhost-
  Vorschlag im tatsächlichen DOM. Test-Prozesse, -Hosts (per SQL, kein
  DELETE-Endpunkt für Hosts vorhanden) und -Tokens danach entfernt.

- **D7** Workflow-Bereitstellung & -Verteilung: neues Objekt „Workflow"
  (Rollen + Verbindungs-Template + Platzierungs-Hinweise),
  Katalog-Descriptor (optional pro Node), Start/Stop ganzer Bundles
  (Quadlets bare-metal, Helm-Äquivalent cloud) — Konzept siehe
  `ARCHITECTURE.md` §6.2. Teilt den Host-Telemetrie-/Start-Agenten mit
  D6, deshalb zusammen mit D6 sequenziert, nach D4 (2110). Anders als
  D6 **kein** Node-Contract-Zusatz vor dem SDK-Freeze nötig
  (Katalog-Descriptor ist rein additiv, nachrüstbar). „Stufe 0" davon
  (einfacher Instanz-Launcher, ein Host, Prozesse statt Bundles) ist
  bereits in Phase C (C8) vorgezogen, siehe `ARCHITECTURE.md` §6.2 und
  `docs/decisions.md` 2026-07-09; D7 baut darauf zum vollen
  Workflow-Objekt aus, ersetzt es nicht.

  **D7 Teil 1 (Workflow-Objekt + Bundle-Start/-Stop, erledigt,
  2026-07-14):** analog zum D3/D6-Schnitt hier zuerst „Workflows
  anlegen und als Bündel starten/stoppen" (§6.2s Kernwunsch), nicht
  „automatisch planen, wo/wann" (Zeitsteuerung/Ressourcen-Vorprüfung —
  Teil 2, noch nicht terminiert, hängt an der weiterhin
  zurückgestellten Placement-Engine, §6.1). Neues Paket
  `orchestrator/internal/workflows`: Workflow = Rollen (Name + Katalog-
  Typ + optionale Host-ID) + Rolle→Rolle-Verbindungs-Template (§6.2
  wörtlich, kein Port→Port) + Lifecycle-Status. `Start`/`Stop` laufen
  asynchron im Hintergrund (Zwischenzustand "starting"/"stopping" sofort
  in der HTTP-Antwort, Fortschritt per Poll oder SSE-Event
  `workflow.updated`); provisioniert jede Rolle über den bestehenden
  Launcher (C8/D6 Teil 2), wartet mit Timeout (20s) auf die
  NMOS-Registrierung (Korrelation über `OMP_INSTANCE_ID`), löst dann das
  Verbindungs-Template auf den jeweils ersten Sender/Receiver jeder
  Rolle in echte IS-05-Connections auf. API: `GET/POST
  /api/v1/workflows`, `GET/DELETE /api/v1/workflows/{id}`, `POST
  .../start`, `POST .../stop`. UI: `<omp-workflows-view>`
  (`ui/shell/workflows-view.ts`), Liste + Anlegen-Formular, gleiches
  Toggle-Panel-Muster wie `hosts-view.ts`.
  **Scope-Entscheidung:** Zeitsteuerung, Stop-Sicherheitsabfrage,
  Ressourcen-Vorprüfung (§6.2-Erweiterung 2026-07-10) bewusst nicht in
  dieser Runde — Start ist best-effort mit gesammelten Fehlern statt
  Alles-oder-Nichts (echte Ressourcen-Vorprüfung bräuchte die
  Placement-Engine als harte Vorbedingung, §6.1). Port-genaues
  Verbindungs-Template ebenfalls zurückgestellt (reicht heute nicht als
  Bedarf). **Nebenfund:** `nodes/mock` setzte den
  `urn:x-omp:instance`-Tag nie (nur von Hand gestartet, nie über den
  Launcher getestet) — Ein-Zeilen-Fix, sonst hätte kein Workflow mit
  Mock-Rollen je "started" erreicht. Details/vollständiges
  Verifikationsprotokoll inkl. zweier per CDP-Klicktest gefundener
  UI-Race-Bugs: `docs/decisions.md` 2026-07-14 (D7 Teil 1).
  **Verifiziert (echte Prozesse):** `go build/vet/test` für
  `orchestrator` (neues `internal/workflows`, Store-Tests gegen echtes
  Postgres) und `nodes/mock` grün, `deno check/test/bundle` grün.
  End-to-end per echtem API-Aufruf UND per echtem CDP-Klicktest: ein
  Workflow mit zwei Rollen + einer Verbindung gestartet, beide Prozesse
  liefen und registrierten sich, die Verbindung erschien automatisch als
  aktive IS-05-Connection im Graphen, Stop beendete beide Prozesse
  sauber. Test-Prozesse/-Workflow danach entfernt.

---

## 6a. Kapitel 10 — Endziel-Anforderungen (`docs/END-GOAL-FEATURES.md`)

Alle zehn Entscheidungspunkte aus `docs/END-GOAL-FEATURES.md` Kapitel 10
wurden am 2026-07-14 getroffen (Details dort und in `docs/decisions.md`
2026-07-14 „Entscheidungssitzung END-GOAL-FEATURES Kapitel 10"). Diese
Sektion nimmt die einzelnen „Teil 1"-Scheiben als reguläre Schritte auf,
in der dort festgelegten Reihenfolge: K1-Teil-1 → K2-Teil-1 →
K3/K4-Teil-1 → K5 → K6, K7-Teil-1 und K9-Teil-0 unabhängig/parallel
startbar.

**K1-Teil-1 (UI-Verbindungsschicht + App-Bar mit Tabs, erledigt,
2026-07-14):** `docs/END-GOAL-FEATURES.md` §1.3a/b/d — kleinste,
präsentationswirksamste Scheibe aus Kapitel 1 (Kapitel-10-Entscheidung
2: Studio-Dark als einziges Theme, Englisch als Primärsprache mit
DE-Umschaltung — Umschaltung selbst ist Teil 4 —, Floating-Panels werden
zu Vollansichten mit Tabs). Drei neue Bausteine:

- **`ui/design-tokens.css`** — der in §1.3d vorgeschlagene Token-Satz
  (Flächen/Text/Signalfarben/Typo/Radius-Spacing/Glow-Zustände) plus
  `@keyframes omp-pulse` für den Disconnected-Banner; per `<link>` aus
  `ui/index.html` geladen (Custom Properties durchdringen Shadow-DOM,
  §22.2 — kein zusätzlicher Import pro Bundle nötig, damit sie wirken).
  `index.html` außerdem `lang="de"` → `lang="en"` (Kapitel-10-
  Entscheidung 2).
- **`ui/shell/connection.ts`** (neu) — `ConnectionMonitor`
  (`connected|degraded|disconnected`, `EventTarget`-basiert) plus
  `apiFetch()`. Die bisher in `flow-canvas.ts` verbaute SSE-Verbindung
  (`#connectEvents`/`#scheduleReconnect`) zieht hierher um: genau eine
  `EventSource` pro Shell statt einer pro Komponente (`start()` ist
  idempotent). Primärsignal SSE (`onopen`→„connected", `onerror`→
  „disconnected" + Backoff-Reconnect, unveränderte Konstanten aus der
  alten `flow-canvas.ts`-Logik); Sekundärsignal `apiFetch()` statt
  rohem `fetch` in `flow-canvas.ts`/`hosts-view.ts`/`workflows-view.ts`
  (18 bzw. 6 Aufrufstellen) — ein 5xx/Netzwerkfehler dort setzt
  „degraded" (nur während „connected", überschreibt kein bereits
  sichtbares „disconnected"), ein 4xx bleibt bewusst folgenlos
  (legitime Anwendungsantwort, kein Konnektivitätssymptom).
- **`ui/shell/app-shell.ts`** (neu, `<omp-app-shell>`) — ersetzt die
  zwei Floating-Toggle-Buttons (`shell.ts`: vormals
  `buildHostsToggle`/`buildWorkflowsToggle`) durch eine 48px-App-Bar
  (Produktname, Tabs „Flow Editor · Workflows · Hosts", Verbindungs-Pill)
  über einer Content-Fläche, die den jeweils aktiven Tab als
  vollwertige Ansicht rendert (Kapitel-10-Entscheidung: Vollansichten
  statt andockbarer Panels). Bei „disconnected": rot pulsierender
  Banner mit Live-Countdown bis zum nächsten Reconnect-Versuch und
  „Reconnect now"-Knopf (`connectionMonitor.reconnectNow()`), die
  Content-Fläche bekommt `aria-disabled` + reduzierte Deckkraft +
  `pointer-events:none` („kein Klick ins Leere"). Reconnect
  (disconnected → connected) remountet den aktiven Tab (frisches
  `document.createElement(...)`), damit Graph/Panel-Daten einmal neu
  geladen werden — nutzt die ohnehin vorhandenen
  `connectedCallback()`-Ladepfade der Views, kein neuer Reload-
  Mechanismus. `shell.ts` mountet in der Engineering-Ansicht jetzt
  `<omp-app-shell>` statt `<omp-flow-canvas>` + zwei Buttons.
- **Design-Token-Migration** auf den in §1.4 explizit benannten
  „Shell-eigenen Flächen": App-Bar (neu, von Anfang an mit Tokens),
  `hosts-view.ts`/`workflows-view.ts` (jetzt Vollansicht statt
  Floating-Panel: `max-width`/`max-height` entfernt, `width/height:100%`),
  Toast + Parameter-Panel in `flow-canvas.ts`. SVG-Canvas/Breadcrumb/
  Snapshot-Bar/Palette bewusst **nicht** angefasst (nicht Teil der
  Teil-1-Aufzählung — folgt mit der Node-Bundle-/Kit-Migration in
  Teil 2). Gear-Icon/Settings-Panel selbst: **zurückgestellt auf
  Teil 3** (eigene Datei `settings-view.ts`, dort spezifiziert), Teil 1
  liefert nur Pill + Tabs, kein Zahnrad.

  **Echter Bug per Live-Test gefunden und behoben:** beim CDP-
  Stop/Start-Zyklus des Orchestrators blieb die Pill nach einem
  Neustart dauerhaft auf „degraded" hängen statt zu „connected"
  zurückzukehren. Ursache (per `Network`-Domain-Trace der echten
  Requests belegt, nicht vermutet): ein einzelner `apiFetch()`-Aufruf,
  der schon **vor** dem Abbruch lief (`#maybeFetchPreviewUrl` in
  `flow-canvas.ts`, ausgelöst beim ursprünglichen Seitenaufbau), löste
  sich in einem beobachteten Fall erst 68 Sekunden später mit einem
  5xx auf — lange nachdem die SSE-Verbindung längst wieder „connected"
  war. Da auf dem Flow-Editor-Tab sonst nichts periodisch `apiFetch()`
  aufruft, gab es keine Selbstkorrektur. Fix: `reportApiFailure()`
  startet einen leisen Recovery-Probe gegen `/healthz`
  (unauthentifiziert, bereits von `stop-omp.sh` genutzt) alle 3s,
  solange der Zustand „degraded" bleibt — der Probe ruft denselben
  `apiFetch()`-Pfad auf wie jeder andere Aufrufer, kein Sonderfall.
  Deterministisch abgesichert in `ui/shell/connection_test.ts` (drei
  Fälle: Selbstheilung nach einem Fehlschlag, wiederholtes Retry über
  mehrere Probe-Zyklen mit `@std/testing`s `FakeTime`, 4xx zählt nicht
  als Konnektivitätsproblem) statt sich auf die live beobachtete,
  nicht deterministisch reproduzierbare 68s-Verzögerung zu verlassen.

  **Scope-Entscheidung:** Settings-Menü (c), `ui/kit`-Bausteine,
  Node-Bundle-Migration auf Tokens, Nutzer-Präferenzen/i18n-Umschaltung
  sind Teil 2–4, hier bewusst nicht enthalten (§1.4-Phasenplan).

  **Verifiziert:** `deno check`/`deno test ui/`
  (40 Tests grün, davon 3 neu für den Degraded-Recovery-Fix) /
  `deno bundle` grün. Live per CDP (Node-WebSocket-Client, kein
  `--dump-dom` — Projekt-Memory zu sequenziellen Fetch-Ketten): echter
  Orchestrator-Stop/Start-Zyklus zweimal gefahren. Erster Lauf deckte
  den Degraded-Hänger auf; nach dem Fix zeigte ein zweiter Lauf den
  vollständigen Zyklus sauber: „Connected" → (Prozess gestoppt) →
  Pill „Disconnected" binnen ~12s, Banner erscheint mit Countdown,
  Content-Fläche `aria-disabled`/gesperrt → (Prozess neu gestartet) →
  SSE reconnected binnen ~18s, Pill zurück auf „Connected", Banner
  verschwindet, Content entsperrt, Flow-Editor-Tab frisch neu gemountet
  (Graph/Layout/Snapshots/Katalog erneut geladen). Zusätzlich per
  CDP-Klick durch alle drei Tabs (Flow Editor/Workflows/Hosts) ohne
  Konsolenfehler. Keine Test-Ressourcen (Hosts/Instanzen) angelegt,
  nichts aufzuräumen.

**K2-Teil-1 (`omp-player`: Datei-Playback MP4/MOV, erledigt,
2026-07-15):** `docs/END-GOAL-FEATURES.md` §2.3/§2.4 Teil 1 — die
zweite Kapitel-10-Scheibe (`K1-Teil-1 → K2-Teil-1 → …`, s. o.).
`nodes/omp-player` spielt jetzt neben den bisherigen
`videotestsrc`/`audiotestsrc`-Testmustern auch echte Mediendateien:

- **`pipeline.rs`:** `Item` bekommt eine `id` sowie ein neues
  `ItemSource`-Enum (`TestPattern { pattern, tone_freq }` — unverändert
  das CI-Testmittel — und neu `File { uri }`). Ein Datei-Slot-Zweig
  (`build_file_branches`) baut pro `cue()` ein `uridecodebin`
  (proven-Pattern-Referenz `PIPELINE CONTROLLER/lib/PlayerPipeline.js`,
  `UMSETZUNG.md` §0 Punkt 9 — der dortige `mxfdemux`-Workaround ist
  K2-Teil-2, hier nicht nachgebaut) plus je einer Video-
  (`videoconvert!videoscale!videorate!capsfilter(640×480@25)`) und
  Audio-Konform-Kette (`audioconvert!audioresample!capsfilter(F32/48k/
  2ch)`) vor dem jeweiligen isel-Pad; dynamische Pads werden per
  `pad-added` gebunden. Das `uridecodebin` gehört (Ownership) dem
  Audio-Branch (immer vorhanden), der optionale Video-Branch bleibt bei
  `has_video=false` (Jingle-Profil) unverlinkt.
- **EOS als erstklassiges Ereignis:** ein `queue`-Element am Ende jedes
  Datei-Zweigs (direkt vor dem isel-Pad) erzeugt eine echte
  Thread-Grenze; ein `EVENT_DOWNSTREAM`-Pad-Probe auf dessen Src-Pad
  verwirft jedes EOS-Event dort immer (die Pipeline bedient dauerhaft
  beide Slots, ein durchschlagendes EOS am Bus/den MXL-Ausgängen würde
  auch den jeweils anderen Slot beenden) und meldet — nur wenn der
  betroffene Slot zum Zeitpunkt des EOS tatsächlich on-air war —
  `Event::ItemEnded` nach außen. `main.rs` veröffentlicht daraus
  `omp.player.<node_id>.itemEnded {itemId}` (neu:
  `omp_node_sdk::health::Publisher::publish_item_ended`/
  `NodeHandle::publish_item_ended`, analog zu `publish_tally`). Am
  Clip-Ende hält der Zweig lokal auf dem letzten Bild/still — kein
  Auto-Advance (Automations-Scope, K6/C14-C15).
- **`main.rs`:** `append`/`load` akzeptieren zusätzlich zu `pattern`
  ein `file` (Pfad relativ zu `OMP_MEDIA_DIR`, Default `data/media`,
  wird bei Bedarf angelegt). `resolve_media_path` löst gegen
  `OMP_MEDIA_DIR` auf und lehnt jeden Traversal-Versuch (`../..`) über
  `canonicalize()` + `starts_with()`-Prüfung ab. Die `file://`-URI
  entsteht über `gst::glib::filename_to_uri` (korrekte
  Pfadsegment-Kodierung, löst den in `PlayerPipeline.js` nur
  dokumentierten, dort aber nicht tatsächlich gelösten
  Leerzeichen/Umlaute-Fallstrick strukturell). `durationMs` kommt bei
  Datei-Items aus einer einmaligen `gstreamer_pbutils::Discoverer`-Probe
  (neue Abhängigkeit `gstreamer-pbutils`, Teil von gst-plugins-base wie
  `gstreamer` selbst — Minimal-Dependency-Regel erfüllt, kein
  eigener Demux/Decoder-Nachbau sinnvoll möglich). Neuer readonly-Param
  `mediaLibrary` (flache Dateiliste aus `OMP_MEDIA_DIR`, kein Cache/
  Rekursion — Komfort-Ausbau ist K2-Teil-3).
- **UI (`ui/bundle-video.js`):** Texteingabe "Datei" mit `<datalist>`
  aus `mediaLibrary` neben dem bestehenden Pattern-Select — kein
  Clip-Browser (Vorschau/Sortierung folgt Teil 3), `append` schickt
  `file` statt `pattern`, wenn ausgefüllt.
- **Testmittel:** `deploy/dev/make-test-media.sh [Sekunden]` erzeugt per
  `gst-launch-1.0` eine kurze H.264/AAC-MP4 (SMPTE-Balken + 440-Hz-Ton,
  640×480@25) unter `OMP_MEDIA_DIR` — kein Asset-Beschaffungs-Blocker
  (§2.4-Empfehlung: "MP4 zuerst … selbst erzeugbar").

  **Echter Bug per Live-Test gefunden und behoben:** ein
  `EVENT_DOWNSTREAM`-Pad-Probe, der EOS direkt auf einem Pad der
  Konform-Kette (unmittelbar hinter `uridecodebin`, ohne Thread-Grenze
  dazwischen) verwirft, löste reproduzierbar `gst_mini_object_unref:
  assertion 'mini_object != NULL' failed` aus (per gdb-Backtrace
  bestätigt: Race mit `uridecodebin`s eigener, rekursiver
  `gst_pad_forward`-EOS-Verteilung an seine internen Ghost-Pads, auf
  demselben Streaming-Thread). Fix: `queue`-Element zwischen Konform-
  Kette und isel-Pad eingefügt, Probe auf dessen Src-Pad verschoben
  (Standard-GStreamer-Pattern zur Thread-Entkopplung). Unter
  `G_DEBUG=fatal-criticals` + gdb reproduzierbar, in normalem Betrieb
  nicht fatal — der Prozess lief in allen Tests zuverlässig über
  mehrere Cue/Take/EOS-Zyklen weiter. **Bekannte Restwarnung:** eine
  einzelne, nicht mehr mit dem EOS-Zeitpunkt korrelierte
  GStreamer-CRITICAL-Zeile tritt weiterhin kurz nach dem `cue()` einer
  Datei auf (vermutlich `uridecodebin`/`decodebin3`-interne
  Multiqueue-Startlogik in GStreamer 1.22, nicht funktional
  beobachtbar) — dokumentiert, nicht weiter verfolgt in dieser Sitzung,
  s. `docs/decisions.md` 2026-07-15.

  **Verifiziert (echte Prozesse, kein Mock):** `cargo build/test
  --workspace` grün (inkl. `omp-node-sdk`). End-to-end per echtem API-
  Aufruf: Testdatei erzeugt, `append`/`cue`/`take` gegen einen echten
  `omp-player`-Prozess, Bild im per `POST /api/v1/graph/edges`
  verbundenen `omp-viewer` (MJPEG-Preview) visuell bestätigt (SMPTE-
  Farbbalken aus der Datei, nicht das Testmuster), `durationMs=5000`
  korrekt von `Discoverer` geprobt, `omp.player.<id>.itemEnded
  {"item_id":"item1"}` exakt zur erwarteten Zeit (~5 s nach `take`) per
  `nats sub` auf NATS beobachtet. Mehrere Cue/Take-Zyklen inkl.
  Neu-Cuen nach EOS in denselben Slot ohne Absturz. Test-Instanzen/
  -Prozesse danach entfernt, `data/media/*.mp4` bleibt als
  reproduzierbares Testmittel (per Skript neu erzeugbar, `/data/` ist
  gitignored).

**K3/K4-Teil-1 (Konsolen-Optik + Metering, erledigt, 2026-07-15):**
`docs/END-GOAL-FEATURES.md` §3.4/§4.4 Teil 1 — die dritte Kapitel-10-
Scheibe (`K1-Teil-1 → K2-Teil-1 → K3/K4-Teil-1 → …`, s. o.), K3
(`omp-video-mixer-me`) und K4 (`omp-audio-mixer`) zusammen umgesetzt, da
beide auf demselben neuen `ui/kit` aufbauen (§10 Punkt 1: "kein neuer
Bausatz nur für eine Node").

- **`ui/kit/` (neu):** `<omp-fader>`, `<omp-knob>`, `<omp-meter>`,
  `<omp-button>` als eigenständige Custom Elements mit eigenem Shadow-
  DOM (Kapselung, ARCHITECTURE.md §22.2), auf `ui/design-tokens.css`
  (K1-Teil-1) aufbauend. Einmal global aus `shell.ts` importiert
  (`import "../kit/index.ts"`), Node-UI-Bundles nutzen sie danach ohne
  eigenen Import (Custom-Element-Registry ist global).
- **`omp-audio-mixer` (K4-Teil-1, §4.3a "post-fader Metering"):**
  `levels.rs` (neu) — eigener `tiny_http`-SSE-Server (`GET /levels`,
  Muster von `omp-mediaio::preview`s MJPEG-Port übernommen, node-lokal
  statt in `omp-mediaio` verallgemeinert, da bisher nur ein Node das
  braucht). `pipeline.rs`: ein `level`-Element pro Kanal (vor dem
  Fader — ehrliche Teil-1-Grenze, echtes Post-Fader-Metering bräuchte
  den in `docs/decisions.md` dokumentierten Verzicht auf ein
  zusätzliches `volume`-Element rückgängig zu machen, folgt mit dem
  Kompressor in Teil 2) sowie ein Master-`level` nach dem `audiomixer`
  (dort echtes Post-Fader-Metering, kein Fader-Analogon am Master in
  Teil 1). Bus-Loop pollt `level`-Bus-Messages nicht-blockierend
  zwischen den 50-ms-Kommando-Wartezyklen. Neuer readonly-Param
  `levelsUrl`. UI-Bundle (`ui/bundle.js`, komplett neu aufgebaut):
  vertikale Kanalzüge (`<omp-fader>` für Gain, `<omp-knob>`×3 für EQ,
  `<omp-button>` für Mute/AFV/Override, `<omp-meter>` für Pegel) statt
  der bisherigen Zahlenfelder; eigene `EventSource` auf `levelsUrl`.
- **`omp-video-mixer-me` (K3-Teil-1, §3.4):** reines UI-Bundle-Update
  (`ui/bundle.js`), keine Node-/Pipeline-Änderung — PGM/PST-Doppelreihe,
  CUT/AUTO, Keyer/DVE als beleuchtete `<omp-button>`-Tasten statt
  generischer Button-Liste. T-Bar rein kosmetisch (Teil 2:
  `transitionPosition` existiert noch nicht), Rate-Wahl/Wipe ausgegraut
  mit Tooltip statt weggelassen ("gehört zur Pult-Anmutung", §3.3).
  PGM-Reihe bewusst nur Anzeige, kein Hot-Cut (§3.5 offene Frage 1 nicht
  entschieden).

  **Zwei echte Bugs per Live-Test gefunden und behoben, beide
  Auth-bedingt (D3-2) und beide NICHT Teil dieser Scheibe selbst, aber
  ohne sie war kein Live-Test der eigentlichen K3/K4-Lieferung
  möglich — der Bootstrap-Zustand (kein Nutzer angelegt) verdeckte sie
  bislang in jeder früheren Sitzung, auch in K1-Teil-1s eigener
  Verifikation:**

  1. **`ui/shell/connection.ts`** öffnete die `EventSource` als
     `new EventSource("/api/v1/events")` ohne den in `docs/decisions.md`
     (D3-2) bereits vorgesehenen `?access_token=`-Fallback (Browser-
     `EventSource` kann keine eigenen Header setzen). Sobald ein echter
     Nutzer angelegt ist, quittiert der Server das mit 401 →
     `onerror` → Zustand bleibt dauerhaft "disconnected", die gesamte
     Content-Fläche bleibt per `aria-disabled`/`pointer-events:none`
     gesperrt (K1-Teil-1s eigener Mechanismus). Fix: Token aus
     `localStorage` (`"omp-auth-token"`) lesen, als `?access_token=`
     anhängen — bewusst kein `import { getToken } from "./auth.ts"`,
     da dessen Modul-Seiteneffekt (`window.fetch`-Patch) unter
     `deno test` bricht (`window` vs. `globalThis` in Deno 2), Token-Key
     stattdessen dupliziert.
  2. **`ui/shell/ui-bundle.ts`** lud Node-UI-Bundles per nativem
     `import(...)`, das (anders als `fetch()`) nicht über den in
     `auth.ts` gepatchten globalen `fetch` läuft — der
     `Authorization`-Header fehlte, jeder Bundle-Import schlug unter
     echter Auth mit 401 fehl und fiel wegen des schluckenden `catch`
     still auf das generische B6-Parameter-Panel zurück (betrifft ALLE
     Nodes mit eigenem UI-Bundle, nicht nur die beiden aus dieser
     Scheibe). Fix: gleiches `?access_token=`-Muster wie bei (1) auf die
     `bundle.js`-Import-URL angewendet.

  Beide Funde reproduzierbar demonstriert: Bootstrap-Nutzer angelegt,
  eingeloggt (Node-CDP-WebSocket-Client, kein `--dump-dom`, Projekt-
  Memory zu sequenziellen Fetch-Ketten) → vor dem Fix blieb die Pill rot
  ("Disconnected"), die Content-Fläche gesperrt, Klicks auf Node-Kacheln
  ohne Wirkung (`elementFromPoint` traf wegen `pointer-events:none` nur
  noch `<omp-app-shell>` selbst, nie tiefer); nach beiden Fixes Pill
  grün ("Connected"), Klick öffnet das Panel, `<omp-audio-mixer-panel>`/
  `<omp-video-mixer-me-panel>` laden sichtbar ihr eigenes Shadow-DOM.

  **Verifiziert (echte Prozesse, kein Mock):** `cargo build/test
  --workspace` grün, `deno check`/`deno test ui/` grün (40 Tests, davon
  0 neu — reine Bugfixes ohne neues Verhalten, das isoliert testbar
  wäre; die eigentliche K3/K4-Funktionalität ist UI-Rendering + Live-
  SSE, per CDP verifiziert statt per Unit-Test). End-to-end per echtem
  `omp-audio-mixer`-Prozess: `addChannel` gegen einen echten Testton-
  Kanal, `curl -sN .../levels` zeigt reale, alternierende
  `{"channelId":"ch1",...}`/`{"channelId":null,...}`-SSE-Frames mit
  plausiblen `rms`/`peak`-Werten (Master und Kanal getrennt). Browser-
  Test per CDP (Chromium headless + Node-WebSocket, gleiche Methode wie
  D3-2/K1-Teil-1): Login, Klick auf die Audiomischer-Kachel öffnet
  `<omp-audio-mixer-panel>` mit 1 Fader/3 Knobs/4 Buttons/2 Metern im
  Shadow-DOM; `<omp-meter value>` ändert sich zwischen drei
  Screenshots im Sekundenabstand (Live-Update über SSE bestätigt, nicht
  nur einmalig gerendert). Video-Mixer-M/E-Panel separat per CDP
  geöffnet und screenshotet: PGM/PST-Reihen, CUT/AUTO, DSK/PIP,
  ausgegraute Rate-Reihe — sieht wie ein Hardware-Pult aus, keine
  Konsolen-Fehler. Bekanntes Gotcha erneut bestätigt (Projekt-Memory):
  `/dev/shm/omp-mxl` ist tmpfs und war nach einem Neustart der
  Entwicklungsmaschine leer — `mkdir -p /dev/shm/omp-mxl` vor jedem
  MXL-Node-Start seit Reboot nötig, keine Code-Änderung. Test-
  Instanzen/-Prozesse und der Bootstrap-Testnutzer (inkl. dessen
  Rollenbindung) danach wieder entfernt, Bootstrap-Zustand
  (`authRequired:false`) verifiziert wiederhergestellt.

  **Nachtrag (2026-07-15, visueller Feinschliff nach Referenzvergleich
  §12.3):** der Projektinhaber zeigte ein Beispiel-Bedienpanel eines
  kommerziellen PTZ-/Vision-Mixer-Systems ("Bildmeister"-Layout) als
  Zielbild. `ui/kit` bekam dafür kräftigere Metall-Gradients (neue
  Design-Tokens `--omp-metal-*`) statt der bisherigen dunkler-auf-
  dunkel-Flächen: `<omp-button>` mit Glanzlicht-Sheen, `<omp-fader>`
  mit dB-Skala-Ticks und Metall-Kappe, `<omp-knob>` mit Chrom-Bezel-Ring
  und Mittenschraube, `<omp-meter>` mit LED-Segment-Fugen. Neuer
  Baustein **`<omp-panel-section>`** (gruppierte Sektion mit betonter
  Kopfzeile + Trennlinien, genau die im Referenzbild sichtbare
  "AUDIO MIXER"/"TRANSITION"-Optik) — Audio- und Video-Mixer-Bundle
  gruppieren ihre Konsole jetzt jeweils darunter.

  **Ein Layout-Bug per Live-Test gefunden und behoben:** zwei
  verschachtelte `<omp-panel-section>`-Boxen (Bus + Transition einzeln)
  im Video-Mixer-Bundle sprengten zusammen mit ihrem doppelten Padding
  die 280px-Breite des Parameter-Panels — die Transition-Spalte
  (CUT/AUTO/T-Bar) fiel unsichtbar aus dem sichtbaren Bereich, die
  Seite bekam einen ungewollten horizontalen Scrollbalken. Fix: eine
  einzige äußere Sektion um das ganze Pult, `border-left` als leichte
  interne Trennung (wie vor dem ersten Versuch), Bus-Button-/Spalten-
  Maße leicht verkleinert. Zusätzlich denselben `?access_token=`-Bug
  wie bei `ui/shell/connection.ts` (s. o.) auch im Video-Mixer-Bundles
  eigener `/api/v1/events`-`EventSource` gefunden und behoben (war
  bisher nur durch den 2-s-Poll-Fallback verdeckt, kein Absturz, aber
  unnötig träge).

  **Verifiziert:** `cargo build/test --workspace`, `deno check`/
  `deno test ui/` (weiterhin 40/40) grün. Live per CDP: Audio- und
  Video-Mixer-Panel neu gebaut/gestartet, Screenshots vor und nach dem
  Layout-Fix verglichen (Transition-Spalte jetzt vollständig sichtbar,
  kein Scrollbalken), Mute-Button-Klick-Test bestätigt Interaktion
  bleibt über die neue Sektions-Verschachtelung hinweg funktionsfähig
  (`active`-Attribut korrekt `false→true`). Test-Instanzen und
  Bootstrap-Testnutzer danach wieder entfernt.

**K3-Nachtrag (PGM-Hot-Cut, erledigt, 2026-07-16):** `docs/END-GOAL-
FEATURES.md` §3.5 offene Frage 1 beantwortet (Projektinhaber-Feedback
nach dem K5-Teil-1-Livetest, s. `docs/decisions.md` 2026-07-16
Nachtrag): PGM-Bus-Buttons waren bisher bewusst nur Anzeige (kein
Hot-Cut), weil ein impliziter `select+cut`-Umweg die gestagte
Preset-Auswahl überschrieben hätte. Neue Node-Methode
`crosspoint.take(senderId)` (`pipeline.rs::Command::Take`) schaltet
PGM (`isel`/`isel_bg`) sofort um, identischer fg/bg-Alpha-Mechanismus
wie `Cut`, aber ohne `preset` anzurühren — PGM-Hot-Cut und
PST-Preset-Stage bleiben dadurch strukturell unabhängig. UI-Bundle:
PGM-Tasten rufen jetzt `crosspoint.take` statt keinen Handler zu haben,
PST-Tasten unverändert `crosspoint.select`.

  **Nebenbefund (kein neuer Bug, bereits dokumentiert seit C8):**
  Source→Mixer→Viewer zeigte nach dem OOM-Vorfall (K5-Teil-1-Nachtrag)
  Schwarzbild — der bekannte, seit 2026-07-09/2026-07-14 offene
  „MXL-Read-Livelock" (TOCTOU in `third_party/mxl`s `Sync.cpp`) traf
  erneut zu, ein Instanz-Neustart behob es (etabliertes Recovery-
  Muster). Nicht in dieser Sitzung gefixt (weiterhin „eigene künftige
  Sitzung").

  **Verifiziert:** `cargo build/test --workspace` grün. Live per echtem,
  über den Instanz-Launcher gestarteten Prozess: `crosspoint.take`
  schaltet PGM sofort um (MJPEG-Preview-Frame bestätigt den
  Quellwechsel ohne Take-Zwischenschritt); anschließendes
  `crosspoint.select` auf eine andere Quelle ändert nachweisbar nur
  `presetInput`, `programInput` bleibt unverändert (Parameter-Roundtrip
  nach jedem Aufruf). Test-Instanzen danach bereinigt, Demo-Vierergespann
  (Source/Videoplayer/Mixer/Viewer) läuft gesund weiter.

  **Offen, nicht priorisiert:** PST-Vorschau-Ausgang (zweiter,
  zuschaltbarer MXL-Sender mit dem Preset-Bild — braucht einen dritten
  `input-selector`-Zweig + zweiten `MxlVideoOutput`, keine reine
  UI-Änderung) und Per-Bus-Button-Thumbnails (eigene, größere Anfrage,
  evtl. mit `omp-multiviewer`) — beide vom Projektinhaber explizit auf
  eine künftige Sitzung verschoben. §3.5 offene Frage 2 (Button-Bank-
  Verhalten bei vielen Quellen) bleibt ebenfalls offen.

**K5-Teil-0 (OGraf-Render-Spike, erledigt, 2026-07-15):**
`docs/END-GOAL-FEATURES.md` §5.4 Teil 0 verlangt vor jedem
`omp-ograf`-Node-Code eine eigene Sitzung: Go/No-Go zwischen `wpesrc`
(nativ) und Headless-Chromium/CDP (Fallback) gegen 5 echte Templates.
Volles Ergebnis inkl. Test-Aufbau in `docs/decisions.md`
2026-07-15 „K5-Teil-0" — Kurzfassung:

- **Beide im Design-Dokument benannten Risiken empirisch widerlegt:**
  `wpesrc` fehlte nur als installiertes Paket (`apt install
  gstreamer1.0-wpe`), keine Paketierungslücke; der 2026-07-07
  dokumentierte Chromium-Sandbox-Crash (B2) tritt seit mehreren späteren
  Sitzungen mit `--headless=new` nicht mehr auf (K1/K2/K3/K4-Teil-1
  nutzen das längst produktiv für Live-Verifikation).
- **5 echte Templates aus `PIPELINE CONTROLLER`** (`digital-clock-
  top-left`, `breaking-news`, `flat-design-lower-third`, `scorebug`,
  `ticker`) über eine nachgebaute, generische Test-Harness gerendert,
  die den EBU-OGraf-v1-Lifecycle fährt (Manifest laden → `main`-Modul
  per `import()` → `default export`-Klasse selbst per
  `customElements.define()` registrieren — **Formfund:** die Klasse ist
  in der Datei *nicht* bereits registriert, das muss die Host-Seite
  selbst tun, in §5.3 nicht explizit festgehalten).
- **`wpesrc` vs. Chromium (Kontrollprobe) pixelidentisch**, inklusive
  `clip-path`, `repeating-linear-gradient`, `backdrop-filter: blur`,
  Live-`setInterval`-Update. Alpha-Kanal pixelgenau per `ffmpeg`-
  Pixelsonde verifiziert (Hintergrund `rgba(0,0,0,0)`, Content-Pixel
  `rgba(17,34,102,217)` bei CSS-Vorgabe `rgba(20,40,120,0.85)`).
- **MXL `video/v210a`** ist in der installierten `third_party/mxl`-
  Bibliothek bereits vollständig implementiert (`FlowParser.cpp`,
  eigene Test-Flow-Definition) — kein Fallback auf getrennte
  Fill+Key-Flows nötig.
- **Entscheidung: Variante A (`wpesrc`)**, wie ursprünglich in
  `ARCHITECTURE.md` §11.2 vorgesehen — ein Prozess statt
  Node+Chromium-Kindprozess+CDP-Screencast. `docs/END-GOAL-FEATURES.md`
  §5.5 Punkt 2 damit beantwortet.

  **Verifiziert:** `gst-inspect-1.0 wpesrc` (Element registriert nach
  Paket-Install), 5 reale Renderdurchläufe via `gst-launch-1.0`
  (`wpesrc ! videoconvert ! video/x-raw,format=BGRA ! ... ! pngenc`,
  PNG-Colortype 6 = RGBA bestätigt), Pixel-Stichproben per `ffmpeg`
  gegen die tatsächlichen CSS-Vorgaben der Templates verglichen (keine
  Annahme). Chromium-Kontrollprobe per CDP (gleiche Methode wie
  K1–K4). Templates nur in `/tmp/.../ograf-spike/` kopiert, **nicht**
  ins Repo übernommen (Lizenzfrage §5.5 Punkt 4 weiterhin offen, erst
  vor der echten Übernahme in K5-Teil-1 zu klären). `gstreamer1.0-wpe`
  ist aktuell nur auf dieser Dev-Maschine installiert — Deploy-Skript
  (`deploy/dev/install-wpe.sh` o. Ä.) folgt mit K5-Teil-1.

**K5-Teil-1 (Kern-Node: Template-Scan, `show`/`hide`, Fill+Key-MXL-
Ausgang, erledigt, 2026-07-16):** `docs/END-GOAL-FEATURES.md` §5.4 Teil
1 — neues Crate `nodes/omp-ograf`: Template-Scan (`templates.rs`, EBU-
OGraf-v1-Manifeste über `*.ograf.json`-Glob, nicht rekursiv),
Harness-Seite (`ui/harness.html`, von `wpesrc` per `run-javascript`
gesteuertes `window.omp.show/hide`), Pipeline (`wpesrc → tee →` zwei
`video/v210`-MXL-Flows Fill+Key — Fallback statt eines nativen
`video/v210a`-Einzelflows, s. K5-Teil-0/§11.2: `FlowParser.cpp` kodiert
`v210a` als zwei Rohbyte-Ebenen in einem Grain, kein GStreamer-Format
erzeugt dieses Layout aus BGRA). Descriptor: readonly `templates[]`/
`current`, Methoden `show(templateId, data)`/`hide()`.

Diese Sitzung führte den in der vorherigen (WIP-)Sitzung offen
gelassenen End-to-end-Live-Test zu Ende und fand dabei, dass die
dortige Diagnose eine **Fehldiagnose** war — voller Befund in
`docs/decisions.md` 2026-07-16, Kurzfassung:

- **Echte Ursache des Dauerstillstands (drei Teile, nicht der zuvor
  vermutete Thread/WPE-Konflikt):** (1) den drei `appsink`s der Pipeline
  fehlte `async=false` — ohne dieses Flag muss ein Sink erst einen
  Puffer empfangen, bevor sein Zustandswechsel als abgeschlossen gilt;
  bei drei Sinks an einem `tee` reicht ein einziger, minimal
  abweichender Zweig, um die gesamte Pipeline dauerhaft in
  `gst_base_sink_wait_preroll()` hängen zu lassen (per `gdb`/
  `GST_DEBUG=GST_STATES:5` hart nachgewiesen). Fund per Konsultation von
  `PIPELINE CONTROLLER/lib/PlayerPipeline.js`/`MasterPipeline.js`
  (`UMSETZUNG.md` §0 Punkt 9), wo jeder Tee-Zweig-Sink genau dieses
  Muster (`sync=false async=false`) trägt. (2) Das Alpha-Brücken-
  `appsrc` hatte `is-live=true` — falsch für ein `appsrc`, das manuell
  per `push_buffer()` gefüttert wird (liefert laut GstBaseSrc-Vertrag
  sonst keine Daten vor PLAYING). (3) Henne-Ei-Problem: `wpesrc` lädt
  die Harness-Seite schon beim Pipeline-Aufbau, der reguläre
  Descriptor-HTTP-Server startet aber erst danach (braucht den fertigen
  `PipelineHandle`) — „Connection refused" beim allerersten Seitenaufruf.
  Fix: eigener minimaler HTTP-Server nur für Harness+Templates, vor dem
  Pipeline-Aufbau gestartet (OS-zugewiesener Port,
  `omp_node_sdk::server::spawn` bindet synchron).
- Zusätzlich: `Pipeline::build` wechselt den Zustand jetzt zweistufig
  PAUSED→(`get_state`)→PLAYING→(`get_state`) statt eines einzelnen
  `set_state(Playing)` — `wpevideosrc0` (Live-Quelle) meldet
  `NO_PREROLL` statt `ASYNC`, was GStreamers interne
  Zustands-Buchhaltung ohne begleitenden `get_state()`-Aufruf nicht
  zuverlässig verarbeitet (`gst-launch-1.0` fährt intern denselben
  zweistufigen Ablauf).
- `spawn_alpha_key_bridge` blieb bei einem eigenen Thread +
  blockierendem `try_pull_sample()` (das bewährte, von acht anderen
  Nodes seit C4 genutzte Muster aus `tools/mxl-gst/testsrc.cpp`) — mit
  `async=false` gelöst war kein Umbau auf `AppSinkCallbacks` nötig.

  **Verifiziert (echte Prozesse, kein Mock):** `cargo build/test
  --workspace` grün (inkl. 4 `omp-mediaio::mxl`-Tests), `cargo deny
  check`/`cargo audit` grün. End-to-end per echtem, über den
  Instanz-Launcher gestarteten `omp-ograf`-Prozess: `make contract`
  grün gegen die reale `api_base_url`. `show("hello-lower-third",
  {title, subtitle, accentColor})` → Fill-MXL-Flow zeigt die Bauchbinde
  mit den übergebenen Werten (`omp-viewer`-MJPEG-Preview, JPEG-Frame aus
  dem Multipart-Stream extrahiert, visuell bestätigt), Key-MXL-Flow
  zeigt zeitgleich die passende Alpha-Maske (heller Kasten, transparent/
  schwarz drumherum, weicher Kantenverlauf durch den halbtransparenten
  Kasten-Hintergrund). `hide()` setzt den Key-Flow zurück auf
  vollständig transparent. Beide Flows laufen nach dem Fix durchgehend
  mit realer Framerate (`mxl-info -f <flow>`: `Head index`/`Last write
  time` wachsen kontinuierlich) — vor dem Fix blieb `Head index` nach
  exakt einem Frame stehen. Bekannte, nicht blockierende, vorbestehende
  Einschränkung (nicht neu, `omp_mediaio::mxl` seit C4): ein Reader, der
  sich erst sehr lange nach dem ersten Puffer anschließt, kann
  „TOO EARLY" melden (kein Selbstkorrektur-Mechanismus für den
  Grain-Index) — bei sofort verbundenem Reader (Normalfall) nicht
  beobachtet. Test-Instanzen danach entfernt.

  **Nebenbefund, nicht Teil dieser Scheibe:** hoher gleichzeitiger
  `wpesrc`/`WPEWebProcess`-Ressourcenverbrauch bei vielen
  Neustart-Iterationen auf der 6,5-GB-RAM-Dev-Maschine löste den
  Linux-OOM-Killer aus, der den persistenten `omp-video-mixer-me`-
  Instanzprozess des laufenden Regieplatz-Demo-Setups beendete
  (ungewöhnlich hoher RSS-Wert, `docs/decisions.md` 2026-07-16) —
  `omp-source`/`omp-player-video` verschwanden im selben Zeitraum
  ebenfalls. Alle drei über den Launcher neu gestartet, Mixer→Viewer-
  Kante neu verbunden; die vorherige Crosspoint-/Tally-Konfiguration ist
  nicht wiederherstellbar (kein Snapshot vorhanden) — der Projektinhaber
  sollte das beim nächsten UI-Besuch neu einrichten.

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
| C9 | erledigt | [C9] Contract-Konformitätstest (tools/contract-check) | 2026-07-10 |
| C10 | erledigt | [C10] omp-video-mixer-me: Crosspoint/DVE/Keyer + Tally-Bus im SDK | 2026-07-11 |
| C11 | erledigt | [C11] omp-audio-mixer: dynamische Kanäle, Gain/EQ, Audio-Follow-Video + MXL-Audio-Fundament im SDK | 2026-07-11 |
| C12 | erledigt | [C12] omp-player: PlaylistController als gemeinsames Crate (Video-/Jingle-Profil) | 2026-07-12 |
| C13 | erledigt | [C13] Operator-Console: Rollen-Stub, /api/v1/me/consoles, Console-Ansicht + Kiosk-Routen | 2026-07-12 |
| C14/C15 | erledigt | [C14/C15] omp-playout-automation: Playlist-Controller ohne eigene Pipeline, steuert Player+Mixer fern | 2026-07-13 |
| D1 | erledigt | [D1] PostgreSQL für Layouts/Snapshots statt Datei-Backend | 2026-07-13 |
| D2 | erledigt | [D2] AMWA NMOS Testing Tool in CI gegen die Registry (IS-04-02) | 2026-07-13 |
| D3 (Teil 1: mTLS) | erledigt | [D3-1] step-ca + mTLS Orchestrator↔Nodes (Go-Seite) | 2026-07-13 |
| D3 (Teil 2: IS-10/OAuth2 + §12-Rollen) | erledigt | [D3-2] Nutzer-/Rollenmodell: echte Anmeldung, Rollenbindungen in Postgres, Audit-Log | 2026-07-14 |
| D4 | erledigt | [D4] omp-mediaio::st2110 + omp-srt-gateway (ST 2110 ⇄ SRT) | 2026-07-13 |
| D5-prep | erledigt | [D5-prep] Node-Contract §5 Punkt 6: media-ready-Signal im SDK | 2026-07-14 |
| D5-prep-2 | erledigt | [D5-prep-2] MediaFlow-Trait + media-ready für alle acht verbleibenden Nodes | 2026-07-14 |
| D5 | erledigt | [D5] SDK-Doku + Node-Tutorial (docs/NODE-TUTORIAL.md) | 2026-07-14 |
| D6 Teil 1 (Bootstrap + Telemetrie) | erledigt | [D6-1] omp-host-agent: Bootstrap-Token, Registrierung, CPU/RAM-Telemetrie, Hosts-UI-Panel | 2026-07-14 |
| D6 Teil 2 (Kommandokanal) | erledigt | [D6-2] host-agent + orchestrator: Remote-Start/Stop über NATS, agent-lokaler Katalog als Vertrauensgrenze, UI-Host-Selector | 2026-07-14 |
| D6 Teil 3 (Placement-Engine, §6.1) | erledigt | [D6-3] internal/placement: advisory-only Resource-Aware Placement, CPU/RAM-Schwellwerte, Ausweichhost-Vorschlag, SSE-Event, Hosts-UI-Banner | 2026-07-14 |
| D7 Teil 1 (Workflow-Objekt + Bundle-Start/-Stop) | erledigt | [D7-1] internal/workflows: Workflow-Objekt, Rolle→Rolle-Verkabelung, Bundle-Start/-Stop, UI-Panel | 2026-07-14 |
| D7 Teil 2 (Zeitsteuerung + Ressourcen-Vorprüfung + Stop-Sicherheitsabfrage) | erledigt | [D7-2] Schedule (once/daily/weekly, "verfallen lassen"), confirm_stop, Ressourcen-Vorprüfung als harte Start-Vorbedingung (placement.Engine.CheckHost); live gefundener und behobener Blind-Overwrite-Race zwischen Scheduler und runStart/runStop (Store.UpdateSchedules/UpdateRuntime, JSONB-Partial-Updates statt Get+Put) | 2026-07-18 |
| K1-Teil-1 (Verbindungsschicht + App-Bar mit Tabs) | erledigt | [K1-1] Verbindungsschicht (ConnectionMonitor/apiFetch) + App-Bar mit Tabs, Design-Tokens | 2026-07-14 |
| K2-Teil-1 (omp-player: Datei-Playback MP4/MOV) | erledigt | [K2-1] Datei-Playback (uridecodebin, EOS-Event, Discoverer-Dauer, mediaLibrary) | 2026-07-15 |
| K3/K4-Teil-1 (Konsolen-Optik + Metering) | erledigt | [K3/K4-1] ui/kit (Fader/Knob/Meter/Button) + Audio-Mixer-Metering (/levels-SSE) + Video-Mixer-M/E-Pult-Optik, SSE-/UI-Bundle-Auth-Bugfix; Nachtrag: visueller Feinschliff (Metall-Gradients, omp-panel-section) nach Bildmeister-Referenzvergleich | 2026-07-15 |
| K5-Teil-0 (OGraf-Render-Spike) | erledigt | [K5-0] Go für wpesrc (Variante A) — Paketierung/Sandbox-Crash-Risiken widerlegt, 5 echte Templates pixelidentisch gerendert, Alpha + MXL video/v210a verifiziert | 2026-07-15 |
| K5-Teil-1 (omp-ograf Kern-Node) | erledigt | [K5-1] Template-Scan, show/hide, Fill+Key-MXL-Ausgang — Preroll-Deadlock (fehlendes async=false), is-live-Fehlkonfiguration + Harness-Server-Henne-Ei-Problem gefunden+gefixt (Fehldiagnose der WIP-Sitzung korrigiert) | 2026-07-16 |
| MXL-Read-Livelock (C8-Nachtrag, root-caused) | erledigt | MXL-Read-Livelock root-caused (FUTEX_WAIT im vendorten C++ hängt über sein Timeout hinaus bei ≥2 gleichzeitigen Readern auf demselben Flow) + behoben per `get_grain_non_blocking`/`get_samples_non_blocking` statt blockierender API in `omp-mediaio::mxl` | 2026-07-17 |
| §1.6 (Property-Panel-Breite + Operator-Ansicht-Button) | erledigt | Parameter-Panel: resizable/breiterer Default (420px, Drag-Handle, localStorage-persistiert) statt fest 280px; „Als Operator ansehen"-Button verlinkt `/console/default/<nodeRoleId>` — behebt den gemeldeten „Bildmischer-Buttons vertikal statt horizontal"-Bug (war ein Container-Breiten-Problem, kein separater UI-Pfad), live per CDP verifiziert | 2026-07-17 |
| K7-Teil-1 (Prozess-Auto-Restart) | erledigt | Launcher startet abgestürzte lokale Instanzen automatisch in derselben Instanz-ID neu (Crash-Loop-Bremse 5/60s), `instance.restarted`-Event + Restart-Zähler im Katalog-UI, `workflows.Service` verkabelt die betroffene Rolle nach einem Neustart automatisch neu (echter Live-Bug bei stale NMOS-Registrierungen gefunden+gefixt); live per `kill -9` gegen einen echten Workflow verifiziert | 2026-07-17 |
| §17 Teil 1 (Katalog-Beschreibungen + vermutete Ressourcen) | erledigt | `CatalogEntry.Description`/`ExpectedResources` (additiv, optional), alle zehn `deploy/catalog.json`-Einträge befüllt, Katalog-Palette zeigt beides sichtbar; Teil 2 braucht zuerst Kapitel 14 (Ressourcen-Historie, noch nicht gebaut), Teil 3 (Alarm-View) bleibt offen | 2026-07-17 |
| §17 Teil 3 (Alarm-View) | erledigt | Neuer vierter App-Bar-Tab „Alarme" (`ui/shell/alarm-view.ts`), zentraler Konsument von `/api/v1/instances` (crashed/restartCount), `/api/v1/placement/advice`, `/api/v1/workflows` (status failed) — kein neuer Alarm-Erzeuger; additiv zu `hosts-view.ts`s bestehendem Advice-Banner; live per kill -9 + provoziertem Crash-Loop verifiziert | 2026-07-17 |
| §4.6 (Audio-Mixer: EQ-Parametrisierung + Kompressor + Master-Limiter) | erledigt | `equalizer-nbands` (Freq/Bandbreite je Band statt nur Gain), `audiodynamic`-Kompressor pro Kanal + Master-Limiter (je mit eigenem Makeup-Gain-Element), UI-Bundle um aufklappbare EQ-Freq/Q- und Comp/Limiter-Sektionen erweitert; live per API + CDP-Screenshot + `contract-check` verifiziert. AFV-Pegel und Presets bleiben offen | 2026-07-17 |
| Kapitel 15 Teil 1 (Workflow-Auflösungs-Setting) | erledigt | Orchestrator/UI-Infrastruktur (`Definition.Settings`, `Launcher.Start`-extraEnv, Workflow-Formular) plus `omp-source` bereits 2026-07-17 (live verifiziert: 960×540 statt 640×480); Rest (`omp-switcher`/`omp-player`/`omp-video-mixer-me`, inkl. Laufzeit-Keyer-Geometrie + `DveBox::full_frame()` beim Mixer) am 2026-07-18 nachgezogen, live mit `OMP_WIDTH=800/OMP_HEIGHT=600` gegen alle vier Video-Flows verifiziert; `omp-ograf` bewusst ausgenommen (Template-Auflösung). Teil 2 (echter Lowres-MXL-Sender) offen | 2026-07-18 |
| K11-Teil-1 (Admin-Tab: Nutzer-/Rollenbindungs-Verwaltung + Audit-Log) | erledigt | Neue Endpunkte `GET/DELETE /api/v1/auth/users`, `PUT .../password`; `whoami` liefert `isAdmin` (admin-Verb ODER Bootstrap); Selbstschutz (letzter Admin kann sich nicht selbst löschen/entrechten) bei Nutzer- UND Rollenbindungs-Löschung, live gegen echten Server verifiziert (409); neuer App-Bar-Tab „Administration" (`ui/shell/admin-view.ts`), Bootstrap-Formular = normales „+ Neuer Nutzer"-Formular mit Auto-Login danach (reale Lücke beim Entwerfen gefunden+geschlossen, nicht erst im Test); voll per CDP-Klicks verifiziert: Bootstrap-Anlage → Auto-Login → Testnutzer + `operate`-Bindung auf echte Mixer-Instanz → Console-Landing (C13-Pfad) → 403 auf fremdem Node → Audit-Log zeigt Bindungs-Anlage (201) | 2026-07-17 |
| Kapitel 14 Teil 1 (Host-Gesamt-Historie: Sparkline + Min/Ø/Max) | erledigt | Zweistufiger Ringpuffer pro Host (`hosts.History`: Rohsamples ~1h, 1-Minuten-Aggregate ~24h, in-memory), `GET /api/v1/hosts/{id}/metrics/history?window=…`, Sparkline + Min/Ø/Max-Spalte in `hosts-view.ts`; live gegen einen echten `omp-host-agent`-Prozess verifiziert (Roh-Fenster nach ~45s, abgeschlossener Aggregat-Bucket nach realem Warten über die Minutengrenze) + CDP-UI-Check. Unblockt §17 Teil 2 (zusammen mit Teil 2 unten). Teile 2-4 dort weiterhin offen | 2026-07-19 |
| Kapitel 14 Teil 2 (Pro-Instanz-Telemetrie: CPU%/RSS per `/proc/<pid>`) | erledigt | `host-agent/internal/telemetry.ProcessSampler` (entfernte Instanzen) + `launcher.Launcher.sampleLocalResources()` (lokale, eigenständiges Go-Modul, gleiche Logik dupliziert) — additives `instances[]`-Feld im Host-Metrik-Payload bzw. separate `resourceSamples`-Map (nicht in Postgres persistiert); `httpapi.mergeInstanceMetrics` mischt entfernte Werte in `GET /api/v1/instances` ein; Anzeige einheitlich in der Katalog-Palette ("CPU x% · RAM y MB"), `hosts-view.ts` bewusst unangetastet (das ist §17 Teil 2s Aufgabe). Live gegen einen echten Host-Agent-Prozess + eine lokale Instanz verifiziert (API + CDP-Browser-Check beider Palette-Zeilen). Beiläufig eine bereits vorbestehende, unabhängige MXL-Test-Flakiness beobachtet (nicht verfolgt, s. `docs/decisions.md` Nachtrag 32). Teil 3 (Typ-Profile+Warnung)/Teil 4 (Anbindung) offen | 2026-07-19 |
| §17 Teil 2 (Laufende-Instanzen-Tab) | erledigt | Fünfter App-Bar-Tab „Instanzen" (`ui/shell/instances-view.ts`), reiner Konsument von `GET /api/v1/instances` (Kapitel-14-Teil-2-Felder) + `GET /api/v1/hosts` (Host-Label), keine neue Backend-Logik; 5s-Poll statt der sonstigen 30s-SSE-Fallback-Kadenz (CPU%/RSS haben keinen eigenen SSE-Trigger), Client-seitige Sortierung wegen Go-Map-Iterationsreihenfolge in `Launcher.List()`. Live per CDP verifiziert, inkl. eines echten `kill -9`-Crash→Auto-Restart-Zyklus, der ohne Reload in der Tabelle ankam (neue PID, „↻ 1×"). Mit Teil 1-3 ist §17 jetzt bis auf Teil 4/5 (Import/Versionierung) vollständig | 2026-07-19 |
| §7.6 (stabile Konsolen-Rolle über Prozess-Restart hinweg) | erledigt | Backend war bereits korrekt (`consoles.NodeRoleID` = stabile Instanz-ID, `/api/v1/me/consoles` löst live auf); Lücke lag im Client — `shell.ts` fetchte Konsolen nur einmal beim Seitenaufbau. Neu: `watchConsoleEntries()` (SSE-first `node.added`/`node.removed` + 30s-Poll-Fallback) + `console-view.ts` erkennt eine geänderte `uiBundleUrl` der aktiven Rolle und remountet gezielt (Entscheidungslogik ausgelagert in `console-logic.ts`, 6 neue `deno test`-Fälle). Live per CDP mit einem echten `nodes/mock`-Prozess verifiziert: `kill -9` → K7-Teil-1-Neustart mit neuer NMOS-Node-ID → bereits offene Kiosk-Konsole zeigte per Netzwerk-Trace beweisbar das neue Bundle, `Page.getNavigationHistory` blieb bei einem Eintrag (kein Reload). §7.6 damit vollständig; echtes Hot-Standby-Failover (§7.3d Teil 4) bleibt eigene, größere Folgearbeit | 2026-07-19 |
| §4.6 Nachtrag Punkt 3 (Audio-Follow-Video-Pegel) | erledigt | Statt `-inf`-Sentinel (JSON kennt keine Unendlichkeit) zwei Felder pro Kanal: `followUseMute` (Default `true`, bitgenau altes Verhalten) + `followOffLevelDb`; neuer Setter `channel.<id>.setFollowOffLevel`. Bei `false` rampt/springt `cut`/`crossfade` auf den konfigurierten Pegel statt Mute/-60dB, `mute` bleibt durchgehend `false`. Live gegen einen echten `omp-audio-mixer` mit einem echten `nats pub omp.tally.<id>`-Event verifiziert: realer `/levels`-SSE-Master-Pegel zeigte eine glatte Rampe auf exakt `0.3 × 10^(-18/20)` (rechnerisch der konfigurierte Zielpegel), Rückwärtskompatibilität (`followUseMute:true`) bitgenau bestätigt (Pegel → praktisch Null, `mute:true`); UI-Bundle-Steuerung (Checkbox+Zahlenfeld+Button) per echtem Chromium-Klick verifiziert | 2026-07-19 |
| §4.6 Nachtrag Punkt 3 (Erweiterung: An-Pegel + Transition-Zeit) | erledigt | Nutzer-Feedback direkt im Anschluss: „An" soll ebenfalls eigenständig einstellbar sein (nicht implizit der Fader), dazu eine konfigurierbare Transition-Zeit statt fester 500ms. `setFollowOffLevel` → `setFollowLevels(useMute, onLevelDb, offLevelDb, transitionMs)`; bei `followUseMute==false` übernimmt AFV den Gain vollständig eigenständig (Fader wird ignoriert), bei `true` bitgenau der alte Mute+Fader-Pfad. Live beide Rampenrichtungen + `cut`-Sofortsprung mit `transitionMs=1000` gegen echte `/levels`-Messwerte verifiziert (exakte dB-Mathematik bestätigt; ein erster Testlauf zeigte scheinbar keine Änderung — Timing-Fehler im Testskript, kein Implementierungsfehler, per direktem `setGain`-Gegentest + sauberem Wiederholungslauf aufgeklärt), UI-Bundle um „An-Pegel"/„Transition ms"-Felder erweitert, per Chromium-Klick verifiziert. Mixer-Presets (§4.6 Punkt 4) bleiben offen | 2026-07-19 |
| Kapitel 15 Teil 2 (zweiter, referenzgezählter Lowres-MXL-Sender) | erledigt | Nutzerentscheidung: feste 320×180-Auflösung, nur bei aktivem Vorschau-Bedarf zugeschaltet (nicht "immer mitlaufend"). `urn:x-nmos:tag:grouphint/v1.0` gegen die echte AMWA-NMOS-Parameter-Registry verifiziert (Sender-Tag, nicht Flow/Source — abweichend von der ungenauen Doku-Formulierung). `SenderSpec` bekommt additives `tags`-Feld (omp-node-sdk), `omp-source` (Pilot-Node wie Teil 1) bekommt einen dritten `tee`-Zweig mit zweitem `MxlVideoOutput`, referenzgezählte `activateLowresPreview`/`releaseLowresPreview`-Methoden schalten dessen bereits vorhandenen Valve. Live verifiziert: Sender+Grouphint-Tags in der Registry, zwei eigenständige MXL-Flows, Lowres-Flow-Index blieb bei 0 (kein Grain geschrieben) bis zur Aktivierung, danach wachsend; Referenzzählung (2×aktiviert/1×freigegeben → weiterhin aktiv) und Unterlauf-Schutz bestätigt; Highres-Flow lief währenddessen ununterbrochen weiter. Teil 3 (Bildmischer/Multiviewer lesen lowres)/Teil 4 (weitere Lowres-Quellen) bleiben offen | 2026-07-19 |
| Kapitel 15 Teil 3 (teilweise: `omp-multiviewer` liest bevorzugt lowres) | teilweise | Pilot `omp-multiviewer` (reiner Monitor, kein PGM-/Preview-Unterschied wie beim Mischer). Discovery baut eine Grouphint-Gruppen-Map aus dem ohnehin geholten Sender-Satz, aktiviert/gibt den Lowres-Sender der jeweiligen Quelle über einen direkten Node-zu-Node-HTTP-Aufruf frei (`omp-node-sdk::peer::PeerClient`, neu ins SDK gehoben — Präzedenzfall bereits in `omp-playout-automation` gefunden, nicht erfunden; `get_node` neu am `RegistryClient`), `MxlVideoInput` öffnet den Lowres- statt Highres-Flow, Rückfall auf Highres bei Aktivierungs-Fehlschlag pro Kachel. Live verifiziert: `lowresActive` wechselte via echtem HTTP-Aufruf auf `true`, `mxl-info` zeigte aktives Lesen des Lowres- statt Highres-Flows, MJPEG-Vorschau lieferte echte, visuell bestätigte Frames (SMPTE-Farbbalken + Label). Dokumentierte Lücke: kein Graceful-Release beim Multiviewer-Shutdown. `omp-video-mixer-me`/`omp-switcher` (PGM-Pfad bleibt highres, komplexer) bleiben offen | 2026-07-19 |
| Kapitel 15 Teil 4 (teilweise: Lowres-Sender auch in `omp-player`) | teilweise | Gleicher Handgriff wie Teil 2, mit einem Strukturunterschied: `omp-player`s PGM hing bisher direkt am `input-selector` (1:1-Pad, kein Fan-out) — neuer `tee` dazwischen war nötig, bevor ein zweiter (Lowres-)Zweig möglich war. `ActivePipeline` wird nur einmal pro Prozesslaufzeit gebaut (Cue/Take rebuilt nur die Input-Zweige vor dem isel), der Lowres-Ausgang + Referenzzähler leben deshalb genauso einmalig wie bei `omp-source`. Im Jingle-Profil (`has_video==false`) bleibt der Lowres-Sender korrekt ganz weg. Live verifiziert inkl. Generalisierungs-Bonus: eine echte `omp-multiviewer`-Instanz (Teil 3) entdeckte und nutzte den neuen Player-Lowres-Sender automatisch, ganz ohne player-spezifischen Code dort — bestätigt die Grouphint-Discovery aus Teil 3 als producer-agnostisch. `omp-ograf` bleibt offen (Design-Frage Lowres-Fill allein vs. auch Lowres-Key, nicht im Dokument entschieden) | 2026-07-19 |
| §4.6 Punkt 4 (Mixer-Presets) | erledigt | Blocker live entdeckt: der geplante Weg (Snapshot-Service B7 per `nodeIds:[self]` einschränken, Erfassungscode wiederverwenden) erfasste bei `omp-audio-mixer`/`omp-video-mixer-me` nichts, weil beide ausnahmslos alle Parameter `readonly:true` erklären (Mutation nur über `invoke()`-Methoden) — `GetWritableParams` filtert strikt auf `readonly==false`. Nutzerentscheidung (3 Optionen vorgelegt): Node-Contract um optionale `GET`/`POST /state`-Route erweitert (opakes, node-eigenes JSON über den vorhandenen `extra_route`-Erweiterungspunkt, kein Descriptor-Schema-Update, 404 = Node unterstützt es nicht) statt `set()` PATCH-fähig nachzurüsten oder den Scope zurückzustellen. Snapshot-Service versucht `GetState` je Node zuerst (gilt auch für workflow-weite Szenen, nicht nur Node-Presets), fällt sonst auf die Parameter-Enumeration zurück. `omp-audio-mixer` und (gleicher Tag, Nachtrag) `omp-video-mixer-me` bekamen beide dasselbe UI-Presets-Panel. Live verifiziert: echter Kanal-Gain -12dB → Preset erstellt → Gain auf +3dB geändert → Preset angewendet → wieder -12dB, keine Kanal-Duplikate; zusätzlich per echtem Chromium/CDP-Klick auf "Preset speichern"/einen Preset-Chip bestätigt (ein scheinbarer Fehlschlag im ersten CDP-Durchlauf war ein Label-Kollisions-Testartefakt, kein Produktfehler, per Preset-ID-Vergleich aufgeklärt). `omp-video-mixer-me`: echter Keyer+DVE-Box gesetzt → Preset gespeichert → zurückgesetzt → per Klick auf den Preset-Chip exakt wiederhergestellt | 2026-07-19 |
| Kapitel 16 Teil 0 (MXL-Fabrics: Build aktivieren + Spike) | erledigt | Zwei echte, live entdeckte Blocker statt des veranschlagten "eine Sitzung, wie K5-Teil-0" — beide mit dem Nutzer abgestimmt statt geraten. (1) Debian Bookworms `libfabric-dev` (1.17.0) zu alt für MXLs vendorten Fabrics-Code (braucht die libfabric-2.x-API, `fi_fabric2`/neue `fi_mr_attr`-Felder existieren in 1.17 nicht) — libfabric 2.6.0 aus Quellcode vendort (`third_party/libfabric`, `autogen.sh`/`configure --enable-tcp=yes`/`make install` in einen lokalen Prefix, MXLs CMake per `PKG_CONFIG_PATH` + `cmake --fresh` darauf umgestellt — ein reines `cmake --preset` ohne `--fresh` behält alte gecachte pkg-config-Pfade). (2) MXLs eigene Fabrics-C-API war im projektweit gepinnten Tag `v1.0.1` eine reine Stub-Implementierung (jede Funktion liefert bedingungslos `MXL_ERR_INTERNAL`) — MXL auf `v1.1.0-beta-1` angehoben (Nutzerentscheidung, einzige Version mit echter Implementierung), `deploy/dev/install-mxl.sh` aktualisiert. Voller Regressionstest vor dem Fabrics-Spike: Rust-Workspace neu gebaut (ein Cargo-Build-Cache-Bug in `mxl-sys/build.rs` gefunden — fehlendes `rerun-if-changed` im tatsächlich genutzten `mxl-not-built`-Feature-Zweig, `cargo clean -p mxl-sys -p mxl` behob es), ein echter `omp-source` gestartet und per `mxl-info` über eine echte Sekunde wachsender Head-Index bestätigt. Eigentliche Teil-0-Verifikation: zwei unabhängige MXL-Domains, echter SMPTE-Flow per `mxl-gst-testsrc`, `mxl-fabrics-demo` als Target+Initiator über `--provider tcp` verbunden — Ziel-Domain zeigte danach denselben Flow mit kontinuierlich wachsendem Head-Index, echter One-Sided-RDMA-Transfer ohne RDMA-Hardware bestätigt. `third_party/libfabric` neu ins `.gitignore` | 2026-07-19 |
| Kapitel 16 Teil 1 (`omp-mediaio::fabrics`-Grundmodul, Fundament-Ebene) | erledigt | Eigene, schlanke bindgen-Anbindung an `mxl/fabrics.h` statt einer Erweiterung der vendorten `mxl-sys` (deckt kein `fabrics.h` ab). Live entdeckt: `mxlFabrics*`-Symbole liegen in einer eigenen `libmxl-fabrics.so` (CMake-Target `mxl-fabrics`), die laut `ldd` nicht einmal gegen `libmxl.so` linkt — zwei getrennte bindgen-Durchläufe + zwei `dlopen`s mit Zeiger-Casts zwischen den unabhängig generierten Opak-Typen an den FFI-Grenzstellen; `deploy/dev/install-mxl.sh`/`mxl.env` um den zweiten `LD_LIBRARY_PATH`-Eintrag ergänzt. Zweiter Fund: Verbindungsaufbau kam nicht zustande, solange nur die Initiator-Seite pollte — `mxl-fabrics-demo`s Target-Loop nutzt ausschließlich die blockierende `ReadGrain`-Variante, die offenbar auch den Verbindungsaufbau der Zielseite treibt; gelöst mit zwei unabhängig pollenden Threads im Test (näher am echten Zwei-Prozess-Modell). Dritter, kleinerer Fund: `build.rs` referenzierte `bindgen` zunächst unbedingt und brach dadurch den Standard-/`mxl`-only-Build (bindgen ist ein optionales Build-Dependency); behoben mit echten `#[cfg(feature = "fabrics")]`-Gates statt eines reinen Laufzeit-Checks, alle vier Feature-Kombinationen live nachgebaut. Live verifiziert (`cargo test`, 5× ohne Flakiness): echter Grain-Transfer per One-Sided-RDMA zwischen zwei temporären MXL-Domains über den `tcp`-Provider. `Output`-Trait-/GStreamer-Anbindung (analog C5 auf C4) bleibt offener nächster Schritt | 2026-07-19 |
| Kapitel 19 Teil 0 (ST 2110-30/AES67-Audio in `omp-mediaio::st2110`) | erledigt | `St2110AudioOutput`/`St2110AudioInput` (`rtpL24pay`/`rtpL24depay`, RFC 3190) analog den bestehenden Video-Typen — Payload-Familie am echten `gst-inspect-1.0`-Lauf verifiziert, nicht geraten. `min-ptime`/`max-ptime` explizit auf 1ms gesetzt (GStreamer-Default ist unbegrenzt bis MTU, AES67-Konformitätsstufe A/ST-2110-30-Standardprofil verlangen exakt 1ms). Live auf drei Ebenen verifiziert: eigener UDP-Loopback-Test, SDP-Regressionstest (`a=rtpmap:96 L24/<rate>/<channels>` + `a=ptime:1`), und die im Phasenplan geforderte echte FFmpeg-Gegenprobe (`#[ignore]`d, `--ignored` gezielt gelaufen) — ein unabhängiger `ffmpeg`-Prozess sendet einen echten Sinuston als `pcm_s24be`/L24-RTP, `St2110AudioInput` empfängt/dekodiert ihn korrekt (der eigentliche Interop-Nachweis, ffmpegs eigenes SDP deckte sich exakt mit dem selbst erzeugten). Ein erster Versuch, den Pegel zusätzlich per `level`-Element+Bus-Watch zu messen, scheiterte an einem fehlenden laufenden GLib-Mainloop — als unnötige Zusatzstrenge verworfen statt einer Debugging-Sackgasse nachzujagen. `cargo clippy`/`cargo test --workspace` grün. PTP-Zeitbasis (Teil 2), `omp-aes67-gateway`/SAP (Teil 3), NDI-Gateway (Teil 4) bleiben offen | 2026-07-19 |
| Kapitel 19 Teil 1 (`omp-2110-gateway`-Node-Paar) | erledigt | Neuer Node, zwei Richtungen (`OMP_2110_GATEWAY_DIRECTION=ingest\|output`) — anders als `omp-srt-gateway` (reines Protokoll-Gateway) berührt hier eine Seite den OMP-internen MXL-Fabric: Ingest fix konfiguriert (`St2110VideoInput ! MxlVideoOutput`, IS-04-Sender), Output wählt die MXL-Quelle dynamisch per echtem IS-05-Receiver-PATCH (`MxlVideoInput ! St2110VideoOutput`, Rebuild-bei-Connect wie `omp-viewer`). Vorarbeit live entdeckt nötig: `St2110VideoInput`/`St2110AudioInput` waren Unicast-only, neuer `multicast_group`-Parameter (nur `udpsrc`s `address`-Property, kein neues Element, `auto-multicast` übernimmt den Rest) + ein neuer Multicast-Loopback-Test bestätigen es live. Neuer minimaler SDP-Parser (`sdp.rs`, kein RFC-4566-Vollparser/keine neue Dependency) für die SDP-Annahme auf der Ingest-Seite. Ein echter Bug live gefunden+behoben: die erste `SenderSpec` setzte dieselbe UUID doppelt als Sender- und Flow-ID, NMOS-Registrierung schlug mit HTTP 400 fehl. Live verifiziert mit einer echten Drei-Prozess-Kette ohne jeden Mock: `gst-launch-1.0`-Quelle → Ingest-Gateway (echter, über die Zeit wachsender MXL-Head-Index) → echte IS-04-Sender-Registrierung → Output-Gateway per echtem `POST /api/v1/graph/edges` verbunden → echtes 2110-Multicast → unabhängiger `gst-launch-1.0`-Empfänger dekodierte den kompletten Pfad erfolgreich. Kein Katalog-Eintrag (wie `omp-srt-gateway`, Richtungs-Env-Vars passen nicht zur generischen Launcher-UI). Audio-Gateway-Betrieb, PTP (Teil 2), `omp-aes67-gateway`/SAP (Teil 3), NDI-Gateway (Teil 4) bleiben offen | 2026-07-19 |
