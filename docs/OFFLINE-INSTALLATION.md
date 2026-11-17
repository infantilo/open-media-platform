# Offline-Installation (Rechner ohne Internetzugang)

Für Rechner, die **nie** ins Internet kommen (Sendezentrale, abgeschottetes Netz). Statt auf dem Zielrechner zu
bauen (Go, Rust, Deno, MXL-Quellen, Container-Pulls — alles braucht Internet), wird auf einem **Rechner mit
Internet ein fertiges Paket gebaut**, per USB-Stick/`scp` übertragen und auf dem Zielrechner **ohne Netz** installiert.
Auf dem Zielrechner sind **kein Go, Rust, Deno, Compiler und kein Git** nötig.

```
 Rechner MIT Internet                               Zielrechner OHNE Internet
 ./deploy/offline/make-offline-bundle.sh   ──USB──▶  tar -x … && ./install-offline.sh
        → omp-offline-….tar.zst                              → make start
```

## 1. Was ist im Paket?

| Teil | Inhalt |
|---|---|
| `omp/` | Repository-Stand (inkl. Handbücher) + **fertige Binaries**: Orchestrator, Supervisor, Host-Agent und alle Nodes aus `deploy/catalog.json` (Debug-Symbole entfernt), UI-Bundle, libmxl + MXL-Werkzeuge |
| `images.tar` | Container-Images: NATS, NMOS-Registry, etcd, Patroni/Postgres (Pflicht); Caddy, step-ca, SeaweedFS-S3 (optional/Funktionen wie HTTPS, mTLS, Storage) |
| `node-images.tar`, `omp/deploy/offline/node-packages.json` | **Node-Pakete samt Modellen**: Auto-Untertitel als ein Image mit Node + whisper.cpp-Engine + Modellen (`small`, `base`) + Sprechererkennung (sherpa-onnx + Modelle). Nach dem Start einmal `deploy/offline/import-node-packages.sh` (der Installer mit `--start` macht das selbst) |
| `debs/` bzw. `rpms/` | Systempakete: **apt** → `debs/` (lokales apt-Verzeichnis), **dnf (Rocky/RHEL 9)** → `rpms/` (lokales Repository): Podman, GStreamer-Laufzeit samt Plugins, ffmpeg, chrony/linuxptp, make, curl … **mit allen Abhängigkeiten** (kein `-dev`, keine Compiler) |
| `plugins/` | GStreamer-Plugin `avvideofilter` (Blend-Bildratenwandlung, optional — `docs/INSTALLATION.md` §9) |
| `SHA256SUMS`, `MANIFEST.json` | Prüfsummen aller Dateien; Distribution, Release, Architektur, glibc des Build-Rechners |
| `install-offline.sh`, `ANLEITUNG.md` | Installer für den Zielrechner, diese Anleitung |

### Modelle und Daten, die ohne Netz mitkommen müssen (Prüfliste)

| Node / Funktion | Braucht | Wo es im Paket liegt | Prüfung beim Bau |
|---|---|---|---|
| Auto-Untertitel (`omp-subtitle-asr`) | whisper.cpp-Engine, Modelle `ggml-small`/`ggml-base`, Sprechererkennung (Segmentierungs- und Einbettungsmodell) | im Image `localhost/omp-subtitle-asr:<Version>` (`node-images.tar`), läuft im Container | `save-images.sh` startet das Image und bricht ab, wenn eine dieser Dateien fehlt oder leer ist |
| OGraf-Grafik (`omp-ograf`) | Grafikvorlagen (liegen nicht in git) | `omp/data/ograf-templates` | wird mitkopiert, wenn vorhanden |
| Gebärdensprach-Avatar (`omp-sign-avatar`) | Lexikon/Regeln (eigene Daten, `deploy/sign/*.example.json` als Muster) | nicht mitgeliefert — **fachliche Inhalte des Betreibers**, kein Download | — |
| Video folgt Audio (`omp-vfa-vision`) | Kaskaden-Dateien | im Repo (`nodes/omp-vfa-vision/cascade`) | im Repo-Stand enthalten |
| Oberfläche | Schriften, Skripte | im UI-Bundle, **keine** CDN-Zugriffe (geprüft: keine externen Adressen in `ui/` und den Node-Oberflächen) | — |
| Plugin `avvideofilter` | Binärpaket | `plugins/` (Debian); unter Rocky nicht mitgeliefert (gebaut für glibc 2.35, Rocky 9 hat 2.34) — die Nodes nutzen dann `videorate` | — |

