#!/usr/bin/env bash
# OpenMediaPlatform — installation from the OFFLINE PACKAGE (no internet access needed, nothing is built).
# Started from the EXTRACTED package directory (containing omp/, images.tar, debs/, SHA256SUMS):
#
#   tar -xf omp-offline-*.tar.zst          (or --zstd / -z depending on the extension)
#   cd <extracted directory>
#   ./install-offline.sh [options]
#
#   --target DIR           installation directory (default: ~/OpenMediaPlatform; an existing installation = update,
#                          data/settings/secrets are kept)
#   --no-system-packages   do not install .deb packages (Podman/GStreamer/make are already present)
#   --no-images            do not load container images
#   --host-agent-service --orchestrator IP [--label NAME] [--token TOKEN]
#                          connect this machine as an additional host (service "omp-host-agent", like install.sh)
#   --systemd              start OMP automatically at boot (systemd service "omp", needs sudo)
#   --start                start right afterwards (make start)
#   --force                treat the distribution/architecture/glibc check as a warning only
#   --yes                  no confirmation prompts
#   --dry-run              only show what would be done
#
# What the script does (and only that): verify checksums → check the target machine → (apt) install system packages
# from debs/ (sudo) → copy files to --target → generate mxl.env → load images → install the avvideofilter plugin.
# It NEVER accesses the network, opens no firewall ports and does not run as root.
set -euo pipefail

BUNDLE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$HOME/OpenMediaPlatform"; SYSPKG=1; IMAGES=1; SYSTEMD=0; START=0; FORCE=0; YES=0; DRY=0; AGENT_SVC=0; ORCH_IP=""; AGENT_LABEL=""; AGENT_TOKEN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:?--target needs a directory}"; shift 2 ;;
    --no-system-packages) SYSPKG=0; shift ;;
    --no-images) IMAGES=0; shift ;;
    --systemd) SYSTEMD=1; shift ;;
    --host-agent-service) AGENT_SVC=1; shift ;;
    --orchestrator) ORCH_IP="${2:-}"; shift 2 || true ;;
    --label) AGENT_LABEL="${2:-}"; shift 2 || true ;;
    --token) AGENT_TOKEN="${2:-}"; shift 2 || true ;;
    --start) START=1; shift ;;
    --force) FORCE=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
run()  { if [ "$DRY" = 1 ]; then echo "    [dry-run] $*"; else eval "$*"; fi; }
die()  { echo "ERROR: $*" >&2; exit 1; }
warn() { echo "Warning: $*" >&2; }
confirm() { [ "$YES" = 1 ] || [ "$DRY" = 1 ] || { read -r -p "$1 [Y/n] " a; case "${a:-Y}" in n|N) return 1 ;; esac; }; }
vge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }   # $1 >= $2
mf() { sed -n "s/^ *\"$1\": *\"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\}$/\1/p" "$BUNDLE/MANIFEST.json" | head -1; }

[ "$(uname -s)" = Linux ] || die "Linux only"
[ "$(id -u)" != 0 ] || die "please do NOT run as root (Podman runs rootless; sudo is used by the script itself when needed)"
[ -f "$BUNDLE/MANIFEST.json" ] && [ -d "$BUNDLE/omp" ] || die "$BUNDLE is not an extracted offline package (MANIFEST.json/omp missing) — start the script from the extracted directory"

# ---- 1. Verify the package ----------------------------------------------------------------------------------
say "1/7 Verifying the package"
echo "    Package:  $(mf name)  (commit $(mf gitCommit), built $(mf builtAt))"
if [ -f "$BUNDLE/SHA256SUMS" ]; then
  if (cd "$BUNDLE" && sha256sum --check --quiet SHA256SUMS); then echo "    all files match SHA256SUMS"
  else die "checksums do NOT match — package damaged or modified (repeat the transfer)"; fi
else
  die "SHA256SUMS missing — package incomplete"
fi

# ---- 2. Check the target machine ------------------------------------------------------------------------------
say "2/7 Checking the target machine"
ARCH="$(uname -m)"; # shellcheck disable=SC1091
. /etc/os-release 2>/dev/null || true
GLIBC="$(ldd --version 2>/dev/null | awk 'NR==1 {print $NF}')"; [ -n "$GLIBC" ] || GLIBC=0
problems=0
chk() { # what, is, want
  if [ "$2" = "$3" ]; then echo "    ok   $1: $2"; else
    if [ "$FORCE" = 1 ]; then warn "$1: here $2, package built for $3 (--force)"; else echo "    MISMATCH $1: here $2, package built for $3" >&2; problems=1; fi
  fi
}
chk Architecture "$ARCH" "$(mf arch)"
chk Distribution "${ID:-?}" "$(mf distro)"
if [ "${VERSION_ID:-?}" = "$(mf distroVersion)" ]; then echo "    ok   Release: ${VERSION_ID:-?}"; else warn "release ${VERSION_ID:-?} instead of $(mf distroVersion) — system packages/libraries may not fit"; fi
if [ "$(mf glibc)" != unknown ] && ! vge "$GLIBC" "$(mf glibc)"; then
  if [ "$FORCE" = 1 ]; then warn "glibc $GLIBC is older than at build time ($(mf glibc))"; else echo "    MISMATCH glibc: here $GLIBC, package needs at least $(mf glibc)" >&2; problems=1; fi
