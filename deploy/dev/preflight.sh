#!/usr/bin/env bash
# Preflight-Prüfung für die Erstinstallation und jeden Start: prüft, ob der
# Rechner alles hat, was OpenMediaPlatform braucht — BEVOR `make start`
# nach zwei Minuten mit einer kryptischen Fehlermeldung abbricht. Jede
# Meldung nennt die Ursache und, wo möglich, den Befehl zur Behebung für
# die erkannte Distribution.
#
#   ./deploy/dev/preflight.sh                 alles prüfen (Standard)
#   ./deploy/dev/preflight.sh --for=start     nur, was `make start` braucht
#   ./deploy/dev/preflight.sh --for=nodes     zusätzlich Medien-Nodes (Rust/GStreamer/MXL)
#   ./deploy/dev/preflight.sh --quiet         nur Warnungen und Fehler ausgeben
#   ./deploy/dev/preflight.sh --strict        Warnungen wie Fehler behandeln
#   ./deploy/dev/preflight.sh --json          maschinenlesbar (eine Zeile je Prüfung)
#
# Exit-Code 0 = kein Fehler (Warnungen möglich), 1 = mindestens ein Fehler.
# `make preflight` ruft dies auf; `make start` ruft `--for=start --quiet`
# automatisch auf (überspringbar mit OMP_SKIP_PREFLIGHT=1).
#
# Reine Bash + Standardwerkzeuge (kein sudo, ändert nichts am System).
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
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unbekannte Option: $arg (siehe --help)" >&2; exit 2 ;;
  esac
done
case "$SCOPE" in all|start|nodes) ;; *) echo "--for= erwartet all|start|nodes" >&2; exit 2 ;; esac

# ---- Ausgabe ---------------------------------------------------------------
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

# ---- Distribution / Paketmanager erkennen ---------------------------------------
PM=""
if command -v apt-get >/dev/null 2>&1; then PM="apt"
elif command -v dnf >/dev/null 2>&1; then PM="dnf"
elif command -v pacman >/dev/null 2>&1; then PM="pacman"
elif command -v zypper >/dev/null 2>&1; then PM="zypper"
fi

# install_hint <werkzeug>: Befehl zum Nachinstallieren (Paketname je Distribution).
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

# version_ge <ist> <soll>: ist >= soll (numerisch je Punkt-Segment)
version_ge() {
  local a="$1" b="$2"
  [ "$(printf '%s\n%s\n' "$b" "$a" | sort -V | head -n1)" = "$b" ]
}

need_tool() { # tool, warum, [level=err]
  local tool="$1" why="$2" level="${3:-err}"
  if command -v "$tool" >/dev/null 2>&1; then
    return 0
  fi
  local fix; fix="$(install_hint "$tool")"
  "$level" "$tool nicht gefunden" "$why" "$fix"
  return 1
}

# Grundwerkzeuge, ohne die dieses Skript selbst nicht funktioniert.
for t in awk sed grep sort df uname tr head; do
  if ! command -v "$t" >/dev/null 2>&1; then
    echo "Grundwerkzeug '$t' fehlt — dieses System ist für OpenMediaPlatform nicht geeignet oder ein minimaler Container ohne coreutils." >&2
    exit 1
  fi
done

# =============================================================================
section "System"

case "$(uname -s)" in
  Linux) ok "Betriebssystem" "Linux ($(uname -m))" ;;
  *) err "Betriebssystem" "nur Linux wird unterstützt (gefunden: $(uname -s))" "Auf einem Linux-Rechner oder in einer Linux-VM installieren" ;;
esac
case "$(uname -m)" in
  x86_64|aarch64) ;;
  *) warn "Architektur" "$(uname -m) ist ungetestet (getestet: x86_64)" ;;
esac

# Arbeitsspeicher
if [ -r /proc/meminfo ]; then
  mem_kb="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
  mem_gb="$(awk -v k="$mem_kb" 'BEGIN {printf "%.1f", k/1024/1024}')"
  if [ "$mem_kb" -lt 1500000 ]; then
    err "Arbeitsspeicher" "${mem_gb} GB — mindestens 1,5 GB nötig (Postgres-Cluster, NATS, Orchestrator laufen als Container/Prozesse)" "Mehr RAM bereitstellen (bei einer VM: Speicher erhöhen)"
  elif [ "$mem_kb" -lt 7500000 ]; then
    [ "$SCOPE" != "start" ] && warn "Arbeitsspeicher" "${mem_gb} GB — knapp: für den Grundbetrieb reicht es, für Medien-Nodes (Mischer, Multiviewer) sind 8 GB und mehr empfehlenswert"
  else
    ok "Arbeitsspeicher" "${mem_gb} GB"
  fi
