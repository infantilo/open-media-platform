# OMP — Härtungsplan gegen die Flut maschinell gefundener Schwachstellen

Stand 2026-11-12. **Nur Plan, kein Umbau.** Grundlage ist eine reine Lese-Analyse des Repos
(Commit `941f1ee0`) und des MXL-Quellbaums unter `third_party/mxl` (Tag `v1.1.0`, per
`git describe` bestätigt). Am laufenden Stack wurde nichts verändert und nichts gemessen;
alle Messungen stehen unten als Plan.

**Harte Randbedingung:** Leistung und vor allem Bild-/Ton-Latenz im Sendepfad (Playout, Mischer,
MXL, Ausgänge) dürfen nicht leiden. Jede Maßnahme trägt deshalb eine Latenz- und CPU-Bewertung;
alles, was den Sendepfad berührt, hat eine Messung vorher/nachher und ein Abbruchkriterium (§4.0).

**Lesehilfe:** „Beleg“ = im Code nachgelesen (Datei:Zeile). „Zu prüfen“ = nicht belegt, vor der
Umsetzung zu klären. Bewertungen der Latenz ohne Messung sind als Erwartung gekennzeichnet.

**Normen (UMSETZUNG.md §0 Regel 10):** Im Projekt gelesen und mit Version belegt sind
EBU R 143 v3.0 (März 2025, `docs/R143-KONFORMITAET.md`), AMWA BCP-003-01/-02 und IS-10
(`ARCHITECTURE.md` §4.6). Weitere einschlägige Texte (Lieferketten-, Container-, Signatur- und
SBOM-Spezifikationen) werden hier bewusst **ohne Nummer** genannt: Sie wurden für diesen Plan nicht
im Original gelesen. Der jeweilige Schritt nennt das als Vorarbeit.

---

## 1. Befunde

### 1.1 MXL-Shared-Memory (`/dev/shm/omp-mxl`)

| # | Befund | Beleg |
|---|---|---|
| 1.1 | Die Domain legt der Startskript-/Launcher-Nutzer mit `mkdir -p` bzw. `MkdirAll(…, 0o755)` an. Auf dem Entwicklungsrechner: `drwxr-xr-x`, ein Nutzer; `/dev/shm` ist tmpfs mit `nosuid,nodev`, **ohne `noexec`**, ohne eigene Größengrenze für die Domain. | `deploy/dev/start-omp.sh:101`, `host-agent/internal/commands/commands.go` (MkdirAll vor `buildEnv`), `deploy/systemd/omp-orchestrator-peer.service:39`; Ist-Zustand per `ls -ld`/`findmnt` gelesen |
| 1.2 | Schreiber erzeugt je Flow ein Temp-Verzeichnis (`mkdtemp`, also 0700), füllt es, ergänzt Lese-/Ausführrechte für Gruppe und Andere und benennt es atomar um (`renameat2 … RENAME_NOREPLACE`). | `third_party/mxl/lib/internal/src/FlowManager.cpp:40-78` |
| 1.3 | Datendateien (`data`, Grain-Dateien, `channels`) werden mit `open(O_EXCL|O_CREAT|O_RDWR, 0664)` angelegt und per `posix_fallocate` vergrößert; effektiv 0644 (umask 022). `flow_def.json` und `access` entstehen per `std::ofstream` (0666 & ~umask → 0644). | `SharedMemory.cpp:26-44`, `FlowManager.cpp:89-101,194-200`; Ist: `-rw-r--r--` |
| 1.4 | **Leser mappen nur lesend:** `openFlow(…, AccessMode::READ_ONLY)` → `open(O_RDONLY)` → `mmap(PROT_READ, MAP_SHARED)`. Leser nehmen dabei keine Dateisperre. Schreiber: `PROT_READ|PROT_WRITE`, `flock(LOCK_SH|LOCK_NB)`. | `Instance.cpp:135`, `SharedMemory.cpp:49,56-74,85-86` |
| 1.5 | **Einziger Schreibzugriff eines Lesers:** Video-/Daten-Leser (diskrete Flows) öffnen die Datei `access` mit `O_RDWR` und setzen nach jedem erfolgreichen Grain-Read deren Zugriffszeit (`futimens`). Fehlschlag ist ausdrücklich erlaubt („domain in a read only volume … `lastReadTime` will never be updated“). | `PosixDiscreteFlowReader.cpp:31-51,117-121,143-147` |
| 1.6 | `lastReadTime` im Header schreibt **der Schreiber selbst**: sein Domain-Watcher beobachtet `access` per inotify (`IN_ACCESS|IN_MODIFY|IN_ATTRIB`) und trägt die Zeit in sein eigenes RW-Mapping ein. Leser schreiben nie in gemeinsamen Speicher. | `DomainWatcher.cpp:235,422-443` |
| 1.7 | Ton-Flows (kontinuierlich) haben keine `access`-Datei; deren Leser schreiben gar nichts. | Ist-Verzeichnis eines Ton-Flows (`channels`, `data`, `flow_def.json`); `PosixContinuousFlowReader.cpp` ohne `access`/`futimens` |
| 1.8 | OMP nutzt `lastReadTime` als Gate: ohne frischen Leser (3 s) wird der Ausgang nach 10 s geparkt und nur alle 2 s für 500 ms geöffnet. **Folge:** Ein Leser, der `access` nicht berühren darf (fremde UID ohne Schreibrecht, ro-Mount), bekommt von einem gegateten Ausgang nur Bildimpulse. | `nodes/omp-mediaio/src/mxl.rs:1285-1330` |
| 1.9 | Leser warten per `FUTEX_WAIT` auf ein Wort im gemeinsamen Mapping; der Schreiber weckt per `FUTEX_WAKE`. Das funktioniert nur innerhalb eines Kernels. | `Sync.cpp:30-44,68-110` |
| 1.10 | **Leser vertrauen dem Header des Schreibers ohne Grenzprüfung:** `grainCount` bestimmt, wie viele Grain-Dateien geöffnet werden; `headIndex`, `validSlices`, `totalSlices` steuern den Zugriff; die Rust-Anbindung bildet die Nutzlast als `from_raw_parts(payload_ptr, grainSize)` aus dem Header — ohne Abgleich mit der gemappten Dateigröße. Ton: `bufferLength`/`channelCount` aus dem Header. | `FlowManager.cpp:381-394`, `PosixDiscreteFlowReader.cpp:162-200`, `third_party/mxl/rust/mxl/src/grain/reader.rs:85,119`, `ContinuousFlowData.hpp:55-79` |
| 1.11 | **Der Schreiber vertraut seinem eigenen Header:** `payload_mut()` bildet den Schreibpuffer ebenfalls aus `grainSize` im gemeinsamen Speicher. Wer die Grain-Datei beschreiben darf (heute: jeder Prozess derselben UID), kann den Schreiber über das Puffer-Ende hinaus schreiben lassen. Header-Felder von **Lesern** liest der Schreiber nicht (es gibt keine). | `third_party/mxl/rust/mxl/src/grain/write_access.rs:40-42` |
| 1.12 | Gültigkeit eines Flows prüft der Leser über die Inode-Nummer im Header gegen `stat` der Datei. | `PosixDiscreteFlowReader.cpp:249-254` |
| 1.13 | Aufräumen (`garbageCollect`) löscht jedes Flow-Verzeichnis, auf dessen `data` sich eine exklusive Sperre holen lässt. Löschen darf, wer im Domain-Verzeichnis schreiben darf — heute jeder Node. `flock` braucht **kein** Schreibrecht: auch ein reiner Leser kann eine Sperre halten (verhindert Aufräumen; eine exklusive Sperre ließe den nächsten Schreiber-Start an `LOCK_SH|LOCK_NB` scheitern — **zu prüfen**, ob praktisch auslösbar). | `Instance.cpp:303-350`, `SharedMemory.cpp:56-74` |
| 1.14 | Container-Pakete bekommen die Domain **beschreibbar** eingehängt (`-v domain:domain`, kein `:ro`). | `podmanrun/podmanrun.go:153-156` |

**Antworten auf die Fragen**

- *Schreiben Leser?* Nein in den gemeinsamen Speicher; ja in die Zeitstempel der Datei `access` (nur Video/Daten).
- *Ist ein Nur-Lese-Mapping möglich?* Es ist bereits so (1.4). Ein Nur-Lese-**Mount** der ganzen Domain bricht dagegen
  das Gate (1.8), weil `access` im selben Flow-Verzeichnis liegt. Einen getrennten beschreibbaren Bereich kennt das
  MXL-Layout nicht. Praktikabel ohne MXL-Umbau: Domain beschreibbar einhängen, Trennung über **Dateirechte und UIDs**
  (`access` für Leser beschreibbar, alles andere nicht). Die Datei `access` trägt keine Nutzdaten.
