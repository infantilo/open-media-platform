package main

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/infantilo/openmediaplatform/jobwire"
	"github.com/infantilo/openmediaplatform/jobwire/clocksync"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/alertsink"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/kpi"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/profile"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/uiorigin"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/alarmacks"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/asset"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/assetlinks"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/audit"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/auth"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/backup"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/blackbox"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/cluster"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/config"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/consoles"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/db"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/domainaudit"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/eventbus"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/ffmpegtools"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/freeze"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/graph"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/groups"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/health"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/hostcmd"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/housekeeping"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/httpapi"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/ioports"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/is05"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/jobrun"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/layouts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/locations"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/logbus"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/maintenance"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/materialize"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
	extsvcmod "github.com/infantilo/openmediaplatform/orchestrator/internal/modules/extsvc"
	ingestmod "github.com/infantilo/openmediaplatform/orchestrator/internal/modules/ingest"
	jobsmod "github.com/infantilo/openmediaplatform/orchestrator/internal/modules/jobs"
	playoutmod "github.com/infantilo/openmediaplatform/orchestrator/internal/modules/playout"
	reviewmod "github.com/infantilo/openmediaplatform/orchestrator/internal/modules/review"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/mtls"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/nodeauth"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/nodeoptions"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/nodeversions"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/organizations"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/outbox"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/placement"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/process"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/profiles"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/runtimesettings"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/safego"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/snapshots"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sourcetags"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/storagebackends"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/supervisorclient"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/support"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/supportaccess"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/timeline"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/trends"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/updates"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/version"
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

// hostSigner signiert Kommandos an Host-Agents (Audit 2026-10-23 B2); gesetzt, sobald die Datenbank bereit ist.
var hostSigner atomic.Pointer[hostcmd.Signer]

