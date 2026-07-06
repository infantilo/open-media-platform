# OpenMediaPlatform (OMP) — Architekturplan v1

Referenzdokument. Bei jeder größeren Entscheidung hierher zurückkommen und fortschreiben.

> **Umsetzung:** Der Schritt-für-Schritt-Plan für die Implementierung (mit
> Claude Sonnet / Claude Code, Pro-Plan, jeder Schritt einzeln verifizierbar)
> steht in `UMSETZUNG.md`. Dieses Dokument bleibt die Architektur-Referenz.

## 1. Vision

Offene, modulare Broadcast-/Streaming-Plattform (TV, Radio, OTT) als europäische
Alternative zu Grass Valley AMPP / Matrox Origin. Kein Vendor-Lock, keine
Lizenzgebühren, 24/7-tauglich, läuft unverändert auf Bare-Metal, On-Prem-Cluster
und (Ziel) Cloud. Jede Funktion (Mediaplayer, Audiomixer, Videomixer, DVE,
OGraf-Grafik-Engine, Playout, …) ist ein eigenständiger, ersetzbarer Node —
nichts monolithisch, nichts hartkodiert.

## 2. Standard-Fundament

| Ebene | Standard | Zweck |
|---|---|---|
| Architektur-Prinzipien | **EBU DMF** (Dynamic Media Facility) | Referenzarchitektur: lose gekoppelte, orchestrierte Media-Functions statt Appliances |
| Lokaler Media-Transport | **MXL** (Media eXchange Layer, AMWA/Linux-Foundation-Umfeld, 2025) | Zero-Copy Shared-Memory-Austausch zwischen Nodes auf demselben Host — ersetzt proprietäre SDI-Matrix im Rechner |
| Netzwerk-Transport | **SMPTE ST 2110** (+ ST 2022-7 Redundanz) | unkomprimierter Audio/Video/Ancillary über IP zwischen Hosts |
| Discovery & Registry | **NMOS IS-04** | wer bin ich, welche Senders/Receivers existieren |
| Connection Management | **NMOS IS-05** | Streams verbinden/trennen ohne Neustart |
| Audio-Kanal-Mapping | **NMOS IS-08** | flexibles Audio-Routing |
| **Generisches Geräte-Control** | **NMOS IS-12/IS-14 (MS-05-02 Control Framework)** | selbstbeschreibende Parameter/Methoden pro Node — **das ist der Hebel gegen Hardcoding** |
| AuthN/AuthZ | **NMOS IS-10** (OAuth2/mTLS) | von Anfang an, nicht nachrüsten |
| Grafik | **OGraf** | portables Template-Format für die CG/Graphics-Node |
| Zeitsync | **PTP (IEEE 1588 / ST 2059)** | Genlock-Ersatz im IP-Umfeld |

**Warum das der Hebel gegen Hardcoding ist:** IS-12/14 beschreibt jeden Node
selbst (Parameter, Typen, Wertebereiche, Methoden) als Datenmodell, das der
Orchestrator zur Laufzeit einliest. Der Orchestrator kennt „Videomixer" nie als
Typ im Code — nur als Menge von Control-Classes. Neue Node-Art = neues
Descriptor-JSON, kein Orchestrator-Release.

## 3. Layer-Architektur

```
┌─────────────────────────────────────────────────────────┐
│ Web-UI-Shell (vanilla TS, Custom Elements, kein Framework)│
│  lädt UI-Fragmente der Nodes zur Laufzeit per import()    │
├─────────────────────────────────────────────────────────┤
│ Orchestrator-Core (Go, statisches Binary)                 │
│  serviert UI-Shell + REST/JSON-API direkt (kein BFF)       │
│  - NMOS Registry/Query (IS-04/05/08)                       │
│  - Control-Framework-Client (IS-12/14)                     │
│  - Node-Lifecycle (start/stop/health via systemd/k3s)      │
├─────────────────────────────────────────────────────────┤
│ Event-Bus (NATS, ein Binary) — Tally, Alarme, State-Change │
├─────────────────────────────────────────────────────────┤
│ Nodes (je eigener Prozess/Container, Rust+GStreamer)        │
│  Mediaplayer │ AudioMixer │ VideoMixer │ DVE │ OGraf │ ...  │
│  jeder Node: NMOS-Client + IS-12/14-Server + UI-Bundle      │
├─────────────────────────────────────────────────────────┤
│ Media Exchange: MXL (lokal) ↔ SMPTE 2110 (LAN) ↔           │
│                 Cloud-Gateway-Node (SRT/RIST, WAN/Cloud)    │
└─────────────────────────────────────────────────────────┘
```