- *Vertraut der Schreiber Lesern?* Nein. Er vertraut aber dem gemeinsamen Header, den heute jeder Prozess derselben UID
  ändern kann (1.11), und Leser vertrauen dem Schreiber blind (1.10). **Heute gilt: ein übernommener Node kann jeden
  anderen Node am selben Host zum Absturz bringen oder dessen Speicher verletzen.**

### 1.2 Prozess-Isolation heute

| # | Befund | Beleg |
|---|---|---|
| 2.1 | Orchestrator, Host-Agent und Zeuge laufen als ein unprivilegierter Nutzer (`User=@USER@`). Alle 44 Katalogeinträge haben `runner: "process"`; Nodes sind Kindprozesse (`exec.Command`) **derselben UID**. | `deploy/systemd/omp.service:23`, `omp-host-agent.service:23`, `deploy/catalog.json` (ausgewertet), `orchestrator/internal/launcher/launcher.go:1596-1599`, `host-agent/internal/commands/commands.go:430-434` |
| 2.2 | **Nodes erben die komplette Umgebung des Starters** (`os.Environ()`), darunter `OMP_STORAGE_SECRET_KEY` (aus `storage-secret.env` exportiert) und beim Cluster-Peer die Postgres-Adresse samt Passwort; dazu das plattformweite Node-API-Token und ggf. `OMP_LAUNCH_SECRET`. | `launcher.go:2393-2399`, `commands.go:577-585`, `deploy/dev/start-omp.sh:66`, `deploy/systemd/omp-orchestrator-peer.service:33,40` |
| 2.3 | systemd-Härtung der drei Hauptdienste: nur `ProtectKernelModules`, `ProtectKernelLogs`, `LockPersonality`, `SystemCallArchitectures=native`, Limits. Bewusst nicht gesetzt: `ProtectSystem`, `ProtectHome`, `PrivateTmp`, `ProtectControlGroups`, `RestrictSUIDSGID`, `NoNewPrivileges`. Kein seccomp-Filter, kein `RestrictAddressFamilies`, kein `CapabilityBoundingSet`. | `omp.service:24-32`, `omp-host-agent.service:24-32`, `omp-orchestrator-peer.service:16-24` |
| 2.4 | Nur der Raft-Zeuge hat `NoNewPrivileges`, `ProtectSystem=full`, `PrivateTmp`. Der Postgres-Weiterleiter hat `IPAddressDeny=any` + `IPAddressAllow=127.0.0.1`. | `omp-raft-witness.service:23-28`, `omp-pg-proxy@.service:8-10` |
| 2.5 | Uhr: Die Units verweisen für das Stellen der Uhr auf `AmbientCapabilities=CAP_SYS_TIME` als Ausweg — das würde an **alle** Nodes vererbt. `setcap` ist dort bereits als verboten vermerkt (bricht `LD_LIBRARY_PATH`, Nodes finden `libmxl.so` nicht). | `omp.service:18-20` |
| 2.6 | Priorität/Pinning: Wrapper `chrt … taskset … nice … <binary>` nur für `runner: "process"`; für Container sind „Podman-Optionen“ vorgesehen, aber `BuildArgs` setzt keine. | `orchestrator/internal/launcher/realtime.go:13-17`, `podmanrun/podmanrun.go:141-172` |
| 2.7 | ffmpeg-Jobs am Host-Agent: Programm-Freigabeliste, Pfadwurzeln, kein `..`, `-protocol_whitelist file,pipe` ohne `allowNet`; Ausführung als Agent-UID mit `nice`/`ionice`, optional `systemd-run --user --scope` (nur CPU-Quote, OOM-Wert). Keine Namensraum-, Dateisystem- oder Netz-Sperre. | `host-agent/internal/jobs/jobs.go:135-200,279-280,305-319` |
| 2.8 | Lokale Jobs, File-QC und die Ingest-Prüfung starten `ffmpeg`/`ffprobe` als Kindprozess **des Orchestrators** (gleiche UID wie Datenbank-Zugang, Signatur-Vertrauensanker, Sicherungen). | `orchestrator/internal/jobrun/local.go:58-82`, `orchestrator/internal/modules/review/qc_runner.go:22-37`, `orchestrator/internal/modules/ingest/runner.go:552` |
| 2.9 | Container-Pakete (OGraf, Intercom, Auto-Untertitel): Start ohne `--read-only`, `--cap-drop`, `--security-opt no-new-privileges`, `--pids-limit`, Speichergrenze; Containerfiles ohne `USER`; Intercom im Netz des Hosts. | `podmanrun/podmanrun.go:141-172`, `deploy/omp-ograf/Containerfile`, `deploy/omp-intercom/Containerfile`, `deploy/omp-intercom/catalog-entry.json:18` |
| 2.10 | Entwicklungsrechner (nicht repräsentativ, VM-Container): `ptrace_scope=1`, `unprivileged_bpf_disabled=2`, `perf_event_paranoid=2`, `kptr_restrict=0`, `dmesg_restrict=0`, `io_uring_disabled=0`; aktive LSM: capability, landlock, yama, selinux. | `/proc/sys/…`, `/sys/kernel/security/lsm` gelesen |

**Kern:** Es gibt genau eine Vertrauenszone. Ein Fehler in einem Demuxer genügt, um als Plattform-Nutzer zu handeln:
Flows manipulieren (1.10/1.11), Geheimnisse aus der Umgebung lesen (2.2), mit dem Node-Token andere Nodes steuern (5.1).

### 1.3 Angriffsfläche durch fremde Daten

| # | Komponente | Fremde Daten | Beleg |
|---|---|---|---|
| 3.1 | ffmpeg-/ffprobe-Jobs (Agent und lokal) | beliebige Mediendateien, mit `allowNet` auch Netz | `jobs.go:135-200`, `local.go:26-82` |
| 3.2 | File-QC, Vergleich, HDR-/Gamut-Prüfung, Ingest-Prüfung | hochgeladene/angelieferte Dateien, im Orchestrator-Kontext | `modules/review/qc_runner.go`, `modules/ingest/runner.go:552` |
| 3.3 | `omp-srt-gateway` | SRT aus dem Netz, `tsdemux`, H.264/HEVC-Dekoder | `nodes/omp-srt-gateway/src` (`srtsrc`, `tsdemux`, `avdec_h264`, `avdec_h265`) |
| 3.4 | `omp-2110-gateway`, `omp-aes67-gateway`, `omp-mediaio` (RTP, ST 2110-40) | UDP/RTP, eigene Parser für ANC, CEA-608, SCTE | `omp-mediaio/src/{rtp,st2110,st2110_anc,anc,cea608,scte_decode}.rs` |
| 3.5 | `omp-webrtc-gateway`, `omp-intercom` | WebRTC aus dem Browser (auch Gäste per Link), ICE/DTLS/SRTP, Dekoder | `webrtcbin` in beiden Nodes |
| 3.6 | Player im **Sendepfad**: `omp-channel-player`, `omp-mxf-player(-direct)`, `omp-segue-player`, `omp-failover` | Dateien über `uridecodebin`/`decodebin`/`mxfdemux` | Quelltexte der Nodes |
| 3.7 | `omp-ograf` | HTML/JS-Vorlagen im Web-Renderer (`wpesrc`) | `nodes/omp-ograf/src/pipeline.rs`, `main.rs:674-690` |
| 3.8 | `omp-scte35` (`ffprobe`), `omp-radio-automation` (`ffmpeg`), `omp-subtitle-asr` (`ffmpeg`, Sprach-Engine), `omp-device-hub` (USB-Video/-Ton) | Dateien, Geräte | `Command::new("ffprobe"/"ffmpeg")` in den Nodes |
| 3.9 | Orchestrator | Upload von Update- und Microservice-Paketen (`tar`+`gzip` werden **vor** der Signaturprüfung gelesen), Fremdplaylist-XML, LDAP/Kerberos-Antworten, S3-Antworten | `update/package.go:214-240,319`, Go-Importe `archive/tar`, `compress/gzip`, `encoding/xml`; `orchestrator/go.mod` |
| 3.10 | Review-Player | Wiedergabe im Browser; serverseitig Proxy-Erzeugung per ffmpeg (fällt unter 3.2) | `modules/review/handlers.go:497` |

**Bezug und Bau**

- GStreamer und ffmpeg kommen als **Distributionspakete** (inkl. `plugins-bad`, `plugins-ugly`, `gstreamer1.0-libav`),
  nicht aus einem eigenen Build. Container-Pakete installieren sie per `apt` aus `debian:bookworm-slim` **ohne
  Digest-Pin**. Beleg: `install.sh:68-71`, `deploy/dev/preflight.sh:93-99`, `deploy/*/Containerfile:4-10`.
- MXL: eigener Build aus Git-Tag `v1.1.0` plus zwei OMP-Patches; die C++-Abhängigkeiten kommen über einen
  **ungepinnten** `git clone` des Paketmanagers; die Rust-Toolchain per `curl | sh`. Beleg: `deploy/dev/install-mxl.sh:53,73,86,105-123`.