func (r natsRequester) RequestBytes(subject string, data []byte, timeout time.Duration) ([]byte, error) {
	if sg := hostSigner.Load(); sg != nil {
		return sg.Request(subject, data, timeout)
	}
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
	http.DefaultTransport = nodeauth.Wrap(http.DefaultTransport)
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	// Audit 2026-10-23 M1: auch der Orchestrator-Rechner stellt seinen TAI-Versatz und seine Uhr, wenn kein Zeitdienst es tut.
	go clocksync.Run(context.Background(), clocksync.ConfigFromEnv())

	cfg := config.Load()

	// Audit 2026-10-23 B4/B5: Produktionsprofil. OMP_PROFILE=production verweigert den Start bei offenen kritischen Befunden
	// (bewusst Akzeptiertes in OMP_PROFILE_ACCEPT); sonst werden sie nur gemeldet und unter GET /api/v1/admin/profile angeboten.
	profileFindings := profile.Evaluate(profile.Inputs{
		PostgresURL: cfg.PostgresURL, NatsURL: cfg.NatsURL, NatsTLS: cfg.NatsTLSEnabled, RegistryTLS: cfg.RegistryTLSEnabled, NodeMTLS: cfg.MTLSEnabled,
		JWTSecret: cfg.JWTSecret, BootstrapOpen: cfg.BootstrapOpen, UpdateAllowUnsigned: cfg.UpdateAllowUnsigned, BackupPassphrase: cfg.BackupPassphrase,
		BackupCopyDir: cfg.BackupCopyDir, MetricsToken: cfg.MetricsToken, ClusterPeers: cfg.ClusterPeers,
	})
	profileName := os.Getenv("OMP_PROFILE")
	if profileName == "" {
		profileName = "dev"
	}
	if err := profile.Enforce(profileName, profileFindings, profile.Accepted(os.Getenv("OMP_PROFILE_ACCEPT"))); err != nil {
		slog.Error("orchestrator start refused", "error", err)
		os.Exit(1)
	}
	if n := len(profileFindings); n > 0 {
		slog.Warn("Konfiguration entspricht nicht dem Produktionsprofil", "profile", profileName, "findings", n, "details", "GET /api/v1/admin/profile", "enforce", "OMP_PROFILE=production")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	hub := sse.NewHub()
	// Audit M7: Medien-Kennzahlen (Verfügbarkeit, Ausfälle) aus den Health-Ereignissen der Nodes.
	kpiTracker := kpi.NewTracker()
	// Flugschreiber (Kap. 72.10): die letzten 15 Minuten der Node-Kennzahlen und Prozesswerte in 5-s-Auflösung, Grundlage von „Einfrieren“.
	flightBox := blackbox.New()
	go func() {
		ch, cancel := hub.Subscribe()
		defer cancel()
		for ev := range ch {
			if id, label, ready, kpis, ok := kpi.FromEvent(ev); ok {
				kpiTracker.Observe(id, label, ready, kpis, time.Now())
				flightBox.Record(id, label, ready, kpis, time.Now())
			}
		}
	}()
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
	// Module (Kapitel 36): eigene Migrationen nach dem Kernschema. Ein Modul mit fehlgeschlagener Migration wird als
	// `failed` markiert und nicht gemountet; der Kern startet trotzdem.
	modules := module.NewRegistry(module.DisabledFromEnv()...)
	playoutSvc := &playoutmod.Services{}
	reviewMod := reviewmod.New(nil)                  // der Asset-Store folgt weiter unten (assetStore), vor dem Mounten der Routen
	ingestMod := ingestmod.New(ingestmod.Services{}) // Kern-Dienste folgen weiter unten (vor dem Mounten der Routen)
	extsvcMod := extsvcmod.New(extsvcmod.Services{}) // Registry, Launcher und Node-Client folgen weiter unten
	jobsMod := jobsmod.New()                         // ffmpeg-Jobs: Host-Auswahl, Lastverteilung, Sendeschutz (Kapitel 52)
	registerModules(modules, playoutSvc, reviewMod, ingestMod, extsvcMod, jobsMod)
	if err := modules.Migrate(ctx, database); err != nil {
		slog.Error("module migration failed (affected modules are not mounted)", "error", err)
	}

	// Kapitel 29: in der UI gesetzte Betriebswerte überschreiben Umgebung/Defaults (wirksam
	// ab diesem Start). Ungültige Einträge werden übersprungen und gemeldet, nie angewendet.
	systemSettingsStore := runtimesettings.NewStore(database)
	var startupSkipped []string
	if overrides, oerr := systemSettingsStore.Overrides(); oerr != nil {
		slog.Warn("einstellungen: Überschreibungen nicht lesbar", "error", oerr)
	} else if startupSkipped = runtimesettings.Apply(&cfg, overrides); len(startupSkipped) > 0 {
		slog.Warn("einstellungen: Überschreibungen verworfen", "details", startupSkipped)
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
	// Ereignis-Zeitleiste (Kap. 72.6): zeichnet Betriebsereignisse aus dem Hub auf; Bedienungen, Domänen-Audit und Fehler-Logs
	// kommen beim Lesen aus ihren Tabellen dazu.
	timelineStore := timeline.NewStore(database)

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
		// Viele Operatoren/Proxy-Aufrufe pro Node: Go-Default wäre 2 Idle-
		// Verbindungen pro Host (ständiger Neuaufbau unter Last).
		MaxIdleConns:        512,
		MaxIdleConnsPerHost: 32,
		IdleConnTimeout:     90 * time.Second,
	}
	nodeHTTPClient := &http.Client{Transport: nodeauth.Wrap(nodeTransport)}
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
		MaxIdleConns:          16,
		MaxIdleConnsPerHost:   8,
		IdleConnTimeout:       90 * time.Second,
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
	// Kapitel 48: Dienst-Token für das Dienst-Gateway (bleibt über Neustarts gleich, damit weiterlaufende Nodes gültig bleiben).
	serviceToken, err := loadServiceToken(filepath.Dir(cfg.JWTSecretFile))
	if err != nil {
		slog.Error("service token unavailable", "error", err)
		os.Exit(1)
	}
	launcherSvc.SetServiceToken(serviceToken)
	// Audit 2026-10-23 B1: Node-API-Token (s. internal/nodeauth). Aus dem gemeinsamen JWT-Geheimnis abgeleitet, damit alle Orchestrator-
	// Instanzen des Clusters dasselbe Token kennen; OMP_NODE_API_TOKEN überschreibt (z. B. um es mit extern gestarteten Nodes zu teilen).
	// Muss vor RestoreLocal stehen: die dort gestarteten Nodes bekommen es in ihre Umgebung.
	jwtSecret := []byte(cfg.JWTSecret)
	if cfg.JWTSecret == "" {
		jwtSecret, err = auth.LoadOrCreateSharedSecret(database, cfg.JWTSecretFile)
		if err != nil {
			slog.Error("jwt secret setup failed", "error", err)
			os.Exit(1)
		}
	}
	nodeAPIToken := os.Getenv(nodeauth.Env)
	if nodeAPIToken == "" {
		nodeAPIToken = nodeauth.Derive(jwtSecret)
	}
	launcherSvc.SetNodeAPIToken(nodeAPIToken)
	nodeauth.SetToken(nodeAPIToken)
	nodeauth.SetExtraHosts(strings.Split(os.Getenv("OMP_NODE_API_TOKEN_HOSTS"), ","))
	// Nach Neustart/Reboot die zuvor laufenden Instanzen wieder starten (lokale hier, Instanzen auf
	// Host-Agents vom Cluster-Leader, s. unten).
	launcherSvc.RestoreLocal()
	// Kapitel 29: einstellbare Node-Optionen (Schema aus node-options.json neben dem Katalog,
	// Werte aus Postgres). Fehlt die Datei, bleibt alles wie früher.
	nodeOptionStore := nodeoptions.NewStore(database)
	if schema, serr := nodeoptions.LoadFile(filepath.Join(filepath.Dir(cfg.CatalogPath), "node-options.json")); serr == nil {
		launcherSvc.SetNodeOptions(schema, nodeOptionStore)
	} else if !errors.Is(serr, os.ErrNotExist) {
		slog.Error("node-optionen: node-options.json ungültig — Optionen deaktiviert", "error", serr)
	}
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
	if v, err := strconv.Atoi(os.Getenv("OMP_AUTH_MIN_PASSWORD")); err == nil && v >= 8 {
		auth.MinPasswordLength = v
	}
	authSvc := auth.NewService(auth.NewStore(database), jwtSecret)
	authzStore := authz.NewStore(database)
	// Kapitel 21 B14 (Nachtrag 283) — s. internal/organizations-Paketdoku.
	orgStore := organizations.NewStore(database)
	// Nutzerauftrag 2026-09-24: gruppenbasierte Rechteverwaltung — s.
	// internal/groups-Paketdoku. Unconditional wie orgStore (kein Env-
	// Var-Gate wie bei den Storage-Backends, da Gruppen kein Secret
	// verschlüsseln und keine externe Infrastruktur brauchen).
	groupStore := groups.NewStore(database)
	groupStore.OnChange = authzStore.Invalidate // Audit H7: Mitgliedschaftsänderung verwirft den Rechte-Cache sofort
	auditStore := audit.NewStore(database, hub)
	// S5 (docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md): Startup- + täglicher
	// Retention-Lauf, löscht Audit-Zeilen älter als cfg.AuditRetentionDays.
	go auditStore.RunRetention(ctx, cfg.AuditRetentionDays)
	// Fachliches Domain-Audit (Kapitel 21 B13), additiv zu auditStore oben
	// — s. internal/domainaudit-Paketdoku. Teilt sich cfg.AuditRetentionDays
	// (kein eigener Konfigurationswert: reine Verdopplung ohne fachlichen
	// Unterschied zwischen den beiden Aufbewahrungsfristen).
	domainAuditStore := domainaudit.NewStore(database, hub)
	go domainAuditStore.RunRetention(ctx, cfg.AuditRetentionDays)

	// Asset<->Workflow-Verknüpfung (Kapitel 21 B10, Nachtrag 277,
	// Nutzerentscheidung 2026-09-23: generische Link-API).
	assetLinkStore := assetlinks.NewStore(database)

	// Storage-Backend-Registry (Nutzerauftrag 2026-09-24: super-admin-
	// verwaltete, live hinzufügbare/entfernbare S3/MinIO-Ziele — löst
	// Kapitel 21 B5s einzelnes, fest über OMP_MINIO_* konfiguriertes
	// objectstore.Client ab, Nachtrag 280/285). Additiv wie mTLS: leerer
	// OMP_STORAGE_SECRET_KEY lässt storageBackendStore als nil-Interface,
	// sowohl die Verwaltungs- als auch die Presigned-URL-Endpunkte
	// antworten dann 503/404 statt zu crashen. Ein GESETZTER, aber
	// ungültiger Schlüssel (falsche Länge/Kodierung) ist dagegen fatal —
	// anders als "Feature nicht konfiguriert" deutet das auf einen
	// Tippfehler hin, den ein Admin sofort sehen soll, nicht erst beim
	// ersten fehlschlagenden Backend-Zugriff.
	// storageBackendSvc bleibt bewusst ein Interface-Wert (nicht der
	// konkrete *storagebackends.Store), obwohl storageBackendStore unten
	// selbst schon der konkrete Typ ist — ein nil *storagebackends.Store
	// in ein Interface eingepackt wäre NICHT `== nil` (klassische Go-
	// Falle), server.go's `if options.storageBackends != nil` würde dann
	// fälschlich "aktiv" sehen, obwohl gar kein Store existiert. Diese
	// Variable wird nur zugewiesen, wenn wirklich ein Store entstand.
	var storageBackendSvc httpapi.StorageBackendService
	var storageBackendStore *storagebackends.Store
	if cfg.StorageSecretKey != "" {
		var err error
		storageBackendStore, err = storagebackends.NewStore(database, cfg.StorageSecretKey)
		if err != nil {
			slog.Error("storage backends: invalid OMP_STORAGE_SECRET_KEY", "error", err)
			os.Exit(1)
		}

		// Einmalige Migrations-Komfortfunktion: ein bestehendes Dev-Setup
		// mit den alten OMP_MINIO_*-Variablen, aber noch ohne ein einziges
		// registriertes Backend, bekommt automatisch einen sichtbaren,
		// voll bedienbaren Eintrag dafür — kein "hidden config" mehr (s.
		// Nutzerauftrag), sondern ab dem ersten Start in der UI (Admin-
		// istration > Storage) sichtbar und danach normal editierbar/
		// löschbar wie jedes andere Backend.
		if existing, err := storageBackendStore.List(); err == nil && len(existing) == 0 && cfg.MinioEndpoint != "" {
			seedInput := storagebackends.Input{
				Name: "Default (aus OMP_MINIO_* migriert)", Provider: "minio",
				Endpoint: cfg.MinioEndpoint, Bucket: cfg.MinioBucket,
				AccessKey: cfg.MinioAccessKey, SecretKey: cfg.MinioSecretKey, UseSSL: cfg.MinioUseSSL,
			}
			if seeded, err := storageBackendStore.Create(ctx, seedInput, "system"); err != nil {
				slog.Warn("storage backends: could not auto-migrate legacy OMP_MINIO_* config", "error", err)
			} else {
				slog.Info("storage backends: auto-migrated legacy OMP_MINIO_* config into a visible backend",
					"id", seeded.ID, "name", seeded.Name, "hint", "safe to remove OMP_MINIO_* once confirmed working in Administration > Storage")
			}
		}

		activeCount := 0
		if failed, err := storageBackendStore.WarmAll(ctx); err != nil {
			slog.Warn("storage backends: could not list backends to pre-warm", "error", err)
		} else if len(failed) > 0 {
			slog.Warn("storage backends: some backends are currently unreachable (will retry lazily on first use)", "backends", failed)
		} else if all, err := storageBackendStore.List(); err == nil {
			activeCount = len(all)
		}
		slog.Info("storage backends: enabled", "count", activeCount)
		storageBackendSvc = storageBackendStore
	} else {
		slog.Info("storage backends: disabled (OMP_STORAGE_SECRET_KEY unset) — set it to a base64-encoded 32-byte key to enable Administration > Storage")
	}

	// Remote-Host-Erkennung (ARCHITECTURE.md §18, UMSETZUNG.md D6 Teil 1).
	hostStore := hosts.NewStore(database)
	if nc != nil {
		sg := &hostcmd.Signer{Conn: nc, Keys: hostStore, Term: clusterNode.Term}
		hostSigner.Store(sg)
		// Hosts aus der Zeit vor der Signatur bekommen ihren Schlüssel, sobald sie online sind (nicht erst beim ersten Kommando).
		safego.Go("hostcmd.provision", func() {
			tick := time.NewTicker(20 * time.Second)
			defer tick.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-tick.C:
					hs, err := hostStore.ListHosts()
					if err != nil {
						continue
					}
					for _, h := range hs {
						if m, ok := hostMetricsTracker.Get(h.ID); ok && time.Since(m.ReceivedAt) < 15*time.Second {
							sg.EnsureProvisioned(h.ID, 3*time.Second)
						}
					}
				}
			}
		})
	}

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
	jobsMod.History, jobsMod.Profiles = hostHistory, profileStore
	// Trend-Daten (Kapitel 54): Stundenwerte der Host-Telemetrie in Postgres (30 Tage) — überleben Neustarts, Grundlage der
	// Auto-Kalibrierung der Live-Reserve und der 7-/30-Tage-Ansicht.
	hourStore := hosts.NewHourStore(database)
	if rows, herr := hourStore.Load(ctx, time.Now().Add(-30*24*time.Hour)); herr != nil {
		slog.Warn("trend: Stundenwerte nicht lesbar", "error", herr)
	} else {
		for id, r := range rows {
			hostHistory.Seed(id, r)
		}
	}
	hostHistory.OnHour = func(id string, row hosts.HourRow) {
		if serr := hourStore.Save(id, row); serr != nil {
			slog.Warn("trend: Stundenwert nicht gespeichert", "host", id, "error", serr)
		}
	}
	// Der Orchestrator-Rechner selbst ist kein Host-Agent und sendet keine Telemetrie über NATS: hier alle 5 s ins Verlaufsmodell
	// eintragen (Host-ID "local"), samt Live-Anteil der lokal gestarteten Instanzen.
	go recordLocalHost(ctx, launcherSvc, hostHistory)
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
	// Trend-Vorwarnung (Kapitel 54): OMP_PLACEMENT_PREDICT = off | warn (Standard: Alarm + Vorschlag) | act (auch automatische
	// Eskalation der Rolle, bevor die Schwelle erreicht ist); OMP_PLACEMENT_PREDICT_HORIZON_MIN = Vorlauf in Minuten (Standard 60).
	prediction := placement.DefaultPrediction
	if v := strings.ToLower(strings.TrimSpace(os.Getenv("OMP_PLACEMENT_PREDICT"))); v == "off" || v == "warn" || v == "act" {
		prediction.Mode = v
	}
	if v, perr := strconv.Atoi(os.Getenv("OMP_PLACEMENT_PREDICT_HORIZON_MIN")); perr == nil && v >= 5 && v <= 480 {
		prediction.Horizon = time.Duration(v) * time.Minute
	}
	placementEngine.SetPrediction(hostHistory, prediction)
	// D12 Teil 3: nur die aktuelle Leader-Instanz wertet aus/löst
	// Migrations-Empfehlungen aus (s. runWhileLeader-Doku) — ohne dieses
	// Gating würde jede Cluster-Instanz unabhängig denselben Alarm
	// erkennen und unabhängig eine Migration anstoßen (migration.go:
	// claimMigrationAttempt schützt nur innerhalb EINES Prozesses, nicht
	// clusterweit).
	go runWhileLeader(ctx, clusterNode, placementEngine.Run)
	go runWhileLeader(ctx, clusterNode, func(ctx context.Context) {
		launcherSvc.RestoreRemote()
		<-ctx.Done()
	})

	// Workflow-Bereitstellung & -Verteilung (ARCHITECTURE.md §6.2,
	// UMSETZUNG.md D7 Teil 1/Teil 2): bündelt mehrere launcherSvc.Start()-
	// Aufrufe zu einem benannten Workflow, verkabelt die Rollen automatisch
	// gemäß Verbindungs-Template, sobald sie in der Registry erscheinen,
	// und prüft vor jedem Start die Ressourcenlage der Ziel-Hosts
	// (placementEngine.CheckHost).
	workflowSvc := workflows.NewService(workflows.NewStore(database), store, graphSvc, launcherSvc, hub, nodeHTTPClient, placementEngine, authzStore)
	// Playout-Fachwissen im Workflow-Dienst (Automations-Ziele, Control-Plane-Typ) kommt über die Erweiterungspunkte der
	// Modul-Schnittstelle (Kapitel 36.5), nicht mehr aus dem Kern.
	playoutmod.Register(workflowSvc)
	// Video folgt Audio (Kapitel 46) steuert Bild- und Tonmischer fern und braucht wie die Automation ein Service-Token.
	workflowSvc.RegisterControlPlaneType("omp-vfa")
	// Lauf-Historie (Scheduler: geplant vs. real) samt täglicher Bereinigung.
	workflowRunStore := workflows.NewRunStore(database)
	workflowSvc.SetRunRecorder(workflowRunStore)
	workflowSvc.ReconcileRuns()
	go workflowRunStore.RunRetention(ctx, cfg.WorkflowRunRetentionDays)
	// Aufräumen der übrigen unbegrenzt wachsenden Tabellen (Outbox, Host-
	// Einmaltokens, abgeschlossene Prozess-Ausführungen, Alarm-Quittierungen).
	go housekeeping.New(database, housekeeping.Config{
		OutboxDays:           cfg.OutboxRetentionDays,
		HostTokenDays:        cfg.HostTokenRetentionDays,
		ProcessExecutionDays: cfg.ProcessExecutionRetentionDays,
	}, alarmacks.NewStore(database)).Run(ctx)
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
	// Audit 2026-10-23 M7: externes Alarming. Nur der Leader sendet (sonst käme jeder Alarm einmal je Orchestrator); ohne OMP_ALERT_WEBHOOK_URL passiert nichts.
	if sink := alertsink.New(os.Getenv("OMP_ALERT_WEBHOOK_URL"), os.Getenv("OMP_ALERT_WEBHOOK_TOKEN")); sink != nil {
		slog.Info("externes Alarming aktiv (Webhook)")
		go sink.Run(ctx)
		go runWhileLeader(ctx, clusterNode, func(ctx context.Context) { alertsink.NodeAlerts(ctx, hub, sink) })
		go runWhileLeader(ctx, clusterNode, func(ctx context.Context) { (&alertsink.HealthWatch{Sink: sink}).Run(ctx, hub) })
		go runWhileLeader(ctx, clusterNode, func(ctx context.Context) {
			alertsink.WatchLoad(ctx, 5*time.Second, time.Duration(getEnvIntMain("OMP_ALERT_LOAD_SECONDS", 120))*time.Second, float64(getEnvIntMain("OMP_ALERT_CPU_PERCENT", 95)), float64(getEnvIntMain("OMP_ALERT_MEM_PERCENT", 95)), float64(getEnvIntMain("OMP_ALERT_TEMP_C", 85)), func() map[string]alertsink.Load {
				out := map[string]alertsink.Load{}
				all, err := hostStore.ListHosts()
				if err != nil {
					return out
				}
				for _, h := range all {
					m, ok := hostMetricsTracker.Get(h.ID)
					if !ok || m.Goodbye || time.Since(m.ReceivedAt) >= 15*time.Second {
						continue
					}
					mem := 0.0
					if m.MemTotalBytes > 0 {
						mem = float64(m.MemUsedBytes) / float64(m.MemTotalBytes) * 100
					}
					load := alertsink.Load{Name: h.Label, CPUPercent: m.CPUPercent, MemPercent: mem}
					if m.Sensors != nil && m.Sensors.TempC != nil {
						load.TempC = *m.Sensors.TempC
					}
					out[h.ID] = load
				}
				return out
			}, sink)
		})
		go runWhileLeader(ctx, clusterNode, func(ctx context.Context) {
			alertsink.WatchHosts(ctx, 5*time.Second, func() map[string]alertsink.HostState {
				out := map[string]alertsink.HostState{}
				all, err := hostStore.ListHosts()
				if err != nil {
					return out
				}
				for _, h := range all {
					m, ok := hostMetricsTracker.Get(h.ID)
					out[h.ID] = alertsink.HostState{Name: h.Label, Online: ok && !m.Goodbye && time.Since(m.ReceivedAt) < 15*time.Second}
				}
				return out
			}, sink)
		})
	}
	// Periodische Sicherung des Bedienzustands laufender Workflows
	// (OMP_ROLE_STATE_BACKUP_INTERVAL, Default 60s, "0" = aus).
	go runWhileLeader(ctx, clusterNode, workflowSvc.RunRoleStateBackup)

	// D6 Teil 4 (ARCHITECTURE.md §6.1 Erweiterung 2026-07-13 Punkt 2):
	// automatisierte Placement-Eskalation (auto-confirm-window/auto) —
	// placementEngine bleibt dabei workflow-unwissend, sie reicht nur
	// ihren ohnehin berechneten Alarm-Stand an workflowSvc durch, das die
	// betroffene Rolle auflöst und je nach Role.Placement.Escalation
	// reagiert (s. migration.go). Erst hier verdrahtbar (workflowSvc
	// existiert erst ab hier), gleiches Nachträglich-Verdrahtungsmuster
	// wie SetRestartObserver/SetFailoverObserver oben.
	placementEngine.SetAdviceObserver(workflowSvc)
	// Wartungsmodus für Hosts: Sperre + Make-before-break-Evakuierung (internal/maintenance).
	maintenanceMgr := maintenance.NewManager(hostStore, placementEngine, workflowSvc, maintenanceInstances{launcherSvc}, hub)
	maintenanceMgr.Restore()

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
	// internal/asset (asset.NewStore) wurde in Phase 5 Teil 1 bewusst
	// NICHT konstruiert (kein Aufrufer ohne HTTP-API, s. Nachtrag 263) —
	// jetzt, mit der Asset-API aus Phase 5 Teil 3, hat es einen echten
	// Aufrufer und wird hier gebaut. `WithOutbox(outboxStore)` aktiviert
	// B9 (Asset-Domain-Events, bereits seit Phase 4 Teil 1 im Store
	// vorbereitet, bis jetzt aber nie tatsächlich ausgelöst, weil nie ein
	// Aufrufer CreateAsset/UpdateAssetStatus/... rief).
	outboxStore := outbox.NewStore(database)
	assetStore := asset.NewStore(database, asset.WithOutbox(outboxStore))
	reviewMod.Assets = assetStore
	ingestFFmpeg, _ := exec.LookPath("ffmpeg")
	// ffmpeg-Jobs (Kapitel 52): Dispatcher verdrahten — Weg zu den Host-Agents, Pfadprüfung auf Hosts, gebuchte Live-Zeit
	// der Aufnahmen; QC, Proxy, Ingest-Nachbearbeitung und Script-Schritte laufen darüber.
	jobDisp := jobsMod.Dispatcher()
	if nc != nil {
		jobDisp.Bus = jobrun.NATSBus{Conn: nc, Signer: hostSigner.Load()}
	}
	jobDisp.CheckPath = func(hostID, path, kind string) (bool, string) {
		info, perr := launcherSvc.CheckPathOnHost(hostID, path, kind)
		switch {
		case perr != nil:
			return false, perr.Error()
		case !info.Exists:
			return false, "nicht vorhanden: " + path
		case kind == "dir" && !info.IsDir:
			return false, path + " ist kein Verzeichnis"
		case kind != "dir" && !info.Readable:
			return false, path + " nicht lesbar"
		}
		return true, ""
	}
	jobDisp.Busy = jobsmod.BusyFromBookings(ingestMod.BusyOn)
	reviewMod.QCRunner = &jobrun.Runner{D: jobDisp, Caller: "qc", Class: jobrun.ClassBatch}
	reviewMod.ProxyRunner = &jobrun.Runner{D: jobDisp, Caller: "proxy", Class: jobrun.ClassInteractive}
	ingestMod.S = ingestmod.Services{Assets: assetStore, Launcher: launcherSvc, Nodes: store, Graph: graphSvc, FFmpeg: ingestFFmpeg,
		Jobs: &jobrun.Runner{D: jobDisp, Caller: "convert", Class: jobrun.ClassScheduled}}
	extsvcMod.S = extsvcmod.Services{Nodes: store, Secrets: serviceSecrets{l: launcherSvc, token: serviceToken}, HTTP: &http.Client{Transport: nodeauth.Wrap(nodeTransport), Timeout: 10 * time.Second}}
	processStore := process.NewStore(database)
	// EventPublisher = nc direkt (erfüllt process.EventPublisher: Publish
	// (subject string, payload []byte) error) — "workflow -> event"
	// bleibt bewusst fire-and-forget wie der Rest von internal/eventbus,
	// s. engine.go-Moduldoku; kein Outbox-Umweg für diese Richtung.
	processEngine := process.NewEngine(processStore, process.WithEventPublisher(nc))
	// MediaFunction/ServiceCall brauchen keine zusätzliche Sicherheits-
	// entscheidung (HTTP-Client + registry.Store genügen) — anders als
	// Script (s. u.), daher immer registriert.
	// Kapitel 27 / P8: Materialisierung als Prozess-Schritt (Playout-Preflight).
	var matObjects materialize.ObjectBackends
	if storageBackendStore != nil {
		matObjects = storageBackendStore
	}
	matManager := materialize.NewManager(assetStore, matObjects)
	processEngine.Register(process.StepTypeMaterialize, materialize.Executor{Manager: matManager})
	preflightSvc := materialize.Preflight{Manager: matManager, Starter: &materialize.Starter{Store: processStore, Engine: processEngine}}
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
	scriptCommandNames := make([]string, 0, len(scriptAllowList))
	for name := range scriptAllowList {
		scriptCommandNames = append(scriptCommandNames, name)
	}
	// UMSETZUNG.md Kapitel 22 (W1): dieselbe Allow-Liste wie oben liefert
	// gleich den ffmpeg-Pfad für die Introspektion mit — kein zweites
	// exec.LookPath, kein zweites Sicherheitsmodell. scriptAllowList["ffmpeg"]
	// ist "" (Go-Zero-Wert), wenn ffmpeg auf diesem Host fehlt;
	// ffmpegtools.Store bleibt dann nutzbar, meldet aber Available()==false.
	ffmpegToolsStore := ffmpegtools.NewStore(scriptAllowList["ffmpeg"])
	if scriptEval, err := process.NewEvaluator(); err == nil {
		processEngine.Register(process.StepTypeScript, process.NewScriptExecutor(scriptAllowList, scriptEval, process.WithJobRunner(jobDisp)))
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

	backupSvc := backup.NewService(backup.ParsePatroniNodes(cfg.PatroniNodes), cfg.BackupDir, cfg.BackupKeep).WithExtras(cfg.BackupKeyFiles, cfg.BackupPassphrase, cfg.BackupCopyDir)
	backupSvc.Warn = func(msg string, err error) { slog.Warn(msg, "error", err) }
	if cfg.BackupPassphrase == "" {
		slog.Info("backup: ohne OMP_BACKUP_PASSPHRASE kein Schlüsselbündel (Update-Schlüssel, mTLS-CA, Dateigeheimnisse sind nicht gesichert)")
	}
	if cfg.BackupIntervalHours > 0 {
		go runWhileLeader(ctx, clusterNode, func(ctx context.Context) {
			backup.RunSchedule(ctx, time.Duration(cfg.BackupIntervalHours)*time.Hour, 10*time.Minute, time.Hour, backupSvc.Newest,
				func(ctx context.Context) (string, error) {
					r, err := backupSvc.Create(ctx)
					return r.Name, err
				})
		})
	}
	supervisorClient := supervisorclient.New(cfg.SupervisorURL)
	updateDist := &updates.Distributor{
		Downloads: updates.NewDownloads(),
		Hosts: func() ([]updates.HostRef, error) {
			hs, err := hostStore.ListHosts()
			if err != nil {
				return nil, err
			}
			out := make([]updates.HostRef, 0, len(hs))
			for _, h := range hs {
				out = append(out, updates.HostRef{ID: h.ID, Label: h.Label})
			}
			return out, nil
		},
		Online: func(hostID string) bool {
			m, ok := hostMetricsTracker.Get(hostID)
			return ok && time.Since(m.ReceivedAt) < 20*time.Second
		},
		Request: func(subject string, data []byte, timeout time.Duration) ([]byte, error) {
			if launcherNATS == nil {
				return nil, errors.New("kein NATS verbunden")
			}
			return launcherNATS.RequestBytes(subject, data, timeout)
		},
	}
	// Kapitel 28: Versionsspeicher für Node-Binaries; produktive Version gilt für
	// neu gestartete lokale Instanzen. Gestempelte, installierte Binaries werden
	// im Hintergrund archiviert (Rückkehr nach einem Update).
	nodeVersionStore := nodeversions.New(cfg.NodeVersionsDir)
	launcherSvc.SetBinaryResolver(nodeVersionStore.Resolve)
	launcherSvc.SetBinaryLookup(func(name, id string) (string, bool) {
		p, err := nodeVersionStore.Path(name, id)
		return p, err == nil
	})
	safego.Go("nodeversions.registerInstalled", func() {
		paths := map[string]string{}
		for _, c := range launcherSvc.Catalog() {
			if (c.Runner == "process" || c.Runner == "") && len(c.Command) > 0 {
				paths[filepath.Base(c.Command[0])] = c.Command[0]
			}
		}
		added, _ := nodeVersionStore.RegisterInstalled(paths)
		if len(added) > 0 {
			slog.Info("node-versionen: installierte Binaries archiviert", "count", len(added))
		}
	})
	updateSvc := updates.New(cfg.UpdateDir, cfg.UpdatePubKeyFile, cfg.UpdateAllowUnsigned, runtime.GOOS+"/"+runtime.GOARCH, 0)

	// Dienste, die das Playout-Modul vom Kern braucht (Mount geschieht erst in NewHandler unten).
	*playoutSvc = playoutmod.Services{
		Authz: authzStore, Roles: workflowSvc, Preflight: preflightSvc, Launcher: launcherSvc, NodeValues: nodeOptionStore,
		Nodes: store, RetentionDays: cfg.AuditRetentionDays,
		Release: reviewmod.NewStore(database),
	}
	if nc != nil {
		playoutSvc.Publisher = nc
	}
	moduleDeps := module.Deps{Hooks: module.NewHooks(), DB: database, Audit: domainAuditStore, Settings: moduleSettings{nodeSettingsStore}, Access: moduleAccess{authzStore}, Actor: httpapi.ActorFromRequest,
		Hosts: hostStore, HostMetrics: hostMetricsTracker, Instances: moduleInstances{launcherSvc}, Placement: placementEngine}
	// Audit H1: zweiter Ursprung für Node-Oberflächen (nur mit OMP_UI_ORIGIN_LISTEN).
	var uiIso *httpapi.UIIsolation
	uiMgr := uiorigin.NewManager()
	if cfg.UIOriginListen != "" {
		_, port, perr := net.SplitHostPort(cfg.UIOriginListen)
		if perr != nil || port == "" {
			slog.Error("OMP_UI_ORIGIN_LISTEN ungültig (erwartet host:port oder :port)", "value", cfg.UIOriginListen)
			os.Exit(1)
		}
		uiIso = &httpapi.UIIsolation{Manager: uiMgr, Port: port, URLBase: cfg.UIOriginURL, Types: cfg.UIIsolationTypes}
	}
	// Zeitleiste (Kap. 72.6): Quellen zusammenführen, Hub aufzeichnen, Start und alte Zeilen aufräumen.
	timelineSrc := timeline.Sources{Store: timelineStore, Audit: auditStore, Domain: domainAuditStore, Logs: logStore}
	timelineRec := timeline.NewRecorder()
	timelineRec.HostLabel = func(id string) string {
		list, _ := hostStore.ListHosts()
		for _, h := range list {
			if h.ID == id {
				return h.Label
			}
		}
		return ""
	}
	// Baseline und Trends (Kap. 72.11): Stundenverlauf von Instanzen und Orchestrator (trend_hourly), Hosts aus host_metrics_hourly;
	// die Auswertung erkennt Abweichungen vom Üblichen und stetiges Wachstum.
	trendCol := trends.NewCollector(database)
	go trendCol.RunFlush(ctx, func(err error) { slog.Warn("trend flush failed", "error", err) })
	machineMem := func() float64 {
		if b, err := os.ReadFile("/proc/meminfo"); err == nil {
			total, _ := jobwire.ParseMeminfo(string(b))
			return float64(total)
		}
		return 0
	}
	trendAnalyzer := trends.NewAnalyzer(trendCol, trends.Sources{
		Hosts: func() []trends.HostHours {
			list, err := hostStore.ListHosts()
			if err != nil {
				return nil
			}
			var out []trends.HostHours
			for _, h := range list {
				w, ok := hostHistory.Window(h.ID, 30*24*time.Hour)
				if !ok || len(w.Hours) == 0 {
					continue
				}
				hh := trends.HostHours{ID: h.ID, Label: h.Label}
				for _, r := range w.Hours {
					hh.CPU = append(hh.CPU, trends.Point{T: r.Hour, Avg: r.CPUAvg, Max: r.CPUMax})
					hh.Mem = append(hh.Mem, trends.Point{T: r.Hour, Avg: r.MemAvg, Max: r.MemMax})
					hh.Net = append(hh.Net, trends.Point{T: r.Hour, Avg: r.NetMax, Max: r.NetMax})
				}
				out = append(out, hh)
			}
			return out
		},
		Limit: func(subject, metric string) float64 {
			switch metric {
			case "host.mem":
				return 100
			case "proc.rss", "orch.heap":
				return machineMem()
			}
			return 0
		},
	})
	go trendAnalyzer.Run(ctx, func(err error) { slog.Warn("trend analysis failed", "error", err) })
	// Einfrieren (Kap. 72.10): Quellen für die Momentaufnahme; die Automatik friert bei Absturz, Medien weg, Host verstummt und Failover ein
	// (abschaltbar mit OMP_AUTO_FREEZE=0).
	freezeStore := freeze.NewStore(database)
	freezer := freeze.New(freeze.Deps{
		Box:      flightBox,
		Timeline: func(since, until time.Time) (any, error) { return timelineSrc.Query(since, until, 2000, true) },
		Logs: func(since, until time.Time) (any, error) {
			return logStore.Query(logbus.Filter{Since: since, Until: until, Limit: 2000})
		},
		Nodes:     func() (any, error) { return store.List(), nil },
		Instances: func() (any, error) { return httpapi.InstancesWithMetrics(launcherSvc, hostMetricsTracker), nil },
		Graph:     func(ctx context.Context) (any, error) { return graphSvc.Graph(ctx), nil },
		Hosts: func() (any, error) {
			list, err := hostStore.ListHosts()
			if err != nil {
				return nil, err
			}
			out := make([]map[string]any, 0, len(list))
			for _, h := range list {
				row := map[string]any{"id": h.ID, "label": h.Label, "hostname": h.Hostname}
				if m, ok := hostMetricsTracker.Get(h.ID); ok {
					row["metrics"] = m
				}
				out = append(out, row)
			}
			return out, nil
		},
		HostSeries: func(window time.Duration) (any, error) {
			list, err := hostStore.ListHosts()
			if err != nil {
				return nil, err
			}
			out := map[string]any{}
			for _, h := range list {
				if w, ok := hostHistory.Window(h.ID, window); ok {
					out[h.Label+" ("+h.ID[:min(8, len(h.ID))]+")"] = w
				}
			}
			return out, nil
		},
		Pipelines: func(ctx context.Context, scope []string, max int) (map[string][]byte, error) {
			want := map[string]bool{}
			for _, id := range scope {
				want[id] = true
			}
			// Parallel und mit kurzem Zeitlimit: ein hängender Node darf die Momentaufnahme nicht um Sekunden verzögern.
			var picked []registry.NodeView
			for _, n := range store.List() {
				if len(picked) >= max {
					break
				}
				if n.Online && n.APIBaseURL != "" && (len(want) == 0 || want[n.ID]) {
					picked = append(picked, n)
				}
			}
			out := map[string][]byte{}
			var mu sync.Mutex
			var wg sync.WaitGroup
			for _, n := range picked {
				wg.Add(1)
				go func(n registry.NodeView) {
					defer wg.Done()
					pctx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
					defer cancel()
					req, err := http.NewRequestWithContext(pctx, http.MethodGet, n.APIBaseURL+"/diag/pipelines", nil)
					if err != nil {
						return
					}
					resp, err := nodeHTTPClient.Do(req)
					if err != nil {
						return
					}
					defer resp.Body.Close()
					if resp.StatusCode != http.StatusOK {
						return
					}
					if body, rerr := io.ReadAll(io.LimitReader(resp.Body, 1<<20)); rerr == nil {
						mu.Lock()
						out[freezeFileName(n.Label, n.ID)] = body
						mu.Unlock()
					}
				}(n)
			}
			wg.Wait()
			return out, nil
		},
	}, freezeStore)
	freezer.AutoEnabled = os.Getenv("OMP_AUTO_FREEZE") != "0"
	// Prozesswerte (CPU, Speicher je Instanz) alle 5 s in den Flugschreiber.
	ticks := 0
	go func() {
		tick := time.NewTicker(blackbox.Interval)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-tick.C:
				ticks++
				for _, in := range httpapi.InstancesWithMetrics(launcherSvc, hostMetricsTracker) {
					flightBox.RecordProc(in.ID, in.Label, in.CPUPercent, in.RSSBytes, now)
					// Stundenverlauf für Baseline und Trends: nach Typ und Name, damit er einen Neustart der Instanz überlebt.
					subject := "instance:" + in.Type + ":" + in.Label
					if in.CPUPercent != nil {
						trendCol.Observe(subject, in.Label, "proc.cpu", *in.CPUPercent, now)
					}
					if in.RSSBytes != nil {
						trendCol.Observe(subject, in.Label, "proc.rss", float64(*in.RSSBytes), now)
					}
					// Offene Dateien und Threads nur für Prozesse auf diesem Rechner, einmal pro Minute (Lecks zeigen sich über Stunden).
					if ticks%12 == 0 && in.HostID == "" && in.PID > 0 && !in.Crashed {
						if p, err := support.ReadProcess(in.PID); err == nil {
							trendCol.Observe(subject, in.Label, "proc.fds", float64(p.OpenFDs), now)
							trendCol.Observe(subject, in.Label, "proc.threads", float64(p.Threads), now)
						}
					}
				}
			}
		}
	}()
	// Der Orchestrator selbst: Speicher, Goroutinen, offene Dateien alle 30 s (ein Leck im Orchestrator zeigt sich genauso).
	go func() {
		tick := time.NewTicker(30 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-tick.C:
				var ms runtime.MemStats
				runtime.ReadMemStats(&ms)
				trendCol.Observe("orchestrator", "Orchestrator", "orch.heap", float64(ms.HeapAlloc), now)
				trendCol.Observe("orchestrator", "Orchestrator", "orch.goroutines", float64(runtime.NumGoroutine()), now)
				if p, err := support.ReadProcess(os.Getpid()); err == nil {
					trendCol.Observe("orchestrator", "Orchestrator", "orch.fds", float64(p.OpenFDs), now)
				}
			}
		}
	}()
	timelineSink := func(e timeline.Event) {
		if err := timelineStore.Insert(e); err != nil {
			slog.Warn("timeline insert failed", "kind", e.Kind, "error", err)
			return
		}
		hub.Broadcast(sse.Event{Type: "timeline.appended", Data: json.RawMessage("null")})
		label, _ := e.Data["label"].(string)
		freezer.Observe(e.Kind, label)
	}
	trendAnalyzer.OnNew = func(f trends.Finding) {
		timelineSink(timeline.Event{At: time.Now(), Kind: "trend", Severity: timeline.SevWarn, Subject: f.Subject,
			Data: map[string]any{"label": f.Label, "metric": f.Metric, "kind": f.Kind, "unit": f.Unit, "value": f.Value, "baseline": f.Baseline,
				"hours": f.Hours, "hoursToLimit": f.HoursToLimit}})
	}
	freezer.OnFrozen = func(m freeze.Meta) {
		timelineSink(timeline.Event{At: m.CreatedAt, Kind: "freeze", Severity: timeline.SevInfo, Subject: m.ID, Actor: m.CreatedBy,
			Data: map[string]any{"trigger": m.Trigger, "reason": m.Reason, "note": m.Note, "minutes": m.WindowMinutes}})
		hub.Broadcast(sse.Event{Type: "freeze.created", Data: json.RawMessage("null")})
	}
	timelineSink(timeline.Event{At: time.Now(), Kind: "orchestrator.started", Severity: timeline.SevInfo, Subject: cfg.ClusterNodeID, Data: map[string]any{"version": version.Version}})
	go timelineRec.Run(ctx, hub, timelineSink)
	go timelineStore.RunRetention(ctx, cfg.AuditRetentionDays)
	handler := httpapi.NewHandler(cfg, store, hub, graphSvc, layoutStore, snapshotSvc, launcherSvc, consoleResolver, nodeHTTPClient, authSvc, authzStore, audit.NewAsyncLogger(auditStore, 16384), auditStore, hostStore, hostMetricsTracker, hostHistory, workflowSvc, placementEngine, profileStore, placementThresholds, nodeSettingsStore, backupSvc, supervisorClient, clusterNode, ioPortStore, logStore, logPublisher, processStore, processEngine, assetStore, httpapi.WithAlarmAckStore(alarmacks.NewStore(database)), httpapi.WithScriptCommands(scriptCommandNames), httpapi.WithFFmpegTools(ffmpegToolsStore), httpapi.WithDomainAudit(domainAuditStore, domainAuditStore), httpapi.WithAssetLinks(assetLinkStore), httpapi.WithStorageBackends(storageBackendSvc), httpapi.WithOrganizations(orgStore), httpapi.WithGroups(groupStore), httpapi.WithSourceTags(sourcetags.NewStore(database)), httpapi.WithWorkflowRuns(workflowRunStore), httpapi.WithUpdates(updateSvc, supervisorClient, backupSvc), httpapi.WithUpdateDistributor(updateDist), httpapi.WithNodeVersions(nodeVersionStore), httpapi.WithSettings(nodeOptionStore, systemSettingsStore, startupSkipped), httpapi.WithLocations(locations.NewStore(database)), httpapi.WithMaintenance(maintenanceMgr), httpapi.WithProfile(profileName, profileFindings), httpapi.WithMediaKPI(kpiTracker), httpapi.WithHostSysinfo(launcherSvc.SysinfoOnHost), httpapi.WithTimeline(timelineSrc), httpapi.WithFreeze(freezer, freezeStore), httpapi.WithTrends(trendAnalyzer), httpapi.WithSupportAccess(supportaccess.NewStore(database)), httpapi.OptionalUIIsolation(uiIso), httpapi.WithHostKeyRotation(func(id string) error {
		sg := hostSigner.Load()
		if sg == nil {
			return errors.New("no command channel")
		}
		return sg.Rotate(id, 5*time.Second)
	}), httpapi.WithModules(modules, moduleDeps))

	startModules(ctx, modules, moduleDeps, clusterNode)

	startPprof()
	slog.Info("starting orchestrator",
		"listen", cfg.Listen,
		"registry_url", cfg.RegistryURL,
		"nats_url", cfg.NatsURL,
		"ui_dir", cfg.UIDir,
	)

	if uiIso != nil {
		tokens, _ := os.ReadFile(filepath.Join(cfg.UIDir, "design-tokens.css"))
		kit, _ := os.ReadFile(filepath.Join(cfg.UIDir, "dist", "node-ui-kit.js"))
		uiSrv := &http.Server{Addr: cfg.UIOriginListen, Handler: httpapi.LimitRequests(uiMgr.Handler(uiorigin.Config{
			Main: handler, ExtraPaths: cfg.UIIsolationExtra, HostJS: []byte(uiorigin.HostJS), DesignTokens: tokens, KitJS: kit,
		}))}
		httpapi.ConfigureServer(uiSrv)
		go func() {
			if err := uiSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				slog.Error("zweiter Ursprung für Node-Oberflächen gestoppt", "error", err)
			}
		}()
		slog.Info("Node-Oberflächen isoliert (zweiter Ursprung)", "listen", cfg.UIOriginListen, "types", cfg.UIIsolationTypes, "extraPaths", cfg.UIIsolationExtra)
	}
	srv := &http.Server{Addr: cfg.Listen, Handler: httpapi.LimitRequests(handler)}
	httpapi.ConfigureServer(srv)
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

