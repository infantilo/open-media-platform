package launcher

import (
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"
)

// scriptedRequester antwortet je Aktion ("start"/"stop") mit einem einstellbaren Ergebnis und zählt die Kommandos.
type scriptedRequester struct {
	mu      sync.Mutex
	stopErr error
	stops   int
	starts  int
}

func (r *scriptedRequester) RequestBytes(subject string, data []byte, timeout time.Duration) ([]byte, error) {
	var cmd remoteCommand
	_ = json.Unmarshal(data, &cmd)
	r.mu.Lock()
	defer r.mu.Unlock()
	if cmd.Action == "stop" {
		r.stops++
		if r.stopErr != nil {
			return nil, r.stopErr
		}
		return json.Marshal(remoteResponse{OK: true})
	}
	r.starts++
	return json.Marshal(remoteResponse{OK: true, PID: 4000 + r.starts})
}

func (r *scriptedRequester) setStopErr(err error) {
	r.mu.Lock()
	r.stopErr = err
	r.mu.Unlock()
}

func (r *scriptedRequester) counts() (starts, stops int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.starts, r.stops
}

// TestStopRemoteUnreachableKeepsInstanceAsStopPending — antwortet der Host nicht, darf die Instanz nicht vergessen
// werden (sie liefe nach einer Netztrennung unbemerkt weiter). Sie bleibt als "Stop vorgemerkt" geführt, wird nicht
// neu gestartet und verschwindet, sobald der Host den Stop bestätigt.
func TestStopRemoteUnreachableKeepsInstanceAsStopPending(t *testing.T) {
	nc := &scriptedRequester{}
	store := newFakeInstanceStore()
	l := newWithStore(nil, "http://registry", "nats://nats", store, nil, nc, nil)
	inst, err := l.Start("omp-source", "", "host-1", nil)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	nc.setStopErr(errors.New("nats: no responders"))
	if err := l.Stop(inst.ID); !errors.Is(err, ErrStopDeferred) {
		t.Fatalf("Stop() error = %v, want ErrStopDeferred", err)
	}
	got, ok := l.Get(inst.ID)
	if !ok || !got.StopPending {
		t.Fatalf("instance after failed remote stop = %+v (found=%v), want kept as stop-pending", got, ok)
	}
	if row, ok := store.data[inst.ID]; !ok || !row.StopPending {
		t.Fatalf("stop-pending mark not persisted: %+v (found=%v)", row, ok)
	}

	// Weder ein Exit-Ereignis noch der Abgleich mit dem Agent startet sie neu.
	startsBefore, _ := nc.counts()
	payload, _ := json.Marshal(remoteExitEvent{InstanceID: inst.ID, ExitCode: 1})
	l.HandleRemoteExit("host-1", payload)
	for i := 0; i < remoteMissingThreshold+1; i++ {
		if lost := l.ReconcileRemote("host-1", []string{}); len(lost) != 0 {
			t.Fatalf("stop-pending instance was scheduled for a restart: %v", lost)
		}
	}
	if starts, _ := nc.counts(); starts != startsBefore {
		t.Fatalf("stop-pending instance was restarted (%d start commands, want %d)", starts, startsBefore)
	}

	// Ein neuer Orchestrator-Prozess stellt sie nicht wieder her, sondern führt die Vormerkung weiter.
	l2 := newWithStore(nil, "http://registry", "nats://nats", store, nil, nc, nil)
	l2.RestoreLocal()
	l2.RestoreRemote()
	time.Sleep(50 * time.Millisecond)
	if starts, _ := nc.counts(); starts != startsBefore {
		t.Fatalf("stop-pending instance was restored after a restart")
	}

	// Host wieder erreichbar: Stop wird nachgeholt, die Instanz verschwindet.
	nc.setStopErr(nil)
	if ids := l2.RetryPendingStops("host-1"); len(ids) != 1 || ids[0] != inst.ID {
		t.Fatalf("RetryPendingStops = %v, want [%s]", ids, inst.ID)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, ok := l2.Get(inst.ID); !ok {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, ok := l2.Get(inst.ID); ok {
		t.Fatalf("instance still tracked after the deferred stop succeeded")
	}
	store.mu.Lock()
	_, rowLeft := store.data[inst.ID]
	store.mu.Unlock()
	if rowLeft {
		t.Fatalf("row still persisted after the deferred stop succeeded")
	}
}

// TestSyncRemoteFromStoreSharesStateBetweenClusterMembers — zwei Orchestratoren teilen die Instanz-Tabelle. Was das
// eine Mitglied startet, muss das andere kennen (Exit-Ereignis nach Führungswechsel, Stop); was eines stoppt, muss
// beim anderen verschwinden.
func TestSyncRemoteFromStoreSharesStateBetweenClusterMembers(t *testing.T) {
	backoff := crashRestartBackoff
	crashRestartBackoff = 10 * time.Millisecond
	t.Cleanup(func() { crashRestartBackoff = backoff })

	nc := &scriptedRequester{}
	store := newFakeInstanceStore()
	a := newWithStore(nil, "http://registry", "nats://nats", store, nil, nc, nil)
	b := newWithStore(nil, "http://registry", "nats://nats", store, nil, nc, nil)

	x, err := a.Start("omp-source", "", "host-1", nil)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	y, _ := a.Start("omp-source", "", "host-1", nil)
	z, _ := a.Start("omp-source", "", "host-1", nil)

	// Exit-Ereignis beim neuen Leader b, der x nie gesehen hat: wird nachgeladen und neu gestartet.
	payload, _ := json.Marshal(remoteExitEvent{InstanceID: x.ID, ExitCode: 1})
	b.HandleRemoteExit("host-1", payload)
	if in, ok := b.Get(x.ID); !ok || in.RestartCount != 1 {
		t.Fatalf("exit event for an instance started by another member = %+v (found=%v), want restarted", in, ok)
	}

	// Stop über b für eine Instanz, die a gestartet hat.
	if err := b.Stop(y.ID); err != nil {
		t.Fatalf("Stop() via another member error = %v", err)
	}

	b.SyncRemoteFromStore()
	if _, ok := b.Get(z.ID); !ok {
		t.Fatalf("instance started by another member not visible after sync")
	}
	a.SyncRemoteFromStore()
	if _, ok := a.Get(y.ID); ok {
		t.Fatalf("instance stopped by another member still tracked after sync")
	}
	if in, _ := a.Get(x.ID); in.RestartCount != 1 {
		t.Fatalf("restart done by another member not visible after sync: %+v", in)
	}
}

// TestSyncRemoteFromStoreKeepsInstanceWhosePersistFailed — scheiterte das Speichern beim Start, steht die laufende
// Instanz nicht in der Tabelle. Der Abgleich darf sie deshalb nicht vergessen, sondern trägt sie nach.
func TestSyncRemoteFromStoreKeepsInstanceWhosePersistFailed(t *testing.T) {
	nc := &scriptedRequester{}
	store := &flakyPutStore{fakeInstanceStore: newFakeInstanceStore(), failPut: true}
	l := newWithStore(nil, "http://registry", "nats://nats", store, nil, nc, nil)
	inst, _ := l.Start("omp-source", "", "host-1", nil) // Speichern scheitert
	store.failPut = false

	l.SyncRemoteFromStore()
	if _, ok := l.Get(inst.ID); !ok {
		t.Fatalf("running instance forgotten because its row was missing")
	}
	store.mu.Lock()
	_, ok := store.data[inst.ID]
	store.mu.Unlock()
	if !ok {
		t.Fatalf("missing row was not written again")
	}
}

// flakyPutStore lässt Put scheitern, solange failPut gesetzt ist (Datenbank kurz nicht erreichbar).
type flakyPutStore struct {
	*fakeInstanceStore
	failPut bool
}

func (s *flakyPutStore) Put(inst Instance) error {
	if s.failPut {
		return errors.New("db unavailable")
	}
	return s.fakeInstanceStore.Put(inst)
}