- **Whitelist ist ohne Neubau möglich:** ffmpeg kennt neben `-protocol_whitelist` (schon genutzt, `jobs.go:185,198`)
  die Laufzeitoptionen `-format_whitelist` und `-codec_whitelist` (**zu prüfen** gegen die ausgelieferte Version per
  `ffmpeg -h full`). GStreamer: Ränge sind bereits zentral steuerbar (`GST_PLUGIN_FEATURE_RANK` in
  `deploy/dev/start-omp.sh:54`); je Node-Typ lässt sich der Plugin-Suchpfad einschränken.
- **Rust (`nodes/Cargo.lock`, 317 Pakete):** kein Brotli, kein WebP, keine Bild-Dekoder. Parser-relevant: `flate2`
  1.1.11 / `miniz_oxide` 0.9.1 / `zlib-rs` 0.6.8, `roxmltree` 0.21.2, `serde_json`, `toml`, `rustls` 0.23.46 /
  `rustls-webpki` / `ring` 0.17.14, `tiny_http` 0.12.0, `ureq` 3.5.1, `async-nats` 0.52.0, `url`/`idna`, `regex`;
  FFI: `gstreamer-*-sys` 0.25, `mxl-sys` (bindgen), `libloading`.
- **Go (`orchestrator/go.sum`):** `klauspost/compress`, `go-ldap` + `go-asn1-ber`, `gokrb5`, `pgx`, `minio-go`,
  `expr-lang/expr`, `hashicorp/raft` + msgpack, YAML, `golang.org/x/{net,crypto,text}`.
- **Das eigentliche Parser-Risiko liegt in den Systembibliotheken** (Demuxer/Dekoder von GStreamer und ffmpeg, der
  Web-Renderer mit seinen Abhängigkeiten — Kompression, Bildformate, Schrift, TLS) und im Kernel. Welche Bibliotheken
  je Node-Binary tatsächlich geladen werden, ist **zu prüfen** (Schritt 98.2: `ldd`/Paketliste je Typ).

### 1.4 Abhängigkeits-Hygiene

| # | Vorhanden | Beleg |
|---|---|---|
| 4.1 | `govulncheck` über alle Go-Module und `cargo audit`, bei Push/PR und wöchentlich | `.github/workflows/security.yml` |
| 4.2 | CodeQL für Go, TypeScript, Actions (Rust und C++ nicht) | `.github/workflows/codeql.yml:16-31` |
| 4.3 | `cargo deny check` nur lokal in `make check`; Konfiguration prüft Lizenzen und Quellen, `bans` leer | `Makefile:150`, `nodes/deny.toml` |
| 4.4 | Dependabot wöchentlich für Go, Cargo, Actions | `.github/dependabot.yml` |
| 4.5 | Infrastruktur-Images per Digest gepinnt, Actions per SHA | `deploy/quadlets/*.container`, `deploy/images.env` |

**Fehlt:** SBOM je Release; `cargo deny` in der CI; Inventar und Schwachstellenabgleich der **Systempakete** (GStreamer,
ffmpeg, Web-Renderer, Kernel) und der Container-Images; Pin für den C++-Paketmanager und die MXL-Abhängigkeiten;
Digest-Pin der Basis-Images der `-pkg`-Containerfiles; Fuzzing der eigenen Parser (3.4); statische Analyse für Rust
und für die MXL-Patches; ein Verfahren „Meldung → ausgerolltes Update“ mit Zeitvorgabe.

### 1.5 Netz / Zero Trust

| # | Befund | Beleg |
|---|---|---|
| 5.1 | Node-API: ein Token je **Plattform**, aus dem JWT-Geheimnis abgeleitet; wer einen Node übernimmt, kann alle anderen ansprechen (im Code so dokumentiert). Nodes binden an `0.0.0.0`. | `orchestrator/internal/nodeauth/*.go` (Paketkommentar), `nodes/omp-node-sdk/src/node.rs:763` |
| 5.2 | NATS: ohne Anmeldung, ohne Konten/Rechte je Teilnehmer, im Netz des Hosts. TLS mit Client-Zertifikat ist wählbar, aber **ein** Zertifikat für alle. | `Makefile:192-214,481-504`, `deploy/quadlets/omp-nats.container:18`, `ARCHITECTURE.md` §20.4 |
| 5.3 | Host-Kommandos sind zusätzlich signiert (HMAC je Host, Rotation, Raft-Amtszeit als Fencing). | `orchestrator/internal/hostcmd/hostcmd.go:59-178` |
| 5.4 | etcd: Klartext-HTTP, keine Anmeldung, lauscht auf `0.0.0.0`. | `deploy/quadlets/omp-etcd.container:17-22`, `Makefile:263-272` |
| 5.5 | Postgres: `omp:omp`, `sslmode=disable`, `pg_hba` `0.0.0.0/0 md5`. | `Makefile:139`, `deploy/patroni/bootstrap.yml:40-41`, `omp-orchestrator-peer.service:33` |
| 5.6 | mTLS Orchestrator↔Nodes (Go-Seite) wählbar; Rust-Nodes: Server-TLS ohne Client-Zertifikat; Host-Agent↔Orchestrator unverschlüsselt; Registry-TLS wählbar. | `ARCHITECTURE.md` §4.6, §20.4 |
| 5.7 | Segmentierung Sende-/Produktions-/Management-Netz: im Code nicht abgebildet (keine Bind-Adresse je Netz, keine Firewall-Vorlage). Das Produktionsprofil verweigert den Start bei kritischen Befunden. | `node.rs:763`; `AUDIT_2026_10_23.md` (neunte Runde) |
| 5.8 | Air-Gap: Offline-Installationspaket und signierte Update-Pakete per Browser-Upload vorhanden. Netz nach außen brauchen: Uhr-Standard `pool.ntp.org`, Bau von MXL, Basis-Images. | `deploy/offline/*.sh`, `omp.service:20`, `install-mxl.sh` |

### 1.6 Container-Pakete

| # | Befund | Beleg |
|---|---|---|
| 6.1 | Drei importierbare Pakete (OGraf, Intercom, Auto-Untertitel) als signierte Bündel; rootless Podman, Standard Bridge-Netz. | `deploy/omp-ograf`, `deploy/omp-intercom`, `deploy/subtitle-asr`, `update/microsvc.go:161-215` |
| 6.2 | Vertrauensschalter je Katalogeintrag: `mxlAccess`, `mediaRead` (ro), `hostNetwork`, `extraPort`, `dataDir`. | `podmanrun/podmanrun.go:27-38` |
| 6.3 | MXL über die Containergrenze funktioniert heute schon (gleicher tmpfs, gleicher Kernel → Futex und inotify greifen). | `podmanrun.go:153-156`, Befund 1.9 |
| 6.4 | Härtungsoptionen und Priorität/Pinning für Container fehlen (2.6, 2.9). | `podmanrun.go:141-172` |

### 1.7 Kernel/Host

Im Repo gibt es keine Host-Härtungsvorlage (sysctl, Modulsperre, Erkennung). Der Selbsttest prüft Betriebsdinge, keine
Sicherheitsparameter. Beleg: Suche nach `seccomp|landlock|sysctl|auditd` ohne Treffer außerhalb von Kommentaren.

### 1.8 Update und Signierung

| # | Befund | Beleg |
|---|---|---|
| 8.1 | Ed25519, **eine** Signatur; gültig ist, was zu irgendeinem Schlüssel der Vertrauensliste passt (1 aus n). | `update/package.go:392-405` |
| 8.2 | Privater Schlüssel als Base64-Datei (0600) auf dem Baurechner, Standard `~/.omp-update/update-signing.key`. | `tools/update-bundle/main.go:61-84`, `Makefile:90` |
| 8.3 | Signatur liegt **im** Archiv; `gzip`/`tar` werden vor der Prüfung gelesen (Go-Standardbibliothek, speichersicher). | `update/package.go:214-240,319` |
| 8.4 | Rücksprung automatisch bei fehlgeschlagener Gesundheitsprüfung, drei Stände werden aufbewahrt; Downgrade-Sperre vorhanden. | `supervisor/update.go:295-370,505-518`, `AUDIT_2026_10_23.md` (M9) |
| 8.5 | Rollierendes Cluster-Update vorhanden. | `orchestrator/internal/clusterupdate/rollout.go`, `UMSETZUNG.md` Kap. 84 |
| 8.6 | **Das Update-Paket enthält nur OMP-Programme.** Kernel, GStreamer, ffmpeg, Web-Renderer kommen vom Betriebssystem — genau dort landet die Flut an Funden, und dafür gibt es keinen gesteuerten Kanal. | `Makefile:81-86` |
| 8.7 | Schlüsseltausch/Widerruf: kein Verfahren im Code gefunden — **zu prüfen** in `docs/ENTWURF-SYSTEM-UPDATE.md`. | — |

