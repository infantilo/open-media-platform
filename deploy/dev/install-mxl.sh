#!/usr/bin/env bash
# Baut die EBU/AMWA DMF "Media eXchange Layer" (libmxl, C++-Kern) aus den
# offiziellen Quellen: https://github.com/dmf-mxl/mxl
#
# WICHTIG (Korrektur ggü. einer früheren Annahme, siehe docs/decisions.md
# 2026-07-09 "MXL-GStreamer-Integration richtiggestellt"): MXL bietet
# **kein** installierbares GStreamer-Plugin mit mxlsrc/mxlsink-Elementen.
# `tools/mxl-gst/` enthält stattdessen drei eigenständige Kommandozeilen-
# programme (mxl-gst-testsrc, mxl-gst-sink, mxl-gst-looping-filesrc), die
# selbst appsink/appsrc + die MXL-C-API verwenden — nützlich hier nur als
# Verifikations-/Debug-Werkzeuge (siehe unten), nicht als Baustein für
# omp-mediaio. Die eigentliche Rust-Anbindung läuft über die im MXL-Repo
# mitgelieferten Crates `rust/mxl-sys` + `rust/mxl` (FlowWriter/FlowReader,
# GrainWriter/GrainReader) — Details: omp-mediaio/src/mxl.rs.
#
# Angelehnt an /home/infantilo/PIPELINE CONTROLLER/scripts/install-mxl.sh,
# auf einen festen Tag gepinnt statt einem bewegten Branch zu folgen.
#
# Version-Historie: v1.0.1 → v1.1.0-beta-1 (docs/decisions.md Nachtrag
# 42, 2026-07-19) — Kapitel 16 Teil 0 (MXL-native Fabrics/RDMA-Spike)
# fand heraus, dass v1.0.1s `lib/fabrics/ofi/src/fabrics.cpp` eine reine
# Stub-Implementierung ist (jede öffentliche C-API-Funktion liefert
# bedingungslos MXL_ERR_INTERNAL); v1.1.0-beta-1 ist der nächste Tag
# und hat eine echte Implementierung. Kein isolierter Fabrics-Fix,
# sondern ein projektweiter Kern-Upgrade — vor der Übernahme per echtem
# Rust-Workspace-Rebuild + Live-Regressionstest (omp-source schreibt
# einen echten Flow, mxl-info bestätigt) gegen die bestehenden
# MXL-Pfade abgesichert, nicht nur den neuen Fabrics-Pfad.
#
# OMP-eigene Patches (deploy/dev/mxl-patches/, docs/decisions.md
# Nachtrag 116): third_party/mxl ist komplett gitignored — ein
# `git checkout $MXL_VERSION` (unten) auf einen bewegten/neuen Tag
# würde lokale Fixes im vendorten Baum sonst stillschweigend
# zurücksetzen. Deshalb werden hier per `git apply` echte, gegen den
# Original-Tag erzeugte Patches angewendet (gleiches Muster wie
# deploy/pipeline-controller/patches/*.diff für PIPELINE CONTROLLER),
# statt die Fixes nur lokal unversioniert im Checkout zu belassen.
set -euo pipefail

MXL_VERSION="v1.1.0-beta-1"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MXL_SRC_DIR="${MXL_SRC_DIR:-$ROOT_DIR/third_party/mxl}"
MXL_PRESET="${MXL_PRESET:-Linux-GCC-Release}"
MXL_DOMAIN="${MXL_DOMAIN:-/dev/shm/omp-mxl}"
VCPKG_ROOT="${VCPKG_ROOT:-$HOME/vcpkg}"

echo "== System-Pakete (cmake, ninja, bison/flex fürs vcpkg-Paket libpcap, libclang fürs Rust-mxl-sys-bindgen, ...) =="
if ! command -v cmake >/dev/null || ! command -v bison >/dev/null || ! command -v clang >/dev/null; then
  sudo apt-get update -y
  sudo apt-get install -y cmake build-essential pkg-config curl git ninja-build bison flex libclang-dev clang
fi

if ! command -v cargo >/dev/null; then
  echo "== Rust-Toolchain (rustup) =="
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"
fi

echo "== vcpkg (CMake-Preset erwartet \$HOME/vcpkg) =="
if [ ! -x "$VCPKG_ROOT/vcpkg" ]; then
  git clone https://github.com/microsoft/vcpkg "$VCPKG_ROOT"
  "$VCPKG_ROOT/bootstrap-vcpkg.sh" --disableMetrics
fi

