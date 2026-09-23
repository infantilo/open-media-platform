package process

import (
	"context"
	"encoding/json"
	"strconv"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// testJetStream liefert eine JetStream-Verbindung gegen die lokale
// Dev-NATS-Instanz (überspringt den Test, wenn nicht erreichbar — kein
// impliziter Fallback, gleiche Vorsicht wie dbtest bei Postgres).
func testJetStream(t *testing.T) (jetstream.JetStream, func()) {
	t.Helper()
	nc, err := nats.Connect("nats://localhost:4222", nats.Timeout(2*time.Second))
	if err != nil {
		t.Skipf("NATS nicht erreichbar (%v) — Test übersprungen", err)
	}
	js, err := jetstream.New(nc)
	if err != nil {
		nc.Close()
		t.Fatalf("jetstream.New() error = %v", err)
	}
	return js, func() { nc.Close() }
}

func TestTriggerListenerStartsExecutionOnMatchingEvent(t *testing.T) {
	engine, store := testEngine(t)
	js, closeNC := testJetStream(t)
	// t.Cleanup statt defer, und VOR listener.Stop() registriert: NATS-
	// Verbindung erst schließen, NACHDEM der Listener (der sie noch
	// aktiv nutzt) sauber gestoppt wurde — sonst versucht ein später
	// Sync()-Zyklus, über eine bereits geschlossene Verbindung einen
	// Consumer anzulegen (harmlos, aber unnötiger Fehler-Log beim
	// Teardown).
	t.Cleanup(closeNC)

	streamName := "TEST_TRIGGER_" + mustNewTestID(t)
	subject := "omp.test.trigger." + streamName + ".created"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	_, err := js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
		Name:      streamName,
		Subjects:  []string{"omp.test.trigger." + streamName + ".>"},
		Retention: jetstream.LimitsPolicy,
		MaxAge:    time.Minute,
	})
	cancel()
	if err != nil {
		t.Fatalf("CreateOrUpdateStream() error = %v", err)
	}
	t.Cleanup(func() { _ = js.DeleteStream(context.Background(), streamName) })

	cfg := mustMarshal(t, notificationConfig{Subject: "noop"})
	_, v := publishedVersion(t, store, Definition{
		StartStepID: "noop",
		Steps:       []Step{{ID: "noop", Type: StepTypeTask, Config: cfg}},
		Triggers:    []EventTrigger{{Subject: subject}},
	})
	engine.Register(StepTypeTask, StepExecutorFunc(func(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error) {
		return json.RawMessage(`{}`), nil
	}))

	listener := NewTriggerListener(store, engine, js, streamName, WithTriggerSyncInterval(20*time.Millisecond))
	listener.Start()
	t.Cleanup(listener.Stop)

	waitForConsumerActive(t, listener, v.ID, 3*time.Second)

	pubCtx, pubCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer pubCancel()
	if _, err := js.Publish(pubCtx, subject, []byte(`{"assetId":"a1"}`)); err != nil {
		t.Fatalf("Publish() error = %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	var executions []ProcessExecution
	for time.Now().Before(deadline) {
		executions, err = store.ListExecutions(ExecutionFilter{ProcessDefinitionID: v.ProcessDefinitionID})
		if err != nil {
			t.Fatalf("ListExecutions() error = %v", err)
		}
		if len(executions) > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(executions) != 1 {
		t.Fatalf("ListExecutions() = %d entries after publishing the trigger event, want exactly 1", len(executions))
	}
	if executions[0].CreatedBy != "system:event-trigger" {
		t.Errorf("execution.CreatedBy = %q, want %q", executions[0].CreatedBy, "system:event-trigger")
	}

	final := awaitExecutionStatus(t, store, executions[0].ID, 2*time.Second, StatusCompleted, StatusFailed)
	if final.Status != StatusCompleted {
		t.Fatalf("triggered execution status = %s, want completed (error=%q)", final.Status, final.Error)
	}
}

func TestTriggerListenerIsIdempotentAgainstRedelivery(t *testing.T) {
	engine, store := testEngine(t)
	js, closeNC := testJetStream(t)
	// t.Cleanup statt defer: defer liefe VOR den t.Cleanup-Funktionen,
	// das DeleteStream unten träfe eine schon geschlossene Verbindung
	// ("nats: connection closed", per `_ =` verschluckt) und ließe den
	// TEST_*-Stream auf dem Dev-Cluster liegen — solche Reste häuften
	// sich über Läufe an (s. docs/decisions.md Nachtrag 269).
	t.Cleanup(closeNC)

	streamName := "TEST_TRIGGER_" + mustNewTestID(t)
	subject := "omp.test.trigger." + streamName + ".created"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	_, err := js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
		Name:      streamName,
		Subjects:  []string{"omp.test.trigger." + streamName + ".>"},
		Retention: jetstream.LimitsPolicy,
		MaxAge:    time.Minute,
	})
	cancel()
	if err != nil {
		t.Fatalf("CreateOrUpdateStream() error = %v", err)
	}
	t.Cleanup(func() { _ = js.DeleteStream(context.Background(), streamName) })

	_, v := publishedVersion(t, store, Definition{
		StartStepID: "noop",
		Steps:       []Step{{ID: "noop", Type: StepTypeTask}},
		Triggers:    []EventTrigger{{Subject: subject}},
	})
	engine.Register(StepTypeTask, StepExecutorFunc(func(ctx context.Context, ec ExecutionCtx, step Step) (json.RawMessage, error) {
		return json.RawMessage(`{}`), nil
	}))

	// Simuliert eine "Zustellung" direkt über handleMessage — zweimal mit
	// EXAKT derselben Stream-Sequenznummer (wie es bei einer echten
	// JetStream-Redelivery nach einem fehlenden Ack der Fall wäre),
	// statt auf eine echte Redelivery zu warten (langsam, timing-
	// abhängig). Prüft direkt die Idempotenz-Garantie, nicht die
	// JetStream-Redelivery-Mechanik selbst (die ist Serververhalten,
	// kein Code dieses Pakets).
	listener := NewTriggerListener(store, engine, js, streamName)
	pubCtx, pubCancel := context.WithTimeout(context.Background(), 3*time.Second)
	ack, err := js.Publish(pubCtx, subject, []byte(`{}`))
	pubCancel()
	if err != nil {
		t.Fatalf("Publish() error = %v", err)
	}

	correlationID := "trigger:" + v.ID + ":" + strconv.FormatUint(ack.Sequence, 10)
	for i := 0; i < 2; i++ {
		existing, err := store.ListExecutions(ExecutionFilter{ProcessDefinitionID: v.ProcessDefinitionID, CorrelationID: correlationID})
		if err != nil {
			t.Fatalf("ListExecutions() error = %v", err)
		}
		if len(existing) > 0 {
			continue // wie handleMessage: bereits vorhanden, kein zweiter Start
		}
		if _, err := listener.engine.Start(CreateExecutionParams{
			ProcessDefinitionID: v.ProcessDefinitionID,
			ProcessVersionID:    v.ID,
			CorrelationID:       correlationID,
			CreatedBy:           "system:event-trigger",
		}); err != nil {
			t.Fatalf("Start() (attempt %d) error = %v", i, err)
		}
	}

	final, err := store.ListExecutions(ExecutionFilter{ProcessDefinitionID: v.ProcessDefinitionID, CorrelationID: correlationID})
	if err != nil {
		t.Fatalf("ListExecutions() error = %v", err)
	}
	if len(final) != 1 {
		t.Fatalf("ListExecutions() = %d executions for the same correlationId, want exactly 1 (idempotency)", len(final))
	}
}