// maintenanceInstances liefert dem Wartungsmodus die auf einem Host laufenden Instanzen.
type maintenanceInstances struct{ l *launcher.Launcher }

func (m maintenanceInstances) ListOnHost(hostID string) []maintenance.Item {
	var out []maintenance.Item
	bound := map[string]bool{}
	for _, e := range m.l.Catalog() {
		if e.HostBound {
			bound[e.Type] = true
		}
	}
	for _, inst := range m.l.List() {
		if inst.HostID == hostID {
			reason := maintenance.ReasonStandalone
			if bound[inst.Type] {
				reason = maintenance.ReasonHostBound
			}
			out = append(out, maintenance.Item{Kind: "instance", InstanceID: inst.ID, Label: inst.Label, Reason: reason})
		}
	}
	return out
}

// getEnvIntMain liest eine ganze Zahl aus der Umgebung (Standard bei fehlender/ungültiger Angabe).
func getEnvIntMain(name string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(name)); err == nil && v > 0 {
		return v
	}
	return def
}

// freezeFileName: Dateiname einer Pipeline-Momentaufnahme („Kamera-1-1a2b3c4d.json“).
func freezeFileName(label, id string) string {
	var b strings.Builder
	for _, r := range label {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' {
			b.WriteRune(r)
		} else if r == ' ' {
			b.WriteRune('-')
		}
	}
	if b.Len() == 0 {
		b.WriteString("node")
	}
	return b.String() + "-" + id[:min(8, len(id))] + ".json"
}