fi

# CPU-Kerne
cores="$(nproc 2>/dev/null || echo 1)"
if [ "$cores" -lt 2 ]; then
  warn "CPU-Kerne" "$cores — Medien-Nodes brauchen mehrere Kerne" "Mindestens 4 Kerne empfohlen"
else
  ok "CPU-Kerne" "$cores"
fi

# Plattenplatz im Projektverzeichnis
free_kb="$(df -Pk "$ROOT_DIR" 2>/dev/null | awk 'NR==2 {print $4}')"
if [ -n "${free_kb:-}" ]; then
  free_gb="$(awk -v k="$free_kb" 'BEGIN {printf "%.1f", k/1024/1024}')"
  if [ "$free_kb" -lt 3145728 ]; then
    err "Plattenplatz" "${free_gb} GB frei in $ROOT_DIR — Container-Images, Build-Artefakte und Datenbank brauchen mindestens 10 GB" "Platz schaffen (z. B. 'podman system prune' entfernt ungenutzte Images)"
  elif [ "$free_kb" -lt 10485760 ]; then
    warn "Plattenplatz" "${free_gb} GB frei — knapp (Rust-Build der Nodes allein braucht mehrere GB)" "Empfohlen: mindestens 10 GB frei"
  else
    ok "Plattenplatz" "${free_gb} GB frei"
  fi
fi

# =============================================================================
section "Werkzeuge (für make start)"

need_tool bash "Skripte"
need_tool make "Einstiegspunkt aller Befehle (make start …)" && ok "make" "$(make --version 2>/dev/null | head -n1)"
need_tool curl "Health-Checks beim Start" && ok "curl"
need_tool openssl "erzeugt beim ersten Start den Schlüssel für Storage-Backends" && ok "openssl"
need_tool git "Versionsstempel/Updates" warn && ok "git"

# Go
if command -v go >/dev/null 2>&1; then
  go_have="$(go env GOVERSION 2>/dev/null | sed 's/^go//')"
  go_need="$(awk '/^go [0-9]/ {print $2; exit}' "$ROOT_DIR/orchestrator/go.mod" 2>/dev/null)"
  if [ -n "$go_have" ] && [ -n "$go_need" ] && ! version_ge "$go_have" "$go_need"; then
    if [ "${GOTOOLCHAIN:-auto}" = "local" ]; then
      err "Go" "Version $go_have — das Projekt braucht $go_need" "Go $go_need oder neuer installieren: https://go.dev/dl/"
    else
      warn "Go" "Version $go_have — das Projekt braucht $go_need; Go lädt die passende Toolchain beim ersten Build selbst nach (Internetzugang nötig)" "Alternativ Go $go_need installieren: https://go.dev/dl/"
    fi
  else
    ok "Go" "$go_have"
  fi
else
  err "Go nicht gefunden" "baut den Orchestrator" "Go installieren: https://go.dev/dl/ (aktuelle Version)"
fi

# Deno
if command -v deno >/dev/null 2>&1; then
  ok "Deno" "$(deno --version 2>/dev/null | head -n1 | awk '{print $2}')"
else
  err "Deno nicht gefunden" "baut das UI-Bundle (kein Node/npm nötig)" "Deno installieren: curl -fsSL https://deno.land/install.sh | sh"
fi

# =============================================================================
section "Container (Podman)"

