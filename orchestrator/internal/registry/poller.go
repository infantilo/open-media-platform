package registry

import (
	"context"
	"log/slog"
	"reflect"
	"time"
)

// PollInterval ist der Abstand zwischen zwei Abfragen der Query-API
// (UMSETZUNG.md A5: "Poll alle 2s reicht", spätere Schritte ersetzen das
// ggf. durch eine WebSocket-Subscription).
const PollInterval = 2 * time.Second

// ChangeFunc wird für jede erkannte Node-Inventar-Änderung aufgerufen.
// eventType ist eines von "node.added", "node.updated", "node.removed"
// (UMSETZUNG.md A6); node ist der neue Stand (bzw. der letzte bekannte
// Stand bei "node.removed").
type ChangeFunc func(eventType string, node NodeView)

// Poller fragt periodisch die Query-API ab, schreibt das Ergebnis in den
// Store und meldet Änderungen gegenüber dem vorherigen Snapshot an
// OnChange (falls gesetzt).
type Poller struct {
	client   *Client
	store    *Store
	prevByID map[string]NodeView

	// OnChange wird bei jedem Poll für jeden hinzugekommenen, entfernten
	// oder veränderten Node aufgerufen. Optional — nil bedeutet "kein
	// Interesse an Änderungsereignissen" (z. B. in Tests).
	OnChange ChangeFunc
}

// NewPoller verbindet einen Client mit einem Store.
func NewPoller(client *Client, store *Store) *Poller {
	return &Poller{client: client, store: store, prevByID: map[string]NodeView{}}
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
	if p.OnChange != nil {
		p.notifyChanges(nodes)
	}
	p.store.Set(nodes)
}

// notifyChanges vergleicht nodes mit dem zuletzt gesehenen Stand und ruft
// OnChange für jede Änderung auf.
func (p *Poller) notifyChanges(nodes []NodeView) {
	newByID := make(map[string]NodeView, len(nodes))
	for _, n := range nodes {
		newByID[n.ID] = n
	}

	for id, n := range newByID {
		old, existed := p.prevByID[id]
		switch {
		case !existed:
			p.OnChange("node.added", n)
		case !reflect.DeepEqual(old, n):
			p.OnChange("node.updated", n)
		}
	}
	for id, old := range p.prevByID {
		if _, stillPresent := newByID[id]; !stillPresent {
			p.OnChange("node.removed", old)
		}
	}

	p.prevByID = newByID
}
