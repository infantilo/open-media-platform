#!/usr/bin/env bash
# OpenMediaPlatform — Installation aus dem OFFLINE-PAKET (kein Internetzugang nötig, nichts wird gebaut).
# Wird aus dem ENTPACKTEN Paketverzeichnis gestartet (dort liegen omp/, images.tar, debs/, SHA256SUMS):
#
#   tar -xf omp-offline-*.tar.zst          (oder --zstd / -z je nach Endung)
#   cd <entpacktes Verzeichnis>
#   ./install-offline.sh [Optionen]
#
#   --target VERZ          Installationsverzeichnis (Standard: ~/OpenMediaPlatform; vorhandene Installation = Update,
#                          Daten/Einstellungen/Geheimnisse bleiben)
#   --no-system-packages   keine .deb-Pakete installieren (Podman/GStreamer/make sind schon da)
#   --no-images            Container-Images nicht laden
#   --host-agent-service --orchestrator IP [--label NAME] [--token TOKEN]
#                          diesen Rechner als zusätzlichen Host anbinden (Dienst "omp-host-agent", wie install.sh)
#   --systemd              OMP beim Boot automatisch starten (systemd-Dienst "omp", braucht sudo)
#   --start                danach gleich starten (make start)
#   --force                Prüfung von Distribution/Architektur/glibc nur als Warnung behandeln
#   --yes                  keine Rückfragen
#   --dry-run              nur anzeigen, was getan würde
#
# Was das Skript tut (und nur das): Prüfsummen prüfen → Zielrechner prüfen → (apt) Systempakete aus debs/ installieren
# (sudo) → Dateien nach --target kopieren → mxl.env erzeugen → Images laden → Plugin avvideofilter installieren.
# Es greift NIE auf das Netz zu, öffnet keine Firewall-Ports und läuft nicht als root.
set -euo pipefail

BUNDLE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$HOME/OpenMediaPlatform"; SYSPKG=1; IMAGES=1; SYSTEMD=0; START=0; FORCE=0; YES=0; DRY=0; AGENT_SVC=0; ORCH_IP=""; AGENT_LABEL=""; AGENT_TOKEN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:?--target braucht ein Verzeichnis}"; shift 2 ;;
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
    *) echo "Unbekannte Option: $1 (siehe --help)" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
run()  { if [ "$DRY" = 1 ]; then echo "    [dry-run] $*"; else eval "$*"; fi; }
die()  { echo "FEHLER: $*" >&2; exit 1; }
warn() { echo "Warnung: $*" >&2; }
confirm() { [ "$YES" = 1 ] || [ "$DRY" = 1 ] || { read -r -p "$1 [J/n] " a; case "${a:-J}" in n|N) return 1 ;; esac; }; }
vge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }   # $1 >= $2
mf() { sed -n "s/^ *\"$1\": *\"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\}$/\1/p" "$BUNDLE/MANIFEST.json" | head -1; }

[ "$(uname -s)" = Linux ] || die "nur Linux"
[ "$(id -u)" != 0 ] || die "bitte NICHT als root ausführen (Podman läuft rootless; sudo wird bei Bedarf selbst benutzt)"
[ -f "$BUNDLE/MANIFEST.json" ] && [ -d "$BUNDLE/omp" ] || die "$BUNDLE ist kein entpacktes Offline-Paket (MANIFEST.json/omp fehlen) — Skript aus dem entpackten Verzeichnis starten"

# ---- 1. Paket prüfen --------------------------------------------------------------------------------------
say "1/7 Paket prüfen"
echo "    Paket:  $(mf name)  (Commit $(mf gitCommit), gebaut $(mf builtAt))"
if [ -f "$BUNDLE/SHA256SUMS" ]; then
  if (cd "$BUNDLE" && sha256sum --check --quiet SHA256SUMS); then echo "    alle Dateien stimmen mit SHA256SUMS überein"
  else die "Prüfsummen stimmen NICHT — Paket beschädigt oder verändert (Übertragung wiederholen)"; fi
else
  die "SHA256SUMS fehlt — Paket unvollständig"
fi