Weitere Modelle (z. B. `medium`, `large-v3` für Whisper) müssen **vor** dem Bau in `data/asr-engine/models` liegen
(`sh tools/asr-engine/install.sh medium`) und das Image neu gebaut werden (`sh deploy/subtitle-asr/build.sh`); danach
`save-images.sh`/`make-offline-bundle.sh --build-node-images`.

**Nicht** im Paket: der Pipeline-Controller-Node (2 GB-Image; `--with-pipeline-controller` nimmt es mit),
Cloud-Zugangsdaten, eure Daten (Nutzer, Layouts, Workflows liegen in Postgres und werden nicht mitgeliefert).

## 2. Voraussetzungen

| | Build-Rechner (mit Internet) | Zielrechner (ohne) |
|---|---|---|
| Betriebssystem | Linux, **gleiche Distribution, gleiches Release und gleiche Architektur wie der Zielrechner** (z. B. beide Debian 12 x86_64) | wie links |
| Software | OMP vollständig gebaut: `./install.sh --media` (bzw. `make nodes`), Podman, `git`, `tar`; für Systempakete `apt` | nur ein Standard-Linux mit `sudo`; alles Weitere kommt aus dem Paket |
| Plattenplatz | ca. 10 GB frei (Arbeitsverzeichnis + Paket) | ≥ 10 GB (Images, Binaries, Postgres) |
| RAM | — | Grundsystem ≥ 2 GB, mit Medien-Nodes ≥ 8 GB |

Warum gleiche Distribution/gleiches Release? Die Binaries sind gegen die glibc und die GStreamer-Bibliotheken des
Build-Rechners gelinkt; die mitgelieferten `.deb` passen nur zu diesem Release. Der Installer prüft das und bricht bei
Abweichung ab (`--force` macht daraus eine Warnung — auf eigene Gefahr). Hat der Zielrechner eine **andere**
Distribution, einen Build-Rechner dieser Distribution verwenden (z. B. eine VM).

## 3. Paket bauen (Rechner mit Internet)

```sh
cd OpenMediaPlatform
./install.sh --media                          # falls noch nicht gebaut (einmalig, 20–60 min)
./deploy/offline/make-offline-bundle.sh --out ~/offline
```

Ergebnis in `~/offline/`: `omp-offline-<Datum>-<Commit>-<Arch>-<Distribution><Release>.tar.zst` (oder `.tar.gz`, wenn
`zstd` fehlt) und eine `.sha256`-Datei. Größenordnung (gemessen, Debian 12): **ca. 0,8 GB** komprimiert (Binaries ≈ 200 MB, 7 Images ≈ 0,95 GB
unkomprimiert, ≈ 460 Systempakete ≈ 250 MB). Der Bau dauert je nach Netz 5–15 Minuten.

Optionen: `--skip-build` (vorhandene Go-Binaries/UI nehmen statt neu zu bauen), `--no-images`, `--no-node-images` (nicht empfohlen: ohne Untertitel-Engine und Modelle), `--build-node-images`, `--node-package TYP`, `--with-rpmfusion`, `--only-system-packages`, `--no-system-packages`,
`--no-plugin`, `--with-pipeline-controller`, `--dry-run` (nur anzeigen), `--keep-stage` (Arbeitsverzeichnis behalten).
Fehlen Binaries (`make nodes` nicht gelaufen), nennt das Skript genau, was fehlt, und baut **kein** halbes Paket.

Ein Hinweis zum Stand: das Paket enthält den **Arbeitsstand** des Repositorys (auch nicht eingecheckte Dateien).
Für Auslieferungen vorher committen — der Name enthält `-dirty`, solange Änderungen offen sind.

