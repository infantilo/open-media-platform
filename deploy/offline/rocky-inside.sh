#!/usr/bin/env bash
# LÄUFT IM WEGWERF-CONTAINER (Rocky Linux 9 oder 10), gestartet von make-rocky-bundle.sh — nicht von Hand ausführen.
# Baut OMP gegen die Rocky-Bibliotheken (Rocky-glibc und -GStreamer) und erzeugt das Offline-Paket.
# Eingänge (read-only): /in/repo (Quellen, git), /in/ui-dist (gebautes UI), /in/images (save-images.sh-Ausgabe)
# Ausgang: /out  Arbeitsplatz: /work (benanntes Volume, vom Host danach gelöscht)
set -euo pipefail
J="${OMP_BUILD_JOBS:-2}"
say() { printf '\n\033[1m==> [rocky] %s\033[0m\n' "$*"; }
RPMFUSION="${OMP_RPMFUSION:-0}"

say "Rocky: Entwicklungspakete (BaseOS/AppStream + CRB + EPEL)"
dnf -y -q install epel-release dnf-plugins-core
dnf config-manager --set-enabled crb
if [ "$RPMFUSION" = 1 ]; then
  dnf -y -q install "https://mirrors.rpmfusion.org/free/el/rpmfusion-free-release-$(rpm -E %rhel).noarch.rpm"
fi
dnf -y -q install --setopt=install_weak_deps=False \
  gcc gcc-c++ make pkgconf-pkg-config cmake ninja-build bison flex clang clang-devel git curl zip unzip tar xz findutils which \
  openssl-devel zlib-devel createrepo_c rpm-sign \
  gstreamer1-devel gstreamer1-plugins-base-devel gstreamer1-plugins-bad-free-devel libnice-devel glib2-devel \
  python3 zstd
# alle Repository-Schlüssel importieren: make-offline-bundle.sh prüft damit die Signatur jedes geladenen RPMs
rpm --import /etc/pki/rpm-gpg/RPM-GPG-KEY-* 2>/dev/null || true

export HOME=/work; mkdir -p /work; cd /work
export CARGO_HOME=/work/cargo RUSTUP_HOME=/work/rustup
if ! command -v cargo >/dev/null; then
  say "Rust-Toolchain (rustup)"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
fi
export PATH="$CARGO_HOME/bin:/work/go/bin:$PATH"
GOVER="$(sed -n 's/^go \([0-9.]*\).*/\1/p' /in/repo/orchestrator/go.mod | head -1)"
if [ ! -x /work/go/bin/go ]; then
  say "Go $GOVER"
  curl -fsSL "https://go.dev/dl/go${GOVER}.linux-amd64.tar.gz" | tar -C /work -xzf -
fi

say "Quellen nach /work/src (Repo-Stand inkl. ungetrackter Dateien, ohne Build-Ausgaben)"
git config --global --add safe.directory /in/repo
mkdir -p /work/src
(cd /in/repo && git ls-files -z --cached --others --exclude-standard | tar --null -T - -cf -) | tar -C /work/src -xf -
cp -a /in/repo/.git /work/src/.git
mkdir -p /work/src/ui && cp -a /in/ui-dist /work/src/ui/dist
cd /work/src

say "MXL (libmxl) bauen — portables CPU-Ziel x86-64-v2"
export VCPKG_ROOT=/work/vcpkg MXL_TARGET_ARCH=x86-64-v2 MXL_BUILD_JOBS="$J"
nice -n 19 bash deploy/dev/install-mxl.sh

say "Go-Binaren"
[ ! -d /in/gomod ] || export GOPROXY="file:///in/gomod,https://proxy.golang.org,direct"
mkdir -p bin
# Modul-Downloads mit Wiederholung (kurze Netzabbrüche kippen sonst den stundenlangen Lauf)
for d in orchestrator supervisor host-agent; do
  for t in 1 2 3 4 5; do (cd "$d" && go mod download) && break || { echo "go mod download ($d) Versuch $t fehlgeschlagen"; sleep 10; }; done
done
(cd orchestrator && nice -n 19 go build -o ../bin/omp-orchestrator .)
(cd supervisor && nice -n 19 go build -o ../bin/omp-supervisor .)
(cd host-agent && nice -n 19 go build -o ../bin/omp-host-agent .)

say "Rust-/Go-Nodes (make nodes; ohne Debug-Info und ohne inkrementelle Zwischenstände: spart Platz)"
export CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS="$J"
# deploy/dev/mxl.env liefert LD_LIBRARY_PATH für die Build-Schritte, die libmxl brauchen
# shellcheck disable=SC1091
. deploy/dev/mxl.env
# Das Paket braucht ALLE Binaries als Release (make nodes baut die Nicht-Medien-Nodes nur als Debug): ganzer Workspace in einem Lauf
(cd nodes && nice -n 19 cargo build --release --workspace --bins)
mkdir -p nodes/target/release
(cd nodes/omp-vfa && nice -n 19 go build -o ../target/release/omp-vfa .)
(cd nodes/omp-vfa-vision && nice -n 19 go build -o ../target/release/omp-vfa-vision .)

say "Offline-Paket"
OMP_COMMIT="$(git -C /in/repo rev-parse --short HEAD)"; export OMP_COMMIT
[ -z "$(git -C /in/repo status --porcelain --untracked-files=no)" ] || export OMP_DIRTY=-dirty
args=(--skip-build --images-dir /in/images --out /out --no-plugin)
[ "$RPMFUSION" != 1 ] || args+=(--with-rpmfusion)
nice -n 19 bash deploy/offline/make-offline-bundle.sh "${args[@]}"
