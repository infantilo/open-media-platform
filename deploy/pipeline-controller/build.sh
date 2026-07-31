#!/usr/bin/env bash
# Baut das PIPELINE-CONTROLLER-Microservice-Image für OMP.
#
# PIPELINE CONTROLLER (/home/infantilo/PIPELINE CONTROLLER) ist ein eigenständiges
# Projekt (kein Code-/Git-Zusammenhang zu OMP, CLAUDE.md) — die echte Arbeitskopie
# dort bleibt unangetastet. Dieses Skript baut den Podman-Build-Context aus drei
# Quellen zusammen, ohne dort etwas zu schreiben:
#   1. Ein Snapshot des PC-Baums (ohne node_modules/.git/releases/media — releases
#      sind Build-Artefakte, media ist die Mediathek, für den ersten Ende-zu-Ende-
#      Test mit einer Live-Quelle nicht nötig).
#   2. Die additiven Patches aus patches/ (neuer mxl-Sink-Typ, s. UMSETZUNG.md).
#   3. OMPs bereits gebautes, versions-passendes gst-mxl-rs-Plugin
#      (third_party/mxl/rust/target/debug/libgstmxl.so) — bewusst NICHT PIPELINE
#      CONTROLLERs eigenes scripts/install-mxl.sh, um Versions-/ABI-Drift zwischen
#      zwei unabhängig gebauten libmxl-Kopien im selben Domain-Verbund zu vermeiden.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OMP_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PC_SRC="${PC_SRC:-/home/infantilo/PIPELINE CONTROLLER}"
MXL_PLUGIN="$OMP_ROOT/third_party/mxl/rust/target/debug/libgstmxl.so"
MXL_LIB_DIR="$OMP_ROOT/third_party/mxl/build/Linux-GCC-Release/lib"
ADAPTER_BIN="$OMP_ROOT/nodes/target/release/omp-pipeline-controller"
IMAGE_TAG="${IMAGE_TAG:-localhost/omp-pipeline-controller:latest}"

if [ ! -d "$PC_SRC" ]; then
  echo "PIPELINE CONTROLLER nicht gefunden unter: $PC_SRC" >&2
  exit 1
fi
if [ ! -f "$MXL_PLUGIN" ]; then
  echo "gst-mxl-rs-Plugin nicht gefunden: $MXL_PLUGIN" >&2
  echo "(third_party/mxl/rust: cargo build -p gst-mxl-rs, falls noch nicht gebaut)" >&2
  exit 1
fi
if [ ! -f "$ADAPTER_BIN" ]; then
  echo "Adapter-Binary nicht gefunden: $ADAPTER_BIN" >&2
  echo "(cd $OMP_ROOT/nodes && cargo build --release -p omp-pipeline-controller)" >&2
  exit 1
fi

STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

echo "== Snapshot PIPELINE CONTROLLER -> $STAGING/pc =="
mkdir -p "$STAGING/pc"
tar -C "$PC_SRC" \
  --exclude='node_modules' --exclude='.git' --exclude='releases' \
  --exclude='media' --exclude='recordings' --exclude='dead' \
  -cf - . | tar -C "$STAGING/pc" -xf -

echo "== Patches anwenden (Snapshot, nicht das echte PC-Repo) =="
for p in "$SCRIPT_DIR"/patches/*.diff; do
  echo "  - $(basename "$p")"
  (cd "$STAGING/pc" && patch -p1 < "$p")
done

echo "== gst-mxl-rs-Plugin + libmxl.so kopieren =="
mkdir -p "$STAGING/mxl-plugin"
cp "$MXL_PLUGIN" "$STAGING/mxl-plugin/"
# libmxl.so wird von gst-mxl-rs zur Laufzeit per dlopen("libmxl.so") aus dem
# Ld-Suchpfad geladen (third_party/mxl/rust/mxl/src/config.rs
# get_mxl_so_path — kein Build-Time-NEEDED-Eintrag, per readelf bestätigt),
# muss also mitkopiert werden (inkl. der beiden Versions-Symlinks).
cp -P "$MXL_LIB_DIR"/libmxl.so "$MXL_LIB_DIR"/libmxl.so.1 "$MXL_LIB_DIR"/libmxl.so.1.1 "$STAGING/mxl-plugin/"

echo "== Adapter-Binary kopieren =="
mkdir -p "$STAGING/adapter"
cp "$ADAPTER_BIN" "$STAGING/adapter/"

echo "== podman build =="
podman build -f "$SCRIPT_DIR/Containerfile" -t "$IMAGE_TAG" "$STAGING"
echo "Image gebaut: $IMAGE_TAG"