### 3a. Paket für Rocky Linux 9 bauen (Wegwerf-Container)

Die Binaries sind gegen die Bibliotheken des Build-Rechners gelinkt (Debian 12: glibc 2.36, Rocky 9: glibc 2.34). Ein
Debian-Paket läuft deshalb **nicht** unter Rocky. Das Rocky-Paket baut `make-rocky-bundle.sh` in einem **Wegwerf-Rocky-9-Container**
(rootless Podman) auf jedem Linux-Rechner mit Internet:

```sh
make ui                                           # einmalig, das UI ist distributionsunabhängig
sh deploy/subtitle-asr/build.sh                   # Untertitel-Image MIT Modellen (falls noch nicht gebaut)
./deploy/offline/make-rocky-bundle.sh --out ~/offline [--jobs 2] [--no-rpmfusion]
```

Das Skript sichert zuerst Plattform-Images und Node-Pakete auf dem Host (`save-images.sh`), baut dann im Container libmxl, die
Go-Binaries und alle Nodes, erzeugt das lokale RPM-Repository (`rpms/`, Signaturen geprüft, Gegenprobe gegen einen leeren
Installationsstand) und das Paket. **Danach wird alles aufgeräumt**: Container, Arbeits-Volume (Cargo, Go, vcpkg, Quellen,
Build-Ausgaben), Zwischenverzeichnisse und das selbst gezogene Rocky-Image; übrig bleiben nur `…rocky9….tar.zst` und `.sha256`.
Vor und nach dem Lauf steht der freie Plattenplatz in der Ausgabe; es werden nur selbst angelegte, nummerierte Objekte
(`omp-rocky-build-<pid>`) gelöscht. `--keep` lässt alles zur Fehlersuche stehen.

Platz: ca. **14 GB frei** auf dem Podman-Speicher (das Skript prüft das vorher). Dauer: Stunden bei 2 Jobs (Rust-Workspace und
libmxl samt vcpkg-Abhängigkeiten, alles `nice 19`).

**Codecs und RPM Fusion.** Rocky enthält aus Lizenzgründen kein x264, kein libav und kein HEVC/AAC. Die Nodes nutzen
`x264enc`, `avdec_h264`, `x265enc`, `avenc_aac`. Standard ist deshalb **mit RPM Fusion Free** (`--no-rpmfusion` lässt es weg; dann
nur H.264 über openh264 und mit Funktionsverlust). Die Entscheidung berührt Patent-/Lizenzfragen (`docs/LIZENZ-INVENTAR.md`) und liegt
beim Betreiber. **Nicht verfügbar unter Rocky:** das WPE-Plugin (HTML-Grafik per `wpesrc`).

Installation auf dem Rocky-Zielrechner wie in §5; der Installer nutzt `rpms/` als **einziges** Repository (`--disablerepo='*'`).
SELinux kann `enforcing` bleiben; `firewalld` nach `docs/INSTALLATION.md` §4 einstellen.

## 4. Übertragen und prüfen

Datei und `.sha256` auf den Zielrechner bringen (USB-Stick, `scp`, Datenträger). Dort:

```sh
sha256sum -c omp-offline-*.sha256          # muss "OK" melden — sonst Übertragung wiederholen
mkdir omp-offline && tar -C omp-offline -xf omp-offline-*.tar.zst      # .tar.gz: tar -xzf
cd omp-offline
```

(`.tar.zst` braucht `zstd` auf dem Zielrechner; ohne: Paket mit `gzip`-Variante bauen oder `zstd` aus den
Systempaketen installieren.)

## 5. Installieren (Zielrechner, ohne Netz)

```sh
./install-offline.sh                       # Standardziel ~/OpenMediaPlatform
./install-offline.sh --target /opt/omp --systemd --start      # Beispiel mit Autostart und Start
```