## 4. Tech-Stack-Entscheidungen

### 4.1 Orchestrator/Backend: Go, **nicht** Node.js als Core

Explizite Antwort auf die Frage: Node.js für den Orchestrator-Kern ist die
falsche Wahl — GC-Pausen/Event-Loop-Jitter sind für 24/7-Broadcast-Kontrollpfad
riskant (Tally-/Switch-Latenz), und npm zieht Abhängigkeitsbäume, die dem
„so wenig Deps wie möglich"-Ziel widersprechen. Go: einzelnes statisches
Binary, keine Laufzeit-Deps, exzellente Concurrency für „hunderte Nodes
gleichzeitig überwachen", cross-compiled identisch für Bare-Metal/Cloud/ARM.

**Update: Node.js/npm wird gar nicht mehr gebraucht — auch nicht als
Nebenrolle.** Die ursprünglichen zwei Gründe fallen weg:
- API-Gateway/BFF als eigener Service ist unnötig — Go-Orchestrator serviert
  UI-Shell (statische ESM-Module/Custom Elements, §4.5) und JSON/REST-API
  direkt selbst (`net/http` reicht). Ein Extra-Prozess wäre nur zusätzliche
  Betriebs-Komplexität ohne Gegenwert.
- Die Annahme „Referenz-Tooling ist Node-basiert" war falsch: das offizielle
  **AMWA NMOS Testing Tool ist Python** (`AMWA-TV/nmos-testing`, Apache-2.0,
  aktiv gepflegt), nicht Node/`nmos-js`. `nmos-js` selbst brauchen wir ohnehin
  nicht, da die Registry-Wahl auf nmos-cpp fiel (§11). Python taucht damit nur
  als **fertiges Drittanbieter-CI-Tool** auf (Container, wird aufgerufen, nicht
  von uns geschrieben) — kein Widerspruch zum Sprachminimalismus.

Falls doch mal JS/TS-Tooling nötig wird (z.B. Type-Checking der UI-Shell,
lokaler Dev-Server): **Deno statt Node/npm** — ein statisches Binary wie
Go/NATS/step-ca, kein `node_modules`, TypeScript eingebaut, npm-Pakete bei
Bedarf importierbar ohne separaten Install-Schritt. Passt zum
„ein-Binary-pro-Werkzeug"-Muster der ganzen Plattform, npm-Ökosystem bleibt
optional statt Pflicht-Runtime.

Media-Verarbeitung (Mediaplayer, Mixer, DVE) NIE in GC-Sprache — **Rust** mit
GStreamer (siehe 4.1a), Know-how-Transfer aus PIPELINE CONTROLLER (Patterns,
nicht 1:1-Code). Control-Plane (Go) und Media-Plane (Rust) sind immer
getrennte Prozesse: stürzt der Orchestrator ab, laufen Nodes weiter (kein
Frame-Drop), Reconnect beim Neustart.

### 4.1a Media-Nodes: Rust (entschieden, ersetzt die C++-Option aus v1)

Referenzsprache für alle neuen Media-Nodes, inkl. Playout (P1). Bindings:
`gstreamer-rs` (Centricular/Sebastian Dröge) — Stand 2026 ausgereift, in
Produktion bei mehreren Firmen, `gst-plugins-rs` liefert bereits fertige
Elemente (RTP, WebRTC, fMP4, AWS, …), die DVE/Mixer/Converter-Nodes direkt
nutzen können — beschleunigt Community-Nodes (§7.3).

Warum Rust statt C++ trotz Rewrite-Aufwand:
- Memory-Safety ohne GC — passt exakt zum „nie GC im Media-Pfad"-Prinzip,
  aber ohne C++-Klassen von Bugs (use-after-free, buffer overflow). Relevant,
  weil ab P2 **fremder Community-Code** in die Plattform kommt — ein
  abstürzender Node soll nicht mehr riskieren als in C++ nötig.
- Cargo + starkes Typsystem senken die Einstiegshürde für Drittanbieter
  (bessere Fehler zur Compile-Zeit als Laufzeit-Crash im Sendebetrieb).
- Exzellentes Cross-Compiling (`cross`/Target-Triples) — passt zu
  Multi-Arch-Bedarf (§8).

