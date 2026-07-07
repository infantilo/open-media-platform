package main

import (
	"log/slog"
	"net/http"
	"os"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/config"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/httpapi"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	cfg := config.Load()
	handler := httpapi.NewHandler(cfg)

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
