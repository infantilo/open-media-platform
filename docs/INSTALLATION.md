# Installation

Ziel: von einem frischen Linux-Rechner zur laufenden Oberfläche in **zwei Befehlen**.

```sh
git clone <repo-url> OpenMediaPlatform && cd OpenMediaPlatform
./install.sh --media --start        # alles installieren, bauen, starten
```

Danach im Browser **http://localhost:8000** öffnen. Fertig.

| Variante | Befehl | Dauer | Was du bekommst |
|---|---|---|---|
| **Grundsystem** | `./install.sh --start` | ca. 10 min | Orchestrator, Oberfläche, Datenbank, Nachrichtenbus, Geräte-Registry. Keine Video-/Audio-Bausteine. |
| **Komplett** | `./install.sh --media --start` | 20–60 min (einmalig, kompiliert) | zusätzlich alle Medien-Bausteine (Quelle, Mischer, Multiviewer, Player, WebRTC …). |

`./install.sh --dry-run` zeigt vorab, was getan würde. `./install.sh --yes` stellt keine Rückfragen.
Das Skript ist mehrfach aufrufbar (Vorhandenes wird übersprungen), braucht `sudo` nur für Systempakete
und Go, öffnet **keine** Firewall-Ports und läuft **nicht** als root.

Nach `./install.sh` ohne `--start`: `source ~/.bashrc` (damit `go`, `deno`, `cargo` im Pfad sind), dann `make start`.

---

## 1. Was muss installiert sein?

Das Installationsskript erledigt das (apt, dnf, pacman, zypper). Zum Nachlesen oder für die manuelle Installation:

**Immer nötig**

| Was | Wozu | Hinweis |
|---|---|---|
| Linux (x86_64, aarch64 ungetestet) | Betriebssystem | getestet: Debian 12 |
| **Podman** (rootless) | startet NATS, NMOS-Registry, etcd, PostgreSQL als Container | kein Docker nötig; `subuid`/`subgid` für den Nutzer (Skript richtet sie ein) |
| **Go** ≥ 1.26 (Version steht in `orchestrator/go.mod`) | baut Orchestrator, Supervisor, Host-Agent | zu alte Version: Go lädt die passende Toolchain selbst nach (Internet nötig) |
| **Deno** | baut die Weboberfläche (kein Node/npm) | `curl -fsSL https://deno.land/install.sh \| sh` |
| `make`, `curl`, `openssl`, `git`, `ss` (iproute2) | Start-Skripte | |

**Zusätzlich nur für Medien-Bausteine (`--media`)**

| Was | Wozu |
|---|---|
| **Rust** ≥ 1.85 (rustup) | baut die Nodes (`make nodes`) |
| **GStreamer** inkl. Entwicklungspakete und Plugins base/good/bad/ugly/libav (+ libnice für WebRTC) | Video-/Audio-Verarbeitung |
| **MXL-Bibliothek** (`deploy/dev/install-mxl.sh`) | gemeinsamer Speicher-Austausch der Medien zwischen den Nodes; braucht cmake, ninja, clang, bison, flex, vcpkg (Skript holt vcpkg selbst) |
| `ffmpeg`/`ffprobe` | optional, nur für den ffmpeg-Assistenten |
| `/dev/shm` ≥ 1 GB | MXL legt die Medienpuffer im RAM ab |

**Hardware (Richtwerte)**: Grundsystem ≥ 2 GB RAM; mit Medien-Bausteinen 8 GB und 4+ Kerne;
≥ 10 GB freier Plattenplatz (Container-Images, Rust-Build).
**Internet** wird beim ersten Start und Build gebraucht (Container-Images, Go-/Rust-Abhängigkeiten, MXL-Quellen).

**Prüfen**: `make preflight` kontrolliert alles (Werkzeuge, Podman, Images, belegte Ports, GStreamer, MXL) und nennt zu
jedem Problem den Befehl zur Behebung. `make start` ruft die Kurzform selbst auf.

---

