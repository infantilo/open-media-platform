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
- **`media_ready` ehrlich setzen** (§5 Punkt 6, `UMSETZUNG.md` D5-prep):
  `MediaReadySource::NotApplicable` ist ab jetzt falsch (du hast Medien-
  I/O). Baue eine echte Probe statt zu raten — `omp-source` macht das,
  indem es einen Buffer-Zähler an einer internen `fakesink`-Abzweigung
  auf ein Sticky-Flag umlegt (`pipeline.rs`, `video_flowed:
  Arc<AtomicBool>`), das per `MediaReadySource::Probe(Arc::new(move || …))`
  an die `NodeConfig` gereicht wird. Hast du noch keine Probe verdrahtet,
  ist `MediaReadySource::Unknown` (meldet konservativ `false`) ehrlicher
  als ein geratenes `true`.

Für Empfänger (dein Node **liest** einen MXL-Flow, z. B. wie
`omp-viewer`) ist `MxlVideoInput`/`MxlAudioInput` das Gegenstück — du
löst die `flow_id` der Quelle über die Registry-Query-API auf (Muster
in `omp-viewer`s `main.rs`, Stichwort IS-05-Receiver-PATCH).

## Schritt 5: In den Instanz-Launcher/GUI-Katalog aufnehmen (optional)

Damit dein Node aus der GUI heraus startbar ist (statt nur per
`cargo run`/Terminal, `UMSETZUNG.md` C8): Eintrag in
`deploy/catalog.json` ergänzen (`{type, label, command: ["nodes/target/debug/mein-node"], env: {}}`),
Binary vorher bauen (`cargo build -p mein-node`, der Launcher startet
kein `cargo run`). Danach erscheint dein Node-Typ in der
Katalog-Palette des Flow-Editors, mehrfach instanziierbar.

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

## Weiterführend

- `ARCHITECTURE.md` §5 (Node-Contract, vollständig), §11.1
  (IS-12/14-Objektmodell für komplexere Nodes: Blocks/Workers statt
  flacher Parameterliste, sobald dein Node mehrere logische Einheiten
  hat wie z. B. ein Mixer mit mehreren Kanälen).
- `nodes/omp-node-sdk/src/node.rs` (`NodeConfig`, `SenderSpec`,
  `ReceiverSpec`, `MediaReadySource` — vollständige Doc-Kommentare im
  Quelltext).
- `tools/contract-check/` — Quelltext, falls du verstehen willst, was
  genau geprüft wird.
- `docs/HANDBUCH.md` — Dev-Stack starten/stoppen/troubleshooten.
