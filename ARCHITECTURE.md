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

**Zielbild „ganzes Sendezentrum" (2026-07-10):** Der Endzustand ist nicht ein
einzelner Regieplatz, sondern ein Sendezentrum mit mehreren, dynamisch
gestarteten Regieplätzen (Bild, Ton, Grafik, …) plus mehreren
Sendeabwicklungen — manche 24/7, andere nur temporär (Event, Saison,
Sondersendung). Die Bausteine dafür sind über dieses Dokument verteilt und
dort im Detail beschrieben: Regieplatz = Workflow-Objekt mit Zeitsteuerung,
Stop-Sicherheitsabfrage und Ressourcen-Vorprüfung (§6.2), dynamische
Host-/I/O-Karten-Zuweisung und proaktive Migration (§6.1), reaktives
Failover bei Service-Crash (§6.3), Microservice-Distribution über die UI
(§6.4), Rollen-Scoping pro Regieplatz (§12). Redundanz ist dabei
mehrschichtig und pro Workflow-Klasse verschieden: ST 2022-7 deckt nur
Netzwerk-Pfade ab (P2); dazu kommen Hot-Standby für kritische Rollen (§6.3)
und N+1-Reservekapazität auf Host-Ebene als Randbedingung der
Placement-Engine (§6.1) — 24/7-Sendeabwicklungen brauchen Standby +
unterbrechungsarme Wartungs-Migration, temporäre Regieplätze primär saubere
Provisionierung und Ressourcen-Freigabe. Die vollständige Ausarbeitung der
Redundanz-Klassen ist P2/P3-Scope; hier bewusst nur als Zielbild verankert,
damit keine frühere Entscheidung dagegen läuft.

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
6. **(ab SDK v1, P1 — siehe §6.1)** Seinen vollständigen Parameterzustand
   über den bestehenden Descriptor exportier- und reimportierbar machen und
   ein „media-ready"-Signal liefern, sobald er nach dem Start tatsächlich
   Medien produziert/konsumiert. Grundlage für ressourcenbewusste
   Make-before-break-Migration (§6.1) — Nachrüsten nach SDK-Freeze wäre
   ein Breaking Change für alle Community-Nodes, deshalb von Anfang an im
   Contract statt später ergänzt.

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

### 6.1 Resource-Aware Placement & Live-Migration (geplant, ab P2)

**Anforderung:** Der Orchestrator soll die Ressourcenlast (CPU/RAM/GPU/NIC)
jedes Hosts/jeder VM kontinuierlich kennen und, bevor eine überlastete
Maschine einen Audio-/Video-Ausfall verursacht (z. B. ein zu schwerer
DVE-Node), proaktiv eine neue Instanz auf einem anderen Host starten,
deren Betriebsbereitschaft prüfen, den Media-Pfad per IS-05 dorthin
umschalten (Make-before-break) und erst danach die alte Instanz beenden.

**Einordnung:** Passt philosophisch zu EBU DMF (lose gekoppelte,
orchestrierte Media-Functions) und dem bestehenden
Node-Lifecycle-Auftrag des Orchestrators (§3) — erweitert dessen Rolle
aber von „Lifecycle + Routing" zu „Scheduler". Das ist eine echte
Erweiterung, keine Detailarbeit, und braucht drei neue Bausteine:

1. **Telemetrie:** Host-Metriken (CPU/RAM/GPU/NIC-Auslastung) periodisch
   über den bestehenden NATS-Bus publizieren (kein neues Transportmittel
   nötig) — leichtgewichtiger Host-Agent statt Eigenentwicklung eines
   Protokolls; ab der Cloud-Stufe (k3s, §4.3) liefert `metrics-server`
   einen Teil davon bereits mit.
2. **Placement-Engine:** reines Custom-Design (Scoring/Schwellwerte/
   Trend-Erkennung) im Orchestrator — existiert in keinem der genutzten
   Standards. Erste Ausbaustufe bewusst **advisory** (Alarm +
   Vorschlag), nicht sofort automatisch migrierend.
3. **Make-before-break-Protokoll:** neue Instanz starten → Zustand
   übernehmen (Node-Contract §5 Punkt 6) → Betriebsbereitschaft
   verifizieren (Health + Descriptor + tatsächlich fließende Medien) →
   IS-05-Umschaltung der Downstream-Receiver → Drain → Teardown der alten
   Instanz. Für Node-Typen mit kontinuierlichem visuellem Zustand
   (Beispiel DVE mitten in einer Transition) ist „unterbrechungsfrei" in
   v1 als **kein Ausfall**, nicht als **unsichtbare Bildschnitt-Fortsetzung**
   zu verstehen — ehrlich im Scope halten statt zu versprechen, was nur
   mit PTP-referenziertem Frame-genauem State-Handoff ginge.