## 2. Erster Start und Anmeldung

`make start` startet nacheinander: NATS-Cluster + NMOS-Registry + PostgreSQL-Cluster
(Podman) → Supervisor → baut Oberfläche und Orchestrator → startet den Orchestrator. Der allererste Start lädt Images
und baut das Postgres-Image — das dauert einige Minuten. Die Datenbank-Tabellen legt der Orchestrator selbst an.

**Anmeldung**: Auf einer frischen Installation gibt es noch **keinen Nutzer** — die Oberfläche läuft dann *ohne*
Anmeldung. **Lege sofort einen Admin an** (Administration → Nutzer), sonst kann jeder, der Port 8000 erreicht, alles
steuern. Sobald der erste Nutzer existiert, ist die Anmeldung Pflicht. (`admin`/`adminpass123` in älteren Anleitungen
ist nur ein Nutzer auf der Entwicklungsmaschine, nicht Teil einer Neuinstallation.)

```sh
make status        # läuft alles?
make stop          # nur den Orchestrator stoppen (Container bleiben)
make start         # wieder starten
```

Die Instanzen (Quellen, Mischer …) startest du danach in der Oberfläche; der Orchestrator startet sie als eigene Prozesse.

---

## 3. Wer redet mit wem? (Aufbau)

```
 Browser ──HTTP 8000──▶ ┌────────────────────┐ ──HTTP, zufälliger Port──▶ Nodes (Quelle, Mischer, …)
 (Bediener)             │    Orchestrator    │ ◀──IS-04 Registrierung──── (jeder Node meldet sich selbst an)
                        └─┬────┬───────┬─────┘
            SQL 5432/5442 │    │ NATS  │ HTTP 8010 (Registry abfragen, alle 2 s)
                          ▼    │ 4222… ▼
                   PostgreSQL  │    NMOS-Registry (8010 HTTP / 8011 WebSocket)
                   (Patroni)   ▼
                          NATS-Cluster ◀── Nodes (Tally, Zustand) ◀── Host-Agent (weitere Rechner)
 Supervisor 8091 (nur lokal): Backup/Restore/System-Update, überlebt Orchestrator-Neustarts

 Medien selbst fließen NICHT über den Orchestrator:
   gleicher Rechner:   Node ──MXL (gemeinsamer RAM /dev/shm)──▶ Node
   anderer Rechner:    Node ──ST 2110/RTP, SRT, MXL-Fabrics, WebRTC──▶ Node/Gerät
```

| Verbindung | Protokoll / Port | Wozu |
|---|---|---|
| Browser → Orchestrator | HTTP **8000** | Oberfläche und API; auch Vorschaubilder und Node-Oberflächen laufen über den Orchestrator (Proxy) — der Browser spricht in der Regel **nicht direkt** mit einem Node* |
| Orchestrator → Node | HTTP, pro Node ein **zufälliger freier Port** (Betriebssystem wählt, `OMP_PORT=0`) | Parameter lesen/setzen, Methoden aufrufen, Oberfläche des Nodes holen |
| Node → NMOS-Registry | HTTP **8010** | Selbstanmeldung (AMWA IS-04) samt Herzschlag; Orchestrator liest daraus das Gerätebild |
| Orchestrator ↔ NATS | TCP **4222** (4223, 4224 als Ausweichknoten) | Ereignisse: Tally, Zustandsänderungen, Befehle an Host-Agents |
| Node → NATS | TCP 4222–4224 | Tally, Audio-Follow-Video, Meldungen |
| Orchestrator → PostgreSQL | TCP **5432** (5442, 5452 Replikate; Patroni wählt den schreibbaren) | Nutzer, Rechte, Layouts, Workflows, Audit |
| Orchestrator → Supervisor | HTTP 127.0.0.1:**8091** | Backup, Restore, System-Update |
| Host-Agent → Orchestrator | HTTP 8000 (Registrierung), danach NATS | weiterer Rechner meldet sich an und führt Start-/Stopp-Befehle aus |
| Orchestrator ↔ Orchestrator | TCP **8300** (Raft) | nur bei Orchestrator-Cluster (optional) |

