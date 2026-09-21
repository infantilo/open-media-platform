.PHONY: build test check check-ci up down ci ui nodes contract start hosts stop status mtls-up mtls-down mtls-issue-certs nmos-registry-tls-up nmos-registry-tls-down nats-tls-up nats-tls-down backup restore proxy-up proxy-down soak

GO_MODULES := orchestrator nodes/mock tools/contract-check tools/nmos-conformance-check host-agent supervisor

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
#
# KEIN Release-Profil für omp-video-mixer-me/omp-multiviewer-custom
# trotz ihres hohen CPU-Verbrauchs (Nutzerfund 2026-08-24, "CPU
# burning", mehrere hundert Prozent bei aktiver Kompositions-Last) —
# per fairem Debug-vs-Release-Vergleich UNTER DERSELBEN echten
# Arbeitslast (4 Multiviewer-Pips, 2 Mixer-Ebenen, nicht im Leerlauf)
# live widerlegt: praktisch kein Unterschied (s. docs/decisions.md
# Nachtrag 163). Die eigentliche Frame-Verarbeitung läuft in
# GStreamer/gst-plugins' eigenem, bereits optimiertem C-Code — Rusts
# Debug-/Release-Profil betrifft nur die dünne Rust-Glue-Schicht
# drumherum, die neben kontinuierlicher Echtzeit-Komposition kaum ins
# Gewicht fällt. Ein erster, vorschneller Vergleich (Leerlauf-Release
# gegen belastetes Debug) hatte fälschlich einen großen Unterschied
# suggeriert — dieser Vergleich war nicht fair, s. Nachtrag 163.
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

# OMP_POSTGRES_URL wird hier explizit exportiert (Nachtrag 108,
# docs/decisions.md): die DB-Store-Tests (workflows/snapshots/hosts/…)
# verbinden sich seit Nachtrag 108 NICHT mehr implizit mit der lokalen
# Dev-Postgres, wenn die Variable fehlt — sie überspringen sich dann
# nur noch. `make test`/`check`/`check-ci` sind bewusste, vom Nutzer
# aufgerufene Vollverifikationen (anders als ein ad-hoc `go test ./...`
# für ein einzelnes Paket) und sollen die DB-Tests weiterhin real gegen
# die per `make up` gestartete Dev-Postgres laufen lassen — deshalb hier
# explizit gesetzt, nicht dem Zufall/der Shell-Umgebung überlassen.
# Multi-Host-DSN + target_session_attrs=read-write statt eines einzelnen
# Ports seit D15 (ARCHITECTURE.md §19.3, Postgres-HA via Patroni) — der
# `pgx`-Treiber verbindet sich automatisch mit dem Knoten, der gerade
# beschreibbar ist (Patronis aktueller Primary), unabhängig von Failover.
DEV_POSTGRES_URL := postgres://omp:omp@localhost:5432,localhost:5442,localhost:5452/omp?sslmode=disable&target_session_attrs=read-write

test:
	$(foreach m,$(GO_MODULES),cd $(m) && OMP_POSTGRES_URL="$(DEV_POSTGRES_URL)" go test ./... && cd $(CURDIR) &&) true
	cd nodes && cargo test --workspace

check:
	$(foreach m,$(GO_MODULES),cd $(m) && go vet ./... && OMP_POSTGRES_URL="$(DEV_POSTGRES_URL)" go test ./... && cd $(CURDIR) &&) true
	deno check ui/**/*.ts
	deno test ui/
	cd nodes && cargo test --workspace && cargo deny check && cargo audit

