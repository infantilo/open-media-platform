#!/usr/bin/env bash
# Baut das OFFLINE-PAKET für Rechner ohne Internetzugang (docs/OFFLINE-INSTALLATION.md).
# Läuft auf einem Rechner MIT Internet, auf dem OMP schon gebaut ist (./install.sh --media, make nodes),
# idealerweise gleiche Distribution/gleiches Release/gleiche Architektur wie der Zielrechner.
#
# Das Paket enthält FERTIG GEBAUTES (kein Go/Rust/Deno/Compiler auf dem Zielrechner nötig):
#   omp/            Repository-Stand (git) + Binaries (Orchestrator, Supervisor, Host-Agent, alle Nodes aus
#                   deploy/catalog.json), UI-Bundle, libmxl + mxl-Werkzeuge
#   images.tar      Container-Images (NATS, NMOS-Registry, etcd, Patroni/Postgres, optional Caddy/step-ca/MinIO)
#   debs/           Systempakete (nur apt-Systeme): Laufzeit-Pakete samt allen Abhängigkeiten
#   plugins/        GStreamer-Plugin avvideofilter (optional, Blend-Bildratenwandlung)
#   SHA256SUMS, MANIFEST.json, install-offline.sh
#
#   ./deploy/offline/make-offline-bundle.sh [Optionen]
#     --out VERZ                 Zielverzeichnis des Pakets (Standard: ./offline-bundle)
#     --skip-build               nichts neu bauen, vorhandene Binaries nehmen (Standard: Go-Binaries + UI neu bauen;
#                                die Rust-Nodes baut IMMER vorher 'make nodes' — hier nur geprüft)
#     --no-images                keine Container-Images (z. B. wenn der Zielrechner sie anders bekommt)
#     --no-system-packages       keine .deb-Pakete (Zielrechner hat Podman/GStreamer schon)
#     --no-plugin                avvideofilter weglassen
#     --with-pipeline-controller auch das (2 GB große) Image des Pipeline-Controller-Nodes
#     --keep-stage               Arbeitsverzeichnis nicht löschen (Fehlersuche)
#     --dry-run                  nur anzeigen, was gepackt würde
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$HERE/../.." && pwd)"
OUT="$PWD/offline-bundle"; SKIP_BUILD=0; IMAGES=1; DEBS=1; PLUGIN=1; PC_IMAGE=0; KEEP=0; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:?--out braucht ein Verzeichnis}"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --no-images) IMAGES=0; shift ;;
    --no-system-packages) DEBS=0; shift ;;
    --no-plugin) PLUGIN=0; shift ;;
    --with-pipeline-controller) PC_IMAGE=1; shift ;;
    --keep-stage) KEEP=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unbekannte Option: $1 (siehe --help)" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
die()  { echo "FEHLER: $*" >&2; exit 1; }

[ "$(uname -s)" = Linux ] || die "nur Linux"
for t in git tar sha256sum; do have "$t" || die "'$t' fehlt"; done
ARCH="$(uname -m)"
# shellcheck disable=SC1091
. /etc/os-release 2>/dev/null || true
DISTRO="${ID:-unknown}"; DISTRO_VER="${VERSION_ID:-unknown}"
GLIBC="$(ldd --version 2>/dev/null | awk 'NR==1 {print $NF}')"; [ -n "$GLIBC" ] || GLIBC=unknown
GST="$(gst-inspect-1.0 --version 2>/dev/null | awk '/^GStreamer/ {print $2}')"
COMMIT="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
DIRTY=""; [ -z "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=no 2>/dev/null)" ] || DIRTY="-dirty"
VERSION="$(date +%Y.%m.%d)-${COMMIT}${DIRTY}"
NAME="omp-offline-${VERSION}-${ARCH}-${DISTRO}${DISTRO_VER}"
MXL_LIB="$ROOT_DIR/third_party/mxl/build/Linux-GCC-Release"

# Runtime-Pakete (OHNE -dev/Compiler): was der Zielrechner zum Betrieb braucht.
RUNTIME_PKGS_apt="podman uidmap slirp4netns make curl openssl ca-certificates tar zip unzip iproute2 netcat-openbsd
 gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly
 gstreamer1.0-libav gstreamer1.0-nice ffmpeg gstreamer1.0-wpe libwpebackend-fdo-1.0-1"

