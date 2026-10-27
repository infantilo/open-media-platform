package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/cluster"
)

type soloFake struct {
	ClusterService
	err   error
	asked int
}

func (f *soloFake) RequestSolo(by string) error { f.asked++; return f.err }
func (f *soloFake) CancelSolo() error           { return nil }

func TestEmergencySoloNeedsConfirmationAndMapsErrors(t *testing.T) {
	do := func(svc ClusterService, body string) int {
		rec := httptest.NewRecorder()
		handleClusterEmergencySolo(svc, nil)(rec, httptest.NewRequest(http.MethodPost, "/api/v1/cluster/emergency-solo", strings.NewReader(body)))
		return rec.Code
	}
	f := &soloFake{}
	if c := do(f, `{}`); c != http.StatusBadRequest || f.asked != 0 {
		t.Fatalf("ohne Bestätigung: %d (asked %d)", c, f.asked)
	}
	if c := do(f, `{"confirmPartnerDown": true}`); c != http.StatusAccepted || f.asked != 1 {
		t.Fatalf("mit Bestätigung: %d", c)
	}
	if c := do(&soloFake{err: cluster.ErrNotQuorumLost}, `{"confirmPartnerDown": true}`); c != http.StatusConflict {
		t.Fatalf("mit Leader: %d", c)
	}
	if c := do(&soloFake{err: cluster.ErrNoOtherMembers}, `{"confirmPartnerDown": true}`); c != http.StatusConflict {
		t.Fatalf("allein: %d", c)
	}
	if c := do(nil, `{"confirmPartnerDown": true}`); c != http.StatusNotImplemented {
		t.Fatalf("ohne Unterstützung: %d", c)
	}
}