---

## 2. Bedrohungsmodell (kurz)

**Annahme:** Speicherfehler in Demuxern, Dekodern, Kompressions- und Bildbibliotheken sowie Kernel-Lücken zur
Rechteausweitung werden laufend und schnell gefunden. Ein Fehler in einer Bibliothek ist als gegeben zu behandeln;
entscheidend ist, was ein Angreifer **danach** erreicht und wie schnell ein Patch ausgerollt ist.

**Angreifer und Wege**

1. Präparierte Datei (Anlieferung, Upload, Fremdplaylist) → Demuxer in QC, Job, Player.
2. Präparierter Strom (SRT, RTP, WebRTC-Gast) → Gateway-Node.
3. Präparierte Grafikvorlage → Web-Renderer.
4. Teilnehmer im Management-Netz → NATS, etcd, Postgres, Node-API, Registry.
5. Lieferkette → Abhängigkeit, Basis-Image, Baurechner, Signierschlüssel.

**Schutzgüter in Reihenfolge**

1. Sendesignal (Verfügbarkeit, Latenz, Inhalt).
2. Signierschlüssel und Vertrauensanker (ein gefälschtes Update trifft alle Hosts).
3. Steuerung (Orchestrator, Datenbank, Rechte).
4. Material und Zugangsdaten zu Speichern.

**Heute führt jeder der Wege 1–3 in dieselbe Zone wie Schutzgut 1 und 3** (Befunde 1.10, 1.11, 2.1, 2.2, 5.1).

**Zielbild: drei Zonen auf jedem Host**

| Zone | Inhalt | Regel |
|---|---|---|
| **S — Sendepfad** | Playout, Mischer, Puffer, Ausgänge, deren MXL-Flows | native Prozesse, keine VM, keine Laufzeit-Sandbox mit Kosten pro Systemaufruf; parst möglichst keine ungeprüften Daten |
| **F — Fremddaten** | ffmpeg-Jobs, QC, Ingest-Gateways, WebRTC, Web-Renderer | eigene UID, Container mit eingeschränkten Rechten, kein Zugriff auf Geheimnisse; in Zone S nur über MXL-Flows mit festen Rechten |
| **K — Kontrolle** | Orchestrator, Host-Agent, Supervisor, Datenbank, Bus | eigene UID, startet nichts Fremdes im eigenen Kontext |

**Nicht im Umfang:** physischer Zugriff, böswillige Administratoren, Schutz des Inhalts gegen Mitlesen im Sendenetz.

---

## 3. Maßnahmenkatalog

Bewertungsskala: **0** = kein Einfluss im Dauerbetrieb (wirkt nur bei Start/Öffnen), **gering** = messbar, aber
erwartbar unter der Messschwelle, **mittel/hoch** = im Sendepfad nicht ohne Messung, ggf. gar nicht. „Sendepfad“ in der
Spalte Latenz meint Zone S; Maßnahmen, die Zone S nicht berühren, haben dort per Definition 0.

### 3.1 Sofort wirksam, latenzneutral

| ID | Maßnahme | Nutzen | Latenz-Risiko | CPU-Risiko | Aufwand | Abhängigkeiten |
|---|---|---|---|---|---|---|
| M1 | **Umgebung der Nodes als Freigabeliste** statt Vererbung (nur `OMP_*`-Betriebswerte, `LD_LIBRARY_PATH`, `GST_*`, `PATH`, `HOME`, `XDG_RUNTIME_DIR`; nie Datenbank-Adresse, Speicher-Schlüssel, Cloud-Zugang) | Übernommener Node findet keine Plattform-Geheimnisse (2.2) | 0 | 0 | klein | Liste je Node-Typ aus dem Code ableiten; Test je Typ |
| M2 | **Eigener tmpfs-Mount für die Domain** mit `noexec,nosuid,nodev,size=…` | Kein Ausführen aus dem Flow-Speicher; ein Node kann `/dev/shm` nicht mehr für alle füllen | 0 (Mount-Option; **zu prüfen**, dass kein Element ausführbar mappt) | 0 | klein | Installationsskript, Units; Größe aus Flow-Bedarf |
| M3 | **`access`-Datei für Leser beschreibbar, alles andere nur für den Schreiber**; Domain-Verzeichnis mit Sticky-Bit | Vorbereitung der UID-Trennung, ohne das Gate (1.8) zu brechen; Flows fremder UIDs nicht löschbar | 0 | 0 | klein (Rechte nach Flow-Anlage setzen, in `omp-mediaio`) | M2; Aufräumen je UID klären (1.13) |
| M4 | **Sandbox für ffmpeg/ffprobe** (Jobs, QC, Ingest-Prüfung, Hilfsaufrufe in Nodes): rootless Container oder Namensraum-Wrapper; kein Netz, Wurzel nur lesbar, Medien ro, nur Job-Verzeichnis rw, alle Capabilities weg, `no-new-privileges`, seccomp-Standardprofil, PID-/Speichergrenze, **kein MXL** | Größter Einzelgewinn: der häufigste Fremddaten-Parser verlässt Zone K | 0 im Sendepfad | Startaufschlag je Aufruf (Erwartung zweistellige bis niedrige dreistellige ms; **messen**, ffprobe wird oft gerufen); Laufzeit ≈ unverändert | mittel | Pilot (§5); GPU-Jobs brauchen Gerätedurchreichung |
| M5 | **Format-/Codec-/Protokoll-Freigabeliste** für ffmpeg zur Laufzeit; GStreamer-Plugin-Satz je Node-Typ einschränken | Weniger erreichbarer Parser-Code | 0 (wirkt beim Aufbau) | 0 | klein–mittel | Liste der betrieblich nötigen Formate (Nutzerentscheidung E5); verträgt sich mit dem ffmpeg-Assistenten nur als Laufzeitliste, nicht als Minimal-Build |
| M6 | **Härtung der Container-Starts** (`podmanrun`): `--cap-drop=all`, `--security-opt=no-new-privileges`, `--read-only` + tmpfs, `--pids-limit`, Speichergrenze, Nutzer im Image, Basis-Image per Digest | Vorhandene Pakete (OGraf, Intercom, Untertitel) werden echte Zone F | 0 für Zone S; OGraf/Intercom schreiben selbst MXL → vorher/nachher messen | 0–gering | klein | je Paket prüfen, was beschreibbar sein muss |
| M7 | **CI/Lieferkette:** `cargo deny` in die CI, SBOM je Release, Paketinventar der Systembibliotheken je Host im Support-Paket, Pins für MXL-Abhängigkeiten und Basis-Images, Fuzzing der eigenen Parser (ANC, CEA-608, SCTE, RTP) | Wissen, **ob** ein Fund betrifft, in Minuten statt Tagen | 0 | 0 (nur CI) | mittel | SBOM-Format festlegen (Original lesen, Version nennen) |
| M8 | **`NoNewPrivileges` je Node** über den vorhandenen Wrapper (`chrt … taskset … nice …` um ein Glied erweitern); Capabilities-Menge leer | setuid-Programme helfen nach einem Einbruch nicht mehr | 0 | 0 | klein | Nicht an der Orchestrator-Unit setzen: rootless Podman braucht seine setuid-Helfer (**zu prüfen**); Uhr nur über Zeitdienst, nie `AmbientCapabilities` (2.5) |

### 3.2 Zonen trennen