Der Installer macht der Reihe nach (und nur das): **(1)** alle Dateien gegen `SHA256SUMS` prüfen · **(2)** Zielrechner
gegen `MANIFEST.json` prüfen (Architektur, Distribution, Release, glibc) · **(3)** Systempakete installieren: `debs/` ist ein
lokales apt-Verzeichnis, nur dieses wird als Paketquelle benutzt, installiert werden die Programme aus `packages.txt` **per
Name** (apt sucht die Abhängigkeiten selbst; nach Rückfrage, `sudo`, `--no-download`: nichts wird geladen), danach
rootless-Podman einrichten ·
**(4)** Dateien nach `--target` kopieren · **(5)** `deploy/dev/mxl.env` für diesen Pfad erzeugen · **(6)** Images mit
`podman load` einspielen · **(7)** Plugin `avvideofilter` installieren · danach `make preflight`.

Wichtige Optionen: `--no-system-packages` (Podman/GStreamer/make sind schon da), `--no-images`, `--systemd`
(Dienst `omp` für den Start beim Boot), `--start`, `--yes` (keine Rückfragen), `--dry-run`, `--force`.
Er läuft nicht als root, öffnet **keine** Firewall-Ports und greift nie auf das Netz zu.

Unter **Rocky/RHEL 9 (dnf)** installiert der Installer die Programme aus `packages.txt` aus dem lokalen Repository `rpms/` und
sonst aus **keiner** anderen Quelle. Mit `--start` registriert er danach die Node-Pakete (Auto-Untertitel samt Modellen) im Katalog;
ohne `--start` einmal nach `make start`: `deploy/offline/import-node-packages.sh` (Admin-Zugang über `OMP_USER`/`OMP_PASSWORD`).

Ohne apt und dnf (Arch, openSUSE …): `debs/` fehlt, der Installer meldet, welche Programme fehlen
(`packages.txt` im Paket nennt die Debian-Namen). Podman, make, curl, openssl, tar und GStreamer
(base/good/bad/ugly/libav) müssen dann **vorab** aus einem lokalen Spiegel/Datenträger installiert sein.

## 6. Starten und erste Schritte

```sh
cd ~/OpenMediaPlatform && make start       # baut NICHTS (Marke .offline-install), startet Container, Supervisor, Orchestrator
```

Danach im Browser `http://<Rechner>:8000`. **Sofort einen Admin anlegen** (Administration → Nutzer), solange noch kein
Nutzer existiert, ist die Oberfläche ohne Anmeldung offen (`docs/INSTALLATION.md` §2). Ports und Firewall:
`docs/INSTALLATION.md` §4.

`make preflight` zeigt auf einem Offline-Rechner „Go/Deno/Rust: nicht nötig (Offline-Paket mit fertigen Binaries)“ —
das ist richtig. Der Hinweis „Signaturschlüssel für System-Update fehlt“ betrifft nur Updates per Browser (§7).

## 7. Aktualisieren

Auf dem Build-Rechner ein neues Paket bauen, übertragen, entpacken und `./install-offline.sh` **erneut** ausführen:

- Läuft OMP noch, bricht der Installer ab: vorher `make stop`.
- Eine vorhandene Installation wird **aktualisiert**: Binaries, UI und Repo-Dateien werden überschrieben;
  `data/`, `.run/`, `.backups/`, Postgres-Daten (Container), `deploy/dev/storage-secret.env` und eure
  `deploy/dev/cloud.env` bleiben unberührt. Die bisherigen `bin/*` werden vorher nach `.offline-previous/bin/` gesichert
  (Rückfall: Dateien zurückkopieren, `make start`).
- **Vorher sichern:** Oberfläche → Administration → Backup (`docs/HANDBUCH.md` §5).

Alternativ geht der signierte **Browser-Upload** des Update-Pakets (`make update-bundle`, `docs/ENTWURF-SYSTEM-UPDATE.md`):
er aktualisiert Orchestrator, UI und Nodes, aber **nicht** Container-Images und Systempakete. Für diese ist das
Offline-Paket der Weg.

## 8. Weiterer Host im Cluster (Host-Agent) ohne Internet