**Erweiterung (2026-07-10): I/O-Karten als erstklassige Host-Ressource.**
Anforderung: mehrere Barebone-Hosts mit z. B. Blackmagic-DeckLink- oder
SDI↔2110-Gateway-Karten (physische SDI-/2110-Ein-/Ausgänge) müssen den
Workflows (§6.2) dynamisch zugewiesen werden — dynamisches
Ressourcen-Handling als eine der wichtigsten Projektaufgaben. Das
Telemetrie-/Placement-Modell oben nannte bisher nur CPU/RAM/GPU/NIC —
kontinuierliche, teilbare Größen. I/O-Karten/Ports sind eine andere
Ressourcenklasse: **diskret und exklusiv** (ein Port ist belegt oder
frei, nicht „zu 70 % ausgelastet"). Drei Konsequenzen:

1. **Telemetrie-Schema:** Der Host-Agent (derselbe „ein Agent, zwei
   Verben"-Agent aus §6.2) meldet neben Auslastungsmetriken ein
   **Geräte-Inventar** — Kartentyp, Port-Anzahl/-Richtung,
   Belegungszustand je Port (frei / belegt durch Instanz X).
2. **Placement-Engine:** bekommt Claim/Release-Semantik für exklusive
   Ressourcen; die Platzierungs-Hinweise eines Workflows (§6.2) können
   Kartenanforderungen deklarieren („Rolle Ingest braucht 1× SDI-In").
   Harte Bedingungen (Port frei?) werden vor weichen (CPU-Trend)
   geprüft.
3. **Migrations-Grenze:** Ein Node, der eine physische Karte nutzt, ist
   nur auf einen Host mit äquivalenter freier Karte migrierbar — das
   Make-before-break-Protokoll oben gilt unverändert, aber die
   Kandidaten-Menge ist hardware-beschränkt; gibt es keinen Ersatz-Host
   mit Karte, ist der ehrliche Befund „nicht migrierbar" (Alarm), kein
   stiller Fallback.

Standards dafür: IS-04 beschreibt nur die **registrierte** Node-Sicht
(Devices/Senders/Receivers), nicht freie Host-Kapazität — das
Inventar-Format ist Eigenentwicklung wie das restliche
Telemetrie-Schema. Auf der k3s-Stufe (§4.3) entspricht das dem
Device-Plugin-/Extended-Resources-Muster, das als Vorbild dient, nicht
als Abhängigkeit (Bare-Metal/Quadlets brauchen dieselbe Semantik ohne
k3s).

**Standards-Abdeckung:** IS-04 (neue Instanz entdecken), IS-05 (die
eigentliche Umschaltung), Descriptor-Selbstbeschreibung (Zustand
exportieren, „kostenlos" wenn Parameter vollständig sind), ST 2022-7 als
verwandte, aber andere Antwort (Redundanz statt Migration). Nicht
abgedeckt: Telemetrie-Format, Placement-Logik, Migrations-Orchestrierung,
Umschalt-Timing — das ist Eigenentwicklung. k3s reschedult reaktiv
(kill/restart), das ist kein Ersatz für Make-before-break.

**Testbarkeit:** Auf der aktuellen Single-Host-Dev-Maschine (kein zweiter
Host, kein 2110-Netz, siehe §8) nur das Protokoll simulierbar (z. B. zwei
Podman-„virtuelle Hosts" mit fingierten Metriken), nicht der
Ausfallfreiheits-Anspruch selbst — das spricht dafür, Schnittstellen
(Node-Contract-Klausel, Telemetrie-Event-Schema, Migrations-Zustandsmaschine)
früh festzulegen, die eigentliche Umsetzung/Verifikation aber erst ab P2
(Platform-Hardening, parallel zu Community-Nodes) bzw. der Cloud/k3s-Stufe
anzugehen. Keine A–C-Schritte in `UMSETZUNG.md` ändern dadurch ihren Scope.

### 6.2 Workflow-Bereitstellung & -Verteilung (geplant, ab Phase D)

**Anforderung:** Vizrt AMPP OS erlaubt Operator:innen, nach Login
App-Kategorien (Core Apps, Inputs, Play & Record) zu wählen und per Klick
eine Anwendung als Workload dynamisch auf einer verfügbaren Ressource
(Edge-Server oder Cloud-Instanz) zu starten; ein „Workflow Designer"
verdrahtet Container über Vorlagen statt Handinstallation; ganze Workflows
(z. B. ein Regieplatz) lassen sich manuell oder zeitgesteuert
starten/stoppen, um Ressourcen freizugeben. OMP hat dafür heute keine
Entsprechung: Nodes werden rein passiv entdeckt, sobald sie bereits laufen
(Dev: `go run`/`podman run`, On-Prem: von Hand vorbereitete
systemd-Quadlets, Cloud: vorbereitete k3s-Pods, §4.3) — es gibt weder
einen Katalog noch ein „Klick startet Instanz auf Host X" noch ein
Bundle-weises Start/Stop. Das ist eine andere Frage als §6.1: dort geht es
um das Verschieben bereits laufender Instanzen unter Last, hier um das
Erst-Provisionieren und um das gezielte Freigeben von Ressourcen durch
Stoppen ganzer Bündel.

**Einordnung:** Neues erstklassiges Objekt **„Workflow"** — Name, benötigte
Node-Rollen, logisches Verbindungs-Template (Rolle→Rolle, wird beim
Erscheinen konkreter Node-IDs zu echten IS-05-Connections aufgelöst),
optionale Platzierungs-Hinweise, Lifecycle-Status (gestartet/gestoppt).
Bewusst getrennt von zwei bestehenden Konzepten: ein **Node** ist ein
einzelner laufender, selbstregistrierter Prozess; ein **Snapshot** (B7)
erfasst/reproduziert Parameter- und Kantenzustand bereits laufender Nodes,
startet aber nie einen Prozess. Ein Workflow bestimmt, welche Prozesse
überhaupt existieren und wo — Start eines Workflows kann Prozesse
provisionieren, ein Snapshot kann anschließend den initialen
Parameterzustand darüberlegen; beide Konzepte ergänzen sich, ohne sich zu
überschneiden.

Zwei-Stufen-Antwort statt erzwungener Parität über alle Deployment-Stufen:

1. **Cloud (k3s):** kein Neubau eines Schedulers — ein Workflow-„Katalog"
   bzw. dessen Platzierung entspricht einem Helm-Release-Äquivalent;
   Start/Stop ist Skalieren auf/von null bzw. Apply/Delete, hinter einer
   Orchestrator-API + einem Flow-Editor-Button verborgen. OMPs eigener
   Anteil ist nur der NMOS-Glue: ein Listener auf `node.added` (nutzt den
   bestehenden SSE-Mechanismus aus A6/B1), der das wartende
   Verbindungs-Template eines Workflows automatisch anwendet, sobald
   dessen erwartete Nodes registriert sind.
2. **Bare-Metal/Quadlets:** zuerst nur Start/Stop **vorab platzierter**
   Quadlet-Units je Bundle — kein Scheduling, deckt aber den
   AMPP-Kernwunsch „Regieplatz startet/stoppt als Ganzes, Ressourcen frei"
   bereits weitgehend ab. Echtes dynamisches „starte irgendwo, wo Platz
   ist" auf Bare-Metal braucht denselben Host-Telemetrie-Agenten, der
   ohnehin für §6.1 geplant ist — dieser Agent wird deshalb von Anfang an
   für **zwei Verben** ausgelegt („Metriken melden" für §6.1, „dieses
   Image starten" für Workflows) statt zwei getrennte Subsysteme zu bauen.

**Node-Contract-Berührung:** minimal und **nicht eilig** — anders als die
State-Export/Readiness-Klausel für §6.1 (§5 Punkt 6), die vor dem
SDK-v1-Freeze stehen musste, ist ein Katalog-Descriptor (z. B. ein
OCI-Label oder eine kleine `catalog.json` mit Node-Typ/Rolle/
Ressourcen-Hinweisen) rein optional: Nodes ohne dieses Label erscheinen
einfach nicht im Self-Service-Katalog und bleiben wie heute manuell
deploybar. Kann nach dem SDK-Freeze ergänzt werden, ohne bestehende
Community-Nodes zu brechen — deshalb **kein** neuer Punkt in §5 jetzt.

**Standards-Abdeckung:** IS-04 (Node-Erscheinen erkennen, löst
Verbindungs-Templates auf), IS-05 (die eigentliche Verkabelung). Nicht
abgedeckt: Katalog-Format, Placement-Logik, Workflow-Zustandsmaschine,
Start/Stop-Protokoll für Quadlets/k3s — das ist Eigenentwicklung analog zu
§6.1. Kein Ersatz für Helm/ArgoCD auf der Cloud-Stufe, sondern schmale
NMOS-Glue-Schicht darüber.

**Testbarkeit:** Auf der aktuellen Single-Host-Dev-Maschine nur das
Verbindungs-Template-Protokoll simulierbar (z. B. ein Mock-Workflow, der
beim Start eines zweiten Mock-Nodes automatisch eine Kante zieht), nicht
Mehr-Host-Placement selbst — wie bei §6.1 spricht das dafür, die
Schnittstellen (Workflow-Objekt, Verbindungs-Template, Katalog-Descriptor)
früh festzulegen, Umsetzung/Verifikation aber erst in Phase D (D7,
sequenziert nach D4 „2110/MXL" und zusammen mit D6, da beide Bausteine
denselben Telemetrie-/Start-Agenten teilen) anzugehen. Keine A–C-Schritte
in `UMSETZUNG.md` ändern dadurch ihren Scope.

**Stufe 0 (Dev/Single-Host): Instanz-Launcher — vorgezogen nach `UMSETZUNG.md`
C8 (docs/decisions.md, 2026-07-09).** Die MXL-Demo-Trias (`omp-source`/
`omp-viewer`/`omp-switcher`, Phase C) braucht schon vor Phase D eine
minimale, konkrete Ausbaustufe: Start/Stop einer gewählten Node-Instanz
**aus der GUI**, mehrfach-instanziierbar. Das ist bewusst nicht der volle
Workflow-Ansatz oben (kein Rollen-Template, keine Platzierung, kein
Bundle-Start), sondern nur die unterste Schicht, die D7 ohnehin gebraucht
hätte — vorgezogen, weil ohne sie die drei Test-Services nicht vorführbar
wären (heute lässt sich kein Node aus der GUI starten, nur `cargo
run`/Binary von Hand):

- **Katalog statt beliebiger Kommandos:** `deploy/catalog.json` listet
  bekannte Node-Typen (`{type, label, command[], env{}}`, `command` zeigt
  auf ein vorgebautes Binary) — der Orchestrator startet **nur**
  Katalog-Einträge, keine freien Kommandos (Sicherheitsgrenze). Ein neues
  Feld `runner` (Default `"process"`, später `"podman"`/Quadlet) hält die
  Tür zur volleren Lösung offen, ohne sie jetzt zu bauen.
- **Orchestrator-seitig:** neues Paket `internal/launcher` + API
  (`GET /api/v1/catalog`, `GET /api/v1/instances`,
  `POST /api/v1/instances {type}`, `DELETE /api/v1/instances/{id}`) —
  spawnt/killt lokale Subprozesse (Go `os/exec`), vergibt
  `OMP_INSTANCE_ID`/`OMP_LABEL`/`OMP_PORT=0`. Persistenz von
  `{id, type, pid}`, damit ein Orchestrator-Neustart noch laufende
  Kind-Prozesse wiedererkennt (PID-Check) statt sie zu verwaisen.
- **Korrelation Instanz↔Registry-Node:** neuer IS-04-Node-Tag
  `urn:x-omp:instance`, den das SDK aus `OMP_INSTANCE_ID` setzt — der
  Launcher muss dafür keine Ports kennen, die Zuordnung läuft rein über
  NMOS.
- **Flow-Editor:** Palette mit Katalog-Typen + Start-Button; ein
  Stop-Control an Kacheln, deren Node einen bekannten Instanz-Tag trägt.
  Instanzen erscheinen im Graph über den normalen
  Selbstregistrierungs-Pfad — der Launcher fasst den Graph nicht an.
- **Bewusst nicht jetzt:** Platzierung/Host-Wahl (nur ein Host),
  Container (würde GStreamer+MXL-Images brauchen — echter Aufwand ohne
  Demo-Nutzen jetzt), Workflow-Bundles, Verbindungs-Templates, Zeitpläne.
  D7 bleibt der volle Zielzustand; diese Stufe 0 ist dessen lokale
  „starte dieses Image"-Verb-Implementierung, vorweggenommen.

**Erweiterung (2026-07-10): Regieplatz = Workflow — Zeitsteuerung,
Stop-Sicherheitsabfrage, Ressourcen-Vorprüfung.**

Anforderung: Ein „Regieplatz" für eine Sendung soll **vor** der Sendung
entworfen/konfiguriert und dann manuell **oder zeitgesteuert**
gestartet/gestoppt werden; Stoppen soll eine Sicherheitsabfrage haben
können; Starten muss vorher prüfen, wo passende Ressourcen frei sind.
Der Kern davon ist ein Duplikat des Workflow-Objekts oben („Regieplatz"
ist der Operator-Begriff für einen Workflow: Name, Node-Rollen,
Verbindungs-Template, Platzierungs-Hinweise, Lifecycle-Status; Entwurf
vor der Sendung = Anlegen des Workflow-Objekts im gestoppten Zustand,
plus optional ein Snapshot (B7) als initialer Parameterzustand). Drei
Punkte fehlten bisher und erweitern §6.2:

1. **Zeitsteuerung (Scheduler):** Ein Workflow bekommt optionale
   Zeitpläne (`start_at`/`stop_at`, einmalig oder wiederkehrend), die
   der Orchestrator ausführt. Zeitbasis ist die synchronisierte
   Systemzeit (NTP) — PTP (§2) ist Media-Zeitbasis, nicht
   Kontroll-Zeitbasis, hier bewusst nicht vermengt. Verpasste
   Zeitpunkte (Orchestrator war zum Zeitpunkt down) brauchen eine
   definierte Nachhol-Regel pro Zeitplan (nachholen / verfallen lassen)
   statt impliziten Verhaltens — Detail in D7.
2. **Stop-Sicherheitsabfrage:** Pro Workflow konfigurierbar
   (`confirm_stop`); die API verlangt dann eine explizite Bestätigung
   (zweistufig: Stop ohne Bestätigungs-Flag → abgelehnt mit Hinweis,
   UI zeigt Bestätigungsdialog). Für 24/7-Sendeabwicklungen (§1
   Zielbild) ist „an" der sinnvolle Default. Wie sich ein
   **zeitgesteuerter** Stop zu `confirm_stop` verhält (Bestätigung
   erfolgt sinnvollerweise beim Anlegen des Zeitplans, nicht um 03:00
   nachts), wird bei D7 festgelegt, nicht hier geraten.
3. **Ressourcen-Vorprüfung als Start-Vorbedingung:** Der
   Workflow-Start fragt zuerst Telemetrie/Placement (§6.1, inkl.
   I/O-Karten-Inventar), ob **alle** Node-Rollen platzierbar sind, und
   erstellt einen vollständigen Platzierungsplan (Rolle→Host, inkl.
   exklusiver Karten-Claims), bevor irgendetwas provisioniert wird —
   kein Teil-Start, der mangels Ressourcen auf halbem Weg hängen
   bleibt. Damit wird die Placement-Engine aus §6.1 (dort advisory für
   Migration unter Last) hier zur **harten Vorbedingung** des
   Workflow-Starts; schlägt die Prüfung fehl, ist das Ergebnis eine
   verständliche Ablehnung („keine freie SDI-In-Karte"), kein
   halbgestarteter Regieplatz.

Standards-Abdeckung: unverändert IS-04/IS-05 wie oben;
Scheduler-Format, Bestätigungs-Protokoll und Platzierungsplan sind
Eigenentwicklung. Testbarkeit: alle drei Punkte auf der
Single-Host-Dev-Maschine simulierbar (fingierte Inventare wie bei
§6.1; Scheduler/Bestätigung sind reine Control-Plane-Logik). Umsetzung
in D7 (bestehende Sequenzierung nach D4, zusammen mit D6 — unverändert);
keine A–C-Schritte ändern ihren Scope.

### 6.3 Reaktives Failover: Service-Crash darf den Workflow nicht stoppen (geplant, ab P2)

**Anforderung:** Microservices **und** die Hosts, auf denen sie laufen,
werden überwacht; oberste Aufgabe: (a) bei knapp werdenden Ressourcen
proaktiv entscheiden, welcher Service ausfallsicher
(Make-before-break) auf einen anderen Host umzieht — das ist
vollständig §6.1; (b) stirbt ein Service **unerwartet**, darf das nie
zum Ausfall des gesamten Workflows führen — das ist von §6.1 **nicht**
abgedeckt (dort explizit proaktiv/advisory bei Überlast-Trend, kein
Crash-Pfad) und auch nicht von ST 2022-7 (P2 — Netzwerk-Pfad-Redundanz,
kein Prozess-Failover). Dieser reaktive Teil ist ein eigener Baustein.

**Einordnung — vier Stufen, aufeinander aufbauend:**

1. **Crash-Erkennung existiert im Kern schon:** Health-Staleness über
   den NATS-Bus (B4: offline nach 10 s ohne Health-Event) plus
   IS-04-Registry-Expiry. Zusätzlich nötig für Media-Nodes: das
   „media-ready"/„media flowing"-Signal aus dem Node-Contract (§5
   Punkt 6) auch im Laufenden auswerten — ein Prozess kann leben, aber
   keine Frames mehr liefern (real belegt: MXL-Read-Livelock, C8-Bug 2
   in `docs/decisions.md` — Prozess-Lebendigkeit allein ist kein
   Gesundheitsbeweis).
2. **Restart-in-place als erste Stufe:** systemd/Quadlet-Restart-Policy
   bzw. k3s-Rescheduling sind bereits Teil des Stacks (§4.3) — billig,
   aber Sekunden Ausfall der betroffenen Funktion. Der Orchestrator
   muss den Neustart nur beobachten (neue Node-ID erscheint per IS-04)
   und das Verbindungs-Template des Workflows (§6.2) automatisch
   wieder anwenden — derselbe `node.added`-Glue wie beim
   Workflow-Start.
3. **Degradation statt Kettenausfall:** Downstream-Nodes müssen den
   Ausfall eines Upstream tolerieren, nie mitsterben. Das Muster ist
   bereits gelebt: `omp-switcher` fällt bei verschwundener Quelle auf
   Schwarzbild zurück statt den Prozess zu beenden (C7,
   `docs/decisions.md`). Wird als SDK-Doku-Leitlinie für alle
   Community-Nodes festgeschrieben (D5) — bewusst **kein** neuer
   Pflichtpunkt in §5 (nicht maschinell prüfbar wie die bestehenden
   Punkte, und nachrüstbar ohne Breaking Change).
4. **Hot-Standby (N+1) für kritische Rollen:** Die Workflow-Definition
   (§6.2) kann pro Node-Rolle einen mitlaufenden Standby verlangen
   (Zustand per State-Import aus §5 Punkt 6 nachgeführt oder parallel
   gespeist). Übernahme = IS-05-Umschaltung der Downstream-Receiver
   wie in §6.1 — aber zwangsläufig **break-before-make** (die alte
   Instanz ist tot); Umschaltzeit = Erkennungszeit + IS-05-PATCH,
   nicht Prozess-Startzeit.

Die Grade sind bewusst unterschiedlich teuer und pro Workflow-Klasse
wählbar (24/7-Sendeabwicklung: Standby; temporärer Regieplatz:
Restart + Degradation reicht oft): ST 2022-7 = 0 Frames Verlust (nur
Netzpfad), Hot-Standby = kurzer Aussetzer, Restart-in-place = Sekunden.
Welche Rolle welchen Grad braucht, ist Workflow-Konfiguration (§6.2),
keine globale Plattform-Einstellung.

**Standards-Abdeckung:** IS-04 (Verschwinden/Wiedererscheinen
erkennen), IS-05 (Umschalten auf Standby), ST 2022-7 (komplementär,
nur Netzpfad). Nicht abgedeckt: Failover-Zustandsmaschine,
Standby-Semantik, Erkennungs-Schwellwerte — Eigenentwicklung, eng
verzahnt mit §6.1 (gleiche Telemetrie, gleiche
IS-05-Umschalt-Mechanik, anderer Auslöser und andere Reihenfolge).

**Testbarkeit:** Anders als §6.1 vollständig auf der
Single-Host-Dev-Maschine testbar: `kill -9` eines Nodes + automatische
Standby-Übernahme/Template-Neuanwendung braucht keinen zweiten Host.
Umsetzung ab P2, im D6-Umfeld (gleiche Bausteine); Detail-Schritte bei
der D6-Konkretisierung. Bewusste Nicht-Ziele v1: frame-genaue,
unsichtbare Übernahme (wie §6.1: „kein Ausfall des Workflows", nicht
„unsichtbarer Schnitt") und Hochverfügbarkeit des Orchestrators selbst
(Control-Plane-HA ist ein separates Thema; Nodes und Medien laufen bei
Orchestrator-Ausfall ohnehin weiter, §4.1).

### 6.4 Microservice-Distribution & -Lifecycle über die UI (geplant, ab P2)

**Anforderung:** Microservices (Node-Images — OMPs eigene wie die von
Drittanbietern) sollen über die UI installiert/importiert/entfernt/
versioniert werden können; und es braucht eine Antwort, **in welcher
Form** solche Microservices Nutzern überhaupt angeboten werden.

**Einordnung:** Neu. §6.2 kennt den Katalog bekannter Typen
(`deploy/catalog.json` in Stufe 0, später OCI-Label/Descriptor), aber
der Katalog selbst ist handgepflegt — es gibt keinen UI-Pfad, um neue
Node-Images hinzuzufügen, zu versionieren oder zu entfernen.

**Angebotsform: OCI-Images in einer OCI-Registry** — exakt der Stack,
der schon gesetzt ist (§4.3 Podman/k3s), keine neue Paketierungswelt:

- Ein Node-Microservice wird als Multi-Arch-OCI-Image (§8) mit
  Katalog-Descriptor (OCI-Label bzw. eingebettete `catalog.json`,
  §6.2) publiziert — von OMP selbst wie von Drittanbietern, in einer
  beliebigen erreichbaren OCI-Registry (on-prem z. B. als eigener
  Quadlet-Container, Cloud: jede gehostete Registry).
- **Installieren/Importieren** = Image-Referenz über die UI in den
  Plattform-Katalog aufnehmen; der Orchestrator liest den Descriptor
  aus dem Image und zeigt ihn vor der Aufnahme an.
- **Versionieren** = Image-Tags für Menschen, intern wird immer der
  **Digest** gepinnt (reproduzierbar, kein stiller Drift durch
  bewegliche Tags). Update = neuen Tag/Digest im Katalog wählen;
  laufende Workflows wechseln **nicht** automatisch, sondern per
  Make-before-break (§6.1) oder geplantem Workflow-Neustart (§6.2).
- **Entfernen** = Katalog-Eintrag löschen; laufende Instanzen des Typs
  werden vorher über den normalen Workflow-/Instanz-Lifecycle gestoppt,
  nie implizit gekillt.

**Sicherheit (Anschluss an §4.6 und §12):** Nur signierte/
vertrauenswürdige Images sind zulassbar — Signaturprüfung über die
Container-Stack-eigenen Mechanismen (Podman `policy.json` /
sigstore-artige Signaturen); der Vertrauensanker dafür ist bewusst
**getrennt** von der step-ca-mTLS-CA aus §4.6 (Image-Signatur und
Transport-TLS sind verschiedene Mechanismen, nicht vermengen).
Katalog-Verwaltung ist eine administrative Rolle (§12), kein
Operator-Recht. Aufnahme-Gate: der Contract-Konformitätstest
(`tools/contract-check`, C9) — ein importierter Node, der den
Node-Contract (§5) nicht erfüllt, erscheint nicht im
Operator-Katalog.

**Machbarkeit am bestehenden Stack:** hoch — das `runner`-Feld der
Stufe 0 (§6.2) ist genau dafür vorgesehen (`"process"` heute,
`"podman"`/Quadlet bzw. k3s dann); Podman und k3s ziehen Images per
Digest nativ. Einzige echte Vorarbeit: Container-Images für die
eigenen Nodes bauen (GStreamer+MXL-Basis-Image — in C8 bewusst
zurückgestellt, wird hier zur Voraussetzung).

**Standards-Abdeckung:** OCI Image/Distribution Spec (Format,
Verteilung, Digest-Versionierung). NMOS ist unberührt — ein
installierter Node registriert sich nach dem Start ganz normal per
IS-04 und beschreibt sich per Descriptor; genau deshalb braucht der
Orchestrator auch für fremde Images kein Typ-Sonderwissen (§2).
Katalog-UI, Signatur-Policy, Descriptor-Format: Eigenentwicklung.

**Testbarkeit:** Vollständig auf der Single-Host-Dev-Maschine
durchspielbar (lokale Registry als Container, `podman push/pull`),
sobald die Node-Images existieren. Umsetzung: P2, als Ausbau von D7
(gleiche Katalog-/Agent-Bausteine); keine A–C-Schritte ändern ihren
Scope.

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
| **P2 – Community-Nodes + Platform-Hardening** (parallel) | DVE, großer Audiomixer, Formatkonverter (UHD↔HD, 50↔60Hz, Colorspace) durch Dritte; du: Redundanz (2022-7), IS-10-Auth/mTLS, Konformitätstests in CI, Review/Integration der Community-Nodes, Resource-Aware Placement & Live-Migration (§6.1, inkl. I/O-Karten-Inventar), Workflow-Bereitstellung & -Verteilung (§6.2, inkl. Scheduler/Stop-Bestätigung/Ressourcen-Vorprüfung), Reaktives Failover (§6.3), Microservice-Distribution über die UI (§6.4), Nutzer-/Rollenmodell (§12, zusammen mit IS-10-Auth/D3) | Community + Du |
| **P3 – Radio & MAM** | **Bewusst nach 2029 verschoben** — nicht nötig für TV-Regieplatz-Demo, Scope-Cut für Termintreue | Später |
| **P4 – Demo-Vorbereitung** | **OGraf-Grafik-Node, vollwertig (§11.2)** — bewusste Aufwertung gegenüber dem früheren Scope „Minimal-Grafik-Node (kein volles OGraf/AI nötig)" per Nutzeranforderung 2026-07-10; größtenteils Know-how-Transfer aus PIPELINE CONTROLLER statt Neuland, siehe §11.2 — **Kompositing über MXL Zero-Copy**, das dank der vorgezogenen MXL-Fundament-Arbeit (`UMSETZUNG.md` C4, docs/decisions.md 2026-07-09 „MXL-Timing per Nutzer-Machtwort vorgezogen") schon aus der Source/Switcher/Viewer-Demo-Trias (Phase C, „Demo 2") vorhanden ist, statt hier erstmals gebaut zu werden, Cloud-Gateway als Architektur-Nachweis (muss nicht produktionsreif sein), Integration aller Nodes, Rehearsal | Du + Community |
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

Nur noch die Projektlizenz ist offen ([C1-Eintrag] in
`docs/decisions.md`) — Identity-Provider-Ansatz für §12 und Render-Technik
für den OGraf-Node (§11.2) sind am 2026-07-10 entschieden (siehe
`docs/decisions.md` für Begründung/verworfene Optionen). Rest ist
Detailarbeit der jeweiligen Phase (siehe 11.1 für die IS-12/14-Methodik,
die diese Detailarbeit anleitet).

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

### 11.2 OGraf-Grafik-Node (vollwertig; P4-Scope aufgewertet, 2026-07-10)

**Anforderung:** Ein eigenständiger OGraf-Grafik-Microservice — manuell
über die UI bedienbar, später zusätzlich vom OMP-Playout steuerbar —
unter Nutzung des gesamten vorhandenen Grafik-Know-hows aus
PIPELINE CONTROLLER (Steuerung und UI).

**Einordnung:** OGraf war bisher nur als Zielformat genannt (§2,
§3-Diagramm); der Phasenplan sah in P4 ausdrücklich einen
„Minimal-Grafik-Node (kein volles OGraf nötig)" vor — ein Konflikt mit
dieser Anforderung. Entschieden: der P4-Scope wird **explizit
aufgewertet** (P4-Zeile in §7 angepasst, keine stille Änderung) zum
vollwertigen OGraf-Node als weiterem Referenzknoten neben Playout
(§11.1-Methodik). Das Risiko „mehr P4-Arbeit" ist ehrlich benannt;
Gegengewicht: der größte Teil ist Know-how-Transfer statt Neuland, und
die ~45 fertigen OGraf-Templates aus PIPELINE CONTROLLER
(`templates/grafik/**/*.ograf.json`) sind direkt wiederverwendbar —
OGraf-Templates sind portables HTML/JS nach EBU-Spec, keine
Rust-Portierung nötig.

**Know-how-Transfer aus PIPELINE CONTROLLER** (Patterns, nicht
1:1-Code; verifiziert an `templates/grafik/**/*.ograf.json`,
`lib/GrafixEngine.js`, `server.js`, `streamdeck.js`):

- **Template-Modell:** `*.ograf.json`-Manifest nach EBU-OGraf-Spec
  (`ograf.ebu.io` v1): `main` = ES-Modul (Custom Element), `schema` =
  JSON Schema der Template-Daten (inkl. GDD-Typen wie
  `color-rrggbb`), `stepCount` für mehrstufige Grafiken,
  `renderRequirements` (Auflösung/Framerate). Für OMP zentral: das
  per-Template-JSON-Schema ist die grafik-eigene Entsprechung unseres
  Descriptor-Selbstbeschreibungs-Prinzips — die UI generiert
  Eingabemasken pro Template generisch daraus, exakt wie das
  Parameter-Panel aus dem IS-12/14-Descriptor (§4.5a), kein
  Template-Sonderwissen im Code.
- **Lifecycle-Steuerung:** die OGraf-Standard-Methoden am
  Template-Element — `load()` → `playAction()`, `updateAction({data})`,
  `stopAction()`; Weiterschalten mehrstufiger Templates per
  `playAction({goto: step+1})` („Continue").
- **Steuer-API-Muster:** show/hide/update/continue/status —
  PIPELINE CONTROLLER: `POST /api/grafik/{show|hide|update|continue}`
  + `GET /api/grafik/status` (Template-Liste + aktive Instanzen);
  mehrere Grafik-Instanzen gleichzeitig (eigene ID je Einblendung),
  Layer-Begriff (Overlay über Video vs. Vollbild-Ersatz);
  Take/Takeout/Continue zusätzlich als Stream-Deck-Belegung.
- **Render-Architektur:** Headless-Browser rendert eine Host-Seite,
  Frames → `appsrc` → Video-Pipeline. Konkrete, dort erarbeitete
  Erkenntnisse, die hier Neuland ersparen: **Pre-Cue** (OGraf-Module
  laden per dynamischem `import()` deutlich langsamer als statisches
  HTML — Template ~2,5 s vor der Einblendung unsichtbar vorladen,
  sonst erscheint es zu spät oder gar nicht); **adaptive Render-Rate**
  (volle fps nur bei aktiver Animation, ~1 fps bei statischer Grafik,
  ~0,2 fps ohne Grafik); **Latenz-Kompensation** als kalibrierbarer
  Wert (`grafikLatencyMs`).
- **Playout-Integration (spätere Stufe):** Child-Event-Muster — ein
  Playlist-Eintrag trägt Grafik-Kinder `{template, data, delay,
  duration}` relativ zum Clip-Start; dazu Variablen-Auflösung aus dem
  Playout-Kontext (z. B. Clip-Restlaufzeit) beim Show.

**OMP-Modellierung (nach §11.1-Methodik, Klassennamen bei Umsetzung
gegen MS-05-02 verifizieren):**

```
NcBlock "OGrafGraphics"
├─ NcWorker "TemplateLibrary"   [custom class]
│    properties: templates[] (aus *.ograf.json gescannt, readonly)
├─ NcWorker "GraphicsChannel"   [custom class, ggf. mehrfach]
│    properties: activeGraphics[] (id, template, layer, step)
│    methods:    show(template, data, layer), update(id, data),
│                continue(id), hide(id | all)
└─ Standard-Monitoring-Klassen  [MS-05-02] am MXL-Sender
```

Die `data`-Argumente von `show`/`update` sind per Template dynamisch
(JSON Schema aus dem Manifest); der Node validiert sie gegen das
Template-Schema — der generische Methoden-Dispatch mit Argumenten
existiert im SDK bereits (C4-prep). Das UI-Bundle des Nodes (§4.5)
liefert die Grafiker-Bedienoberfläche (Template-Wahl, generiertes
Formular aus dem Template-Schema, Take/Takeout/Continue) — **manuelle
Bedienung ab Tag 1**; die Playout-Steuerung kommt später über
**dieselben** IS-12/14-Methoden (Child-Event-Muster), keine zweite
API.

**Ausgabe:** MXL-Video-Flow mit Alpha (Key/Fill) — Kompositing per
MXL-Zero-Copy im Switcher/Playout, wie in der P4-Zeile (§7) bereits
vorgesehen. Wie Alpha über MXL transportiert wird (Pixelformat mit
Alpha-Kanal vs. getrennte Key+Fill-Flows) ist bei der Umsetzung gegen
die MXL-Spec zu verifizieren, nicht anzunehmen.

**Entschieden** (`docs/decisions.md` 2026-07-10): Render-Technik ist
GStreamer `wpesrc` (WPE WebKit) — nativ in der Pipeline, Alpha direkt,
schlanker als ein separater Headless-Chromium-Prozess. Vor dem
Festschreiben im Code: alle ~45 vorhandenen PIPELINE-CONTROLLER-Templates
gegen `wpesrc` durchtesten (P4-Beginn); Headless-Chromium bleibt
dokumentierter Fallback, falls einzelne Templates an der WebKit-Engine
scheitern.

**Phase/Testbarkeit:** P4 (kein neuer C/D-Schritt jetzt; A–C-Scope
unverändert). Auf der Dev-Maschine vollständig testbar
(Headless-Rendering + MXL-Loopback + `omp-viewer` aus C6 als
Sichtkontrolle). Bekannte Einschränkung: Chromium stürzt in der
Claude-Code-Sandbox ab (docs/decisions.md, B2) — betrifft nur die
automatisierte Verifikation dort, nicht das Zielsystem.

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

## 12. Nutzer- und Rollenmodell (AuthZ, geplant, ab P2 zusammen mit D3)

**Anforderung:** Lokale Benutzerkonten **und** Active-Directory-Anbindung;
ein Rollenmodell, das Bedienrechte auf Workflows/Regieplätze begrenzt:
ein Nutzer bzw. eine Gruppe darf nur einen bestimmten Workflow/Regieplatz
bedienen — der Bildmischer nur den Videomixer seines Regieplatzes, der
Tonmeister nur sein Mischpult, nicht alles für alle.

**Einordnung:** Neu. §2/§4.6 („IS-10 OAuth2/mTLS von Anfang an") decken
die **Authentifizierung** von Clients und Nodes sowie die Absicherung der
APIs ab — aber kein Nutzer-/Gruppen-/Rollenmodell, keine
Verzeichnisdienst-Anbindung und kein Ressourcen-Scoping. D3
(`UMSETZUNG.md`) baut die IS-10/mTLS-Transportschicht; dieses Kapitel
definiert die Autorisierungs-Semantik darüber. Vier Bausteine:

1. **Identität — lokale Konten und AD hinter einer Schnittstelle.**
   IS-10 basiert auf OAuth2; der natürliche Schnitt ist eine
   Token-Ausstellung (JWT mit Claims), die beide Identitätsquellen
   bedient: lokale Konten für kleine/Standalone-Setups,
   AD/LDAP(S)-Anbindung für Enterprise-Umgebungen. Ob dafür ein
   externer Identity Provider eingebettet wird oder der Orchestrator
   ein minimales eigenes User-Management plus direkten LDAP-Bind
   bekommt, ist eine offene Grundsatzentscheidung
   (`docs/decisions.md` 2026-07-10) — die AD-Anbindung selbst ist in
   beiden Fällen Konfiguration, kein Sonder-Code pro Verzeichnisdienst.
2. **Rollenmodell mit Workflow-Scope.** Rechte sind Tripel aus
   (Rolle/Gruppe, **Wirkungsbereich**, Verben) — der Wirkungsbereich
   ist ein Workflow (§6.2) oder eine einzelne Node-Rolle darin, keine
   globalen Flags. Beispiel: Gruppe „Bildmischer Regie 1" → Verb
   `operate` auf Node-Rolle „Videomixer" im Workflow „Regie 1".
   Verben grob: `view` (sehen/Monitoring), `operate`
   (Parameter/Methoden über den generischen Proxy bedienen),
   `configure` (Workflows anlegen/ändern/planen, §6.2), `admin`
   (Katalog §6.4, Nutzer-/Rechteverwaltung). AD-Gruppen mappen auf
   Rollen, damit die Zuordnung im Verzeichnis gepflegt werden kann.
3. **Durchsetzung zentral im Orchestrator.** Alle Node-Zugriffe der UI
   laufen ohnehin über den generischen Parameter-/Methoden-Proxy (A8)
   und die Graph-/Workflow-APIs — genau **eine** Durchsetzungsstelle;
   die Nodes selbst bleiben rollenfrei (kein Rollenwissen im
   Node-Contract §5, bewusst kein neuer Pflichtpunkt). mTLS/IS-10
   (§4.6/D3) verhindert, dass der Proxy umgangen und ein Node direkt
   angesprochen wird. Die UI-Shell filtert zusätzlich, was die Rolle
   nicht erlaubt (der Operator sieht seinen Regieplatz, nicht die
   ganze Facility) — Filterung ist Komfort, die Durchsetzung liegt
   immer beim Orchestrator, nie umgekehrt.
4. **Audit.** Jede schreibende Aktion wird mit Nutzer-Identität
   protokolliert (wer hat wann welchen Parameter/Workflow geändert).

**Know-how-Transfer PIPELINE CONTROLLER:** Dort existiert bereits ein
kleines, bewährtes Muster — `users.json`, Session-Tokens, rollen-
gegatete Endpunkte (`_requireAuth(req, res, ['grafiker','editor'])` pro
API-Route) und ein User-Action-Log (`_userLog`). Übernommen wird das
Pattern (Rollen-Gate an genau einer Stelle pro API-Zugriff + Audit-Log,
Auth deaktivierbar solange kein Nutzer angelegt ist), erweitert um die
dort fehlende Dimension **Wirkungsbereich**: PIPELINE CONTROLLER kannte
nur globale Rollen — bei einem Ein-Kanal-System ausreichend, für ein
Sendezentrum mit mehreren Regieplätzen (§1 Zielbild) nicht.

**Standards-Abdeckung:** NMOS IS-10 / AMWA BCP-003-02 (OAuth2-
Autorisierung für NMOS-APIs, Token-/Scope-Transport) trägt Tokens und
API-Schutz. Die Semantik „Rolle X darf Workflow Y bedienen" ist in
keinem NMOS-Standard definiert — das Claims-auf-Wirkungsbereich-Mapping
im Orchestrator ist Eigenentwicklung. AD-Anbindung über LDAP(S) bzw.
OIDC-Föderation ist Konfiguration der gewählten Identitätslösung.

**Testbarkeit:** Vollständig auf der Single-Host-Dev-Maschine testbar —
zwei Test-Nutzer/-Gruppen, ein Workflow: der „Bildmischer" kann
Mixer-Parameter PATCHen, bekommt aber 403 auf dem Audio-Node und auf
fremden Workflows; Audit-Log zeigt die Zugriffe. Umsetzung: P2,
zusammen mit D3 (D3 liefert Transport + Token, §12 die Semantik
darüber); keine A–C-Schritte ändern ihren Scope. Bewusste Nicht-Ziele
v1: kein feldgenaues Parameter-ACL (der Scope endet an Node-Rolle +
Verb), kein Multi-Tenant-Mandantenmodell.
