package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/config"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/eventbus"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/graph"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/httpapi"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/is05"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	cfg := config.Load()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	hub := sse.NewHub()

	nc, err := eventbus.Connect(cfg.NatsURL, hub)
	if err != nil {
		slog.Error("nats connect failed, continuing without event bus", "error", err)
	} else {
		defer nc.Close()
	}

	store := registry.NewStore()
	poller := registry.NewPoller(registry.NewClient(cfg.RegistryURL, nil), store)
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

	handler := httpapi.NewHandler(cfg, store, hub, graphSvc)

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
