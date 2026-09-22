package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/alarmacks"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/audit"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/auth"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/backup"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/cluster"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/config"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/consoles"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/db"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/eventbus"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/graph"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/health"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/httpapi"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/ioports"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/is05"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/layouts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/logbus"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/mtls"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/outbox"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/placement"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/process"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/profiles"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/snapshots"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/supervisorclient"
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

// ioPortAdapter adaptiert *ioports.Store auf workflows.IOPortClaimer —
// reshaped nur GetClaim (ioports.Claim → Klartext-Strings), alle
// anderen Methoden haben identische Signaturen und werden direkt
// durchgereicht (s. Kommentar bei SetIOPortClaimer unten).
type ioPortAdapter struct{ store *ioports.Store }

func (a ioPortAdapter) Claim(cardType, direction, preferredHostID, workflowID, role, instanceID string) (string, string, bool, error) {
	return a.store.Claim(cardType, direction, preferredHostID, workflowID, role, instanceID)
}

func (a ioPortAdapter) UpdateInstanceID(workflowID, role, instanceID string) error {
	return a.store.UpdateInstanceID(workflowID, role, instanceID)
}

func (a ioPortAdapter) Release(workflowID, role string) error {
	return a.store.Release(workflowID, role)
}

func (a ioPortAdapter) GetClaim(workflowID, role string) (hostID, portID string, found bool, err error) {
	c, ok, err := a.store.GetClaim(workflowID, role)
	if err != nil || !ok {
		return "", "", ok, err
	}
	return c.HostID, c.PortID, true, nil
}

