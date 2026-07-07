package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/config"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/httpapi"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	cfg := config.Load()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	store := registry.NewStore()
	poller := registry.NewPoller(registry.NewClient(cfg.RegistryURL, nil), store)
	go poller.Run(ctx)

	handler := httpapi.NewHandler(cfg, store)

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