Kosten/Konsequenz: PIPELINE-CONTROLLER-Code ist nicht 1:1 portierbar, der
Playout-Node (P1) wird eine **Neu-Implementierung nach bekanntem Muster**,
kein reiner Port — Zeitplan (§7.1/7.2) entsprechend mit Puffer versehen, nicht
knapper rechnen. Lohnt sich, weil Playout die Referenzimplementierung ist, an
der sich Community-Nodes orientieren — inkonsistent, wenn die Blaupause in
einer anderen Sprache als die SDK-Empfehlung wäre. Node-SDK (§5) wird als
Rust-Crate (`omp-node-sdk`) ausgeliefert: kapselt NMOS-Registrierung,
IS-12/14-Self-Describe, `omp-mediaio`-Adapter (§10.1).

Achtung Dependency-Bloat: Rust-Kultur neigt zu tiefen Crate-Bäumen (tokio,
diesel, …) — widerspricht „so wenig Deps wie möglich". Gegenmaßnahme:
`cargo deny`/`cargo audit` in CI von Anfang an, bewusst schlanke Crates
bevorzugen, kein Async-Overkill im Echtzeit-Pfad.

### 4.2 Event-Bus: NATS (+ JetStream)

Ein Go-Binary, kein ZooKeeper/Erlang-Runtime wie Kafka/RabbitMQ. Pub/Sub für
Tally, Node-Health, Alarme. Passt zur „ein Binary, keine Fremd-Runtime"-Linie.

### 4.3 Container/Deployment: Podman (rootless) + systemd Quadlets → k3s

- Dev (Crostini): Podman rootless — läuft nativ in Crostinis Linux-Container,
  keine Docker-Desktop-Lizenzfrage, keine Daemon-als-root-Problematik.
- On-Prem/Bare-Metal Produktion: **systemd Quadlets** statt docker-compose —
  Podman generiert systemd-Units, damit übernimmt systemd Restart-Policy,
  Ressourcen-Limits (cgroups), Boot-Order. Keine zusätzliche
  Orchestrierungs-Schicht/Dependency nötig für Single-Host-Setups (typisch
  für Sendezentren).
- Cloud/Multi-Host: **k3s** (ein Binary, kein Full-K8s-Overhead) — dieselben
  OCI-Images unverändert. Kein Vendor-spezifisches Cloud-SDK im Code.

### 4.4 Persistenz

- Metadaten/Config: PostgreSQL (identisch Bare-Metal → Cloud, keine Migration).
- Media-Assets/MAM (spätere Phase): S3-kompatibel via MinIO on-prem,
  swap-in gegen jeden Cloud-Object-Store ohne Code-Änderung.

### 4.5 UI-Föderation: native ESM statt Module Federation/Webpack

Jeder Node liefert `/ui/manifest.json` (Name, Version, Capabilities) +
`/ui/bundle.js` (ein Custom Element, Shadow DOM für Style-Isolation). Shell
liest Manifeste aus der NMOS-Registry (als Extension-Tag am Node-Resource),
lädt Bundles per nativem `import()`. Kein Framework-Zwang für Plugin-Autoren,
keine Build-Toolchain-Kopplung Shell↔Node, minimal-Dependency-Shell (vanilla
TS + Custom Elements).

### 4.5a Flow-Editor: grafisches Verschalten der Nodes (AMPP-artig)

Die zentrale Operator-Oberfläche der Shell ist ein **Node-Graph-Editor**
(vergleichbar mit AMPP-Flows / Node-RED): jeder Node erscheint als Kachel mit
Ein-/Ausgangs-Ports, Verbindungen werden per Drag & Drop gezogen. Der Editor
ist reine Projektion der Standards — er erfindet kein eigenes Datenmodell:

- **Kacheln** = IS-04-Resources aus der Registry (Nodes/Devices, Ports =
  Senders/Receivers). Erscheint ein neuer Node im Netz, erscheint er
  automatisch in der Seitenleiste — kein Konfigurieren.
- **Kanten** = IS-05-Connections. Drag & Drop von Output- auf Input-Port führt
  den IS-05-PATCH aus; Trennen ebenso. Der Graph zeigt also immer den echten
  Routing-Zustand, nie eine lokale Kopie.
- **Verschachtelung/Gruppen**: mehrere Kacheln lassen sich zu einem
  auf-/zuklappbaren **Makro-Block** gruppieren (z.B. „Regie 1" = Playout +
  Mixer + Grafik). Das mappt konzeptionell auf die `NcBlock`-Hierarchie aus
  MS-05-02 (§11.1): zunächst reine UI-Gruppierung (Layout-Persistenz),
  später echte Composite-Nodes.
- **Status-Overlay**: Tally/Health/Alarme aus dem NATS-Bus färben Kacheln und
  Kanten live (rot = on air, grau = offline …).
- **Parameter-Panel**: Klick auf eine Kachel öffnet ein aus dem
  IS-12/14-Descriptor **generisch generiertes** Einstellungs-Panel; liefert
  der Node ein eigenes UI-Bundle (§4.5), wird stattdessen dieses eingebettet.
