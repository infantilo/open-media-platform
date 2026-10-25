#!/usr/bin/env bash
# Preflight check for the first installation and every start: verifies that
# the machine has everything OpenMediaPlatform needs — BEFORE `make start`
# aborts after two minutes with a cryptic error message. Every message
# names the cause and, where possible, the command to fix it for the
# detected distribution.
#
#   ./deploy/dev/preflight.sh                 check everything (default)
#   ./deploy/dev/preflight.sh --for=start     only what `make start` needs
#   ./deploy/dev/preflight.sh --for=nodes     additionally media nodes (Rust/GStreamer/MXL)
#   ./deploy/dev/preflight.sh --quiet         print warnings and errors only
#   ./deploy/dev/preflight.sh --strict        treat warnings as errors
#   ./deploy/dev/preflight.sh --json          machine-readable (one line per check)
#
# Exit code 0 = no error (warnings possible), 1 = at least one error.
# `make preflight` calls this; `make start` calls `--for=start --quiet`
# automatically (skippable with OMP_SKIP_PREFLIGHT=1).
#
# Plain Bash + standard tools (no sudo, changes nothing on the system).
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

SCOPE="all"
QUIET=0
STRICT=0
JSON=0
for arg in "$@"; do
  case "$arg" in
    --for=*) SCOPE="${arg#--for=}" ;;
    --quiet) QUIET=1 ;;
    --strict) STRICT=1 ;;
    --json) JSON=1 ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done
case "$SCOPE" in all|start|nodes) ;; *) echo "--for= expects all|start|nodes" >&2; exit 2 ;; esac

# ---- Output ----------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "$JSON" = "0" ]; then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_B=$'\033[1m'; C_OFF=$'\033[0m'
else
  C_OK=""; C_WARN=""; C_ERR=""; C_DIM=""; C_B=""; C_OFF=""
fi

N_OK=0; N_WARN=0; N_ERR=0
FIXES=()

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' '; }

emit() { # level, title, detail, fix
  local level="$1" title="$2" detail="${3:-}" fix="${4:-}"
  case "$level" in ok) N_OK=$((N_OK+1)) ;; warn) N_WARN=$((N_WARN+1)) ;; err) N_ERR=$((N_ERR+1)) ;; esac
  if [ "$JSON" = "1" ]; then
    printf '{"level":"%s","check":"%s","detail":"%s","fix":"%s"}\n' "$level" "$(json_escape "$title")" "$(json_escape "$detail")" "$(json_escape "$fix")"
    return
  fi
  if [ "$level" = "ok" ] && [ "$QUIET" = "1" ]; then return; fi
  local mark color
  case "$level" in ok) mark="✔"; color="$C_OK" ;; warn) mark="!"; color="$C_WARN" ;; err) mark="✘"; color="$C_ERR" ;; esac
  printf '  %s%s%s %s' "$color" "$mark" "$C_OFF" "$title"
  [ -n "$detail" ] && printf ' %s— %s%s' "$C_DIM" "$detail" "$C_OFF"
  printf '\n'
  if [ "$level" != "ok" ] && [ -n "$fix" ]; then
    printf '      %s→ %s%s\n' "$C_DIM" "$fix" "$C_OFF"
    FIXES+=("$fix")
  fi
}
ok()   { emit ok "$@"; }
warn() { emit warn "$@"; }
err()  { emit err "$@"; }
section() { [ "$JSON" = "1" ] && return; [ "$QUIET" = "1" ] && return; printf '\n%s%s%s\n' "$C_B" "$1" "$C_OFF"; }

# ---- Detect distribution / package manager ---------------------------------------
PM=""
if command -v apt-get >/dev/null 2>&1; then PM="apt"
elif command -v dnf >/dev/null 2>&1; then PM="dnf"
elif command -v pacman >/dev/null 2>&1; then PM="pacman"
elif command -v zypper >/dev/null 2>&1; then PM="zypper"
fi

