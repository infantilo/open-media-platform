# OpenMediaPlatform

[![AMWA NMOS](https://img.shields.io/badge/AMWA%20NMOS-IS--04%20v1.3-1f6feb)](https://specs.amwa.tv/is-04/) [![AMWA NMOS](https://img.shields.io/badge/AMWA%20NMOS-IS--05%20v1.1%20%2B%20v1.2.0-1f6feb)](https://specs.amwa.tv/is-05/) [![AMWA NMOS](https://img.shields.io/badge/AMWA%20NMOS-IS--12%20%2F%20IS--14-1f6feb)](https://specs.amwa.tv/ms-05-02/) [![AMWA NMOS](https://img.shields.io/badge/AMWA%20NMOS-IS--08-1f6feb)](https://specs.amwa.tv/is-08/) [![AMWA NMOS](https://img.shields.io/badge/AMWA%20NMOS-BCP--003--01-1f6feb)](https://specs.amwa.tv/bcp-003-01/) [![AMWA NMOS](https://img.shields.io/badge/AMWA%20NMOS-BCP--008-1f6feb)](https://specs.amwa.tv/bcp-008-01/) [![AMWA NMOS](https://img.shields.io/badge/AMWA%20NMOS-BCP--007--03%20(MXL)-1f6feb)](https://specs.amwa.tv/bcp-007-03/) [![CI](https://img.shields.io/badge/AMWA%20conformance-verified%20in%20CI-2ea043)](.github/workflows/ci.yml) [![SMPTE](https://img.shields.io/badge/SMPTE-ST%202110--20%2F30-6e40c9)](https://www.smpte.org/standards) [![AES67](https://img.shields.io/badge/AES67-Dante%20compatible-6e40c9)](https://en.wikipedia.org/wiki/AES67) [![EBU](https://img.shields.io/badge/EBU-R37%20%2B%20R128%2FBS.1770-6e40c9)](https://tech.ebu.ch/loudness)

> **Standards-first:** built directly on AMWA NMOS — IS-04 v1.3 for
> discovery/registration, **IS-05 v1.1 and the current v1.2.0 release
> served side by side** (wire-compatible, same handlers) for connection
> management, IS-12/IS-14 for self-described control, BCP-008-01/02
> for real receiver/sender health status (link, sync, connection/
> transmission, stream/essence) on the network-facing nodes, and
> **BCP-007-03** for standardized IS-05 connection management of MXL
> flows (`urn:x-nmos:transport:mxl`, real `mxl_domain_id`/`mxl_flow_id`
> transport parameters, not a proprietary transport string). This isn't
> a compatibility claim on paper: the official AMWA NMOS Testing Tool
> runs against a real node on every push, and the current run is fully
> green — 62 passing IS-05-01 checks, zero accepted exceptions, on both
> API versions; BCP-007-03 (too new to have an official AMWA test suite
> yet) is checked by our own schema-conformance tool instead, against
> the real published JSON schemas.

### Standards conformance — verified, not just claimed

| Standard | What it covers here | Verified by |
|---|---|---|
| AMWA NMOS IS-04 v1.3 | Discovery & registration | Official AMWA NMOS Testing Tool, in CI on every push |
| AMWA NMOS IS-05 v1.1 + v1.2.0 | Connection management, both API versions served side by side | Official AMWA NMOS Testing Tool — 62/62 checks, zero accepted exceptions |
| AMWA NMOS IS-08 | Audio channel mapping | Real `audiomixmatrix` routing over the standard API, round-trip live-verified |
| AMWA NMOS IS-12 / IS-14 | Self-described control (no built-in node-type knowledge) | Every node self-describes; new node types integrate with zero orchestrator changes |
| AMWA BCP-003-01 | Secure transport for the NMOS control plane | Registry over TLS, opt-in, same model as orchestrator↔node mTLS |
| AMWA BCP-007-03 | MXL as a standardized NMOS transport, not a proprietary one | Own schema-conformance tool against the real published JSON schemas (spec too new for an official AMWA suite yet) |
| AMWA BCP-008-01/02 | Receiver/sender health status | Real signals (GStreamer jitterbuffer stats, PTP lock, DeckLink cable lock, SRT stats), live-verified |
| MXL v1.1.0 (Media eXchange Layer) | Zero-copy local media exchange | Read/write path run against MXL's own independent reference tools, both directions, down to actual pixels |
| SMPTE ST 2110-20/30 | Video/audio over IP | Conformant SDP, live-verified against real RTP traffic |
| AES67 (Dante-compatible) | Audio interop over IP | SAP discovery, live-verified |
| PTP (IEEE 1588) | Network timebase for the 2110 paths | Opt-in domain, verified live-synchronized across two network namespaces |
| SMPTE ST 377-4 / ST 377-41 (MXF MCA) | Multichannel audio labeling in MXF (channel / soundfield-group / group labels, controlled vocabulary) | Own parser and injector (`omp-mxf-mca`); `omp-mxf-player` reads labels into the audio rules, `omp-recorder` writes them into `.mxf` recordings; round-trip checked against ffmpeg/GStreamer demuxers (no MCA reference file available yet) |
| EBU R 37 | A/V lip-sync tolerance window | `omp-scope` measures real signals and scores them against it live |
| EBU R 128 / ITU-R BS.1770 | Loudness & true peak | `omp-scope` computes both and gives a live compliance verdict |

![OpenMediaPlatform Hero](./OpenMediaPlatform%20Hero.png)

New, standalone project (separate from `PIPELINE CONTROLLER`).

## An Open-Source Orchestrator for Broadcast – A Current Status

The goal is a proof of concept for a modular broadcast and streaming platform that adheres to open standards and brings modern software architectures to the broadcast world.

The focus is not on a single product, but rather on how to assemble a complete production system from independent services.

The architectural foundation is the EBU Dynamic Media Facility (DMF) model: Functions such as video mixers, audio mixers, playout, graphics, and signal sources are not conceived as monolithic applications, but as independent, loosely coupled services that can be dynamically orchestrated.

For local, high-performance media exchange, MXL (Media Exchange Layer) is used. MXL enables zero-copy exchange of audio and video data between processes on the same host, thus replacing the traditional approach of unnecessarily transporting media streams over network stacks or proprietary interfaces. When multiple hosts are involved, communication takes place either via SMPTE ST 2110 (with an SRT gateway for contribution/distribution over lossy networks) or, as a zero-copy alternative, via MXL-native Fabrics — real remote memory access (RDMA) between two MXL domains on different hosts, verified live over a software transport, with a drop-in path to real RDMA hardware.

The core of the system is an orchestrator developed in Go. It handles discovery, routing, and communication between the individual services. NATS is used as the event bus, while AMWA NMOS (IS-04 v1.3 and IS-05, both the v1.1.x line and the current v1.2.0 release) handles the automatic registration and routing of the components. This means the orchestrator doesn't have to rely on fixed device types or proprietary interfaces.

**A note on scope:** the microservices listed below (`omp-source`,
`omp-video-mixer-me`, `omp-mxf-player`, etc.) exist to demonstrate what the
orchestrator can actually coordinate end to end — they are reference
implementations, not the product. The project's core focus, and where
most of the engineering effort goes, is the orchestrator itself:
discovery/routing, placement and multi-host operation, high
availability (Raft cluster, clustered NATS, Patroni/etcd Postgres),
auth/audit, and the tooling around it (Flow Editor, guided Host and
Cluster setup wizards, workflows). Anyone is welcome to build their own
nodes against the same NMOS-based contract; the orchestrator doesn't
need to know or care what they do.

An essential part of the architecture is also the NMOS Control Framework (IS-12/IS-14). Each service describes its own parameters and capabilities. Therefore, the orchestrator doesn't need to know whether it's a video mixer, audio mixer, or a future node type. New components can be integrated without requiring any modifications to the orchestrator. This self-description capability is precisely what makes the platform scalable in the long term.

Although the project is still in its early stages, the current version is already fully functional on my Chromebook. For me, this is important proof that modern broadcast architectures can initially be developed and validated with manageable resources.

I'm excited to see how this approach evolves and look forward to exchanging ideas with everyone involved in software-defined broadcast systems, open standards, or modern media architectures.

**Contents:** [Quickstart](#quickstart) · [Demo](#demo) ·
[Screenshots](#screenshots) · [What's in the box](#whats-in-the-box)
(standard-based core, flow editor & workflows, business process engine
& asset catalog, microservices, reliability & operations) · [What
OpenMediaPlatform does not do](#what-openmediaplatform-does-not-do) ·
[Status](#status) · [License](#license) · [Related
project](#related-project)

## Quickstart

```sh
make preflight   # first install: checks tools, Podman, images, ports — and tells you how to fix each problem
make start       # NATS + NMOS registry + orchestrator, see docs/HANDBUCH.md
```

`make start` runs the short form of the preflight check itself and stops
with a clear message (cause + fix command for your distribution) instead
of failing minutes later. Then open http://localhost:8000. Details/troubleshooting:
[`docs/HANDBUCH.md`](docs/HANDBUCH.md). User guide for the UI (with
screenshots): [`docs/BENUTZERHANDBUCH.md`](docs/BENUTZERHANDBUCH.md).
(Both docs are in German — this README is the only English-language
entry point so far.)

## Demo

https://github.com/user-attachments/assets/f347147b-6052-4a5c-af90-4a5c946592a1

_~5 min walkthrough of the UI in action — node catalog, Flow Editor
wiring, multi-host operation, workflows._

## Screenshots

![Flow editor with running node instances](docs/screenshots/flow-editor.png)

_The flow editor: node catalog on the left, drag-and-drop wiring on the
canvas, a running workflow shown as a collapsible tile._

![Host zones: two hosts, a group spanning both, and an MXL connection flagged for crossing a host boundary](docs/screenshots/host-zonen.png)

_Multi-host operation made visible: each registered host gets its own
zone with live CPU/RAM; a source migrated to a second host while its
viewer stayed local — the resulting MXL connection (host-local by
design) is automatically flagged in the warning style, because that
link needs an ST 2110/SRT/Fabrics gateway to actually work across
hosts, not a same-host zero-copy MXL flow._

![Operator console with four assigned node UIs plus two sources honestly reporting they have no UI of their own](docs/screenshots/operator-konsole.png)

_An operator's console: every node UI it's entitled to operate, live,
side by side — no flow editor, no catalog, nothing to misconfigure._

![The measurement node: waveform/vectorscope, A/V timing against the EBU R 37 window, held signal alarms, EBU R 128 loudness with true peak](docs/screenshots/scope-messgeraet.png)

_The `omp-scope` measurement tap: lip-sync computed from the MXL grain
origin timestamps of the two flows (not from arrival times), scored
against the EBU R 37 window; held black/freeze/silence alarms; EBU R 128
loudness with ITU-R BS.1770 true peak. Further down the same panel:
per-flow transport latency, delay variation, cadence and dropped-grain
counters, next to what the writer actually declares about the flow._

### More screens

<table>
<tr>
<td width="33%"><img src="docs/screenshots/scope-mxl-timing.png" width="260"><br><sub><code>omp-scope</code>: per-flow MXL transport latency, delay variation, cadence and dropped-grain counters, next to the writer's own flow declaration</sub></td>
<td width="33%"><img src="docs/screenshots/scope-qc-alarme.png" width="260"><br><sub><code>omp-scope</code>: held black/freeze/silence QC alarms — debounced, not a false alarm on every cut</sub></td>
<td width="33%"><img src="docs/screenshots/hosts.png" width="260"><br><sub>Host list: CPU/RAM/network telemetry per host, online status, sparkline history</sub></td>
</tr>
<tr>
<td width="33%"><img src="docs/screenshots/host-wizard.png" width="260"><br><sub>Guided host onboarding — bare-metal, VM or AWS</sub></td>
<td width="33%"><img src="docs/screenshots/cluster.png" width="260"><br><sub>Raft cluster status, guided join/leave for growing or shrinking the orchestrator cluster</sub></td>
<td width="33%"><img src="docs/screenshots/instanzen.png" width="260"><br><sub>Running instances: CPU/RAM per process, across all hosts</sub></td>
</tr>
<tr>
<td width="33%"><img src="docs/screenshots/workflows.png" width="260"><br><sub>Workflow management — presets, snapshots, running state</sub></td>
<td width="33%"><img src="docs/screenshots/scheduler.png" width="260"><br><sub>Scheduler with resource planning — per-host CPU/RAM/I-O timeline, bottlenecks in red, free capacity, drag to move/resize/create</sub></td>
<td width="33%"><img src="docs/screenshots/gruppen.png" width="260"><br><sub>Grouped/nested tiles in the flow editor</sub></td>
</tr>
<tr>
<td width="33%"><img src="docs/screenshots/alarme.png" width="260"><br><sub>Collected alarms across the whole fleet</sub></td>
<td width="33%"><img src="docs/screenshots/administration.png" width="260"><br><sub>Administration: users, role bindings, node catalog, audit log</sub></td>
<td width="33%"><img src="docs/screenshots/login.png" width="260"><br><sub>Login — local user/role model with audit log</sub></td>
</tr>
<tr>
<td width="33%"><img src="docs/screenshots/scheduler-woche.png" width="260"><br><sub>Scheduler, week view: recurring plans and the daily 18:00 bottleneck on one host at a glance</sub></td>
<td width="33%"><img src="docs/screenshots/scheduler-ziehen.png" width="260"><br><sub>Dragging out a new schedule — the resource strips preview the effect live</sub></td>
<td width="33%"><img src="docs/screenshots/system-update.png" width="260"><br><sub>System update: signed package upload, content review, version confirmation, automatic rollback</sub></td>
</tr>
</table>

Full walkthroughs and context for every screen above are in
[`docs/BENUTZERHANDBUCH.md`](docs/BENUTZERHANDBUCH.md).

## What's in the box

**Standard-based core**

- EBU DMF-style service decomposition — a mixer, a player, a graphics
  engine, etc. are independent, self-describing processes, not modules
  inside a monolith.
- AMWA NMOS IS-04 v1.3/IS-05 for discovery and routing; IS-12/IS-14 for
  self-described parameters and methods — the orchestrator never has
  built-in knowledge of a specific node type. IS-05 serves both the
  v1.1.x line and the current **v1.2.0** release side by side (wire-
  compatible, same handlers) so existing v1.1 controllers keep working
  while new ones can already target v1.2. Conformance isn't just
  claimed: the official AMWA NMOS Testing Tool runs in CI on every push
  against a real running registry (IS-04-02) and a real running node,
  for both IS-05-01 API versions, with every accepted deviation
  individually named and justified in the workflow file — no silent
  skips (and as of the latest pass, zero: all IS-05-01 exceptions,
  including the ones that needed a real Sender fixture, are closed).
- MXL zero-copy shared memory for same-host media exchange, on
  **MXL v1.1.0** (GA, incl. the native Fabrics API); SMPTE ST 2110 (+ SRT gateway for lossy
  WANs) or MXL-native Fabrics (RDMA) for cross-host exchange,
  including AES67 audio (Dante-compatible). Because MXL is an open
  format shared by the whole software-defined-production ecosystem
  (not an OMP-specific transport), interoperability was verified
  directly: OMP's own read/write path was run against the MXL
  project's independent reference tools on the same shared-memory
  domain — in both directions, including full pixel-level playback —
  confirming a third-party media function speaking the same open MXL
  format could exchange a flow with an OMP node with no gateway in
  between. IS-05 connection management for MXL flows now speaks the
  standardized **AMWA BCP-007-03** transport (`urn:x-nmos:transport:mxl`,
  real `mxl_domain_id`/`mxl_flow_id` parameters) instead of a proprietary
  transport string — a foreign, spec-compliant controller can address an
  OMP MXL sender/receiver as such, not just OMP's own orchestrator.
- **AMWA BCP-008-01/02 health monitoring**: real receiver/sender status
  (link, external sync, connection/transmission, stream/essence, plus
  an aggregated overall status) on every node that touches a real
  network or hardware boundary — `omp-2110-gateway`, `omp-decklink`,
  `omp-aes67-gateway`, `omp-srt-gateway` — backed by actual signals
  (GStreamer `rtpjitterbuffer` packet-loss counters, PTP lock state,
  DeckLink cable/format lock, real SRT connection statistics), not
  synthetic placeholders; MXL-internal nodes (`omp-video-mixer-me`,
  `omp-viewer`, `omp-recorder`) get the same status model applied to
  "is this input's MXL flow actually readable" instead of link health.
  Exposed as generic parameters (`monitor.*`), readable through the
  same self-description mechanism as everything else — no separate
  BCP-008 client needed to inspect it.
- PostgreSQL-backed state (highly available via Patroni + etcd, no
  single-node database SPOF), mTLS between orchestrator and nodes, a
  local user/role model with audit log — no external directory server
  required. The NMOS Registry (IS-04/05 Query/Registration API) can
  also be run over AMWA BCP-003-01 transport TLS (`make
  nmos-registry-tls-up`) instead of plaintext HTTP — opt-in, same as
  mTLS.
- The orchestrator itself runs as a Raft-consensus cluster (one or more
  instances, automatic leader election/failover) and the NATS event bus
  is clustered too — no single point of failure anywhere in the control
  plane. Both onboarding a new host (bare-metal, VM, or an AWS EC2
  instance) and growing the orchestrator cluster itself are guided,
  point-and-click wizards in the Administration UI — not a curl-only
  API you have to script by hand.

**Flow editor & workflows**

- Drag-and-drop canvas: nodes register automatically and appear as
  tiles; connecting two ports creates a real IS-05 connection.
- Reusable workflow objects (named role→role templates), snapshots/
  presets, grouping tiles into collapsible macro blocks, import/export.
- A scheduler tab for time-driven start/stop of whole workflows
  (day/week/month view). Drag a bar to move it, drag its edges to
  lengthen/shorten it, or drag on an empty spot of a row to create a
  new schedule.
- **Resource planning in the scheduler**: below the timeline, every host
  gets CPU, RAM and I/O-port strips over time, computed from the
  schedules and the *measured* per-node-type profiles (CPU 95th
  percentile, RAM maximum) against the host's capacity. Bottlenecks turn
  red (with the affected time range and resource), the free reserve up to
  the placement threshold is shown per host, bars that run into a
  bottleneck get a red outline, and roles without a measurement profile
  are hatched ("demand unknown", never silently zero). While dragging, the
  strips preview the change live; on drop a new bottleneck is called out.
- Multi-host operation is visible on the same canvas, not a separate
  screen: once more than one host is registered, the flow editor shows
  a zone per host (live CPU/RAM, fixed lanes, toggleable), a connection
  that crosses a host boundary while using host-local MXL is flagged
  automatically (dashed, with an explanation), zones are collapsible,
  and dragging a standalone node's tile into another zone triggers a
  guided move (stop, start on the target host, best-effort reconnect
  of its existing connections) after a confirmation dialog.

**Operations**

- **System update from the browser**: an admin uploads a signed update
  package (Ed25519 signature, SHA-256 per file, strict archive checks),
  reviews its content and confirms the version by typing it. The
  standalone supervisor backs up the database, stages everything next to
  its target (no downtime yet), stops the orchestrator, swaps the files
  atomically, restarts it with the finished binaries (no source build) and
  verifies health and version — **automatically rolling back** if the new
  version does not come up. Running nodes keep running and are flagged
  "outdated" until restarted (one confirmed action restarts them);
  packages can also be distributed to remote host agents, which verify
  them against their own trust anchor. See `docs/HANDBUCH.md` §5b.
- Database backup/restore from the browser, an orchestrator cluster
  (Raft) with guided join/leave, and an audit log of all write requests.

**Business process engine & asset catalog**

Deliberately a *second*, separate concept from the "workflow" objects
above (which are node-role deployment bundles, i.e. a control-room
setup) — a business-process/task-graph engine in the BPMN sense:
definitions, versions with an immutable-once-published lifecycle, and executions
that survive an orchestrator restart mid-run (crash-recovery is a
tested requirement, not an afterthought). The step vocabulary covers
task, media function (drives any self-described node method through
the same IS-12/14 contract the Flow Editor uses), service call,
allow-listed shell script (`ffmpeg`/`ffprobe` auto-detected on the
host, nothing else runs unless explicitly allow-listed) — with a
**guided assistant** on top rather than raw CLI flags, built entirely
from the host's *actual* installed ffmpeg (real encoder/container/
filter lists, their real options, valid ranges and defaults —
introspected live, never hand-maintained, so it can't drift out of
sync with the ffmpeg build it's actually driving): read technical
metadata, make a thumbnail, convert format/codec (parameter fields
adapt to what the chosen codec/container actually supports — a select/
checkbox/range per option, not a blind text box), extract an audio
track, concatenate clips into a "Schnittliste" (optionally as a true
stream-copy with no re-encoding, for compatible source formats), and
place timed text/image overlays (branding, credits) with a start/end
per event. A graphical routing/mixing/delay matrix maps arbitrary
source channels onto output tracks (percentage mix, millisecond
delay), and output tracks themselves are a generic, repeatable
building block — any number of independently-coded tracks with
free-form metadata, not a fixed title/language pair. A visual
drag-and-drop filter-graph builder (search a real filter, wire named
pads, adjustable pad count for filters like `amix`) compiles to the
real `-filter_complex` syntax. For anyone who needs a parameter the
guided forms don't surface yet, an expert mode exposes literally every
parameter across every installed encoder/decoder/muxer/demuxer/filter
plus the full set of global CLI flags (over a thousand, all searchable
by name or description, inserted with one click, validated inline as
you type) — raw arguments are never more than one click away — condition/
branch (a sandboxed expression language, no host access), parallel/
join, wait/timer, human task/approval (assign, claim, decide, with
optimistic-concurrency-safe state), notification, subworkflow, and
compensation. Domain events (e.g. an asset becoming ready) can start a
process automatically — delivered at-least-once via a Postgres
outbox written atomically with the state change, relayed through
clustered NATS JetStream, so a crashed relay never silently drops an
event. A visual, drag-and-drop step-graph editor (reusing the same
`ui/graph` pan/zoom/connect primitives as the Flow Editor and the
graphical workflow designer, on a genuine business-process graph
instead of a live NMOS wiring view) sits next to a plain HTTP API —
both produce the identical JSON. Alongside it, an asset/content domain
model (assets, versions, representations, free-form metadata
categories, an explicit ingest→…→published→archived lifecycle state
machine, plus collections and typed asset-to-asset relationships such
as `derived_from`/`version_of`) gives the process engine something
real to operate on. Storage is provider-agnostic by design and backed
by a real implementation, not just a placeholder: representations get
presigned upload/download URLs against an actual S3-compatible store
(MinIO), so media bytes move directly between client and object store,
never proxied through the orchestrator. A process execution can link
to the specific asset version it produced or consumed (a generic,
process/asset-agnostic link record, not a special case in either
domain), and every asset/process state change is additionally captured
in its own business-level audit trail, separate from the general
request audit log. Its own "Assets" tab offers search/filter, lifecycle
transitions (only those the backend state machine actually allows —
the UI reads them from the server rather than keeping its own copy), a
key/value metadata editor that keeps non-string values intact, and
versions with their technical representations; a published version is
enforced immutable on the server, not just hidden in the UI.

**Microservices** (demonstration nodes, not the focus — see the note
above) — each an independent process that self-registers via NMOS,
with its own UI and self-described parameters (full list with
functions: [`docs/HANDBUCH.md`](docs/HANDBUCH.md) §9):

- **omp-source** — test sources (color bars etc. plus test tone)
- **omp-decklink** — Blackmagic DeckLink SDI/IP capture card bridge,
  directed per instance (ingest: card → MXL; output: MXL → card,
  video-anchored with an independent optional audio leg); SDI and IP
  cards are addressed identically in software — a DeckLink IP card's
  network-side configuration (multicast/PTP/SDP) lives entirely in
  Blackmagic's own driver, outside NMOS's reach; also exposes AMWA NMOS
  IS-08 for its embedded SDI audio channels (e.g. remap embedded
  channels 3+4 onto program audio via the standard API)
- **omp-switcher** — simple video switcher between auto-discovered
  sources (no program/preset bus)
- **omp-video-mixer-me** — video mixer (1 M/E with cut, crossfade,
  picture-in-picture, downstream keyer)
- **omp-audio-mixer** — broadcast audio console: per-channel HPF + 4-band
  EQ, compressor (attack/release/knee/GR), gate/expander, delay, pan, phase;
  gain-sharing AutoMix and sidechain ducking (separate engines) with groups
  and manual override; aux/N-1 buses with pre/post sends; scenes with
  video→audio context; declarative media-player automation; derived On-Air
  state; touch-capable responsive console (full/compact/dense/grid/touch);
  master limiter, solo/PFL, audio-follow-video (see docs/AUDIOMIXER-PLAN.md)
- **omp-mxf-player** — MXF file player with program-group audio shuffle
  and MXF MCA label reading (SMPTE ST 377-4/-41; labels drive the audio rules)
  (cued playback, plus live-MXL-source and real-file playlist items)
- **omp-channel-player** — isel-free single-branch player for the
  playout automation channels (load-only, no playlist/cue-take)
- **omp-playout-automation** — playout automation (playlist-driven,
  Auto/Hold, Next/Next-Live/Stop, cart/interrupt assets; no pipeline of
  its own)
- **omp-viewer** / **omp-multiviewer** — single-stream preview and
  auto-discovered multi-tile monitoring (with automatic low-res preview
  fan-out); as a role in a workflow the multiviewer shows only that
  workflow's sources
- **omp-ograf** — EBU OGraf graphics overlay node (Fill+Key)
- **omp-media-library** — file catalog with technical metadata
  (ffprobe) and mark-in/out segments
- **omp-recorder** — records an MXL source (video/audio) to a Matroska
  file, or to MXF (H.264 + 24-bit PCM) when the name ends in `.mxf`, with
  optional SMPTE ST 377-4/-41 MCA labels (`record.mcaPlan`); MXL-only
  input, no capture-card dependency
- **omp-device-hub** — detects the host's local video (V4L2) and audio
  (ALSA/USB) devices with a stable ID and capabilities; each device can be
  switched on to be offered as an MXL flow + NMOS sender (default off, the
  selection persists, a re-plugged device keeps its sender ID)
- **omp-scaler** — scales/converts a connected MXL video source to a
  fixed target format; also one of two nodes that can absorb a
  workflow's declared output-delay compensation (see Status)
- **omp-scope** — a passive measurement tap (taps a video and/or an
  audio flow, sends nothing itself): waveform/vectorscope, EBU R 128
  loudness with ITU-R BS.1770 true peak, held black/freeze/silence
  alarms, and **A/V timing derived from the MXL grain origin
  timestamps** — per-flow transport latency, delay variation, measured
  vs. nominal cadence, dropped-grain and reader-restart counters, and
  the resulting lip-sync offset judged against EBU R 37 (see below)
- **omp-2110-gateway** / **omp-aes67-gateway** — native ST 2110 video /
  AES67 audio gateways for inter-site contribution with foreign
  equipment; `omp-2110-gateway` also carries an independent ST 2110-30
  audio ingest/output path alongside its video (its own MXL flow, own
  NMOS sender/receiver), and both nodes expose AMWA NMOS IS-08 (Audio
  Channel Mapping) so an external controller can re-route/mute their
  channels live, not just view them
- **omp-srt-gateway** — ST 2110 ⇄ SRT gateway for contribution over
  lossy WANs
- **omp-webrtc-gateway** — WebRTC (WHIP/WHEP) bridge for ordinary phone
  cameras and phone/browser monitors to join the MXL fabric with zero
  install, catalog entries for both directions
  (`omp-webrtc-gateway-camera` ingest, `omp-webrtc-gateway-monitor`
  playout). Connecting is invitation-only by design (a phone's browser
  is by definition on the open internet-facing side): an operator
  issues time-scoped invitation links/QR codes from the node's own UI,
  and WHIP/WHEP requests without a valid, unexpired invitation token
  are rejected outright — there is no way to join by guessing or
  scanning the endpoint URL alone.
- **omp-fabrics-gateway** — **remote memory access between hosts**:
  MXL-native Fabrics (libfabric/RDMA) instead of a network-stack hop —
  zero-copy, one-sided RDMA writes of a full MXL flow into another
  host's domain. Implemented and live-verified over the software `tcp`
  provider (no RDMA hardware required to test); `verbs`/`efa` providers
  for real RoCEv2 hardware are a drop-in config change, hardware
  procurement pending.
- **omp-pipeline-controller** — embeds `PIPELINE CONTROLLER` (a
  separate, previously production-run broadcast playout system) as an
  OMP node: its full web UI and REST API run unmodified in the
  container, shown via `<iframe>` in the operate panel. Registers two
  NMOS senders (program video/audio) and two receivers for real MXL
  I/O in the DMF fabric — live sources wired in via IS-05 connect are
  added to PIPELINE CONTROLLER's own live-source list automatically.
  No native OMP play/stop/cue methods of its own — playlist,
  graphics, player, assets, voiceover, and record stay exclusively on
  PIPELINE CONTROLLER's own UI.

All components run as independent services and can be started,
stopped, or extended independently — either locally via the built-in
instance launcher, or on a separate machine via a lightweight host
agent that registers itself with the orchestrator and executes only
pre-approved node types (agent-local catalog as the trust boundary,
not a wide-open remote-exec channel). Third-party microservices can
also be imported as Podman containers straight from the GUI, subject
to an admission check against the same node contract every built-in
node has to satisfy.

**Reliability & operations**

- Centralized observability: every IS-05 connect/disconnect and every
  request through the generic node proxy carries a trace ID (returned
  as an `X-OMP-Trace-Id` response header, success and failure alike),
  logged into a single, Raft/JetStream-replicated log channel — no
  per-host log-scraping across a multi-host deployment. A "Diagnose"
  tab in the Flow Editor tails that log live (SSE, filterable by trace
  ID/node/level), turns a failed connection's toast into a one-click
  jump straight to its trace, and — on that same click — briefly
  highlights every graph tile touched by that trace, so an operator
  sees the blast radius of a failure, not just an error string.
- Automatic process restart with a crash-loop brake; a metrics
  endpoint; an operations view with running instances (CPU/RAM per
  process), host resource history, and collected alarms.
- Optional hot-standby for critical roles: a mirrored instance takes
  over on crash-loop exhaustion or host-offline detection
  (break-before-make handover, operator state carried across).
- A workflow can declare a target end-to-end latency budget — the
  orchestrator hard-rejects wiring that can't meet it and automatically
  compensates paths that are too short by assigning output delay to
  capable nodes.
- A placement engine (overload alarm + target-host suggestion,
  configurable per workflow role between purely advisory, a
  confirmation window with automatic execution on expiry, or immediate
  automatic execution) plus, since Kapitel 13, a manual guided move via
  drag in the flow editor for standalone nodes (see above); the
  equivalent for workflow roles exists in the orchestrator (reuses the
  same make-before-break protocol) but has no UI trigger yet — see
  "What OpenMediaPlatform does not do" below.
- Login-based user/role accounts (local, no external directory server
  required) gate who can wire the graph, launch instances, or
  administer hosts; every write access is captured in an audit log.
  Multi-organization access scoping sits on top: each user belongs to
  one organization, and workflows/process definitions/assets/
  collections carry an owner organization — a user only sees and can
  act on their own organization's objects (cross-organization access
  returns a plain not-found, not a permission error, so it doesn't even
  leak that the object exists). Node/instance infrastructure itself
  stays shared across organizations by design, same as the rest of the
  control plane — this is access scoping for a multi-team/multi-client
  install, not a hard per-tenant data silo.
- **Measurement you can act on, not just monitoring.** Every MXL read
  path already carries the origin timestamp the *writer* stamped onto a
  grain (`timestamp/x-mxl-tai`). `omp-scope` reads it and turns it into
  real numbers: transport latency (`mxlGetTime()` minus grain origin,
  both from the same clock), its peak-to-peak variation, measured
  against nominal cadence, dropped grains — and, across a video and an
  audio flow, the **lip-sync offset**, because the difference of the two
  latencies cancels the unknown clock offset and doesn't require the two
  flows to be sampled at the same instant. It is judged against EBU
  R 37 (sound may lead picture by at most 40 ms and lag by at most
  60 ms — deliberately asymmetric, because the standard is).

  This paid for itself on the first run. Pointed at a plain test
  source, it measured that this project's own MXL writers drifted
  against the MXL clock: video stamped its grains about four frames
  into the *future*, audio fell progressively behind. Both numbers were
  confirmed independently by MXL's own `mxl-info` tool (audio: scope
  +408 ms vs. `mxl-info` +406 ms). That was not a new bug — it was the
  first actual measurement of a simplification `MxlVideoOutput` had
  documented since day one ("index initialised once, incremented
  freely, no drift correction … a production source should switch to
  the PTS-based method *if drift is observed*"). Root-caused over the
  following two sessions to a one-way ratchet in the write-index
  calculation (a scheduling hiccup could push the index ahead of real
  time, but the guard only ever compared upward, so it could never fall
  back) and fixed by capping the ratchet and dropping a sample rather
  than ever moving the index backward (which would corrupt MXL's own
  ring buffer) — live-verified stable over a 96-second run afterward.
  Full trail: `docs/decisions.md` Nachtrag 226/236/237. Exactly the kind
  of latent defect a measuring device is supposed to catch before a
  standards-facing consumer would have been misled by it.

## What OpenMediaPlatform does **not** do

Being upfront about the current edges, not just the highlights:

- **No RDMA hardware verified.** MXL-native Fabrics is implemented and
  live-tested, but only over the software `tcp` libfabric provider;
  `verbs`/`efa` for real RoCEv2 NICs is a drop-in config change that
  hasn't been run against real hardware yet (procurement pending).
- **No NDI gateway, no proprietary Dante.** AES67 (which most Dante
  devices also speak) is supported via `omp-aes67-gateway`; native NDI
  and Dante's proprietary control protocol are not implemented.
- **Workflow-role migration has no drag-to-move UI yet.** The backend
  for moving a running workflow role to another host exists and is
  tested (`POST /api/v1/workflows/{id}/roles/{role}/migrate`), and the
  flow editor's host view now correctly places a running workflow's
  collapsed tile in the zone matching where its roles actually run
  (including a dedicated zone when roles are split across hosts) — but
  it's still one collapsed tile, so there's no individual-role tile to
  drag. Only standalone (non-workflow) node instances can be moved
  today via drag-and-drop; migrating a workflow role needs the API
  directly for now.
- **NMOS grouphint not yet meaningful for video/audio pairs.** OMP's
  own flow definitions use each flow's own ID as the NMOS grouphint
  group name, so a source's video and audio flows never share a group
  — which is exactly what that tag is for (a foreign controller can't
  currently use it to recognize them as a pair). (The MXL writer clock
  drift `omp-scope` originally found alongside this — see "What's in
  the box" above — has since been root-caused and fixed.)
- **No independent security audit.** Auth, mTLS, and audit logging
  exist and are exercised by the test suite, but there has been no
  external penetration test or formal security review.
- **Not production-hardened at broadcast scale.** This is a working
  proof of concept, developed and demonstrated on a single laptop-class
  machine (see below) — it has not been run in a real multi-day,
  multi-operator broadcast production, and there is no commercial
  support offering.
- **No mobile/tablet-optimized UI.** The web UI targets desktop
  operator positions and engineering workstations.
- **No external identity provider.** User accounts are local to the
  orchestrator; there is no SSO/LDAP/OIDC integration.

If any of these matter for your use case and you'd like to help close
the gap, contributions and issues are welcome.

## Status

Architecture/tech stack decided (see `ARCHITECTURE.md`); implementation
follows `UMSETZUNG.md`, whose status checklist is the authoritative,
continuously updated build log — every chapter/step, what changed, how
it was verified, and the date. This section is a snapshot of where
things stand, not a second copy of that history; most of what's listed
here is already described in full under "What's in the box" above, so
this stays short on purpose.

**Foundation & high availability** — Raft-clustered orchestrator (no
control-plane SPOF), clustered NATS, Patroni/etcd-HA PostgreSQL,
placement-aware I/O-port claims, mTLS orchestrator↔node, local user/
role model with audit log and multi-organization access scoping,
guided host- and cluster-onboarding wizards, hot-standby failover for
critical roles, a workflow latency budget with automatic delay
compensation.

**Flow editor & multi-host operation** — drag-and-drop canvas with
automatic host zones once more than one host is registered (live CPU/
RAM per zone, cross-host MXL connections flagged automatically), a
guided move for standalone node tiles between hosts, a scheduler for
time-driven workflow start/stop, a placement engine (overload alarm +
target-host suggestion, configurable advisory/confirm/automatic), a GUI
import path for third-party Podman-container microservices.

**Standards conformance** — see the table near the top of this file
for what's verified and how; in short, IS-04/IS-05 (both v1.1.x and
v1.2.0) run 62/62 in CI with zero accepted exceptions, IS-08 audio
channel mapping is live on every node with an independent audio path,
BCP-008-01/02 receiver/sender health status is live on every node with
a real network/hardware boundary, the NMOS Registry can run over
BCP-003-01 transport TLS, MXL flows use the standardized BCP-007-03
transport, and a real Blackmagic DeckLink SDI/IP card bridges to/from
MXL in both directions.

**Business process engine, asset catalog, ffmpeg assistant** — Kapitel
21 (definitions/versions/crash-recoverable executions, the full
BPMN-style step vocabulary, reliable domain-event triggers, a visual
step-graph editor, the asset/content domain model with collections,
typed relationships, and real S3/MinIO-backed storage) and Kapitel 22/
23 (the guided ffmpeg assistant described above, generalized into a
graphical audio matrix, timed overlays, lossless-capable concatenation,
generic multi-track output mapping, and a fully searchable/validated
expert mode) — both described in full under "What's in the box".

**Observability** — a trace ID follows every IS-05 connect/disconnect
and generic-proxy request end to end into one replicated log channel, a
"Diagnose" tab in the Flow Editor tails it live and pivots a failed
connection straight to its trace, highlighting every tile it touched.

**Measurement** — `omp-scope` is a timing instrument, not just a
picture/level scope: per-flow MXL transport latency, delay variation,
cadence/dropped-grain counters from the grain origin timestamps,
lip-sync scored against EBU R 37, held black/freeze/silence alarms,
EBU R 128 loudness with ITU-R BS.1770 true peak. Building it paid for
itself immediately — see "What's in the box" above for the real
clock-drift defect it found (and that has since been root-caused and
fixed).

**Fixed since first reported here:** the MXL writer clock drift above.
`docs/decisions.md` Nachtrag 226/236/237 has the full three-session
investigation trail, for anyone curious how "measured → root-caused →
fixed" actually looked in practice.

**Open** (see "What OpenMediaPlatform does not do" above for the full,
qualified list): RDMA hardware integration (`verbs`/EFA providers,
pending hardware procurement), an NDI gateway, proprietary Dante
(Dante in AES67 mode already runs via `omp-aes67-gateway`), a
drag-to-move UI for the already-built workflow-role migration backend,
the NMOS grouphint gap for video/audio pairs, and — within the ffmpeg
assistant — keyframe-exact lossless concatenation with per-clip
trimming (today's lossless mode covers whole, untrimmed clips; trimming
still means re-encoding).

## License

Apache License 2.0 — see [`LICENSE`](LICENSE). Vendored third-party
components under `third_party/` (MXL, libfabric) are never committed
to this repository (fetched at build time by `deploy/dev/install-mxl.sh`
and friends) and keep their own upstream licenses (both Apache-2.0/
BSD-or-GPLv2-compatible).

## Related project

For broadcast/GStreamer/playout experience, see `PIPELINE CONTROLLER`
(separate repo, see `CLAUDE.md` for details).