| ID | Maßnahme | Nutzen | Latenz-Risiko | CPU-Risiko | Aufwand | Abhängigkeiten |
|---|---|---|---|---|---|---|
| M9 | **Getrennte UIDs** für Zone K, Zone S, Zone F (Gruppe für die MXL-Domain) | Schließt 1.11 und 1.13 zwischen Zonen: F kann Flows von S weder ändern noch löschen; S und F können K nicht lesen | 0 (Rechteprüfung nur beim Öffnen) | 0 | **groß** — ein unprivilegierter Starter kann keine fremde UID starten | Startweg entscheiden (E2): Dienstvorlagen des Systemdienst-Managers je Node oder Container mit Nutzer-Namensraum; M3 |
| M10 | **Fremddaten-Nodes in Container** (SRT-/WebRTC-Gateway, Web-Renderer, Geräte-Hub): Nutzer-Namensraum, ro-Wurzel, seccomp, Netz des Hosts nur wo Medien über Netz laufen | Parser-Einbruch bleibt im Container | Erwartung 0 für MXL (gleicher Kernel: Futex, inotify, Mapping unverändert). **Risiken:** CPU-Quote des Containers (nie setzen), Nutzer-Netz statt Host-Netz für Medienströme (nicht verwenden), fehlende RT-Priorität | gering | mittel je Node-Typ | M3, M6, M9; RT-Limits und Pinning als Container-Optionen nachziehen (2.6); Geräte (GPU, Capture, `/dev/ptp*`) durchreichen |
| M11 | **Landlock im Node-SDK** (Selbstbeschränkung nach dem Start: Domain, Medien ro, eigenes Datenverzeichnis) | Dateisystem-Zugriff je Node minimal, ohne Container, an einer Stelle für alle Typen | 0 im Dauerbetrieb (prüft beim Öffnen) | 0 | mittel | Kernel mit Landlock (hier aktiv); GStreamer lädt Plugins/Registry spät — Pfadliste je Typ ermitteln; zuerst an `omp-viewer` |
| M12 | **Leser-seitige Grenzprüfung in MXL** (Header-Werte gegen gemappte Größe; `grainCount` deckeln) als Upstream-Beitrag oder dritter OMP-Patch | Schließt 1.10: ein übernommener Schreiber in Zone F bringt Leser in Zone S nicht mehr aus dem Tritt | gering (einige Vergleiche je Grain; **messen**) | gering | mittel | Abstimmung mit dem MXL-Projekt; Patch-Pflege wie `deploy/dev/mxl-patches` |
| M13 | **Schleuse für Ingest** (optional): Fremddaten-Schreiber in eigener Domain, ein vertrauenswürdiger Kopier-Node überträgt geprüft in die Sende-Domain | Zone S liest nie direkt aus Zone F | **+1 Kopie je Bild** nur auf dem Ingest-Weg (nicht Playout→Mischer→Ausgang); messen | mittel (Kopie je Bild, bei UHD spürbar) | mittel | nur falls M12 nicht reicht (E3) |
| M14 | **seccomp im Sendepfad** (Freigabeliste je Node-Typ) | Kernel-Angriffsfläche aus Zone S kleiner | **gering, aber nicht 0:** Filter läuft bei jedem Systemaufruf (Futex, Zeitstempel, Geräte-ioctl je Bild). Nur mit Messung, zuletzt | gering | mittel–groß (Liste je Typ, GPU-Treiber) | M8, M11 zuerst; Abbruchkriterium §4.0 |

### 3.3 Netz

| ID | Maßnahme | Nutzen | Latenz-Risiko | CPU-Risiko | Aufwand | Abhängigkeiten |
|---|---|---|---|---|---|---|
| M15 | **NATS-Konten und Rechte je Rolle** (Orchestrator, Host-Agent je Host, Node), Anmeldung mit Schlüsseln, TLS | Ein Node kann keine fremden Subjekte mehr senden/lesen (5.2) | 0 für Medien; Steuerlatenz (Tally, Take) **messen** | gering | mittel | Subjekt-Inventar; Schlüsselverteilung über Launcher |
| M16 | **etcd und Postgres:** Anmeldung, TLS, `pg_hba` auf Cluster-Adressen, starke Passwörter; Produktionsprofil prüft das | Schließt 5.4/5.5 | 0 | gering | klein–mittel | step-ca vorhanden |
| M17 | **Bind-Adresse je Netz** für Node-API und Dienste, Firewall-Vorlage je Host (Management-/Produktions-/Sendenetz) | Segmentierung wird durchsetzbar (5.7) | 0, wenn Regeln **nicht** auf der Medien-Schnittstelle zustandsbehaftet filtern; sonst Kosten je Paket | 0–gering | mittel | Netzplan je Installation (E6) |
| M18 | **Node-Token je Instanz oder je Workflow** | Übernommener Node steuert nicht mehr alle (5.1) | 0 | 0 | mittel–groß | Peer-Aufrufe zwischen Nodes (im Code als Hindernis benannt) |
| M19 | **Verschlüsselung der Medienströme zwischen Hosts** | Schutz gegen Mitlesen | **mittel–hoch** (CPU je Paket, Puffer) | hoch | — | **Nicht empfohlen**; stattdessen M17 |

### 3.4 Host und Kernel

| ID | Maßnahme | Nutzen | Latenz-Risiko | CPU-Risiko | Aufwand | Abhängigkeiten |
|---|---|---|---|---|---|---|
| M20 | **sysctl-Profil:** unprivilegiertes BPF aus, `ptrace_scope` ≥ 1 (Produktion 2), `kptr_restrict`, `dmesg_restrict`, `perf_event_paranoid` hoch, `io_uring` aus, wenn ungenutzt (**zu prüfen**) | Erschwert Rechteausweitung nach Einbruch | 0 | 0 | klein | Preflight/Selbsttest um Prüfung erweitern |
| M21 | **Modul-Ladesperre nach dem Start**, Kernel-Lockdown „integrity“ | Kein Nachladen verwundbarer Module | 0 im Betrieb | 0 | mittel | Capture-/GPU-Treiber müssen vorher geladen bzw. signiert sein — Risiko für Hardware-Hosts (E7) |
| M22 | **Unprivilegierte Nutzer-Namensräume** nur für den Container-Starter erlauben | Großer Teil der Kernel-Lücken braucht sie | 0 | 0 | mittel, distributionsabhängig (**zu prüfen**) | rootless Podman braucht sie → nicht global abschalten |
| M23 | **Erkennung:** wenige eBPF- oder Audit-Haken auf **seltene** Ereignisse (Programmstart, Modul laden, `ptrace`, neue ausgehende Verbindung aus Zone S/F) | Einbruch wird sichtbar; passt in vorhandenes Alarming | **0 nur ohne** Haken auf heißen Aufrufen. Audit-Regeln auf Systemaufrufe kosten bei **jedem** Aufruf aller Prozesse → auf Sende-Hosts nicht verwenden | gering | mittel | Dienst auf Nicht-Medien-Kerne legen |
| M24 | **Speicher-Initialisierung beim Freigeben/Anfordern, weitere Kernel-Härtungsschalter** | Erschwert Ausnutzung | **mittel** bei großen Bildpuffern (jede Seite wird überschrieben) | mittel | klein | Nur nach Messung; Voreinstellung: nicht auf Sende-Hosts |
| M25 | **CPU-Schutzmaßnahmen gegen Seitenkanäle** eingeschaltet lassen | — | bereits eingepreist | — | 0 | Nicht zugunsten der Leistung abschalten |
| M26 | **Unveränderliches Host-Abbild** (A/B-Partitionen, geprüfte Wurzel, signiert; Bau mit mkosi oder bootc) | Kernel + GStreamer + ffmpeg als **ein** getestetes, signiertes Paket; Rücksprung auf das alte Abbild; schließt 8.6 | 0 im Betrieb (Prüfung der Wurzel beim ersten Lesen; Medien auf eigenem Datenträger ohne Prüfung) | 0–gering | **groß** | E8; Hardware-Treiber im Abbild; Neustart je Update → Cluster-Rolling (8.5) |

### 3.5 Update und Schlüssel

| ID | Maßnahme | Nutzen | Latenz-Risiko | CPU-Risiko | Aufwand | Abhängigkeiten |
|---|---|---|---|---|---|---|
| M27 | **Abgesetzte Signatur**, Prüfung vor dem Entpacken | Kein Parser vor der Prüfung (8.3) | 0 | 0 | klein | Formatversion 2, altes Format für eine Übergangszeit |
| M28 | **Zwei Signaturen (2 aus n)**: Bau-Schlüssel und Freigabe-Schlüssel auf Hardware-Token, offline | Ein gestohlener Schlüssel reicht nicht (8.1, 8.2) | 0 | 0 | mittel | Token-Beschaffung, Ablauf (E9) |
| M29 | **Schlüsseltausch und Widerruf** über die Vertrauensdatei (Gültigkeit, Sperrliste), Probe einmal jährlich | Reaktion auf Schlüsselverlust | 0 | 0 | mittel | M28; einschlägige Spezifikation für Update-Vertrauen im Original lesen |
| M30 | **Patch-Kanal für Systembibliotheken** mit Zeitvorgabe und Probe („Fund am Montag → alle Hosts bis …“); Zwischenlösung ohne M26: eigenes Paketarchiv mit Freigabestufe | Schließt 8.6 | 0; Neustart der betroffenen Nodes nötig → Fenster/Make-before-break | 0 | mittel | M7 (Inventar), E8 |
| M31 | **Stufenweises Ausrollen:** ein Nicht-Sende-Host zuerst, Latenzmessung §4.0 als Tor, dann rollierend | Ein schlechter Patch trifft nicht die Sendung | 0 | 0 | klein | Kap. 84 vorhanden |

### 3.6 Bewertung der Isolationsstufen für MXL