# ---- 2. Zielrechner prüfen -----------------------------------------------------------------------------------
say "2/7 Zielrechner prüfen"
ARCH="$(uname -m)"; # shellcheck disable=SC1091
. /etc/os-release 2>/dev/null || true
GLIBC="$(ldd --version 2>/dev/null | awk 'NR==1 {print $NF}')"; [ -n "$GLIBC" ] || GLIBC=0
problems=0
chk() { # was, ist, soll
  if [ "$2" = "$3" ]; then echo "    ok   $1: $2"; else
    if [ "$FORCE" = 1 ]; then warn "$1: hier $2, Paket gebaut für $3 (--force)"; else echo "    FEHLT $1: hier $2, Paket gebaut für $3" >&2; problems=1; fi
  fi
}
chk Architektur "$ARCH" "$(mf arch)"
chk Distribution "${ID:-?}" "$(mf distro)"
if [ "${VERSION_ID:-?}" = "$(mf distroVersion)" ]; then echo "    ok   Release: ${VERSION_ID:-?}"; else warn "Release ${VERSION_ID:-?} statt $(mf distroVersion) — Systempakete/Bibliotheken passen eventuell nicht"; fi
if [ "$(mf glibc)" != unknown ] && ! vge "$GLIBC" "$(mf glibc)"; then
  if [ "$FORCE" = 1 ]; then warn "glibc $GLIBC ist älter als beim Bau ($(mf glibc))"; else echo "    FEHLT glibc: hier $GLIBC, Paket braucht mindestens $(mf glibc)" >&2; problems=1; fi
fi
[ "$problems" = 0 ] || die "Zielrechner passt nicht zum Paket. Ein Paket für genau diese Distribution/Architektur bauen (make-offline-bundle.sh) — oder mit --force auf eigene Gefahr."

# ---- 3. Systempakete -------------------------------------------------------------------------------------------
say "3/7 Systempakete"
if [ "$SYSPKG" = 1 ] && [ -d "$BUNDLE/debs" ] && have apt-get; then
  n="$(ls "$BUNDLE/debs"/*.deb 2>/dev/null | wc -l)"
  echo "    $n Pakete aus debs/ (lokales apt-Verzeichnis, nichts wird aus dem Netz geladen)"
  confirm "    Die Pakete aus packages.txt samt Abhängigkeiten jetzt mit sudo installieren?" || die "abgebrochen"
  # Nur DIESES Verzeichnis als Paketquelle (apt löst Alternativen selbst auf; bereits installierte Pakete bleiben).
  APTDIR="$(mktemp -d)"; echo "deb [trusted=yes] file:$BUNDLE/debs ./" > "$APTDIR/local.list"
  AOPTS="-o Dir::Etc::sourcelist=$APTDIR/local.list -o Dir::Etc::sourceparts=/dev/null -o APT::Get::List-Cleanup=0 -o Acquire::Languages=none"
  run "sudo apt-get $AOPTS update"
  run "sudo apt-get $AOPTS install -y --no-install-recommends --no-download $(tr '\n' ' ' < "$BUNDLE/packages.txt")"
  rm -rf "$APTDIR"
elif [ "$SYSPKG" = 1 ] && [ -d "$BUNDLE/debs" ]; then
  warn "kein apt — Pakete aus packages.txt müssen vorab installiert sein (Podman, make, curl, openssl, GStreamer base/good/bad/ugly/libav)"
else
  echo "    übersprungen"
fi
missing=""
for t in podman make curl openssl tar gst-inspect-1.0; do have "$t" || missing="$missing $t"; done
[ -z "$missing" ] || [ "$DRY" = 1 ] || die "es fehlen:$missing — Systempakete installieren (ohne --no-system-packages bzw. aus packages.txt)"
# rootless Podman braucht subuid/subgid
if ! grep -q "^$(id -un):" /etc/subuid 2>/dev/null; then
  echo "    subuid/subgid für $(id -un) anlegen (rootless Podman)"
  run "sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $(id -un) && podman system migrate"
fi

# ---- 4. Dateien kopieren --------------------------------------------------------------------------------------------
say "4/7 Dateien nach $TARGET"
if [ -f "$TARGET/.run/orchestrator.pid" ] && kill -0 "$(cat "$TARGET/.run/orchestrator.pid")" 2>/dev/null; then
  die "OMP läuft in $TARGET — erst stoppen (cd $TARGET && make stop), dann erneut installieren"
fi
if [ -e "$TARGET/Makefile" ]; then
  echo "    vorhandene Installation → Update (Daten, .run, .backups, deploy/dev/*.env bleiben erhalten)"
  if [ "$DRY" != 1 ] && [ -d "$TARGET/bin" ]; then
    bk="$TARGET/.offline-previous"; rm -rf "$bk"; mkdir -p "$bk"
    cp -a "$TARGET/bin" "$bk/bin" 2>/dev/null || true
    echo "    bisherige bin/ gesichert in $bk (Rückfall: bin/ zurückkopieren)"
  fi
