# OpenMediaPlatform (OMP) — Architekturplan v1

Referenzdokument. Bei jeder größeren Entscheidung hierher zurückkommen und fortschreiben.

> **Umsetzung:** Der Schritt-für-Schritt-Plan für die Implementierung (mit
> Claude Sonnet / Claude Code, Pro-Plan, jeder Schritt einzeln verifizierbar)
> steht in `UMSETZUNG.md`. Dieses Dokument bleibt die Architektur-Referenz.

## 1. Vision

Offene, modulare Broadcast-/Streaming-Plattform (TV, Radio, OTT) als europäische
Alternative zu proprietären Cloud-Produktionsplattformen (z. B. Matrox Origin).
Kein Vendor-Lock, keine
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

### 4.5a Flow-Editor: grafisches Verschalten der Nodes

Die zentrale Operator-Oberfläche der Shell ist ein **Node-Graph-Editor**
(vergleichbar mit Node-RED): jeder Node erscheint als Kachel mit
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

**Anforderung:** Vergleichbare Cloud-Produktionsplattformen erlauben
Operator:innen, nach Login App-Kategorien (Core Apps, Inputs, Play &
Record) zu wählen und per Klick
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
   Kernwunsch „Regieplatz startet/stoppt als Ganzes, Ressourcen frei"
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
  Tür zur volleren Lösung offen, ohne sie jetzt zu bauen. Ein weiteres,
  rein additives Feld `category` (Input/Output/Audio/Video/Grafik/Daten/
  Control-Gruppierung für die Palette) ist in §13.5 spezifiziert —
  optional, kein Pflichtfeld dieser Stufe.
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
| **P1 – Erster Node + SDK v1** | Playout-Referenz-Node aus PIPELINE-CONTROLLER portiert (IS-12/14, MXL/2110-I/O, UI-Bundle, C1–C3 **erledigt**) **+ Node-Contract/SDK inkl. Doku** (D5 offen) — Community-Onboarding startet ab hier. **Resequenziert (§7.4, 2026-07-11):** direkt danach zuerst der kleine manuell bedienbare Regieplatz (§13 Bildmischer/Audiomischer/Player-Minimalausbau + §14 Operator-Console + OGraf §11.2 = „Demo 3"), **erst danach** die Playout-Automation-Vertiefung (ehemals C10/C11) | Du |
| **P2 – Community-Nodes + Platform-Hardening** (parallel) | DVE, großer Audiomixer, Formatkonverter (UHD↔HD, 50↔60Hz, Colorspace) durch Dritte; du: Redundanz (2022-7), IS-10-Auth/mTLS, Konformitätstests in CI, Review/Integration der Community-Nodes, Resource-Aware Placement & Live-Migration (§6.1, inkl. I/O-Karten-Inventar), Workflow-Bereitstellung & -Verteilung (§6.2, inkl. Scheduler/Stop-Bestätigung/Ressourcen-Vorprüfung), Reaktives Failover (§6.3), Microservice-Distribution über die UI (§6.4), Nutzer-/Rollenmodell (§12, zusammen mit IS-10-Auth/D3), Rollen-gescoptes Operator-Console-UI (§14), Latenz-Budget-Rechner/Delay-Ausgleich (§15), Monitoring-Vertiefung/konfigurierbare Erkennungsgeschwindigkeit (§17), Remote-Host-Erkennung/Host-Agent (§18, Grundlage von §6.1/§6.2 auf echten Mehr-Host-Setups) | Community + Du |
| **P3 – Radio & MAM** | **Bewusst nach 2029 verschoben** — nicht nötig für TV-Regieplatz-Demo, Scope-Cut für Termintreue. **Bei Bedarf auch hier eingeordnet, nicht vorher:** Orchestrator-Redundanz/Control-Plane-HA (§19) — erst relevant, wenn eine echte 24/7-Sendeabwicklung ansteht (§1-Zielbild), nicht für die Demo-Phasen | Später |
| **P4 – Demo-Vorbereitung** | **OGraf-Grafik-Node, vollwertig (§11.2)** — bewusste Aufwertung gegenüber dem früheren Scope „Minimal-Grafik-Node (kein volles OGraf/AI nötig)" per Nutzeranforderung 2026-07-10; größtenteils Know-how-Transfer aus PIPELINE CONTROLLER statt Neuland, siehe §11.2 — **Kompositing über MXL Zero-Copy**, das dank der vorgezogenen MXL-Fundament-Arbeit (`UMSETZUNG.md` C4, docs/decisions.md 2026-07-09 „MXL-Timing per Nutzer-Machtwort vorgezogen") schon aus der Source/Switcher/Viewer-Demo-Trias (Phase C, „Demo 2") vorhanden ist, statt hier erstmals gebaut zu werden, Cloud-Gateway als Architektur-Nachweis (muss nicht produktionsreif sein), Integration aller Nodes, Rehearsal, DVE/Keyer/Kompressor/Limiter/Expander-**Vertiefung** der in Phase C bereits vorgezogenen §13-Minimalknoten (Grundgerüst siehe P1-Zeile/§7.4), **Ressourcen-Kapazitätsplanung/Kalender (§16)** nach D7, **Remote-Host-Erkennung (§18)** sobald eine zweite Maschine real verfügbar ist | Du + Community |
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

### 7.4 Realitätscheck (2026-07-11) & Resequenzierung: kleiner Regieplatz vor Playout-Automation

**Anforderung:** Playout-Automation-Demo nach hinten stellen, zuerst eine
kleine Regieplatz-Demo (manuell bedient); Zeitplan an das bisherige Tempo
anpassen.

**Gemessenes Tempo (git-Log-Zeitstempel, nicht geschätzt):** Phase A
(Fundament) + Phase B (Flow-Editor) + Phase C bis C9 (MXL-Demo-Trias +
Contract-Check) — das, was §2 mit „11–20 Monate, ~30 Schritte" bei
5–10 h/Woche veranschlagt hatte — wurde tatsächlich in **vier
Arbeitssitzungen über vier Kalendertage** fertig:

| Datum | Zeitfenster | Fertiggestellt |
|---|---|---|
| 2026-07-07 | 09:36–15:57 (≈6,3 h) | A1–B5 |
| 2026-07-08 | 10:27 (kurz) | B7 |
| 2026-07-09 | 11:11–17:17 (≈6,1 h) | C1–C4 |
| 2026-07-10 | 08:51–16:06 (≈7,3 h) | C5–C9 |

Reale Sitzungszeit gesamt: **≈ 20 Stunden** für einen Umfang, den §2
konservativ auf **hunderte Stunden** geschätzt hatte. Das ist keine kleine
Korrektur, sondern ein Faktor von grob 20–40×.

**Warum die alte Schätzung so weit danebenlag — ehrlich einordnen, nicht
einfach linear hochrechnen:** §2/§7.1/§7.2 gingen von „5–10 h/Woche
nebenbei, Schritte einzeln über Wochen verteilt" aus (UMSETZUNG.md §1: „Ein
Schritt ≈ 1 Sitzung, 5-Stunden-Fenster"). Tatsächlich laufen mehrere
Schritte pro Sitzung am Stück, an aufeinanderfolgenden Tagen — die
Mensch-Zeit-Engpass-Annahme aus `UMSETZUNG.md` §1 galt in der Praxis nicht
in dieser Form. Zwei Kategorien Restarbeit sind davon aber unterschiedlich
betroffen:

- **Tempo-getriebene Arbeit** (weiteres Solo-Software-Bauen auf der
  Single-Host-Dev-Maschine — die neuen §13/§14-Regieplatz-Nodes, der
  Host-Agent-Grundbau aus §18, SDK-Doku D5): plausibel im selben
  Größenordnungs-Tempo fortsetzbar, **wenn** die Sitzungsdichte anhält —
  das ist keine Garantie, nur eine Beobachtung aus vier Tagen, kein
  Jahresdurchschnitt.
- **Extern-getriebene Arbeit** (Community-Nodes für DVE/großen Audiomixer/
  Formatkonverter, §7.3; echte Multi-Host-/2110-Netz-Verifikation, §8;
  echte Sendezentrum-Redundanz-Erprobung, §19): bleibt von der
  Sitzungsgeschwindigkeit **unbeeinflusst** — dort entscheiden andere
  Menschen bzw. echte Hardware, nicht Prompt-Durchsatz. §7.3s Kernaussage
  („Community-Geschwindigkeit ist der Flaschenhals, nicht deine Stunden")
  gilt dadurch **stärker** als vorher, nicht schwächer — der eigene Anteil
  schrumpft relativ zum externen.

**Konsequenz für die Zeitpläne in §7.1/§7.2:** Die dortigen Monats-/
Jahresangaben werden **nicht** mit einem neuen Faktor umgerechnet (das wäre
dieselbe Fehlerart wie vorher, nur in die andere Richtung) — sie bleiben
als Ober-/Sicherheits-Schätzung stehen, gelten aber erkennbar als
**Worst-Case**, kein Erwartungswert mehr. Statt eines neuen Datums:
Meilenstein-Reihenfolge statt Kalender-Vorhersage als belastbarere
Planungseinheit, siehe unten.

**Resequenzierung: kleiner Regieplatz vor Playout-Automation.**
`UMSETZUNG.md` sah bisher **C10/C11 „Playout v1"** (playlist-fähiger
Automatisations-Kanal) direkt nach Demo 2 als nächsten Schritt vor.
Begründung für die Umstellung: Playout-Automation ist architektonisch
**kein eigener Steuerpfad**, sondern nur ein weiterer Aufrufer derselben
IS-12/14-Methoden, die die manuell bedienten §13-Nodes ohnehin brauchen
(bereits so festgelegt: §13.1 „dieselben Methoden … keine zweite API",
§13.2/§13.3 identisch, §11.2 für OGraf ebenso). Playout-Automation vor den
eigentlichen Regieplatz-Nodes zu bauen hieße, den Aufrufer vor der Sache zu
bauen, die er aufruft. Reihenfolge daher umgestellt:

1. **Nächstes Ziel („Demo 3", ersetzt die alte C10/C11-Planung an dieser
   Stelle):** kleiner, **manuell bedienter** Regieplatz — `VideoMixerME`
   (§13.1, Minimal-Ausbaustufe: Crosspoint + 1–2 DVE-Kanäle + 1 Keyer,
   volle DVE/Keyer-Tiefe bleibt wie in §7 vorgesehen Community-Scope),
   `AudioMixer` (§13.2, Minimal-Ausbaustufe: N Kanäle, EQ+Gain, Aux,
   Audio-Follow-Video — Kompressor/Limiter/Expander können wie DVE/Keyer
   nachziehen), `omp-player` (§13.3, manueller Modus zuerst), Operator-
   Console (§14), dazu die bereits separat für P4 vorgesehene
   OGraf-Anbindung (§11.2). Alles über Live-Quellen (§13.4) und den
   bestehenden Flow-Editor/Instanz-Launcher (§6.2 Stufe 0) bedienbar.
2. **Danach:** Playout-Automation-Controller (die eigentliche C10/C11-
   Substanz, umbenannt/verschoben, siehe `UMSETZUNG.md`-Änderung) — jetzt
   spürbar kleiner im Umfang, weil er nur noch eine dünne
   Sequenzierungs-/Playlist-Schicht ist, die die in Schritt 1 bereits
   existierenden Node-Methoden aufruft, statt selbst eine neue
   Medienpipeline zu bauen. Der ursprüngliche C1–C3-RTP-Referenz-Node
   bleibt unverändert im Repo (bereits gebaut, keine Rückabwicklung
   nötig) — er zählt architektonisch als eine mögliche `omp-player`-
   Instanz, wird aber nicht rückwirkend umgebaut.
3. **P5-Demo unverändert im Ziel:** Regieplatz mit UND ohne Automatisation
   vorführbar — die Reihenfolge ändert, **was zuerst existiert**, nicht das
   Endbild aus §7/P5.

Die Phasenplan-Tabelle (§7) wird entsprechend angepasst: P4 führt „§13" nun
als das nächste konkrete Ziel statt als fernen P4-Punkt; die
Playout-Automation-Vertiefung wandert sichtbar hinter den kleinen
Regieplatz. `UMSETZUNG.md`s C10/C11-Abschnitt wird direkt umgeschrieben
(siehe dortige Änderung, docs/decisions.md 2026-07-11) — anders als reine
Konzept-Abschnitte ist das hier eine echte Reihenfolge-Entscheidung im
Umsetzungsplan, kein bloßer Kommentar dazu (gleiche Kategorie wie die
MXL-Timing-Vorziehung, docs/decisions.md 2026-07-09).

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
  Matrox, Lawo, Riedel, Intel, NVIDIA + Broadcaster (BBC, CBC,
  France TV, Bell Media, SVT, RTÉ, VRT). **Matrox ORIGIN Fabric wird bereits
  explizit als "MXL-kompatibel" beworben** — direkter Bezugspunkt zur
  Nutzeranfrage. Erwartung laut Branchenpresse:
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
2. **MXL-Tiger-Team = 5 Großvendoren** (Matrox, Lawo, Riedel,
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
die MXL-Spec zu verifizieren, nicht anzunehmen — **Vorabbefund
2026-07-11** (Fable-Konsultation, am gevendorten Spec-Stand verifiziert):
`third_party/mxl/lib/tests/data/v210a_flow.json` zeigt `media_type:
"video/v210a"` als offizielles Beispiel — MXL kennt ein Pixelformat mit
Alpha-Kanal, die Umsetzung muss das aber trotzdem gegen den dann
aktuellen Spec-Stand bestätigen, nicht diesen einen Fund als
abschließend behandeln.

**Klarstellung Insert-Punkt vs. Downstream-Key (2026-07-12, Fable-
Konsultation zu einer Nutzerfrage):** OGraf als eigenständiger Service
mit MXL-Fill+Key-Ausgang deckt das klassische Downstream-Key-Szenario
(CG → DSK) bereits vollständig ab — §13.1 listet den Keyer-Worker
bewusst als „Chroma/Luma/**DSK**", ein DSK ist signalflusstechnisch
nichts anderes als ein Keyer, der den Programmbus als Hintergrund nimmt
und OGrafs Ausgang als Quelle wählt. **Kein zusätzlicher, bidirektionaler
Insert-Modus** (Signal verlässt den Mixer-Prozess mitten in der
Pipeline, geht zu OGraf, kommt zurück) ist vorgesehen — das würde genau
die Synchronität untergraben, die §13.1 durch das Ein-Prozess-Modell für
Crosspoint/DVE/Keyer bewusst schützt (ein zusätzlicher MXL-Hop mitten im
Pipeline-Takt einer Transition). Eine Verkettung OGraf → separater
Downstream-Node (PGM-Out → Keyer-/Compositing-Node → Ausgang) bleibt
davon unberührt erlaubt — §13.1 verbietet nur das Aufsplitten
**innerhalb** einer M/E-Bank, nicht die Verkettung eigenständiger Nodes
mit eigenem, im Latenzbudget (§15) zu berücksichtigendem Zusatz-Hop.

**Scope-Unschärfe zu Demo 3 (offen, 2026-07-11):** §7.4 zählt OGraf
ausdrücklich zur Demo-3-Definition des kleinen Regieplatzes, die
`UMSETZUNG.md`-Schrittliste (C10–C13) enthält aber keinen OGraf-Schritt
und der dortige Demo-3-Meilensteintext nennt nur Bildmischer/
Audiomischer/Player/Live-Quellen. Nicht stillschweigend aufgelöst —
Optionen: (a) OGraf als eigenen Schritt in den C10–C13-Block aufnehmen
(z. B. nach C10, weil dessen Keyer sonst nur eine Testfarbfläche zum
Keyen hat statt eines echten Sende-Grafikelements), oder (b) die
§7.4-Erwähnung bewusst auf Demo 4 verschieben. Nutzerentscheidung
aussteht, siehe `docs/decisions.md` 2026-07-11.

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

## 13. Produktions-Microservices für den Regieplatz (geplant, ab P2/P4)

**Anforderung (2026-07-11):** Für einen vorführbaren Regieplatz fehlen noch
konkrete Node-Typen jenseits von Playout (§7) und OGraf (§11.2): Bildmischer
(skalierbar mehrere M/E-Ebenen, manuell oder per gemeinsamer Automatisation
gesteuert), Audiomischpult (EQ/Kompressor/Limiter/Expander/Aux/Gruppen,
dynamische Kanalzahl, Audio-Follow-Video zum Bildmischer), Musik-/
Jingle-Player, Videoplayer, Live-Quellen. Zusätzlich die Grundsatzfrage: ist
der Bildmischer bei uns ein einzelner Node oder eine Verkettung aus
Switcher/DVE/Keyer/Freeze als separate Nodes?

**Einordnung:** Neu, aber Methodik vollständig aus §11.1 (IS-12/14-
Objektmodell) und §11.2 (OGraf als zweiter Referenzknoten) übernommen — kein
neues Muster, nur dessen dritte/vierte/fünfte Anwendung.

### 13.1 Bildmischer: ein Prozess pro M/E-Bank, nicht Switcher+DVE+Keyer als separate Nodes

**Entschieden:** Ein Videomixer ist **ein** Node/Microservice pro
Mix-Effekt-Bank (M/E) — Switcher-Crosspoint, DVE-Kanäle, Keyer
(Chroma/Luma/Downstream) und die In-Mixer-Freeze-Funktion leben als
`NcWorker`-Members **innerhalb desselben** `NcBlock` (§11.1-Methodik), nicht
als eigenständige, über MXL verkettete Nodes.

Grund: Jeder MXL-Hop zwischen Prozessen ist ein zusätzlicher Latenz-/
Frame-Schritt und damit ein weiterer Posten im Latenz-Budget (§15) sowie ein
zusätzlicher potenzieller Ausfallpunkt (§6.3) für eine Funktion, die im
realen Sendebetrieb als **eine** atomare, frame-genaue Operation erlebt wird
(eine Transition betrifft Crosspoint, DVE-Position und Keyer gleichzeitig,
in einem gemeinsamen Pipeline-Takt). Separate Prozesse pro Funktion würden
genau die Synchronität erschweren, die §15 an anderer Stelle erst mühsam
wiederherstellen müsste — hier lohnt sich der Prozess-pro-Funktion-Vorteil
(unabhängige Nodes, §1 Vision) nicht, weil die Funktionen zwingend
gekoppelt sind, nicht lose.

```
NcBlock "VideoMixerME1"
├─ NcWorker "Crosspoint"        [custom class] — Program-/Preset-Bus, Take/Cut/AutoTrans
├─ NcWorker "DveChannel" ×N     [custom class] — Position/Größe/Border, N konfigurierbar
├─ NcWorker "Keyer" ×N          [custom class] — Chroma/Luma/DSK, on/off, Clip/Gain
├─ NcWorker "StillStore"        [custom class] — Freeze von Program/Preset/beliebigem Eingang
└─ Standard-Monitoring-Klassen  [MS-05-02] an den zugrundeliegenden MXL-Sendern/-Receivern
```

**Skalierbarkeit „mehrere Ebenen":** bedeutet mehrere unabhängige
`VideoMixerME`-Node-**Instanzen** (jede eigenständig platzierbar/migrierbar
nach §6.1), nicht mehr `NcWorker` in einem Prozess. M/E-Verkettung
(Program-Out von M/E1 speist einen Eingang von M/E2) ist ein ganz normaler
MXL/2110-Pfad zwischen zwei Nodes — genau das Muster, das §4.5a/B3 schon
kann, kein Sonderfall.

**Steuerung manuell vs. Automatisation:** dieselben IS-12/14-Methoden
(`take()`, `autoTrans()`, `select(input)`, …) werden entweder vom
UI-Bundle des Operators (§14) oder vom Playout-/Automatisations-Node
(§7, C10/C11) aufgerufen — keine zweite API, exakt das bereits für OGraf
etablierte Prinzip (§11.2: „Playout-Steuerung kommt später über dieselben
IS-12/14-Methoden, keine zweite API").

**Abgrenzung Freeze/Still:** Die `StillStore`-Funktion oben ist das
**In-Mixer-Einfrieren** eines laufenden Signals (Bus/Eingang) — das braucht
zwingend Zugriff auf die interne Pipeline des Mixers, deshalb dort
verortet. Ein **eigenständiger** Standbild-/Grafik-Player (z. B. ein Foto
als normale MXL-Quelle einspeisen) ist dagegen keine Mixer-Funktion,
sondern deckungsgleich mit dem Videoplayer/OGraf-Fall (§13.3/§11.2) — beide
Konzepte nicht verwechseln, auch wenn der Alltagsbegriff „Freeze" für
beide verwendet wird.

DVE/Keyer selbst als Referenz-Implementierung zu bauen bleibt
Community-Scope wie im Phasenplan vorgesehen (§7: „DVE, großer Audiomixer
… durch Dritte"); dieser Abschnitt legt nur die **Node-Grenze** fest, an
der sich Community-Beiträge orientieren, nicht die Umsetzung selbst.

### 13.2 Audiomischpult: dynamische Kanalzahl, Audio-Follow-Video über den bestehenden Tally-Bus

**Entschieden:** Analog zu 13.1 ein Node/Microservice pro Konsolen-Instanz,
aus demselben Grund (Aux-Sends brauchen gekoppelten Post-Fader-Zugriff auf
alle Kanalzüge gleichzeitig, EQ/Dynamik-Kette ist pro Kanal ein
zusammenhängender Sample-genauer Pfad — Verteilung auf mehrere
MXL-verkettete Prozesse würde Latenz/Phasenlage zwischen Kanälen
gefährden).

```
NcBlock "AudioMixer"
├─ NcWorker "ChannelStrip" ×N    [Standard-Audio-Klassen wo vorhanden, §11.1
│                                  Punkt 2 — Gain/Mute/EQ/Dynamics-Grundklassen
│                                  aus MS-05-02/AES70-Ableitung zuerst prüfen,
│                                  Compressor/Limiter/Expander/Gate custom nur
│                                  falls der Standard sie nicht abdeckt]
│    Methoden am NcBlock:  addChannel(), removeChannel(id) — macht die
│                          Kanalzahl zur Laufzeit-Eigenschaft statt
│                          Neustart-Parameter
├─ NcWorker "AuxBus" ×N          [custom class] — Send-Level pro ChannelStrip
├─ NcWorker "Group/VCA" ×N       [custom class] — Fader-Gruppierung
├─ NcWorker "AudioFollowVideo"   [custom class] — siehe unten
└─ Standard-Monitoring-Klassen   [MS-05-02] an den MXL-Sendern/-Receivern
```

**Dynamische Kanalzahl** ist damit eine Methoden-/Descriptor-Eigenschaft
(`addChannel`/`removeChannel` ändern den Descriptor zur Laufzeit — das
generische Parameter-Panel, B6, muss Descriptor-Änderungen ohnehin schon
per Re-Fetch vertragen), keine Neustart-/Konfigurationsfrage.

**Audio-Follow-Video ohne neuen Sync-Mechanismus:** `AudioFollowVideo`
abonniert den **bereits existierenden** Tally-/Health-NATS-Bus (§3, B4) des
gekoppelten `VideoMixerME`-Node (Workflow-Konfiguration verknüpft die
beiden Node-Rollen, §6.2) und löst bei einer Tally-/Crosspoint-Änderung
automatisch eine interne Aktion aus (Kanal stumm-/aufschalten, Aux-Routing
wechseln) — konfigurierbar pro Kanal: `followMode` (`cut` sofort wie das
Bild, oder `crossfadeMs` für einen weichen Übergang), plus ein manueller
Override-Schalter pro Kanal (Operator kann die Kopplung jederzeit
aufheben, ohne den Automatismus für andere Kanäle zu beeinflussen). Das
ist bewusst **kein** neues Transportmittel — derselbe Tally-Mechanismus,
der heute schon Kacheln im Flow-Editor rot färbt (B4), treibt hier eine
Node-interne Methode statt einer UI-Farbe. Steuerung (manuell oder durch
eine gemeinsame Automatisation) läuft wie bei 13.1 über dieselben
IS-12/14-Methoden.

### 13.3 Musik-/Jingle-Player und Videoplayer: eine Codebasis, keine drei

**Entschieden:** Statt drei separater Rust-Crates wird der ohnehin für
Playout geplante `PlaylistController`-Baustein (§11.1, C10/C11) zu einem
gemeinsamen Crate `omp-player` verallgemeinert. Musik-/Jingle-Player,
Videoplayer und der große Playout-Kanal unterscheiden sich nur in:

1. **UI-Bundle-Variante** (§4.5): Cart-Wall/Jingle-Grid für den
   Musik-Player, kompakte Cue/Take-Ansicht für den Videoplayer, volle
   Playlist-Ansicht für Playout — alle drei generieren sich aus demselben
   Descriptor, nur unterschiedliche UI-Bundles.
2. **Default-Konfigurationsprofil** (z. B. Jingle-Player: nur Audio-MXL-
   Sender, kein Video-Sender im Katalog-Descriptor, §6.2).
3. **Katalog-Rolle/-Tag** (§13.5) für die Zuordnung in Workflow-Templates.

Grund: `PlaylistController` (load/append/remove/cue/take, §11.1) ist für
alle drei Rollen dieselbe Funktion in unterschiedlicher Verkleidung — ein
eigenes Node-Typ-Rewrite pro Rolle wäre die Art von Duplikation, die die
Node-Contract-Methodik gerade vermeiden soll. Steuerung wie bei 13.1/13.2
manuell oder durch eine gemeinsame Automatisation über dieselben Methoden.

**Hinweis für die spätere C10/C11-Detaillierung** (`UMSETZUNG.md`, wird
dort nicht jetzt geändert): bei der Detaillierung von C10/C11 diese
Verallgemeinerung (`omp-player` statt eines reinen Playout-Crates)
berücksichtigen, damit Musik-/Jingle-Player und Videoplayer nicht
nachträglich als Kopie entstehen.

### 13.4 Live-Quellen: bereits abgedeckt, keine neue Node-Art

Live-Kamera-/Zuspiel-Signale kommen entweder (a) direkt per NMOS/ST 2110
von Fremdgeräten (§9 — heute schon interop-fähig, kein neuer Node nötig,
nur Discovery) oder (b) über einen Ingest-Node, der eine physische
Capture-/SDI-2110-Gateway-Karte per `omp-mediaio` kapselt und als
zuweisbare I/O-Karten-Ressource behandelt wird (§6.1-Erweiterung). Dieser
Abschnitt fügt bewusst nichts Neues hinzu — er bestätigt nur, dass „Live-
Quellen" architektonisch bereits abgedeckt ist, damit die Anforderungsliste
vollständig eingeordnet ist.

### 13.5 Katalog-Kategorien (Erweiterung von §6.2/§6.4)

**Anforderung:** Ein Microservice-Katalog in Kategorien (Input, Output,
Audio, Video, Daten), damit die Instanz-Launcher-Palette (§6.2 Stufe 0) und
der spätere UI-Katalog (§6.4) nicht als unsortierte Liste wachsen.

**Umsetzung:** rein additives Feld `category` im bestehenden
`deploy/catalog.json`-Eintrag bzw. im OCI-Label/`catalog.json` aus §6.4 —
Enum `input | output | audio | video | graphics | data | control`
(`graphics` für OGraf/§11.2, `control` für Playout/Automatisation, die
selbst keine Medien produziert/konsumiert, sondern andere Nodes steuert).
Keine neue Logik: die Palette (§6.2) gruppiert nur nach diesem Feld, der
Orchestrator wertet es sonst nicht aus. Fehlt `category`, erscheint der
Eintrag in einer „Sonstige"-Gruppe statt einen Fehler zu werfen (robust
gegen ältere Katalog-Einträge/Community-Nodes ohne das Feld).

**Standards-Abdeckung:** keine (reines UI-Ordnungsfeld). **Testbarkeit:**
trivial (Katalog-JSON mit `category` befüllen, Palette gruppiert sichtbar).
**Phase:** P2/P4, zusammen mit den jeweiligen Node-Typen aus 13.1–13.3.

## 14. Rollen-gescoptes Operator-Console-UI („virtuelles Pult") (geplant, ab P2 zusammen mit §12/D3)

**Anforderung (2026-07-11):** Ein Bildmeister/Tonmeister an seinem
Arbeitsplatz soll sein „virtuelles Mischpult" öffnen können, ohne den
Workflow (Regieplatz) editieren zu dürfen — nur die ihm zugewiesene Rolle
(z. B. Videomixer) bedienen. Braucht ein eigenes Frontend.

**Einordnung:** Neu, aber keine neue Komponente — eine zweite
**Präsentation** der bereits vorhandenen Bausteine (§12-Rollenbindung,
§4.5-UI-Bundle/generisches Parameter-Panel B6), nicht eine zweite
Bedien-API. §12 definiert bereits die Durchsetzung (Tripel Rolle/
Wirkungsbereich/Verb, zentral im Orchestrator); hier fehlte bisher nur,
**wie** ein reiner `operate`-Nutzer überhaupt an sein Pult kommt, ohne den
vollen Flow-Editor (§4.5a) zu sehen.

**Zwei UI-Oberflächen derselben Shell (§4.5), keine zweite Shell:**

1. **Engineering-Ansicht** — der bestehende Flow-Editor (§4.5a): voller
   Graph, sichtbar für Nutzer mit `configure`/`admin` irgendwo (§12 Punkt
   2), gefiltert auf die erlaubten Workflows (§12 Punkt 3, „Filterung ist
   Komfort, Durchsetzung bleibt beim Orchestrator").
2. **Console-Ansicht** — neu: für einen Nutzer, dessen Rollenbindungen nur
   `operate` auf einer oder mehreren Node-Rollen enthalten (der typische
   Bildmeister-/Tonmeister-Fall), landet die Shell direkt auf dem/den
   UI-Bundle(s) der zugewiesenen Node(s) — **kein Graph, keine anderen
   Nodes sichtbar**, exakt das „virtuelle Pult". Technisch identisch mit
   dem bereits existierenden Parameter-Panel/UI-Bundle-Rendering aus B6 —
   nur ohne den umschließenden Canvas, vollflächig.

**Neue, kleine API-Ergänzung:** `GET /api/v1/me/consoles` liefert für den
eingeloggten Nutzer die aufgelöste Liste
`[{workflowId, workflowLabel, nodeRoleId, nodeLabel, uiBundleUrl}]` aus
seinen §12-Rollenbindungen. Bei genau einem Eintrag springt die Shell nach
Login direkt dorthin; bei mehreren (z. B. jemand bedient Bildmischer **und**
Still-Store) eine schmale Tab-Leiste nur dieser Einträge — nie ein Graph.
Hat der Nutzer zusätzlich `configure`/`admin` irgendwo, entscheidet die
Shell für Engineering statt Console als Startansicht (wer konfigurieren
darf, braucht typischerweise auch den Überblick).

**Kiosk-taugliche Routen:** `/console/<workflowId>/<nodeRoleId>` ist direkt
verlinkbar/bookmarkbar — ein Arbeitsplatzrechner kann per Kiosk-Browser
beim Hochfahren direkt auf „sein" Pult starten, wie in echten Regien
üblich (ein Bildschirm = eine Bedienposition), statt jedes Mal über Login
+ Auswahl zu gehen. Die Zugriffsprüfung läuft trotzdem bei jedem
API-Aufruf über §12 — die feste Route ist Komfort, keine Sicherheitslücke
(ein falscher Nutzer an der Kiosk-Maschine bekäme beim Login-Prompt
trotzdem nur seine eigenen Rechte).

**Node-Contract-Berührung: keine.** Wie in §12 Punkt 3 festgehalten bleibt
der Node selbst rollenfrei; die Console-Ansicht ist reine
Orchestrator-/Shell-Komposition aus Rollenauflösung + bereits vorhandenem
Bundle-Laden. Kein neuer Pflichtpunkt in §5.

**Standards-Abdeckung:** keine zusätzliche (nutzt IS-10/§12 wie es steht).
**Testbarkeit:** vollständig auf der Single-Host-Dev-Maschine — ein
`operate`-only-Testnutzer auf einer Mock-Node-Rolle landet nach Login
direkt auf deren Panel, `GET /api/v1/graph` bzw. die Engineering-Route
liefert für ihn 403/leer. **Phase:** P2, zusammen mit D3/§12 (gleiche
Rollen-Infrastruktur, keine separate Vorarbeit nötig).

## 15. Deterministische Ende-zu-Ende-Latenz & A/V/Daten-Synchronität (geplant, ab P2/D-Phase)

**Anforderung (2026-07-11):** Audio-/Video-/Daten-Synchronität muss über den
gesamten Workflow garantiert sein, unabhängig davon, welche Nodes wie
verkettet sind: der Workflow bekommt eine maximale Latenz-/Buffer-Vorgabe
(z. B. 5 Frames), danach kommen Video/Audio/Daten mit exakt dieser Latenz
am Workflow-Ende an — unabhängig vom tatsächlichen Pfad.

**Einordnung:** Komplett neu und die bisher größte fehlende Fähigkeit im
Konzept. PTP (§2) liefert bisher nur eine **gemeinsame Zeitbasis** (Takt) —
das garantiert, dass alle Nodes wissen, „wann jetzt ist", aber **nicht**,
dass zwei Pfade unterschiedlicher Länge (unterschiedlich viele
Verarbeitungsschritte) gleich viel Zeit brauchen. Ohne Laufzeit-Ausgleich
liefe z. B. ein Audio-Follow-Video-Pfad (§13.2, nur ein Hop) systematisch
früher am Ausgang an als ein Bildpfad durch DVE+Keyer+Grafik-Kompositing
(mehrere Hops) — genau das Problem, das ein Workflow-Latenz-Budget löst.

### 15.1 Mechanik

1. **Per-Node-Latenzdeklaration** (Descriptor-Erweiterung, additiv wie der
   Katalog-Descriptor in §6.2 — **kein** Pflichtpunkt vor dem SDK-v1-Freeze,
   siehe Empfehlung unten): jeder Node deklariert seine inhärente
   Verarbeitungslatenz getrennt für Video/Audio/Daten als
   `minLatencyFrames`/`maxLatencyFrames` (ggf. audio in Samples oder
   audio-frame-äquivalenten Einheiten, Punkt 5) sowie, ob er zusätzliche
   Verzögerung einstellen kann: `supportsDelayCompensation: bool` +
   Methode `setOutputDelay(frames)`.
2. **Workflow-Latenz-Budget:** Das Workflow-Objekt (§6.2) bekommt ein Feld
   `targetLatencyFrames` (Operator-Vorgabe, siehe „5 Frames"-Beispiel oben).
   Beim Start berechnet der Orchestrator — als **Teil der bestehenden
   Ressourcen-Vorprüfung** (§6.2 Punkt 3, „vollständigen Platzierungsplan
   erstellen, bevor irgendetwas provisioniert wird") — für jeden Pfad im
   Verbindungs-Template die Summe der `minLatencyFrames` der beteiligten
   Nodes. Das Maximum über alle Pfade ist die **Mindestlatenz** des
   Workflows. Ist `targetLatencyFrames` kleiner, wird der Start abgelehnt
   („Zielband zu knapp für Pfad X→Y→Z, Minimum N Frames") — dieselbe
   ehrliche Ablehnung statt Teil-Start wie beim I/O-Karten-Fall in §6.1.
3. **Delay-Ausgleich:** Für jeden Pfad, der kürzer als
   `targetLatencyFrames` ist, weist der Orchestrator den delay-fähigen
   Nodes entlang dieses Pfades die fehlende Differenz per
   `setOutputDelay()` zu (bevorzugt möglichst spät im Pfad, um
   Zwischenzustände wie Tally/Preview nicht unnötig zu verzögern). Ergebnis:
   alle Pfade eines Workflows verlassen den Workflow nach exakt
   `targetLatencyFrames` — die aus der Anforderung geforderte Eigenschaft.
4. **Referenzzeit — eine durchgehende Referenz, präzisiert 2026-07-11 (Fable-
   Konsultation, gegen den gevendorten `third_party/mxl`-Spec-Stand
   v1.0.1 verifiziert, nicht geraten):** Der MXL-Grain-Index ist **kein**
   lokaler Ersatztakt, sondern absolute TAI-Zeit seit der ST-2059-1-Epoche
   (`third_party/mxl/docs/Timing.md`: „Index 0 is defined to be index at
   the beginning of the epoch"). ST-2110-Pfade (PTP-referenziert, §2) und
   MXL-Zero-Copy-Pfade (Single-Host) teilen sich damit **dieselbe**
   Zeitreferenz in verschiedenen Einheiten (RTP-Timestamp-Unroll ↔ TAI-ns ↔
   Grain-Index sind verlustfrei ineinander umrechenbar, `mxl::time`), keine
   zwei sauber zu trennenden Fälle mehr. Damit konkretisiert sich der
   Delay-Ausgleich zu: **Ausgangs-Grain(N) = Eingangs-Grain(N) + D**, wobei D
   die zugewiesene `setOutputDelay()`-Latenz in Grains ist — Ursprungsbezug
   und Latenzbudget sind dieselbe Mechanik, kein Gegensatz. Voraussetzung
   dafür ist, dass Nodes den Origin-Index tatsächlich durchreichen statt ihn
   zu verwerfen — das ist aktuell **nicht** der Fall (siehe
   `docs/decisions.md`, 2026-07-11 „MXL-Grain-Index ist TAI-Zeit, nicht
   Ersatztakt"): die C4-Vereinfachung (`do-timestamp=true` beim Lesen,
   `get_current_index()`+1-Zähler beim Schreiben) verwirft die
   Ursprungskorrelation an jedem Node-Hop. Für die A–C-Phasen unverändert
   tragbar (dort geht es um Funktionsnachweis, keine Frame-Attribution);
   muss vor echter §15-Umsetzung (P2/D) behoben sein.
5. **Audio-/Daten-Pfade separat, nicht als Kopie des Video-Budgets:** Ein
   Video-Frame-Budget ist kein automatisches Audio-Sample- oder
   Ancillary-Daten-Budget — derselbe Mechanismus (Deklaration + Ausgleich)
   läuft parallel, aber mit eigener Einheit, für Audio- und Daten-Pfade.
   **Audio-Follow-Video (§13.2) ist ein verwandtes, aber anderes Problem:**
   reine Latenzangleichung sorgt nur dafür, dass gleich alte Signale
   gleichzeitig ankommen — Audio-Follow-Video braucht zusätzlich die
   explizite Kopplung „Video-Tally-Ereignis löst Audio-Aktion aus" (§13.2).
   Beide Mechanismen ergänzen sich (ein per Audio-Follow-Video geschalteter
   Kanal profitiert trotzdem vom Latenz-Ausgleich, damit sein Signal nicht
   vor- oder nacheilt), lösen aber nicht dasselbe Problem — nicht
   verwechseln.

   **Metadatenebene, präzisiert 2026-07-11:** frame-genaue Begleitdaten
   (Timecode, Captions, künftig Grafik-Steuerdaten) laufen als eigener
   MXL-Datenflow (`format: urn:x-nmos:format:data`, Beispiel
   `video/smpte291`/ST-2110-40 liegt im gevendorten Spec-Testfundus,
   `third_party/mxl/lib/tests/data/data_flow.json`) mit `grain_rate` =
   Videorate — Daten-Grain N gehört per Definition zu Video-Grain N, ein
   Node wendet auf beide dasselbe `D` an (Punkt 4), dann bleibt die
   Zuordnung ohne Zusatzmechanismus korrekt. Für Steuerkommandos, die
   nicht als Medien-Flow reisen (z. B. ein IS-12-„show graphic"- oder
   Take-Aufruf, der exakt zu einem Grain wirken soll), ist ein optionales
   `executeAtIndex`-Argument im generischen Methoden-Dispatch (seit
   C4-prep vorhanden) der vorgesehene Ort — ohne das ist Automation nur
   „so schnell wie der Control-Plane-Roundtrip", nie frame-genau.
   `mxlGrainInfo` selbst hat kein Nutzdaten-Korrelationsfeld (nur
   reservierte Bytes) — die Korrelation läuft ausschließlich über den
   Index, nicht über ein Zusatzfeld.
6. **Re-Berechnung bei laufender Graph-Änderung:** Wird während der Sendung
   eine Kante neu gezogen oder ein Node mit anderer deklarierter Latenz
   eingewechselt, muss der betroffene Pfad neu berechnet und die
   Delay-Zuweisung nachgezogen werden. Kein neuer Mechanismus — derselbe
   `node.added`/Graph-Änderungs-Listener, der schon Workflow-Templates
   (§6.2) und Failover-Reconnects (§6.3) auslöst, bekommt hier einen
   dritten Zweck.

### 15.2 Node-Contract-Empfehlung (nicht Pflicht vor SDK-Freeze)

Anders als das State-Export/Readiness-Signal (§5 Punkt 6, dort **zwingend**
vor dem SDK-v1-Freeze, weil Nachrüsten ein Breaking Change für alle
Community-Nodes wäre) ist die Latenzdeklaration formal additiv nachrüstbar
— ein Node ohne dieses Feld bräuchte nur einen konservativen
„Latenz unbekannt, hoch annehmen"-Fallback im Budget-Rechner. Trotzdem
**Empfehlung**, sie so früh wie praktikabel (Übergang Phase C→D, zusammen
mit dem SDK-v1-Dokument) mit aufzunehmen: Latenzangaben sind faktisch
genauso „teuer nachzurüsten" wie das Readiness-Signal, weil jeder
existierende Community-Node sie sonst nachträglich ergänzen muss, um im
Budget-Rechner nicht pauschal als „Bremse" behandelt zu werden. Bewusst
**keine** Hochstufung zum Pflichtpunkt jetzt (P1 hat nur einen einzigen
Node — die Budget-Rechnung wird erst ab Mehr-Node-Workflows überhaupt
wirksam, siehe Phasenzuordnung).

**Standards-Abdeckung:** PTP/ST 2059 liefert die Zeitbasis (§2); kein
NMOS-Standard deckt „Latenzbudget-Ausgleich über eine Facility" ab — das ist
durchgehend Eigenentwicklung (vergleichbare Ansätze kommerzieller Plattformen
sind proprietär und dienen nur als Vorbild, keine übernehmbare Spec).

**Testbarkeit:** Einfache Fälle bereits auf der Single-Host-Dev-Maschine
testbar — mehrere `omp-source`/`omp-switcher`-Instanzen mit künstlich
unterschiedlich deklarierter Latenz, Delay-Ausgleich über die
Grain-Sequenznummer verifizierbar (kein zweiter Host nötig). Volle
PTP-Cross-Host-Verifikation erst mit echtem 2110-Netz — dieselbe
Einschränkung wie bei §6.1 (§8).

**Phase:** Deklarations-Feld als Empfehlung Richtung SDK v1 (Phase-C/D-
Übergang); Budget-Rechner/Delay-Orchestrierung selbst als P2/D-Baustein
zusammen mit §6.1/§6.2 (gleiche Placement-/Workflow-Infrastruktur, kein
neues Subsystem). Keine A–C-Schritte in `UMSETZUNG.md` ändern dadurch ihren
Scope — die SDK-v1-Empfehlung ist bei der D5-Doku (SDK-Doku/Tutorial)
beziehungsweise beim C10/C11-Playout-Umbau zu berücksichtigen, wenn diese
Schritte konkretisiert werden.

## 16. Ressourcen-Kapazitätsplanung über die Zeit (Erweiterung von §6.2, geplant ab D7)

**Anforderung (2026-07-11):** Zeitliche Planung der Ressourcen — wann will
ich welchen Regieplatz/Workflow starten/stoppen, welche Ressourcen brauche
ich, geht sich das überhaupt aus (Kapazitätsrechnung über mehrere geplante
Regieplätze hinweg)?

**Einordnung:** Erweiterung, kein neues Subsystem. §6.2 (Erweiterung
2026-07-10) hat bereits die **Einzelstart-Ressourcen-Vorprüfung**: prüft
beim tatsächlichen Start eines Workflows, ob **jetzt** alle Rollen
platzierbar sind (harte Vorbedingung, kein Teil-Start). Was fehlt: eine
**vorausschauende, mehrere Workflows gleichzeitig betrachtende** Sicht —
„Regieplatz A ist von 9–12 Uhr geplant, Regieplatz B von 11–14 Uhr,
überschneiden sich 11–12 Uhr die benötigten I/O-Karten/Host-Kapazität?",
und zwar **beim Planen**, nicht erst beim Start um 11 Uhr.

**Konzept:**

1. Jeder zeitgeplante Workflow (`start_at`/`stop_at`, §6.2 Punkt 1) hat
   bereits einen Ressourcen-Fußabdruck (Rollen→Platzierungs-Hinweise inkl.
   exklusiver Karten-Claims, §6.1) — vorhanden für den Einzelstart-Check,
   hier nur wiederverwendet, nicht neu gebaut.
2. **Neue Vorschau-API** `GET /api/v1/capacity?from=…&to=…`: simuliert —
   **ohne irgendetwas zu starten** — den Claim/Release-Zeitstrahl aller im
   Zeitraum geplanten Workflows über dieselbe Placement-Engine (§6.1), rein
   als Berechnung. Für jede exklusive Ressource (Host-Kapazität, I/O-
   Karten-Port) entsteht eine Belegungs-Zeitleiste; Überschneidungen, die
   die verfügbare Kapazität übersteigen, sind Konflikte mit Zeitfenster und
   betroffener Ressource in der Antwort.
3. **Kalender-UI** (neue Shell-Ansicht, kein neues Framework, gleiches
   Muster wie Snapshot-/Katalog-Listen): Regieplätze als Balken auf einer
   Zeitachse je Ressourcen-Pool, Konflikte rot markiert — Feedback beim
   **Anlegen/Ändern** eines Zeitplans, nicht erst beim Start.
4. **Bewusst keine Reservierungssperre.** Die Kalenderansicht ist
   Vorschau/Frühwarnung, **keine** zusätzliche Garantie — der scharfe Check
   bleibt ausschließlich der bestehende Start-Zeitpunkt-Mechanismus (§6.2
   Punkt 3). Entsteht zwischen Planung und Start durch eine andere, später
   geänderte Buchung ein neuer Konflikt, wird das trotzdem erst beim
   tatsächlichen Start hart abgelehnt. Ehrlich benannt: das ist **kein**
   Ressourcen-Reservierungssystem mit Buchungssperre (ein Nutzer könnte
   zwei sich widersprechende Zeitpläne anlegen, ohne dass das Anlegen
   selbst blockiert wird) — ein echtes Sperr-/Reservierungssystem wäre ein
   eigenes, deutlich größeres Feature und bewusst **nicht** Teil dieses
   Konzepts.

**Standards-Abdeckung:** keine (Eigenentwicklung wie der Rest von
§6.1/§6.2). **Testbarkeit:** vollständig auf der Single-Host-Dev-Maschine
simulierbar (fingierte Multi-Host-Inventare wie bei §6.1, mehrere
Workflows mit überlappenden Zeitplänen, Konflikt-Erkennung ist reine
Control-Plane-Logik ohne Medien-Hardware-Bedarf). **Phase:** nach D7 (baut
direkt auf dessen Scheduler/Placement-Ergebnissen auf, kein neuer
Foundational-Baustein) — keine A–C-Schritte ändern ihren Scope.

## 17. Monitoring-Vertiefung: frame-genaue Erkennung, Operator- vs. Engineering-Sicht (geplant, ab P2 zusammen mit §6.1/§6.3)

**Anforderung (2026-07-11):** Detaillierter Monitoring-Plan für die spätere
Umsetzung. Deckt sich mit einer bereits früher (2026-07-09) geäußerten,
für den Nutzer besonders wichtigen Anforderung: Node-/Host-Monitoring muss
**frame-genau** sein, damit ein ausgefallener Node sofort ersetzt/migriert
werden kann — kein „irgendwann später" Nice-to-have, sondern eine der
Kernaufgaben des Orchestrators.

**Einordnung:** Kein neues Subsystem — dieser Abschnitt bündelt bereits
vorhandene Bausteine zu einer Monitoring-Antwort und ergänzt genau eine
konkrete Lücke (Erkennungsgeschwindigkeit). Vorhandene Bausteine, hier nur
referenziert statt neu erfunden: Health/Tally-NATS-Bus + Live-Overlay (§3,
B4), „media-ready"/„media-flowing"-Signal (§5 Punkt 6), Host-Telemetrie +
I/O-Karten-Inventar (§6.1), Crash-Erkennung/Degradation/Hot-Standby (§6.3),
Kapazitäts-Vorschau (§16), Audit-Log (§12 Punkt 4).

### 17.1 Erkennungsgeschwindigkeit als bewusst konfigurierbarer Parameter

Der aktuelle Health-Staleness-Schwellwert (§6.3: „offline nach 10 s ohne
Health-Event") ist ein für **alle** Rollen gleicher Kompromiss. Für
On-Air-kritische Rollen (der aktuell sendende `VideoMixerME`/`AudioMixer`
eines laufenden Regieplatzes, §13) ist 10 s Erkennungszeit für den
Anspruch „frame-genau ersetzen" zu grob. Konkretisierung: der
Health-Publish-Intervall (heute pauschal 5 s, A7/§6.3) und der
Staleness-Schwellwert werden **pro Workflow-Rolle konfigurierbar** (Teil
der Workflow-Definition, §6.2) statt global fest — kritische Rollen können
ein engeres Intervall (z. B. 1 s Publish/2–3 s Schwelle) wählen, nicht-
kritische bleiben beim heutigen Default. Kompromiss ehrlich benannt:
engeres Intervall = mehr NATS-Traffic, keine kostenlose Verbesserung — pro
Rolle abwägbar statt platformweit erzwungen. Das verschiebt die
Erkennungszeit näher an „frame-genau", ohne den bereits als ehrlich
dokumentierten Scope zu verlassen (§6.1/§6.3: „kein Ausfall des Workflows",
nicht „unsichtbarer Schnitt" — dieser Abschnitt macht die Erkennung
schneller, verspricht aber weiterhin keine unsichtbare Fortsetzung mitten
in einer laufenden Bildmischer-Transition).

### 17.2 Zwei Dashboard-Sichten, dieselbe Datenquelle

- **Engineering-Dashboard** (Teil der Flow-Editor-Shell, §4.5a/§14):
  Host-Telemetrie (§6.1), I/O-Karten-Belegung, Workflow-Lebenszyklen über
  die ganze Facility, Kapazitäts-Kalender (§16), Audit-Log (§12) — die
  volle Sicht für `configure`/`admin`-Rollen.
- **Operator-Console-Statuszeile** (§14): eine schmale, auf den eigenen
  Workflow/die eigene Node-Rolle **beschränkte** Status-Leiste (Health der
  unmittelbar vor-/nachgelagerten Nodes im selben Workflow, eigene
  Tally) — kein Zugriff auf Facility-weite Telemetrie, dieselbe
  Scope-Regel wie überall in §12/§14 angewendet, nicht neu erfunden.

**Standards-Abdeckung:** keine zusätzliche (nutzt NATS/§6.1/§6.3 wie
vorhanden). **Testbarkeit:** Publish-Intervall/Schwellwert pro Rolle
vollständig auf der Single-Host-Dev-Maschine testbar (`kill -9` eines
Mock-Nodes mit engerer Konfiguration → messbar schnellere
Offline-Erkennung als beim Default). **Phase:** P2, zusammen mit §6.1/§6.3
(gleiche Telemetrie-Infrastruktur, keine separate Vorarbeit) — keine
A–C-Schritte ändern ihren Scope.

## 18. Remote-Host-Erkennung & Host-Agent (geplant, ab P2; Grundlage von §6.1/§6.2)

**Anforderung (2026-07-11):** Was müssen wir bauen, damit unser Server
(Orchestrator) eine entfernte Maschine (virtuell oder Bare-Metal) erkennt,
um dort Nodes/Services zu starten? Detaillierter Plan gewünscht.

**Einordnung:** Das ist die überfällige Detaillierung eines Bausteins, den
§6.1 Punkt 1 und §6.2 Stufe 0 bereits als „ein Agent, zwei Verben"
angekündigt, aber ausdrücklich als „noch nicht detailliert" offengelassen
hatten. Heutiger Stand: der Instanz-Launcher (§6.2 Stufe 0, bereits gebaut,
C8) startet Subprozesse ausschließlich **lokal** auf demselben Host wie der
Orchestrator (`os/exec`). Dieser Abschnitt beschreibt, was dazukommt, damit
das auch auf einem **entfernten** Host funktioniert.

### 18.1 Was gebaut wird: `omp-host-agent`

Ein eigenständiges, leichtgewichtiges Go-Binary (gleiche Sprachlinie wie
der Orchestrator, §4.1 — keine neue Sprache im Stack), das auf **jedem**
Host läuft, der Nodes hosten soll. Wichtige Abgrenzung: der Host-Agent ist
**kein NMOS-Node** — er produziert/konsumiert keine Medien und hat keinen
IS-12/14-Descriptor (§5). Er ist reine Infrastruktur-Ebene, vergleichbar
mit einem kubelet, aber eigenständig (weil §4.3 auf der Bare-Metal/
Quadlets-Stufe bewusst kein k3s will).

### 18.2 Erkennung: Agent meldet sich selbst an („Phone Home"), nicht Server-Scan

Zwei Muster wären denkbar — Server sucht aktiv im Netz (Scan/mDNS) versus
Agent meldet sich beim Server. **Entschieden: Agent-initiiert.** Begründung:
funktioniert identisch für Bare-Metal/LAN, VM und Cloud/WAN, ohne
Netzwerk-Scan oder Multicast-Bedarf — dieselbe Überlegung, die §6 schon für
das WAN/Cloud-Problem getroffen hat (kein Multicast-Bedarf über die
Cloud-Gateway-Node). Ein Server-seitiger Scan bräuchte zusätzlich
Netzwerktopologie-Wissen, das der Orchestrator sonst nirgends braucht.

### 18.3 Sicherer Bootstrap (kein anonymes Anmelden)

1. Ein Admin (`admin`-Rolle, §12) erzeugt im Orchestrator ein **einmaliges,
   kurzlebiges Bootstrap-Token** pro neuem Host (z. B. 1 h gültig,
   single-use) — `POST /api/v1/hosts/bootstrap-tokens`.
2. Das Token wird in die Provisionierungs-Konfiguration des neuen Hosts
   eingebettet (Cloud-Init, Kickstart, oder ein manuelles Setup-Skript —
   Wahl je Deployment-Weg, kein Zwang zu einem bestimmten Provisioning-Tool).
3. Der `omp-host-agent` startet, meldet sich **einmalig** mit dem Token
   (`POST /api/v1/hosts/register` — Hostname, `uname`-Capabilities,
   I/O-Karten-Inventar) und bekommt im Gegenzug ein **mTLS-Client-
   Zertifikat von step-ca** (§4.6) ausgestellt — dasselbe
   Zertifikats-Bootstrapping-Muster, das step-ca für Orchestrator↔Node
   ohnehin schon vorsieht, hier nur auf den Host-Agent angewendet. Danach
   ist das Bootstrap-Token verbraucht; alle weitere Kommunikation läuft
   über mTLS wie der Rest des Stacks.
4. Ohne gültiges Token keine Registrierung — „Erkennung" ist nie
   ungesichert-anonym, anders als z. B. NMOS IS-04-Node-Discovery, die
   bewusst offen für Medien-Nodes im vertrauten Facility-Netz ist. Der
   Host-Agent braucht die striktere Regel, weil er beliebige Prozesse
   starten kann (Sicherheitsgrenze wie schon in §6.2: „nur
   Katalog-Einträge, keine freien Kommandos").

### 18.4 Telemetrie/Inventar (Detaillierung von §6.1 Punkt 1)

Nach der Registrierung publiziert der Agent periodisch auf demselben
NATS-Bus, der auch Node-Health trägt (§3/§6.1): CPU/RAM/GPU/NIC-Auslastung
plus das I/O-Karten-Inventar (Kartentyp, Port-Anzahl/-Richtung,
Belegungszustand). **Wie** gemessen wird, ist zum Umsetzungszeitpunkt zu
verifizieren, nicht zu raten: Standardmetriken über `/proc`/`/sys`,
I/O-Karten herstellerspezifisch (z. B. Blackmagic DeckLink über dessen
CLI/API) — das ist Eigenrecherche bei der D6/§6.1-Umsetzung, kein
Standardformat.

### 18.5 Kommandokanal: Instanz-Launcher wird Remote-fähig

Der bestehende Instanz-Launcher (§6.2 Stufe 0, `internal/launcher`) schickt
Start/Stop-Kommandos nicht mehr zwingend per lokalem `os/exec`, sondern —
sobald ein Ziel-Host ausgewählt ist (manuell oder über die Placement-Engine,
§6.1) — als Nachricht an den passenden Host-Agent, z. B. über ein
NATS-Request/Reply-Muster auf einem host-spezifischen Subject
(`omp.host.<hostId>.cmd`), über den bereits bestehenden mTLS-authentifizierten
Kanal. Der Agent führt lokal aus und meldet PID/Erfolg zurück — dieselbe
Sicherheitsgrenze wie heute schon lokal (§6.2: nur Katalog-Einträge). Für
die Podman/Quadlet-Runner-Stufe (`runner`-Feld, §6.2) installiert/startet
der Agent das Quadlet auf seinem Host statt eines rohen Subprozesses — nur
die Ausführungsstelle wandert von „lokal beim Orchestrator" zu „auf dem
Zielhost", das `runner`-Konzept selbst bleibt unverändert.

### 18.6 Abgrenzung zu k3s

Auf der Cloud/Multi-Host-k3s-Stufe (§4.3) übernimmt k3s dieselben Aufgaben
bereits nativ (Node-Join-Token = dasselbe Bootstrap-Muster, kubelet =
Telemetrie/Start-Stop) — der `omp-host-agent` ist **nur** für Bare-Metal/
kleine On-Prem-Cluster nötig, wo §4.3 bewusst keinen k3s-Overhead will. Auf
k3s-Hosts registriert sich der k3s-Agent, der Orchestrator spricht dort die
k3s-API statt des eigenen Host-Agent-Protokolls — dieselbe
Zwei-Stufen-Antwort wie schon in §6.2 („keine erzwungene Parität über alle
Deployment-Stufen").

### 18.7 Sichtbarkeit im UI

Ein erfolgreich gebootstrapter Host erscheint in einer neuen Host-Liste im
Engineering-Dashboard (§17.2): Name, Capabilities, aktuelle Auslastung,
I/O-Karten-Inventar — und wird ab dann ein gültiges Platzierungsziel für
die Placement-Engine (§6.1) und die Kapazitätsplanung (§16).

**Node-Contract-Berührung:** keine — der Host-Agent ist kein Node (§18.1),
also nicht von §5 betroffen.

**Standards-Abdeckung:** keine (Host-Discovery/-Bootstrap ist reine
Eigenentwicklung, außerhalb des NMOS-Scopes, der nur Medien-Nodes
beschreibt, keine Compute-Hosts). mTLS/step-ca (§4.6) wird wiederverwendet,
kein neuer Sicherheitsmechanismus.

**Testbarkeit:** Auf der Single-Host-Dev-Maschine bereits **realistischer**
als der bisherige §6.1-Testplan simulierbar — zwei Podman-„virtuelle Hosts"
können jetzt mit einem echten `omp-host-agent`-Prozess pro virtuellem Host
statt nur fingierten Metriken laufen (Bootstrap-Token-Fluss, mTLS-Ausgabe
und Kommandokanal vollständig durchspielbar, nur ohne echte
Host-Trennung). Echte Multi-Host-Verifikation (zweite physische/virtuelle
Maschine), sobald verfügbar.

**Phase:** Kern-Grundlage für D6 (§6.1)/D7 (§6.2) — angesichts der in §7.4
gemessenen Geschwindigkeit und weil der Nutzer eine reale zweite Maschine
unabhängig von Community-Fortschritt testen kann, realistisch **früher**
ansetzbar als die ursprüngliche P2-Einordnung nahelegt (P2-Zeile in §7
entsprechend ergänzt) — sobald der kleine Regieplatz (§7.4) steht, ist dies
der nächste sinnvolle, weil unabhängig von Community-Beiträgen
angehbare Baustein.

## 19. Orchestrator-Redundanz / Control-Plane-HA (Konzept, gestaffelt — kein Umsetzungsschritt vor Bedarf)

**Anforderung (2026-07-11):** Haben wir ein Redundanzkonzept für unseren
Server (Orchestrator) — brauchen wir überhaupt eines?

**Kurze Antwort: aktuell nicht, für das 24/7-Sendezentrum-Zielbild
irgendwann ja — gestaffelt, nicht jetzt bauen.** §6.3 hatte
Orchestrator-HA bereits explizit als „Bewusste Nicht-Ziele v1" benannt,
aber ohne Begründung/Plan stehen lassen; dieser Abschnitt liefert beides.

### 19.1 Warum aktuell nicht

§4.1 hält bereits die entscheidende Eigenschaft fest: „stürzt der
Orchestrator ab, laufen Nodes weiter (kein Frame-Drop), Reconnect beim
Neustart" — Control-Plane (Go) und Media-Plane (Rust) sind getrennte
Prozesse. Ein Orchestrator-Absturz bedeutet also: laufende Signale/
Kompositionen bleiben im letzten Zustand eingefroren, aber es gibt **keinen
Bildausfall**. Was in der Ausfallzeit fehlt, ist **Steuerung**
(Schnitte, neue Verkabelung, Monitoring, neue Workflow-Starts) — für die
aktuelle Phase (Single-Host-Dev, Demo, „temporäre Regieplätze" laut
§1-Zielbild-Unterscheidung) ist **Restart-in-place** (systemd/Podman-
Quadlet-Restart-Policy, bereits Teil des Stacks, §4.3) ausreichend: Sekunden
Steuerungs-Ausfall, kein Medien-Ausfall. Das deckt sich mit der bereits in
§1/§6.3 getroffenen Grundregel: Redundanz-Tiefe ist pro Workflow-Klasse
verschieden, temporäre Regieplätze brauchen primär saubere Provisionierung,
nicht Standby.

### 19.2 Warum langfristig doch — und wann es fällig wird

Das §1-Zielbild „Sendezentrum mit 24/7-Sendeabwicklungen" verträgt einen
mehrsekündigen bis -minütigen Totalausfall der Steuerung schlechter als ein
temporärer Regieplatz — ein Host-Ausfall (nicht nur Prozess-Crash) legt bei
nur einem Orchestrator die Steuerung für die Dauer der Reparatur lahm.
**Fällig wird das erst, wenn eine reale 24/7-Sendeabwicklung ansteht**
(§1-Zielbild), nicht für die aktuellen Demo-Phasen — deshalb hier nur als
Konzept, kein Schritt in `UMSETZUNG.md`.

### 19.3 Konzept-Skizze für später: Active-Passive über die ohnehin vorhandene Postgres/NATS-Basis

Wichtige Ausgangslage, die die Lösung deutlich vereinfacht: der
Orchestrator ist bereits so gebaut, dass er kaum eigenen, nicht
wiederherstellbaren Zustand hält — Config/Snapshots/Layouts liegen in
PostgreSQL (§4.4), Health/Tally sind ephemer auf NATS, Discovery-Zustand
liegt in der NMOS-Registry (§11: nmos-cpp). Orchestrator-HA muss also
**keine eigene Konsens-Logik** für Orchestrator-Zustand erfinden — nur
regeln, welche Instanz gerade „aktiv" ist.

1. **Mehrere Orchestrator-Prozesse**, auf getrennten Hosts, alle gegen
   dieselbe (später geclusterte) Postgres + denselben NATS-Cluster +
   dieselbe(n) NMOS-Registry-Instanz(en) verbunden (NMOS IS-04 erlaubt
   Nodes ohnehin die Registrierung bei mehreren Registries — auch dafür
   also kein neuer Mechanismus nötig).
2. **Leader-Wahl über eine Postgres-Advisory-Lock** statt eines
   zusätzlichen Konsens-Tools (etcd/Raft-Bibliothek o. Ä.) — passt zur
   Ein-Binary-Sparsamkeitslinie (§4.1/§4.3): die Datenbank ist ohnehin da,
   ein zusätzlicher Fremd-Prozess nur für Leader-Wahl wäre unnötiges
   Gewicht. Die passive Instanz hält den Lock nicht, beantwortet
   Health-/Read-Endpunkte, lehnt Schreibkommandos ab (oder leitet sie an
   die aktive Instanz weiter); verliert die aktive Instanz die
   Datenbankverbindung/stirbt, läuft der Lock ab und die passive Instanz
   übernimmt.
3. **Einziger Teil, der nicht rein software-intern lösbar ist:** Clients/
   Nodes müssen dieselbe Adresse ansprechen können, unabhängig davon,
   welche Instanz gerade aktiv ist — entweder ein schlanker
   VIP-Mechanismus (keepalived/VRRP) oder ein einfacher
   Health-Check-basierter L4/L7-Proxy davor. Das ist der einzige neue
   Fremd-Baustein in diesem Konzept — bewusst so knapp wie möglich
   gehalten (kein volles Service-Mesh).
4. **Bewusst nicht mitgelöst — eigene Baustellen, nicht Teil dieses
   Konzepts:** Postgres selbst und NATS selbst sind in diesem Entwurf noch
   nicht redundant. NATS-Clustering ist ein natives, einfaches Feature (3
   Knoten) — Empfehlung: früh mitnehmen, geringer Zusatzaufwand.
   Postgres-HA (Streaming-Replikation + Failover-Tooling wie Patroni) ist
   dagegen ein eigenes, aufwändiges Thema mit hohem
   Aufwand/Nutzen-Verhältnis, solange keine echte 24/7-Sendeabwicklung
   ansteht — bewusst zurückgestellt, nicht jetzt bauen. Ehrlich benannt:
   „Orchestrator-HA" im obigen Sinn beseitigt **nicht** automatisch jeden
   Single-Point-of-Failure der Control-Plane, solange Postgres/NATS selbst
   nicht redundant sind — nur den Orchestrator-Prozess selbst.

**Standards-Abdeckung:** keine (Eigenentwicklung; NMOS-Multi-Registry-
Registrierung wird nur als bestehendes Feature mitgenutzt, nicht neu
gebaut). **Testbarkeit:** vollständig auf der Single-Host-Dev-Maschine
simulierbar, sobald gebaut (zwei Orchestrator-Prozesse gegen dieselbe
lokale Postgres, `kill -9` der aktiven Instanz → passive übernimmt den
Advisory-Lock messbar). **Phase:** kein Schritt vor Bedarf — wird bei
Planung einer echten 24/7-Sendeabwicklung (§1-Zielbild) als P3-Baustein
konkretisiert, siehe §7-Phasenplan-Anmerkung bei P3. Bis dahin ist
Prozess-Restart via systemd/Quadlet-Restart-Policy (§4.3) die einzige und
für den aktuellen Scope ausreichende Antwort.

## 20. 24/7 Broadcast-Grade Hardening — Gap-Analyse & Fahrplan (Zielbild, Priorisierung ausstehend)

**Anforderung (2026-07-12):** Das Projekt so ausarbeiten, dass es
professionell/vollständig genug für den 24/7-Betrieb einer ganzen
Fernseh-/Radioanstalt werden kann — vergleichbarer Anspruch wie
kommerzielle Cloud-Produktionsplattformen, auch beim Look-and-Feel.

**Einordnung dieses Abschnitts:** reine Bestandsaufnahme + Lückenanalyse,
**keine Umsetzungsentscheidung und keine Phasenplan-Änderung**. §7 bleibt
bis auf Weiteres gültig; die Punkte unten sind Kandidaten, die der Nutzer
noch priorisieren muss, bevor daraus `UMSETZUNG.md`-Schritte werden. Wo
ein Thema bereits an anderer Stelle entschieden/gescoped ist, wird das
hier nur verlinkt, nicht dupliziert.

### 20.1 Instanz-/Prozess-Redundanz jenseits von §6.3 (Genlock-Äquivalent)

§6.3 Stufe 4 (Hot-Standby) ist bewusst **break-before-make** und nennt
frame-genaue, unsichtbare Übernahme explizit als **Nicht-Ziel v1**. Der
Nutzer möchte das als bewusstes Zielbild aufwerten (Option „echte
Genlock-Äquivalenz" statt „schneller sichtbarer Cut").

**`fable`-Modell-Konsultation (2026-07-12, Recherche, nicht verifizierter
Fakt wo als Vermutung gekennzeichnet):** wichtige Klarstellung zuerst —
ST 2022-7 ist **Netzwerkpfad**-Redundanz einer einzigen, bitidentischen
Quelle (Empfänger rekonstruiert paketweise aus zwei Pfaden derselben
Payload), kein Beleg-Mechanismus für das hier gewünschte Problem (zwei
unabhängige, zustandsbehaftete Mixer-Prozesse). Was zu Grass Valley AMPP
öffentlich auffindbar ist: ein Latenz-/Alignment-Timing-Modell (kein
Genlock, Timestamp-basiertes Buffering — konzeptionell nahe an OMPs
eigenem, bereits vendor-neutral beschriebenen Latenzbudget-Modell, §15)
sowie als Resilienz-Story primär **schnelles Sekunden-Respawn** plus
optionales **1+1-Hot-Backup pro Playout-Kanal** (GV selbst nennt volles
Hot-Standby in der Cloud „wasteful"). **Kein öffentlicher Beleg gefunden**
für echtes frame-unsichtbares Lockstep-Failover zwischen zwei
Mixer-Instanzen — als Vermutung/Branchenwissen gekennzeichnet, nicht als
verifizierter Fakt.

Wesentliche Bausteine, falls das Ziel langfristig verfolgt wird:

1. Gemeinsame Zeitbasis zwischen redundanten Instanzen (PTP/ST 2059) —
   heute nicht vorhanden (Single-Host-Dev-Maschine ohne PTP-NIC,
   `UMSETZUNG.md` §0 Punkt 7), aber MXLs TAI-Grain-Index
   (`third_party/mxl/docs/Timing.md`) ist bereits eine absolute
   Zeitbasis — ein struktureller Vorteil gegenüber einer Neuentwicklung
   von Null.
2. Deterministisches Command-Mirroring: jede Take/Cut/DVE-Bewegung als
   zeitgestempeltes Kommando „wirksam ab Grain-Index N" an beide
   Instanzen, plus Resync-Protokoll für neu startende Standby-Instanzen.
3. Ein Downstream-Seamless-Switch-Referenzknoten (`omp-seamless-switch`),
   der zwei MXL-Flows liest und pro Grain-Index den gesunden wählt — die
   2022-7-Idee eine Ebene höher, auf ganzen gerenderten Frames statt
   Netzwerkpaketen.
4. Frame-genaue Ausfallerkennung (§17) statt der heutigen 10s-Health-
   Staleness, sonst dominiert die Erkennungszeit jede Umschaltung.
5. Determinismus-Härtung der Render-Pipeline selbst (gleiche
   GStreamer-Elementversionen, keine wallclock-abhängigen Effekte) +
   Divergenz-Monitoring (Frame-Hash-Vergleich beider Ausgänge, §17), sonst
   driften die Ausgaben trotz identischer Kommandos auseinander.

**Realismus-Einschätzung (Fable, Größenordnungen, keine Garantie):**
Command-Mirroring + Seamless-Switch-Node als Single-Host-Prototyp: Wochen
bis wenige Monate. Produktionsreif über zwei Hosts mit echtem PTP, Resync,
Divergenz-Monitoring: eher ein Jahr+ im aktuellen 5–10h/Woche-Tempo. Kein
P1-Demo-Schritt.

**Empfohlene Fundament-Reihenfolge, falls Option (b) als Zielbild gesetzt
wird** (keine neuen Bausteine erfunden, nur sinnvoll sequenziert):
1. Jetzt, günstig: Mixer-Kommandos intern bereits als „ab Grain-Index N
   wirksam" strukturieren (ohnehin für §15 sinnvoll).
2. P2 mit §6.3/§17: Failover-Erkennung + schneller sichtbarer Cut als
   erste, tatsächlich demo-taugliche Redundanzstufe.
3. P2/D-Phase mit §15/§18: echte PTP/ST-2059-Zeitbasis (zweiter Host,
   Host-Agent).
4. Danach: Command-Mirroring als Orchestrator-Baustein (Fan-out an
   Active+Standby) + `omp-seamless-switch` als eigener Referenzknoten.
5. Zuletzt: Determinismus-Härtung + Divergenz-Monitoring.

**Noch nicht final priorisiert** — Nutzer-Entscheidung zwischen (a)
schneller sichtbarer Cut behalten, (b) obige Reihenfolge als Zielbild
festschreiben, (c) Zwischenlösung (paralleler, identisch bedienter
Standby + Downstream-Freeze-Frame) steht noch aus.

### 20.2 Dynamischer, durchsuchbarer Microservice-Katalog

**Großteils bereits gescoped, kein neues System nötig:** §6.4
(Installieren/Importieren/Entfernen/Versionieren über OCI-Images +
Digest-Pinning + Signaturprüfung) und §13.5 (Kategorien-Feld) decken die
Kern-Anforderung „installierbar/importierbar/versionierbar/sortierbar"
bereits ab, sind aber `ab P2`, noch nicht umgesetzt.

**Echte Lücke:** eine tatsächliche **Such-/Filter-UX** (Marketplace-
artiges Browsen über Name/Tag/Hersteller/Kategorie/Kompatibilität) über
§6.4s Katalog — bisher ist nur grobe Kategorien-Gruppierung (§13.5)
gescoped, kein Volltext-/Facetten-Filter. Kleiner additiver Baustein auf
§6.4, keine eigene Architektur-Entscheidung nötig — als Detail-Schritt
mitplanen, sobald §6.4 an der Reihe ist (P2).

### 20.3 Design-System / Look-and-Feel

**Neu, noch nicht gescoped.** Bisherige UI-Linie: kein Framework, kein
npm-Build, vanilla TS/ESM + Custom Elements (`UMSETZUNG.md` §0 Punkt 5,
Minimal-Dependency-Regel §4.1a) — das bleibt bei einer professionellen
Optik **kompatibel**, ist aber kein Ersatz für eines: ein konsistentes
„Look and Feel" braucht ein **Design-System** (Farbpalette/Typografie/
Spacing/Zustände als CSS-Custom-Properties-Tokens, gemeinsame
Component-Bausteine für Buttons/Panels/Tally-Anzeigen/Fader über alle
Node-UI-Bundles hinweg, ein Referenz-Stylesheet, das jedes UI-Bundle statt
eigener Ad-hoc-Styles importiert), keine Framework-Frage. Bisher hat jedes
Node-UI-Bundle (C7/C10/C11/C12) sein eigenes, unabhängiges `<style>`
gebaut — funktioniert, sieht aber pro Node leicht anders aus. **Kandidat
für einen eigenen Schritt** (vermutlich zusammen mit C13, weil die
Operator-Console die erste UI-Fläche ist, die mehrere Node-Panels
nebeneinander zeigt und dadurch Stil-Inkonsistenz zuerst sichtbar
gemacht).

### 20.4 Security/Auth-Hardening (D3) — Priorität prüfen

Bereits geplant (`UMSETZUNG.md` D3: step-ca/mTLS, IS-10/OAuth2, §12-
Rollenmodell), aber ohne festen Zeitpunkt („Phase D"). Für echten 24/7-
Mehrpersonen-Betrieb (mehrere Bildmeister/Tonmeister/Admins, §14) ist D3
kein Nice-to-have, sondern Voraussetzung — C13 (Operator-Console) baut
heute bewusst noch mit einem **Rollen-Stub** statt echter Durchsetzung
(`UMSETZUNG.md` C13: „echte Durchsetzung folgt mit D3"). Empfehlung: D3
nicht beliebig weit nach hinten schieben, sobald mehr als eine Person
gleichzeitig am System arbeitet.

### 20.5 Control-Plane-HA — bereits abgedeckt

Siehe §19 (bestehendes, gestaffeltes Konzept) — für das 24/7-Zielbild
weiterhin relevant, keine Änderung durch diesen Abschnitt nötig.

### 20.6 Bisher nirgends erfasste Betriebs-/Compliance-Themen einer echten Sendeanstalt

Neu identifiziert, noch nicht diskutiert — reine Auflistung, keine
Entscheidung:

- **Compliance-Recording/Loggingpflicht:** in vielen Rechtsordnungen muss
  aufgezeichnet werden, was wann on air war (Sendeprotokoll +
  Referenzaufzeichnung, oft mehrere Wochen Aufbewahrung) — heute nirgends
  im Projekt erfasst.
- **Loudness-/Ausstrahlungs-Konformität** (z. B. EBU R128) und
  Untertitel-/Ancillary-Data-Durchreichung — bisher nicht betrachtet.
- **NOC-/Alarmierungs-Eskalation über die App hinaus** (Paging/SMS/On-
  Call statt nur In-App-Tally/Alert, §6.3/§17).
- **Backup/Restore-Prozedur** für Config/Snapshots (D1 bringt Persistenz
  in Postgres, aber keine dokumentierte Sicherungs-/Wiederherstellungs-
  Routine).
- **Automatisierte Regressions-/Soak-Tests** über CI hinaus (Dauerlast,
  Langzeit-Stabilität) — heute nur `make check` pro Commit.
- **Multi-Anstalt-/Multi-Standort-Betrieb** (ein Orchestrator pro Standort
  vs. zentrale Verwaltung mehrerer Standorte) — bisher nicht betrachtet,
  falls „ganze Fernseh-/Radioanstalt" mehrere Standorte einschließen soll.

### 20.7 Bewusst unverändert: AMPP/Grass Valley bleibt kein Referenzname in diesem Dokument

Auf Nutzerwunsch (2026-07-12) dient AMPP/vergleichbare Plattformen
weiterhin nur als **interner** Recherche-/Qualitätsmaßstab (z. B. für
§20.1) — keine Rücknahme der Entscheidung vom 2026-07-11
(`docs/decisions.md`), alle Vendor-Namen bleiben aus `ARCHITECTURE.md`
draußen.

### 20.8 Explizit weiterhin außerhalb des Zielbilds, sofern nicht erneut angefragt

MAM/Traffic/Sendeplanungs-Systeme und Radio-Automation bleiben bewusst
„nach 2029" verschoben (§7-Phasenplan, P3) — dieser Abschnitt ändert das
nicht, auch wenn eine vollständige Sendeanstalt in der Praxis meist auch
das braucht.

**Nächster Schritt:** Nutzer priorisiert §20.1–§20.6, danach werden
priorisierte Punkte als reguläre `UMSETZUNG.md`-Schritte konkretisiert —
analog zu §11.2/§13/§19s bisherigem Vorgehen (erst hier als Konzept
verankern, dann erst zum nummerierten Schritt machen).
