.PHONY: build test check up down ci

build:
	cd orchestrator && go build ./...

test:
	cd orchestrator && go test ./...

check:
	cd orchestrator && go vet ./... && go test ./...
	deno check ui/**/*.ts

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

down:
	-podman stop omp-nats
	-podman rm omp-nats
	-podman stop omp-nmos-registry
	-podman rm omp-nmos-registry

ci: check
