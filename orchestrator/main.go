package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/config"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/eventbus"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/graph"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/health"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/httpapi"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/is05"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/layouts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/snapshots"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// healthStaleAfter ist der Schwellwert für die NATS-Health-basierte
// Offline-Erkennung (UMSETZUNG.md B4: "~10s"), deutlich unter
// registration_expiry_interval (12s, deploy/nmos/registry.json), damit
// eine tote Node schon als offline markiert wird, bevor die Registry sie
// vollständig entfernt.
const healthStaleAfter = 10 * time.Second

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	cfg := config.Load()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	hub := sse.NewHub()
	healthTracker := health.NewTracker()

	nc, err := eventbus.Connect(cfg.NatsURL, hub, healthTracker.Touch)
	if err != nil {
		slog.Error("nats connect failed, continuing without event bus", "error", err)
	} else {
		defer nc.Close()
	}

	store := registry.NewStore()
	poller := registry.NewPoller(registry.NewClient(cfg.RegistryURL, nil), store)
	poller.HealthTracker = healthTracker
	poller.HealthStaleAfter = healthStaleAfter
	poller.OnChange = func(eventType string, node registry.NodeView) {
		data, err := json.Marshal(node)
		if err != nil {
			slog.Warn("failed to marshal node for event", "error", err)
			return
		}
		hub.Broadcast(sse.Event{Type: eventType, Data: data})
	}
	go poller.Run(ctx)

	graphSvc := graph.NewService(store, is05.NewClient(nil))
	layoutStore := layouts.NewStore(filepath.Join(cfg.DataDir, "layouts"))
	snapshotSvc := snapshots.NewService(store, graphSvc, snapshots.NewStore(filepath.Join(cfg.DataDir, "snapshots")))

	handler := httpapi.NewHandler(cfg, store, hub, graphSvc, layoutStore, snapshotSvc)

	slog.Info("starting orchestrator",
		"listen", cfg.Listen,
		"registry_url", cfg.RegistryURL,
		"nats_url", cfg.NatsURL,
		"ui_dir", cfg.UIDir,
	)

	if err := http.ListenAndServe(cfg.Listen, handler); err != nil {
		slog.Error("orchestrator stopped", "error", err)
		os.Exit(1)
	}
}
