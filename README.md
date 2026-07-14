# OpenMediaPlatform

![OpenMediaPlatform Hero](./OpenMediaPlatform%20Hero.png)

Neues, eigenständiges Projekt (getrennt von `PIPELINE CONTROLLER`).

## An Open-Source Orchestrator for Broadcast – A Current Status

The goal is a proof of concept for a modular broadcast and streaming platform that adheres to open standards and brings modern software architectures to the broadcast world.

The focus is not on a single product, but rather on how to assemble a complete production system from independent services.

The architectural foundation is the EBU Dynamic Media Facility (DMF) model: Functions such as video mixers, audio mixers, playout, graphics, and signal sources are not conceived as monolithic applications, but as independent, loosely coupled services that can be dynamically orchestrated.

For local, high-performance media exchange, MXL (Media Exchange Layer) is used. MXL enables zero-copy exchange of audio and video data between processes on the same host, thus replacing the traditional approach of unnecessarily transporting media streams over network stacks or proprietary interfaces. When multiple hosts are involved, communication takes place via SMPTE ST 2110 (with an SRT gateway for contribution/distribution over lossy networks).

The core of the system is an orchestrator developed in Go. It handles discovery, routing, and communication between the individual services. NATS is used as the event bus, while AMWA NMOS (IS-04 and IS-05) handles the automatic registration and routing of the components. This means the orchestrator doesn't have to rely on fixed device types or proprietary interfaces.

An essential part of the architecture is also the NMOS Control Framework (IS-12/IS-14). Each service describes its own parameters and capabilities. Therefore, the orchestrator doesn't need to know whether it's a video mixer, audio mixer, or a future node type. New components can be integrated without requiring any modifications to the orchestrator. This self-description capability is precisely what makes the platform scalable in the long term.

Several microservices are currently available as demonstrators:

- Test sources
- Video switcher
- Video mixer (1 M/E with cut, crossfade, and picture-in-picture)
- Simple audio mixer with audio-follow-video
- Video player and jingle player (cued playback)
- Playout automation (playlist-driven, no pipeline of its own)
- Viewer and multiviewer
- ST 2110 ⇄ SRT gateway for inter-site contribution

All components run as independent services and can be started, stopped, or extended independently — either locally via the built-in instance launcher, or on a separate machine via a lightweight host agent that registers itself with the orchestrator and executes only pre-approved node types (agent-local catalog as the trust boundary, not a wide-open remote-exec channel).

A graphical user interface is being developed in parallel, consistently implementing the concept of a software-defined broadcast system. Nodes register automatically, appear in the flow editor, and can be connected via drag and drop. Parameters are dynamically generated from their respective self-descriptions—without having to develop separate interfaces for each device type. Login-based user/role accounts (local, no external directory server required) gate who can wire the graph, launch instances, or administer hosts.

Although the project is still in its early stages, the current version is already fully functional on my Chromebook. For me, this is important proof that modern broadcast architectures can initially be developed and validated with manageable resources.

The focus is currently deliberately not on topics such as high availability, redundancy, or commercial support. The goal is to verify the architecture and demonstrate the potential of open standards like DMF, MXL, NMOS, and NATS.

I'm excited to see how this approach evolves and look forward to exchanging ideas with everyone involved in software-defined broadcast systems, open standards, or modern media architectures.

## Quickstart

```sh
make start   # NATS + NMOS-Registry + Orchestrator, siehe docs/HANDBUCH.md
```

Danach http://localhost:8000 öffnen. Details/Troubleshooting:
[`docs/HANDBUCH.md`](docs/HANDBUCH.md).

## Status

Architektur/Tech-Stack entschieden (siehe `ARCHITECTURE.md`), Umsetzung
läuft nach `UMSETZUNG.md` (Status-Checkliste dort). Fundament,
Flow-Editor und der kleine Regieplatz (Source/Switcher/Video-Mixer/
Audio-Mixer/Player/Multiviewer/Playout-Automation, alle GUI-startbar)
stehen; dazu ST 2110 + SRT-Gateway, PostgreSQL-Backend, mTLS
Orchestrator↔Nodes, ein lokales Nutzer-/Rollenmodell mit Login, ein
Node-SDK-Tutorial sowie Remote-Host-Erkennung samt Kommandokanal
(Instanzen auch auf einer entfernten Maschine starten/stoppen, über
einen Host-Agent mit host-lokalem Katalog als Sicherheitsgrenze).
Offen: automatische Placement-Engine (Ressourcen-bewusste Zielhost-Wahl)
sowie Workflow-Objekte/-Bundles (D7).

## Verwandtes Projekt

Für Broadcast-/GStreamer-/Playout-Erfahrung siehe `PIPELINE CONTROLLER`
(separates Repo, siehe `CLAUDE.md` für Details).