- **Snapshots/Szenen**: kompletter Graph-Zustand (Verbindungen + Parameter)
  speicher- und abrufbar — Operator-Workflow „Sendung X laden".

**Leitprinzip Operator-Einfachheit:** Ein Operator editiert nie Config-Dateien
und muss keine IP-Adressen kennen. Alles, was verbunden werden kann, ist im
Graph sichtbar; alles, was eingestellt werden kann, kommt aus dem
Self-Describe der Nodes.

Technik: vanilla TS + Custom Elements + **SVG-Canvas, selbst implementiert**
(Pan/Zoom/Drag sind überschaubar; ein Framework wie React Flow würde die
No-Framework-Linie aus §4.5 brechen). Layout/Gruppen/Snapshots landen in
PostgreSQL (§4.4).

### 4.6 Sicherheit/Zertifikate

Smallstep CA (step-ca, ein Go-Binary) als interne CA für mTLS zwischen
Orchestrator und Nodes + NMOS IS-10 OAuth2 für Nutzer/externe Clients. Von
Tag 1, nicht nachrüsten (Retrofit in Broadcast-Netzen ist teuer).

## 5. Node-Contract (Plugin-Modell)

Jeder Node — intern oder Drittanbieter — MUSS:
1. Sich bei der NMOS-Registry registrieren (IS-04).
2. Seine Parameter/Methoden über IS-12/14 selbstbeschreiben (kein
   Orchestrator-Sonderwissen nötig).
3. `/ui/manifest.json` + `/ui/bundle.js` bereitstellen (optional, falls UI).
4. Media-I/O über MXL (lokal) oder ST 2110 (Netz) sprechen — nie proprietär.
5. Als eigenständiger Prozess/Container laufen, unabhängig neustartbar.

Damit ist „Drittanbieter erweitert die Plattform" = neues Image + Registrierung,
kein Plattform-Fork.

## 6. Media-Exchange-Strategie über Deployment-Stufen

- **Bare-Metal/Single-Host:** MXL Shared-Memory, Zero-Copy, keine NIC nötig.
- **On-Prem-Cluster (LAN, Multicast verfügbar):** ST 2110 + PTP-Grandmaster
  (physische Karte oder `ptp4l` Software-GM für Dev/kleine Setups). Läuft auf
  Standard-COTS-Ethernet — das ist der Kernvorteil von 2110 gegenüber
  RDMA/InfiniBand-gebundenen Pro-AV-Altansätzen. **Kein RDMA als Baseline.**
- **Host-zu-Host High-Bandwidth (optional, GPU/AI-Nodes):** RDMA via RoCEv2
  als zusätzlicher MXL-Transport (Rack-lokal, z.B. unkomprimiertes 4K/8K
  zwischen DVE/AI-Node und GPU-Compositor). Nur dort einsetzen, wo
  CPU-Overhead/Determinismus wirklich limitiert — braucht lossless-
  konfigurierte Switches (PFC/DCB/ECN), also bewusst Opt-in pro Node-Paar,
  nicht Netz-weiter Standard (siehe Risiko in Abschnitt 8).
- **WAN/Public Cloud (kein Multicast, kein PTP, RDMA nur auf bestimmten
  Cloud-SKUs verfügbar):** dedizierte **Cloud-Gateway-Node** bridged
  ST 2110 ⇄ SRT/RIST (Unicast, FEC, kein Multicast-Bedarf). 2110-Reinheit
  bleibt innerhalb der Facility gekapselt, niemand muss neue Protokolle
  erfinden.

## 7. Phasenplan

Ziel: **IBC 2029 (September, Amsterdam — passt zum "European" Branding) als
Demo-Milestone eines Fernsehregieplatzes**, Kern = Playout (bereits aus
PIPELINE CONTROLLER vorhanden). DVE/großer Audiomixer/Formatkonverter sollen
von Community/Dritten gebaut werden — das macht **Node-Contract/SDK-
Fertigstellung zum wichtigsten Gate**, nicht das Ende der Roadmap. Deshalb P5
(Ecosystem/SDK) nach vorne gezogen, direkt hinter P1.

