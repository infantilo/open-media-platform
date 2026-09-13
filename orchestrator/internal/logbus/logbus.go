// Package logbus verteilt strukturierte Log-Zeilen zentral über NATS
// JetStream und projiziert sie nach Postgres (ARCHITECTURE.md §25.2) —
// dasselbe Grundmuster wie internal/audit (Tabelle + Retention-Job +
// EventPublisher.Broadcast für Live-Updates), nur für Log-Zeilen statt
// Audit-Aktionen. Bewusst kein neuer Infrastruktur-Baustein: der
// 3-Knoten-NATS-Cluster läuft bereits mit JetStream (UMSETZUNG.md D14),
// bisher nur für unpersistiertes Pub/Sub genutzt — dessen Persistenz/
// Replikation ist hier zum ersten Mal tatsächlich genutztes Potenzial,
// ohne einen weiteren Baustein mit eigenem HA-Bedarf einzuführen
// (dieselbe "kein neuer Single Point of Failure"-Linie wie D12–D15).
package logbus

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/tracing"
)

const (
	// StreamName ist der JetStream-Stream-Name für alle Log-Zeilen.
	StreamName = "OMP_LOGS"
	// SubjectPrefix + <node_id oder "orchestrator"> ist das NATS-Subject,
	// auf dem eine einzelne Log-Zeile veröffentlicht wird.
	SubjectPrefix = "omp.logs."
	// consumerName ist der Durable-Consumer-Name des Projektors (main.go:
	// RunProjector) — durable, damit ein Leader-Wechsel (D12) nicht bei
	// Null anfängt, sondern am zuletzt bestätigten Offset weiterliest.
	consumerName = "logbus-projector"

	// RetentionInterval — gleiche Kadenz wie audit.RetentionInterval.
	RetentionInterval = 24 * time.Hour
	// DefaultRetentionHours ist der Default für OMP_LOG_RETENTION_HOURS
	// (config.go) — deutlich kürzer als Audit (90 Tage): Log-Volumen ist
	// um Größenordnungen höher, für eine Störungsanalyse reichen wenige
	// Tage.
	DefaultRetentionHours = 72
)

// Entry ist eine einzelne strukturierte Log-Zeile.
type Entry struct {
	ID         int64     `json:"id,omitempty"`
	OccurredAt time.Time `json:"occurredAt"`
	Level      string    `json:"level"`
	Message    string    `json:"message"`
	TraceID    string    `json:"traceId,omitempty"`
	SpanID     string    `json:"spanId,omitempty"`
	NodeID     string    `json:"nodeId,omitempty"`
	HostID     string    `json:"hostId,omitempty"`
	// Source identifiziert den Absender — "orchestrator" oder eine
	// Node-ID (bei einer künftigen node-seitigen Anbindung, s.
	// ARCHITECTURE.md §25 "bewusst nicht Teil dieser Runde").
	Source string `json:"source"`
}

// Publisher veröffentlicht Log-Zeilen auf den JetStream-Stream.
// `NewPublisher` mit nc == nil liefert einen funktionsfähigen No-Op-
// Publisher (kein NATS erreichbar) — gleiche additive "darf fehlen"-
// Linie wie health.Publisher an anderer Stelle im Code.
type Publisher struct {
	js jetstream.JetStream
}

// NewPublisher richtet den JetStream-Stream ein (idempotent:
// CreateOrUpdateStream) und liefert einen Publisher dafür.
// retentionHours <= 0 bedeutet DefaultRetentionHours.
func NewPublisher(ctx context.Context, nc *nats.Conn, retentionHours int) (*Publisher, error) {
	if nc == nil {
		return &Publisher{}, nil
	}
	if retentionHours <= 0 {
		retentionHours = DefaultRetentionHours
	}
	js, err := jetstream.New(nc)
	if err != nil {
		return nil, fmt.Errorf("logbus: jetstream init: %w", err)
	}
	_, err = js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
		Name:     StreamName,
		Subjects: []string{SubjectPrefix + ">"},
		MaxAge:   time.Duration(retentionHours) * time.Hour,
		Storage:  jetstream.FileStorage,
		// Gleiche Replikationstiefe wie der 3-Knoten-NATS-Cluster selbst
		// (D14) — die Log-Historie überlebt denselben Knotenausfall wie
		// der Rest der Control-Plane, kein schwächeres Glied.
		Replicas: 3,
	})
	if err != nil {
		return nil, fmt.Errorf("logbus: create stream: %w", err)
	}
	return &Publisher{js: js}, nil
}

// Publish veröffentlicht einen Eintrag — best-effort wie
// audit.Store.Log: ein Fehler beim Publizieren darf die eigentliche,
// bereits ausgeführte Aktion nicht rückwirkend scheitern lassen. Liest
// trace_id/span_id aus ctx nach, falls e sie nicht bereits selbst trägt
// (der übliche Fall: Aufrufer übergeben denselben ctx, den sie auch für
// den fehlgeschlagenen Node-Aufruf selbst genutzt haben).
func (p *Publisher) Publish(ctx context.Context, e Entry) {
	if p == nil || p.js == nil {
		return
	}
	e.OccurredAt = time.Now().UTC()
	if e.TraceID == "" {
		e.TraceID = tracing.TraceID(ctx)
	}
	if e.SpanID == "" {
		e.SpanID = tracing.SpanID(ctx)
	}
	if e.Source == "" {
		e.Source = "orchestrator"
	}
	data, err := json.Marshal(e)
	if err != nil {
		slog.Warn("logbus: marshal entry failed", "error", err)
		return
	}
	subject := SubjectPrefix + firstNonEmpty(e.NodeID, e.Source)
	if _, err := p.js.Publish(ctx, subject, data); err != nil {
		slog.Warn("logbus: publish failed", "error", err, "subject", subject)
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return "unknown"
}