| Stufe | MXL-Mapping | Futex-Wecken | inotify (`lastReadTime`) | Geräte / PTP / RT | Urteil |
|---|---|---|---|---|---|
| Prozess, eigene UID | unverändert | ja | ja | unverändert | **Standard Zone S** |
| Rootless-Container, gemeinsamer tmpfs | unverändert (gleicher Seiten-Cache) | ja (gleicher Kernel) | ja | Geräte und `/dev/ptp*` durchreichen; Uhr ist nicht je Container getrennt (TAI/Echtzeit identisch); RT-Limit und Pinning explizit setzen; **keine CPU-Quote** | **Standard Zone F**; für Zone S möglich, aber ohne Gewinn gegenüber UID + Landlock |
| ro-Mount der Domain | ja | ja | **nein** → Gate parkt (1.8) | — | nur für Ton-Flows oder nicht gegatete Ausgänge; sonst Rechte statt ro-Mount (M3) |
| Abfangende Laufzeit (gVisor) | über Vermittler, teurer | emuliert | **zu prüfen** | Geräte eingeschränkt | nur für Zone F **ohne MXL** (Jobs, QC), CPU-Aufschlag messen |
| MicroVM | nur über virtiofs mit Direktzugriff oder gemeinsames Speichergerät | **nein** — Wecken im Host weckt keinen Gast → Leser fällt auf Zeitüberschreitung zurück (Jitter) | **nein** | GPU/NIC/Capture nur per Durchreichung, PTP über virtuelle Uhr | **nie für MXL-Teilnehmer.** Zulässig für Jobs/QC und für Ingest, der per Netz (nicht MXL) übergibt |

**Sendepfad-Nodes: keine MicroVM, keine abfangende Laufzeit.** Abweichung nur für Player, die ungeprüfte Dateien
öffnen (3.6): Dort ist die bessere Antwort organisatorisch — nur Material, das QC in Zone F bestanden hat, darf in
eine Playlist (Sendefreigabe aus Kap. 74) — plus M5 und M11, nicht eine VM.

---

## 4. Phasenplan (Vorschlag: UMSETZUNG.md Kapitel 98)

Stil wie UMSETZUNG.md: **ein Schritt pro Sitzung**, kein Schritt ohne bestandene Verifikation, danach Checkliste und
Commit `[98.x] …`. Schritte, die Zone S berühren, tragen **[S]**.

### 4.0 Gemeinsame Messvorschrift (gilt für jeden [S]-Schritt)

**Werkzeuge (vorhanden):**

- `nodes/omp-mediaio/examples/timebase_probe.rs` — zusätzlicher Nur-Leser an einem Live-Flow: Render-Intervalle,
  Standbilder, Index-Lücken, identische Folgebilder.
- `tools/tc-offset/measure.py` — Versatz Zeitcode↔Bild am Player-Ausgang und am Programmausgang des Mischers, je Grain;
  startet eigene Instanzen und löscht sie.
- `tools/av-marker/analyze_mkv.py` — A/V-Versatz einer Aufnahme.
- `tools/timing-e2e/timing.py` — Soll/Ist von Takes aus dem As-Run (Steuerlatenz).

**Zu bauen in 98.0:** eine Sonde „Schreiben→Lesen“ (Zeit zwischen Grain-Commit und Aufwachen des Lesers, Histogramm
mit Median/p99/Maximum) als weiteres Beispiel in `omp-mediaio`.

**Ablauf je Messung**

1. Eine Quelle, ein Mischer, ein Leser; eigenes Label je Testinstanz (Verwechslung mit Altflows vermeiden).
2. Probe 10 s, mit `nice`, dreimal; Instanzen sofort löschen. Keine Dauerläufe auf dem Entwicklungsrechner.
3. CPU je Node aus `/proc/<pid>/stat` (Differenz `utime+stime` über die Probe), nicht aus `ps`.
4. Kontextwechsel aus `/proc/<pid>/status`.
5. Vorher-Werte im selben Lauf wie Nachher-Werte erheben (gleicher Rechnerzustand).
6. Verbindliche Zahlen nur von einem echten Host (.60/.61); der Entwicklungsrechner ist eine VM und rauscht.

**Abbruchkriterien (Vorschlag, Nutzerentscheidung E1)** — eine Maßnahme wird zurückgenommen, wenn nachher gegenüber vorher:

- irgendein zusätzliches verlorenes oder doppeltes Bild in 3 × 10 s auftritt, **oder**
- Schreiben→Lesen im Median um mehr als 0,1 ms oder im p99 um mehr als 0,5 ms steigt, **oder**
- der Versatz Zeitcode↔Bild sich um ein Bild ändert, **oder**
- der A/V-Versatz sich um mehr als 1 ms ändert, **oder**
- die CPU-Zeit eines Sendepfad-Nodes um mehr als 3 % (relativ) steigt.

### Phase A — Grundlage und latenzneutrale Schritte

**98.0 Messgrundlage.** Sonde Schreiben→Lesen bauen; Ausgangswerte für Player→Mischer→Leser aufnehmen und in
`docs/decisions.md` festhalten.
*Verifikation:* Sonde liefert an einem Testflow drei Läufe mit Streuung < 10 % im Median; Ausgangswerte protokolliert.
*Abbruch:* Streut die Sonde stärker, erst die Sonde verbessern — sonst ist kein späteres Kriterium prüfbar.

**98.1 Umgebung als Freigabeliste (M1).** `buildEnv` in Launcher und Host-Agent stellen die Umgebung aus einer Liste zusammen.
*Verifikation:* Test: gestarteter Mock-Node sieht weder `OMP_STORAGE_SECRET_KEY` noch `OMP_POSTGRES_URL`; jeder
Katalogtyp startet einmal und meldet sich in der Registry (kurz, nacheinander, sofort löschen); `/proc/<pid>/environ`
eines Nodes enthält keine Geheimnisse.
*Latenz:* nicht berührt; Stichprobe 4.0 an einem Mischer als Gegenprobe.
*Abbruch:* Ein Typ startet nicht → fehlende Variable ergänzen, nicht die Liste aufgeben.

**98.2 Lieferkette (M7, Teil 1).** `cargo deny` in `security.yml`; SBOM für Rust und Go je Release; Skript
„geladene Bibliotheken je Node-Binary“ (`ldd` + Paketzuordnung) ins Support-Paket; Pin für MXL-Abhängigkeiten und
Basis-Images der `-pkg`-Containerfiles.
*Vorarbeit:* SBOM-Spezifikation im Original lesen, Version festhalten.
*Verifikation:* CI-Lauf grün; SBOM-Datei im Update-Bündel; Bibliotheksliste für drei Node-Typen plausibel.
*Latenz:* nicht berührt.

**98.3 Pilot: ffmpeg-Job in der Sandbox (M4)** — siehe §5. **Ergebnis 2026-11-12:** Container-Variante gebaut und geprüft, aber mit rund
3,5–4 s Aufschlag je Aufruf unbrauchbar (Abbruchkriterium §5 erfüllt); die Ausweichvariante „Namensraum-Hülle“ (bubblewrap,
`"sandbox": "namespace"`) kostet im Rahmen der Messstreuung nichts und ist die empfohlene Stufe. Einzelheiten: `docs/decisions.md`
„Härtung Schritt 98.3“.

**98.4 Sandbox auf die übrigen ffmpeg/ffprobe-Aufrufe ausdehnen (M4, M5).** File-QC, Vergleich, Ingest-Prüfung,
lokale Jobs; danach die Hilfsaufrufe in `omp-scte35`, `omp-radio-automation`, `omp-subtitle-asr`. Dazu Format-/Codec-Liste.
*Verifikation:* `tools/review-e2e` grün; eine Datei außerhalb der Wurzeln ist in der Sandbox nicht lesbar; ein Format
außerhalb der Liste wird mit verständlicher Meldung abgelehnt; QC-Dauer je Datei vorher/nachher (Ziel: Aufschlag < 10 %).
*Latenz:* Zone S nicht berührt; während eines QC-Laufs einmal 4.0 fahren (Nachweis, dass die Sandbox den Sendepfad nicht stört).
*Abbruch:* QC-Aufschlag > 25 % → Startweg ändern (dauerhafte Sandbox mit Auftragskanal statt Start je Aufruf).

**98.5 [S] MXL-Domain: eigener Mount, Rechte, Sticky-Bit (M2, M3).** Mount in Installationsskript und Units;
`omp-mediaio` setzt nach Flow-Anlage die Rechte der `access`-Datei.
*Verifikation:* Leser unter einer **zweiten Test-UID** liest einen gegateten Video-Flow dauerhaft (Gate bleibt offen);
dieselbe UID kann weder `data` noch Grain-Dateien zum Schreiben öffnen noch das Flow-Verzeichnis löschen; Ausführen
einer Datei aus der Domain scheitert; Mischer 15× neu starten, jeder Eingang hat Pegel/Bild (bekannte Race-Prüfung).
*Latenz:* 4.0 vorher/nachher.
*Abbruch:* Kriterien 4.0; oder ein Element verlangt ausführbares Mapping → `noexec` zurücknehmen, Rest behalten.