fi
[ "$problems" = 0 ] || die "target machine does not match the package. Build a package for exactly this distribution/architecture (make-offline-bundle.sh) — or use --force at your own risk."

# ---- 3. System packages ----------------------------------------------------------------------------------------
say "3/7 System packages"
if [ "$SYSPKG" = 1 ] && [ -d "$BUNDLE/debs" ] && have apt-get; then
  n="$(ls "$BUNDLE/debs"/*.deb 2>/dev/null | wc -l)"
  echo "    $n packages from debs/ (local apt directory, nothing is fetched from the network)"
  confirm "    Install the packages from packages.txt including dependencies now with sudo?" || die "aborted"
  # Only THIS directory as package source (apt resolves alternatives itself; already installed packages are kept).
  APTDIR="$(mktemp -d)"; echo "deb [trusted=yes] file:$BUNDLE/debs ./" > "$APTDIR/local.list"
  AOPTS="-o Dir::Etc::sourcelist=$APTDIR/local.list -o Dir::Etc::sourceparts=/dev/null -o APT::Get::List-Cleanup=0 -o Acquire::Languages=none"
  run "sudo apt-get $AOPTS update"
  run "sudo apt-get $AOPTS install -y --no-install-recommends --no-download $(tr '\n' ' ' < "$BUNDLE/packages.txt")"
  rm -rf "$APTDIR"
elif [ "$SYSPKG" = 1 ] && [ -d "$BUNDLE/debs" ]; then
  warn "no apt — the packages from packages.txt must be installed beforehand (Podman, make, curl, openssl, GStreamer base/good/bad/ugly/libav)"
else
  echo "    skipped"
fi
missing=""
for t in podman make curl openssl tar gst-inspect-1.0; do have "$t" || missing="$missing $t"; done
[ -z "$missing" ] || [ "$DRY" = 1 ] || die "missing:$missing — install the system packages (without --no-system-packages or from packages.txt)"
# rootless Podman needs subuid/subgid
if ! grep -q "^$(id -un):" /etc/subuid 2>/dev/null; then
  echo "    creating subuid/subgid for $(id -un) (rootless Podman)"
  run "sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $(id -un) && podman system migrate"
fi

# ---- 4. Copy files ----------------------------------------------------------------------------------------------
say "4/7 Files to $TARGET"
if [ -f "$TARGET/.run/orchestrator.pid" ] && kill -0 "$(cat "$TARGET/.run/orchestrator.pid")" 2>/dev/null; then
  die "OMP is running in $TARGET — stop it first (cd $TARGET && make stop), then install again"
fi
if [ -e "$TARGET/Makefile" ]; then
  echo "    existing installation → update (data, .run, .backups, deploy/dev/*.env are kept)"
  if [ "$DRY" != 1 ] && [ -d "$TARGET/bin" ]; then
    bk="$TARGET/.offline-previous"; rm -rf "$bk"; mkdir -p "$bk"
    cp -a "$TARGET/bin" "$bk/bin" 2>/dev/null || true
    echo "    previous bin/ saved to $bk (rollback: copy bin/ back)"
  fi
fi
run "mkdir -p \"$TARGET\" && tar -C \"$BUNDLE/omp\" -cf - . | tar -C \"$TARGET\" -xf -"
# Marker: prebuilt binaries, never build (start-omp.sh/start-supervisor.sh/preflight read it)
run "printf 'offline-package %s\\ninstalled %s\\n' \"$(mf name)\" \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\" > \"$TARGET/.offline-install\""
run "chmod +x \"$TARGET\"/bin/* \"$TARGET\"/deploy/dev/*.sh \"$TARGET\"/deploy/offline/*.sh 2>/dev/null || true"

# ---- 5. mxl.env -----------------------------------------------------------------------------------------------------
say "5/7 MXL environment (deploy/dev/mxl.env)"
MXLB="$TARGET/third_party/mxl/build/Linux-GCC-Release"
if [ "$DRY" != 1 ]; then
  cat > "$TARGET/deploy/dev/mxl.env" <<ENV