# Container-Images (wie Makefile 'up'): Name -> Pflicht? (1 = für den Betrieb nötig)
# Die Referenzen (mit Digest) kommen aus deploy/images.env; unten wird der Digest-Bezug gezogen und unter dem Tag-Namen gespeichert.
# shellcheck disable=SC1091
. "$ROOT_DIR/deploy/images.env"
IMAGES_LIST=(
  "$NATS_IMAGE|1"
  "$NMOS_REGISTRY_IMAGE|1"
  "$ETCD_IMAGE|1"
  "localhost/omp-patroni:latest|1"
  "$CADDY_IMAGE|0"
  "$STEP_CA_IMAGE|0"
  "$SEAWEEDFS_IMAGE|0"
)
[ "$PC_IMAGE" = 1 ] && IMAGES_LIST+=("localhost/omp-pipeline-controller:latest|0")

# Binaries aus dem Katalog (runner=process): "../nodes/target/release/omp-x" relativ zu deploy/
mapfile -t CAT_BINS < <(sed -n 's/.*"command": \["\([^"]*\)".*/\1/p' "$ROOT_DIR/deploy/catalog.json" | sort -u)

say "Plan"
echo "    Paketname:     $NAME"
echo "    System:        $DISTRO $DISTRO_VER, $ARCH, glibc $GLIBC, GStreamer ${GST:-?}"
echo "    Binaries:      ${#CAT_BINS[@]} Nodes aus catalog.json + orchestrator/supervisor/host-agent"
echo "    Images:        $([ $IMAGES = 1 ] && echo "${#IMAGES_LIST[@]}" || echo "nein")   Systempakete: $([ $DEBS = 1 ] && echo ja || echo nein)   Plugin: $([ $PLUGIN = 1 ] && echo ja || echo nein)"
echo "    Ausgabe:       $OUT"
[ "$DRY" = 1 ] && { printf '    - %s\n' "${CAT_BINS[@]}"; exit 0; }

# ---- 1. Bauen / prüfen -----------------------------------------------------------------
if [ "$SKIP_BUILD" = 0 ]; then
  say "1/7 Go-Binaries und UI bauen"
  have go || die "go fehlt (oder --skip-build)"; have deno || die "deno fehlt (oder --skip-build)"
  mkdir -p "$ROOT_DIR/bin"
  (cd "$ROOT_DIR/orchestrator" && go build -o "$ROOT_DIR/bin/omp-orchestrator" .)
  (cd "$ROOT_DIR/supervisor" && go build -o "$ROOT_DIR/bin/omp-supervisor" .)
  (cd "$ROOT_DIR/host-agent" && go build -o "$ROOT_DIR/bin/omp-host-agent" .)
  make -C "$ROOT_DIR" ui
else
  say "1/7 Bauen übersprungen (--skip-build)"
fi
missing=0
for f in bin/omp-orchestrator bin/omp-supervisor bin/omp-host-agent ui/dist/shell.js; do
  [ -e "$ROOT_DIR/$f" ] || { echo "    fehlt: $f" >&2; missing=1; }
done
for b in "${CAT_BINS[@]}"; do
  [ -x "$(cd "$ROOT_DIR/deploy" && realpath -m "$b")" ] || { echo "    fehlt: deploy/$b (make nodes?)" >&2; missing=1; }
done
[ -d "$MXL_LIB/lib" ] || { echo "    fehlt: $MXL_LIB/lib (./deploy/dev/install-mxl.sh)" >&2; missing=1; }
[ "$missing" = 0 ] || die "Voraussetzungen fehlen (siehe oben). Erst './install.sh --media' bzw. 'make nodes' ausführen."

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/omp-offline-stage.XXXXXX")"
cleanup() { [ "$KEEP" = 1 ] && echo "Arbeitsverzeichnis: $STAGE" || rm -rf "$STAGE"; }
trap cleanup EXIT
mkdir -p "$STAGE/omp" "$STAGE/plugins" "$STAGE/debs"

# ---- 2. Repository-Stand + Binaries ------------------------------------------------------
say "2/7 Repository-Stand und Binaries"
(cd "$ROOT_DIR" && git ls-files -z --cached --others --exclude-standard | tar --null -T - -cf -) | tar -C "$STAGE/omp" -xf -
mkdir -p "$STAGE/omp/bin" "$STAGE/omp/ui"
cp -a "$ROOT_DIR/bin/omp-orchestrator" "$ROOT_DIR/bin/omp-supervisor" "$ROOT_DIR/bin/omp-host-agent" "$STAGE/omp/bin/"
cp -a "$ROOT_DIR/ui/dist" "$STAGE/omp/ui/dist"
STRIP=""; have strip && STRIP=strip
for b in "${CAT_BINS[@]}"; do
  src="$(cd "$ROOT_DIR/deploy" && realpath -m "$b")"
  dst="$STAGE/omp/${src#"$ROOT_DIR"/}"
  mkdir -p "$(dirname "$dst")"; cp -a "$src" "$dst"
  [ -z "$STRIP" ] || "$STRIP" --strip-debug "$dst" 2>/dev/null || true   # Debug-Symbole sind hunderte MB je Node
done
# libmxl + Werkzeuge (nur Laufzeit, nicht der Build-Baum)
mkdir -p "$STAGE/omp/third_party/mxl/build/Linux-GCC-Release"
cp -a "$MXL_LIB/lib" "$STAGE/omp/third_party/mxl/build/Linux-GCC-Release/lib"
for t in tools/mxl-info/mxl-info tools/mxl-gst/mxl-gst-testsrc tools/mxl-gst/mxl-gst-sink; do
  [ -x "$MXL_LIB/$t" ] && { mkdir -p "$STAGE/omp/third_party/mxl/build/Linux-GCC-Release/$(dirname "$t")"; cp -a "$MXL_LIB/$t" "$STAGE/omp/third_party/mxl/build/Linux-GCC-Release/$t"; }
done
echo "    $(du -sh "$STAGE/omp" | cut -f1) im Repo-Stand + Binaries"

# ---- 3. Container-Images --------------------------------------------------------------------
if [ "$IMAGES" = 1 ]; then
  say "3/7 Container-Images (podman pull/build/save)"
  have podman || die "podman fehlt (oder --no-images)"
  imgs=()
  for e in "${IMAGES_LIST[@]}"; do
    pinned="${e%|*}"; need="${e#*|}"
    img="${pinned%%@*}"                    # gespeichert und geladen wird unter dem Tag-Namen (der Digest bleibt beim Laden nicht erhalten)
    if ! podman image exists "$pinned"; then
      case "$pinned" in
        *@sha256:*) podman pull "$pinned" || { [ "$need" = 1 ] && die "Pflicht-Image $pinned nicht ladbar" || { echo "    $pinned nicht ladbar — übersprungen" >&2; continue; }; } ;;
      esac
    fi
    case "$pinned" in *@sha256:*) podman tag "$pinned" "$img" ;; esac
    if ! podman image exists "$img"; then
      case "$img" in
        localhost/omp-patroni:latest) podman build -t "$img" -f "$ROOT_DIR/deploy/patroni/Dockerfile" "$ROOT_DIR/deploy/patroni" ;;
        localhost/*) echo "    $img fehlt lokal — übersprungen" >&2; continue ;;
        *) podman pull "$img" || { [ "$need" = 1 ] && die "Pflicht-Image $img nicht ladbar" || { echo "    $img nicht ladbar — übersprungen" >&2; continue; }; } ;;
      esac
    fi
    imgs+=("$img")
  done
  printf '%s\n' "${imgs[@]}" > "$STAGE/images.list"
  podman save --multi-image-archive -o "$STAGE/images.tar" "${imgs[@]}"
  echo "    ${#imgs[@]} Images, $(du -sh "$STAGE/images.tar" | cut -f1)"
else
  say "3/7 Container-Images übersprungen"
fi

# ---- 4. Systempakete ---------------------------------------------------------------------------
PKGLIST="$STAGE/packages.txt"
if [ "$DEBS" = 1 ]; then
  say "4/7 Systempakete (.deb samt Abhängigkeiten)"
  if have apt-get && have apt-cache; then
    # Ziel-Pakete (nur solche, die es in dieser Distribution gibt) -> packages.txt; der Zielrechner installiert genau
    # diese BY NAME aus einem lokalen apt-Verzeichnis, apt löst Alternativen selbst auf (alle .deb blind zu
    # installieren scheitert an einander ausschließenden Alternativen, z. B. libqt5gui5 / libqt5gui5-gles).
    : > "$PKGLIST"
    for p in $RUNTIME_PKGS_apt; do apt-cache show --no-all-versions "$p" >/dev/null 2>&1 && echo "$p" >> "$PKGLIST" || echo "    (Paket $p gibt es hier nicht — weggelassen)" >&2; done
    # Abschluss über alle Alternativen laden; nur echte Pakete mit Kandidat (virtuelle Namen/Fremdarchitekturen lassen 'apt-get download' scheitern)
    closure="$(apt-cache depends --recurse --no-recommends --no-suggests --no-conflicts --no-breaks --no-replaces --no-enhances $(cat "$PKGLIST") 2>/dev/null | grep -E '^[a-z0-9]' | sort -u)"
    real=""
    for p in $closure; do
      case "$p" in *:*) continue ;; esac
      apt-cache show --no-all-versions "$p" >/dev/null 2>&1 && real="$real $p"
    done
    (cd "$STAGE/debs" && printf '%s\n' $real | xargs -r -n 40 apt-get download -qq 2>&1 | head -20 || true)
    [ "$(ls "$STAGE/debs" | wc -l)" -gt 0 ] || die "keine .deb geladen (apt-get download fehlgeschlagen?)"
    # lokales apt-Verzeichnis (Packages-Index) + Probe-Auflösung gegen einen LEEREN dpkg-Stand: nur die wirklich
    # nötigen Pakete behalten (Alternativen verwerfen), und sicherstellen, dass alles ohne Konflikt auflösbar ist.
    index() { if have apt-ftparchive; then (cd "$STAGE/debs" && apt-ftparchive packages . > Packages); elif have dpkg-scanpackages; then (cd "$STAGE/debs" && dpkg-scanpackages . /dev/null > Packages 2>/dev/null); else die "weder apt-ftparchive (apt-utils) noch dpkg-scanpackages (dpkg-dev) gefunden"; fi; }
    index
    AT="$STAGE/.aptprobe"; mkdir -p "$AT/state/lists/partial" "$AT/cache/archives/partial" "$AT/etc"; : > "$AT/status"
    echo "deb [trusted=yes] file:$STAGE/debs ./" > "$AT/etc/local.list"
    AOPTS=(-o Dir::State="$AT/state" -o Dir::State::status="$AT/status" -o Dir::Cache="$AT/cache" -o Dir::Etc::sourcelist="$AT/etc/local.list" -o Dir::Etc::sourceparts=/dev/null -o Debug::NoLocking=1 -o Acquire::Languages=none -o APT::Get::List-Cleanup=0)
    apt-get "${AOPTS[@]}" update >/dev/null 2>&1 || die "lokales apt-Verzeichnis nicht lesbar"
    sim="$(apt-get "${AOPTS[@]}" install --simulate --no-download --no-install-recommends $(cat "$PKGLIST") 2>&1)" || { echo "$sim" | tail -15 >&2; die "Pakete lassen sich nicht konfliktfrei auflösen"; }
    needed="$(echo "$sim" | awk '/^Inst / {print $2}')"
    keep=0
    for f in "$STAGE/debs"/*.deb; do
      n="$(dpkg-deb -f "$f" Package)"
      # Here-String statt 'echo | grep -q': unter 'set -o pipefail' liefert die Pipe sonst (SIGPIPE, sobald grep früh
      # beendet) Status 141 und der Treffer gilt als Fehlschlag — dann würden nötige Pakete (tar, debconf …) verworfen.
      if grep -qxF "$n" <<<"$needed"; then keep=$((keep+1)); else rm -f "$f"; fi
    done
    index; gzip -kf "$STAGE/debs/Packages"
    # Gegenprobe auf dem beschnittenen Verzeichnis (leerer dpkg-Stand): muss genauso viele Pakete liefern.
    rm -rf "$AT/state/lists" "$AT/cache"; mkdir -p "$AT/state/lists/partial" "$AT/cache/archives/partial"
    apt-get "${AOPTS[@]}" update >/dev/null 2>&1 || die "beschnittenes Paketverzeichnis nicht lesbar"
    sim2="$(apt-get "${AOPTS[@]}" install --simulate --no-download --no-install-recommends $(cat "$PKGLIST") 2>&1)" || { echo "$sim2" | tail -15 >&2; die "Gegenprobe nach dem Beschneiden fehlgeschlagen (Pakete fehlen)"; }
    [ "$(awk '/^Inst / {n++} END {print n+0}' <<<"$sim2")" = "$keep" ] || die "Gegenprobe: Paketzahl weicht ab"
    rm -rf "$AT"
    echo "    $keep nötige Pakete behalten (Alternativen verworfen)"
    echo "    $(ls "$STAGE/debs" | wc -l) Pakete, $(du -sh "$STAGE/debs" | cut -f1)"
    [ "$(ls "$STAGE/debs" | wc -l)" -gt 0 ] || die "keine .deb geladen (apt-get download fehlgeschlagen?)"
  else
    echo "    kein apt — Paketliste liegt als packages.txt bei, Pakete müssen vorab auf dem Zielrechner installiert sein" >&2
    echo "    (Namen siehe install.sh MEDIA_PKGS_<paketmanager>, ohne -dev/Compiler)" >&2
    echo "$RUNTIME_PKGS_apt" | tr ' ' '\n' > "$PKGLIST"
  fi
else
  say "4/7 Systempakete übersprungen"
  rmdir "$STAGE/debs" 2>/dev/null || true
fi

# ---- 5. Plugin -------------------------------------------------------------------------------------
if [ "$PLUGIN" = 1 ]; then
  say "5/7 Plugin avvideofilter"
  # shellcheck source=../dev/avvideofilter.version
  . "$ROOT_DIR/deploy/dev/avvideofilter.version"
  arc=""
  for c in "$ROOT_DIR/deploy/dev/vendor/$AVF_ASSET" "$HOME/$AVF_ASSET"; do [ -f "$c" ] && { arc="$c"; break; }; done
  if [ -z "$arc" ]; then
    curl -fsSL --retry 2 -o "$STAGE/plugins/$AVF_ASSET" "https://github.com/emcodem/avvideofilter/releases/download/$AVF_VERSION/$AVF_ASSET" \
      || { echo "    Download fehlgeschlagen — Plugin weggelassen" >&2; rm -f "$STAGE/plugins/$AVF_ASSET"; }
  else
    cp -a "$arc" "$STAGE/plugins/$AVF_ASSET"
  fi
  if [ -f "$STAGE/plugins/$AVF_ASSET" ]; then
    got="$(sha256sum "$STAGE/plugins/$AVF_ASSET" | awk '{print $1}')"
    [ "$got" = "$AVF_SHA256" ] || die "SHA256 des Plugin-Archivs stimmt nicht ($got)"
    echo "    $AVF_ASSET ($AVF_VERSION), SHA256 ok"
  fi
else
  say "5/7 Plugin übersprungen"
fi

# ---- 6. Manifest, Installer, Prüfsummen --------------------------------------------------------------
say "6/7 Manifest und Prüfsummen"
cp -a "$HERE/install-offline.sh" "$STAGE/install-offline.sh"; chmod +x "$STAGE/install-offline.sh"
cp -a "$ROOT_DIR/docs/OFFLINE-INSTALLATION.md" "$STAGE/ANLEITUNG.md" 2>/dev/null || true
cat > "$STAGE/MANIFEST.json" <<JSON
{
  "name": "$NAME",
  "version": "$VERSION",
  "gitCommit": "$COMMIT$DIRTY",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "arch": "$ARCH",
  "distro": "$DISTRO",
  "distroVersion": "$DISTRO_VER",
  "glibc": "$GLIBC",
  "gstreamer": "${GST:-}",
  "images": $([ -f "$STAGE/images.list" ] && printf '[%s]' "$(sed 's/.*/"&"/' "$STAGE/images.list" | paste -sd, -)" || echo '[]'),
  "systemPackages": $([ -d "$STAGE/debs" ] && ls "$STAGE/debs" | wc -l || echo 0),
  "plugin": $([ -n "$(ls "$STAGE/plugins" 2>/dev/null)" ] && echo true || echo false)
}
JSON
(cd "$STAGE" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
echo "    $(wc -l < "$STAGE/SHA256SUMS") Dateien in SHA256SUMS"

# ---- 7. Packen --------------------------------------------------------------------------------------------
say "7/7 Packen"
mkdir -p "$OUT"
ARCHIVE="$OUT/$NAME.tar"
if have zstd; then ARCHIVE="$ARCHIVE.zst"; tar -C "$STAGE" -cf - . | nice -n 10 zstd -T2 -3 -q -o "$ARCHIVE" -f
else ARCHIVE="$ARCHIVE.gz"; tar -C "$STAGE" -cf - . | nice -n 10 gzip -3 > "$ARCHIVE"; fi
(cd "$OUT" && sha256sum "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE").sha256")
echo
echo "Fertig: $ARCHIVE ($(du -sh "$ARCHIVE" | cut -f1))"
echo "Prüfsumme: $(cut -d' ' -f1 "$ARCHIVE.sha256")"
echo "Auf den Zielrechner kopieren (USB/scp), dort entpacken und ./install-offline.sh ausführen — docs/OFFLINE-INSTALLATION.md"
