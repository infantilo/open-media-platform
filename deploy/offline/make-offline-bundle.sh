#!/usr/bin/env bash
# Baut das OFFLINE-PAKET für Rechner ohne Internetzugang (docs/OFFLINE-INSTALLATION.md).
# Läuft auf einem Rechner MIT Internet, auf dem OMP schon gebaut ist (./install.sh --media, make nodes),
# idealerweise gleiche Distribution/gleiches Release/gleiche Architektur wie der Zielrechner.
#
# Das Paket enthält FERTIG GEBAUTES (kein Go/Rust/Deno/Compiler auf dem Zielrechner nötig):
#   omp/            Repository-Stand (git) + Binaries (Orchestrator, Supervisor, Host-Agent, alle Nodes aus
#                   deploy/catalog.json), UI-Bundle, libmxl + mxl-Werkzeuge
#   images.tar      Container-Images (NATS, NMOS-Registry, etcd, Patroni/Postgres, optional Caddy/step-ca/MinIO)
#   node-images.tar Node-Pakete als Images MIT ihren Modellen (Auto-Untertitel: whisper.cpp + Modelle + Sprechererkennung),
#                   node-packages.json (Katalogeinträge; Import nach dem Start: deploy/offline/import-node-packages.sh)
#   debs/ | rpms/   Systempakete: Laufzeit-Pakete samt allen Abhängigkeiten (apt: debs/, dnf/Rocky: rpms/ als lokales Repo)
#   plugins/        GStreamer-Plugin avvideofilter (optional, Blend-Bildratenwandlung)
#   SHA256SUMS, MANIFEST.json, install-offline.sh
#
#   ./deploy/offline/make-offline-bundle.sh [Optionen]
#     --out VERZ                 Zielverzeichnis des Pakets (Standard: ./offline-bundle)
#     --skip-build               nichts neu bauen, vorhandene Binaries nehmen (Standard: Go-Binaries + UI neu bauen;
#                                die Rust-Nodes baut IMMER vorher 'make nodes' — hier nur geprüft)
#     --no-images                keine Container-Images (z. B. wenn der Zielrechner sie anders bekommt)
#     --no-node-images           keine Node-Pakete (NICHT empfohlen: dann fehlen Untertitel-Engine und Modelle ohne Netz)
#     --build-node-images        fehlende Node-Pakete bauen (deploy/<Typ>/build.sh)
#     --node-package TYP         weiteres Node-Paket (omp-ograf | omp-intercom | omp-ffmpeg-sandbox)
#     --images-dir VERZ          Images aus einem vorab mit save-images.sh erzeugten Verzeichnis nehmen (statt podman zu benutzen;
#                                so baut make-rocky-bundle.sh im Wegwerf-Container)
#     --only-system-packages     NUR das Systempaket-Verzeichnis (debs/ bzw. rpms/ + packages.txt) nach --out erzeugen und prüfen (Test, Nachlieferung)
#     --with-rpmfusion           (dnf) RPM Fusion Free dazunehmen: x264, libav (H.264/HEVC/AAC), ffmpeg — Codec-Lizenzen beachten
#     --no-system-packages       keine .deb-Pakete (Zielrechner hat Podman/GStreamer schon)
#     --no-plugin                avvideofilter weglassen
#     --keep-stage               Arbeitsverzeichnis nicht löschen (Fehlersuche)
#     --dry-run                  nur anzeigen, was gepackt würde
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$HERE/../.." && pwd)"
OUT="$PWD/offline-bundle"; SKIP_BUILD=0; IMAGES=1; NODE_IMAGES=1; BUILD_NODE=0; NODE_PKG_ARGS=(); IMAGES_DIR=""; RPMFUSION=0; ONLYPKG=0; DEBS=1; PLUGIN=1; KEEP=0; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:?--out braucht ein Verzeichnis}"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --no-images) IMAGES=0; shift ;;
    --no-node-images) NODE_IMAGES=0; shift ;;
    --build-node-images) BUILD_NODE=1; shift ;;
    --node-package) NODE_PKG_ARGS+=(--node-package "${2:?--node-package braucht einen Typ}"); shift 2 ;;
    --images-dir) IMAGES_DIR="${2:?--images-dir braucht ein Verzeichnis}"; shift 2 ;;
    --with-rpmfusion) RPMFUSION=1; shift ;;
    --only-system-packages) ONLYPKG=1; SKIP_BUILD=1; shift ;;
    --no-system-packages) DEBS=0; shift ;;
    --no-plugin) PLUGIN=0; shift ;;
    --keep-stage) KEEP=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,35p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