# CI-Variante von `check`: identische Go/Deno-Schritte, aber OHNE den
# Cargo-Teil (Nutzerentscheidung 2026-07-27, docs/decisions.md) —
# GitHub-Actions-Runner haben third_party/mxl nicht gevendort
# (gitignored, lokal per install-mxl.sh gebaut) und können den
# Rust-Workspace deshalb gar nicht erst manifest-auflösen (`mxl`/
# `mxl-sys` sind PATH-Dependencies von omp-mediaio, Cargo lädt deren
# Manifest workspace-weit auch dann, wenn das jeweilige Feature nicht
# aktiv ist). Rust/MXL-Code bleibt wie bisher Pflicht zur echten
# lokalen Live-Verifikation vor jedem Commit (`make check`, s. Historie
# in docs/decisions.md) — nur nicht Teil des automatisierten
# GitHub-Actions-Gates. OMP_POSTGRES_URL wird hier NICHT gesetzt — ein
# GitHub-Actions-Runner hat ohnehin keine Postgres unter dieser DSN
# laufen, die DB-Tests überspringen sich dort wie schon zuvor.
check-ci:
	$(foreach m,$(GO_MODULES),cd $(m) && go vet ./... && go test ./... && cd $(CURDIR) &&) true
	deno check ui/**/*.ts
	deno test ui/

# Dev-Fallback statt systemd-Quadlets: die auf dieser Maschine verfügbare
# Podman-Version (Debian bookworm, 4.3.1) unterstützt Quadlets erst ab 4.4+
# (siehe docs/decisions.md). deploy/quadlets/*.container bleibt als
# Referenz für spätere On-Prem-Produktion (ARCHITECTURE.md §4.3) erhalten.
#
# NATS-Clustering (ARCHITECTURE.md §19.3 Punkt 7, UMSETZUNG.md D14):
# drei Knoten statt einem — ein Einzelknoten überlebt seinen eigenen
# Ausfall nicht, egal wie viele Clients verbunden sind. --network=host
# statt eines eigenen Podman-Netzwerks (wie schon bei `proxy-up`/Caddy):
# rootless Podmans Default-Bridge bietet keine zuverlässige Container-
# Namensauflösung für die --routes-Adressen zwischen den drei Knoten;
# mit Host-Networking erreicht jeder Knoten die anderen zwei einfach
# über 127.0.0.1:<eigener Port>, drei disjunkte Portsätze statt
# Container-DNS. Client-Ports 4222/4223/4224 (orchestrator/internal/
# config.go defaultNatsURL und host-agent/main.go defaultNatsURL
# erwarten exakt diese drei) — ein einzelner NATS-Client braucht dafür
# KEINEN Code-Unterschied zum früheren Ein-Knoten-Setup: `nats.Connect`/
# `async-nats` bekommen einfach eine kommagetrennte Drei-Adressen-Liste
# statt einer einzelnen und failen bei Verbindungsverlust selbst auf
# einen der beiden anderen Knoten um.
up:
	@if podman container exists omp-nats-1; then \
		podman start omp-nats-1; \
	else \
		podman run -d --name omp-nats-1 --restart=always --network=host \
			docker.io/library/nats:latest -js --server_name omp-nats-1 -p 4222 -m 8222 \
			--cluster_name OMP --cluster nats://127.0.0.1:6222 \
			--routes nats://127.0.0.1:6223,nats://127.0.0.1:6224; \
	fi
	@if podman container exists omp-nats-2; then \
		podman start omp-nats-2; \
	else \
		podman run -d --name omp-nats-2 --restart=always --network=host \
			docker.io/library/nats:latest -js --server_name omp-nats-2 -p 4223 -m 8223 \
			--cluster_name OMP --cluster nats://127.0.0.1:6223 \
			--routes nats://127.0.0.1:6222,nats://127.0.0.1:6224; \
	fi
	@if podman container exists omp-nats-3; then \
		podman start omp-nats-3; \
	else \
		podman run -d --name omp-nats-3 --restart=always --network=host \
			docker.io/library/nats:latest -js --server_name omp-nats-3 -p 4224 -m 8224 \
			--cluster_name OMP --cluster nats://127.0.0.1:6224 \
			--routes nats://127.0.0.1:6222,nats://127.0.0.1:6223; \
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
	@$(MAKE) postgres-up

