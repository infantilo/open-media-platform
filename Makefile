.PHONY: build test check up down ci ui nodes contract start stop status mtls-up mtls-down mtls-issue-certs backup restore proxy-up proxy-down

GO_MODULES := orchestrator nodes/mock tools/contract-check tools/nmos-conformance-check host-agent

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
	@podman container exists omp-step-ca && echo "step-ca: läuft" || echo "step-ca: gestoppt (optional, siehe 'make mtls-up')"
	@podman container exists omp-caddy && echo "Caddy-Reverse-Proxy: läuft, https://localhost:8443" || echo "Caddy-Reverse-Proxy: gestoppt (optional, siehe 'make proxy-up')"

# Backup/Restore (S9, docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md) —
# .backups/omp-<timestamp>.sql.gz, Rotation N=14. `make restore
# ARGS=.backups/omp-<timestamp>.sql.gz` (verlangt gestoppten
# Orchestrator + interaktive Bestätigung, s. restore-omp.sh).
backup:
	@./deploy/dev/backup-omp.sh

restore:
	@./deploy/dev/restore-omp.sh $(ARGS)

# step-ca (UMSETZUNG.md D3, ARCHITECTURE.md §4.6) — bewusst NICHT Teil von
# `make up`: mTLS ist opt-in (OMP_MTLS_ENABLED, s. orchestrator/internal/
# config.go), der normale Dev-Workflow ohne mTLS soll unverändert ohne
# CA-Container auskommen. `.run/step-ca` persistiert die CA über
# Neustarts hinweg (wie bei Postgres/D1: ephemer über `make mtls-down`,
# das ist für Dev ausreichend, s. docs/decisions.md D3).
mtls-up:
	@mkdir -p .run/step-ca
	@[ -f .run/step-ca/password.txt ] || openssl rand -base64 32 > .run/step-ca/password.txt
	@if podman container exists omp-step-ca; then \
		podman start omp-step-ca; \
	else \
		podman run -d --name omp-step-ca --restart=always \
			--userns=keep-id \
			-p 9000:9000 \
			-v $(CURDIR)/.run/step-ca:/home/step \
			-e DOCKER_STEPCA_INIT_NAME="OpenMediaPlatform Dev CA" \
			-e DOCKER_STEPCA_INIT_DNS_NAMES="localhost,127.0.0.1" \
			-e DOCKER_STEPCA_INIT_PROVISIONER_NAME="omp-dev" \
			-e DOCKER_STEPCA_INIT_PASSWORD_FILE=/home/step/password.txt \
			docker.io/smallstep/step-ca:latest; \
	fi
	@echo "Warte auf step-ca-Initialisierung..."
	@for i in $$(seq 1 20); do \
		[ -f .run/step-ca/certs/root_ca.crt ] && break; \
		sleep 1; \
	done
	@[ -f .run/step-ca/certs/root_ca.crt ] || (echo "step-ca nicht rechtzeitig initialisiert, 'podman logs omp-step-ca' prüfen" >&2; exit 1)
	@echo "step-ca bereit: https://localhost:9000, Root-CA .run/step-ca/certs/root_ca.crt"

mtls-down:
	-podman stop omp-step-ca
	-podman rm omp-step-ca

# Stellt Dev-Zertifikate für Orchestrator + Mock-Node aus (braucht
# 'make mtls-up' zuerst). Danach: OMP_MTLS_ENABLED=true beim Start beider
# Prozesse setzen (deploy/dev/mtls-issue-cert.sh dokumentiert die Pfade).
mtls-issue-certs:
	@./deploy/dev/mtls-issue-cert.sh orchestrator .run/mtls/orchestrator.crt .run/mtls/orchestrator.key
	@./deploy/dev/mtls-issue-cert.sh mock-node .run/mtls/mock-node.crt .run/mtls/mock-node.key localhost 127.0.0.1

# Caddy-Reverse-Proxy mit TLS-Terminierung (S7, docs/REVIEW-2026-07-17-
# SKALIERUNG-24-7.md) — bewusst NICHT Teil von `make up`: Remote-Zugriff
# ist opt-in, der normale lokale Dev-Workflow (Bearer-Token übers
# Klartext-http://localhost:8000) bleibt unverändert. `--network=host`
# statt einer Podman-Bridge, damit der Container 127.0.0.1:8000 (den
# bare-Prozess-Orchestrator auf dem Host, kein eigener Container)
# direkt erreicht, ohne einen Host-Gateway-Alias zu brauchen — für den
# reinen Dev-Anwendungsfall ausreichend. `.run/caddy` persistiert
# Caddys lokale CA über Neustarts hinweg (gleiches Muster wie
# `.run/step-ca` bei mtls-up), sonst müsste der Browser das
# selbstsignierte Zertifikat bei jedem `make proxy-up` neu akzeptieren.
proxy-up:
	@mkdir -p .run/caddy
	@if podman container exists omp-caddy; then \
		podman start omp-caddy; \
	else \
		podman run -d --name omp-caddy --restart=always \
			--network=host \
			-v $(CURDIR)/deploy/dev/Caddyfile:/etc/caddy/Caddyfile:ro,Z \
			-v $(CURDIR)/.run/caddy:/data \
			docker.io/library/caddy:latest; \
	fi
	@echo "Reverse-Proxy bereit: https://localhost:8443 (selbstsigniertes Caddy-Zertifikat, s. docs/HANDBUCH.md)"

proxy-down:
	-podman stop omp-caddy
	-podman rm omp-caddy

ci: check
