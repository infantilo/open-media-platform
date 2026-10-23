#!/usr/bin/env bash
# OpenMediaPlatform — one-command installation (Debian/Ubuntu, Fedora, Arch, openSUSE).
#
#   ./install.sh               base system: orchestrator, GUI, NATS, registry, Postgres
#   ./install.sh --media       additionally media nodes (Rust, GStreamer, MXL) — for real video/audio
#   ./install.sh --media --start   start right afterwards
#   ./install.sh --dry-run     only show what would be done
#   ./install.sh --yes         no confirmation prompts
#   ./install.sh --media --avvideofilter-archive DATEI   plugin for blend frame-rate conversion from a file (no internet)
#   ./install.sh --media --no-avvideofilter              do not install the plugin (nodes use videorate)
#   ./install.sh --systemd     start OMP automatically at boot (systemd service "omp", main machine)
#   ./install.sh --streamdeck-udev   install the udev rule for the Stream Deck (WebHID in the browser) — belongs on the
#                              operator workstation the device is plugged into (docs/BENUTZERHANDBUCH.md §10g)
#   ./install.sh --host-agent-service --orchestrator <IP> [--label NAME] [--token TOKEN]
#                              connect this machine as an additional host (service "omp-host-agent")
#
# What the script does (and only that):
#   1. install system packages via the package manager (needs sudo; asks first)
#   2. install Go, Deno (and with --media: Rust) if missing/too old — into $HOME, without sudo
#   3. with --media: build the MXL library (deploy/dev/install-mxl.sh) and the media nodes (make nodes);
#      plus, optionally, the GStreamer plugin avvideofilter (pinned, SHA256-verified; --no-avvideofilter skips it)
#   4. run make preflight
# It opens NO firewall ports and changes no system configuration besides the packages.
# Can be run repeatedly: anything already present is skipped.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MEDIA=0; START=0; DRY=0; YES=0; SYSTEMD=0; STREAMDECK=0; AGENT_SVC=0; ORCH_IP=""; AGENT_LABEL=""; AGENT_TOKEN=""; AVF=1; AVF_ARCHIVE=""
while [ $# -gt 0 ]; do
  a="$1"; shift
  case "$a" in
    --systemd) SYSTEMD=1 ;;
    --streamdeck-udev) STREAMDECK=1 ;;
    --host-agent-service) AGENT_SVC=1 ;;
    --orchestrator) ORCH_IP="${1:-}"; shift || true ;;
    --label) AGENT_LABEL="${1:-}"; shift || true ;;
    --token) AGENT_TOKEN="${1:-}"; shift || true ;;
    --media) MEDIA=1 ;;
    --no-avvideofilter) AVF=0 ;;
    --avvideofilter-archive) AVF_ARCHIVE="${1:-}"; shift || true ;;
    --start) START=1 ;;
    --dry-run) DRY=1 ;;
    --yes|-y) YES=1 ;;
    -h|--help) sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $a (see --help)" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
run()  { if [ "$DRY" = 1 ]; then echo "    [dry-run] $*"; else eval "$*"; fi; }
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(uname -s)" = "Linux" ] || { echo "Only Linux is supported." >&2; exit 1; }
[ "$(id -u)" != "0" ] || { echo "Please do NOT run as root (Podman runs rootless, build as a normal user). sudo is used by the script itself when needed." >&2; exit 1; }

# ---- Package manager ----------------------------------------------------------
if   have apt-get; then PM=apt
elif have dnf;     then PM=dnf
elif have pacman;  then PM=pacman
elif have zypper;  then PM=zypper
else echo "No supported package manager (apt/dnf/pacman/zypper). See docs/INSTALLATION.md, section \"Manual\"." >&2; exit 1; fi

BASE_PKGS_apt="podman make curl openssl git ca-certificates zip unzip tar iproute2 uidmap slirp4netns"
BASE_PKGS_dnf="podman make curl openssl git ca-certificates zip unzip tar iproute shadow-utils"
BASE_PKGS_pacman="podman make curl openssl git ca-certificates zip unzip tar iproute2"
BASE_PKGS_zypper="podman make curl openssl git ca-certificates zip unzip tar iproute2"