echo "== Clone dmf-mxl/mxl @ $MXL_VERSION =="
if [ -d "$MXL_SRC_DIR/.git" ]; then
  # Bereits gepatchter Checkout + gleiche Version: nicht anfassen — ein
  # `checkout` auf denselben Stand ist harmlos, ein erneutes Anwenden der
  # Patches unten ist trotzdem idempotent abgesichert (git apply --check),
  # aber ein `fetch`/`checkout` bei jedem Lauf ist unnötiger Netzwerk-/
  # Arbeitsaufwand für den Normalfall "läuft schon".
  current_ref="$(git -C "$MXL_SRC_DIR" describe --tags --exact-match 2>/dev/null || true)"
  if [ "$current_ref" != "$MXL_VERSION" ]; then
    git -C "$MXL_SRC_DIR" fetch --depth 1 origin "tag" "$MXL_VERSION"
    git -C "$MXL_SRC_DIR" checkout "$MXL_VERSION"
  fi
else
  mkdir -p "$(dirname "$MXL_SRC_DIR")"
  git clone --depth 1 --branch "$MXL_VERSION" https://github.com/dmf-mxl/mxl "$MXL_SRC_DIR"
fi

echo "== OMP-eigene Patches anwenden (deploy/dev/mxl-patches/) =="
MXL_PATCHES_DIR="$ROOT_DIR/deploy/dev/mxl-patches"
if [ -d "$MXL_PATCHES_DIR" ]; then
  for p in "$MXL_PATCHES_DIR"/*.diff; do
    [ -e "$p" ] || continue
    if git -C "$MXL_SRC_DIR" apply --check --reverse "$p" 2>/dev/null; then
      echo "  - $(basename "$p") (bereits angewendet, übersprungen)"
    elif git -C "$MXL_SRC_DIR" apply --check "$p" 2>/dev/null; then
      echo "  - $(basename "$p")"
      git -C "$MXL_SRC_DIR" apply "$p"
    else
      echo "  ! $(basename "$p") passt nicht mehr auf $MXL_VERSION — von Hand prüfen (docs/decisions.md Nachtrag 116)." >&2
      exit 1
    fi
  done
fi

echo "== Build libmxl + Tools (CMake Preset: $MXL_PRESET) =="
cd "$MXL_SRC_DIR"
cmake --preset "$MXL_PRESET"
cmake --build "build/$MXL_PRESET" --parallel "$(nproc)"
MXL_BUILD_DIR="$MXL_SRC_DIR/build/$MXL_PRESET"

mkdir -p "$ROOT_DIR/deploy/dev"
cat > "$ROOT_DIR/deploy/dev/mxl.env" <<EOF
# Auto-generiert von deploy/dev/install-mxl.sh.
# Vor jedem MXL-nutzenden Node/Tool sourcen (setzt LD_LIBRARY_PATH für
# libmxl.so, das omp-mediaios mxl-Modul zur Laufzeit per libloading lädt).
# lib/fabrics/ofi zusätzlich (Kapitel 16 Teil 1, docs/decisions.md
# Nachtrag 44): libmxl-fabrics.so ist ein eigenes CMake-Target
# (lib/fabrics/ofi/CMakeLists.txt), nicht Teil von libmxl.so, und liegt
# in einem eigenen Unterverzeichnis — live entdeckt, als omp-mediaios
# fabrics-Feature das Symbol sonst nicht fand.
export OMP_MXL_DOMAIN="$MXL_DOMAIN"
export LD_LIBRARY_PATH="$MXL_BUILD_DIR/lib:$MXL_BUILD_DIR/lib/fabrics/ofi:\${LD_LIBRARY_PATH:-}"
export MXL_INFO_BIN="$MXL_BUILD_DIR/tools/mxl-info/mxl-info"
export MXL_GST_TESTSRC_BIN="$MXL_BUILD_DIR/tools/mxl-gst/mxl-gst-testsrc"
export MXL_GST_SINK_BIN="$MXL_BUILD_DIR/tools/mxl-gst/mxl-gst-sink"
EOF

mkdir -p "$MXL_DOMAIN"

echo "== Verifikation =="
# shellcheck disable=SC1090
source "$ROOT_DIR/deploy/dev/mxl.env"
"$MXL_INFO_BIN" -d "$MXL_DOMAIN" -l || echo "(Domain '$MXL_DOMAIN' noch leer — ok beim ersten Lauf)"

echo
echo "Fertig. Vor jedem MXL-Node: 'source deploy/dev/mxl.env'."
echo "Test-Feed erzeugen (Debug/Verifikation, nicht Teil von omp-source):"
echo "  \$MXL_GST_TESTSRC_BIN -d \$OMP_MXL_DOMAIN -v $MXL_SRC_DIR/lib/tests/data/v210_flow.json -p smpte"
