# Eigenen Node bauen — Tutorial

Ziel: ein lauffähiger OMP-Node, der sich selbst registriert, Parameter
über den generischen Orchestrator-Proxy anbietet und im Flow-Editor
erscheint — in unter einer Stunde, auf Basis des Rust-SDK
(`omp-node-sdk`). Jeder Schritt unten ist an einer echten, laufenden
Dev-Umgebung nachvollzogen worden (nicht nur beschrieben) — die
gezeigten Befehle/Ausgaben sind echte Kommando-Läufe, keine Beispiele.

Für die Konzepte dahinter: `ARCHITECTURE.md` §5 (Node-Contract), §11.1
(IS-12/14-Objektmodell, warum Parameter/Methoden so aussehen, wie sie
aussehen). Hier geht es nur um „wie baue ich das".

## Der Node-Contract in Kürze

Jeder Node — intern oder von dir gebaut — erfüllt sechs Punkte
(`ARCHITECTURE.md` §5). Das SDK übernimmt fünf davon automatisch, sobald
du `omp_node_sdk::run()`/`start()` aufrufst:

1. **IS-04-Registrierung** — SDK macht das.
2. **Selbstbeschreibung (IS-12/14-artig)** — du implementierst den
   [`ParamStore`](../nodes/omp-node-sdk/src/server.rs)-Trait, SDK liefert
   ihn über `GET /descriptor.json` aus.
3. **`/ui/manifest.json` + `/ui/bundle.js`** — optional, nur falls dein
   Node eine eigene UI mitbringt (§4.5, hier nicht behandelt).
4. **Media-I/O über MXL/ST 2110** — nur relevant, wenn dein Node
   tatsächlich Audio/Video verarbeitet (Schritt 4 unten).
5. **Eigenständiger, unabhängig neustartbarer Prozess** — dein `main()`.
6. **State-Export/Import + „media-ready"-Signal** — Export/Import ist
   durch Punkt 2 automatisch erfüllt (der generische Descriptor/Params-
   Mechanismus deckt das ab); das media-ready-Signal setzt du über
   `NodeConfig.media_ready` (`MediaReadySource`, s. Schritt 4).

## Voraussetzungen

- Rust/Cargo (aktuelle Version)
- Laufender Dev-Stack aus dem Repo-Root: `make up` (NATS + NMOS-Registry
  + Postgres als Podman-Container) — für den Descriptor-Roundtrip unten
  reicht das; für „erscheint im Flow-Editor" zusätzlich den
  Orchestrator: `make start` (siehe `docs/HANDBUCH.md`).

## Schritt 1: Minimal-Node ohne Medien

Das SDK bringt bereits ein vollständiges, funktionierendes Minimalbeispiel
mit — `nodes/omp-node-sdk/examples/hello_node.rs`. Statt es hier zu
duplizieren, ein Durchgang durch seine Teile:

**`ParamStore`-Implementierung** — dein Node hält seinen eigenen
Zustand (hier: eine `HashMap` hinter einem `Mutex`) und beantwortet vier
Methoden:

```rust
impl ParamStore for HelloStore {
    fn descriptor(&self) -> Descriptor { /* welche Parameter/Methoden gibt es */ }
    fn get(&self, name: &str) -> Option<Value> { /* aktueller Wert */ }
    fn set(&self, name: &str, value: Value) -> Result<(), SetError> { /* PATCH */ }
    fn invoke(&self, name: &str, args: &Map<String, Value>) -> Result<(), InvokeError> { /* POST */ }
}
```

`descriptor()` listet exakt die Parameter/Methoden, die `get`/`set`/
`invoke` tatsächlich kennen — der Orchestrator (und darüber das
generische Parameter-Panel im Flow-Editor, B6) fragt `descriptor()` ab,
um zu wissen, was es überhaupt gibt; er hat **keine** Kenntnis, dass
dein Node z. B. „gain" oder „label" heißt.

**`main()`** — Env-Variablen einlesen, Store bauen, `omp_node_sdk::run()`
mit einer `NodeConfig` aufrufen:

```rust
omp_node_sdk::run(
    NodeConfig {
        label, host, port, registry_url, nats_url,
        senders: vec![SenderSpec::default()],
        receivers: vec![omp_node_sdk::ReceiverSpec::default()],
        instance_id: std::env::var("OMP_INSTANCE_ID").ok(),
        media_ready: omp_node_sdk::MediaReadySource::NotApplicable,
    },
    store,
).await
```

