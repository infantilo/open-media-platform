#!/usr/bin/env bash
# Baut die EBU/AMWA DMF "Media eXchange Layer" (libmxl, C++-Kern) aus den
# offiziellen Quellen: https://github.com/dmf-mxl/mxl
#
# WICHTIG (Korrektur ggü. einer früheren Annahme, siehe docs/decisions.md
# 2026-07-09 "MXL-GStreamer-Integration richtiggestellt"): MXL v1.0.1 bietet
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
# aber auf Tag v1.0.1 gepinnt statt einem bewegten Branch zu folgen.
set -euo pipefail

MXL_VERSION="v1.0.1"

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
  git -C "$MXL_SRC_DIR" fetch --depth 1 origin "tag" "$MXL_VERSION"
  git -C "$MXL_SRC_DIR" checkout "$MXL_VERSION"
else
  mkdir -p "$(dirname "$MXL_SRC_DIR")"
  git clone --depth 1 --branch "$MXL_VERSION" https://github.com/dmf-mxl/mxl "$MXL_SRC_DIR"
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
export OMP_MXL_DOMAIN="$MXL_DOMAIN"
export LD_LIBRARY_PATH="$MXL_BUILD_DIR/lib:\${LD_LIBRARY_PATH:-}"
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