GST="$(gst-inspect-1.0 --version 2>/dev/null | awk '/^GStreamer/ {print $2}' || true)"
COMMIT="${OMP_COMMIT:-$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)}"
DIRTY="${OMP_DIRTY:-}"; [ -n "${OMP_COMMIT:-}" ] || [ -z "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=no 2>/dev/null)" ] || DIRTY="-dirty"
VERSION="$(date +%Y.%m.%d)-${COMMIT}${DIRTY}"
NAME="omp-offline-${VERSION}-${ARCH}-${DISTRO}${DISTRO_VER}"
MXL_LIB="$ROOT_DIR/third_party/mxl/build/Linux-GCC-Release"

# Runtime-Pakete (OHNE -dev/Compiler): was der Zielrechner zum Betrieb braucht.
RUNTIME_PKGS_apt="podman uidmap slirp4netns make curl openssl ca-certificates tar zip unzip iproute2 netcat-openbsd
 gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly
 gstreamer1.0-libav gstreamer1.0-nice ffmpeg gstreamer1.0-wpe libwpebackend-fdo-1.0-1"

# dnf (Rocky/RHEL 9): kein "curl" in der Liste — Rocky bringt curl-minimal mit, das mit "curl" kollidiert. Namen aus Rocky AppStream/CRB + EPEL. Ohne RPM Fusion fehlen x264/libav (H.264/HEVC/AAC über GStreamer);
# H.264 geht dann nur über openh264. Das WPE-Plugin (HTML-Grafik per wpesrc) gibt es unter Rocky nicht.
RUNTIME_PKGS_dnf="podman shadow-utils slirp4netns make openssl ca-certificates tar zip unzip zstd iproute nmap-ncat python3 chrony linuxptp
 gstreamer1 gstreamer1-plugins-base gstreamer1-plugins-good gstreamer1-plugins-bad-free gstreamer1-plugins-ugly-free libnice-gstreamer1
 ffmpeg-free gstreamer1-plugin-openh264 libwpe wpebackend-fdo rdma-core libfabric"
RUNTIME_PKGS_dnf_rpmfusion="gstreamer1-libav gstreamer1-plugins-ugly ffmpeg x264-libs"

# Binaries aus dem Katalog (runner=process): "../nodes/target/release/omp-x" relativ zu deploy/
mapfile -t CAT_BINS < <(sed -n 's/.*"command": \["\([^"]*\)".*/\1/p' "$ROOT_DIR/deploy/catalog.json" | sort -u)

say "Plan"
echo "    Paketname:     $NAME"
echo "    System:        $DISTRO $DISTRO_VER, $ARCH, glibc $GLIBC, GStreamer ${GST:-?}"
echo "    Binaries:      ${#CAT_BINS[@]} Nodes aus catalog.json + orchestrator/supervisor/host-agent"
echo "    Images:        $([ $IMAGES = 1 ] && echo ja || echo nein)   Node-Pakete (Modelle): $([ $NODE_IMAGES = 1 ] && echo ja || echo nein)   Systempakete: $([ $DEBS = 1 ] && echo ja || echo nein)   Plugin: $([ $PLUGIN = 1 ] && echo ja || echo nein)"
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
if [ "$ONLYPKG" = 0 ]; then
for f in bin/omp-orchestrator bin/omp-supervisor bin/omp-host-agent ui/dist/shell.js; do
  [ -e "$ROOT_DIR/$f" ] || { echo "    fehlt: $f" >&2; missing=1; }
done
for b in "${CAT_BINS[@]}"; do
  [ -x "$(cd "$ROOT_DIR/deploy" && realpath -m "$b")" ] || { echo "    fehlt: deploy/$b (make nodes?)" >&2; missing=1; }
