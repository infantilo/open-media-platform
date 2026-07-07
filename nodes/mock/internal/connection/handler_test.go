package connection

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandlerGetStagedAndActive(t *testing.T) {
	store := NewReceiverStore([]string{"recv-1"})
	h := Handler(store)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x-nmos/connection/v1.1/single/receivers/recv-1/staged", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET staged status = %d, want 200", rec.Code)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x-nmos/connection/v1.1/single/receivers/recv-1/active", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET active status = %d, want 200", rec.Code)
	}
}

func TestHandlerPatchStagedActivatesImmediately(t *testing.T) {
	store := NewReceiverStore([]string{"recv-1"})
	h := Handler(store)

	body := `{"sender_id":"sender-1","master_enable":true,"activation":{"mode":"activate_immediate"}}`
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/x-nmos/connection/v1.1/single/receivers/recv-1/staged", strings.NewReader(body))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("PATCH status = %d, want 200", rec.Code)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x-nmos/connection/v1.1/single/receivers/recv-1/active", nil))
	var active ReceiverResource
	if err := json.Unmarshal(rec.Body.Bytes(), &active); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if active.SenderID == nil || *active.SenderID != "sender-1" {
		t.Fatalf("active.sender_id = %v, want sender-1", active.SenderID)
	}
}

func TestHandlerUnknownReceiverReturns404(t *testing.T) {
	store := NewReceiverStore([]string{"recv-1"})
	h := Handler(store)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x-nmos/connection/v1.1/single/receivers/nope/staged", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}
