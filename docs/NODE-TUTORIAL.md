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
   Node eine eigene UI mitbringt (§4.5; Kurzanleitung unten:
   [„Eigene Bedienoberfläche“](#eigene-bedienoberfläche-uibundlejs)).
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

## Mit einer KI (Claude o. ä.) einen eigenen Node bauen lassen

Der Node-Contract (oben) ist bewusst so klein und explizit gehalten,
dass eine KI ihn zuverlässig umsetzen kann, wenn sie die richtigen
Informationen bekommt — er ist dieselbe Grundlage, auf der auch dieses
Repo selbst entsteht (`CLAUDE.md`, `UMSETZUNG.md`). Zwei grundsätzlich
verschiedene Wege, je nachdem, wer den Node baut:

**Weg 1 — natives Rust-Crate in diesem Repo** (Schritt 1–5 oben): für
alle, die direkt an diesem Workspace mitarbeiten wollen/können. Die KI
schreibt ein `ParamStore` + `main()` gegen `omp-node-sdk`, wie im
gesamten Tutorial gezeigt.

**Weg 2 — eigenständiger Container in beliebiger Sprache** (Schritt 5,
„Weg B"/Administration-Tab, `docs/HANDBUCH.md` §9.5): für Dritte, die
*keinen* Zugriff auf dieses Repo haben (wollen) — z. B. wenn ihr
Microservice bereits in Python/Go/Node.js/… existiert oder eine eigene
Toolchain mitbringt. Der Node-Contract ist bewusst sprachunabhängig
(IS-04-Registrierung per einfachem HTTP-POST an die Registry, die
Descriptor-/Params-/Methods-Endpunkte sind reines JSON-über-HTTP) — es
braucht kein Rust und kein SDK, nur die sechs Punkte aus
`ARCHITECTURE.md` §5 von Hand implementiert. Referenzmuster für genau
diesen Weg: `PIPELINE CONTROLLER` wurde als fremdes, eigenständiges
Node.js-Projekt exakt so an OMP angebunden (eigene UI iframed, echtes
Medien-I/O, kein OMP-seitiger Rust-Code nötig). Der Import läuft über
`POST /api/v1/catalog` (Administration-Tab in der GUI) — verlangt
`runner: "podman"` + ein Image, durchläuft denselben Admission-Check
(`tools/contract-check`) wie jeder eingebaute Node, und bekommt
dieselben Umgebungsvariablen wie ein lokal gestarteter Node injiziert:
`OMP_INSTANCE_ID`, `OMP_LABEL`, `OMP_PORT`, `OMP_REGISTRY_URL`,
`OMP_NATS_URL` (s. `orchestrator/internal/launcher/podman.go`) — dieselben
Namen, die auch die Rust-`NodeConfig` oben erwartet, nur von Hand statt
über das SDK gelesen.

### Wie man den Auftrag an die KI beschreibt

Eine KI kann den Contract technisch korrekt umsetzen, aber sie kann
nicht erraten, *was* dein Node fachlich tun soll oder welche Parameter
sinnvoll sind — das musst du liefern. Vor dem Prompt kurz festlegen:

1. **Zweck in einem Satz.** Was tut der Node fachlich (z. B. „liest
   einen MXL-Videostream, legt ein Wasserzeichen-Bild darüber, schreibt
   das Ergebnis wieder als MXL-Flow")?
2. **Medien-I/O oder reiner Control-Plane-Node?** Liest/schreibt er
   Video/Audio (dann Schritt 4 relevant, `omp-mediaio`/MXL) oder hat er
   gar keine Medien-Pipeline (dann `MediaReadySource::NotApplicable`,
   wie `hello_node.rs`)?
3. **Parameter/Methoden**, so konkret wie möglich — Name, Typ, Einheit,
   Wertebereich, readonly oder nicht; bei Methoden: Name + Argumente.
   Ungefähr reicht nicht, die KI würde sonst raten (und `descriptor()`/
   `get()`/`set()` müssen exakt zueinander passen, s. Troubleshooting
   oben).
4. **Nächstliegender Referenz-Node.** Nenne den existierenden Node, der
   deinem am ähnlichsten ist (`nodes/omp-scaler` für „liest einen
   Stream, verändert ihn, schreibt einen aus", `nodes/omp-viewer` für
   „liest nur, keine eigene Ausgabe", `nodes/omp-player` für „hat einen
   internen Zustandsautomaten") — das verankert die KI an echtem,
   bereits funktionierendem Code statt an einer generischen Vorstellung
   von „Node-Contract".
5. **Eigene UI nötig?** Falls ja: welche Bedienelemente, sonst reicht
   das generische Parameter-Panel (Default, kein Zusatzaufwand).
6. **Weg 1 oder Weg 2** (oben) — und bei Weg 2 zusätzlich die Zielsprache/
   das Ziel-Framework.
7. **Bedienung am Stream Deck?** Soll der Node auch am Stream Deck
   (Hardware-Pult, `docs/BENUTZERHANDBUCH.md` §10g) bedienbar sein, sag der KI
   *welche Funktionen auf Tasten* gehören (z. B. „Take, Take Out, Continue,
   Vorlagenwahl“), *welche Zustände auf der Taste sichtbar sein müssen*
   (z. B. „läuft = rot“) und ob Drehregler (Dials) etwas einstellen sollen.
   Wie das technisch geht, steht im Abschnitt
   [„Stream-Deck-Belegung“](#stream-deck-belegung-für-einen-eigenen-node).

### Beispiel-Prompt (Weg 1, natives Rust-Crate)

```
Ich baue einen neuen Node für OpenMediaPlatform (Rust-SDK
`omp-node-sdk`, Workspace unter `nodes/`). Lies zuerst
`docs/NODE-TUTORIAL.md` und `ARCHITECTURE.md` §5 (Node-Contract) im
Repo — das ist die verbindliche Spec, nicht raten.

Zweck: [z. B. "ein Node, der einen MXL-Videostream liest, ein
halbtransparentes PNG-Logo oben rechts überlagert, und das Ergebnis als
eigenen MXL-Flow schreibt"].

Referenz-Node (nächstliegendes Muster, bitte dessen Aufbau
übernehmen): `nodes/[z. B. omp-scaler]` — insbesondere
`src/pipeline.rs` (Pipeline-Aufbau) und `src/main.rs`
(ParamStore/NodeConfig).

Parameter:
- [Name] ([Typ: string/number/bool], [Einheit falls zutreffend],
  [Wertebereich falls zutreffend], [readonly: ja/nein])
- …

Methoden:
- [Name]([Argument: Name+Typ, …])
- …

Baue ein neues Workspace-Crate `nodes/[mein-node]` nach Schritt 3 des
Tutorials (`cargo new --bin` innerhalb von `nodes/`, `Cargo.toml` mit
`omp-node-sdk = { path = "../omp-node-sdk" }`). Verifiziere danach
selbst mit `cargo run -p [mein-node]` + `NODE_URL=http://localhost:<port>
make contract` (aus dem Repo-Root) — ohne PASS beim Contract-Check gilt
der Node nicht als fertig.
```

### Beispiel-Prompt (Weg 2, eigenständiger Container, beliebige Sprache)

```
Ich baue einen eigenständigen Microservice, der sich als Node in
OpenMediaPlatform einbinden lassen soll — als Podman-Container-Import
über die Administration-GUI, NICHT als Teil des OMP-Rust-Repos. Ziel-
Stack: [z. B. Python/FastAPI].

Der Node-Contract (sechs Pflichtpunkte, sprachunabhängig, HTTP+JSON):
1. Beim Start per HTTP POST bei der AMWA-NMOS-IS-04-Registration-API
   registrieren (Node/Device/Sender/Receiver-Resources, Registry-URL aus
   der Umgebungsvariable OMP_REGISTRY_URL, Standard-Port 8010, API-Pfad
   .../x-nmos/registration/v1.3/resource).
2. GET /descriptor.json liefert Parameter/Methoden als JSON
   (Feldformat: [hier das reale Beispiel aus
   `docs/NODE-TUTORIAL.md` Schritt 2 einfügen]).
3. PATCH /params/<name> setzt einen Parameterwert, POST
   /methods/<name> ruft eine Methode auf.
4. Nur falls echtes Medien-I/O nötig: MXL (lokal, Zero-Copy) oder
   ST 2110 — kein proprietäres Format. [Falls dein Node KEIN
   Medien-I/O braucht, diesen Punkt weglassen — reiner
   Control-Plane-Node.]
5. Eigenständiger Prozess/Container, unabhängig neustartbar, liest
   OMP_INSTANCE_ID/OMP_LABEL/OMP_PORT/OMP_REGISTRY_URL/OMP_NATS_URL aus
   der Umgebung (vom Launcher injiziert).
6. Vollständigen Parameterzustand über den Descriptor-Mechanismus
   export-/importierbar machen (Punkt 2 deckt das ab).

Zweck: [wie oben].
Parameter/Methoden: [wie oben].

Als Referenz, wie ein fremdsprachiger Node real angebunden wurde (nicht
kopieren, nur Muster): `PIPELINE CONTROLLER`
(`/home/infantilo/PIPELINE CONTROLLER`, separates Repo) — Node.js,
eigene UI iframed, per Podman-Import angebunden.

Verifiziere zum Schluss: `curl http://localhost:<port>/descriptor.json`
liefert gültiges JSON, und ein Import über die GUI (Administration-Tab,
„+ Node/Microservice importieren") läuft ohne Admission-Check-Fehler
durch.
```

**Wichtig, unabhängig vom Weg:** der Contract-Check (`make contract`
bzw. der automatische Admission-Check beim GUI-Import) ist die
tatsächliche Abnahme, nicht die Selbsteinschätzung der KI — beide
Beispiel-Prompts enden deshalb bewusst mit der Aufforderung, das Ergebnis
selbst gegen den echten Check laufen zu lassen, statt "PASS" zu
behaupten.

## Eigene Bedienoberfläche (`ui/bundle.js`)

Ein Node ohne eigene Oberfläche bekommt automatisch das **generische
Parameter-Panel** aus dem Descriptor (jeder Parameter ein Regler/Schalter,
jede Methode ein Knopf). Reicht das nicht (Beispiele: Videomischer,
Grafik-Steuerung, Audiomischer), liefert der Node selbst eine Oberfläche aus:

- `GET /ui/manifest.json` → `{"name": "omp-meinnode-panel", "version": "0.1.0", "tag": "omp-meinnode-panel"}`
  (optional `"ownsPreview": true`, wenn die Oberfläche das Vorschaubild
  selbst groß zeigt).
- `GET /ui/bundle.js` → ein **ES-Modul**, das ein **Custom Element** mit genau
  diesem Tag-Namen definiert (`customElements.define("omp-meinnode-panel", …)`).

Die Shell lädt das Modul, legt das Element an und setzt das Attribut
`node-id` (die NMOS-Node-ID). Alle Aufrufe gehen über den Orchestrator-Proxy
`/api/v1/nodes/<node-id>/…` — **dieselben** Endpunkte wie bei jedem anderen
Aufrufer: `GET /params/<name>`, `PATCH /params/<name>` (Body `{"value": …}`),
`POST /methods/<name>` (Body = Argumente als JSON). Sprache und Farben
kommen aus der Shell (`document.documentElement.lang`, CSS-Variablen
`--omp-*` aus `ui/design-tokens.css`) — keine festen Hex-Farben verwenden.

Im Rust-SDK bindet man die zwei Dateien mit `include_str!` ein und liefert sie
aus `route()` aus (Muster: `nodes/omp-ograf/src/uibundle.rs`) — **nach jeder
Änderung am Bundle neu bauen**, sonst läuft die alte Fassung. Ein Container-Node
(Weg 2) liefert die beiden Pfade einfach als statische Dateien aus.

Minimalbeispiel:

```js
// ui/bundle.js
class MeinPanel extends HTMLElement {
  connectedCallback() {
    this.nodeId = this.getAttribute("node-id");
    const root = this.attachShadow({ mode: "open" });
    const btn = document.createElement("button");
    btn.textContent = "Start";
    btn.onclick = () =>
      fetch(`/api/v1/nodes/${this.nodeId}/methods/start`, { method: "POST" });
    root.append(btn);
  }
}
customElements.define("omp-meinnode-panel", MeinPanel);
```

Hinweise aus der Praxis: Zustand alle 1–2 s per `GET /params/…` nachladen
(und/oder Ereignisse aus `/api/v1/events` nutzen); nach jeder Änderung des
Bundles `node --check ui/bundle.js` laufen lassen (ein Backtick in einem
CSS-Kommentar innerhalb eines Template-Literals zerstört sonst das ganze
Bundle); Texte in Deutsch **und** Englisch (s. Abschnitt „Mehrsprachige
Node-Oberfläche“ unten).

## Stream-Deck-Belegung für einen eigenen Node

Die Operator-Konsole kann ein **Stream Deck** (XL, +, + XL, 15-Tasten-Modelle)
als Hardware-Pult betreiben (`docs/BENUTZERHANDBUCH.md` §10g,
`docs/ENTWURF-STREAMDECK.md`). Das Gerät hängt am **Browser** (WebHID), nicht am
Node: Eine Taste ruft dieselbe Proxy-API auf wie ein Mausklick. Ein Node
braucht deshalb **keinen Treiber und keinen USB-Code** — er entscheidet nur,
*was auf den Tasten steht und was sie auslösen*. Es gibt drei Stufen, vom
einfachsten zum aufwendigsten:

![Stream Deck XL mit dem OGraf-Adapter: Vorlagen als Tasten, Steuerzeile unten, eine Grafik on air](screenshots/streamdeck-xl-ograf-onair.png)

### Stufe 0 — nichts tun: das Auto-Raster

Hat ein Node keinen eigenen Adapter, erzeugt die Shell ein Raster **aus dem
Descriptor** (`GET /descriptor.json`):

| Descriptor | Wird am Deck |
|---|---|
| schreibbarer Parameter `boolean` | **Umschalter-Taste** (an = rot) |
| schreibbarer Parameter `enum` mit `values` | **Taste, die den nächsten Wert wählt** (Wert steht darunter) |
| Methode **ohne Argumente** | **Starttaste** (▶) |
| schreibbarer `number` mit `min`/`max` | **Dial** (nur „+“ / „+ XL“; Schrittweite ≈ 1 % des Bereichs) |
| `readonly`-Parameter, Methoden mit Argumenten | nicht belegt |

Wer einen Node mit einer KI bauen lässt und Stream-Deck-Bedienung will, aber
keine eigene Belegung braucht, **entwirft den Descriptor deshalb deckfreundlich**:
sprechende Parameternamen (`mute`, `take`, `fadeTime`), Wertebereiche bei
Zahlen, für jede Aktion, die auf eine Taste soll, eine **Methode ohne Argumente**
(z. B. `take`, `takeOut`, `continue`) statt einer Methode mit Pflichtargument, und
Zustände als `readonly`-Parameter (wegen der Anzeige auf der Bildschirm-UI).

### Stufe 1 — Eigenschaft `streamDeck` am Custom Element (auch für Container-Nodes)

Für eine **richtige Belegung** (Vorlagenraster, Statusfarben, Blättern) stellt das
Custom Element der eigenen Oberfläche (oben) die Eigenschaft `streamDeck`
bereit. Das geht in **jedem** Node mit eigenem `bundle.js`, auch bei Weg 2 —
ohne Zugriff auf dieses Repo. Die Shell fragt sie ab, sobald der Tab am Gerät
aktiv wird:

```js
class MeinPanel extends HTMLElement {
  // … connectedCallback wie oben …

  get streamDeck() {
    if (this._deck) return this._deck;
    const el = this;
    const call = (m, body) =>
      fetch(`/api/v1/nodes/${el.nodeId}/methods/${m}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });
    const deck = {
      onChange: () => {},        // die Shell setzt diese Funktion; bei Änderungen aufrufen
      onError: (e) => {},        // die Shell setzt sie; Fehler melden statt schlucken
      running: false,
      // ctx: { cols, rows (Zeilen UNTER der Kopfzeile), dials, page }
      getLayout(ctx) {
        const keys = Array.from({ length: ctx.rows }, () => Array(ctx.cols).fill(null));
        keys[0][0] = { label: "START", state: deck.running ? "onair" : "preset" };
        keys[0][1] = { label: "STOP", sub: deck.running ? "läuft" : "", dim: !deck.running };
        return { keys, dials: [{ label: "Pegel", value: "−6 dB", fill: 0.7 }], pages: 1 };
      },
      onKey(row, col, down) {
        if (!down) return;                        // nur Tastendruck, nicht Loslassen
        if (row === 0 && col === 0) call("start").catch(deck.onError);
        if (row === 0 && col === 1) call("stop").catch(deck.onError);
      },
      onDial(i, delta) { /* delta = zusammengefasste Raststellungen, + = rechts */ },
      onDialPress(i, down) {},
      async refresh() {           // alle ~1,5 s, nur solange der Tab aktiv ist
        const r = await fetch(`/api/v1/nodes/${el.nodeId}/params/running`);
        deck.running = (await r.json()).value === true;
        deck.onChange();
      },
    };
    return (this._deck = deck);
  }
}
```

Die Schnittstelle (`ui/shell/streamdeck/adapter.ts`):

- **`getLayout(ctx) → { keys, dials?, pages? }`** — `keys[zeile][spalte]` ist
  `null` (leer) oder eine Tastenbeschreibung; `ctx.rows` zählt nur die Zeilen
  **unter** der Kopfzeile (Home + Tabs gehören der Shell). Die Größe
  kommt vom Gerät: nie feste Indizes annehmen, immer aus `ctx.cols/rows`
  rechnen (XL: 8×3 Inhalt, „+ XL“: 9×3, „+“: 4×1 plus 4 Dials, 15 Tasten: 5×2).
  `pages > 1` → die Shell belegt die **letzte Taste** unten rechts mit „⇄ n/m“;
  der Adapter bekommt die aktuelle Seite in `ctx.page` und lässt diese Zelle frei.
- **Taste** (`KeyDef`): `label` (kurz — der Text bricht um und wird bei Bedarf
  kleiner), `sub` (kleine Zeile unten, z. B. Wert/„ON AIR“), `icon` (ein Zeichen
  oben, z. B. „▶“), `state` (`"onair"` rot, `"preset"` grün, `"cue"` orange,
  `"error"` Warnrot, `"off"` neutral — **Farben nie selbst wählen**, die kommen
  aus den Design-Tokens), `dim` (gedimmt/nicht bedienbar).
  Eine Taste, die nicht sinnvoll bedienbar ist, wird gedimmt, nicht entfernt.
- **Dial** (`DialDef`, Anzeige im Touch-Streifen): `label`, `value` (fertig
  formatierter Text), optional `fill` 0…1 (Balken), `dim`.
- **`onKey(zeile, spalte, down)`**, **`onDial(i, delta)`**,
  **`onDialPress(i, down)`** — Eingaben. Immer die **gleiche** Proxy-API wie die
  Bildschirm-UI aufrufen (nie am Node vorbei); Fehler an `onError` geben.
- **`refresh()`** — Zustand holen, danach `onChange()`. Die Shell ruft es etwa alle
  1,5 s für den **aktiven** Tab auf (nicht gestapelt, mit 8-s-Zeitlimit).
  Daten, die die Bildschirm-UI ohnehin lädt, nicht doppelt abfragen.
- Zusätzlich darf das Element das DOM-Ereignis `omp-streamdeck-relayout`
  (`bubbles: true`) auslösen, wenn sich sein Zustand ändert (Variante, wenn das
  Bundle seinen Zustand selbst hält).

Regeln: Texte kurz (Tasten sind 72–120 px groß), keine Hersteller-/Produktnamen
in Beschriftungen, keine Farben/Hex-Werte, Text zweisprachig wie die übrige UI,
Aktionen **idempotent** (zweimal „Take“ darf nichts kaputt machen). Rechte
gelten wie bei der Maus: wer am Bildschirm nur ansehen darf, bekommt am Deck
dieselbe 403-Meldung.

### Stufe 2 — Adapter in der Shell (nur für Nodes in diesem Repo)

Komplexe Belegungen (Mischer: Kanalstreifen, Detailseiten, Kurven) liegen als
**testbare Logik in der Shell**: `ui/shell/streamdeck/adapters/<node>-logic.ts`
(reine Funktion `layout(state, cols, rows, dials, page)` + Aktionstabelle,
Deno-Test ohne Browser), `<node>.ts` (Zustand holen, Aktionen ausführen) und ein
Eintrag in `adapters/index.ts` (Fabrik nach dem Elementnamen, z. B.
`"omp-ograf-panel"`). Vorbild ist der OGraf-Adapter (`ograf-logic.ts`,
`ograf.ts`, `ograf_test.ts`, ~250 Zeilen). Kurven (EQ/Dynamik) sind als
`KeyDef.plot`/`DialDef.plot` über mehrere Tasten bzw. den Touch-Streifen
möglich (`plot-logic.ts`, `plot-draw.ts`).

![Audio-Mixer-Detailseite EQ am + XL: Kurve über Tasten und Touch-Streifen](screenshots/streamdeck-plusxl-audio-eq.png)

### Ausprobieren ohne Gerät

Die Konsole hat unten rechts (Board) bzw. unten links (Einzelansicht) den Knopf
**Stream Deck**; darin **Simulator starten** und ein Modell wählen
(XL, „+“, „+ XL“). Der Simulator zeigt die gerenderten Tastenbilder und gibt
Klicks/Mausrad/Streifen als echte Geräteeingaben zurück — derselbe Weg wie am
Gerät. Die Seite `/streamdeck-sim` ist dieselbe Komponente ohne Konsole. Für
den Test eines **echten Geräts** (Drehung der Bilder, USB-Dauer) siehe
`docs/BENUTZERHANDBUCH.md` §10g.

### Prompt-Zusatz für die KI (Stream Deck)

```
Zusätzlich soll der Node am Stream Deck bedienbar sein. Lies dazu
`docs/NODE-TUTORIAL.md`, Abschnitt „Stream-Deck-Belegung für einen eigenen
Node“, und `ui/shell/streamdeck/adapter.ts`.

Tasten (Zeile für Zeile, wie sie auf einem 8×3-Raster stehen sollen):
- [z. B. Zeile 1: je Vorlage eine Taste (Name), gewählte Vorlage grün, laufende rot]
- [z. B. Zeile 3: TAKE, TAKE OUT, CONTINUE, ALLE AUS; gedimmt, wenn nicht möglich]
Zustände auf der Taste: [z. B. „on air = rot, Schritt n/m als Untertitel“].
Dials („+“/„+ XL“): [z. B. Dial 1 wählt die Vorlage, Druck auf Dial 2 = Take].
Welche Methode/welcher Parameter hinter jeder Taste liegt: [Liste].

Umsetzung: [Weg 1: Adapter nach Stufe 2 mit Deno-Test nach dem Muster der
OGraf-Dateien. / Weg 2: Eigenschaft `streamDeck` am Custom Element nach Stufe 1.]
Nur die Proxy-API des Orchestrators verwenden, keine Hersteller- oder
Produktnamen in Texten, Farben nur über `state`. Prüfe das Ergebnis im
Simulator (Konsole → Stream Deck → Simulator starten) für XL, „+“ und „+ XL“.
```


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


## Mehrsprachige Node-Oberfläche (de/en)

Ein `ui/bundle.js` läuft als ES-Modul in der Shell-Seite und liest die
Sprache aus `document.documentElement.lang` (setzt die Shell; "en" oder
sonst Deutsch). Muster: ein kleines `T(key, {param})` mit je einem
Wörterbuch für `de` und `en` am Dateianfang (Vorbild:
`nodes/omp-viewer/ui/bundle.js`), Fallback Deutsch. Texte, die der Node-
Backend-Code liefert (z. B. Urteile aus Messwerten), sind davon nicht
betroffen und bleiben, wie sie sind.

### Katalog- und Options-Texte übersetzen

`deploy/catalog.json` und `deploy/node-options.json` tragen die deutschen
Grundtexte. Optional ergänzt ein Feld `"i18n": { "en": { … } }` die
englischen Anzeigetexte (Katalog: `label`, `description`,
`expectedResources`; Optionen: `label`, `description`, `group`; leere Felder
lassen den Grundtext stehen). Die UI sendet bei jedem API-Aufruf
`Accept-Language`; der Orchestrator liefert bei `en` die übersetzten Texte
aus (`launcher.CatalogEntry.Localized`, `nodeoptions.Option.Localized`).