done
[ -d "$MXL_LIB/lib" ] || { echo "    fehlt: $MXL_LIB/lib (./deploy/dev/install-mxl.sh)" >&2; missing=1; }
fi
[ "$missing" = 0 ] || die "Voraussetzungen fehlen (siehe oben). Erst './install.sh --media' bzw. 'make nodes' ausführen."

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/omp-offline-stage.XXXXXX")"
cleanup() { [ "$KEEP" = 1 ] && echo "Arbeitsverzeichnis: $STAGE" || rm -rf "$STAGE"; }
trap cleanup EXIT
mkdir -p "$STAGE/omp" "$STAGE/plugins" "$STAGE/debs"

if [ "$ONLYPKG" = 0 ]; then
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

# ---- 3. Container-Images + Node-Pakete ----------------------------------------------------------------------
# save-images.sh sichert die Plattform-Images und die Node-Pakete (Image samt Modellen). Mit --images-dir kommen sie
# fertig von außen (Wegwerf-Container ohne Podman-Zugriff auf den Host).
if [ -n "$IMAGES_DIR" ]; then
  say "3/7 Images aus $IMAGES_DIR"
  for f in images.tar images.list node-images.tar node-images.list node-packages.json; do [ -f "$IMAGES_DIR/$f" ] && cp -a "$IMAGES_DIR/$f" "$STAGE/$f"; done
  [ "$NODE_IMAGES" = 0 ] || [ -f "$STAGE/node-images.tar" ] || die "$IMAGES_DIR enthält keine Node-Pakete (node-images.tar) — save-images.sh ohne --no-node-images ausführen"
elif [ "$IMAGES" = 1 ] || [ "$NODE_IMAGES" = 1 ]; then
  say "3/7 Container-Images und Node-Pakete (save-images.sh)"
  have podman || die "podman fehlt (oder --no-images --no-node-images)"
  sargs=(--out "$STAGE")
  [ "$IMAGES" = 1 ] || sargs+=(--no-images)
  [ "$NODE_IMAGES" = 1 ] || sargs+=(--no-node-images)
  [ "$BUILD_NODE" = 0 ] || sargs+=(--build-node-images)
  "$HERE/save-images.sh" "${sargs[@]}" "${NODE_PKG_ARGS[@]}"
else
  say "3/7 Container-Images übersprungen"
fi
[ ! -f "$STAGE/node-images.tar" ] || [ -f "$STAGE/node-packages.json" ] || die "node-packages.json fehlt neben node-images.tar"
# Zusatzdaten außerhalb des Repos, die Nodes zur Laufzeit lesen (liegen nicht in git): Grafikvorlagen
if [ -d "$ROOT_DIR/data/ograf-templates" ]; then
  mkdir -p "$STAGE/omp/data"; cp -a "$ROOT_DIR/data/ograf-templates" "$STAGE/omp/data/ograf-templates"
  echo "    Grafikvorlagen: data/ograf-templates ($(du -sh "$STAGE/omp/data/ograf-templates" | cut -f1))"
fi
[ -f "$STAGE/node-packages.json" ] && cp -a "$STAGE/node-packages.json" "$STAGE/omp/deploy/offline/node-packages.json"

fi  # ONLYPKG

