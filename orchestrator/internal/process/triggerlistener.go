package process

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/nats-io/nats.go/jetstream"
)

// TriggerListener realisiert A8 "event -> workflow trigger": für jede
// VERÖFFENTLICHTE ProcessVersion mit Definition.Triggers hält es einen
// durablen JetStream-Consumer aufrecht und startet bei jeder passenden
// Nachricht eine neue ProcessExecution (Engine.Start). Die Gegenrichtung
// ("workflow -> event") ist bereits seit Phase 3 Teil 1 über
// Engine.publishExecutionEvent umgesetzt.
//
// Zuverlässigkeit: der Consumer ist DURABLE (überlebt einen Neustart,
// JetStream merkt sich den Zustellfortschritt serverseitig) und
// verwendet expliziten Ack — eine Nachricht gilt erst nach
// ERFOLGREICHEM Engine.Start() als verarbeitet; scheitert der Start,
// wird sie genakt und beim nächsten Zyklus erneut zugestellt.
// Idempotenz gegen Mehrfachzustellung (JetStream ist at-least-once,
// nie exactly-once): die CorrelationID der gestarteten Execution wird
// DETERMINISTISCH aus (ProcessVersion, Stream-Sequenznummer) abgeleitet
// — vor jedem Start prüft der Handler, ob dafür bereits eine Execution
// existiert (identisches Muster wie der Subworkflow-Executor in
// executors.go), sodass eine erneute Zustellung derselben Nachricht nie
// eine zweite Execution erzeugt.
//
// Bewusst NICHT Teil dieser Runde: StepTypeEventTrigger als Schritt
// INNERHALB eines bereits laufenden Graphen (ein Schritt, der mitten im
// Ablauf auf ein Ereignis wartet) — das hier Gebaute deckt nur die
// Definitions-Ebene ("dieses Ereignis STARTET einen neuen Lauf") ab,
// s. engine.go-Moduldoku.
type TriggerListener struct {
	store        *Store
	engine       *Engine
	js           jetstream.JetStream
	streamName   string
	syncInterval time.Duration

	mu       sync.Mutex
	cancel   context.CancelFunc
	done     chan struct{}
	active   map[string]context.CancelFunc // Schlüssel: ProcessVersionID + "#" + Trigger-Index
	activeWG sync.WaitGroup
}

// TriggerListenerOption konfiguriert einen neuen TriggerListener.
type TriggerListenerOption func(*TriggerListener)

// WithTriggerSyncInterval überschreibt das Standardintervall (30s), in
// dem nach neu veröffentlichten (oder deprecateten) Trigger-Definitionen
// gesucht wird — vor allem für Tests gedacht.
func WithTriggerSyncInterval(d time.Duration) TriggerListenerOption {
	return func(tl *TriggerListener) { tl.syncInterval = d }
}

// NewTriggerListener erstellt einen TriggerListener. streamName ist der
// JetStream-Stream, der die Trigger-Subjects erfasst (Topologie-
// Entscheidung des Aufrufers — main.go, Phase 5; ein einzelner
// gemeinsamer Stream über "omp.>" ist der einfachste Fall, s.
// outbox.EnsureStream).
func NewTriggerListener(store *Store, engine *Engine, js jetstream.JetStream, streamName string, opts ...TriggerListenerOption) *TriggerListener {
	tl := &TriggerListener{
		store:        store,
		engine:       engine,
		js:           js,
		streamName:   streamName,
		syncInterval: 30 * time.Second,
		active:       make(map[string]context.CancelFunc),
	}
	for _, opt := range opts {
		opt(tl)
	}
	return tl
}

// Start beginnt, periodisch nach Trigger-Definitionen zu suchen und für
// jede einen Consumer aufrechtzuerhalten — nicht blockierend. Stop()
// beendet alles sauber.
func (tl *TriggerListener) Start() {
	ctx, cancel := context.WithCancel(context.Background())
	tl.mu.Lock()
	tl.cancel = cancel
	tl.done = make(chan struct{})
	tl.mu.Unlock()

	go func() {
		defer close(tl.done)
		for {
			if err := tl.Sync(ctx); err != nil {
				slog.Error("process: trigger listener: sync failed", "error", err)
			}
			select {
			case <-time.After(tl.syncInterval):
			case <-ctx.Done():
				return
			}
		}
	}()
}

// Stop bricht alle aktiven Consumer ab und wartet, bis sie beendet sind.
func (tl *TriggerListener) Stop() {
	tl.mu.Lock()
	cancel := tl.cancel
	done := tl.done
	// Jeder aktive Consumer läuft mit einem EIGENEN, von Sync() erzeugten
	// Kontext (context.Background()-Kind, nicht vom Sync-Schleifen-
	// Kontext abgeleitet — damit Sync() einzelne Consumer gezielt
	// stoppen kann, ohne die ganze Schleife zu beenden). Stop() muss
	// diese deshalb explizit mit abbrechen, sonst blockiert
	// runConsumer() für immer auf <-ctx.Done() (echter, per Test
	// gefundener Deadlock einer früheren Fassung — der Testlauf hing
	// bis zum Timeout in genau diesem Stop()-Aufruf).
	for key, consumerCancel := range tl.active {
		consumerCancel()
		delete(tl.active, key)
	}
	tl.mu.Unlock()
	if cancel == nil {
		return
	}
	cancel()
	<-done
	tl.activeWG.Wait()
}

