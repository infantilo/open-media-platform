package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/audit"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/auth"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/config"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/consoles"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/db"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/eventbus"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/graph"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/health"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/httpapi"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/is05"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/layouts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/mtls"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/placement"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/profiles"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/snapshots"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/workflows"
)

// healthStaleAfter ist der Schwellwert für die NATS-Health-basierte
// Offline-Erkennung (UMSETZUNG.md B4: "~10s"), deutlich unter
// registration_expiry_interval (12s, deploy/nmos/registry.json), damit
// eine tote Node schon als offline markiert wird, bevor die Registry sie
// vollständig entfernt.
const healthStaleAfter = 10 * time.Second

// natsRequester adaptiert *nats.Conn auf launcher.NATSRequester —
// launcher.go bleibt dadurch frei von einer direkten nats.go-
// Abhängigkeit (s. dortiger Paketkommentar, UMSETZUNG.md D6 Teil 2).
type natsRequester struct{ nc *nats.Conn }

func (r natsRequester) RequestBytes(subject string, data []byte, timeout time.Duration) ([]byte, error) {
	msg, err := r.nc.Request(subject, data, timeout)
	if err != nil {
		return nil, err
	}
	return msg.Data, nil
}

// hostEventsSubjectPrefix/-Suffix identifizieren die S3-Prozessende-
// Events eines Host-Agent ("omp.host.<hostId>.events") — gleiches
// Muster wie eventbus.go's hostIDFromMetricsSubject, hier lokal statt
// dort, weil der Konsument (launcherSvc.HandleRemoteExit) erst nach
// eventbus.Connect existiert (s. Kommentar bei der Subscription unten).
const (
	hostEventsSubjectPrefix = "omp.host."
	hostEventsSubjectSuffix = ".events"
)