**98.6 Container-Starts härten (M6, M8).** `podmanrun.BuildArgs` um die Optionen erweitern; Wrapper-Glied für
`NoNewPrivileges` bei Prozess-Nodes.
*Verifikation:* `podmanrun_test.go` erweitert; OGraf-Paket rendert eine Vorlage, Intercom baut eine Sprechverbindung
auf (nur auf Nutzerwunsch testen), Untertitel-Paket startet; `NoNewPrivs: 1` in `/proc/<pid>/status` eines Nodes.
*Latenz:* [S] für `NoNewPrivileges`: 4.0 an Player+Mischer. OGraf: Renderintervall vorher/nachher mit `timebase_probe`.

**98.7 NATS-Konten und Rechte (M15).**
*Verifikation:* Ein Node-Konto kann kein Host-Kommando-Subjekt senden und fremde Subjekte nicht abonnieren (Test);
Tally und Alarme laufen; `timing.py` vorher/nachher ohne Verschlechterung.
*Abbruch:* Take-Abweichung steigt messbar → TLS und Rechte getrennt betrachten, Ursache suchen, nicht beides zurücknehmen.

**98.8 etcd/Postgres absichern (M16).** Anmeldung, TLS, `pg_hba`; Prüfung im Produktionsprofil.
*Verifikation:* Verbindung ohne Zertifikat/Passwort scheitert; Patroni-Umschaltung funktioniert; Tests gegen Wegwerf-Postgres grün.

**98.9 Bind-Adressen und Firewall-Vorlage (M17).**
*Verifikation:* Node-API ist aus dem Sendenetz nicht erreichbar (Test mit zweiter Adresse); Medienströme unverändert.
*Latenz:* [S] 4.0 mit einem Netz-Ausgang (RTP/SRT lokal), weil Paketfilter berührt wird.

### Phase B — Zonen trennen

**98.10 [S] Landlock im SDK, zuerst `omp-viewer` (M11).** Wählbar je Typ, Standard aus.
*Verifikation:* Viewer zeigt Bild; Zugriff auf eine Datei außerhalb der Liste scheitert; danach Typ für Typ freischalten
(Mischer zuletzt), jeweils 4.0.
*Abbruch:* Kriterien 4.0; oder ein spät geladenes Plugin scheitert → Pfadliste ergänzen.

**98.11 Startweg für getrennte UIDs entscheiden und als Prototyp bauen (M9).** Zwei Varianten gegenüberstellen
(Dienstvorlage des Systemdienst-Managers je Node gegen Container mit Nutzer-Namensraum), an **einem** Fremddaten-Typ
(`omp-srt-gateway`) ausprobieren. Ergebnis in `docs/decisions.md`, Nutzer entscheidet (E2).
*Verifikation:* Gateway läuft unter fremder UID, schreibt seinen Flow, Mischer liest ihn; Gateway kann Flows des
Mischers nicht verändern; Wiederaufnahme nach Orchestrator-Neustart funktioniert weiter.
*Latenz:* [S] 4.0 am Mischer mit dem Gateway als Quelle.

**98.12 Fremddaten-Nodes umziehen (M10).** Je Sitzung ein Typ: SRT-Gateway, WebRTC-Gateway, Web-Renderer, Geräte-Hub,
2110-/AES67-Gateway. RT-Limit und Pinning als Container-Optionen.
*Verifikation je Typ:* Funktion; Rechteprobe wie 98.11; 4.0 mit diesem Typ als Quelle.
*Abbruch:* Kriterien 4.0 → Typ bleibt Prozess mit UID + Landlock.

**98.13 [S] Grenzprüfung für MXL-Leser (M12).** Als Beitrag ans MXL-Projekt vorbereiten; bis zur Übernahme als Patch.
*Verifikation:* Test mit absichtlich verfälschtem Header: Leser meldet Fehler statt abzustürzen; 4.0.
*Abbruch:* Kriterien 4.0 → Prüfung nur beim Öffnen statt je Grain.

**98.14 Node-Token je Instanz/Workflow (M18).** Erst Entwurf (Peer-Aufrufe), dann Umsetzung in eigener Sitzung.

**98.15 [S] seccomp im Sendepfad (M14) — optional, zuletzt.** Erst Aufrufliste je Typ im Beobachtungsmodus sammeln, dann scharf.
*Abbruch:* Kriterien 4.0 → bleibt aus; Zone S ist dann über UID, Landlock, `NoNewPrivileges` geschützt.

### Phase C — Host

**98.16 sysctl-Profil + Prüfung im Selbsttest (M20, M22).**
*Verifikation:* Selbsttest zeigt Abweichungen; rootless Podman startet weiter. *Latenz:* [S] 4.0 als Gegenprobe.

**98.17 Modulsperre/Lockdown auf einem Hardware-Host erproben (M21).** Nur mit Nutzerfreigabe und Hardware (E7).

**98.18 Erkennung (M23).** Wenige Haken, Meldung über das vorhandene Alarming.
*Verifikation:* Testereignis (fremdes Programm aus Zone F gestartet) erzeugt Alarm.
*Latenz:* [S] 4.0 mit laufender Erkennung; zusätzlich Kontextwechsel der Sendepfad-Nodes vergleichen.
*Abbruch:* Kriterien 4.0 → Haken reduzieren oder Erkennung nur auf Zone-F-/Zone-K-Hosts.

**98.19 Unveränderliches Host-Abbild: Machbarkeit (M26).** Nur Prototyp in einer VM: Abbild bauen, A/B-Wechsel,
Rücksprung, OMP startet. Entscheidung E8 danach.

### Phase D — Update

**98.20 Abgesetzte Signatur + zwei Signaturen (M27, M28).**
*Verifikation:* Paket mit nur einer Signatur wird abgelehnt; verfälschtes Archiv wird abgelehnt, **bevor** es entpackt
wird (Test mit kaputtem gzip); altes Format nur mit ausdrücklichem Schalter.

**98.21 Schlüsseltausch/Widerruf + Probe (M29).**
*Verifikation:* Probe auf zwei Hosts: alter Schlüssel gesperrt, neues Paket wird angenommen, altes abgelehnt.

**98.22 Patch-Kanal und Zeitprobe (M30, M31).** Einmal durchspielen: angenommener Fund in einer Medienbibliothek →
Inventar zeigt betroffene Hosts → Paket/Abbild → ein Host → Messung 4.0 → rollierend.
*Verifikation:* gemessene Gesamtdauer protokolliert; Zielzeit (E10) erreicht oder Engpass benannt.

### Reihenfolge und Begründung

98.0 → 98.1 → 98.3 → 98.4 bringen den größten Gewinn ohne Berührung des Sendepfads. 98.5 ist die Voraussetzung für jede
Zonentrennung. Phase D (98.20) kann parallel zu Phase B laufen; sie hängt an Beschaffung und Entscheidung, nicht am Code.

---

## 5. Pilot: genau ein Node rootless im Container — der ffmpeg-Job am Host-Agent

**Warum dieser:** Er parst beliebige Fremddateien, liegt nicht im Sendepfad, hat **keinen** MXL-Zugriff, und der Code
hat schon die passende Stelle: `Runner.wrap()` setzt Wrapper vor das Programm (`host-agent/internal/jobs/jobs.go:305-319`),
`Validate()` kennt die erlaubten Pfadwurzeln (`jobs.go:135-200`). Der Container-Start existiert als Modul (`podmanrun`).

**Aufbau**

- Neues Feld in der Werkzeug-Freigabe des Hosts (`deploy/tools.example.json`): `sandbox: "none" | "container"`, Standard `none`.
- Bei `container` ersetzt `wrap()` den Programmpfad durch einen rootless-Containerstart:
  - Netz: keines (bei `allowNet` das Bridge-Netz).
  - Wurzel nur lesbar; `/tmp` als kleines tmpfs.
  - `jobRoots` nur lesbar eingehängt, das Job-Arbeitsverzeichnis und das Zielverzeichnis beschreibbar.
  - Alle Capabilities entfernt, `no-new-privileges`, seccomp-Standardprofil, PID- und Speichergrenze.
  - Nutzer im Container ≠ root; **kein** MXL-Mount.
  - `nice`/`ionice` bleiben außen davor; **keine CPU-Quote über die bestehende hinaus**.
- Image: schlank, nur ffmpeg/ffprobe aus dem Distributionspaket, per Digest gepinnt, als signiertes Bündel wie die
  vorhandenen `-pkg`-Pakete verteilt (Air-Gap-tauglich).
- Fortschritts-/Fehlerausgabe unverändert über stdout/stderr; Abbruch über die Prozessgruppe plus Container-Stop.

**Verifikation**