# install_hint <tool>: command to install it (package name per distribution).
install_hint() {
  local tool="$1" pkg=""
  case "$PM:$tool" in
    apt:podman) pkg="podman" ;;   dnf:podman) pkg="podman" ;;   pacman:podman) pkg="podman" ;;   zypper:podman) pkg="podman" ;;
    apt:curl) pkg="curl" ;;       dnf:curl) pkg="curl" ;;       pacman:curl) pkg="curl" ;;       zypper:curl) pkg="curl" ;;
    apt:openssl) pkg="openssl" ;; dnf:openssl) pkg="openssl" ;; pacman:openssl) pkg="openssl" ;; zypper:openssl) pkg="openssl" ;;
    apt:make) pkg="make" ;;       dnf:make) pkg="make" ;;       pacman:make) pkg="make" ;;       zypper:make) pkg="make" ;;
    apt:git) pkg="git" ;;         dnf:git) pkg="git" ;;         pacman:git) pkg="git" ;;         zypper:git) pkg="git" ;;
    apt:pkg-config) pkg="pkg-config" ;; dnf:pkg-config) pkg="pkgconf-pkg-config" ;; pacman:pkg-config) pkg="pkgconf" ;; zypper:pkg-config) pkg="pkg-config" ;;
    apt:gst) pkg="libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-libav gstreamer1.0-tools" ;;
    dnf:gst) pkg="gstreamer1-devel gstreamer1-plugins-base-devel gstreamer1-plugins-base gstreamer1-plugins-good gstreamer1-plugins-bad-free gstreamer1-plugins-ugly-free" ;;
    pacman:gst) pkg="gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugins-ugly" ;;
    zypper:gst) pkg="gstreamer-devel gstreamer-plugins-base-devel gstreamer-plugins-good gstreamer-plugins-bad gstreamer-plugins-ugly" ;;
    apt:ss|zypper:ss|pacman:ss) pkg="iproute2"; [ "$PM" = "pacman" ] && pkg="iproute2" ;;
    dnf:ss) pkg="iproute" ;;
    apt:ffmpeg) pkg="ffmpeg" ;;   dnf:ffmpeg) pkg="ffmpeg-free" ;; pacman:ffmpeg) pkg="ffmpeg" ;; zypper:ffmpeg) pkg="ffmpeg" ;;
  esac
  case "$PM" in
    apt) [ -n "$pkg" ] && echo "sudo apt-get install -y $pkg" ;;
    dnf) [ -n "$pkg" ] && echo "sudo dnf install -y $pkg" ;;
    pacman) [ -n "$pkg" ] && echo "sudo pacman -S --needed $pkg" ;;
    zypper) [ -n "$pkg" ] && echo "sudo zypper install $pkg" ;;
  esac
}

# version_ge <have> <want>: have >= want (numeric per dot segment)
version_ge() {
  local a="$1" b="$2"
  [ "$(printf '%s\n%s\n' "$b" "$a" | sort -V | head -n1)" = "$b" ]
}

need_tool() { # tool, why, [level=err]
  local tool="$1" why="$2" level="${3:-err}"
  if command -v "$tool" >/dev/null 2>&1; then
    return 0
  fi
  local fix; fix="$(install_hint "$tool")"
  "$level" "$tool not found" "$why" "$fix"
  return 1
}

# Basic tools this script itself cannot work without.
for t in awk sed grep sort df uname tr head; do
  if ! command -v "$t" >/dev/null 2>&1; then
    echo "Basic tool '$t' is missing — this system is not suitable for OpenMediaPlatform, or it is a minimal container without coreutils." >&2
    exit 1
  fi
done

# =============================================================================
section "System"

case "$(uname -s)" in
  Linux) ok "Operating system" "Linux ($(uname -m))" ;;
  *) err "Operating system" "only Linux is supported (found: $(uname -s))" "Install on a Linux machine or in a Linux VM" ;;
