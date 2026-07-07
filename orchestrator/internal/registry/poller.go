package registry

import (
	"context"
	"log/slog"
	"time"
)

// PollInterval ist der Abstand zwischen zwei Abfragen der Query-API
// (UMSETZUNG.md A5: "Poll alle 2s reicht", spätere Schritte ersetzen das
// ggf. durch eine WebSocket-Subscription).
const PollInterval = 2 * time.Second

// Poller fragt periodisch die Query-API ab und schreibt das Ergebnis in
// den Store.
type Poller struct {
	client *Client
	store  *Store
}

// NewPoller verbindet einen Client mit einem Store.
func NewPoller(client *Client, store *Store) *Poller {
	return &Poller{client: client, store: store}
}

// Run pollt bis ctx beendet wird. Ein einzelner fehlgeschlagener Poll wird
// geloggt, der Store behält den letzten guten Stand.
func (p *Poller) Run(ctx context.Context) {
	p.pollOnce(ctx)

	ticker := time.NewTicker(PollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			p.pollOnce(ctx)
		}
	}
}

func (p *Poller) pollOnce(ctx context.Context) {
	nodes, err := p.client.FetchSnapshot(ctx)
	if err != nil {
		slog.Warn("registry poll failed", "error", err)
		return
	}
	p.store.Set(nodes)
}
