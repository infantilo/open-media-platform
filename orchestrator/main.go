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
	"github.com/infantilo/openmediaplatform/orchestrator/internal/consoles"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/db"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/eventbus"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/graph"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/health"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/httpapi"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/is05"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
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

	// Postgres ist ab hier hart erforderlich (anders als NATS oben, das
	// best-effort degradiert) — Layouts/Snapshots (UMSETZUNG.md D1) haben
	// ohne DB kein sinnvolles Fallback-Verhalten, ein halb funktionierender
	// Orchestrator wäre irreführender als ein klarer Start-Abbruch.
	database, err := db.Connect(cfg.PostgresURL)
	if err != nil {
		slog.Error("postgres connect failed", "error", err, "hint", "make up starten (startet u.a. Postgres)")
		os.Exit(1)
	}
	defer database.Close()
	if err := db.Migrate(database); err != nil {
		slog.Error("postgres migration failed", "error", err)
		os.Exit(1)
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

	graphSvc := graph.NewService(store, is05.NewClient(nil), hub)
	layoutStore := layouts.NewStore(database)
	snapshotSvc := snapshots.NewService(store, graphSvc, snapshots.NewStore(database))

	catalog, err := launcher.LoadCatalog(cfg.CatalogPath)
	if err != nil {
		slog.Warn("failed to load instance launcher catalog, GUI-Launch bleibt leer", "path", cfg.CatalogPath, "error", err)
		catalog = nil
	}
	launcherSvc := launcher.New(catalog, cfg.RegistryURL, cfg.NatsURL, cfg.DataDir, hub)

	consoleResolver := consoles.NewResolver(consoles.NewStore(filepath.Join(cfg.DataDir, "role-bindings.json")))

	handler := httpapi.NewHandler(cfg, store, hub, graphSvc, layoutStore, snapshotSvc, launcherSvc, consoleResolver)

	slog.Info("starting orchestrator",
		"listen", cfg.Listen,
		"registry_url", cfg.RegistryURL,
		"nats_url", cfg.NatsURL,
		"ui_dir", cfg.UIDir,
	)

	srv := &http.Server{Addr: cfg.Listen, Handler: handler}
	serveErr := make(chan error, 1)
	go func() {
		serveErr <- srv.ListenAndServe()
	}()

	select {
	case err := <-serveErr:
		if err != nil && err != http.ErrServerClosed {
			slog.Error("orchestrator stopped", "error", err)
			os.Exit(1)
		}
	case <-ctx.Done():
		// SIGTERM/SIGINT (z. B. deploy/dev/stop-omp.sh): sauber
		// herunterfahren statt nur auf das nächste SIGKILL zu warten —
		// ctx wurde bisher nur an den Poller weitergereicht, ohne dass
		// der HTTP-Server je darauf reagierte.
		slog.Info("shutdown signal received, draining")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			slog.Warn("graceful shutdown failed, forcing close", "error", err)
			srv.Close()
		}
	}
}