if need_tool podman "startet NATS, NMOS-Registry, etcd und Postgres"; then
  pv="$(podman --version 2>/dev/null | awk '{print $3}')"
  if podman info >/dev/null 2>&1; then
    ok "Podman" "$pv, funktionsfähig"
  else
    err "Podman meldet einen Fehler" "'podman info' schlägt fehl" "Ausgabe prüfen: podman info   (rootless: /etc/subuid und /etc/subgid, 'podman system migrate')"
  fi
  # rootless: subuid/subgid vorhanden?
  if [ "$(id -u)" != "0" ]; then
    user="$(id -un)"
    if ! grep -q "^${user}:" /etc/subuid 2>/dev/null || ! grep -q "^${user}:" /etc/subgid 2>/dev/null; then
      warn "subuid/subgid für $user fehlen" "rootless Podman braucht sie für Container-Benutzer" "sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $user && podman system migrate"
    fi
  fi

  # Benötigte Images aus dem Makefile ableiten (eine Quelle der Wahrheit)
  missing_images=()
  for img in $(grep -ho '\(docker\.io\|quay\.io\)/[a-zA-Z0-9_./-]*:[a-zA-Z0-9._-]*' "$ROOT_DIR/Makefile" | sort -u | grep -E 'nats|nmos-cpp|etcd'); do
    if podman image exists "$img" 2>/dev/null; then
      ok "Image $img" "vorhanden"
    else
      missing_images+=("$img")
    fi
  done
  if [ "${#missing_images[@]}" -gt 0 ]; then
    # Erreichbarkeit der Registries prüfen (nur relevant, wenn etwas geladen werden muss)
    reach=1
    for host in registry-1.docker.io quay.io; do
      if ! curl -fsS -m 6 -o /dev/null "https://$host/v2/" 2>/dev/null && ! curl -sS -m 6 -o /dev/null -w '%{http_code}' "https://$host/v2/" 2>/dev/null | grep -q '^\(200\|401\)$'; then
        reach=0
      fi
    done
    if [ "$reach" = "1" ]; then
      warn "${#missing_images[@]} Container-Image(s) fehlen" "werden beim ersten 'make start' automatisch geladen (${missing_images[*]}) — das dauert einige Minuten" ""
    else
      err "${#missing_images[@]} Container-Image(s) fehlen und die Registry ist nicht erreichbar" "${missing_images[*]}" "Internetzugang/Proxy prüfen ODER die Images auf einem anderen Rechner laden und importieren (podman save / podman load)"
    fi
  fi
  if ! podman image exists localhost/omp-patroni:latest 2>/dev/null; then
    warn "Postgres-Image (omp-patroni) noch nicht gebaut" "wird beim ersten 'make start' aus deploy/patroni gebaut (mehrere Minuten, braucht Internetzugang)" ""
  fi
fi

# =============================================================================
section "Ports"

# Erwartete Belegung durch OMP selbst erkennen: laufen die OMP-Container/der
# Orchestrator bereits, ist die Belegung gewollt und kein Fehler.
omp_running=0
if command -v podman >/dev/null 2>&1 && podman ps --format '{{.Names}}' 2>/dev/null | grep -q '^omp-'; then omp_running=1; fi
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
    # Belegung durch OMP selbst ist gewollt: laufender Orchestrator/Supervisor
    # bzw. OMP-Container (Prozessname aus der Allowlist oder nicht ermittelbar).
    case "$port:$name" in
      8000:Orchestrator|8091:Supervisor) [ "$orch_running" = "1" ] && continue ;;
    esac
    if [ "$omp_running" = "1" ]; then
      case "${proc:-}" in
        ""|nats-server|etcd|postgres|patroni|conmon|rootlessport|slirp4netns|pasta|omp-*|nmos-cpp-*) continue ;;
      esac
    fi
    err "Port $port ($name) ist belegt" "${proc:+von \"$proc\"}" "Belegenden Prozess beenden: ss -ltnp | grep :$port   (ein früherer, nicht sauber beendeter Lauf? 'make stop' bzw. kill <PID>)"
    conflicts=$((conflicts+1))
  done
  if [ "$conflicts" = "0" ]; then
    if [ "$orch_running" = "1" ]; then ok "Benötigte Ports" "frei bzw. von OpenMediaPlatform selbst belegt (Orchestrator läuft bereits)"; else ok "Benötigte Ports frei"; fi
  fi
else
  warn "'ss' nicht gefunden" "Port-Prüfung übersprungen" "$(install_hint ss)"
fi