MEDIA_PKGS_apt="build-essential pkg-config cmake ninja-build bison flex clang libclang-dev ffmpeg libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev libgstreamer-plugins-bad1.0-dev gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-libav gstreamer1.0-tools gstreamer1.0-nice libnice-dev"
MEDIA_PKGS_dnf="gcc gcc-c++ pkgconf-pkg-config cmake ninja-build bison flex clang clang-devel ffmpeg-free gstreamer1-devel gstreamer1-plugins-base-devel gstreamer1-plugins-bad-free-devel gstreamer1-plugins-base gstreamer1-plugins-good gstreamer1-plugins-bad-free gstreamer1-plugins-ugly-free libnice-devel libnice-gstreamer1"
MEDIA_PKGS_pacman="base-devel pkgconf cmake ninja bison flex clang ffmpeg gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugins-ugly libnice"
MEDIA_PKGS_zypper="gcc gcc-c++ pkg-config cmake ninja bison flex clang libclang-devel ffmpeg gstreamer-devel gstreamer-plugins-base-devel gstreamer-plugins-bad-devel gstreamer-plugins-good gstreamer-plugins-bad gstreamer-plugins-ugly"

pkgs_var="BASE_PKGS_$PM"; PKGS="${!pkgs_var}"
if [ "$MEDIA" = 1 ]; then m="MEDIA_PKGS_$PM"; PKGS="$PKGS ${!m}"; fi

# ---- Pre-check: disk space and RAM --------------------------------------------
free_gb=$(( $(df -Pk "$ROOT_DIR" | awk 'NR==2 {print $4}') / 1024 / 1024 ))
mem_gb=$(( $(awk '/^MemTotal:/ {print $2}' /proc/meminfo) / 1024 / 1024 ))
NEED_GB=5; [ "$MEDIA" = 1 ] && NEED_GB=25
if [ "$free_gb" -lt "$NEED_GB" ]; then
  echo "Warning: only ${free_gb} GB free in $ROOT_DIR — at least ${NEED_GB} GB recommended." >&2
  [ "$YES" = 1 ] || { read -r -p "Continue anyway? [y/N] " a; case "${a:-N}" in y|Y) ;; *) exit 1 ;; esac; }
fi
if [ "$MEDIA" = 1 ] && [ "$mem_gb" -lt 6 ]; then
  echo "Warning: only ${mem_gb} GB RAM — the Rust/MXL build can fail with less than ~8 GB (create swap if needed)." >&2
  [ "$YES" = 1 ] || { read -r -p "Continue anyway? [y/N] " a; case "${a:-N}" in y|Y) ;; *) exit 1 ;; esac; }
fi

say "1/4 System packages ($PM)"
echo "    $PKGS"
if [ "$YES" != 1 ] && [ "$DRY" != 1 ]; then
  read -r -p "    Install these packages now with sudo? [Y/n] " ans
  case "${ans:-Y}" in n|N) echo "Aborted."; exit 1 ;; esac
fi
case "$PM" in
  apt)    run "sudo apt-get update -y && sudo apt-get install -y $PKGS" ;;
  dnf)    run "sudo dnf install -y $PKGS" ;;
  pacman) run "sudo pacman -S --needed --noconfirm $PKGS" ;;
  zypper) run "sudo zypper --non-interactive install $PKGS" ;;
esac

hash -r   # find freshly installed programs (git, zip, ...) immediately
for t in git zip unzip tar curl; do
  [ "$DRY" = 1 ] || have "$t" || { echo "Error: '$t' is missing after the package installation — check the package installation output above." >&2; exit 1; }
done

# rootless Podman needs subuid/subgid
if ! grep -q "^$(id -un):" /etc/subuid 2>/dev/null; then
  say "Creating subuid/subgid for $(id -un) (rootless Podman)"
  run "sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $(id -un) && podman system migrate"
fi