\* Ausnahme: **WebRTC-Gateway** (Handy-Kamera/-Monitor) — das Handy öffnet die Sendeseite des Nodes direkt, siehe Abschnitt 4.

---

## 4. Welche Ports müssen offen sein?

### Einzelner Rechner (Normalfall): nur **eine** Port-Freigabe

| Port | Offen für | Wozu |
|---|---|---|
| **TCP 8000** | Bediener-Rechner / Netz | Oberfläche + API. **Das ist der einzige Port, den Anwender brauchen.** |
| TCP 8443 (oder 443) | Bediener, optional | nur falls du `make proxy-up` (Caddy, HTTPS) benutzt — dann **statt** 8000 freigeben |

Alles andere bleibt auf dem Rechner. **Achtung**: NATS (4222–4224, 6222–6224, 8222–8224) und die NMOS-Registry (8010/8011)
lauschen standardmäßig auf *allen* Netzwerkkarten und sind in der Standardeinstellung **ohne Anmeldung** — in einer
Firewall von außen **sperren**, solange du keinen zweiten Rechner anbindest. PostgreSQL, etcd, Patroni (5432…, 2379…, 8008…)
und der Supervisor (8091) lauschen nur auf `127.0.0.1`.

### Mehrere Rechner (Host-Agents, Cluster)

Zwischen den beteiligten Rechnern (nicht ins Internet!) freigeben:

| Richtung | Port | Wozu |
|---|---|---|
| Weitere Hosts → Hauptrechner | TCP **8000** | Host-Agent-Registrierung, API |
| Weitere Hosts → Hauptrechner | TCP **8010** | Nodes melden sich in der Registry an |
| Weitere Hosts → Hauptrechner | TCP **4222–4224** | NATS (Tally, Befehle) |
| Hauptrechner → weitere Hosts | TCP **32768–60999** (Linux-Standardbereich für zufällige Ports; einschränkbar mit `sysctl net.ipv4.ip_local_port_range`) | Orchestrator spricht die Nodes auf dem Host an |
| NATS-Knoten untereinander | TCP 6222–6224 | nur bei NATS-Knoten auf getrennten Rechnern |
| Orchestrator-Cluster | TCP 8300 | Raft zwischen Orchestratoren |
| Postgres-Cluster auf getrennten Rechnern | TCP 5432/5442/5452, 8008/8018/8028, 2379–2400 | nur bei verteiltem Datenbank-Cluster (siehe `deploy/patroni`, ARCHITECTURE.md §19.3) |

### Medien zwischen Rechnern und zu Geräten (je nach genutzten Bausteinen)

| Baustein | Port | Hinweis |
|---|---|---|
| **MXL** (Rechner-intern) | keiner — gemeinsamer Speicher `/dev/shm/omp-mxl` | gilt nur für Nodes auf **demselben** Rechner |
| MXL-Fabrics (Rechner ↔ Rechner) | frei wählbar, TCP oder RDMA (`OMP_FABRICS_PROVIDER`) | Sender/Empfänger-Gateway |
| **ST 2110 / AES67** | UDP, Ports und Multicast-Gruppen aus den Parametern des Gateways (`OMP_2110_GATEWAY_*`, `OMP_AES67_GATEWAY_*`); PTP: UDP 319/320 | Netz muss Multicast/IGMP und ggf. PTP erlauben |
| **SRT** | UDP, vom Anwender je Gateway gewählt | |
| **WebRTC-Gateway** (Handy) | TCP: eigener Port des Nodes (steht in der Instanz-Ansicht); **UDP**: fester ICE-Port per `OMP_WEBRTC_ICE_PORT`, öffentliche Adresse per `OMP_WEBRTC_PUBLIC_IP` | Handy im selben WLAN: nichts weiter nötig. Handy übers Internet: beide Ports am Router weiterleiten und beide Variablen setzen. Zugang nur mit Einladungs-Token. |