# Podman 5 (pasta): veröffentlichte Ports antworten auf 127.0.0.1, setzen aber
# Verbindungen über ::1 ("localhost" löst oft zuerst dorthin auf) zurück —
# dann sieht der Orchestrator die NMOS-Registry nicht und kein Node startet.
# Nur prüfbar, wenn die Registry bereits läuft.
if command -v curl >/dev/null 2>&1 && curl -s -m 3 -o /dev/null "http://127.0.0.1:8010/x-nmos/query/v1.3/" 2>/dev/null; then
  if curl -s -m 3 -o /dev/null "http://[::1]:8010/x-nmos/query/v1.3/" 2>/dev/null; then
    ok "Registry über IPv6 (::1)" "erreichbar"
  elif getent ahosts localhost 2>/dev/null | awk 'NR==1 {exit !($1=="::1")}'; then
    warn "Registry über ::1 nicht erreichbar" "IPv4 geht, 'localhost' löst aber zuerst auf ::1 auf (Podman/pasta) — Dienste mit localhost-URL sehen die Registry nicht" "OMP_REGISTRY_URL=http://127.0.0.1:8010 setzen (OMP-Standard) und keine localhost-URLs für Registry/Container-Ports verwenden"
  else
    ok "Registry über IPv4" "erreichbar (::1 unbenutzt)"
  fi
fi

# =============================================================================
section "Konfiguration"

if [ -w "$ROOT_DIR" ]; then
  mkdir -p "$ROOT_DIR/.run" "$ROOT_DIR/bin" 2>/dev/null
  if [ -w "$ROOT_DIR/.run" ] && [ -w "$ROOT_DIR/bin" ]; then
    ok "Schreibrechte" ".run/ und bin/ beschreibbar"
  else
    err "Keine Schreibrechte in .run/ oder bin/" "" "Besitzer prüfen: ls -ld $ROOT_DIR/.run $ROOT_DIR/bin"
  fi
else
  err "Projektverzeichnis nicht beschreibbar" "$ROOT_DIR" "Berechtigungen prüfen (nicht als anderer Nutzer/aus einem schreibgeschützten Mount starten)"
fi

if [ -f "$ROOT_DIR/deploy/dev/storage-secret.env" ]; then
  ok "Storage-Schlüssel" "vorhanden (deploy/dev/storage-secret.env)"
else
  ok "Storage-Schlüssel" "wird beim ersten Start automatisch erzeugt"
fi

if [ -s "$ROOT_DIR/.run/update-trusted.pub" ]; then
  ok "System-Update" "Signaturschlüssel hinterlegt"
else
  [ "$SCOPE" = "all" ] && warn "System-Update: kein Signaturschlüssel" ".run/update-trusted.pub fehlt — hochgeladene Update-Pakete werden abgelehnt" "Nur nötig, wenn du Updates per Browser einspielen willst: make update-keygen (siehe docs/HANDBUCH.md §5b)"
fi

# =============================================================================
if [ "$SCOPE" != "start" ]; then
section "Medien-Nodes (Rust, GStreamer, MXL) — optional, nur für Video/Audio"

if command -v cargo >/dev/null 2>&1 && command -v rustc >/dev/null 2>&1; then
  rv="$(rustc --version | awk '{print $2}')"
  if version_ge "$rv" "1.85.0"; then ok "Rust" "$rv"; else err "Rust zu alt" "$rv — Edition 2024 braucht mindestens 1.85" "rustup update stable"; fi
else
  warn "Rust/Cargo nicht gefunden" "baut die Medien-Nodes (make nodes)" "Rust installieren: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
fi

if command -v pkg-config >/dev/null 2>&1; then
  missing_pc=()
  for m in gstreamer-1.0 gstreamer-app-1.0 gstreamer-video-1.0 gstreamer-pbutils-1.0 gstreamer-net-1.0; do
    pkg-config --exists "$m" 2>/dev/null || missing_pc+=("$m")
  done
  if [ "${#missing_pc[@]}" -eq 0 ]; then
    ok "GStreamer-Entwicklungsbibliotheken" "$(pkg-config --modversion gstreamer-1.0)"
  else
    warn "GStreamer-Entwicklungsbibliotheken fehlen" "${missing_pc[*]} — 'make nodes' kann die Medien-Nodes nicht bauen" "$(install_hint gst)"
  fi
else
  need_tool pkg-config "findet die GStreamer-Bibliotheken beim Bauen der Nodes" warn
fi

