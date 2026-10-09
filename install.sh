#!/usr/bin/env bash
# OpenMediaPlatform — Ein-Befehl-Installation (Debian/Ubuntu, Fedora, Arch, openSUSE).
#
#   ./install.sh               Grundsystem: Orchestrator, GUI, NATS, Registry, Postgres
#   ./install.sh --media       zusätzlich Medien-Nodes (Rust, GStreamer, MXL) — für echtes Video/Audio
#   ./install.sh --media --start   danach gleich starten
#   ./install.sh --dry-run     nur anzeigen, was getan würde
#   ./install.sh --yes         keine Rückfragen
#
# Was das Skript tut (und nur das):
#   1. Systempakete per Paketmanager installieren (braucht sudo; fragt vorher)
#   2. Go, Deno (und mit --media: Rust) installieren, falls fehlend/zu alt — nach $HOME, ohne sudo
#   3. mit --media: MXL-Bibliothek bauen (deploy/dev/install-mxl.sh) und Medien-Nodes bauen (make nodes)
#   4. make preflight laufen lassen
# Es öffnet KEINE Firewall-Ports und ändert keine Systemkonfiguration außer den Paketen.
# Mehrfach aufrufbar: Vorhandenes wird übersprungen.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MEDIA=0; START=0; DRY=0; YES=0
for a in "$@"; do
  case "$a" in
    --media) MEDIA=1 ;;
    --start) START=1 ;;
    --dry-run) DRY=1 ;;
    --yes|-y) YES=1 ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unbekannte Option: $a (siehe --help)" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
run()  { if [ "$DRY" = 1 ]; then echo "    [dry-run] $*"; else eval "$*"; fi; }
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(uname -s)" = "Linux" ] || { echo "Nur Linux wird unterstützt." >&2; exit 1; }
[ "$(id -u)" != "0" ] || { echo "Bitte NICHT als root ausführen (Podman läuft rootless, Build als normaler Nutzer). sudo wird bei Bedarf selbst benutzt." >&2; exit 1; }

# ---- Paketmanager ----------------------------------------------------------
if   have apt-get; then PM=apt
elif have dnf;     then PM=dnf
elif have pacman;  then PM=pacman
elif have zypper;  then PM=zypper
else echo "Kein unterstützter Paketmanager (apt/dnf/pacman/zypper). Siehe docs/INSTALLATION.md, Abschnitt „Manuell“." >&2; exit 1; fi

BASE_PKGS_apt="podman make curl openssl git ca-certificates unzip iproute2 uidmap slirp4netns"
BASE_PKGS_dnf="podman make curl openssl git ca-certificates unzip iproute shadow-utils"
BASE_PKGS_pacman="podman make curl openssl git ca-certificates unzip iproute2"
BASE_PKGS_zypper="podman make curl openssl git ca-certificates unzip iproute2"

MEDIA_PKGS_apt="build-essential pkg-config cmake ninja-build bison flex clang libclang-dev ffmpeg libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly gstreamer1.0-libav gstreamer1.0-tools gstreamer1.0-nice libnice-dev"
MEDIA_PKGS_dnf="gcc gcc-c++ pkgconf-pkg-config cmake ninja-build bison flex clang clang-devel ffmpeg-free gstreamer1-devel gstreamer1-plugins-base-devel gstreamer1-plugins-base gstreamer1-plugins-good gstreamer1-plugins-bad-free gstreamer1-plugins-ugly-free libnice-gstreamer1"
MEDIA_PKGS_pacman="base-devel pkgconf cmake ninja bison flex clang ffmpeg gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugins-ugly libnice"
MEDIA_PKGS_zypper="gcc gcc-c++ pkg-config cmake ninja bison flex clang libclang-devel ffmpeg gstreamer-devel gstreamer-plugins-base-devel gstreamer-plugins-good gstreamer-plugins-bad gstreamer-plugins-ugly"

pkgs_var="BASE_PKGS_$PM"; PKGS="${!pkgs_var}"
if [ "$MEDIA" = 1 ]; then m="MEDIA_PKGS_$PM"; PKGS="$PKGS ${!m}"; fi

