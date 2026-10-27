---
name: omp-node-builder
description: Builds a new OpenMediaPlatform (OMP) node or microservice with AI, either as a native Rust crate on omp-node-sdk or as a container in any language, and proves it against the node contract check. Use when asked to create, port or debug an OMP node, an IS-04-registered broadcast microservice, or a media service that exposes /descriptor.json.
version: 1.0.0
author: infantilo
tags: [broadcast, nmos, is-04, mxl, rust, microservice, gstreamer]
license: MIT
compatibility: Needs a checkout of the OpenMediaPlatform repository (docs/NODE-TUTORIAL.md, ARCHITECTURE.md), Rust/cargo for path 1, Go for the contract checker, Podman for path 2.
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
argument-hint: "<purpose in one sentence> [rust|container]"
---

# OMP node builder

Build one node that passes the contract check. Do not guess the contract: the repository is the specification.

## 1. Read the specification first
Read `docs/NODE-TUTORIAL.md` and `ARCHITECTURE.md` section 5 in the repository. If either is missing, stop and ask for the checkout. Details are in `references/node-contract.md`.

## 2. Collect the order (ask only what is missing)
1. Purpose in one sentence.
2. Media I/O (reads or writes video/audio via MXL/ST 2110) or pure control-plane node.
3. Parameters (name, type, unit, range, read-only) and methods (name, arguments). Never invent them.
4. Closest existing reference node: `omp-scaler` (reads, changes, writes), `omp-viewer` (reads only), `omp-player` (internal state machine), `omp-source`, `omp-ograf` (own UI bundle).
5. Own UI needed? Otherwise the generic parameter panel is enough.
6. Path 1 (Rust crate in `nodes/`) or path 2 (container, any language).

## 3. Build
- Path 1: new crate under `nodes/<name>`, edition 2024, `omp-node-sdk = { path = "../omp-node-sdk" }`. Implement `ParamStore` (`descriptor/get/set/invoke`), start with `omp_node_sdk::run(NodeConfig{..}, store)`. `descriptor()`, `get()` and `set()` must agree exactly. Add the node to `deploy/catalog.json` (read at orchestrator start only).
- Path 2: any language. Register at `OMP_REGISTRY_URL` (IS-04), serve `GET /descriptor.json`, `PATCH /params/<name>`, `POST /methods/<name>`, read `OMP_INSTANCE_ID`, `OMP_LABEL`, `OMP_PORT`, `OMP_REGISTRY_URL`, `OMP_NATS_URL`. Import with `POST /api/v1/catalog` and `runner: "podman"`.
- Copy the structure of the named reference node instead of inventing one.

## 4. Make it diagnosable (path 1)
See `references/diagnostics.md`: honest `media_ready`, rate KPIs, pipeline snapshot, error codes. A node that cannot say why it is silent is not finished.

## 5. Verify, never claim
Start the node, then run `make contract NODE_URL=http://localhost:<port>` from the repository root. Report the real output. No PASS means not done. For UI bundles run `node --check ui/bundle.js` and rebuild (`include_str!` embeds it at compile time). Keep test instances few and short-lived.

## Rules
- No vendor or product names in docs or labels.
- UI texts in German and English; use `--omp-*` CSS variables; no `alert/confirm/prompt`.
- Document the new node in the user manual and the catalog description.
