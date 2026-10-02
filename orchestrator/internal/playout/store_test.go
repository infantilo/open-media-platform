package playout

import (
	"database/sql"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
)

func testStore(t *testing.T) (*Store, *sql.DB) {
	t.Helper()
	database := dbtest.Open(t)
	clean := func() {
		if _, err := database.Exec(`DELETE FROM playout_channels`); err != nil {
			t.Fatalf("cleanup: %v", err)
		}
	}
	clean()
	t.Cleanup(clean)
	return NewStore(database), database
}

func TestChannelCRUDAndValidation(t *testing.T) {
	s, _ := testStore(t)

	if _, err := s.CreateChannel(ChannelInput{Name: " "}, "u"); !errors.Is(err, ErrValidation) {
		t.Fatalf("empty name: err = %v, want ErrValidation", err)
	}
	if _, err := s.CreateChannel(ChannelInput{Name: "X", Timezone: "Mars/Olympus"}, "u"); !errors.Is(err, ErrValidation) {
		t.Fatalf("bad timezone: err = %v, want ErrValidation", err)
	}
	if _, err := s.CreateChannel(ChannelInput{Name: "X", Config: json.RawMessage(`{bad`)}, "u"); !errors.Is(err, ErrValidation) {
		t.Fatalf("bad config: err = %v, want ErrValidation", err)
	}

	c, err := s.CreateChannel(ChannelInput{Name: "National", Timezone: "Europe/Vienna", Group: "national", Instance: "inst-1"}, "alice")
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if c.ID == "" || c.Timezone != "Europe/Vienna" || string(c.Config) != `{}` {
		t.Fatalf("created = %+v", c)
	}
	if def, err := s.CreateChannel(ChannelInput{Name: "Default"}, "alice"); err != nil || def.Timezone != "UTC" {
		t.Fatalf("default timezone: %+v, %v", def, err)
	}

	// Name und Instanz sind eindeutig.
	if _, err := s.CreateChannel(ChannelInput{Name: "National"}, "u"); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate name: err = %v, want ErrConflict", err)
	}
	if _, err := s.CreateChannel(ChannelInput{Name: "Other", Instance: "inst-1"}, "u"); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate instance: err = %v, want ErrConflict", err)
	}

	byInst, err := s.ChannelByInstance("inst-1")
	if err != nil || byInst.ID != c.ID {
		t.Fatalf("ChannelByInstance = %+v, %v", byInst, err)
	}
	if _, err := s.ChannelByInstance(""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ChannelByInstance(\"\") err = %v, want ErrNotFound", err)
	}

	upd, err := s.UpdateChannel(c.ID, ChannelInput{Name: "National HD", Timezone: "UTC", Instance: ""})
	if err != nil || upd.Name != "National HD" || upd.Instance != "" {
		t.Fatalf("UpdateChannel = %+v, %v", upd, err)
	}
	list, err := s.ListChannels()
	if err != nil || len(list) != 2 {
		t.Fatalf("ListChannels = %d, %v", len(list), err)
	}
	if err := s.DeleteChannel(c.ID); err != nil {
		t.Fatalf("DeleteChannel: %v", err)
	}
	if err := s.DeleteChannel(c.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete err = %v, want ErrNotFound", err)
	}
}

func TestStateOptimisticConcurrency(t *testing.T) {
	s, _ := testStore(t)
	c, _ := s.CreateChannel(ChannelInput{Name: "A"}, "u")

	if _, err := s.GetState(c.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetState before first put: err = %v, want ErrNotFound", err)
	}
	if _, err := s.GetState("missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetState unknown channel: err = %v, want ErrNotFound", err)
	}

	st, err := s.PutState(c.ID, 0, json.RawMessage(`{"n":1}`))
	if err != nil || st.Version != 1 {
		t.Fatalf("first put = %+v, %v", st, err)
	}
	// Zweiter "erster" Schreibzugriff (Version 0) kollidiert.
	if _, err := s.PutState(c.ID, 0, json.RawMessage(`{"n":2}`)); !errors.Is(err, ErrConflict) {
		t.Fatalf("second v0 put: err = %v, want ErrConflict", err)
	}
	st, err = s.PutState(c.ID, 1, json.RawMessage(`{"n":2}`))
	if err != nil || st.Version != 2 {
		t.Fatalf("put v1 = %+v, %v", st, err)
	}
	// Veraltete Version → Konflikt, Zustand bleibt unverändert.
	if _, err := s.PutState(c.ID, 1, json.RawMessage(`{"n":3}`)); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale put: err = %v, want ErrConflict", err)
	}
	got, err := s.GetState(c.ID)
	if err != nil || got.Version != 2 || string(got.State) != `{"n": 2}` {
		t.Fatalf("GetState = %+v (%s), %v", got, got.State, err)
	}

	if _, err := s.PutState(c.ID, 2, json.RawMessage(`not json`)); !errors.Is(err, ErrValidation) {
		t.Fatalf("invalid JSON: err = %v, want ErrValidation", err)
	}
	if _, err := s.PutState("missing", 0, json.RawMessage(`{}`)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown channel: err = %v, want ErrNotFound", err)
	}

	// Löschen des Channels räumt den Zustand mit ab (ON DELETE CASCADE).
	if err := s.DeleteChannel(c.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetState(c.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("state after channel delete: err = %v, want ErrNotFound", err)
	}
}

func TestRecordExecutionIsIdempotent(t *testing.T) {
	s, _ := testStore(t)
	a, _ := s.CreateChannel(ChannelInput{Name: "A"}, "u")
	b, _ := s.CreateChannel(ChannelInput{Name: "B"}, "u")

	first, err := s.RecordExecution(a.ID, "fixtime:item1:2026-10-02", "fixtime")
	if err != nil || !first {
		t.Fatalf("first = %v, %v; want true", first, err)
	}
	again, err := s.RecordExecution(a.ID, "fixtime:item1:2026-10-02", "fixtime")
	if err != nil || again {
		t.Fatalf("repeat = %v, %v; want false", again, err)
	}
	// Dieselbe ID in einem anderen Channel ist eine eigene Ausführung.
	other, err := s.RecordExecution(b.ID, "fixtime:item1:2026-10-02", "fixtime")
	if err != nil || !other {
		t.Fatalf("other channel = %v, %v; want true", other, err)
	}
	if _, err := s.RecordExecution(a.ID, "  ", "x"); !errors.Is(err, ErrValidation) {
		t.Fatalf("empty id: err = %v, want ErrValidation", err)
	}
	if _, err := s.RecordExecution("missing", "x", "x"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown channel: err = %v, want ErrNotFound", err)
	}

	n, err := s.PruneExecutions(time.Now().Add(time.Minute))
	if err != nil || n != 2 {
		t.Fatalf("PruneExecutions = %d, %v; want 2", n, err)
	}
	if first, _ := s.RecordExecution(a.ID, "fixtime:item1:2026-10-02", "fixtime"); !first {
		t.Fatal("after prune the ID should count as first again")
	}
}