if command -v gst-inspect-1.0 >/dev/null 2>&1; then
  # Kernelemente: fehlt eines, funktionieren die Basis-Nodes nicht.
  core="capsfilter queue videoconvert videoscale videorate tee appsink appsrc audioconvert audioresample audiomixer audiomixmatrix input-selector interleave compositor textoverlay jpegenc mxfdemux decodebin deinterlace volume level valve filesrc videotestsrc audiotestsrc"
  miss_core=()
  for e in $core; do gst-inspect-1.0 --exists "$e" 2>/dev/null || miss_core+=("$e"); done
  if [ "${#miss_core[@]}" -eq 0 ]; then
    ok "GStreamer-Kernelemente" "alle vorhanden"
  else
    err "GStreamer-Elemente fehlen" "${miss_core[*]}" "$(install_hint gst)"
  fi
  # Optionale Elemente: je Funktion einzeln melden.
  opt_check() { # element, funktion
    gst-inspect-1.0 --exists "$1" 2>/dev/null || warn "GStreamer-Element $1 fehlt" "$2" "$(install_hint gst)"
  }
  opt_check webrtcbin "WebRTC-Gateway/-Monitor"
  opt_check x264enc "H.264-Encoding (WebRTC, Recorder)"
  opt_check srtsrc "SRT-Gateway"
  opt_check rtpvrawpay "ST-2110-Gateway"
  opt_check matroskamux "Recorder (Matroska)"
else
  warn "gst-inspect-1.0 nicht gefunden" "GStreamer-Laufzeit fehlt oder ist nicht installiert" "$(install_hint gst)"
fi

# MXL
mxl_lib="$(ls "$ROOT_DIR"/third_party/mxl/build/*/lib/libmxl.so 2>/dev/null | head -n1)"
if [ -n "$mxl_lib" ]; then
  ok "MXL-Bibliothek" "gebaut ($(basename "$(dirname "$(dirname "$mxl_lib")")"))"
else
  warn "MXL-Bibliothek nicht gebaut" "ohne sie starten die Medien-Nodes nicht (libmxl.so fehlt)" "./deploy/dev/install-mxl.sh   (braucht cmake, ninja, clang, vcpkg — siehe Kopfkommentar; dauert länger)"
fi
if [ -d /dev/shm ] && [ -w /dev/shm ]; then
  shm_kb="$(df -Pk /dev/shm | awk 'NR==2 {print $2}')"
  if [ "${shm_kb:-0}" -lt 1000000 ]; then
    warn "/dev/shm ist klein" "$((shm_kb/1024)) MB — MXL-Flows liegen dort im Arbeitsspeicher" "Größe erhöhen: sudo mount -o remount,size=2G /dev/shm"
  else
    ok "/dev/shm" "$((shm_kb/1024/1024)) GB, beschreibbar"
  fi
else
  err "/dev/shm nicht beschreibbar" "MXL legt dort seine Medienpuffer ab" "Prüfen: ls -ld /dev/shm  (in Containern: --shm-size setzen)"
fi

command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1 \
  && ok "ffmpeg/ffprobe" "vorhanden (Prozess-Assistent)" \
  || warn "ffmpeg/ffprobe nicht gefunden" "nur für den ffmpeg-Assistenten im Prozess-Editor" "$(install_hint ffmpeg)"
fi

# =============================================================================
if [ "$JSON" = "1" ]; then
  printf '{"summary":{"ok":%d,"warn":%d,"err":%d}}\n' "$N_OK" "$N_WARN" "$N_ERR"
else
  [ "$QUIET" = "1" ] && [ "$N_ERR" -eq 0 ] || printf '\n'
  if [ "$QUIET" = "1" ] && [ "$N_ERR" -eq 0 ]; then
    :  # Kurzform (aus make start): Warnungen stehen schon oben, kein Abschlusssatz
  elif [ "$N_ERR" -gt 0 ]; then
    printf '%s%s Fehler, %s Warnung(en) — bitte die markierten Punkte beheben (→ Zeilen), dann erneut: make preflight%s\n' "$C_ERR" "$N_ERR" "$N_WARN" "$C_OFF"
  elif [ "$N_WARN" -gt 0 ]; then
    printf '%sBereit, mit %s Hinweis(en).%s Start: make start\n' "$C_WARN" "$N_WARN" "$C_OFF"
  else
    printf '%sAlles bereit.%s Start: make start\n' "$C_OK" "$C_OFF"
  fi
fi

if [ "$N_ERR" -gt 0 ]; then exit 1; fi
if [ "$STRICT" = "1" ] && [ "$N_WARN" -gt 0 ]; then exit 1; fi
exit 0
