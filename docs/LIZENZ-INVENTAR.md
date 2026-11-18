# Lizenzinventar (Stand 2026-11-16)

Technische Bestandsaufnahme, **keine Rechtsberatung**. Sie ersetzt weder die Prüfung durch einen Anwalt noch
`THIRD-PARTY-NOTICES.md` (dort stehen Urheber, Pflichten und Hinweise je Komponente). Eigener Code: Apache-2.0
(`LICENSE`, `NOTICE`).

## 1. Abhängigkeiten im Quellcode

| Bereich | Prüfung | Ergebnis |
|---|---|---|
| Rust (`nodes/`, ~Cargo-Workspace) | `cargo deny --offline check licenses` gegen die Erlaubnisliste in `nodes/deny.toml` (MIT, Apache-2.0, BSD, ISC, 0BSD, Zlib, Unlicense, Unicode-3.0, CDLA-Permissive-2.0) | **ok**, keine Ausnahmen. `r-efi` ist `MIT OR Apache-2.0 OR LGPL-2.1-or-later` (MIT gewählt, wirkt nur auf UEFI-Ziele). `webpki-roots` steht unter CDLA-Permissive-2.0 (Datenlizenz, Hinweis bei Weitergabe). |
| Go (orchestrator, host-agent, supervisor, nodes/mock, omp-vfa, omp-vfa-vision; tatsächlich gebundene Module) | Lizenzdatei je Modul im Modul-Cache ausgewertet (Skript einmalig, nicht eingecheckt) | 53 Module: MIT 23, Apache-2.0 11, BSD-3 9, BSD-2 1, **MPL-2.0 4** (`hashicorp/raft`, `raft-boltdb/v2`, `go-immutable-radix`, `golang-lru`), Rest eigene Teilmodule. Kein GPL/AGPL. |
| UI (Deno/TypeScript) | Importe geprüft | Keine Laufzeit-Fremdbibliotheken; nur Testabhängigkeiten `jsr:@std/*` (MIT). Schriften/Bilder nicht geprüft. |
| Vendored (`third_party/`) | nicht im Repo, wird beim Bau geholt | MXL (Apache-2.0), libfabric (BSD-2 oder GPL-2): Lizenztexte aus dem Quellbaum mitgeben |

Hinweise
* **MPL-2.0** ist dateiweises Copyleft: unveränderte Nutzung ist unkritisch; wer die MPL-Dateien ändert, muss diese
  Dateien unter MPL offenlegen. Bei Weitergabe von Binaries den Quellverweis auf das Upstream-Projekt beilegen.
* Eigene Rust-Pakete haben **kein** `license`-Feld in der `Cargo.toml` (cargo-deny meldet sie als „Unlicensed“,
  `[licenses.private] ignore` blendet das aus). Vor einer Veröffentlichung `license = "Apache-2.0"` ergänzen.

## 2. Container-Images (`deploy/images.env`)

Lizenzen aus dem Gedächtnis, **gegen die Images prüfen** (`/licenses`, Projektseiten) bevor etwas ausgeliefert wird.

| Image | erwartete Lizenz | Anmerkung |
|---|---|---|
| nats, etcd, Caddy, step-ca, SeaweedFS | Apache-2.0 | |
| PostgreSQL, Patroni | PostgreSQL License, MIT | |
| `rhastie/nmos-cpp` | Apache-2.0 (nmos-cpp) | **Community-Image Dritter**: Basisschichten und Inhalt nicht von uns kontrolliert; ersetzbar durch ein selbst gebautes Image |
| `amwa/nmos-testing` | Apache-2.0 | nur Test, nicht Teil der Auslieferung |
| Debian-Basis | gemischt, enthält GPL-Pakete | Quelle: Debian |

## 3. Systempakete im Offline-Paket

Das Paket enthält Debian-Pakete mit **GPL/LGPL** (GStreamer-Plugins, FFmpeg, Podman u. a.) und **patentbelasteten
Codecs** (H.264, HEVC, AAC über `gstreamer1.0-plugins-ugly`, `-libav`, `ffmpeg`).

* Copyright-Dateien liegen in den `.deb` selbst (`/usr/share/doc/*/copyright`).
* **Offen:** ein schriftliches Quellcode-Angebot für die GPL-Pakete liegt dem Paket nicht bei. Bei kommerzieller
  Weitergabe von Rechtsseite klären lassen (Angebot oder Quellpakete beilegen).
* **Offen:** Patentlizenzen für H.264/HEVC/AAC gewährt weder GPL noch LGPL. Für Weitergabe als Produkt: Codec-Pakete aus
  dem Paket nehmen (Betreiber installiert selbst) oder Lizenzfrage klären. Reiner Eigenbetrieb ist ein anderer Fall.

## 4. Modelle und Daten

| Teil | Stand |
|---|---|
| Whisper-Modelle, whisper.cpp | MIT, Lizenztexte im Image (`THIRD-PARTY-NOTICES.md`) |
| pyannote-segmentation-3-0 | MIT |
| 3D-Speaker CAM++ | **Lizenz nicht verifiziert** — vor kommerzieller Nutzung klären |
| Pigo-Gesichtsdetektor (facefinder) | MIT (Bibliothek), eingebettet |
| Gebärdensprach-Lexikon | nur eigene/verifizierte Daten, keine GPL-/Forschungsquellen (`docs/funktionen/GEBAERDENSPRACHE.md`) |

## 5. Offene Punkte (nicht technisch lösbar)

1. Wem gehört der Code (Arbeitsverhältnis, Auftrag, Übernahmen aus PIPELINE CONTROLLER)? Der Urhebervermerk in `NOTICE`
   („The OpenMediaPlatform contributors“) ist ein Platzhalter.
2. Patent-Recherche (Freedom-to-Operate) für Kernfunktionen vor kommerzieller Auslieferung.
3. Markenrecherche für den Namen „OpenMediaPlatform“.
4. Quellangebot und Codec-Patente beim Offline-Paket (Abschnitt 3).
5. Patent- und Marken-Regeln von SMPTE und AMWA einmal bestätigen lassen; „kompatibel“, nie „zertifiziert“ sagen.