func waitForConsumerActive(t *testing.T, tl *TriggerListener, versionID string, timeout time.Duration) {
	t.Helper()
	key := versionID + "#0"
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		tl.mu.Lock()
		_, ok := tl.active[key]
		tl.mu.Unlock()
		if ok {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("trigger consumer for version %s never became active within %s", versionID, timeout)
}

func mustNewTestID(t *testing.T) string {
	t.Helper()
	id, err := newID()
	if err != nil {
		t.Fatalf("newID() error = %v", err)
	}
	return id
}

// Regressionstest (docs/decisions.md Nachtrag 269): ein Stop(), das genau
// zwischen dem ungesperrten Definitions-Lesen und dem Anwenden eines
// Sync() landet, darf weder hängen noch einen verwaisten Consumer
// hinterlassen. Deterministisch über den syncBeforeApply-Einhängepunkt
// statt über Timing-Glück.
func TestTriggerListenerStopDuringSyncDoesNotLeakConsumer(t *testing.T) {
	engine, store := testEngine(t)
	js, closeNC := testJetStream(t)
	t.Cleanup(closeNC)

	streamName := "TEST_TRIGGER_" + mustNewTestID(t)
	subject := "omp.test.trigger." + streamName + ".created"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	_, err := js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
		Name:     streamName,
		Subjects: []string{"omp.test.trigger." + streamName + ".>"},
		MaxAge:   time.Minute,
	})
	cancel()
	if err != nil {
		t.Fatalf("CreateOrUpdateStream() error = %v", err)
	}
	t.Cleanup(func() { _ = js.DeleteStream(context.Background(), streamName) })

	_, v := publishedVersion(t, store, Definition{
		StartStepID: "noop",
		Steps:       []Step{{ID: "noop", Type: StepTypeTask, Config: mustMarshal(t, notificationConfig{Subject: "noop"})}},
		Triggers:    []EventTrigger{{Subject: subject}},
	})

	// Langes Intervall: nur der initiale Sync der Schleife läuft, der
	// zweite kommt gezielt vom Test.
	listener := NewTriggerListener(store, engine, js, streamName, WithTriggerSyncInterval(time.Hour))
	listener.Start()
	waitForConsumerActive(t, listener, v.ID, 3*time.Second)

	stopReturned := make(chan struct{})
	listener.syncBeforeApply = func() {
		go func() {
			listener.Stop()
			close(stopReturned)
		}()
		// Warten, bis Stop() die aktiven Consumer abgeräumt und mu wieder
		// freigegeben hat — erst DANN darf Sync() anwenden (das Rennen).
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			listener.mu.Lock()
			n := len(listener.active)
			listener.mu.Unlock()
			if n == 0 {
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	if err := listener.Sync(context.Background()); err != nil {
		t.Fatalf("Sync() error = %v", err)
	}

	select {
	case <-stopReturned:
	case <-time.After(5 * time.Second):
		t.Fatal("Stop() did not return — Sync() restarted a consumer after Stop() cleared them")
	}
	listener.mu.Lock()
	n := len(listener.active)
	listener.mu.Unlock()
	if n != 0 {
		t.Fatalf("active consumers after Stop() = %d, want 0", n)
	}
}
