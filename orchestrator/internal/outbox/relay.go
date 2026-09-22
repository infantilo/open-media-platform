package outbox

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/nats-io/nats.go/jetstream"
)

// DefaultRelayPollInterval ist die Wartezeit zwischen zwei Zyklen, wenn
// gerade keine unversendeten Events vorliegen — dasselbe DB-
// zustandsgetriebene Polling-Entwurfsmuster wie internal/process.Engine
// (kein In-Memory-Zustand, ein Neustart holt automatisch alles Fehlende
// nach, s. Relay.Run).
const DefaultRelayPollInterval = 2 * time.Second

// DefaultBatchSize begrenzt, wie viele Events ein Polling-Zyklus
// höchstens auf einmal versendet — verhindert, dass ein nach längerer
// Downtime aufgelaufener Rückstand den Relay-Prozess in einer einzigen,
// beliebig langen Runde blockiert.
const DefaultBatchSize = 100

// Relay liest unversendete Outbox-Events und veröffentlicht sie zu
// NATS JetStream — die Zustellseite des Outbox-Musters (s. Moduldoku
// store.go). Ein Event gilt erst nach BESTÄTIGTEM JetStream-Publish
// (PubAck) als versendet (Store.MarkDispatched) — ein Absturz zwischen
// Publish-Versuch und dem Markieren führt bestenfalls zu einer
// erneuten Zustellung beim nächsten Zyklus (at-least-once, nie
// at-most-once) — JetStreams `Nats-Msg-Id`-Dedup (dedupKey) macht das
// für Konsumenten ungefährlich, die ihn auswerten.
type Relay struct {
	store        *Store
	js           jetstream.JetStream
	pollInterval time.Duration
	batchSize    int

	mu     sync.Mutex
	cancel context.CancelFunc
	done   chan struct{}
}

// RelayOption konfiguriert einen neuen Relay.
type RelayOption func(*Relay)

// WithRelayPollInterval überschreibt DefaultRelayPollInterval (vor allem
// für Tests).
func WithRelayPollInterval(d time.Duration) RelayOption {
	return func(r *Relay) { r.pollInterval = d }
}

// WithRelayBatchSize überschreibt DefaultBatchSize.
func WithRelayBatchSize(n int) RelayOption {
	return func(r *Relay) { r.batchSize = n }
}

// NewRelay erstellt einen Relay gegen den gegebenen Store und die
// gegebene JetStream-Verbindung.
func NewRelay(store *Store, js jetstream.JetStream, opts ...RelayOption) *Relay {
	r := &Relay{
		store:        store,
		js:           js,
		pollInterval: DefaultRelayPollInterval,
		batchSize:    DefaultBatchSize,
	}
	for _, opt := range opts {
		opt(r)
	}
	return r
}

// Start startet den Polling-Zyklus in einem eigenen Goroutine — nicht
// blockierend. Stop() beendet ihn sauber.
func (r *Relay) Start() {
	ctx, cancel := context.WithCancel(context.Background())
	r.mu.Lock()
	r.cancel = cancel
	r.done = make(chan struct{})
	r.mu.Unlock()

	go func() {
		defer close(r.done)
		r.Run(ctx)
	}()
}

// Stop bricht den Polling-Zyklus ab und wartet, bis er beendet ist.
func (r *Relay) Stop() {
	r.mu.Lock()
	cancel := r.cancel
	done := r.done
	r.mu.Unlock()
	if cancel == nil {
		return
	}
	cancel()
	<-done
}

// Run treibt den Polling-Zyklus synchron im aufrufenden Goroutine — für
// Aufrufer, die selbst über Lebenszyklus/Kontext entscheiden wollen
// (Start()/Stop() sind der bequeme Normalfall für die meisten Aufrufer).
func (r *Relay) Run(ctx context.Context) {
	for {
		if ctx.Err() != nil {
			return
		}
		n, err := r.dispatchBatch(ctx)
		if err != nil {
			slog.Error("outbox: relay: dispatch batch failed", "error", err)
		}
		if n == 0 {
			select {
			case <-time.After(r.pollInterval):
			case <-ctx.Done():
				return
			}
		}
	}
}

// dispatchBatch versendet bis zu batchSize unversendete Events und
// liefert, wie viele erfolgreich versendet wurden (für Run()s
// Entscheidung, ob sofort weiterzumachen oder erst zu warten ist — ein
// voller Rückstand soll ohne Wartezeit zwischen den Runden abgearbeitet
// werden).
func (r *Relay) dispatchBatch(ctx context.Context) (int, error) {
	events, err := r.store.Undispatched(r.batchSize)
	if err != nil {
		return 0, err
	}
	dispatched := 0
	for _, e := range events {
		if ctx.Err() != nil {
			return dispatched, ctx.Err()
		}
		opts := []jetstream.PublishOpt{}
		if e.DedupKey != "" {
			opts = append(opts, jetstream.WithMsgID(e.DedupKey))
		}
		if _, err := r.js.Publish(ctx, e.Subject, e.Payload, opts...); err != nil {
			// Best effort: ein einzelnes fehlgeschlagenes Event (z. B.
			// JetStream kurzzeitig nicht erreichbar) darf den Rest des
			// Batches nicht blockieren — bleibt unversendet, wird beim
			// nächsten Zyklus erneut versucht (Idempotenz über
			// dedupKey/Nats-Msg-Id macht Mehrfachversuche ungefährlich).
			slog.Error("outbox: relay: publish failed, will retry next cycle", "event", e.ID, "subject", e.Subject, "error", err)
			continue
		}
		if err := r.store.MarkDispatched(e.ID); err != nil && !errors.Is(err, ErrNotFound) {
			slog.Error("outbox: relay: mark dispatched failed", "event", e.ID, "error", err)
			continue
		}
		dispatched++
	}
	return dispatched, nil
}

// EnsureStream legt einen JetStream-Stream an oder aktualisiert ihn
// (idempotent) — Aufrufer geben die Subjects an, die der Stream
// dauerhaft erfassen soll (z. B. "omp.asset.>", "omp.process.>").
// Bewusst kein Limits-freier Default: WorkQueue/Limits-Policy und ein
// endliches MaxAge verhindern unbegrenztes Wachstum, falls ein
// Konsument dauerhaft ausfällt — Details liegen beim Aufrufer
// (main.go, Phase 5), hier nur der Mechanismus.
func EnsureStream(ctx context.Context, js jetstream.JetStream, cfg jetstream.StreamConfig) (jetstream.Stream, error) {
	return js.CreateOrUpdateStream(ctx, cfg)
}