| Phase | Inhalt | Träger |
|---|---|---|
| **P0 – Fundament** | Repo, Go-Orchestrator-Skeleton, NMOS-Registry (fork/embed statt Neubau), NATS, Podman-Quadlet-Dev-Setup, UI-Shell-Skeleton **+ Flow-Editor v1 (§4.5a)**, `omp-mediaio`-Adapter-SDK (§10.1) | Du |
| **P1 – Erster Node + SDK v1** | Playout-Node aus PIPELINE-CONTROLLER portiert (IS-12/14, MXL/2110-I/O, UI-Bundle) **+ Node-Contract/SDK inkl. Doku** — Community-Onboarding startet ab hier | Du |
| **P2 – Community-Nodes + Platform-Hardening** (parallel) | DVE, großer Audiomixer, Formatkonverter (UHD↔HD, 50↔60Hz, Colorspace) durch Dritte; du: Redundanz (2022-7), IS-10-Auth/mTLS, Konformitätstests in CI, Review/Integration der Community-Nodes | Community + Du |
| **P3 – Radio & MAM** | **Bewusst nach 2029 verschoben** — nicht nötig für TV-Regieplatz-Demo, Scope-Cut für Termintreue | Später |
| **P4 – Demo-Vorbereitung** | Minimal-Grafik-Node (kein volles OGraf/AI nötig), Cloud-Gateway als Architektur-Nachweis (muss nicht produktionsreif sein), Integration aller Nodes, Rehearsal | Du + Community |
| **P5 – IBC 2029 Demo** | Fernsehregieplatz: Playout + community-gebaute Nodes + UI-Shell live | Alle |

### 7.1 Zeitplan „Nebenbei" (5–10 h/Woche, ⌀ 30 h/Monat)

Grobschätzung inkl. ~30 % Puffer (Solo-Projekte laufen fast immer länger als
gedacht), Claude Code beschleunigt v.a. Boilerplate (NMOS-Client, Go-Services,
GStreamer-Wrapping) — ohne AI-Pairing wären diese Zahlen eher doppelt so hoch.

| Meilenstein | Aufwand | Fertig ab jetzt (Jul 2026) |
|---|---|---|
| P0 fertig | ~450 h | ~15 Monate → **Okt 2027** |
| P1 fertig (Playout + SDK v1, öffentlich) | ~390 h | +13 Monate → **Nov 2028** |
| P2 (dein Anteil: Hardening/Review) | ~250 h | +8 Monate, parallel zu Community | **~Sommer 2029** |
| P4/P5 Demo | Puffer/Rehearsal | | **IBC 2029 sehr knapp** |

**Realistischer Fallback bei diesem Tempo:** SDK erst Ende 2028 fertig lässt
der Community nur ~10 Monate für DVE/Mixer/Converter — knapp für
broadcast-taugliche Qualität. Zwei Auswege, keine Schande dran:
- Zieltermin auf **NAB 2030** verschieben (mehr Puffer für Community), oder
- Demo-Scope kürzen: Regieplatz zeigt Playout + Basis-Switcher + Basis-Audio
  (von dir/vereinfachte Referenz), DVE/Colorspace-Formatkonverter als
  „Community-Roadmap" statt live — die eigentliche Pointe der Demo ist
  ohnehin die Plattform-Modularität (Node live tauschen), nicht jedes
  einzelne Feature.

### 7.2 Zeitplan „Teilzeit" (15–20 h/Woche, ⌀ 75 h/Monat)

| Meilenstein | Aufwand | Fertig ab jetzt (Jul 2026) |
|---|---|---|
| P0 fertig | ~450 h | ~6 Monate → **Jan 2027** |
| P1 fertig (Playout + SDK v1, öffentlich) | ~390 h | +5 Monate → **Jun 2027** |
| P2 (dein Anteil) | ~250 h | +3–4 Monate | **Herbst 2027** |
| Community-Fenster für DVE/Mixer/Converter | — | **~24 Monate bis IBC 2029** | komfortabel |
| P4 Demo-Vorbereitung/Rehearsal | | Frühjahr–Sommer 2029 | |
| **P5 – IBC 2029 Demo** | | | **realistisch erreichbar** |

Mit diesem Puffer lohnt es sich, **1–2 weitere Referenz-Nodes selbst**
(z. B. einfacher Formatkonverter) zu bauen — zweites Vorbild neben Playout
senkt die Einstiegshürde für Drittanbieter erheblich und ist Versicherung,
falls Community-Beiträge ausbleiben.

### 7.3 Kritischer Erfolgsfaktor: Community-Geschwindigkeit, nicht deine Stunden

Sobald SDK v1 steht, ist **Community-Adoption der eigentliche Flaschenhals**,
nicht mehr dein Zeitbudget. SDK existiert ≠ Leute bauen Nodes. Maßnahmen:
- **NAB 2029 (April, ~5 Monate vor IBC)** als öffentlicher „Call for Nodes"-
  Meilenstein nutzen — Alpha zeigen, gezielt DVE/Audiomixer/Converter-Bedarf
  adressieren, bevor IBC der harte Deadline-Termin ist.