esac
case "$(uname -m)" in
  x86_64|aarch64) ;;
  *) warn "Architecture" "$(uname -m) is untested (tested: x86_64)" ;;
esac

# Memory
if [ -r /proc/meminfo ]; then
  mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
  mem_gb="$(awk -v k="$mem_kb" 'BEGIN {printf "%.1f", k/1024/1024}')"
  if [ "$mem_kb" -lt 1500000 ]; then
    err "Memory" "${mem_gb} GB — at least 1.5 GB required (Postgres cluster, NATS and orchestrator run as containers/processes)" "Provide more RAM (for a VM: increase memory)"
  elif [ "$mem_kb" -lt 7500000 ]; then
    [ "$SCOPE" != "start" ] && warn "Memory" "${mem_gb} GB — tight: enough for basic operation, but 8 GB or more is recommended for media nodes (mixers, multiviewer)"
  else
    ok "Memory" "${mem_gb} GB"
  fi
fi

# CPU cores
cores="$(nproc 2>/dev/null || echo 1)"
if [ "$cores" -lt 2 ]; then
  warn "CPU cores" "$cores — media nodes need several cores" "At least 4 cores recommended"
else
  ok "CPU cores" "$cores"
fi

# Disk space in the project directory
free_kb="$(df -Pk "$ROOT_DIR" 2>/dev/null | awk 'NR==2 {print $4}')"
if [ -n "${free_kb:-}" ]; then
  free_gb="$(awk -v k="$free_kb" 'BEGIN {printf "%.1f", k/1024/1024}')"
  if [ "$free_kb" -lt 3145728 ]; then
    err "Disk space" "${free_gb} GB free in $ROOT_DIR — container images, build artifacts and database need at least 10 GB" "Free up space: 'make clean-cache' (cargo incremental caches + untagged images); biggest consumer is usually nodes/target ('cargo clean --manifest-path nodes/Cargo.toml' or 'rm -rf nodes/target/debug'); 'podman system prune' removes unused images"
  elif [ "$free_kb" -lt 10485760 ]; then
    warn "Disk space" "${free_gb} GB free — tight (the Rust build of the nodes alone needs several GB)" "Recommended: at least 10 GB free"
  else
    ok "Disk space" "${free_gb} GB free"
  fi
fi

# =============================================================================
section "Tools (for make start)"

need_tool bash "scripts"
need_tool make "entry point of all commands (make start …)" && ok "make" "$(make --version 2>/dev/null | head -n1)"
need_tool curl "health checks at startup" && ok "curl"
need_tool openssl "generates the key for the storage backends on first start" && ok "openssl"
need_tool git "version stamps/updates" warn && ok "git"

# Offline package: prebuilt binaries, Go/Deno/Rust are not needed (deploy/offline/install-offline.sh)
PREBUILT=0; [ -f "$ROOT_DIR/.offline-install" ] && PREBUILT=1

# Go
if [ "$PREBUILT" = 1 ] && ! command -v go >/dev/null 2>&1; then
  ok "Go" "not needed (offline package with prebuilt binaries)"
elif command -v go >/dev/null 2>&1; then
  # Ask inside the orchestrator directory: go.mod/GOTOOLCHAIN apply there (an already downloaded toolchain counts)
  go_have="$(cd "$ROOT_DIR/orchestrator" 2>/dev/null && go env GOVERSION 2>/dev/null | sed 's/^go//')"
  go_need="$(awk '/^go [0-9]/ {print $2; exit}' "$ROOT_DIR/orchestrator/go.mod" 2>/dev/null)"
  if [ -n "$go_have" ] && [ -n "$go_need" ] && ! version_ge "$go_have" "$go_need"; then
    if [ "${GOTOOLCHAIN:-auto}" = "local" ]; then
      err "Go" "version $go_have — the project needs $go_need" "Install Go $go_need or newer: https://go.dev/dl/"
    else
      warn "Go" "version $go_have — the project needs $go_need; Go downloads the matching toolchain itself on the first build (internet access required)" "Alternatively install Go $go_need: https://go.dev/dl/"
    fi
  else
    ok "Go" "$go_have"
  fi