`senders`/`receivers` hier sind Platzhalter (leere `SenderSpec`/
`ReceiverSpec`, `..Default::default()`) — nur relevant, sobald dein Node
wirklich Medien sendet/empfängt (Schritt 4). `media_ready:
NotApplicable` ist korrekt für jeden Node ohne Medien-Pipeline (§5
Punkt 6, `ARCHITECTURE.md`) — meldet sofort Bereitschaft, weil es
nichts abzuwarten gibt.

## Schritt 2: Starten und prüfen

```sh
cd nodes
OMP_LABEL="Mein Node" OMP_PORT=9101 cargo run --example hello_node
```

Erwartete Ausgabe: `omp-node-sdk: node registered: <uuid>`. Jetzt gegen
den Node selbst prüfen (Port aus dem Beispiel oben):

```sh
curl -s http://localhost:9101/descriptor.json
# {"parameters":[{"name":"label",...},{"name":"gain","type":"number","unit":"dB",...}],"methods":[{"name":"reset","args":[]}]}

curl -s -X PATCH http://localhost:9101/params/gain -d '{"value":-6}'
# {"value":-6}

curl -s -X POST http://localhost:9101/methods/reset
# {"ok":true}
```

Und über den **generischen Orchestrator-Proxy** (bei laufendem
`make start`) — das ist der Pfad, den der Flow-Editor tatsächlich
benutzt, `curl` gegen den Node direkt oben war nur zum Nachvollziehen:

```sh
curl -s http://localhost:8000/api/v1/nodes | jq '.[].label'
# "Mein Node"
# "omp-registry"
```

Öffne `http://localhost:8000` im Browser — die Kachel „Mein Node"
erscheint automatisch (Selbstregistrierung, kein manuelles Eintragen),
Klick öffnet das generische Parameter-Panel mit genau den Feldern aus
`descriptor()`.

**Contract-Check** (`ARCHITECTURE.md` §5, `UMSETZUNG.md` C9) — prüft
maschinell, ob dein Node den Contract wirklich erfüllt (IS-04,
Descriptor-Schema, Param-Roundtrip):

```sh
NODE_URL=http://localhost:9101 make contract
# [PASS] IS-04-Registrierung
# [PASS] Descriptor-Schema
# [PASS] Param-Roundtrip
# [SKIP] UI-Manifest (optional laut Node-Contract)
# [PASS] IS-05 (informativ)
# contract-check: PASS
```

Wenn das durchläuft, erfüllt dein Node den Contract vollständig genug
für die Plattform — unabhängig davon, was er inhaltlich tut.

## Schritt 3: Eigenes, eigenständiges Crate

`hello_node.rs` ist ein `cargo example` **innerhalb** des
`omp-node-sdk`-Crates — praktisch zum Ausprobieren, aber kein
eigenständiger Node. Für einen echten, für sich lauffähigen Node
brauchst du ein eigenes Crate. `omp-node-sdk` ist (Stand jetzt) nicht
auf crates.io veröffentlicht — der reale Weg heute ist ein
Workspace-Member mit Pfad-Abhängigkeit (dokumentierte, bewusste
Einschränkung, kein Versehen: sobald das Projekt Releases hat, kommt
eine Git-/Versions-Abhängigkeit als Alternative dazu):

```sh
cd nodes
cargo new --bin mein-node        # legt sich selbst als workspace member in nodes/Cargo.toml an
```

`nodes/mein-node/Cargo.toml`:

```toml
[package]
name = "mein-node"
version = "0.1.0"
edition = "2024"
publish = false

[dependencies]
omp-node-sdk = { path = "../omp-node-sdk" }
serde_json = "1.0.150"
tokio = { version = "1.52.3", features = ["rt", "macros"] }
```

`nodes/mein-node/src/main.rs` — dieselbe Struktur wie `hello_node.rs`
(Schritt 1), nur mit deinen eigenen Parametern/Methoden. Dieser exakte
Ablauf (neues Crate, obiges `Cargo.toml`, ein `ParamStore` mit zwei
Parametern + einer Methode) wurde beim Schreiben dieses Tutorials real
durchgespielt: `cargo run -p mein-node` registrierte sich beim ersten
Versuch, `make contract NODE_URL=…` lief PASS, die Kachel erschien im
Flow-Editor (per Browser-Test/CDP bestätigt) — kein Nacharbeiten nötig.

```sh
cargo run -p mein-node
```

## Schritt 4: Echtes Medien-I/O (Zero-Copy via MXL)

Bisher hat der Node nur Parameter, keine Medien. Für Audio/Video nutzt
du `omp-mediaio` (`ARCHITECTURE.md` §10.1) statt selbst GStreamer-Rohr-
leitungen ans Netz zu hängen. Kein eigenständiges Tutorial hier — das
beste Referenzbeispiel ist bereits im Repo, vollständig lauffähig:
`nodes/omp-source/` (Test-Videoquelle → MXL, `UMSETZUNG.md` C5). Lies
`nodes/omp-source/src/pipeline.rs` und `src/main.rs` zusammen:

- `omp_mediaio::mxl::MxlVideoOutput`/`MxlAudioOutput` — Pipeline-Element
  (`appsink`, s. `omp-mediaio`) das GStreamer-Buffer in einen MXL-Flow
  schreibt. Baust du analog: `videotestsrc ! … ! MxlVideoOutput::new(…)`.
- `SenderSpec { transport: Some(TRANSPORT_MXL), flow: Some(FlowSpec::Video{…}), .. }`
  in deiner `NodeConfig` statt der leeren `SenderSpec::default()` aus
  Schritt 1 — registriert Sender **und** Flow gemeinsam. Konvention:
  Flow-UUID == MXL-`flow-id` (`flow: Some(FlowSpec::Video{ id: Some(flow_id), .. })`).
- **`media_ready` ehrlich setzen** (§5 Punkt 6, `UMSETZUNG.md` D5-prep/
  D5-prep-2): `MediaReadySource::NotApplicable` ist ab jetzt falsch (du
  hast Medien-I/O). Seit D5-prep-2 bringt `omp_mediaio::MediaFlow`
  (`lib.rs`, `fn has_flowed(&self) -> bool`) das für alle MXL-/RTP-/
  ST-2110-I/O-Typen bereits fertig mit — für den Normalfall (dein Node
  baut seine `MxlVideoOutput`/`MxlAudioOutput`/`MxlVideoInput`/… einmal
  auf und behält sie über die gesamte Prozesslaufzeit) reicht ein
  direkter Aufruf, kein eigener Zähler nötig:
  ```rust
  // Element lebt in derselben Struktur, die die NodeConfig baut:
  media_ready: omp_node_sdk::MediaReadySource::Probe(Arc::new({
      let output = mxl_output.clone(); // Arc<MxlVideoOutput> o.ä.
      move || output.has_flowed()
  }))
  ```
  Lebt dein I/O-Element nur innerhalb eines separaten Pipeline-Threads
  (nicht über die gesamte Prozesslaufzeit erreichbar, z. B. `omp-player`s
  `ActivePipeline`) nimm stattdessen den eigenständigen, klonbaren
  Griff `MxlVideoOutput::flowed_handle() -> Arc<AtomicBool>` (gleiche
  Semantik, unabhängig von der Element-Lebensdauer).
  **Ausnahme, mehr Aufwand nötig:** baut dein Node seinen Eingang zur
  Laufzeit neu auf (Umschalten der Quelle wie bei einem Switcher/Viewer),
  stirbt das interne Flag bei jedem Rebuild mit der alten Instanz — dort
  brauchst du ein von außen persistentes, über Rebuilds hinweg bewusst
  zurückgesetztes Flag samt eigener Pad-Probe (Referenzmuster:
  `nodes/omp-viewer/src/pipeline.rs`s `flowed`/`flowed_probe`,
  kommentiert). Hast du gar keine Probe verdrahtet, ist
  `MediaReadySource::Unknown` (meldet konservativ `false`) ehrlicher als
  ein geratenes `true`.

Für Empfänger (dein Node **liest** einen MXL-Flow, z. B. wie
`omp-viewer`) ist `MxlVideoInput`/`MxlAudioInput` das Gegenstück — du
löst die `flow_id` der Quelle über die Registry-Query-API auf (Muster
in `omp-viewer`s `main.rs`, Stichwort IS-05-Receiver-PATCH).

## Latenz deklarieren & Delay-Kompensation (optional, empfohlen für Medien-Nodes)

Sobald dein Node echtes Medien-I/O hat (Schritt 4), sollte er zusätzlich
seine inhärente Verarbeitungslatenz deklarieren — das ist die
Voraussetzung dafür, dass der Orchestrator ein Workflow-Latenzbudget
(`targetLatencyFrames`, `ARCHITECTURE.md` §15.1) überhaupt berechnen
kann. Formal additiv nachrüstbar (kein SDK-v1-Pflichtpunkt), aber
**empfohlen**: ein Node ohne diese Angabe zwingt jeden Pfad, der ihn
enthält, in den konservativen „Latenz unbekannt" -Fallback, der ein
gesetztes Latenzbudget für diesen Pfad ablehnt.

In deiner `Descriptor` (`ParamStore::descriptor()`) setzt du das
`latency`-Feld:

```rust
Descriptor {
    // …
    latency: Some(LatencyInfo {
        video: Some(LatencyRange { min_latency_frames: 1, max_latency_frames: 1 }),
        audio: None,
        data: None,
        supports_delay_compensation: false, // s. u.
    }),
}
```

`min`/`max_latency_frames` sind die Anzahl Frames, die zwischen Eingang
und Ausgang deines Nodes strukturell vergeht (z. B. `0/0` für einen
reinen Generator ohne Eingang wie `omp-source` — er ist sein eigener
Ursprung; `1/1` für einen Node mit genau einem Frame Pipeline-Latenz).
Miss das nicht raten — falscher Wert unterläuft das Latenzbudget
stillschweigend, ehrlich hoch geschätzt ist besser als optimistisch
geraten.

**Delay-Kompensation (`supportsDelayCompensation`/`setOutputDelay`):**
kann dein Node seinen Ausgang zusätzlich um eine vom Orchestrator
vorgegebene Frame-Zahl verzögern (typisch für Nodes, die ohnehin schon
einen MXL-Ausgang selbst schreiben, z. B. über
`omp_mediaio::mxl::MxlVideoOutput`), setze `supports_delay_compensation:
true` und ergänze eine Methode:

```rust
Descriptor {
    // …
    methods: vec![MethodSpec {
        name: "setOutputDelay".into(),
        args: vec![MethodArg { name: "frames".into(), kind: ParamType::Number }],
    }],
}
```

`invoke("setOutputDelay", args)` liest `frames` (`u64`, negative/
fehlende Werte ablehnen) und muss den Wert **live**, ohne
Pipeline-Neuaufbau, wirksam machen — der Orchestrator ruft die Methode
üblicherweise erst nach `awaitRegistration` auf, also potenziell
**nachdem** dein Node bereits den ersten Frame geschrieben hat. Ein
Referenzmuster (`omp-mediaio::mxl::MxlVideoOutput`/`write_loop`, genutzt
von `omp-scaler` und `omp-video-mixer-me`, D8 Teil 3): das aktuell
gesetzte Delay in einem von außen übergebenen `Arc<AtomicU64>` halten
(überlebt Pipeline-Neuaufbauten, anders als ein pipeline-lokales
Element) und bei **jedem** geschriebenen Frame frisch auslesen statt es
einmalig beim ersten Frame zu „verankern" — ein reales Design-Bug in
der ersten Fassung fror den Wert genau an dieser Stelle dauerhaft ein
(`docs/decisions.md` Nachtrag 114). Reicht dein Node einen
`GstReferenceTimestampMeta`-Ursprungsindex durch (Empfänger-seitig via
`MxlVideoInput`/`MxlAudioInput` automatisch angehängt), ist der
Ziel-Grain-Index `Ursprungs-Index + Delay`; hat dein Node keinen
durchgereichten Ursprung (z. B. ein Compositor-Ausgang wie beim Mixer,
der immer einen neuen Ursprung setzt), gilt dieselbe Formel gegenüber
der aktuellen Wallclock-Position — in beiden Fällen bleibt der
bestehende Monotonie-Schutz (`max(Ziel, letzter_Index + 1)`) unverändert
nötig.

## Schritt 5: In den Instanz-Launcher/GUI-Katalog aufnehmen (optional)

Damit dein Node aus der GUI heraus startbar ist (statt nur per
`cargo run`/Terminal, `UMSETZUNG.md` C8) — zwei unterschiedliche Wege,
je nachdem, wie du deinen Node ausliefern willst:

**Weg A — lokal gebautes Binary (dein Fall nach Schritt 3, kein
Container):** Eintrag in `deploy/catalog.json` ergänzen
(`{"type": "mein-node", "label": "Mein Node", "command": ["nodes/target/debug/mein-node"], "env": {}}`
— `"runner"` weglassen, Default ist `"process"`), Binary vorher bauen
(`cargo build -p mein-node`, der Launcher startet kein `cargo run`).
**Wichtig, leicht zu übersehen:** `deploy/catalog.json` wird nur beim
Orchestrator-**Start** gelesen, kein Hot-Reload — nach dem Editieren
`make stop && make start` (bzw. nur den Orchestrator-Prozess neu
starten), sonst bleibt dein Eintrag unsichtbar. Danach erscheint dein
Node-Typ in der Katalog-Palette des Flow-Editors, mehrfach
instanziierbar.

