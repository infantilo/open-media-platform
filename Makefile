.PHONY: build test check up down ci

build:
	cd orchestrator && go build ./...

test:
	cd orchestrator && go test ./...

check:
	cd orchestrator && go vet ./... && go test ./...
	deno check ui/**/*.ts

up:
	@echo "Podman-Quadlets: noch nicht eingerichtet (siehe UMSETZUNG.md A2)."
	@exit 1

down:
	@echo "Podman-Quadlets: noch nicht eingerichtet (siehe UMSETZUNG.md A2)."
	@exit 1

ci: check