else
  err "Go not found" "builds the orchestrator" "Install Go: https://go.dev/dl/ (current version)"
fi

# Deno
if [ "$PREBUILT" = 1 ] && ! command -v deno >/dev/null 2>&1; then
  ok "Deno" "not needed (offline package with prebuilt binaries)"
elif command -v deno >/dev/null 2>&1; then
  ok "Deno" "$(deno --version 2>/dev/null | head -n1 | awk '{print $2}')"
else
  err "Deno not found" "builds the UI bundle (no Node/npm needed)" "Install Deno: curl -fsSL https://deno.land/install.sh | sh"
fi

# =============================================================================
section "Containers (Podman)"

if need_tool podman "starts NATS, NMOS registry, etcd and Postgres"; then
  pv="$(podman --version 2>/dev/null | awk '{print $3}')"
  if podman info >/dev/null 2>&1; then
    ok "Podman" "$pv, working"
  else
    err "Podman reports an error" "'podman info' fails" "Check the output: podman info   (rootless: /etc/subuid and /etc/subgid, 'podman system migrate')"
  fi
  # rootless: subuid/subgid present?
  if [ "$(id -u)" != "0" ]; then
    user="$(id -un)"
    if ! grep -q "^${user}:" /etc/subuid 2>/dev/null || ! grep -q "^${user}:" /etc/subgid 2>/dev/null; then
      warn "subuid/subgid missing for $user" "rootless Podman needs them for container users" "sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $user && podman system migrate"
    fi
  fi

  # Derive the required images from the Makefile (single source of truth)
  missing_images=()
  # Quelle ist deploy/images.env (mit Digest; bei Offline-Installationen nur das Tag)
  for img in $(sed -n 's/^\(NATS\|NMOS_REGISTRY\|ETCD\)_IMAGE=//p' "$ROOT_DIR/deploy/images.env" | while read -r ref; do
      if [ -e "$ROOT_DIR/.run/images-unpinned" ]; then echo "${ref%%@*}"; else echo "$ref"; fi; done); do
    if podman image exists "$img" 2>/dev/null; then
      ok "Image $img" "present"
    else
      missing_images+=("$img")
    fi
  done
  if [ "${#missing_images[@]}" -gt 0 ]; then
    # Check registry reachability (only relevant if something has to be pulled)
    reach=1
    for host in registry-1.docker.io quay.io; do
      if ! curl -fsS -m 6 -o /dev/null "https://$host/v2/" 2>/dev/null && ! curl -sS -m 6 -o /dev/null -w '%{http_code}' "https://$host/v2/" 2>/dev/null | grep -q '^\(200\|401\)$'; then
        reach=0
      fi
    done
    if [ "$reach" = "1" ]; then
      warn "${#missing_images[@]} container image(s) missing" "will be pulled automatically on the first 'make start' (${missing_images[*]}) — this takes a few minutes" ""
    else
      err "${#missing_images[@]} container image(s) missing and the registry is not reachable" "${missing_images[*]}" "Check internet access/proxy OR pull the images on another machine and import them (podman save / podman load)"
    fi
  fi
  if ! podman image exists localhost/omp-patroni:latest 2>/dev/null; then
    warn "Postgres image (omp-patroni) not built yet" "will be built from deploy/patroni on the first 'make start' (several minutes, needs internet access)" ""
  fi
fi

# =============================================================================
section "Ports"