# Generated by deploy/offline/install-offline.sh (offline package). Source before every MXL-using node/tool
# (sets LD_LIBRARY_PATH for libmxl.so, which the omp-mediaio mxl module loads at runtime).
export OMP_MXL_DOMAIN="/dev/shm/omp-mxl"
export LD_LIBRARY_PATH="$MXLB/lib:$MXLB/lib/fabrics/ofi:\${LD_LIBRARY_PATH:-}"
export MXL_INFO_BIN="$MXLB/tools/mxl-info/mxl-info"
export MXL_GST_TESTSRC_BIN="$MXLB/tools/mxl-gst/mxl-gst-testsrc"
export MXL_GST_SINK_BIN="$MXLB/tools/mxl-gst/mxl-gst-sink"
ENV
  echo "    written"
else echo "    [dry-run] mxl.env"; fi

# ---- 6. Container images ---------------------------------------------------------------------------------------------
say "6/7 Container images"
if [ "$IMAGES" = 1 ] && [ -f "$BUNDLE/images.tar" ]; then
  run "podman load -i \"$BUNDLE/images.tar\""
else
  echo "    skipped$([ -f "$BUNDLE/images.tar" ] || echo ' (package contains no images — provide them beforehand: podman load -i …)')"
fi

# ---- 7. Plugin avvideofilter -----------------------------------------------------------------------------------------
say "7/7 Plugin avvideofilter (blend frame-rate conversion, optional)"
arc="$(ls "$BUNDLE"/plugins/*.tar.gz 2>/dev/null | head -1 || true)"
if [ -n "$arc" ]; then
  run "\"$TARGET/deploy/dev/install-avvideofilter.sh\" --archive \"$arc\" || true"
else
  echo "    not in the package — nodes use videorate"
fi

# ---- systemd + wrap-up -------------------------------------------------------------------------------------------------
if [ "$SYSTEMD" = 1 ]; then
  say "systemd service: start OMP at boot"
  have systemctl || die "systemd not found"
  run "sed -e 's#@USER@#$(id -un)#g' -e 's#@ROOT@#$TARGET#g' -e 's#@UID@#$(id -u)#g' -e 's#@HOME@#$HOME#g' \"$TARGET/deploy/systemd/omp.service\" | sudo tee /etc/systemd/system/omp.service >/dev/null"
  run "sudo loginctl enable-linger $(id -un) && sudo systemctl daemon-reload && sudo systemctl enable omp"
  echo "    Start now: sudo systemctl start omp   (log: journalctl -u omp, $TARGET/.run/orchestrator.log)"
fi

if [ "$AGENT_SVC" = 1 ]; then
  say "systemd service: host agent (additional host)"
  have systemctl || die "systemd not found"
  [ -n "$ORCH_IP" ] || die "--host-agent-service needs --orchestrator <IP of the main machine>"
  [ -n "$AGENT_LABEL" ] || AGENT_LABEL="$(hostname -s)"
  envfile="OMP_HOST_AGENT_LABEL=$AGENT_LABEL
OMP_ORCHESTRATOR_URL=http://$ORCH_IP:8000
OMP_REGISTRY_URL=http://$ORCH_IP:8010
OMP_NATS_URL=nats://$ORCH_IP:4222,nats://$ORCH_IP:4223,nats://$ORCH_IP:4224"
  [ -z "$AGENT_TOKEN" ] || envfile="$envfile
OMP_HOST_AGENT_BOOTSTRAP_TOKEN=$AGENT_TOKEN"
  run "printf '%s\\n' \"$envfile\" | sudo tee /etc/omp-host-agent.env >/dev/null && sudo chmod 600 /etc/omp-host-agent.env"
  run "sed -e 's#@USER@#$(id -un)#g' -e 's#@ROOT@#$TARGET#g' -e 's#@UID@#$(id -u)#g' -e 's#@HOME@#$HOME#g' \"$TARGET/deploy/systemd/omp-host-agent.service\" | sudo tee /etc/systemd/system/omp-host-agent.service >/dev/null"
  run "sudo systemctl daemon-reload && sudo systemctl enable --now omp-host-agent"
  echo "    First start: pass a one-time bootstrap token (UI → Hosts → Add host) with --token. Log: journalctl -u omp-host-agent"
fi

say "Verification (make preflight)"
run "make -C \"$TARGET\" preflight || true"

if [ "$START" = 1 ]; then
  say "Starting (make start)"
  run "make -C \"$TARGET\" start"
  echo; echo "Done: http://localhost:8000"
else
  cat <<EOM

Installation complete. Next steps:
  cd $TARGET && make start        # then in the browser: http://localhost:8000
  First start: create an admin right away (Administration → Users) — docs/INSTALLATION.md §2.
  Guide/troubleshooting: docs/OFFLINE-INSTALLATION.md
EOM
fi