// Sync gleicht die aktiven Consumer mit den aktuell veröffentlichten
// Trigger-Definitionen ab — startet neue, stoppt welche, deren Version
// nicht mehr "published" ist (deprecated/archiviert). Öffentlich (nicht
// nur intern von Start() genutzt), damit ein Aufrufer auch außerhalb
// des Polling-Intervalls gezielt neu synchronisieren kann (z. B. direkt
// nach PublishVersion in einer künftigen API, Phase 5).
func (tl *TriggerListener) Sync(ctx context.Context) error {
	defs, err := tl.store.ListDefinitions()
	if err != nil {
		return fmt.Errorf("process: trigger listener: list definitions: %w", err)
	}

	wanted := make(map[string]struct {
		version ProcessVersion
		trigger EventTrigger
		index   int
	})
	for _, def := range defs {
		versions, err := tl.store.ListVersions(def.ID)
		if err != nil {
			slog.Error("process: trigger listener: list versions failed", "definition", def.ID, "error", err)
			continue
		}
		for _, v := range versions {
			if v.Status != VersionStatusPublished {
				continue
			}
			for i, trig := range v.Definition.Triggers {
				key := v.ID + "#" + fmt.Sprint(i)
				wanted[key] = struct {
					version ProcessVersion
					trigger EventTrigger
					index   int
				}{v, trig, i}
			}
		}
	}

	tl.mu.Lock()
	defer tl.mu.Unlock()

	for key, w := range wanted {
		if _, ok := tl.active[key]; ok {
			continue
		}
		consumerCtx, consumerCancel := context.WithCancel(context.Background())
		tl.active[key] = consumerCancel
		tl.activeWG.Add(1)
		go func(version ProcessVersion, trigger EventTrigger, index int) {
			defer tl.activeWG.Done()
			tl.runConsumer(consumerCtx, version, trigger, index)
		}(w.version, w.trigger, w.index)
	}

	for key, cancel := range tl.active {
		if _, ok := wanted[key]; !ok {
			cancel()
			delete(tl.active, key)
		}
	}

	return nil
}

// runConsumer richtet den durablen JetStream-Consumer für GENAU einen
// Trigger ein und verarbeitet Nachrichten, bis ctx endet.
func (tl *TriggerListener) runConsumer(ctx context.Context, version ProcessVersion, trigger EventTrigger, index int) {
	consumerName := fmt.Sprintf("trigger-%s-%d", version.ID, index)
	cons, err := tl.js.CreateOrUpdateConsumer(ctx, tl.streamName, jetstream.ConsumerConfig{
		Durable:       consumerName,
		FilterSubject: trigger.Subject,
		AckPolicy:     jetstream.AckExplicitPolicy,
	})
	if err != nil {
		slog.Error("process: trigger listener: create consumer failed", "version", version.ID, "subject", trigger.Subject, "error", err)
		return
	}

	consumeCtx, err := cons.Consume(func(msg jetstream.Msg) {
		tl.handleMessage(version, trigger, msg)
	})
	if err != nil {
		slog.Error("process: trigger listener: consume failed", "version", version.ID, "subject", trigger.Subject, "error", err)
		return
	}
	defer consumeCtx.Stop()

	<-ctx.Done()
}

// handleMessage verarbeitet EINE zugestellte Trigger-Nachricht —
// idempotent über eine deterministische CorrelationID (s. Moduldoku).
func (tl *TriggerListener) handleMessage(version ProcessVersion, trigger EventTrigger, msg jetstream.Msg) {
	meta, err := msg.Metadata()
	if err != nil {
		slog.Error("process: trigger listener: read message metadata failed", "version", version.ID, "error", err)
		_ = msg.Nak()
		return
	}
	correlationID := fmt.Sprintf("trigger:%s:%d", version.ID, meta.Sequence.Stream)

	existing, err := tl.store.ListExecutions(ExecutionFilter{
		ProcessDefinitionID: version.ProcessDefinitionID,
		CorrelationID:       correlationID,
	})
	if err != nil {
		slog.Error("process: trigger listener: check existing executions failed", "version", version.ID, "error", err)
		_ = msg.Nak()
		return
	}
	if len(existing) > 0 {
		// Bereits gestartet (frühere Zustellung derselben Nachricht) —
		// sicher zu bestätigen, kein zweiter Start.
		_ = msg.Ack()
		return
	}

	_, err = tl.engine.Start(CreateExecutionParams{
		ProcessDefinitionID: version.ProcessDefinitionID,
		ProcessVersionID:    version.ID,
		CorrelationID:       correlationID,
		CreatedBy:           "system:event-trigger",
		Input:               json.RawMessage(msg.Data()),
	})
	if err != nil {
		slog.Error("process: trigger listener: start execution failed, will retry", "version", version.ID, "subject", trigger.Subject, "error", err)
		_ = msg.Nak()
		return
	}
	_ = msg.Ack()
}