# Detect the expected occupation by OMP itself: if the OMP containers/the
# orchestrator are already running, the occupation is intended and not an error.
omp_running=0
if command -v podman >/dev/null 2>&1; then
  # Several attempts: a single `podman ps` occasionally returns nothing right after `make stop`
  # (Podman lock/restart of the events logger) — all own infrastructure ports would then wrongly count as "in use".
  for _ in 1 2 3; do
    if podman ps --format '{{.Names}}' 2>/dev/null | grep -q '^omp-'; then omp_running=1; break; fi
    sleep 1
  done
fi
orch_running=0
if curl -fs -m 2 http://localhost:8000/healthz >/dev/null 2>&1; then orch_running=1; fi

PORTS_DEFAULT="8000:Orchestrator 8091:Supervisor 8010:NMOS-Registry 8011:NMOS-Registry 4222:NATS 4223:NATS 4224:NATS 8222:NATS-Monitoring 5432:Postgres 5442:Postgres 5452:Postgres 8008:Patroni 2379:etcd"
PORTS="${PREFLIGHT_PORTS:-$PORTS_DEFAULT}"
if command -v ss >/dev/null 2>&1; then
  conflicts=0
  for entry in $PORTS; do
    port="${entry%%:*}"; name="${entry#*:}"
    owner="$(ss -Hltnp "sport = :$port" 2>/dev/null | head -n1)"
    [ -z "$owner" ] && continue
    proc="$(printf '%s' "$owner" | grep -o 'users:(("[^"]*"' | head -n1 | sed 's/users:(("//; s/"$//')"
    # Occupation by OMP itself is intended: running orchestrator/supervisor
    # or OMP containers (process name from the allowlist or not determinable).
    case "$port:$name" in
      8000:Orchestrator|8091:Supervisor) [ "$orch_running" = "1" ] && continue ;;
    esac
    # The supervisor intentionally survives `make stop` (start-supervisor.sh is idempotent).
    [ "$port" = "8091" ] && [ "${proc:-}" = "omp-supervisor" ] && continue
    if [ "$omp_running" = "1" ]; then
      case "${proc:-}" in
        ""|nats-server|etcd|postgres|patroni|conmon|rootlessport|slirp4netns|pasta|omp-*|nmos-cpp-*) continue ;;
      esac
    fi
    err "Port $port ($name) is in use" "${proc:+by \"$proc\"}" "Stop the occupying process: ss -ltnp | grep :$port   (an earlier run that did not shut down cleanly? 'make stop' or kill <PID>)"
    conflicts=$((conflicts+1))
  done
  if [ "$conflicts" = "0" ]; then
    if [ "$orch_running" = "1" ]; then ok "Required ports" "free or occupied by OpenMediaPlatform itself (orchestrator already running)"; else ok "Required ports free"; fi
  fi
else
  warn "'ss' not found" "port check skipped" "$(install_hint ss)"
fi

# Podman 5 (pasta): published ports answer on 127.0.0.1 but reset
# connections via ::1 ("localhost" often resolves there first) —
# the orchestrator then does not see the NMOS registry and no node starts.
# Only checkable if the registry is already running.
if command -v curl >/dev/null 2>&1 && curl -s -m 3 -o /dev/null "http://127.0.0.1:8010/x-nmos/query/v1.3/" 2>/dev/null; then
  if curl -s -m 3 -o /dev/null "http://[::1]:8010/x-nmos/query/v1.3/" 2>/dev/null; then
    ok "Registry via IPv6 (::1)" "reachable"
  elif getent ahosts localhost 2>/dev/null | awk 'NR==1 {exit !($1=="::1")}'; then
    warn "Registry not reachable via ::1" "IPv4 works, but 'localhost' resolves to ::1 first (Podman/pasta) — services with a localhost URL do not see the registry" "Set OMP_REGISTRY_URL=http://127.0.0.1:8010 (OMP default) and do not use localhost URLs for registry/container ports"
  else
    ok "Registry via IPv4" "reachable (::1 unused)"
  fi
fi

# =============================================================================
section "Configuration"

if [ -w "$ROOT_DIR" ]; then
  mkdir -p "$ROOT_DIR/.run" "$ROOT_DIR/bin" 2>/dev/null
  if [ -w "$ROOT_DIR/.run" ] && [ -w "$ROOT_DIR/bin" ]; then
    ok "Write permissions" ".run/ and bin/ are writable"
  else
    err "No write permissions in .run/ or bin/" "" "Check ownership: ls -ld $ROOT_DIR/.run $ROOT_DIR/bin"
  fi
else
  err "Project directory not writable" "$ROOT_DIR" "Check permissions (do not run as another user/from a read-only mount)"
fi

if [ -f "$ROOT_DIR/deploy/dev/storage-secret.env" ]; then
  ok "Storage key" "present (deploy/dev/storage-secret.env)"
else
  ok "Storage key" "will be generated automatically on first start"
fi

if [ -s "$ROOT_DIR/.run/update-trusted.pub" ]; then
  ok "System update" "signing key in place"
else
  [ "$SCOPE" = "all" ] && warn "System update: no signing key" ".run/update-trusted.pub is missing — uploaded update packages will be rejected" "Only needed if you want to apply updates via the browser: make update-keygen (see docs/HANDBUCH.md §5b)"
fi

# =============================================================================
if [ "$SCOPE" != "start" ]; then
section "Media nodes (Rust, GStreamer, MXL) — optional, only for video/audio"

if command -v cargo >/dev/null 2>&1 && command -v rustc >/dev/null 2>&1; then
  rv="$(rustc --version | awk '{print $2}')"
  if version_ge "$rv" "1.85.0"; then ok "Rust" "$rv"; else err "Rust too old" "$rv — edition 2024 needs at least 1.85" "rustup update stable"; fi
elif [ "$PREBUILT" = 1 ]; then
  ok "Rust" "not needed (offline package with prebuilt binaries)"
else
  warn "Rust/Cargo not found" "builds the media nodes (make nodes)" "Install Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
fi

if [ "$PREBUILT" = 1 ]; then
  ok "GStreamer development libraries" "not needed (offline package with prebuilt binaries)"
elif command -v pkg-config >/dev/null 2>&1; then
  missing_pc=()
  for m in gstreamer-1.0 gstreamer-app-1.0 gstreamer-video-1.0 gstreamer-pbutils-1.0 gstreamer-net-1.0; do
    pkg-config --exists "$m" 2>/dev/null || missing_pc+=("$m")
  done
  if [ "${#missing_pc[@]}" -eq 0 ]; then
    ok "GStreamer development libraries" "$(pkg-config --modversion gstreamer-1.0)"
  else
    warn "GStreamer development libraries missing" "${missing_pc[*]} — 'make nodes' cannot build the media nodes" "$(install_hint gst)"
  fi
else
  need_tool pkg-config "finds the GStreamer libraries when building the nodes" warn
fi

if command -v gst-inspect-1.0 >/dev/null 2>&1; then
  # Core elements: if one is missing, the basic nodes do not work.
  core="capsfilter queue videoconvert videoscale videorate tee appsink appsrc audioconvert audioresample audiomixer audiomixmatrix input-selector interleave compositor textoverlay jpegenc mxfdemux decodebin deinterlace volume level valve filesrc videotestsrc audiotestsrc"
  miss_core=()
  for e in $core; do gst-inspect-1.0 --exists "$e" 2>/dev/null || miss_core+=("$e"); done
  if [ "${#miss_core[@]}" -eq 0 ]; then
    ok "GStreamer core elements" "all present"
  else
    err "GStreamer elements missing" "${miss_core[*]}" "$(install_hint gst)"
  fi
  # Optional elements: report per feature.
  opt_check() { # element, feature
    gst-inspect-1.0 --exists "$1" 2>/dev/null || warn "GStreamer element $1 missing" "$2" "$(install_hint gst)"
  }
  opt_check webrtcbin "WebRTC gateway/monitor"
  opt_check x264enc "H.264 encoding (WebRTC, recorder)"
  opt_check srtsrc "SRT gateway"
  opt_check rtpvrawpay "ST 2110 gateway"
  opt_check matroskamux "Recorder (Matroska)"
  # Plugin for "blend" frame-rate conversion (third-party plugin, not in the package manager): without it all nodes use videorate.
  # --atleast-version is required: without it gst-inspect compares against the GStreamer version (0.1.x < 1.x → "missing")
  if gst-inspect-1.0 --exists --atleast-version=0.0.1 avvideofilter 2>/dev/null; then
    ok "GStreamer plugin avvideofilter" "blend frame-rate conversion available"
  else
    warn "GStreamer plugin avvideofilter missing" "optional — only for OMP_FRAMERATE_CONVERSION=blend (scaler); without it videorate is used" "./deploy/dev/install-avvideofilter.sh   (offline: --archive FILE, docs/INSTALLATION.md §9)"
  fi
else
  warn "gst-inspect-1.0 not found" "GStreamer runtime is missing or not installed" "$(install_hint gst)"
fi

# MXL
mxl_lib="$(ls "$ROOT_DIR"/third_party/mxl/build/*/lib/libmxl.so 2>/dev/null | head -n1)"
if [ -n "$mxl_lib" ]; then
  ok "MXL library" "built ($(basename "$(dirname "$(dirname "$mxl_lib")")"))"
else
  warn "MXL library not built" "the media nodes do not start without it (libmxl.so missing)" "./deploy/dev/install-mxl.sh   (needs cmake, ninja, clang, vcpkg — see header comment; takes a while)"
fi
if [ -d /dev/shm ] && [ -w /dev/shm ]; then
  shm_kb="$(df -Pk /dev/shm | awk 'NR==2 {print $2}')"
  if [ "${shm_kb:-0}" -lt 1000000 ]; then
    warn "/dev/shm is small" "$((shm_kb/1024)) MB — MXL flows live there in memory" "Increase the size: sudo mount -o remount,size=2G /dev/shm"
  else
    ok "/dev/shm" "$((shm_kb/1024/1024)) GB, writable"
  fi
else
  err "/dev/shm not writable" "MXL stores its media buffers there" "Check: ls -ld /dev/shm  (in containers: set --shm-size)"
fi

command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1 \
  && ok "ffmpeg/ffprobe" "present (process wizard)" \
  || warn "ffmpeg/ffprobe not found" "only for the ffmpeg wizard in the process editor" "$(install_hint ffmpeg)"
fi

# =============================================================================
if [ "$JSON" = "1" ]; then
  printf '{"summary":{"ok":%d,"warn":%d,"err":%d}}\n' "$N_OK" "$N_WARN" "$N_ERR"
else
  [ "$QUIET" = "1" ] && [ "$N_ERR" -eq 0 ] || printf '\n'
  if [ "$QUIET" = "1" ] && [ "$N_ERR" -eq 0 ]; then
    :  # short form (from make start): warnings are already printed above, no closing sentence
  elif [ "$N_ERR" -gt 0 ]; then
    printf '%s%s error(s), %s warning(s) — please fix the marked items (→ lines), then run again: make preflight%s\n' "$C_ERR" "$N_ERR" "$N_WARN" "$C_OFF"
  elif [ "$N_WARN" -gt 0 ]; then
    printf '%sReady, with %s warning(s).%s Start: make start\n' "$C_WARN" "$N_WARN" "$C_OFF"
  else
    printf '%sAll good.%s Start: make start\n' "$C_OK" "$C_OFF"
  fi
fi

if [ "$N_ERR" -gt 0 ]; then exit 1; fi
if [ "$STRICT" = "1" ] && [ "$N_WARN" -gt 0 ]; then exit 1; fi
exit 0
