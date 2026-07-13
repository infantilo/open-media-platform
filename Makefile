.PHONY: build test check up down ci ui nodes contract start stop status

GO_MODULES := orchestrator nodes/mock tools/contract-check tools/nmos-conformance-check

build: ui
	$(foreach m,$(GO_MODULES),cd $(m) && go build ./... && cd $(CURDIR) &&) true
	cd nodes && cargo build --workspace --examples

# Bundelt die Shell (Engineering-/Console-Ansicht, UMSETZUNG.md C13) zu
# browserlauffähigem JS (ui/dist, nicht versioniert). ui/shell/shell.ts
# ist seit C13 der einzige Einstiegspunkt (importiert flow-canvas.ts
# selbst) — Browser können kein .ts ausführen; `deno bundle` übernimmt
# das Stripping der Typen ohne Node/npm-Build-Toolchain.
ui:
	mkdir -p ui/dist
	deno bundle ui/shell/shell.ts -o ui/dist/shell.js

# Baut die per deploy/catalog.json vom Instanz-Launcher startbaren Node-
# Binaries (UMSETZUNG.md C8) — separates Target von `build`, weil der
# Launcher vorgebaute Binaries erwartet, kein `cargo run` pro Start.
nodes:
	cd nodes && cargo build --workspace --bins

# Prüft den Node-Contract (ARCHITECTURE.md §5) gegen einen laufenden
# Node (UMSETZUNG.md C9). NODE_URL erforderlich, z. B.:
#   make contract NODE_URL=http://localhost:9320
# OMP_REGISTRY_URL optional (Default http://localhost:8010) — falls
# gebraucht, vor dem Aufruf exportieren, nicht hier setzen (sonst würde
# ein leerer Wert den Go-seitigen Fallback überschreiben).
contract:
	cd tools/contract-check && NODE_URL=$(NODE_URL) go run .

test:
	$(foreach m,$(GO_MODULES),cd $(m) && go test ./... && cd $(CURDIR) &&) true
	cd nodes && cargo test --workspace

check:
	$(foreach m,$(GO_MODULES),cd $(m) && go vet ./... && go test ./... && cd $(CURDIR) &&) true
	deno check ui/**/*.ts
	deno test ui/
	cd nodes && cargo test --workspace && cargo deny check && cargo audit

# Dev-Fallback statt systemd-Quadlets: die auf dieser Maschine verfügbare
# Podman-Version (Debian bookworm, 4.3.1) unterstützt Quadlets erst ab 4.4+
# (siehe docs/decisions.md). deploy/quadlets/*.container bleibt als
# Referenz für spätere On-Prem-Produktion (ARCHITECTURE.md §4.3) erhalten.
up:
	@if podman container exists omp-nats; then \
		podman start omp-nats; \
	else \
		podman run -d --name omp-nats --restart=always \
			-p 4222:4222 -p 8222:8222 \
			docker.io/library/nats:latest -js -m 8222; \
	fi
	@if podman container exists omp-nmos-registry; then \
		podman start omp-nmos-registry; \
	else \
		podman run -d --name omp-nmos-registry --restart=always \
			-p 8010:8010 -p 8011:8011 \
			-v $(CURDIR)/deploy/nmos/registry.json:/home/registry.json:ro,Z \
			-e RUN_NODE=FALSE \
			docker.io/rhastie/nmos-cpp:latest; \
	fi
	@if podman container exists omp-postgres; then \
		podman start omp-postgres; \
	else \
		podman run -d --name omp-postgres --restart=always \
			-p 5432:5432 \
			-e POSTGRES_USER=omp -e POSTGRES_PASSWORD=omp -e POSTGRES_DB=omp \
			docker.io/library/postgres:16-alpine; \
	fi

down:
	-podman stop omp-nats
	-podman rm omp-nats
	-podman stop omp-nmos-registry
	-podman rm omp-nmos-registry
	-podman stop omp-postgres
	-podman rm omp-postgres

# Einfacher Einstiegspunkt für die ganze Dev-Umgebung (docs/HANDBUCH.md):
# NATS + NMOS-Registry (make up) + UI-Bundle + Orchestrator-Binary bauen,
# Orchestrator im Hintergrund starten, auf /healthz warten.
start:
	@./deploy/dev/start-omp.sh

# Stoppt nur den Orchestrator-Prozess (Container laufen weiter, schnelles
# Neustarten). `make stop ARGS=--all` stoppt zusätzlich NATS/Registry.
stop:
	@./deploy/dev/stop-omp.sh $(ARGS)

status:
	@if [ -f .run/orchestrator.pid ] && kill -0 "$$(cat .run/orchestrator.pid)" 2>/dev/null; then \
		echo "Orchestrator: läuft (PID $$(cat .run/orchestrator.pid)), http://localhost:8000"; \
	else \
		echo "Orchestrator: nicht gestartet (make start)"; \
	fi
	@podman container exists omp-nats && echo "NATS: läuft" || echo "NATS: gestoppt"
	@podman container exists omp-nmos-registry && echo "NMOS-Registry: läuft" || echo "NMOS-Registry: gestoppt"
	@podman container exists omp-postgres && echo "Postgres: läuft" || echo "Postgres: gestoppt"

ci: check
