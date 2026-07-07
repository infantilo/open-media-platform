// Package health verbindet den Mock-Node mit dem NATS-Event-Bus und
// veröffentlicht periodisch seinen Health-Status (UMSETZUNG.md A7:
// "omp.health.<id>, alle 5s"). Nutzt den offiziellen nats.go-Client —
// gleiche Ausnahme von der Minimal-Dependency-Regel wie im Orchestrator
// (docs/decisions.md, Schritt A6).
package health

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go"
)

// Status ist der auf omp.health.<id> veröffentlichte Payload.
type Status struct {
	NodeID    string `json:"node_id"`
	Label     string `json:"label"`
	Status    string `json:"status"`
	Senders   int    `json:"senders"`
	Receivers int    `json:"receivers"`
}

// Publisher verbindet sich mit NATS und veröffentlicht Status-Snapshots.
type Publisher struct {
	nc *nats.Conn
}

// Connect stellt die Verbindung her. Ein initial nicht erreichbares NATS
// ist nicht fatal (RetryOnFailedConnect): der Mock-Node läuft weiter und
// verbindet sich im Hintergrund, sobald NATS erreichbar ist — konsistent
// mit der Resilienz-Linie des Orchestrators (internal/eventbus).
func Connect(url string) (*Publisher, error) {
	nc, err := nats.Connect(url,
		nats.Name("openmediaplatform-mock-node"),
		nats.RetryOnFailedConnect(true),
		nats.MaxReconnects(-1),
		nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
			slog.Warn("nats disconnected", "error", err)
		}),
	)
	if err != nil {
		return nil, err
	}
	return &Publisher{nc: nc}, nil
}

// Close schließt die NATS-Verbindung.
func (p *Publisher) Close() {
	p.nc.Close()
}

// Publish veröffentlicht status auf omp.health.<status.NodeID>.
func (p *Publisher) Publish(status Status) error {
	data, err := json.Marshal(status)
	if err != nil {
		return err
	}
	return p.nc.Publish(fmt.Sprintf("omp.health.%s", status.NodeID), data)
}

// Run veröffentlicht status alle interval, bis stop geschlossen wird.
func (p *Publisher) Run(status Status, interval time.Duration, stop <-chan struct{}) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	if err := p.Publish(status); err != nil {
		slog.Warn("health publish failed", "error", err)
	}

	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			if err := p.Publish(status); err != nil {
				slog.Warn("health publish failed", "error", err)
			}
		}
	}
}
