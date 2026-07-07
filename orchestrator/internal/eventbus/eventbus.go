// Package eventbus verbindet den Orchestrator mit dem NATS-Event-Bus
// (ARCHITECTURE.md §4.2) und leitet Bus-Ereignisse an einen sse.Hub
// weiter. Verwendet den offiziellen nats.go-Client — Ausnahme von der
// Minimal-Dependency-Regel, begründet in docs/decisions.md.
package eventbus

import (
	"encoding/json"
	"log/slog"
	"strings"

	"github.com/nats-io/nats.go"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// Subject ist der NATS-Subject-Filter, den der Orchestrator abonniert
// (UMSETZUNG.md A6: "omp.>").
const Subject = "omp.>"

// healthSubjectPrefix identifiziert Health-Events eines Nodes
// (UMSETZUNG.md A7: "omp.health.<id>").
const healthSubjectPrefix = "omp.health."

// Connect verbindet sich mit NATS und abonniert Subject; empfangene
// Nachrichten werden als sse.Event an hub weitergereicht. Health-Events
// (omp.health.<id>) lösen zusätzlich onHealth(id) aus — Grundlage für
// die Offline-Erkennung in B4 (internal/health.Tracker); onHealth darf
// nil sein. Ein initial nicht erreichbares NATS ist nicht fatal
// (RetryOnFailedConnect): der Orchestrator läuft weiter und verbindet
// sich, sobald NATS erreichbar ist — konsistent mit der Resilienz-Linie
// aus internal/registry.Poller.
func Connect(url string, hub *sse.Hub, onHealth func(nodeID string)) (*nats.Conn, error) {
	nc, err := nats.Connect(url,
		nats.Name("openmediaplatform-orchestrator"),
		nats.RetryOnFailedConnect(true),
		nats.MaxReconnects(-1),
		nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
			slog.Warn("nats disconnected", "error", err)
		}),
		nats.ReconnectHandler(func(nc *nats.Conn) {
			slog.Info("nats reconnected", "url", nc.ConnectedUrl())
		}),
	)
	if err != nil {
		return nil, err
	}

	if _, err := nc.Subscribe(Subject, func(msg *nats.Msg) {
		hub.Broadcast(sse.Event{Type: msg.Subject, Data: normalizePayload(msg.Data)})
		if onHealth != nil && strings.HasPrefix(msg.Subject, healthSubjectPrefix) {
			onHealth(strings.TrimPrefix(msg.Subject, healthSubjectPrefix))
		}
	}); err != nil {
		nc.Close()
		return nil, err
	}

	return nc, nil
}

// normalizePayload gibt gültiges JSON unverändert weiter; nicht-JSON-Payloads
// werden als JSON-String-Wert verpackt, damit der Client immer gültiges
// JSON im "data"-Feld erhält.
func normalizePayload(data []byte) json.RawMessage {
	if json.Valid(data) {
		return json.RawMessage(data)
	}
	encoded, _ := json.Marshal(string(data))
	return json.RawMessage(encoded)
}