func hostIDFromEventsSubject(subject string) (string, bool) {
	rest, ok := strings.CutPrefix(subject, hostEventsSubjectPrefix)
	if !ok {
		return "", false
	}
	hostID, ok := strings.CutSuffix(rest, hostEventsSubjectSuffix)
	if !ok || hostID == "" {
		return "", false
	}
	return hostID, true
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	cfg := config.Load()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	hub := sse.NewHub()
	healthTracker := health.NewTracker()
	hostMetricsTracker := hosts.NewTracker()
	hostHistory := hosts.NewHistory()

	nc, err := eventbus.Connect(cfg.NatsURL, hub, healthTracker.Touch, func(hostID string, payload []byte) {
		if !hostMetricsTracker.Touch(hostID, payload) {
			slog.Warn("host metrics payload not parsable, dropped", "host_id", hostID)
			return
		}
		// Kapitel 14 Teil 1: dieselbe geparste Metrics erneut aus dem
		// Tracker lesen statt den Payload ein zweites Mal zu parsen —
		// Touch() hat ihn gerade validiert und mit ReceivedAt versehen.
		if m, ok := hostMetricsTracker.Get(hostID); ok {
			hostHistory.Record(hostID, m)
		}
	})
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

	// mTLS Orchestrator↔Nodes (UMSETZUNG.md D3, ARCHITECTURE.md §4.6) —
	// opt-in über cfg.MTLSEnabled, Default aus. Ein nicht erreichbares
	// Zertifikat bei aktiviertem mTLS ist ein harter Fehler (ähnlich
	// Postgres oben): mit OMP_MTLS_ENABLED=true, aber kaputter Cert-
	// Konfiguration still auf Klartext zurückzufallen wäre die
	// gefährlichere Variante (sieht sicher aus, ist es nicht) — der
	// Registry-Poller (unten) betrifft die NMOS-Registry, nicht "unsere"
	// Nodes, bleibt bewusst außerhalb dieses Schritts (docs/decisions.md
	// D3).
	nodeTLSConfig, err := mtls.ClientTLSConfig(mtls.Config{
		Enabled:  cfg.MTLSEnabled,
		CertFile: cfg.MTLSCertFile,
		KeyFile:  cfg.MTLSKeyFile,
		CAFile:   cfg.MTLSCAFile,
	})
	if err != nil {
		slog.Error("mtls config failed", "error", err)
		os.Exit(1)
	}
	nodeHTTPClient := http.DefaultClient
	if nodeTLSConfig != nil {
		nodeHTTPClient = &http.Client{Transport: &http.Transport{TLSClientConfig: nodeTLSConfig}}
		slog.Info("mtls enabled for orchestrator-to-node requests")
	}

	store := registry.NewStore()
	graphSvc := graph.NewService(store, is05.NewClient(nodeHTTPClient), hub)

	poller := registry.NewPoller(registry.NewClient(cfg.RegistryURL, nil), store)
	poller.HealthTracker = healthTracker
	poller.HealthStaleAfter = healthStaleAfter
	poller.OnChange = func(eventType string, node registry.NodeView) {
		// S1 (docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md): hält den
		// Graph-Edge-Cache bei Node-Zu-/Abgang aktuell, statt bis zum
		// nächsten periodischen Reconcile (graph.ReconcileInterval) zu
		// warten — node.added/node.removed sind die einzigen für den
		// Cache relevanten Event-Typen (s. Service.HandleNodeEvent).
		graphSvc.HandleNodeEvent(ctx, eventType, node)

		data, err := json.Marshal(node)
		if err != nil {
			slog.Warn("failed to marshal node for event", "error", err)
			return
		}
		hub.Broadcast(sse.Event{Type: eventType, Data: data})
	}
	go poller.Run(ctx)
	go graphSvc.Run(ctx)
	layoutStore := layouts.NewStore(database)
	snapshotSvc := snapshots.NewService(store, graphSvc, snapshots.NewStore(database), nodeHTTPClient)

	catalog, err := launcher.LoadCatalog(cfg.CatalogPath)
	if err != nil {
		slog.Warn("failed to load instance launcher catalog, GUI-Launch bleibt leer", "path", cfg.CatalogPath, "error", err)
		catalog = nil
	}
	// launcherNATS bleibt nil, wenn die initiale NATS-Verbindung (oben)
	// fehlschlug — Remote-Hosts sind dann nicht ansprechbar
	// (ErrRemoteUnavailable), rein lokaler Betrieb (UMSETZUNG.md C8)
	// funktioniert unverändert (gleiche Degradations-Linie wie der Rest
	// des NATS-Einsatzes hier, s. Kommentar bei eventbus.Connect oben).
	var launcherNATS launcher.NATSRequester
	if nc != nil {
		launcherNATS = natsRequester{nc: nc}
	}
	launcherSvc := launcher.New(catalog, cfg.RegistryURL, cfg.NatsURL, launcher.NewStore(database), hub, launcherNATS, launcher.NewCatalogStore(database))
	// Kapitel 14 Teil 2 (docs/END-GOAL-FEATURES.md §14.3b): periodisches
	// Pro-Instanz-Sampling (CPU%/RSS aus /proc) für lokal laufende
	// Instanzen — das Orchestrator-seitige Gegenstück zum Host-Agent-
	// ProcessSampler.
	go launcherSvc.Run(ctx)

	// S3 (docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md): Remote-Parität für
	// Instanzen — der Host-Agent meldet ein unerwartetes Prozessende auf
	// omp.host.<hostId>.events (host-agent/internal/commands.
	// Executor.publishExit), der Launcher behandelt es wie das lokale
	// cmd.Wait()-Ende (gleiche Crash-Loop-Bremse, gleiches
	// instance.restarted-Event, s. Launcher.HandleRemoteExit). Eigene
	// Subscription statt eventbus.Connect-Erweiterung (oben, vor
	// launcherSvc' Konstruktion aufgerufen) — HandleRemoteExit existiert
	// erst ab hier. Der generische "omp.>"-Passthrough oben leitet diese
	// Nachrichten zusätzlich als rohes SSE-Event weiter (harmlos, die UI
	// kennt den Typ nicht und ignoriert ihn) — keine doppelte
	// Geschäftslogik, nur ein zweiter, unabhängiger Konsument derselben
	// NATS-Nachricht.
	if nc != nil {
		hostEventsSub, err := nc.Subscribe("omp.host.*.events", func(msg *nats.Msg) {
			hostID, ok := hostIDFromEventsSubject(msg.Subject)
			if !ok {
				return
			}
			launcherSvc.HandleRemoteExit(hostID, msg.Data)
		})
		if err != nil {
			slog.Warn("host exit event subscribe failed", "error", err)
		} else {
			defer hostEventsSub.Unsubscribe()
		}
	}

	// Nutzer-/Rollenmodell (ARCHITECTURE.md §12, UMSETZUNG.md D3 Teil 2)
	// — ersetzt die bisherige data/role-bindings.json (C13-Stub) durch
	// die authz-Tabelle; JWTSecret hat Vorrang vor JWTSecretFile (echte
	// Deployments speisen ein eigenes Secret ein statt eines
	// auto-generierten).
	jwtSecret := []byte(cfg.JWTSecret)
	if cfg.JWTSecret == "" {
		jwtSecret, err = auth.LoadOrCreateSecret(cfg.JWTSecretFile)
		if err != nil {
			slog.Error("jwt secret setup failed", "error", err)
			os.Exit(1)
		}
	}
	authSvc := auth.NewService(auth.NewStore(database), jwtSecret)
	authzStore := authz.NewStore(database)
	auditStore := audit.NewStore(database, hub)
	// S5 (docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md): Startup- + täglicher
	// Retention-Lauf, löscht Audit-Zeilen älter als cfg.AuditRetentionDays.
	go auditStore.RunRetention(ctx, cfg.AuditRetentionDays)

	// Remote-Host-Erkennung (ARCHITECTURE.md §18, UMSETZUNG.md D6 Teil 1).
	hostStore := hosts.NewStore(database)

	// Verbrauchsprofile pro Node-Typ (Kapitel 14 Teil 3, docs/END-GOAL-
	// FEATURES.md §14.3c) — tastet dieselben Instanz-/Host-Telemetrie-
	// Quellen ab wie placementEngine (unten), aggregiert sie aber pro
	// (Typ,Host) statt pro Host zu warnen. Eigenständiges Paket statt
	// Erweiterung von placement (andere Zuständigkeit: Datengrundlage/
	// Schätzung, nicht Alarm/Vorschlag). Vor placementEngine konstruiert
	// (Kapitel 14 Teil 4): dessen CheckHost braucht profileStore als
	// ProfileReader, um den Bedarf des zu startenden Node-Typs auf die
	// Host-Momentwerte zu projizieren, statt nur mit ihnen allein zu
	// rechnen.
	profileStore := profiles.NewStore(database)
	profileCollector := profiles.NewCollector(launcherSvc, hostMetricsTracker, profileStore)
	go profileCollector.Run(ctx)

	// Resource-Aware Placement — advisory-only Ausbaustufe (ARCHITECTURE.md
	// §6.1, UMSETZUNG.md D6 Teil 3): beobachtet die seit D6 Teil 1
	// vorhandene Host-Telemetrie, warnt aber nur — kein automatischer
	// Eingriff, s. Paketkommentar internal/placement. Vor workflowSvc
	// konstruiert (D7 Teil 2): dessen Ressourcen-Vorprüfung nutzt dieselbe
	// Engine (CheckHost) als harte Start-Vorbedingung.
	placementThresholds := placement.Thresholds{
		CPUPercent:        cfg.PlacementCPUThreshold,
		MemPercent:        cfg.PlacementMemThreshold,
		HealthyCPUPercent: cfg.PlacementHealthyCPUThreshold,
		HealthyMemPercent: cfg.PlacementHealthyMemThreshold,
	}
	placementEngine := placement.NewEngine(hostStore, hostMetricsTracker, launcherSvc, hub, placementThresholds, profileStore)
	go placementEngine.Run(ctx)

	// Workflow-Bereitstellung & -Verteilung (ARCHITECTURE.md §6.2,
	// UMSETZUNG.md D7 Teil 1/Teil 2): bündelt mehrere launcherSvc.Start()-
	// Aufrufe zu einem benannten Workflow, verkabelt die Rollen automatisch
	// gemäß Verbindungs-Template, sobald sie in der Registry erscheinen,
	// und prüft vor jedem Start die Ressourcenlage der Ziel-Hosts
	// (placementEngine.CheckHost).
	workflowSvc := workflows.NewService(workflows.NewStore(database), store, graphSvc, launcherSvc, hub, nodeHTTPClient, placementEngine)

	// Kapitel 12 Teil 4 (docs/END-GOAL-FEATURES.md §12.3e): löst
	// Rollenbindungen für die Operator-Console auf, jetzt inkl. echter
	// Workflow-ID/-Label statt consoles.StubWorkflowID — braucht
	// workflowSvc als WorkflowRoleFinder, daher erst hier konstruierbar
	// (nicht mehr direkt nach authzStore wie vor diesem Kapitel).
	consoleResolver := consoles.NewResolver(authzStore, workflowSvc)

	// K7-Teil-1 (docs/END-GOAL-FEATURES.md §7.3a/§7.6): nach jedem
	// automatischen Launcher-Neustart einer abgestürzten Instanz die
	// betroffene Workflow-Rolle neu verkabeln, statt auf den nächsten
	// manuellen Workflow-Start zu warten. Erst hier verdrahtbar, da
	// workflowSvc launcherSvc als Konstruktor-Argument braucht.
	launcherSvc.SetRestartObserver(workflowSvc)

	// D7 Teil 2 (ARCHITECTURE.md §6.2 Punkt 1): führt Start/Stop-
	// Zeitpläne aus, unabhängig vom HTTP-Handler.
	workflowScheduler := workflows.NewScheduler(workflowSvc)
	go workflowScheduler.Run(ctx)

	handler := httpapi.NewHandler(cfg, store, hub, graphSvc, layoutStore, snapshotSvc, launcherSvc, consoleResolver, nodeHTTPClient, authSvc, authzStore, auditStore, auditStore, hostStore, hostMetricsTracker, hostHistory, workflowSvc, placementEngine, profileStore, placementThresholds)

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