# Postgres-HA (ARCHITECTURE.md §19.3, UMSETZUNG.md D15) — ersetzt den
# bisherigen Einzelknoten-omp-postgres-Container: etcd-Dreiknoten-Cluster
# (Patronis DCS/Failover-Koordinator, gleiche Rolle wie Raft bei D12, aber
# ein eigenständiges, für genau diesen Zweck gebautes Tool statt
# Marke-Eigenbau) + Patroni-verwaltetes Postgres (1 Primary + 2 Replikate,
# Streaming-Replikation, automatische Promotion bei Primary-Ausfall).
# Eigenes Target statt Teil von `up` direkt, weil der Erstlauf eine
# Reihenfolge braucht (s. u.), die eine einzelne flache `up`-Befehlsliste
# nicht sauber ausdrücken kann.
#
# Bootstrap-Reihenfolge nur beim ALLERERSTEN Start nötig (kein Container
# existiert noch): Knoten 1 muss `initdb` abgeschlossen und sich selbst
# als Primary in etcd eingetragen haben, BEVOR Knoten 2/3 starten — alle
# drei gleichzeitig zu starten lässt sie alle unendlich auf "waiting for
# leader to bootstrap" hängen (live gefunden, 2026-08-18, s.
# docs/decisions.md D15: jeder Knoten sieht in der Race-Situation bereits
# Mitgliedseinträge der anderen in etcd, aber keinen erfolgreich
# gesetzten Initialize-Schlüssel, und hält sich deshalb selbst für nicht
# bootstrap-berechtigt). Bei einem Neustart bereits bestehender Container
# (Normalfall nach dem ersten `make up`) entfällt das: jeder Knoten kennt
# seine Rolle bereits aus eigenem Datenverzeichnis + etcd, `podman start`
# in beliebiger Reihenfolge reicht.
postgres-up:
	@podman image exists localhost/omp-patroni:latest || \
		podman build -t localhost/omp-patroni:latest -f deploy/patroni/Dockerfile deploy/patroni
	@for n in 1 2 3; do \
		case $$n in \
			1) PEER=2380; CLI=2379 ;; \
			2) PEER=2390; CLI=2389 ;; \
			3) PEER=2400; CLI=2399 ;; \
		esac; \
		if podman container exists omp-etcd-$$n; then \
			podman start omp-etcd-$$n; \
		else \
			podman run -d --name omp-etcd-$$n --restart=always --network=host \
				quay.io/coreos/etcd:v3.5.17 etcd \
				--name etcd-$$n --data-dir /etcd-data \
				--initial-advertise-peer-urls http://127.0.0.1:$$PEER --listen-peer-urls http://127.0.0.1:$$PEER \
				--listen-client-urls http://127.0.0.1:$$CLI --advertise-client-urls http://127.0.0.1:$$CLI \
				--initial-cluster-token omp-etcd-cluster \
				--initial-cluster etcd-1=http://127.0.0.1:2380,etcd-2=http://127.0.0.1:2390,etcd-3=http://127.0.0.1:2400 \
				--initial-cluster-state new; \
		fi; \
	done
	@FRESH=false; \
	podman container exists omp-patroni-1 || FRESH=true; \
	if podman container exists omp-patroni-1; then \
		podman start omp-patroni-1; \
	else \
		podman run -d --name omp-patroni-1 --restart=always --network=host \
			-e PATRONI_NAME=omp-patroni-1 -e PATRONI_SCOPE=omp-postgres \
			-e PATRONI_ETCD3_HOSTS=127.0.0.1:2379,127.0.0.1:2389,127.0.0.1:2399 \
			-e PATRONI_RESTAPI_LISTEN=127.0.0.1:8008 -e PATRONI_RESTAPI_CONNECT_ADDRESS=127.0.0.1:8008 \
			-e PATRONI_POSTGRESQL_LISTEN=127.0.0.1:5432 -e PATRONI_POSTGRESQL_CONNECT_ADDRESS=127.0.0.1:5432 \
			-e PATRONI_POSTGRESQL_DATA_DIR=/home/postgres/pgdata \
			-e PATRONI_SUPERUSER_USERNAME=postgres -e PATRONI_SUPERUSER_PASSWORD=omp-superuser-dev \
			-e PATRONI_REPLICATION_USERNAME=replicator -e PATRONI_REPLICATION_PASSWORD=omp-replicator-dev \
			localhost/omp-patroni:latest; \
	fi; \
	if [ "$$FRESH" = "true" ]; then \
		echo "Warte auf Erst-Bootstrap von omp-patroni-1 (initdb)..."; \
		for i in $$(seq 1 30); do \
			ROLE=$$(curl -s http://127.0.0.1:8008/patroni 2>/dev/null | grep -o '"role": *"[^"]*"' | cut -d'"' -f4); \
			[ "$$ROLE" = "primary" ] && break; \
			sleep 2; \
		done; \
	fi
	@for n in 2 3; do \
		if podman container exists omp-patroni-$$n; then \
			podman start omp-patroni-$$n; \
		else \
			case $$n in 2) PGPORT=5442; RESTPORT=8018 ;; 3) PGPORT=5452; RESTPORT=8028 ;; esac; \
			podman run -d --name omp-patroni-$$n --restart=always --network=host \
				-e PATRONI_NAME=omp-patroni-$$n -e PATRONI_SCOPE=omp-postgres \
				-e PATRONI_ETCD3_HOSTS=127.0.0.1:2379,127.0.0.1:2389,127.0.0.1:2399 \
				-e PATRONI_RESTAPI_LISTEN=127.0.0.1:$$RESTPORT -e PATRONI_RESTAPI_CONNECT_ADDRESS=127.0.0.1:$$RESTPORT \
				-e PATRONI_POSTGRESQL_LISTEN=127.0.0.1:$$PGPORT -e PATRONI_POSTGRESQL_CONNECT_ADDRESS=127.0.0.1:$$PGPORT \
				-e PATRONI_POSTGRESQL_DATA_DIR=/home/postgres/pgdata \
				-e PATRONI_SUPERUSER_USERNAME=postgres -e PATRONI_SUPERUSER_PASSWORD=omp-superuser-dev \
				-e PATRONI_REPLICATION_USERNAME=replicator -e PATRONI_REPLICATION_PASSWORD=omp-replicator-dev \
				localhost/omp-patroni:latest; \
		fi; \
	done

