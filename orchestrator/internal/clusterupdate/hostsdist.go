package clusterupdate

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/updates"
)

// DistributorHosts verbindet den Host-Verteiler (updates.Distributor) mit dem Rollout.
type DistributorHosts struct {
	Dist *updates.Distributor
	// Get liefert den Paketeintrag.
	Get func(id string) (updates.Entry, error)
	// Poll: Abfrageintervall (Standard 1 s); Timeout: längste Wartezeit (Standard 30 min).
	Poll, Timeout time.Duration
}

// Distribute startet die Verteilung und wartet, bis sie beendet ist.
func (h *DistributorHosts) Distribute(ctx context.Context, packageID string) (string, error) {
	e, err := h.Get(packageID)
	if err != nil {
		return "", err
	}
	poll, timeout := h.Poll, h.Timeout
	if poll <= 0 {
		poll = time.Second
	}
	if timeout <= 0 {
		timeout = 30 * time.Minute
	}
	if _, err := h.Dist.Start(e); err != nil && !errors.Is(err, updates.ErrBusy) {
		return "", err
	}
	deadline := time.Now().Add(timeout)
	for {
		last := h.Dist.Last()
		if last != nil && last.PackageID == packageID && !last.Running {
			ok, offline := 0, 0
			for _, r := range last.Hosts {
				switch r.State {
				case "ok":
					ok++
				case "offline":
					offline++
				default:
					return "", fmt.Errorf("%s: %s %s", r.Label, r.State, r.Detail)
				}
			}
			return fmt.Sprintf("%d Host(s) aktualisiert, %d offline", ok, offline), nil
		}
		if time.Now().After(deadline) {
			return "", errors.New("Zeitueberschreitung bei der Host-Verteilung")
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(poll):
		}
	}
}