1. `jobs_test.go` erweitert: Argumentvektor für `container` (ohne Podman, Muster wie `podmanrun_test.go`).
2. Echte Probe: ein kurzer Transcode-Job (10 s Testclip) läuft mit `none` und mit `container`; Ergebnisdateien identisch groß/abspielbar.
3. Ausbruchsprobe: Job mit `-i /etc/passwd` bzw. Ausgabe nach `~/.ssh/…` scheitert an der Sandbox, auch wenn die Argumentprüfung testweise umgangen wird.
4. Netzprobe: `-i http://…` scheitert ohne `allowNet`.
5. Zeiten: Start bis erstes Fortschrittsereignis und Gesamtdauer, je dreimal, `none` gegen `container`. Erwartung: Startaufschlag unter 0,5 s, Laufzeit ±3 %.
6. Sendepfad-Gegenprobe: während des Jobs einmal Messung 4.0 an Player→Mischer (Job auf 2 Threads begrenzt, 10 s).

**Abbruchkriterien:** Laufzeit-Aufschlag > 10 % oder Kriterien 4.0 verletzt → Ursache klären (meist CPU-Zuteilung,
nicht die Sandbox); bleibt es dabei, Variante Namensraum-Wrapper ohne Container-Laufzeit prüfen.

**Nicht im Pilot:** GPU-Jobs (Gerätedurchreichung), lokale Jobs im Orchestrator, QC — das ist Schritt 98.4.

---

## 6. Offene Entscheidungen für den Nutzer

| # | Frage | Empfehlung |
|---|---|---|
| E1 | Abbruchgrenzen aus §4.0 (0,1 ms Median, 0,5 ms p99, 3 % CPU) so übernehmen? | Ja als Start; nach 98.0 an die gemessene Streuung anpassen |
| E2 | Startweg für getrennte UIDs: Dienstvorlagen des Systemdienst-Managers (braucht eine eng gefasste Root-Berechtigung zum Starten) oder Container mit Nutzer-Namensraum? | Zone F: Container. Zone S: Dienstvorlage oder vorerst gleiche UID wie heute + Landlock; nach Prototyp 98.11 entscheiden |
| E3 | Reicht die Grenzprüfung im Leser (M12) oder soll Ingest zusätzlich über eine Schleuse (M13, +1 Kopie auf dem Ingest-Weg)? | Erst M12; Schleuse nur für Quellen aus fremden Netzen |
| E4 | Dürfen Player im Sendepfad nur noch Material öffnen, das QC bestanden hat (harte Sperre statt Hinweis)? | **ENTSCHIEDEN 2026-11-12: nur Warnhinweis, keine harte Sperre.** (Plan-Empfehlung war: Sperre mit Notfall-Übersteuerung) |
| E5 | Welche Container/Codecs sind betrieblich nötig (Grundlage der Freigabeliste M5)? | Liste aus dem Bestand der Medienbibliothek erzeugen, Nutzer bestätigt |
| E6 | Netzplan: getrennte Schnittstellen für Management, Produktion, Sendung je Host? Air-Gap für Sende-Hosts mit interner Zeitquelle? | Ja; Zeit über lokalen PTP-/NTP-Dienst statt öffentlichem Pool |
| E7 | Modulsperre/Lockdown auf Hosts mit Capture-/GPU-Karten erproben? | Erst nach Phase B, nur mit Hardware zum Testen |
| E8 | Unveränderliches Host-Abbild als Zielbild (großer Aufwand) oder Paketarchiv mit Freigabestufe? | **ENTSCHIEDEN 2026-11-12:** Paketarchiv (M30) jetzt, Abbild als Prototyp 98.19, Entscheidung danach |
| E9 | Zwei Signaturen: wer hält den zweiten Schlüssel, welches Token? | **ENTSCHIEDEN 2026-11-12:** zwei Geräte (Hardware-Token) bei einer Person an getrennten Orten; Freigabe-Schlüssel nie auf dem Baurechner |
| E10 | Zielzeit „Fund bekannt → alle Hosts gepatcht“? | **ENTSCHIEDEN 2026-11-12:** Zone F/K 48 h; Zone S nächstes Sendefenster, höchstens 7 Tage |
| E11 | Soll die MXL-Grenzprüfung als Beitrag ans MXL-Projekt gehen? | Ja; bis dahin als dritter Patch |
| E12 | `omp-intercom` läuft im Netz des Hosts und nimmt Gäste per Link an — in eine eigene Netzzone/einen eigenen Host legen? | Ja, sobald Gäste von außerhalb des Hauses zugelassen sind |

---

## 7. Risiken

| Risiko | Wirkung | Gegenmaßnahme |
|---|---|---|
| **Signierschlüssel** liegt als Datei auf dem Baurechner (8.2), eine Signatur genügt (8.1) | Gefälschtes Update für alle Hosts — schlimmster Einzelfall | M28/M29 vorziehen, sobald entschieden; bis dahin Schlüssel auf verschlüsseltem Wechselmedium, nicht auf dem Entwicklungsrechner |
| Verlust des Schlüssels ohne Tauschverfahren (8.7) | Kein Update mehr möglich bzw. nur mit Handarbeit je Host | M29; zweiter Vertrauensanker von Anfang an in der Vertrauensdatei |
| Härtung bricht das Leser-Gate (1.8) | Bildimpulse statt Bild — sieht wie ein Sendefehler aus | 98.5 prüft ausdrücklich mit fremder UID; ro-Mount der Domain nicht verwenden |
| Container bekommt CPU-Quote oder Nutzer-Netz für Medien | Ruckeln, Latenz | Regel im Code (`podmanrun`): keine Quote, Medien-Nodes im Netz des Hosts; Messung 4.0 |
| RT-Priorität/Pinning geht beim Umzug in Container verloren (2.6) | Jitter unter Last | Vor dem Umzug Optionen nachziehen; Vergleich der Kontextwechsel |
| `NoNewPrivileges`/Rechteentzug an der falschen Stelle | Rootless Podman startet nicht mehr; früherer Fund: Dateirechte per `setcap` brachen `LD_LIBRARY_PATH` | Nur je Node über den Wrapper; nie `setcap`; Start-Test muss Absturz der Nodes prüfen |
| Getrennte UIDs und Aufräumen (1.13) | Verwaiste Flows einer UID füllen den Speicher | Aufräumen je UID bzw. durch den Starter; Größengrenze des Mounts (M2) + vorhandener Alarm „Speicher voll“ |
| Sperre per `flock` durch einen reinen Leser (1.13) | Schreiber-Neustart könnte scheitern | Zu prüfen; falls auslösbar: `flock` für Zone-F-Leser per seccomp sperren (Leser brauchen ihn nicht, 1.4) |
| Patch-Tempo gegen Stabilität | Schneller Patch einer Medienbibliothek ändert Verhalten (Dekoder, Timing) | M31: ein Host zuerst, Messung 4.0 als Tor, Rücksprung vorhanden (8.4) |
| Lockdown/Modulsperre auf Hardware-Hosts | Capture-/GPU-Treiber laden nicht | Nur nach Probe mit echter Hardware (E7) |
| Erkennung mit Haken auf heißen Aufrufen | Schleichende Latenz | Nur seltene Ereignisse; 98.18 misst mit laufender Erkennung |
| Messungen auf dem Entwicklungsrechner (VM) | Falsche Sicherheit oder falscher Alarm | Verbindliche Zahlen nur vom echten Host; auf der VM nur Vorher/Nachher im selben Lauf |
| Umfang (23 Schritte) | Härtung bleibt halb fertig | Reihenfolge so gewählt, dass jeder Schritt für sich Nutzen bringt; 98.0–98.5 sind das Minimum |
| Normbezug ungeprüft | Falsche Zitate | Vor jedem Schritt mit Normbezug Original lesen, Version nennen (§0 Regel 10); bis dahin keine Nummern |

---

## 8. Kurzfassung

- **Heute eine einzige Vertrauenszone:** alle Nodes, ffmpeg-Aufrufe und der Orchestrator laufen unter einer UID; Nodes
  erben dessen Umgebung samt Geheimnissen; MXL-Leser und -Schreiber vertrauen dem gemeinsamen Header ungeprüft.
- **MXL ist für Trennung besser geeignet als befürchtet:** Leser mappen bereits nur lesend; ihr einziger Schreibzugriff
  ist ein Zeitstempel auf einer leeren Datei. Trennung über UIDs und Dateirechte kostet im Dauerbetrieb nichts.
  Ein ro-Mount oder eine VM-Grenze dagegen bricht Gate bzw. Futex-Wecken.
- **Größter Gewinn ohne Latenzrisiko:** Umgebung als Freigabeliste, ffmpeg/ffprobe in die Sandbox, Lieferketten-Inventar,
  Container-Starts härten, Domain-Rechte.
- **Sendepfad bleibt nativ:** eigene UID, `NoNewPrivileges`, Landlock; seccomp nur nach Messung; keine VM.
- **Größte Lücke gegen die Exploit-Flut:** Systembibliotheken und Kernel haben keinen gesteuerten, signierten
  Patch-Kanal; der Signierschlüssel ist eine einzelne Datei.