down:
	-podman stop omp-nats-1 omp-nats-2 omp-nats-3
	-podman rm omp-nats-1 omp-nats-2 omp-nats-3
	-podman stop omp-nmos-registry
	-podman rm omp-nmos-registry
	-podman stop omp-patroni-1 omp-patroni-2 omp-patroni-3
	-podman rm omp-patroni-1 omp-patroni-2 omp-patroni-3
	-podman stop omp-etcd-1 omp-etcd-2 omp-etcd-3
	-podman rm omp-etcd-1 omp-etcd-2 omp-etcd-3

# Einfacher Einstiegspunkt für die ganze Dev-Umgebung (docs/HANDBUCH.md):
# NATS + NMOS-Registry (make up) + UI-Bundle + Orchestrator-Binary bauen,
# Orchestrator im Hintergrund starten, auf /healthz warten.
start:
	@./deploy/dev/start-omp.sh

# Simulierte Multi-Host-Konfiguration (Nutzerfrage 2026-08-14, "wie
# starte ich das nächste Mal in der aktuellen Multi-Host-Konfiguration"):
# zwei omp-host-agent-Prozesse ("Regie-Host-A"/"Regie-Host-B") auf
# derselben Maschine, docs/HANDBUCH.md §2.2. Bewusst NICHT Teil von
# `make start` (Opt-in, wie der Supervisor kein eigenes `make`-Target
# für den Start braucht — hier trotzdem eins, weil zwei Prozesse statt
# einem gestartet werden). `make stop ARGS=--all` stoppt sie wieder mit.
hosts:
	@./deploy/dev/start-hosts.sh

# Stoppt nur den Orchestrator-Prozess (Container laufen weiter, schnelles
# Neustarten). `make stop ARGS=--all` stoppt zusätzlich Supervisor,
# simulierte Host-Agents (falls per `make hosts` gestartet) und
# NATS/Registry/Postgres.
stop:
	@./deploy/dev/stop-omp.sh $(ARGS)

