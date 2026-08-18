module github.com/infantilo/openmediaplatform/orchestrator

go 1.26.4

require (
	github.com/lib/pq v1.12.3
	github.com/nats-io/nats.go v1.52.0
	github.com/santhosh-tekuri/jsonschema/v6 v6.0.2
	golang.org/x/crypto v0.49.0
)

require (
	github.com/armon/go-metrics v0.4.1 // indirect
	github.com/boltdb/bolt v1.3.1 // indirect
	github.com/fatih/color v1.13.0 // indirect
	github.com/hashicorp/go-hclog v1.6.2 // indirect
	github.com/hashicorp/go-immutable-radix v1.0.0 // indirect
	github.com/hashicorp/go-metrics v0.5.4 // indirect
	github.com/hashicorp/go-msgpack/v2 v2.1.2 // indirect
	github.com/hashicorp/golang-lru v0.5.0 // indirect
	github.com/hashicorp/raft v1.7.3 // indirect
	github.com/hashicorp/raft-boltdb/v2 v2.3.1 // indirect
	github.com/mattn/go-colorable v0.1.12 // indirect
	github.com/mattn/go-isatty v0.0.14 // indirect
	go.etcd.io/bbolt v1.3.5 // indirect
	golang.org/x/text v0.35.0 // indirect
)

require (
	github.com/infantilo/openmediaplatform/tools/contract-check v0.0.0-00010101000000-000000000000
	github.com/klauspost/compress v1.18.5 // indirect
	github.com/nats-io/nkeys v0.4.15 // indirect
	github.com/nats-io/nuid v1.0.1 // indirect
	golang.org/x/sys v0.42.0 // indirect
)

replace github.com/infantilo/openmediaplatform/tools/contract-check => ../tools/contract-check