- SDK-Doku-Qualität priorisieren wie Produktionscode — das ist der
  eigentliche Geschwindigkeits-Multiplikator für Dritte, nicht Feature-Zahl.
- Frühzeitig 1–2 konkrete Studios/Entwickler(-communities) aus dem
  PIPELINE-CONTROLLER-Umfeld gezielt ansprechen statt auf organisches
  Open-Source-Wachstum zu hoffen — bei einem Nischenmarkt (Broadcast) ist
  gezieltes Community-Seeding effektiver als "build it and they will come".

## 8. Erwartete Unwegbarkeiten — vorab bedacht

- **Kein PTP-fähiger NIC auf Crostini/Dev-Rechnern:** Software-`ptp4l`/freilaufend
  für Dev, echte Hardware-PTP erst bei Bare-Metal-Rollout. Nodes müssen
  Free-Run-Modus tolerieren (kein Hard-Fail ohne PTP).
- **Kein Multicast in Public Cloud:** siehe 6 — Cloud-Gateway-Node kapselt das,
  kein Einbruch in den 2110-Purismus der Facility.
- **RDMA/RoCEv2 ist kein "einfach anschalten":** braucht lossless-Ethernet
  (PFC/DCB/ECN korrekt konfiguriert) — reale Netzwerk-Engineering-Aufgabe,
  fehleranfällig bei falscher QoS-Konfig (Head-of-Line-Blocking, Deadlocks).
  Deshalb nur als Opt-in-Performance-Tier für konkrete GPU/High-Bandwidth-
  Node-Paare vorsehen, nicht als generelle Netz-Anforderung — sonst
  widerspricht es dem "nicht überladen"-Ziel für Standard-Deployments.
- **GC-Jitter im Media-Pfad:** strikte Trennung Control-Plane (Go/Node) vs.
  Media-Plane (Rust), siehe 4.1a.
- **Docker-Desktop-Lizenz/Ökosystem-Divergenz Dev↔Prod:** von Anfang an Podman
  überall, keine Docker-Desktop-Abhängigkeit.
- **NMOS-Registry-Neubau wäre Zeitverschwendung:** existierende Open-Source-
  Registry (`nmos-cpp`, Entscheidung siehe §11.1) embedden statt neu
  erfinden — Standard-Treue heißt auch: nicht jedes Rad neu erfinden. Nur der
  Orchestrator/Node-Lifecycle darum herum ist Eigenentwicklung.
- **Crostini-Architektur (ARM vs. x86) unklar:** Multi-Arch-Images von Anfang
  an (Podman/Buildah `--platform`), kein Architektur-Lock-in in Skripten.
  Kurz prüfen: `uname -m` auf Zielgerät.
- **IS-12/14-Tooling ist jung/dünn dokumentiert:** Risiko einkalkulieren, ggf.
  Fallback auf einfacheres eigenes JSON-Schema-basiertes Self-Describe-Format
  mit klarer Migrationsschiene zu IS-12/14, sobald Tooling reift.
- **Lizenz-Mix:** GStreamer ist LGPL — unkritisch für dynamisches Linken.
  Gesamt-Stack auf Apache-2.0/MIT/BSD/LGPL halten, damit Drittanbieter auch
  proprietär erweitern können, ohne Copyleft-Fallen.

## 9. Marktkompatibilität (Stand Juli 2026, per Recherche)

Kurz: **ST 2110/NMOS/IPMX-Ebene funktioniert heute schon mit Kaufprodukten,
MXL-Ebene ist im Aufbau, IS-12/14 ist dünn verbreitet.**

- **ST 2110 + NMOS IS-04/05 + IPMX:** reif, breite Vendor-Basis. Matrox
  ConvertIP/DSX/Avio2 sind explizit standardbasiert interop-fähig. Unser
  Orchestrator kann solche Geräte heute schon per NMOS discovern/verbinden —
  kein Warten auf MXL nötig für die Basis-Interop.
- **MXL:** Spec v1.0 erst März 2026 veröffentlicht. Tiger-Team/Treiber:
  Grass Valley, Matrox, Lawo, Riedel, Intel, NVIDIA + Broadcaster (BBC, CBC,
  France TV, Bell Media, SVT, RTÉ, VRT). **Matrox ORIGIN Fabric wird bereits
  explizit als "MXL-kompatibel" beworben** — direkter Bezugspunkt zur
  Nutzeranfrage. Grass Valley AMPP integriert MXL bisher nur in
  R&D/kontrollierten Demos, nicht produktiv. Erwartung laut Branchenpresse:
  2026 erste MXL-fähige Produkte/Trials, kein breiter Serienstand. Fazit:
  unsere MXL-Nodes werden untereinander und mit früh adoptierenden Produkten
  (Matrox ORIGIN zuerst) austauschbar sein, aber noch nicht mit dem
  Gesamtmarkt — Fallback bleibt die 2110-Ebene.
