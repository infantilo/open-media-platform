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
| `debs/` | Systempakete (nur **apt**-Systeme): Podman, GStreamer-Laufzeit samt Plugins, ffmpeg, make, curl … **mit allen Abhängigkeiten** (kein `-dev`, keine Compiler) |
| `plugins/` | GStreamer-Plugin `avvideofilter` (Blend-Bildratenwandlung, optional — `docs/INSTALLATION.md` §9) |
| `SHA256SUMS`, `MANIFEST.json` | Prüfsummen aller Dateien; Distribution, Release, Architektur, glibc des Build-Rechners |
| `install-offline.sh`, `ANLEITUNG.md` | Installer für den Zielrechner, diese Anleitung |

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

Optionen: `--skip-build` (vorhandene Go-Binaries/UI nehmen statt neu zu bauen), `--no-images`, `--no-system-packages`,
`--no-plugin`, `--with-pipeline-controller`, `--dry-run` (nur anzeigen), `--keep-stage` (Arbeitsverzeichnis behalten).
Fehlen Binaries (`make nodes` nicht gelaufen), nennt das Skript genau, was fehlt, und baut **kein** halbes Paket.

Ein Hinweis zum Stand: das Paket enthält den **Arbeitsstand** des Repositorys (auch nicht eingecheckte Dateien).
Für Auslieferungen vorher committen — der Name enthält `-dirty`, solange Änderungen offen sind.

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

Ohne apt (Fedora, Arch, openSUSE …): `debs/` fehlt, der Installer meldet, welche Programme fehlen
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
- Gebaut/getestet auf **Debian 12 (x86_64)**; andere Distributionen: Paketbau und Installer sind distributionsneutral,
  die Systempaket-Behandlung aber nur für apt automatisiert.

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