fi
run "mkdir -p \"$TARGET\" && tar -C \"$BUNDLE/omp\" -cf - . | tar -C \"$TARGET\" -xf -"
# Marke: fertige Binaries, nie bauen (start-omp.sh/start-supervisor.sh/preflight lesen sie)
run "printf 'offline-paket %s\\ninstalliert %s\\n' \"$(mf name)\" \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\" > \"$TARGET/.offline-install\""
run "chmod +x \"$TARGET\"/bin/* \"$TARGET\"/deploy/dev/*.sh \"$TARGET\"/deploy/offline/*.sh 2>/dev/null || true"

# ---- 5. mxl.env ---------------------------------------------------------------------------------------------------------
say "5/7 MXL-Umgebung (deploy/dev/mxl.env)"
MXLB="$TARGET/third_party/mxl/build/Linux-GCC-Release"
if [ "$DRY" != 1 ]; then
  cat > "$TARGET/deploy/dev/mxl.env" <<ENV
# Erzeugt von deploy/offline/install-offline.sh (Offline-Paket). Vor jedem MXL-nutzenden Node/Tool sourcen
# (setzt LD_LIBRARY_PATH für libmxl.so, das omp-mediaios mxl-Modul zur Laufzeit lädt).
export OMP_MXL_DOMAIN="/dev/shm/omp-mxl"
export LD_LIBRARY_PATH="$MXLB/lib:$MXLB/lib/fabrics/ofi:\${LD_LIBRARY_PATH:-}"
export MXL_INFO_BIN="$MXLB/tools/mxl-info/mxl-info"
export MXL_GST_TESTSRC_BIN="$MXLB/tools/mxl-gst/mxl-gst-testsrc"
export MXL_GST_SINK_BIN="$MXLB/tools/mxl-gst/mxl-gst-sink"
ENV
  echo "    geschrieben"
else echo "    [dry-run] mxl.env"; fi

# ---- 6. Container-Images -------------------------------------------------------------------------------------------------
say "6/7 Container-Images"
if [ "$IMAGES" = 1 ] && [ -f "$BUNDLE/images.tar" ]; then
  run "podman load -i \"$BUNDLE/images.tar\""
else
  echo "    übersprungen$([ -f "$BUNDLE/images.tar" ] || echo ' (Paket enthält keine Images — vorab bereitstellen: podman load -i …)')"
fi

# ---- 7. Plugin avvideofilter ---------------------------------------------------------------------------------------------
say "7/7 Plugin avvideofilter (Blend-Bildratenwandlung, optional)"
arc="$(ls "$BUNDLE"/plugins/*.tar.gz 2>/dev/null | head -1 || true)"
if [ -n "$arc" ]; then
  run "\"$TARGET/deploy/dev/install-avvideofilter.sh\" --archive \"$arc\" || true"
else
  echo "    nicht im Paket — Nodes nutzen videorate"
fi

# ---- systemd + Abschluss -----------------------------------------------------------------------------------------------------
if [ "$SYSTEMD" = 1 ]; then
  say "systemd-Dienst: OMP beim Boot starten"
  have systemctl || die "systemd nicht gefunden"
  run "sed -e 's#@USER@#$(id -un)#g' -e 's#@ROOT@#$TARGET#g' -e 's#@UID@#$(id -u)#g' -e 's#@HOME@#$HOME#g' \"$TARGET/deploy/systemd/omp.service\" | sudo tee /etc/systemd/system/omp.service >/dev/null"
  run "sudo loginctl enable-linger $(id -un) && sudo systemctl daemon-reload && sudo systemctl enable omp"
  echo "    Start jetzt: sudo systemctl start omp   (Log: journalctl -u omp, $TARGET/.run/orchestrator.log)"
fi

if [ "$AGENT_SVC" = 1 ]; then
  say "systemd-Dienst: Host-Agent (zusätzlicher Host)"
  have systemctl || die "systemd nicht gefunden"
  [ -n "$ORCH_IP" ] || die "--host-agent-service braucht --orchestrator <IP des Hauptrechners>"
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
  echo "    Erststart: einmalig ein Bootstrap-Token (UI → Hosts → Host hinzufügen) mit --token übergeben. Log: journalctl -u omp-host-agent"
fi

say "Prüfung (make preflight)"
run "make -C \"$TARGET\" preflight || true"

if [ "$START" = 1 ]; then
  say "Starten (make start)"
  run "make -C \"$TARGET\" start"
  echo; echo "Fertig: http://localhost:8000"
else
  cat <<EOM

Installation abgeschlossen. Nächste Schritte:
  cd $TARGET && make start        # danach im Browser: http://localhost:8000
  Erster Start: sofort einen Admin anlegen (Administration → Nutzer) — docs/INSTALLATION.md §2.
  Anleitung/Fehlersuche: docs/OFFLINE-INSTALLATION.md
EOM
fi