### Firewall-Beispiele (nur wenn du eine aktive Firewall hast)

```sh
# ufw (Ubuntu/Debian): Oberfläche für das lokale Netz
sudo ufw allow from 192.168.1.0/24 to any port 8000 proto tcp
# firewalld (Fedora/openSUSE):
sudo firewall-cmd --permanent --add-port=8000/tcp && sudo firewall-cmd --reload
```

---

## 5. Zugriff von anderen Rechnern / aus dem Internet

Der Orchestrator spricht Klartext-HTTP. Im lokalen Netz reicht `http://<rechner>:8000`. Für Zugriff von außerhalb
**immer HTTPS** davorsetzen: `make proxy-up` (Caddy, siehe `docs/HANDBUCH.md` §6). Zugangstoken liegen sonst im Klartext
im Netz.

---

## 6. Häufige Probleme

| Meldung / Symptom | Ursache und Abhilfe |
|---|---|
| `make start` bricht mit Preflight-Fehler ab | Die Meldung nennt den Befehl zur Behebung; Details mit `make preflight`. |
| „Port … ist belegt" | Ein früherer Lauf oder anderes Programm: `ss -ltnp \| grep :<port>`; eigener Altlauf: `make stop`. |
| Podman: „cannot find UID/GID" / rootless-Fehler | `sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $USER && podman system migrate` |
| Images lassen sich nicht laden | Internet/Proxy prüfen, oder auf anderem Rechner `podman save` / hier `podman load`. |
| Nodes starten nicht: `libmxl.so … cannot open shared object file` | MXL fehlt: `./install.sh --media` (oder `deploy/dev/install-mxl.sh`). |
| Node-Liste in der Oberfläche leer | Medien-Nodes nicht gebaut: `make nodes` (oder `./install.sh --media`). |
| Oberfläche zeigt Seite, aber leer / alte Version | Browser-Cache leeren; nach UI-Änderungen `make start` (baut neu). |
| Weitere Hosts erscheinen nicht | Ports aus Abschnitt 4 (Mehrere Rechner) prüfen, Host-Agent-Log ansehen. |

Logs: `.run/orchestrator.log`, `.run/supervisor.log`; Container: `podman logs omp-nats-1`, `podman logs omp-nmos-registry`.
Weitere Fehlerbilder: `docs/HANDBUCH.md` §8.

---

## 7. Manuelle Installation (ohne `install.sh`)

```sh
# Debian/Ubuntu — für andere Distributionen: Paketnamen in install.sh nachlesen
sudo apt-get install -y podman make curl openssl git unzip iproute2 uidmap slirp4netns
curl -fsSL https://deno.land/install.sh | sh                  # Deno
# Go ≥ 1.26 von https://go.dev/dl/ nach /usr/local/go
export PATH=/usr/local/go/bin:$HOME/.deno/bin:$HOME/.cargo/bin:$PATH
make preflight                      # prüft alles, nennt Abhilfen
make start                          # Grundsystem

# nur für Medien-Bausteine:
sudo apt-get install -y build-essential pkg-config cmake ninja-build bison flex clang libclang-dev ffmpeg \
  libgstreamer1.0-dev libgstreamer-plugins-base1.0-dev gstreamer1.0-plugins-{base,good,bad,ugly} gstreamer1.0-libav gstreamer1.0-tools
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust
./deploy/dev/install-mxl.sh         # MXL (lange)
make nodes                          # Medien-Nodes bauen
```

## 8. Deinstallieren / Zurücksetzen

```sh
make stop ARGS=--all   # ACHTUNG: stoppt auch NATS/Registry/Postgres und löscht die Postgres-Daten (kein Volume-Mount)
make down              # entfernt die Container — ebenfalls inkl. Postgres-Daten (Nutzer, Layouts, Workflows)
```

Vorher sichern: Oberfläche → Administration → Backup (siehe `docs/HANDBUCH.md` §5).
