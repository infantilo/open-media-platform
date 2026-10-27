# Node contract (summary, authoritative: ARCHITECTURE.md section 5)

1. Register with the IS-04 registry (node, device, senders, receivers).
2. Self-description: `GET /descriptor.json` (parameters, methods), `PATCH /params/<name>`, `POST /methods/<name>`.
3. Optional UI: `/ui/manifest.json` and `/ui/bundle.js` as a custom element.
4. Media I/O only via MXL (local, zero copy) or ST 2110. SDK: `omp_mediaio::mxl::{MxlVideoOutput, MxlAudioOutput}`, `SenderSpec{transport: Some(TRANSPORT_MXL), flow: Some(FlowSpec::Video{..})}`.
5. Independent process, restartable on its own. Environment: `OMP_INSTANCE_ID`, `OMP_LABEL`, `OMP_PORT`, `OMP_REGISTRY_URL`, `OMP_NATS_URL`.
6. `media_ready` reports whether media actually flows.

Latency: declare `latency` in the descriptor; honour `setOutputDelay`.
Acceptance: `make contract NODE_URL=...` (tools/contract-check); the GUI import runs the same check.
