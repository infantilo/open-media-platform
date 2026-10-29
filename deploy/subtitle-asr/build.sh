#!/bin/sh
# Baut das Image localhost/omp-subtitle-asr:<Version> mit Node, Engine und den Modellen aus data/asr-engine/models
# (vorher: `make nodes` bzw. `cargo build --release -p omp-subtitle-asr` und `sh tools/asr-engine/install.sh [Modelle]`).
#
#   sh deploy/subtitle-asr/build.sh            Version aus `git describe`
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
VERSION="${VERSION:-$(git describe --tags --always 2>/dev/null || echo dev)}"
NODE="nodes/target/release/omp-subtitle-asr"
MXL="third_party/mxl/build/Linux-GCC-Release/lib"
ENGINE="${OMP_ASR_HOME:-data/asr-engine}"
for f in "$NODE" "$MXL/libmxl.so.1.1" "$ENGINE/bin/whisper-server"; do [ -e "$f" ] || { echo "fehlt: $f" >&2; exit 1; }; done
ls "$ENGINE"/models/ggml-*.bin >/dev/null 2>&1 || { echo "kein Modell in $ENGINE/models — sh tools/asr-engine/install.sh" >&2; exit 1; }

CTX="deploy/subtitle-asr/ctx"; rm -rf "$CTX"; mkdir -p "$CTX/node" "$CTX/mxl" "$CTX/engine"
cp "$NODE" "$CTX/node/"
cp -a "$MXL"/libmxl.so* "$CTX/mxl/"
cp -a "$ENGINE/bin" "$ENGINE/models" "$CTX/engine/"
rm -f "$CTX"/engine/bin/libparakeet* "$CTX"/engine/bin/*.part 2>/dev/null || true
podman build -f deploy/subtitle-asr/Containerfile --build-arg VERSION="$VERSION" \
  -t "localhost/omp-subtitle-asr:$VERSION" "$CTX"
rm -rf "$CTX"
echo "Image: localhost/omp-subtitle-asr:$VERSION ($(podman image inspect --format '{{.Size}}' "localhost/omp-subtitle-asr:$VERSION" | awk '{printf "%.0f MB", $1/1048576}'))"
echo "Importieren: sh deploy/subtitle-asr/import.sh"