# ---- 4. Systempakete ---------------------------------------------------------------------------
PKGLIST="$STAGE/packages.txt"
if [ "$DEBS" = 1 ]; then
  say "4/7 Systempakete (.deb/.rpm samt Abhängigkeiten)"
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
  elif have dnf && have rpm; then
    # Rocky/RHEL: lokales RPM-Repository (rpms/ + createrepo_c). Der Zielrechner installiert die Namen aus packages.txt
    # NUR aus diesem Verzeichnis (--disablerepo='*'). --alldeps lädt auch, was auf dem Build-Rechner schon installiert ist.
    RP="$RUNTIME_PKGS_dnf"; [ "$RPMFUSION" = 0 ] || RP="$RP $RUNTIME_PKGS_dnf_rpmfusion"
    mkdir -p "$STAGE/rpms"; : > "$PKGLIST"
    for p in $RP; do
      if dnf -q list --available "$p" >/dev/null 2>&1 || dnf -q list --installed "$p" >/dev/null 2>&1; then echo "$p" >> "$PKGLIST"
      else echo "    (Paket $p gibt es in den eingerichteten Repositories nicht — weggelassen)" >&2; fi
    done
    [ -s "$PKGLIST" ] || die "keine der Laufzeit-Pakete in den dnf-Repositories gefunden (CRB/EPEL aktiv?)"
    have createrepo_c || die "createrepo_c fehlt (dnf install createrepo_c)"
    # shellcheck disable=SC2046
    dnf -q download --resolve --alldeps --destdir "$STAGE/rpms" --arch "$ARCH,noarch" $(cat "$PKGLIST") || die "dnf download fehlgeschlagen"
    [ "$(ls "$STAGE/rpms" | wc -l)" -gt 0 ] || die "keine .rpm geladen"
    # Signaturen gegen die auf dem Build-Rechner importierten Schlüssel prüfen (nichts Unsigniertes/Fremdes ins Paket)
    bad="$(rpm -K "$STAGE"/rpms/*.rpm 2>&1 | grep -v -E 'digests signatures OK$|signatures OK$|digests OK$' || true)"
    [ -z "$bad" ] || { echo "$bad" | head -10 >&2; die "RPM-Signaturprüfung fehlgeschlagen (Schlüssel importiert? rpm --import /etc/pki/rpm-gpg/*)"; }
    createrepo_c -q "$STAGE/rpms"
    # Gegenprobe: gegen einen LEEREN Installationsstand nur aus diesem Repo auflösen und die RPM-Transaktion testen
    PR="$(mktemp -d)"; mkdir -p "$PR/root"
    # shellcheck disable=SC2046
    dnf -q --installroot="$PR/root" --releasever="${DISTRO_VER%%.*}" --disablerepo='*' --repofrompath="omp-probe,file://$STAGE/rpms" --enablerepo=omp-probe \
        --nogpgcheck --setopt=install_weak_deps=False --setopt=tsflags=test --assumeyes install $(cat "$PKGLIST") >"$PR/probe.log" 2>&1 \
      || { tail -15 "$PR/probe.log" >&2; rm -rf "$PR"; die "Pakete lassen sich aus dem lokalen Repo nicht konfliktfrei installieren (Gegenprobe)"; }
    rm -rf "$PR"
    echo "    $(ls "$STAGE/rpms" | wc -l) Pakete, $(du -sh "$STAGE/rpms" | cut -f1) (Signaturen ok, Gegenprobe ok)"
  else
    echo "    weder apt noch dnf — Paketliste liegt als packages.txt bei, Pakete müssen vorab auf dem Zielrechner installiert sein" >&2
    echo "    (Namen siehe install.sh MEDIA_PKGS_<paketmanager>, ohne -dev/Compiler)" >&2
    echo "$RUNTIME_PKGS_apt" | tr ' ' '\n' > "$PKGLIST"
  fi
else
  say "4/7 Systempakete übersprungen"
  rmdir "$STAGE/debs" 2>/dev/null || true
fi

rmdir "$STAGE/debs" 2>/dev/null || true
if [ "$ONLYPKG" = 1 ]; then
  mkdir -p "$OUT"; for d in debs rpms; do [ -d "$STAGE/$d" ] && rm -rf "$OUT/$d" && cp -a "$STAGE/$d" "$OUT/$d"; done
  [ -f "$PKGLIST" ] && cp -a "$PKGLIST" "$OUT/packages.txt"
  echo "Systempakete: $OUT"; exit 0
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
  "pkgManager": "$([ -d "$STAGE/rpms" ] && echo dnf || { [ -d "$STAGE/debs" ] && echo apt || echo none; })",
  "systemPackages": $({ ls "$STAGE/debs" 2>/dev/null || ls "$STAGE/rpms" 2>/dev/null; } | wc -l),
  "rpmfusion": $([ "$RPMFUSION" = 1 ] && echo true || echo false),
  "nodePackages": $([ -f "$STAGE/node-packages.json" ] && cat "$STAGE/node-packages.json" | tr -d '\n' || echo '[]'),
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