status:
	@if [ -f .run/orchestrator.pid ] && kill -0 "$$(cat .run/orchestrator.pid)" 2>/dev/null; then \
		echo "Orchestrator: läuft (PID $$(cat .run/orchestrator.pid)), http://localhost:8000"; \
	else \
		echo "Orchestrator: nicht gestartet (make start)"; \
	fi
	@for n in 1 2 3; do \
		podman container exists omp-nats-$$n && echo "NATS-Knoten $$n: läuft" || echo "NATS-Knoten $$n: gestoppt"; \
	done
	@podman container exists omp-nmos-registry && echo "NMOS-Registry: läuft" || echo "NMOS-Registry: gestoppt"
	@for n in 1 2 3; do \
		podman container exists omp-etcd-$$n && echo "etcd-Knoten $$n: läuft" || echo "etcd-Knoten $$n: gestoppt"; \
	done
	@for n in 1 2 3; do \
		if podman container exists omp-patroni-$$n; then \
			case $$n in 1) PORT=8008 ;; 2) PORT=8018 ;; 3) PORT=8028 ;; esac; \
			ROLE=$$(curl -s http://127.0.0.1:$$PORT/patroni 2>/dev/null | grep -o '"role": *"[^"]*"' | cut -d'"' -f4); \
			echo "Postgres-Knoten $$n: läuft (Rolle: $${ROLE:-unbekannt})"; \
		else \
			echo "Postgres-Knoten $$n: gestoppt"; \
		fi; \
	done
	@podman container exists omp-step-ca && echo "step-ca: läuft" || echo "step-ca: gestoppt (optional, siehe 'make mtls-up')"
	@podman container exists omp-caddy && echo "Caddy-Reverse-Proxy: läuft, https://localhost:8443" || echo "Caddy-Reverse-Proxy: gestoppt (optional, siehe 'make proxy-up')"
	@if [ -f .run/supervisor.pid ] && kill -0 "$$(cat .run/supervisor.pid)" 2>/dev/null; then \
		echo "Supervisor (Backup/Restore): läuft (PID $$(cat .run/supervisor.pid))"; \
	else \
		echo "Supervisor (Backup/Restore): nicht gestartet"; \
	fi
	@if [ -f .run/host1/pid ] && kill -0 "$$(cat .run/host1/pid)" 2>/dev/null; then \
		echo "Host-Agent Regie-Host-A: läuft (PID $$(cat .run/host1/pid))"; \
	else \
		echo "Host-Agent Regie-Host-A: nicht gestartet (optional, siehe 'make hosts')"; \
	fi
	@if [ -f .run/host2/pid ] && kill -0 "$$(cat .run/host2/pid)" 2>/dev/null; then \
		echo "Host-Agent Regie-Host-B: läuft (PID $$(cat .run/host2/pid))"; \
	else \
		echo "Host-Agent Regie-Host-B: nicht gestartet (optional, siehe 'make hosts')"; \
	fi

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

# Stellt Dev-Zertifikate für Orchestrator + Mock-Node + NMOS-Registry aus
# (braucht 'make mtls-up' zuerst). Danach: OMP_MTLS_ENABLED=true beim
# Start beider Prozesse setzen (deploy/dev/mtls-issue-cert.sh dokumentiert
# die Pfade); für die Registry-TLS-Strecke (BCP-003-01, UMSETZUNG.md D16)
# zusätzlich 'make nmos-registry-tls-up' + OMP_REGISTRY_TLS_ENABLED=true
# + OMP_REGISTRY_URL=https://localhost:8010 beim Orchestrator.
mtls-issue-certs:
	@./deploy/dev/mtls-issue-cert.sh orchestrator .run/mtls/orchestrator.crt .run/mtls/orchestrator.key
	@./deploy/dev/mtls-issue-cert.sh mock-node .run/mtls/mock-node.crt .run/mtls/mock-node.key localhost 127.0.0.1
	@./deploy/dev/mtls-issue-cert.sh nmos-registry .run/mtls/nmos-registry.crt .run/mtls/nmos-registry.key localhost 127.0.0.1
	@./deploy/dev/mtls-issue-cert.sh nats-server .run/mtls/nats-server.crt .run/mtls/nats-server.key localhost 127.0.0.1
	@./deploy/dev/mtls-issue-cert.sh nats-client .run/mtls/nats-client.crt .run/mtls/nats-client.key

# NMOS-Registry mit BCP-003-01-Transport-TLS statt Klartext (UMSETZUNG.md
# D16) — bewusst NICHT Teil von `make up`, gleiches Opt-in-Muster wie
# mtls-up: der normale Dev-Workflow (Klartext-Registry, s. `up`-Target)
# bleibt unverändert. Braucht 'make mtls-up' + 'make mtls-issue-certs'
# zuerst (liefert .run/mtls/nmos-registry.{crt,key} + root_ca.crt). Ersetzt
# den laufenden omp-nmos-registry-Container durch dieselbe Registry mit
# deploy/nmos/registry-tls.json (server_secure/ca_certificate_file/
# server_certificates, s. dort) statt registry.json — derselbe Container-
# Name, damit Orchestrator/Nodes unverändert "die NMOS-Registry" sehen,
# nur über https:// statt http:// erreichbar.
nmos-registry-tls-up:
	@[ -f .run/mtls/nmos-registry.crt ] || (echo "Registry-Zertifikat fehlt — zuerst 'make mtls-up' und 'make mtls-issue-certs' ausführen." >&2; exit 1)
	-podman stop omp-nmos-registry
	-podman rm omp-nmos-registry
	podman run -d --name omp-nmos-registry --restart=always \
		-p 8010:8010 -p 8011:8011 \
		-v $(CURDIR)/deploy/nmos/registry-tls.json:/home/registry.json:ro,Z \
		-v $(CURDIR)/.run/mtls:/home/certs:ro,Z \
		-e RUN_NODE=FALSE \
		docker.io/rhastie/nmos-cpp:latest
	@echo "NMOS-Registry jetzt per BCP-003-01-TLS erreichbar: https://localhost:8010 (Root-CA: .run/mtls/root_ca.crt)"

# Zurück zur Klartext-Registry (registry.json) — gleicher Container-Name,
# einfach per 'make up' erneut mit der alten Konfiguration gestartet.
nmos-registry-tls-down:
	-podman stop omp-nmos-registry
	-podman rm omp-nmos-registry
	@echo "Klartext-Registry wieder mit 'make up' starten."

# NATS mit Client-TLS (mTLS, ARCHITECTURE.md §20.4 Restlücke "NATS-
# Verschlüsselung") statt Klartext — gleiches Opt-in-Muster wie
# nmos-registry-tls-up: der normale Dev-Workflow ('make up', Klartext)
# bleibt unverändert. Braucht 'make mtls-up' + 'make mtls-issue-certs'
# zuerst (liefert .run/mtls/nats-{server,client}.{crt,key} +
# root_ca.crt). Nur der CLIENT-Port (4222/4223/4224) bekommt TLS —
# `--tls`/`--tlsverify` ohne zusätzliche `cluster: {tls: ...}`-Config
# lässt die Drei-Knoten-Cluster-Routen (6222-6224, `--cluster`/
# `--routes`) unverändert Klartext; Cluster-Route-TLS ist eine eigene,
# hier bewusst nicht mitgelöste Entscheidung (die drei Knoten laufen
# ohnehin alle auf demselben Host über 127.0.0.1, kein Netzwerk-Hop).
# `--tlsverify` verlangt zusätzlich ein gültiges Client-Zertifikat (also
# echtes mTLS, nicht nur Server-TLS) — Orchestrator/host-agent/jede
# Rust-Node-Instanz nutzen dafür EIN gemeinsames `nats-client`-
# Zertifikat (Scope-Vereinfachung: eine geteilte Fleet-Identität statt
# echter Pro-Instanz-Zertifikate, s. ARCHITECTURE.md §20.4).
nats-tls-up:
	@[ -f .run/mtls/nats-server.crt ] || (echo "NATS-Zertifikat fehlt — zuerst 'make mtls-up' und 'make mtls-issue-certs' ausführen." >&2; exit 1)
	-podman stop omp-nats-1 omp-nats-2 omp-nats-3
	-podman rm omp-nats-1 omp-nats-2 omp-nats-3
	podman run -d --name omp-nats-1 --restart=always --network=host \
		-v $(CURDIR)/.run/mtls:/certs:ro,Z \
		docker.io/library/nats:latest -js --server_name omp-nats-1 -p 4222 -m 8222 \
		--cluster_name OMP --cluster nats://127.0.0.1:6222 \
		--routes nats://127.0.0.1:6223,nats://127.0.0.1:6224 \
		--tls --tlscert=/certs/nats-server.crt --tlskey=/certs/nats-server.key --tlscacert=/certs/root_ca.crt --tlsverify
	podman run -d --name omp-nats-2 --restart=always --network=host \
		-v $(CURDIR)/.run/mtls:/certs:ro,Z \
		docker.io/library/nats:latest -js --server_name omp-nats-2 -p 4223 -m 8223 \
		--cluster_name OMP --cluster nats://127.0.0.1:6223 \
		--routes nats://127.0.0.1:6222,nats://127.0.0.1:6224 \
		--tls --tlscert=/certs/nats-server.crt --tlskey=/certs/nats-server.key --tlscacert=/certs/root_ca.crt --tlsverify
	podman run -d --name omp-nats-3 --restart=always --network=host \
		-v $(CURDIR)/.run/mtls:/certs:ro,Z \
		docker.io/library/nats:latest -js --server_name omp-nats-3 -p 4224 -m 8224 \
		--cluster_name OMP --cluster nats://127.0.0.1:6224 \
		--routes nats://127.0.0.1:6222,nats://127.0.0.1:6223 \
		--tls --tlscert=/certs/nats-server.crt --tlskey=/certs/nats-server.key --tlscacert=/certs/root_ca.crt --tlsverify
	@echo "NATS jetzt per mTLS erreichbar (4222-4224). Orchestrator/host-agent/Nodes brauchen OMP_NATS_TLS_ENABLED=true + _CERT_FILE/_KEY_FILE/_CA_FILE (s. ARCHITECTURE.md §20.4)."

# Zurück zu Klartext-NATS — gleiche Container-Namen, per 'make up'
# erneut ohne TLS-Flags gestartet.
nats-tls-down:
	-podman stop omp-nats-1 omp-nats-2 omp-nats-3
	-podman rm omp-nats-1 omp-nats-2 omp-nats-3
	@echo "Klartext-NATS wieder mit 'make up' starten."

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
			-e OMP_PUBLIC_HOST=$${OMP_PUBLIC_HOST:-localhost} \
			-v $(CURDIR)/deploy/dev/Caddyfile:/etc/caddy/Caddyfile:ro,Z \
			-v $(CURDIR)/.run/caddy:/data \
			docker.io/library/caddy:latest; \
	fi
	@echo "Reverse-Proxy bereit: https://localhost:8443 (selbstsigniertes Caddy-Zertifikat, s. docs/HANDBUCH.md)"
	@echo "Handy-Kamera (omp-webrtc-gateway auf OMP_PORT=9440): https://$${OMP_PUBLIC_HOST:-localhost}:9441"

proxy-down:
	-podman stop omp-caddy
	-podman rm omp-caddy

# S8 (docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md) — startet den Stack
# (falls nicht bereits gestartet) + 2 Test-Nodes, sammelt /metrics alle
# 60s über 1h in eine CSV (.run/soak/). `make soak ARGS="1800 30"` für
# abweichende Dauer/Intervall (Sekunden). Strg+C bricht früher ab, die
# CSV bis dahin bleibt gültig.
soak:
	@./deploy/dev/soak-omp.sh $(ARGS)

ci: check
