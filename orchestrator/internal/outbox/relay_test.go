package outbox

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
)

// testJetStream liefert eine JetStream-Verbindung gegen die lokale
// Dev-NATS-Instanz (dieselbe Default-DSN wie orchestrator/internal/
// config.defaultNatsURL, seit D14 mit `-js` betrieben) — überspringt den
// Test, wenn NATS nicht erreichbar ist (kein impliziter Fallback auf
// irgendeine andere Instanz, gleiche Vorsicht wie dbtest bei Postgres).
// Ein pro Testlauf eindeutiger Stream-Name (aus dem Testnamen abgeleitet)
// hält Tests voneinander isoliert, ohne die "_test"-Datenbank-Konvention
// (dbtest) für NATS nachbauen zu müssen — JetStream-Streams sind bereits
// von Natur aus benannt/isoliert.
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

func uniqueStreamName(t *testing.T) string {
	t.Helper()
	id, err := newID()
	if err != nil {
		t.Fatalf("newID() error = %v", err)
	}
	return "TEST_OUTBOX_" + id
}

func TestRelayPublishesAndMarksDispatched(t *testing.T) {
	js, closeNC := testJetStream(t)
	defer closeNC()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	streamName := uniqueStreamName(t)
	subject := "omp.test." + streamName + ".created"
	_, err := EnsureStream(ctx, js, jetstream.StreamConfig{
		Name:      streamName,
		Subjects:  []string{"omp.test." + streamName + ".>"},
		Retention: jetstream.LimitsPolicy,
		MaxAge:    time.Minute,
	})
	if err != nil {
		t.Fatalf("EnsureStream() error = %v", err)
	}
	t.Cleanup(func() { _ = js.DeleteStream(context.Background(), streamName) })

	db := testDB(t)
	store := NewStore(db)
	if _, err := store.EnqueueDB(subject, json.RawMessage(`{"assetId":"a1"}`), "dedup-"+streamName); err != nil {
		t.Fatalf("EnqueueDB() error = %v", err)
	}

	relay := NewRelay(store, js, WithRelayPollInterval(10*time.Millisecond))
	n, err := relay.dispatchBatch(ctx)
	if err != nil {
		t.Fatalf("dispatchBatch() error = %v", err)
	}
	if n != 1 {
		t.Fatalf("dispatchBatch() dispatched = %d, want 1", n)
	}

	undispatched, err := store.Undispatched(10)
	if err != nil {
		t.Fatalf("Undispatched() error = %v", err)
	}
	if len(undispatched) != 0 {
		t.Fatalf("Undispatched() = %+v, want none (already relayed)", undispatched)
	}

	// Über einen echten JetStream-Consumer bestätigen, dass die
	// Nachricht tatsächlich im Stream angekommen ist — nicht nur, dass
	// MarkDispatched() lokal aufgerufen wurde.
	cons, err := js.CreateOrUpdateConsumer(ctx, streamName, jetstream.ConsumerConfig{
		AckPolicy: jetstream.AckExplicitPolicy,
	})
	if err != nil {
		t.Fatalf("CreateOrUpdateConsumer() error = %v", err)
	}
	msgs, err := cons.Fetch(1, jetstream.FetchMaxWait(3*time.Second))
	if err != nil {
		t.Fatalf("Fetch() error = %v", err)
	}
	var got *jetstream.Msg
	for m := range msgs.Messages() {
		got = &m
		_ = m.Ack()
	}
	if got == nil {
		t.Fatalf("no message arrived in the JetStream consumer within the fetch window")
	}
	if (*got).Subject() != subject {
		t.Errorf("delivered subject = %q, want %q", (*got).Subject(), subject)
	}
}

func TestRelayIsResilientToUnreachableJetStreamThenRecovers(t *testing.T) {
	// Ein einzelnes fehlgeschlagenes Publish (hier simuliert über einen
	// Stream, dessen Subject NICHT dem veröffentlichten Subject
	// entspricht — JetStream lehnt das Publish dann mit "no responders"/
	// "stream not found" ab, je nach Serverversion) darf den Event-Datensatz
	// NICHT als dispatched markieren — er muss beim nächsten Zyklus
	// erneut versucht werden (kein stiller Datenverlust).
	js, closeNC := testJetStream(t)
	defer closeNC()
	// Kurzes Timeout bewusst: ein Publish ohne registrierten Stream für
	// das Subject blockiert bis zum Kontext-Timeout (kein sofortiger
	// "stream not found"-Fehler bei diesem JetStream-Server) — 2s reichen
	// für den Nachweis "schlägt fehl, markiert aber nicht als dispatched",
	// ohne den Testlauf unnötig zu verlangsamen.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	db := testDB(t)
	store := NewStore(db)
	subject := "omp.test.no-such-stream-subject." + uniqueStreamName(t)
	if _, err := store.EnqueueDB(subject, json.RawMessage(`{}`), ""); err != nil {
		t.Fatalf("EnqueueDB() error = %v", err)
	}

	relay := NewRelay(store, js)
	n, err := relay.dispatchBatch(ctx)
	// Kein registrierter Stream für dieses Subject -> Publish schlägt
	// fehl (kein Fataler Fehler für dispatchBatch selbst, s.
	// relay.go-Doku) -> 0 tatsächlich versendet.
	if err != nil {
		t.Fatalf("dispatchBatch() error = %v, want nil (per-event failures are logged, not fatal)", err)
	}
	if n != 0 {
		t.Fatalf("dispatchBatch() dispatched = %d, want 0 (no stream registered for this subject)", n)
	}

	undispatched, err := store.Undispatched(10)
	if err != nil {
		t.Fatalf("Undispatched() error = %v", err)
	}
	if len(undispatched) != 1 {
		t.Fatalf("Undispatched() = %+v, want the event to remain unversendet for a future retry", undispatched)
	}
}

func TestRelayStartStop(t *testing.T) {
	js, closeNC := testJetStream(t)
	defer closeNC()

	streamName := uniqueStreamName(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	_, err := EnsureStream(ctx, js, jetstream.StreamConfig{
		Name:      streamName,
		Subjects:  []string{"omp.test." + streamName + ".>"},
		Retention: jetstream.LimitsPolicy,
		MaxAge:    time.Minute,
	})
	cancel()
	if err != nil {
		t.Fatalf("EnsureStream() error = %v", err)
	}
	t.Cleanup(func() { _ = js.DeleteStream(context.Background(), streamName) })

	db := testDB(t)
	store := NewStore(db)
	relay := NewRelay(store, js, WithRelayPollInterval(10*time.Millisecond))
	relay.Start()

	subject := "omp.test." + streamName + ".x"
	if _, err := store.EnqueueDB(subject, json.RawMessage(`{}`), ""); err != nil {
		t.Fatalf("EnqueueDB() error = %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		undispatched, err := store.Undispatched(10)
		if err != nil {
			t.Fatalf("Undispatched() error = %v", err)
		}
		if len(undispatched) == 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	relay.Stop()

	undispatched, err := store.Undispatched(10)
	if err != nil {
		t.Fatalf("Undispatched() error = %v", err)
	}
	if len(undispatched) != 0 {
		t.Fatalf("Undispatched() after Start()/Stop() = %+v, want none (relay should have dispatched it)", undispatched)
	}
}
