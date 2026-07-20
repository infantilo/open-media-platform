module github.com/infantilo/openmediaplatform/orchestrator

go 1.26.4

require (
	github.com/lib/pq v1.12.3
	github.com/nats-io/nats.go v1.52.0
	github.com/santhosh-tekuri/jsonschema/v6 v6.0.2
	golang.org/x/crypto v0.49.0
)

require golang.org/x/text v0.35.0 // indirect

require (
	github.com/infantilo/openmediaplatform/tools/contract-check v0.0.0-00010101000000-000000000000
	github.com/klauspost/compress v1.18.5 // indirect
	github.com/nats-io/nkeys v0.4.15 // indirect
	github.com/nats-io/nuid v1.0.1 // indirect
	golang.org/x/sys v0.42.0 // indirect
)

replace github.com/infantilo/openmediaplatform/tools/contract-check => ../tools/contract-check