# ---- Go / Deno / Rust ---------------------------------------------------------
say "2/4 Go, Deno$([ "$MEDIA" = 1 ] && echo ", Rust")"
GO_NEED="$(awk '/^go [0-9]/ {print $2; exit}' "$ROOT_DIR/orchestrator/go.mod")"
vge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }
export PATH="/usr/local/go/bin:$HOME/.deno/bin:$HOME/.cargo/bin:$PATH"
# Ask inside orchestrator/: go.mod/GOTOOLCHAIN apply there, so an already downloaded toolchain counts.
go_have=""; have go && go_have="$(cd "$ROOT_DIR/orchestrator" && go env GOVERSION | sed 's/^go//')"
go_sys=""; have go && go_sys="$(go env GOVERSION | sed 's/^go//')"
if [ -n "$go_have" ] && ! vge "$go_have" "$GO_NEED" && vge "$go_sys" "1.21" && [ "${GOTOOLCHAIN:-auto}" != "local" ]; then
  # Go >= 1.21 fetches the toolchain required by go.mod itself on the first build (internet access needed) —
  # no need to replace the system Go.
  echo "    Go $go_have present; the matching toolchain $GO_NEED is downloaded automatically on the first build"
elif [ -z "$go_have" ] || ! vge "$go_have" "$GO_NEED"; then
  arch="$(uname -m)"; case "$arch" in x86_64) goarch=amd64 ;; aarch64) goarch=arm64 ;; *) echo "Architecture $arch: please install Go manually." >&2; exit 1 ;; esac
  echo "    Installing Go $GO_NEED to /usr/local/go (sudo)"
  run "curl -fsSL https://go.dev/dl/go${GO_NEED}.linux-${goarch}.tar.gz -o /tmp/omp-go.tgz && sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf /tmp/omp-go.tgz && rm -f /tmp/omp-go.tgz"
else echo "    Go $go_have present"; fi
if ! have deno; then run "curl -fsSL https://deno.land/install.sh | sh -s -- -y"; else echo "    Deno present"; fi
if [ "$MEDIA" = 1 ] && ! have cargo; then run "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"; fi

# Make PATH permanent (only if not already present)
PROFILE_LINE='export PATH="/usr/local/go/bin:$HOME/.deno/bin:$HOME/.cargo/bin:$PATH"'
if ! grep -qsF "$PROFILE_LINE" "$HOME/.bashrc"; then
  echo "    Adding PATH entry to ~/.bashrc"
  run "printf '\n# OpenMediaPlatform\n%s\n' '$PROFILE_LINE' >> \"$HOME/.bashrc\""
fi

# ---- Media nodes -----------------------------------------------------------------
if [ "$MEDIA" = 1 ]; then
  say "3/4 Building MXL library and media nodes (takes 20–60 minutes depending on the machine)"
  if [ "$(uname -m)" = "x86_64" ] && ! grep -m1 '^flags' /proc/cpuinfo | grep -qw avx2; then
    echo "    Note: CPU without AVX2 (e.g. generic QEMU CPU model) — libmxl is automatically built for an older"
    echo "    target architecture (otherwise 'Illegal instruction' in every MXL node). Better: choose VM CPU type 'host'."
  fi
  run "\"$ROOT_DIR/deploy/dev/install-mxl.sh\""
  run "make -C \"$ROOT_DIR\" nodes"
  # Optional: plugin for "blend" frame-rate conversion (failure is not critical, nodes then use videorate).
  if [ "$AVF" = 1 ]; then
    say "3b/4 Plugin avvideofilter (blend frame-rate conversion, optional)"
    run "\"$ROOT_DIR/deploy/dev/install-avvideofilter.sh\"${AVF_ARCHIVE:+ --archive \"$AVF_ARCHIVE\"} || true"
  fi
else
  say "3/4 Media nodes skipped (add later: ./install.sh --media)"
fi

