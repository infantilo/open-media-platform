# OMP-Handbuch (Dev-Betrieb)

Kurzanleitung für den lokalen Dev-Betrieb des Orchestrators. Architektur-
Hintergrund steht in `ARCHITECTURE.md`, der Implementierungsplan in
`UMSETZUNG.md` — hier geht es nur um „wie starte ich das Ding".

## 1. Voraussetzungen

- **Go** (aktuelle Version, siehe `docs/decisions.md` 2026-07-07)
- **Deno** (für das UI-Bundle, kein Node/npm nötig)
- **Podman** (rootless; startet NATS + NMOS-Registry als Container)

Nur für die Node-Contract-Demo-Services (`omp-source`/`-viewer`/
`-switcher`, `nodes/`) zusätzlich nötig, **nicht** für den Orchestrator
selbst:
- **Rust/Cargo** (`make nodes` baut sie)
- **MXL-Bibliothek** (`deploy/dev/install-mxl.sh`, siehe dessen
  Kopfkommentar) — ohne sie bauen die Nodes zwar (MXL wird per
  `libloading`/`dlopen` erst zur Laufzeit geladen), lassen sich aber nicht
  starten (`libmxl.so … cannot open shared object file`).

## 2. Schnellstart

```sh
make start
```

Das macht in einem Schritt:
1. NATS + NMOS-Registry als Podman-Container starten (`make up`, idempotent).
2. UI-Bundle bauen (`make ui`).
3. Orchestrator-Binary bauen (`orchestrator/` → `bin/omp-orchestrator`).
4. Orchestrator im Hintergrund starten, auf `/healthz` warten.

Danach: **http://localhost:8000** im Browser öffnen — das ist die
Flow-Editor-Shell.

```sh
make status   # kurzer Überblick: Orchestrator/NATS/Registry laufen?
make stop     # stoppt nur den Orchestrator-Prozess (Container bleiben an)
make stop ARGS=--all   # stoppt zusätzlich NATS + NMOS-Registry
make down     # Alternative: nur die Container stoppen (make up macht das rückgängig)
```

Log des Orchestrators: `.run/orchestrator.log` (nicht versioniert).

## 3. Erste Schritte in der GUI

- Der Flow-Editor zeigt zunächst einen leeren Graphen — noch keine Nodes
  registriert.
- Über die Katalog-Palette (links) lassen sich die in `deploy/catalog.json`
  gelisteten Node-Typen aus der GUI heraus starten (Instanz-Launcher,
  `UMSETZUNG.md` C8) — vorausgesetzt, sie wurden vorher gebaut:
  ```sh
  make nodes   # baut nodes/target/debug/{omp-source,omp-switcher,omp-viewer}
  ```
- Gestartete Instanzen erscheinen automatisch als Kacheln (Selbstregistrierung
  über NMOS, kein manuelles Eintragen).

## 4. Troubleshooting

**„Auf Port 8000 antwortet bereits ein Prozess, der nicht über
start-omp.sh/PID-Datei bekannt ist"** — ein verwaister Prozess (z. B. aus
einer manuell im Terminal gestarteten Sitzung) blockiert den Port:
```sh
ss -ltnp | grep 8000     # zeigt PID des Prozesses
kill <PID>                # bzw. kill -9, falls er nicht reagiert
```

**`registry poll failed: connection refused` kurz nach dem Start** — harmlos:
der Orchestrator pollt die NMOS-Registry alle 2 s; unmittelbar nach `make up`
braucht der Registry-Container ein paar hundert ms zum Hochfahren. Verschwindet
von selbst; falls nicht, `podman logs omp-nmos-registry` prüfen.

**`make check` schlägt bei `cargo test -p omp-mediaio` fehl
(`libmxl.so … cannot open shared object file`)** — erwartet, solange
`deploy/dev/install-mxl.sh` nicht gelaufen ist (siehe Voraussetzungen oben).
Betrifft nur die MXL-Nodes, nicht den Orchestrator/die UI.

**Podman rootless startet nicht** — siehe `deploy/quadlets/README.md` bzw.
`docs/decisions.md` (2026-07-07, Toolchain-Installation) für die auf dieser
Dev-Maschine verifizierte Konfiguration.

## 5. Mehr Kontext

- Architektur/Konzepte: `ARCHITECTURE.md` (Referenzdokument, wird bei jeder
  größeren Entscheidung fortgeschrieben)
- Umsetzungsplan/Status: `UMSETZUNG.md` (Status-Checkliste am Ende)
- Einzelentscheidungen/Blocker-Historie: `docs/decisions.md`
