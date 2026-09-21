package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/alarmacks"
)

type fakeAlarmAckStore struct {
	acks    map[string]alarmacks.Ack
	deleted []string
}

func (f *fakeAlarmAckStore) List() ([]alarmacks.Ack, error) {
	out := []alarmacks.Ack{}
	for _, a := range f.acks {
		out = append(out, a)
	}
	return out, nil
}
func (f *fakeAlarmAckStore) Put(a alarmacks.Ack) error {
	if a.Key == "" || a.Fingerprint == "" || (a.Mode != "ack" && a.Mode != "mask") {
		return alarmacks.ErrInvalid
	}
	if f.acks == nil {
		f.acks = map[string]alarmacks.Ack{}
	}
	f.acks[a.Key] = a
	return nil
}
func (f *fakeAlarmAckStore) Delete(key string) error {
	f.deleted = append(f.deleted, key)
	delete(f.acks, key)
	return nil
}

func TestPutAlarmAckRecordsUserModeAndExpiryAndBroadcasts(t *testing.T) {
	store := &fakeAlarmAckStore{}
	events := &fakeEventPublisher{}
	h := handlePutAlarmAck(store, events)
	req := withPrincipal(httptest.NewRequest(http.MethodPut, "/api/v1/alarms/acks",
		strings.NewReader(`{"key":"host:1:offline","fingerprint":"fp","mode":"mask","comment":"Wartung","durationMinutes":60}`)), "alice")
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, body %q", rec.Code, rec.Body.String())
	}
	got := store.acks["host:1:offline"]
	if got.Username != "alice" || got.Mode != "mask" || got.Comment != "Wartung" || got.ExpiresAt == nil {
		t.Fatalf("stored = %+v", got)
	}
	if len(events.types) != 1 || events.types[0] != "alarm.ack.changed" {
		t.Fatalf("events = %v", events.types)
	}
}

func TestPutAlarmAckWithoutDurationHasNoExpiry(t *testing.T) {
	store := &fakeAlarmAckStore{}
	h := handlePutAlarmAck(store, nil)
	rec := httptest.NewRecorder()
	h(rec, withPrincipal(httptest.NewRequest(http.MethodPut, "/", strings.NewReader(`{"key":"k","fingerprint":"f","mode":"ack"}`)), "bob"))
	if rec.Code != http.StatusNoContent || store.acks["k"].ExpiresAt != nil {
		t.Fatalf("status %d, ack %+v", rec.Code, store.acks["k"])
	}
}

func TestPutAlarmAckRejectsBadInput(t *testing.T) {
	for name, body := range map[string]string{
		"not json":        `nope`,
		"missing key":     `{"fingerprint":"f","mode":"ack"}`,
		"bad mode":        `{"key":"k","fingerprint":"f","mode":"x"}`,
		"negative minute": `{"key":"k","fingerprint":"f","mode":"mask","durationMinutes":-5}`,
	} {
		rec := httptest.NewRecorder()
		handlePutAlarmAck(&fakeAlarmAckStore{}, nil)(rec, httptest.NewRequest(http.MethodPut, "/", strings.NewReader(body)))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400", name, rec.Code)
		}
	}
}

func TestDeleteAlarmAckUsesQueryKeyAndBroadcasts(t *testing.T) {
	store := &fakeAlarmAckStore{acks: map[string]alarmacks.Ack{"workflow:a/b:failed": {Key: "workflow:a/b:failed"}}}
	events := &fakeEventPublisher{}
	rec := httptest.NewRecorder()
	handleDeleteAlarmAck(store, events)(rec, httptest.NewRequest(http.MethodDelete, "/api/v1/alarms/acks?key=workflow:a/b:failed", nil))
	if rec.Code != http.StatusNoContent || len(store.deleted) != 1 || store.deleted[0] != "workflow:a/b:failed" || len(events.types) != 1 {
		t.Fatalf("status %d deleted %v events %v", rec.Code, store.deleted, events.types)
	}
	rec = httptest.NewRecorder()
	handleDeleteAlarmAck(store, events)(rec, httptest.NewRequest(http.MethodDelete, "/api/v1/alarms/acks", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing key: status = %d", rec.Code)
	}
}

func TestListAlarmAcksReturnsJSONArray(t *testing.T) {
	rec := httptest.NewRecorder()
	handleListAlarmAcks(&fakeAlarmAckStore{})(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != "[]" {
		t.Fatalf("status %d body %q", rec.Code, rec.Body.String())
	}
}