# ---- Host agent (for remote hosts in the cluster) ---------------------------------
# bin/omp-host-agent is needed by the UI's host wizard (the script starts
# ./bin/omp-host-agent). go build must run INSIDE the host-agent/ directory.
say "Building the host agent (bin/omp-host-agent)"
run "mkdir -p \"$ROOT_DIR/bin\" && (cd \"$ROOT_DIR/host-agent\" && go build -o ../bin/omp-host-agent .)"

# ---- systemd services (optional) ------------------------------------------------------
unit_install() { # template, target name
  run "sed -e 's#@USER@#$(id -un)#g' -e 's#@ROOT@#$ROOT_DIR#g' -e 's#@UID@#$(id -u)#g' -e 's#@HOME@#$HOME#g' \"$ROOT_DIR/deploy/systemd/$1\" | sudo tee /etc/systemd/system/$2 >/dev/null"
}
if [ "$SYSTEMD" = 1 ]; then
  say "systemd service: start OMP at boot"
  have systemctl || { echo "systemd not found." >&2; exit 1; }
  unit_install omp.service omp.service
  # rootless Podman (NATS/registry/Postgres) needs a user runtime directory without an active login
  run "sudo loginctl enable-linger $(id -un)"
  run "sudo systemctl daemon-reload && sudo systemctl enable omp"
  echo "    Start now: sudo systemctl start omp   (log: journalctl -u omp, .run/orchestrator.log)"
  echo "    Note: the service does not rebuild anything (OMP_SKIP_BUILD=1). After code changes run 'make start' once or rebuild."
fi
if [ "$AGENT_SVC" = 1 ]; then
  say "systemd service: host agent (additional host)"
  [ -n "$ORCH_IP" ] || { echo "--host-agent-service needs --orchestrator <IP of the main machine>" >&2; exit 2; }
  [ -n "$AGENT_LABEL" ] || AGENT_LABEL="$(hostname -s)"
  [ -x "$ROOT_DIR/bin/omp-host-agent" ] || [ "$DRY" = 1 ] || { echo "bin/omp-host-agent is missing (built above if go is available)." >&2; exit 1; }
  envfile="OMP_HOST_AGENT_LABEL=$AGENT_LABEL
OMP_ORCHESTRATOR_URL=http://$ORCH_IP:8000
OMP_REGISTRY_URL=http://$ORCH_IP:8010
OMP_NATS_URL=nats://$ORCH_IP:4222,nats://$ORCH_IP:4223,nats://$ORCH_IP:4224"
  [ -z "$AGENT_TOKEN" ] || envfile="$envfile
OMP_HOST_AGENT_BOOTSTRAP_TOKEN=$AGENT_TOKEN"
  run "printf '%s\\n' \"$envfile\" | sudo tee /etc/omp-host-agent.env >/dev/null && sudo chmod 600 /etc/omp-host-agent.env"
  unit_install omp-host-agent.service omp-host-agent.service
  run "sudo systemctl daemon-reload && sudo systemctl enable --now omp-host-agent"
  echo "    First start: pass a one-time bootstrap token (UI → Hosts → Add host) with --token."
  echo "    Media nodes on this host: run ./install.sh --media first. Log: journalctl -u omp-host-agent"
fi

if [ "$STREAMDECK" = 1 ]; then
  say "Stream Deck: udev rule"
  run "\"$ROOT_DIR/deploy/dev/streamdeck-udev.sh\""
fi

# ---- Verification ------------------------------------------------------------------------
say "4/4 Verification (make preflight)"
run "make -C \"$ROOT_DIR\" preflight || true"

if [ "$START" = 1 ]; then
  say "Starting (make start)"
  run "make -C \"$ROOT_DIR\" start"
  echo; echo "Done: http://localhost:8000"
else
  cat <<EOF

Installation complete. Next steps:
  source ~/.bashrc          # (or open a new terminal) so go/deno/cargo are on the PATH
  cd $ROOT_DIR && make start
  Browser: http://localhost:8000   (first start: pulls container images, takes a few minutes)
To connect another machine as a host: UI → Hosts → "Add host" (run the script on the target machine in
the repo directory; run ./install.sh --media there first). Ports/firewall: docs/INSTALLATION.md
EOF
fi
