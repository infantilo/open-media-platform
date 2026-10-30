# Third-party notices

OpenMediaPlatform itself is licensed under the Apache License 2.0 (`LICENSE`). The components below are **not part
of this repository's source**; they are fetched at install/build time or loaded at run time and keep their own licenses.

## avvideofilter (optional GStreamer plugin)

| | |
|---|---|
| What | GStreamer element `avvideofilter`: applies a libavfilter graph (here: FFmpeg's `framerate` filter) — used for the frame-rate conversion mode **blend** (`OMP_FRAMERATE_CONVERSION=blend`, currently in `omp-scaler`) |
| Author | **emcodem** — <https://github.com/emcodem/avvideofilter> |
| License | LGPL-2.1-or-later (plugin and the bundled FFmpeg); license texts ship inside the release archive (`COPYING`, `avvideofilter-ffmpeg/`) and are installed with it |
| Version used | pinned in `deploy/dev/avvideofilter.version` (release archive, SHA256-verified by `deploy/dev/install-avvideofilter.sh`) |
| How it is used | Not linked into OMP. Loaded at run time through GStreamer if present; without it OMP falls back to `videorate`. Installed by `./install.sh --media`, by `deploy/dev/install-avvideofilter.sh`, or from the offline package (`docs/OFFLINE-INSTALLATION.md`) |
| Credit | The plugin, its FFmpeg integration and the first integration into PIPELINE CONTROLLER (pipeline-controller issue #2) are emcodem's work; OMP reuses the plugin and the idea of the optional, fall-back-safe `blend` mode |

## Pigo (face detection in `omp-vfa-vision`)

| | |
|---|---|
| Project | [github.com/esimov/pigo](https://github.com/esimov/pigo) (Endre Simo), MIT License |
| Use | Pure-Go Pico cascade classifier (library) and the pre-trained `facefinder` cascade, embedded in the binary (`nodes/omp-vfa-vision/cascade/facefinder`); the test image `testdata/sample.jpg` is the library's own sample |

## MXL and libfabric

Vendored under `third_party/` at build time by `deploy/dev/install-mxl.sh` (never committed); upstream licenses apply
(see the respective source trees).

## Speech recognition in `omp-subtitle-asr` (whisper.cpp and Whisper models)

| | |
|---|---|
| Engine | **whisper.cpp** / ggml — <https://github.com/ggml-org/whisper.cpp>, Copyright (c) 2023-2026 The ggml authors, MIT License |
| Models | **Whisper** model weights (`ggml-small.bin`, `ggml-base.bin`, converted for whisper.cpp) — <https://github.com/openai/whisper>, Copyright (c) 2022 OpenAI, released under the MIT License (code and model weights) |
| How it is used | The engine runs as a separate process (`whisper-server`) inside the node and is reached over local HTTP; it is not linked into OMP. Engine binary, libraries and models are fetched at build time by `tools/asr-engine/install.sh` (never committed) and shipped inside the node's container image |
| Obligation | MIT requires the copyright and permission notice to accompany copies: the image carries both license texts under `/usr/share/licenses/omp-subtitle-asr/` (source: `deploy/subtitle-asr/licenses/`) |
| Note | "Whisper" and "OpenAI" are names of the model's authors; OMP uses no logo and implies no endorsement |

## Capture hardware, network cards and their vendor software (chapter 76)

OMP **contains, links and ships none of the software below**. Every item is installed by the operator from the vendor,
under the operator's own agreement with the vendor, and is only reached at run time through GStreamer plugins that are
discovered on the host (`gst-inspect`) or through files the operator provides. Without them OMP falls back to its
standard path or stops the affected instance with a clear message.

| Product | Relationship | Operator's obligation |
|---|---|---|
| **Intel Media Transport Library** (`mtl_st20p_tx/rx`) | open-source plugin (BSD-3-Clause upstream), not included | install it yourself; keep upstream's licence notices with any copy you distribute |
| **AJA** NTV2 / GStreamer `aja` plugin | vendor SDK and plugin, not included | install from the vendor; follow the vendor's licence |
| **Matrox** SDK | proprietary SDK, not included; OMP has no Matrox code and no Matrox plugin — a plugin built by the operator on the Matrox SDK can be attached via `OMP_CARD_ELEMENTS` | the operator's SDK agreement governs building and using such a plugin |
| **Magewell** Pro Capture / USB Capture drivers, **Elgato** Cam Link | vendor drivers expose standard V4L2/ALSA; OMP uses only those kernel interfaces | install the vendor driver under its licence |
| **NVIDIA Mellanox / Intel** network cards | detected from `/sys` (driver name, link, PTP clock); no vendor code | none |

Product and company names (AJA, Elgato, Intel, Magewell, Matrox, Mellanox, NVIDIA, Blackmagic Design,
DeckLink) are trademarks of their respective owners. They are used only to say which hardware OMP can work with
(nominative use); OMP is not affiliated with, endorsed by or certified by any of them, and the interoperability
statements in the documentation are not vendor certifications. Hardware-dependent paths are marked "not verified on
hardware" until they have been run on the real device.

This file is a technical inventory, not legal advice. Before commercial distribution, have the vendor agreements
reviewed by counsel.

## Container images, system packages

NATS, NMOS registry, etcd, PostgreSQL/Patroni, Caddy, step-ca, SeaweedFS (S3), GStreamer, FFmpeg, Podman and the other system
packages are pulled from their upstream sources (or shipped unmodified in the offline package) under their own licenses.
