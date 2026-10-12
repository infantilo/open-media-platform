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

## MXL and libfabric

Vendored under `third_party/` at build time by `deploy/dev/install-mxl.sh` (never committed); upstream licenses apply
(see the respective source trees).

## Container images, system packages

NATS, NMOS registry, etcd, PostgreSQL/Patroni, Caddy, step-ca, MinIO, GStreamer, FFmpeg, Podman and the other system
packages are pulled from their upstream sources (or shipped unmodified in the offline package) under their own licenses.