func (a ioPortAdapter) ReleasePort(hostID, portID string) error {
	return a.store.ReleasePort(hostID, portID)
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

// leaderPollInterval ist der Abstand, in dem runWhileLeader/
// subscribeWhileLeader den aktuellen Führungsstatus prüfen (D12 Teil 3,
// ARCHITECTURE.md §19.3 Punkt 6) — in derselben Größenordnung wie die
// übrigen Kontroll-Ticker dieser Datei (placement.EvaluateInterval/
// failoverCheckInterval, je 5s), damit ein Führungswechsel nicht
// spürbar länger braucht, bis der neue Leader die cluster-weiten
// Entscheidungsschleifen übernimmt, als die Schleifen selbst ohnehin
// zum Reagieren bräuchten.
const leaderPollInterval = 2 * time.Second

// processEventsStreamName/processEventsRetention (Kapitel 21 Phase 5
// Teil 1, A8/B9): EIN gemeinsamer JetStream-Stream für alle Domain-
// Events der Process-/Asset-Domäne (heute: B9 Asset-Lifecycle-Events
// über internal/outbox) — gleiches "ein Stream pro Zuverlässigkeits-
// Zweck"-Muster wie logbus.StreamName (OMP_LOGS), aber bewusst NICHT
// über dasselbe "omp.>" wie ein hypothetischer Alles-Stream: würde sich
// mit OMP_LOGS/Host-Metrics-Subjects unnötig überschneiden (doppelte
// Speicherung derselben Nachrichten in zwei Streams). 30 Tage statt
// logbus' 72h-Default: Domain-Events (Asset-Lifecycle, künftige
// Workflow-Trigger) sind niedriges Volumen mit potenziell länger
// nötiger Nachvollziehbarkeit, kein Log-Volumen-Problem.
const (
	processEventsStreamName = "OMP_EVENTS"
	processEventsRetention  = 30 * 24 * time.Hour
)

// runWhileLeader startet fn (typischerweise ein Run(ctx)-Hintergrund-
// Loop wie placement.Engine.Run/workflows.Scheduler.Run/
// workflows.Service.RunFailoverWatcher) nur, solange diese Instanz
// aktueller Raft-Leader ist — verliert sie die Führung, wird fns
// Kontext storniert (fn muss ctx.Done() beachten, wie es die genannten
// Loops bereits für den äußeren main.go-ctx tun); gewinnt sie sie
// zurück (oder erneut), startet fn neu. Reines Polling statt einer
// Leadership-Notify-Subscription (cluster.Node liefert aktuell keine
// öffentliche Fan-out-API dafür, nur den intern von watchLeadership
// verbrauchten Kanal) — bei leaderPollInterval=2s ist das Verhalten
// praktisch ununterscheidbar von einer Push-Benachrichtigung, ohne
// cluster.Node um eine zweite Concurrency-Grundierung zu erweitern.
func runWhileLeader(ctx context.Context, clusterNode *cluster.Node, fn func(context.Context)) {
	ticker := time.NewTicker(leaderPollInterval)
	defer ticker.Stop()

	var stop func()
	defer func() {
		if stop != nil {
			stop()
		}
	}()
	for {
		switch isLeader := clusterNode.IsLeader(); {
		case isLeader && stop == nil:
			stop = startLeaderSession(ctx, fn)
		case !isLeader && stop != nil:
			stop()
			stop = nil
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// startLeaderSession startet fn in einer eigenen Goroutine mit einem von
// ctx abgeleiteten, eigenständig stornierbaren Kontext und liefert die
// Storno-Funktion zurück — ausgelagert aus runWhileLeader, damit
// `context.WithCancel`s Cancel-Funktion direkt an ihrem Entstehungsort
// zurückgegeben (statt in einer Schleife bedingt wiederverwendet) wird;
// `go vet`s lostcancel-Analyse verfolgt eine an den Aufrufer
// zurückgegebene Cancel-Funktion zuverlässig, eine in einer
// Schleifenvariable wiederverwendete dagegen nicht immer.
func startLeaderSession(ctx context.Context, fn func(context.Context)) func() {
	loopCtx, cancel := context.WithCancel(ctx)
	go fn(loopCtx)
	return cancel
}

// subscribeWhileLeader hält subject nur abonniert, solange diese
// Instanz Leader ist — gleiches Gating-Prinzip wie runWhileLeader, aber
// für eine NATS-Subscription statt eines Run(ctx)-Loops (der
// Host-Exit-Event-Konsument unten ist kein solcher Loop, sondern eine
// dauerhafte Registrierung). Verliert die Instanz die Führung, wird die
// Subscription beendet — ein danach eintreffendes Exit-Event erreicht
// dann nur noch den neuen Leader, kein doppeltes Verarbeiten durch
// mehrere Instanzen gleichzeitig (ARCHITECTURE.md §19.3 Punkt 5: löst
// den bei der D12-Teil-3-Analyse gefundenen echten Multi-Instanz-Bug —
// jede Instanz abonniert denselben Broadcast-Subject, hätte ohne dieses
// Gating unabhängig voneinander ihre eigene, rein lokale Crash-Loop-
// Zählung hochgezählt und unabhängig doppelt neu gestartet/failover-
// befördert).
func subscribeWhileLeader(ctx context.Context, clusterNode *cluster.Node, nc *nats.Conn, subject string, handler nats.MsgHandler) {
	var sub *nats.Subscription
	unsub := func() {
		if sub != nil {
			_ = sub.Unsubscribe()
			sub = nil
		}
	}
	defer unsub()

	ticker := time.NewTicker(leaderPollInterval)
	defer ticker.Stop()
	for {
		switch isLeader := clusterNode.IsLeader(); {
		case isLeader && sub == nil:
			s, err := nc.Subscribe(subject, handler)
			if err != nil {
				slog.Warn("leader-gated subscribe failed, will retry", "subject", subject, "error", err)
			} else {
				sub = s
			}
		case !isLeader && sub != nil:
			unsub()
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
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

	// ARCHITECTURE.md §20.4 Restlücke "NATS-Verschlüsselung" — eigenes
	// Zertifikat (nats-client.{crt,key}, s. `make nats-tls-up`-Doku im
	// Makefile), NICHT cfg.MTLSCertFile (andere Gegenstelle/SANs).
	// natsTLSConfig bleibt nil, solange OMP_NATS_TLS_ENABLED aus ist —
	// eventbus.Connect() nutzt dann unverändert Klartext.
	natsTLSConfig, err := mtls.ClientTLSConfig(mtls.Config{
		Enabled:  cfg.NatsTLSEnabled,
		CertFile: cfg.NatsTLSCertFile,
		KeyFile:  cfg.NatsTLSKeyFile,
		CAFile:   cfg.NatsTLSCAFile,
	})
	if err != nil {
		slog.Error("nats tls config failed", "error", err)
		os.Exit(1)
	}

	nc, err := eventbus.Connect(cfg.NatsURL, hub, healthTracker.Touch, func(hostID string, payload []byte) {
		if !hostMetricsTracker.Touch(hostID, payload) {
			slog.Warn("host metrics payload not parsable, dropped", "host_id", hostID)
			return
		}
		// Kapitel 14 Teil 1: dieselbe geparste Metrics erneut aus dem
		// Tracker lesen statt den Payload ein zweites Mal zu parsen —
		// Touch() hat ihn gerade validiert und mit ReceivedAt versehen.
		if m, ok := hostMetricsTracker.Get(hostID); ok && !m.Goodbye {
			hostHistory.Record(hostID, m)
		}
	}, natsTLSConfig)
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

	// Zentraler Log-Kanal (ARCHITECTURE.md §25.2, UMSETZUNG.md D19) —
	// baut auf dem bereits laufenden NATS-JetStream-Cluster auf (D14),
	// keine neue Infrastruktur. Beobachtbarkeit ist nicht kritischer
	// Pfad (anders als mTLS oben): ein Fehler beim Stream-Setup
	// degradiert auf einen stillen No-Op-Publisher statt den gesamten
	// Prozess abzubrechen — dieselbe "best-effort"-Linie wie der
	// NATS-Connect oben (nc == nil).
	logPublisher, err := logbus.NewPublisher(ctx, nc, cfg.LogRetentionHours)
	if err != nil {
		slog.Error("logbus publisher setup failed, continuing without centralized logging", "error", err)
		logPublisher = &logbus.Publisher{}
	}
	logStore := logbus.NewStore(database, hub)
	go logStore.RunRetention(ctx, cfg.LogRetentionHours)

	// Kapitel 21 Phase 5 Teil 1 (A8/B9): JetStream-Stream für die
	// Process-/Asset-Domain-Events (s. processEventsStreamName-Doku
	// oben) — Setup läuft auf JEDER Instanz (CreateOrUpdateStream ist
	// idempotent, gleiche Linie wie logbus' Stream-Setup oben, kein
	// Leader-Gating nötig). nc == nil degradiert wie der Rest dieser
	// Datei: processJS bleibt nil, asset.Store.enqueueEvent bleibt
	// nil-sicher (State-Changes funktionieren unverändert, nur ohne
	// Event-Zustellung), Outbox-Relay/TriggerListener werden unten gar
	// nicht erst gestartet.
	var processJS jetstream.JetStream
	if nc != nil {
		processJS, err = jetstream.New(nc)
		if err != nil {
			slog.Error("process: jetstream init failed, continuing without domain event delivery", "error", err)
			processJS = nil
		} else if _, err := outbox.EnsureStream(ctx, processJS, jetstream.StreamConfig{
			Name:     processEventsStreamName,
			Subjects: []string{"omp.asset.>", "omp.process.>"},
			MaxAge:   processEventsRetention,
			Storage:  jetstream.FileStorage,
			// Gleiche Replikationstiefe wie OMP_LOGS/der 3-Knoten-NATS-
			// Cluster selbst (D14) — Domain-Events überleben denselben
			// Knotenausfall wie der Rest der Control-Plane.
			Replicas: 3,
		}); err != nil {
			slog.Error("process: jetstream stream setup failed, continuing without domain event delivery", "error", err)
			processJS = nil
		}
	}

	// mTLS Orchestrator↔Nodes (UMSETZUNG.md D3, ARCHITECTURE.md §4.6) —
	// opt-in über cfg.MTLSEnabled, Default aus. Ein nicht erreichbares
	// Zertifikat bei aktiviertem mTLS ist ein harter Fehler (ähnlich
	// Postgres oben): mit OMP_MTLS_ENABLED=true, aber kaputter Cert-
	// Konfiguration still auf Klartext zurückzufallen wäre die
	// gefährlichere Variante (sieht sicher aus, ist es nicht). Die
	// NMOS-Registry-Verbindung (Poller unten) war hier bei D3 bewusst
	// ausgeklammert — seit UMSETZUNG.md D16 eigenständig über
	// cfg.RegistryTLSEnabled/mtls.TrustedCAConfig abgedeckt (AMWA
	// BCP-003-01), s. dort.
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
	// Bewusst nur Dial-/Response-Header-Timeout, kein Client.Timeout
	// (Nutzerfund 2026-07-28: das nmos-cpp-Registry-Self-Registrierungs-
	// href zeigte auf eine seit einem Neustart unerreichbare Container-
	// interne IP — der Parameter-Panel-Klick hing daraufhin ~30s an der
	// OS-Standard-TCP-Connect-Timeout, statt zeitnah einen Fehler zu
	// zeigen). Ein Client.Timeout würde dieselbe Deadline auch auf
	// bewusst lang laufende Antworten anwenden (z. B. den MJPEG-Preview-
	// Multipart-Stream-Proxy, handleNodeStreamProxy) und diese nach
	// Ablauf abbrechen — DialContext/ResponseHeaderTimeout begrenzen nur
	// Verbindungsaufbau bzw. Warten auf die erste Antwort, nicht das
	// Lesen eines bereits begonnenen, absichtlich offenen Streams.
	nodeTransport := &http.Transport{
		TLSClientConfig:       nodeTLSConfig,
		DialContext:           (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
		ResponseHeaderTimeout: 5 * time.Second,
	}
	nodeHTTPClient := &http.Client{Transport: nodeTransport}
	if nodeTLSConfig != nil {
		slog.Info("mtls enabled for orchestrator-to-node requests")
	}

	// Orchestrator-Cluster (ARCHITECTURE.md §19.3, UMSETZUNG.md D12) —
	// vor allen Hintergrund-Loops konstruiert, weil deren Aktiv/Passiv-
	// Gating erst mit D12 Teil 3 kommt (bis dahin laufen alle Loops
	// unverändert auf jeder Instanz, s. dortiger Plan). Läuft immer, kein
	// Ein-/Ausschalter wie mTLS: ein Ein-Knoten-Cluster (ClusterPeers
	// leer, ClusterJoin false) ist der heutige Single-Host-Normalfall.
	// Reuse derselben mTLS-Zertifikate/-CA wie Orchestrator↔Node (§4.6)
	// für den Raft-Transport, statt einer zweiten, eigenen PKI-
	// Konfiguration — beide Richtungen sichern dieselbe Vertrauensgrenze
	// (step-ca). HTTPAddr reused OrchestratorURL (D12 Teil 2, s.
	// cluster.Config.HTTPAddr-Doku) statt eines eigenen Feldes.
	clusterFoundingPeers, err := cluster.ParsePeers(cfg.ClusterPeers)
	if err != nil {
		slog.Error("cluster peer config invalid", "error", err, "value", cfg.ClusterPeers)
		os.Exit(1)
	}
	clusterNode, err := cluster.New(cluster.Config{
		NodeID:   cfg.ClusterNodeID,
		RaftAddr: cfg.ClusterRaftAddr,
		HTTPAddr: cfg.OrchestratorURL,
		DataDir:  cfg.ClusterDataDir,
		TLS: mtls.Config{
			Enabled:  cfg.MTLSEnabled,
			CertFile: cfg.MTLSCertFile,
			KeyFile:  cfg.MTLSKeyFile,
			CAFile:   cfg.MTLSCAFile,
		},
		FoundingPeers: clusterFoundingPeers,
		SkipBootstrap: cfg.ClusterJoin,
	})
	if err != nil {
		slog.Error("cluster start failed", "error", err)
		os.Exit(1)
	}
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := clusterNode.Shutdown(shutdownCtx); err != nil {
			slog.Warn("cluster shutdown failed", "error", err)
		}
	}()
	slog.Info("cluster started", "node_id", cfg.ClusterNodeID, "raft_addr", cfg.ClusterRaftAddr, "founding_peers", len(clusterFoundingPeers), "skip_bootstrap", cfg.ClusterJoin)

	// NMOS-Registry-TLS (AMWA BCP-003-01, UMSETZUNG.md D16) — eigener
	// Opt-in-Schalter statt cfg.MTLSEnabled mitzubenutzen: die Registry-
	// Verbindung ist reines Server-TLS (Query-/Registration-API prüft
	// keine Client-Zertifikate), kein eigenes Orchestrator-Zertifikat
	// nötig, s. mtls.TrustedCAConfig. Bei RegistryURL=http://... bleibt
	// registryTLSConfig ungenutzt (Go's http.Transport ignoriert
	// TLSClientConfig für Klartext-Requests) — Default-Verhalten
	// unverändert, solange OMP_REGISTRY_TLS_ENABLED nicht gesetzt ist.
	registryTLSConfig, err := mtls.TrustedCAConfig(cfg.RegistryTLSEnabled, cfg.RegistryTLSCAFile)
	if err != nil {
		slog.Error("registry tls config failed", "error", err)
		os.Exit(1)
	}
	registryHTTPClient := &http.Client{Transport: &http.Transport{
		TLSClientConfig:       registryTLSConfig,
		DialContext:           (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
		ResponseHeaderTimeout: 5 * time.Second,
	}}
	if registryTLSConfig != nil {
		slog.Info("tls enabled for orchestrator-to-registry requests")
	}

	store := registry.NewStore()
	graphSvc := graph.NewService(store, is05.NewClient(nodeHTTPClient), hub, logPublisher)

	poller := registry.NewPoller(registry.NewClient(cfg.RegistryURL, registryHTTPClient), store)
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
	nodeSettingsStore := launcher.NewNodeSettingsStore(database)
	// ARCHITECTURE.md §24.1, UMSETZUNG.md C16: OMP_ORCHESTRATOR_URL für
	// jede lokal gestartete Instanz — Control-Plane-Nodes nutzen sie,
	// um sich ein Service-Token zu holen und den generischen Proxy
	// statt eines direkten Node-zu-Node-Zugriffs anzusprechen.
	launcherSvc.SetOrchestratorURL(cfg.OrchestratorURL)
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
	//
	// D12 Teil 3 (ARCHITECTURE.md §19.3 Punkt 5/6): Leader-gated
	// (subscribeWhileLeader) — jede Cluster-Instanz abonniert denselben
	// Broadcast-Subject, ohne dieses Gating hätte jede unabhängig ihre
	// eigene, rein lokale Crash-Loop-Zählung geführt und unabhängig
	// doppelt neu gestartet/failover-befördert (echter, bei der
	// Teil-3-Analyse gefundener Multi-Instanz-Bug, s.
	// docs/decisions.md Nachtrag 149 — der lokale os/exec-Supervise-Pfad
	// braucht dieses Gating NICHT: nur der Prozess, der ein Kind selbst
	// geforkt hat, kann dessen Ende überhaupt beobachten, das ist
	// bereits von Natur aus single-owner).
	if nc != nil {
		go subscribeWhileLeader(ctx, clusterNode, nc, "omp.host.*.events", func(msg *nats.Msg) {
			hostID, ok := hostIDFromEventsSubject(msg.Subject)
			if !ok {
				return
			}
			launcherSvc.HandleRemoteExit(hostID, msg.Data)
		})
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

	// I/O-Karten als erstklassige Host-Ressource (ARCHITECTURE.md §6.1
	// Erweiterung 2026-07-10, UMSETZUNG.md D13) — Postgres-Atomarität
	// reicht für "genau einmal cluster-weit geclaimt" bereits aus (s.
	// internal/ioports-Paketkommentar), kein Bezug zur Raft-Cluster-
	// Schicht (D12) nötig.
	ioPortStore := ioports.NewStore(database)

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
		NetPercent:        cfg.PlacementNetThreshold,
		GpuPercent:        cfg.PlacementGpuThreshold,
		HealthyCPUPercent: cfg.PlacementHealthyCPUThreshold,
		HealthyMemPercent: cfg.PlacementHealthyMemThreshold,
		HealthyNetPercent: cfg.PlacementHealthyNetThreshold,
		HealthyGpuPercent: cfg.PlacementHealthyGpuThreshold,
	}
	placementEngine := placement.NewEngine(hostStore, hostMetricsTracker, launcherSvc, hub, placementThresholds, profileStore)
	// D12 Teil 3: nur die aktuelle Leader-Instanz wertet aus/löst
	// Migrations-Empfehlungen aus (s. runWhileLeader-Doku) — ohne dieses
	// Gating würde jede Cluster-Instanz unabhängig denselben Alarm
	// erkennen und unabhängig eine Migration anstoßen (migration.go:
	// claimMigrationAttempt schützt nur innerhalb EINES Prozesses, nicht
	// clusterweit).
	go runWhileLeader(ctx, clusterNode, placementEngine.Run)

	// Workflow-Bereitstellung & -Verteilung (ARCHITECTURE.md §6.2,
	// UMSETZUNG.md D7 Teil 1/Teil 2): bündelt mehrere launcherSvc.Start()-
	// Aufrufe zu einem benannten Workflow, verkabelt die Rollen automatisch
	// gemäß Verbindungs-Template, sobald sie in der Registry erscheinen,
	// und prüft vor jedem Start die Ressourcenlage der Ziel-Hosts
	// (placementEngine.CheckHost).
	workflowSvc := workflows.NewService(workflows.NewStore(database), store, graphSvc, launcherSvc, hub, nodeHTTPClient, placementEngine, authzStore)
	// D13: ioPortAdapter reshapes *ioports.Store.GetClaim (liefert
	// ioports.Claim) auf die schlanken Klartext-Strings, die
	// workflows.IOPortClaimer erwartet — gleiches Adapter-Muster wie
	// natsRequester oben (workflows bleibt frei von einer direkten
	// ioports-Paket-Abhängigkeit, s. dortige IOPortClaimer-Doku).
	workflowSvc.SetIOPortClaimer(ioPortAdapter{store: ioPortStore})
	// Nutzerfund 2026-09-03: lässt `workflows.Service.runStop` den
	// Node-Graph-Cache (`poller`, oben) sofort statt erst nach bis zu
	// `registry.PollInterval` (2s) auffrischen, sobald eine Rollen-
	// Instanz tatsächlich gestoppt ist — behebt Nachreißer-Flackern im
	// Flow-Editor beim Workflow-Stop (s. workflows/service.go::runStop).
	workflowSvc.SetRegistryPoller(poller)

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

	// K7-Teil-4 (docs/END-GOAL-FEATURES.md §7.4, Hot-Standby): Crash-Loop-
	// Trigger (launcher gibt eine Instanz endgültig auf) + Host-Offline-
	// Trigger (hostMetricsTracker, bereits oben für Placement/Profile
	// verdrahtet, hier wiederverwendet statt eines zweiten Telemetrie-
	// Konsumenten). RunFailoverWatcher deckt zusätzlich die periodische
	// Bedienzustands-Erfassung für Rollen mit Standby ab (s. failover.go).
	launcherSvc.SetFailoverObserver(workflowSvc)
	workflowSvc.SetHostMetrics(hostMetricsTracker)
	// D12 Teil 3: gleiches Leader-Gating wie placementEngine.Run oben —
	// der Host-Offline-Trigger (Stufe 2 in failover.go) würde sonst auf
	// jeder Cluster-Instanz unabhängig denselben Host als offline
	// erkennen und unabhängig promoteStandby auslösen. Der
	// Crash-Loop-Trigger (Stufe 1, launcherSvc.SetFailoverObserver oben)
	// braucht dieses Gating dagegen nicht separat: er feuert nur aus dem
	// bereits leader-gated HandleRemoteExit-Pfad (subscribeWhileLeader
	// oben) bzw. aus dem von Natur aus single-owner lokalen
	// os/exec-Supervise-Pfad.
	go runWhileLeader(ctx, clusterNode, workflowSvc.RunFailoverWatcher)

	// D6 Teil 4 (ARCHITECTURE.md §6.1 Erweiterung 2026-07-13 Punkt 2):
	// automatisierte Placement-Eskalation (auto-confirm-window/auto) —
	// placementEngine bleibt dabei workflow-unwissend, sie reicht nur
	// ihren ohnehin berechneten Alarm-Stand an workflowSvc durch, das die
	// betroffene Rolle auflöst und je nach Role.Placement.Escalation
	// reagiert (s. migration.go). Erst hier verdrahtbar (workflowSvc
	// existiert erst ab hier), gleiches Nachträglich-Verdrahtungsmuster
	// wie SetRestartObserver/SetFailoverObserver oben.
	placementEngine.SetAdviceObserver(workflowSvc)

	// D7 Teil 2 (ARCHITECTURE.md §6.2 Punkt 1): führt Start/Stop-
	// Zeitpläne aus, unabhängig vom HTTP-Handler.
	workflowScheduler := workflows.NewScheduler(workflowSvc)
	// D12 Teil 3: Leader-Gating wie oben — der Scheduler selbst ist seit
	// dem Persist-vor-Feuern-Fix (scheduler.go, docs/decisions.md
	// Nachtrag 149) auch ohne Gating korrekt (kein Doppel-Feuern), aber
	// ungegatet würden N-1 Instanzen bei jedem Tick nutzlos dieselbe
	// Auswertung wiederholen.
	go runWhileLeader(ctx, clusterNode, workflowScheduler.Run)

	// Log-Projektor (ARCHITECTURE.md §25.2, UMSETZUNG.md D19) — Raft-
	// Leader-gegated wie placementEngine.Run oben (docs/decisions.md
	// Nachtrag 149: ohne Gating würde jede Cluster-Instanz unabhängig
	// dieselben JetStream-Zeilen projizieren). Durable-Consumer-Name
	// (logbus.RunProjector-Doku) übersteht einen Leader-Wechsel ohne
	// Datenverlust/-Duplikate.
	go runWhileLeader(ctx, clusterNode, func(ctx context.Context) {
		logbus.RunProjector(ctx, nc, logStore)
	})

	// Kapitel 21 Phase 5 Teil 1 (Workflow Engine + Asset/Content Domain
	// Model): verdrahtet die seit Phase 2-4 nur intern getesteten Pakete
	// internal/process/internal/outbox tatsächlich in den laufenden
	// Orchestrator — vorher lief keine Zeile davon außerhalb von Tests.
	// internal/asset (asset.NewStore) wird bewusst ERST in Phase 5 Teil 2
	// konstruiert: ohne eine HTTP-API, die seine Methoden aufruft, hätte
	// ein hier angelegter Store keinen einzigen Aufrufer (Go: "declared
	// and not used") — tote Verdrahtung wäre schlechter als ehrliches
	// Aufschieben. outboxStore/processEngine dagegen haben schon jetzt
	// echten Nutzen (Relay kann ab sofort alles zustellen, was künftige
	// Aufrufer einreihen; Engine kann ab sofort alles ausführen, was
	// künftige Aufrufer anlegen) — keine weitere main.go-Änderung nötig,
	// sobald Teil 2 die API ergänzt. Noch OHNE HTTP-API (Teil 2, eigene
	// Sitzung) — dieser Teil macht B16 ("Prozess killen, neu starten,
	// Workflow läuft korrekt weiter") im echten Betrieb möglich, sobald
	// Teil 2 einen Weg liefert, überhaupt eine Execution anzulegen.
	outboxStore := outbox.NewStore(database)
	processStore := process.NewStore(database)
	// EventPublisher = nc direkt (erfüllt process.EventPublisher: Publish
	// (subject string, payload []byte) error) — "workflow -> event"
	// bleibt bewusst fire-and-forget wie der Rest von internal/eventbus,
	// s. engine.go-Moduldoku; kein Outbox-Umweg für diese Richtung.
	processEngine := process.NewEngine(processStore, process.WithEventPublisher(nc))
	// MediaFunction/ServiceCall brauchen keine zusätzliche Sicherheits-
	// entscheidung (HTTP-Client + registry.Store genügen) — anders als
	// Script (s. u.), daher immer registriert.
	processEngine.Register(process.StepTypeServiceCall, process.NewServiceCallExecutor(nodeHTTPClient))
	processEngine.Register(process.StepTypeMediaFunction, process.NewMediaFunctionExecutor(process.NewRegistryNodeResolver(store), nodeHTTPClient))
	// Script (Aufgaben-Zusatzwunsch "Datei-Workflows nach Möglichkeit auf
	// ffmpeg aufbauen"): die Allow-Liste wird per exec.LookPath ERMITTELT,
	// nicht geraten (kein Raten, s. CLAUDE.md/UMSETZUNG.md §0) — ein auf
	// diesem Host nicht installiertes Programm bleibt draußen, Script-
	// Schritte, die es referenzieren, scheitern dann ehrlich mit "nicht
	// in der Allow-Liste" statt eines Pfad-Ratespiels.
	scriptAllowList := map[string]string{}
	for _, name := range []string{"ffmpeg", "ffprobe"} {
		if path, err := exec.LookPath(name); err == nil {
			scriptAllowList[name] = path
		} else {
			slog.Warn("process: script executor: command not found, Script-Schritte dafür bleiben abgelehnt", "command", name)
		}
	}
	if scriptEval, err := process.NewEvaluator(); err == nil {
		processEngine.Register(process.StepTypeScript, process.NewScriptExecutor(scriptAllowList, scriptEval))
	} else {
		slog.Error("process: script executor: evaluator init failed, Script-Schritte bleiben unregistriert", "error", err)
	}

	// D12 Teil 3: gleiches Leader-Gating wie placementEngine.Run/
	// workflowScheduler.Run oben — RecoverAll() unabhängig auf jeder
	// Instanz aufzurufen wäre harmlos (CAS-Schutz, s. Engine-Doku), aber
	// sinnlose Mehrfacharbeit; nur der Leader treibt Executions aktiv an.
	// Engine.Shutdown() beim Führungsverlust statt nur RecoverAll()
	// einmalig: eine Instanz, die die Führung verliert, darf ihre eigenen
	// aktiven Zyklen nicht unbeaufsichtigt weiterlaufen lassen (der neue
	// Leader startet sie über sein eigenes RecoverAll() ohnehin neu).
	go runWhileLeader(ctx, clusterNode, func(leaderCtx context.Context) {
		if err := processEngine.RecoverAll(); err != nil {
			slog.Error("process: recover all executions failed", "error", err)
		}
		<-leaderCtx.Done()
		processEngine.Shutdown()
	})
	// Outbox-Relay/TriggerListener bleiben aus, wenn kein JetStream
	// erreichbar ist (processJS == nil, s. o.) — Asset-State-Changes und
	// Prozess-Ausführung selbst funktionieren unverändert weiter, nur
	// ohne Event-Zustellung bzw. Event-getriebenen Prozessstart.
	if processJS != nil {
		outboxRelay := outbox.NewRelay(outboxStore, processJS)
		go runWhileLeader(ctx, clusterNode, outboxRelay.Run)

		triggerListener := process.NewTriggerListener(processStore, processEngine, processJS, processEventsStreamName)
		go runWhileLeader(ctx, clusterNode, func(leaderCtx context.Context) {
			triggerListener.Start()
			<-leaderCtx.Done()
			triggerListener.Stop()
		})
	}

	backupSvc := backup.NewService(backup.ParsePatroniNodes(cfg.PatroniNodes), cfg.BackupDir, cfg.BackupKeep)
	supervisorClient := supervisorclient.New(cfg.SupervisorURL)

	handler := httpapi.NewHandler(cfg, store, hub, graphSvc, layoutStore, snapshotSvc, launcherSvc, consoleResolver, nodeHTTPClient, authSvc, authzStore, auditStore, auditStore, hostStore, hostMetricsTracker, hostHistory, workflowSvc, placementEngine, profileStore, placementThresholds, nodeSettingsStore, backupSvc, supervisorClient, clusterNode, ioPortStore, logStore, logPublisher, httpapi.WithAlarmAckStore(alarmacks.NewStore(database)))

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