Auf jedem zusätzlichen Rechner dasselbe Paket einspielen (Abschnitte 4–5, ohne `--start`). Danach ist `bin/omp-host-agent`
vorhanden. Als Dienst einrichten: `./install-offline.sh … --host-agent-service --orchestrator <IP-Hauptrechner>
[--label NAME] [--token TOKEN]` (legt `/etc/omp-host-agent.env` und den Dienst `omp-host-agent` an, wie
`install.sh`). Das Bootstrap-Token kommt aus der Oberfläche (Hosts → Host hinzufügen). Die Container (NATS, Postgres …)
laufen nur auf dem Hauptrechner; auf zusätzlichen Hosts werden `images.tar`/`podman load` nur gebraucht, wenn dort Nodes
mit Container-Runner laufen sollen.

## 9. Grenzen

- **Nichts bauen**: Auf dem Zielrechner lässt sich OMP aus dem Paket nicht neu kompilieren (kein Go/Rust/Deno, keine
  `-dev`-Pakete). Codeänderungen = neues Paket auf dem Build-Rechner.
- **Cloud-Funktionen** (Kap. 35) brauchen naturgemäß Internet; ohne bleiben sie aus.
- **WPE/OGraf** (`omp-ograf`): die Pakete `gstreamer1.0-wpe`/`libwpebackend-fdo-1.0-1` sind in der Systempaket-Liste, sofern
  die Distribution sie führt; sonst fehlt OGraf-Rendering.
- **Images mit `:latest`** (NATS, NMOS-Registry, Caddy …): das Paket friert den Stand des Bautags ein. Ein späteres Paket
  kann neuere Versionen enthalten; vor dem Einspielen auf einem Produktionsrechner gegenprüfen.
- Gebaut/getestet auf **Debian 12 (x86_64)**. **Rocky 10** (Standard von `make-rocky-bundle.sh`, `ROCKY=9` für Rocky 9): Das Paket
  ist am 2026-11-17 im Wegwerf-Container gebaut worden (472 RPMs, Signaturen und Gegenprobe ok, ca. 1,5 h Bauzeit, ~14 GB Platz).
  Die Installation auf einer frischen Rocky-VM ohne Netz ist noch nicht durchgespielt. Unter Rocky 10 fehlen openh264 und das
  WPE-Plugin; H.264/AAC kommen aus RPM Fusion + EPEL (`gstreamer1-plugin-libav`). Container-Images von OGraf/Intercom sind nur mit
  `--node-package` im Paket (Standard: nur Auto-Untertitel); die nativen Nodes sind immer dabei. Andere Distributionen: nur
  Paketliste (`packages.txt`).

## 10. Fehlersuche

| Meldung | Ursache / Abhilfe |
|---|---|
| `Prüfsummen stimmen NICHT` | Datei bei der Übertragung beschädigt → neu kopieren, `.sha256` prüfen |
| `Zielrechner passt nicht zum Paket` | andere Distribution/Architektur/zu alte glibc → Paket auf passendem Build-Rechner bauen |
| `apt-get install … fehlgeschlagen` (`unmet dependencies`, Paket nicht gefunden) | Zielrechner hat ein abweichendes Release oder schon andere Versionen installiert, die nicht zum Paket passen → Paket vom passenden Release bauen, oder fehlende Pakete aus eurem Spiegel installieren und mit `--no-system-packages` fortfahren |
| `podman info schlägt fehl` | `/etc/subuid`/`subgid` fehlen (Installer legt sie an, danach neu anmelden) oder `loginctl enable-linger <nutzer>` fehlt (Autostart) |
| `Container-Image(s) fehlen` im Preflight | `images.tar` nicht geladen (`--no-images`?) → `podman load -i images.tar` |
| `libmxl.so: cannot open shared object file` | `deploy/dev/mxl.env` nicht gesourct (`make start` macht das selbst; bei Handstarts `. deploy/dev/mxl.env`) |
| `make start` will bauen / `go: command not found` | Marke `.offline-install` fehlt im Zielverzeichnis → Installer erneut ausführen oder `touch .offline-install` |
| Plugin `avvideofilter` fehlt im Preflight | nur Warnung; nachinstallieren: `deploy/dev/install-avvideofilter.sh --archive plugins/…tar.gz` |