**Weg B — Katalog-Import über die GUI (`Administration`-Tab, §17 Teil
4/5, `docs/HANDBUCH.md` Abschnitt 9.5):** ohne Orchestrator-Neustart, aber
**nur für containerisierte Nodes** — `POST /api/v1/catalog` (bzw. das
Import-Formular) verlangt serverseitig `runner: "podman"` plus ein
Image (`launcher.ImportCatalogEntry`, `orchestrator/internal/launcher/
launcher.go`); ein reiner Prozess-Eintrag wie aus Weg A lässt sich
darüber **nicht** anlegen (weder API noch GUI). Für deinen frisch per
`cargo build` erzeugten Node ist Weg A also weiterhin der einzige Weg —
Weg B wird erst relevant, wenn du deinen Node zusätzlich als
Container-Image paketierst.

## Troubleshooting

**„connection refused" beim Registrieren** — die Registry
(`omp-nmos-registry`, Port 8010) läuft nicht: `make up` im Repo-Root.

**`descriptor.json` ist leer/fehlt Felder, die du erwartest** — dein
`descriptor()` und dein `get()`/`set()` sind nicht synchron: jeder
Parameter in `descriptor()` muss von `get()` einen Wert liefern, sonst
zeigt der Contract-Check `Param-Roundtrip` einen Fehler (genau dieser
Bug trat real bei `omp-source`, C5, auf — `set()` änderte die Pipeline,
`get()` kannte den Parameternamen aber nicht, s. `docs/decisions.md`).

**Kachel erscheint nicht im Flow-Editor** — Browser-Reload reicht
meist (SSE-Reconnect kann ein paar Sekunden dauern); prüfe zuerst per
`curl http://localhost:8000/api/v1/nodes`, ob der Orchestrator den Node
überhaupt sieht — wenn ja, ist es ein reines UI-Anzeigeproblem, wenn
nein, ein Registrierungsproblem (siehe oben).

**`cargo run -p mein-node` findet `omp-node-sdk` nicht** — Pfad in
`Cargo.toml` prüfen (`{ path = "../omp-node-sdk" }`, relativ zu
`nodes/mein-node/`), und dass `mein-node` in `nodes/Cargo.toml`s
`members` steht (bei `cargo new` innerhalb von `nodes/` automatisch).

## Weitere SDK-Fähigkeiten (optional, nicht in diesem Tutorial ausgebaut)

Über die vier `ParamStore`-Pflichtmethoden hinaus bringt das SDK drei
weitere, opt-in nutzbare Bausteine mit — nur relevant, sobald dein Node
sie tatsächlich braucht:

- **Eigene REST-Endpunkte** (`ParamStore::extra_route`, Default `None`)
  — Escape-Hatch für alles, was nicht als Parameter/Methode passt (z. B.
  `GET/POST /state` für Snapshot-Export/Import, s.
  `nodes/omp-video-mixer-me/src/main.rs`s `extra_route`-Implementierung,
  oder die `/ui/manifest.json`/`/ui/bundle.js`-Routen einer eigenen
  Node-UI, s. `nodes/*/src/uibundle.rs`).
- **Generischer Plugin-Host** (`ParamStore::plugins()`,
  `omp_node_sdk::plugins::PluginRegistry`, `UMSETZUNG.md` C19) — für
  runtime-(de)aktivierbare Zusatzfunktionen mit eigener Konfiguration
  (Referenz: `omp-playout-automation`s SCTE-35-Plugin), liefert
  automatisch `GET /plugins`/`PATCH /plugins/<id>` ohne eigenen
  Routing-Code.
- **Direkte Node-zu-Node-Aufrufe** (`omp_node_sdk::peer::PeerClient`,
  `RegistryClient::get_node`, `UMSETZUNG.md` Kapitel 15 Teil 3) — falls
  dein Node aktiv einen anderen Node aufrufen muss (nicht nur über den
  Orchestrator-Proxy erreichbar sein), z. B. um an dessen Lowres-Vorschau
  zu aktivieren (Referenz: `omp-multiviewer`s Discovery-Code).

## Weiterführend

- `ARCHITECTURE.md` §5 (Node-Contract, vollständig), §11.1
  (IS-12/14-Objektmodell für komplexere Nodes: Blocks/Workers statt
  flacher Parameterliste, sobald dein Node mehrere logische Einheiten
  hat wie z. B. ein Mixer mit mehreren Kanälen), §15.1/§15.2
  (Latenzdeklaration/Delay-Kompensation im Detail, Standards-Einordnung).
- `nodes/omp-node-sdk/src/node.rs` (`NodeConfig`, `SenderSpec`,
  `ReceiverSpec`, `MediaReadySource` — vollständige Doc-Kommentare im
  Quelltext).
- `tools/contract-check/` — Quelltext, falls du verstehen willst, was
  genau geprüft wird.
- `docs/HANDBUCH.md` — Dev-Stack starten/stoppen/troubleshooten.