- **IS-12/14 (Control Framework):** deutlich dünner adoptiert als IS-04/05.
  Für Fremdgeräte ohne IS-12/14 braucht es pragmatisch Adapter-Nodes
  (proprietäre Vendor-API → unser IS-12/14-Modell) — das Zero-Hardcoding-
  Ideal gilt garantiert nur für OMP-eigene Nodes, bei Drittprodukten optimistisch,
  nicht garantiert.
- **Governance-Risiko:** MXL ist laut NewscastStudio bisher **außerhalb des
  formalen SMPTE/AMWA-Standardisierungsprozesses** entstanden — Fragmentierungs-
  risiko, falls sich das nicht in einen offiziellen Standard-Track überführt.
  Beobachten, nicht blind darauf verlassen.

Sources:
- [DMF and MXL in practice — SVG Europe](https://www.svgeurope.org/blog/headlines/dmf-and-mxl-in-practice-which-vendors-are-adopting-it-and-how-fast-is-the-ecosystem-maturing/)
- [MXL skipped the standards process — NewscastStudio](https://www.newscaststudio.com/2026/06/04/mxl-skipped-the-standards-process-and-that-may-need-to-change/)
- [The Media Exchange Layer's role in software-defined production — NewscastStudio](https://www.newscaststudio.com/2026/06/04/industry-insights-the-media-exchange-layers-role-in-software-defined-production/)
- [Matrox Video details the benefits of the ConvertIP Series — TPi](https://www.tpimagazine.com/matrox-video-details-the-benefits-of-the-convertip-series/)
- [MXL Touts True IP Interoperability — TV News Check](https://tvnewscheck.com/tech/article/mxl-touts-true-ip-interoperability/)
- [AMWA MS-05-02 NMOS Control Framework](https://specs.amwa.tv/ms-05-02/)

## 10. Zukunftssicherheit / Markt-Drift-Risiken

Konkrete Maßnahmen gegen "an der Marktentwicklung vorbei bauen":

1. **MXL hinter eigener Adapter-Schicht kapseln.** Kein Node spricht MXL-API
   direkt — ein internes `omp-mediaio`-SDK abstrahiert MXL/2110/SRT. Wenn
   sich die junge MXL-Spec (v1.0 erst 03/2026) ändert, wird nur an einer
   Stelle nachgezogen, nicht in jedem Node.
2. **MXL-Tiger-Team = 6 Großvendoren** (Grass Valley, Matrox, Lawo, Riedel,
   Intel, NVIDIA) — Risiko, dass die Spec Richtung deren proprietärer
   Produkte drifted (z.B. Matrox ORIGIN Fabric). Gegenmaßnahme: **DMF-
   Prinzipien + NMOS bleiben der vendor-neutrale Anker** (EBU-getrieben,
   breiter abgestützt); MXL wird als austauschbare Transport-Implementierung
   behandelt, nicht als Kernabhängigkeit (siehe Punkt 1).
3. **IPMX** (AIMS Alliance, ST-2110-basiert, HDCP/Pro-AV-fähig) gewinnt Boden
   bei Matrox und Pro-AV-Crossover-Geräten. Format-Converter-Node ist der
   natürliche IPMX-Touchpoint am Facility-Rand — beim Bau dieses Node-Typs
   IPMX von Anfang an mitdenken, nicht nachrüsten.
4. **NVIDIA-Präsenz im Tiger-Team (Rivermax/Holoscan for Media)** macht
   GPU-Pfade zur Markterwartung für High-End-Nodes (DVE, Formatkonvertierung,
   AI). RDMA/GPUDirect bleibt optionaler Tier (siehe §6) — bewusst KEIN
   NVIDIA-SDK im Kern verdrahten, sonst entsteht der Vendor-Lock, den wir
   vermeiden wollen.
5. **IS-12/14-Adoption ist dünn** — Marktrichtung könnte sich zu einem
   einfacheren Control-Modell verschieben. Eigenes Descriptor-Format so
   bauen, dass es auf IS-12/14 mapped, aber nicht stur daran hängt.
6. **Compliance-Drift automatisch erkennen statt manuell verfolgen:** AMWA
   NMOS Testing Tool in CI einbinden; sobald verfügbar, MXL-Konformitätstests
   ergänzen.
7. **Feste Beobachtungsroutine:** `github.com/dmf-mxl/mxl`, AMWA-Spec-Repos,
   EBU-DMF-Arbeitsgruppe, Fachpresse (Broadcast Bridge, NewscastStudio, SVG
   Europe) — quartalsweise gegen dieses Dokument abgleichen (§9/§10
   nachziehen).
8. **SMPTE-Ratifizierung von MXL beobachten** — sobald MXL einen offiziellen
   ST-Nummer-Status bekommt, ändert sich das Governance-Risiko aus Punkt 2.

## 11. Offene Entscheidungen

Aktuell keine offenen Grundsatzentscheidungen mehr — Rest ist P1-Detailarbeit
(siehe 11.1 für die IS-12/14-Methodik, die diese Detailarbeit anleitet).

### 11.1 Entschieden: IS-12/14-Objektmodell-Methodik

Regel für jeden Node-Typ (Playout zuerst, Vorlage für DVE/Mixer/Converter):

1. **Ein Root-`NcBlock` pro Node** (MS-05-02-Struktur), darunter `NcWorker`-
   Members für jede logische Funktion.
2. **Standardklassen zuerst.** MS-05-02 bringt bereits einen Klassenbaum inkl.
   Monitoring-Feature-Set (Sender/Receiver-Health-Klassen) und AES70/OCA-
   abgeleiteten Audio-Grundklassen (Gain/Mute/Switch-artig). Diese wo
   anwendbar direkt verwenden — **niemals eigene Klasse für etwas, das der
   Standard schon kennt.** Exakte Klassennamen erst bei P1-Implementierung
   gegen die aktuelle MS-05-02-Spec verifizieren, nicht aus diesem Dokument
   übernehmen (Framework entwickelt sich weiter).
3. **Custom-Klassen nur für das domänen-Eigene**, per MS-05-01-Regel von einer
   Standardklasse abgeleitet + eigene Class-ID.
4. **Eigenen Authority-Key jetzt reservieren** (P0/P1-ToDo, nicht aufschieben)
   — Class-IDs sind Authority-Key-gebunden; nachträglich ändern bricht
   Kompatibilität für alles, was zwischenzeitlich dagegen gebaut wurde.
5. Diese Methodik wandert ins `omp-node-sdk`-Crate (§4.1a) als Doku/Vorlage —
   Community baut neue Node-Typen nach demselben Muster, nicht nach Gefühl.

**Konkrete Instanziierung Playout (P1-Referenz):**

```
NcBlock "Playout"
├─ NcWorker "PlaylistController"   [custom class]
│    properties: items[], currentIndex, playheadPosition, mode
│    methods:    load(), append(), remove(), cue(), take()
├─ NcWorker "ChannelStatus"        [custom class]
│    properties: onAir, tallyState, nextClipETA
└─ Standard-Monitoring-Klassen     [aus MS-05-02, nicht eigenes]
     an die zugrundeliegenden IS-04-Sender/Receiver gehängt
```

Nur `PlaylistController` und `ChannelStatus` sind eigene Klassen — der Rest
(Signal-Health) kommt vom Framework. Genau dieses Verhältnis (minimal-custom,
maximal-standard) ist der Maßstab für jeden weiteren Node-Typ.

### Entschieden: NMOS-Registry = nmos-cpp (Sony)

Containerisiert (`rhastie/nmos-cpp` o.ä. Image) als eigener Podman-Quadlet-
Service, getrennt vom Go-Orchestrator. Orchestrator + alle Nodes sprechen nur
die Standard-REST-API (IS-04/05), kein Wissen über nmos-cpp-Interna —
austauschbar, gleiche Adapter-Philosophie wie §10.1.

Gründe: vollständigste OSS-Referenz (Registration/Query/System/Connection-API,
zusätzlich IS-07/09) — BBC `nmos-js` ist im Vergleich nur Node-API-Client/
Control-UI, keine vollständige Registry. Apache-2.0. Referenzimplementierung
im JT-NM-Tested-Programm, mehrere zertifizierte Vendor-Produkte darauf —
höchste Sicherheit für echte Interop mit Kaufprodukten (§9). Bringt die AMWA
NMOS Testing Tool-Compose-Bundle mit, deckt §10.6 (CI-Compliance-Checks)
direkt ab. IS-12/14 (Control Framework) läuft unabhängig davon zwischen
Orchestrator und Node — Registry kennt nur Discovery/Connection, keine
Control-Modelle, also keine Kollision.

Source: [sony/nmos-cpp](https://github.com/sony/nmos-cpp)