say "1/4 Systempakete ($PM)"
echo "    $PKGS"
if [ "$YES" != 1 ] && [ "$DRY" != 1 ]; then
  read -r -p "    Diese Pakete jetzt mit sudo installieren? [J/n] " ans
  case "${ans:-J}" in n|N) echo "Abgebrochen."; exit 1 ;; esac
fi
case "$PM" in
  apt)    run "sudo apt-get update -y && sudo apt-get install -y $PKGS" ;;
  dnf)    run "sudo dnf install -y $PKGS" ;;
  pacman) run "sudo pacman -S --needed --noconfirm $PKGS" ;;
  zypper) run "sudo zypper --non-interactive install $PKGS" ;;
esac

# rootless Podman braucht subuid/subgid
if ! grep -q "^$(id -un):" /etc/subuid 2>/dev/null; then
  say "subuid/subgid für $(id -un) anlegen (rootless Podman)"
  run "sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $(id -un) && podman system migrate"
fi

# ---- Go / Deno / Rust ---------------------------------------------------------
say "2/4 Go, Deno$([ "$MEDIA" = 1 ] && echo ", Rust")"
GO_NEED="$(awk '/^go [0-9]/ {print $2; exit}' "$ROOT_DIR/orchestrator/go.mod")"
vge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }
export PATH="/usr/local/go/bin:$HOME/.deno/bin:$HOME/.cargo/bin:$PATH"
go_have=""; have go && go_have="$(go env GOVERSION | sed 's/^go//')"
if [ -z "$go_have" ] || ! vge "$go_have" "$GO_NEED"; then
  arch="$(uname -m)"; case "$arch" in x86_64) goarch=amd64 ;; aarch64) goarch=arm64 ;; *) echo "Architektur $arch: Go bitte manuell installieren." >&2; exit 1 ;; esac
  echo "    Go $GO_NEED nach /usr/local/go (sudo)"
  run "curl -fsSL https://go.dev/dl/go${GO_NEED}.linux-${goarch}.tar.gz -o /tmp/omp-go.tgz && sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf /tmp/omp-go.tgz && rm -f /tmp/omp-go.tgz"
else echo "    Go $go_have vorhanden"; fi
if ! have deno; then run "curl -fsSL https://deno.land/install.sh | sh -s -- -y"; else echo "    Deno vorhanden"; fi
if [ "$MEDIA" = 1 ] && ! have cargo; then run "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"; fi

# PATH dauerhaft machen (nur wenn noch nicht vorhanden)
PROFILE_LINE='export PATH="/usr/local/go/bin:$HOME/.deno/bin:$HOME/.cargo/bin:$PATH"'
if ! grep -qsF "$PROFILE_LINE" "$HOME/.bashrc"; then
  echo "    PATH-Eintrag in ~/.bashrc ergänzen"
  run "printf '\n# OpenMediaPlatform\n%s\n' '$PROFILE_LINE' >> \"$HOME/.bashrc\""
fi

# ---- Medien-Nodes -----------------------------------------------------------------
if [ "$MEDIA" = 1 ]; then
  say "3/4 MXL-Bibliothek und Medien-Nodes bauen (dauert, je nach Rechner 20–60 Minuten)"
  run "\"$ROOT_DIR/deploy/dev/install-mxl.sh\""
  run "make -C \"$ROOT_DIR\" nodes"
else
  say "3/4 Medien-Nodes übersprungen (nachholen: ./install.sh --media)"
fi

# ---- Prüfung ------------------------------------------------------------------------
say "4/4 Prüfung (make preflight)"
run "make -C \"$ROOT_DIR\" preflight || true"

if [ "$START" = 1 ]; then
  say "Starten (make start)"
  run "make -C \"$ROOT_DIR\" start"
  echo; echo "Fertig: http://localhost:8000"
else
  cat <<EOF

Installation abgeschlossen. Nächste Schritte:
  source ~/.bashrc          # (oder neues Terminal) damit go/deno/cargo im PATH sind
  cd $ROOT_DIR && make start
  Browser: http://localhost:8000   (erster Start: Container-Images laden, einige Minuten)
Ports/Firewall und Aufbau: docs/INSTALLATION.md
EOF
fi
