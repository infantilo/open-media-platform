package httpapi

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/freeze"
)

func newTestFreezer(t *testing.T) (*freeze.Freezer, *freeze.Store) {
	db := dbtest.Open(t)
	if _, err := db.Exec(`TRUNCATE freezes`); err != nil {
		t.Fatal(err)
	}
	st := freeze.NewStore(db)
	var gotScope []string
	f := freeze.New(freeze.Deps{
		Timeline: func(time.Time, time.Time) (any, error) { return []string{"x"}, nil },
		Pipelines: func(_ context.Context, scope []string, _ int) (map[string][]byte, error) {
			gotScope = scope
			return map[string][]byte{"A-1.json": []byte(`{}`)}, nil
		},
	}, st)
	_ = gotScope
	return f, st
}

func TestFreezeHandlersCreateListDownloadDelete(t *testing.T) {
	f, st := newTestFreezer(t)
	create := handleCreateFreeze(f)
	req := withPrincipal(httptest.NewRequest("POST", "/api/v1/freezes", strings.NewReader(`{"minutes":5,"note":"Bild weg","nodeIds":["n1"]}`)), "anna")
	rec := httptest.NewRecorder()
	create(rec, req)
	var m freeze.Meta
	if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &m) != nil || m.WindowMinutes != 5 || m.CreatedBy != "anna" || m.Note != "Bild weg" || len(m.Scope) != 1 || m.SizeBytes == 0 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "PK") {
		t.Error("die Antwort darf keinen Inhalt tragen")
	}
	// Doppelklick: nicht noch eine
	rec = httptest.NewRecorder()
	create(rec, withPrincipal(httptest.NewRequest("POST", "/api/v1/freezes", nil), "anna"))
	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("Doppelklick: %d", rec.Code)
	}
	// Liste: nur Beschreibungen
	rec = httptest.NewRecorder()
	handleListFreezes(st)(rec, httptest.NewRequest("GET", "/api/v1/freezes", nil))
	var list []freeze.Meta
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil || len(list) != 1 || list[0].ID != m.ID {
		t.Fatalf("%v %s", err, rec.Body.String())
	}
	// Download: ZIP mit Dateiname
	dl := httptest.NewRequest("GET", "/x", nil)
	dl.SetPathValue("id", m.ID)
	rec = httptest.NewRecorder()
	handleDownloadFreeze(st)(rec, dl)
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "application/zip" || !strings.Contains(rec.Header().Get("Content-Disposition"), "omp-freeze-") {
		t.Fatalf("%d %v", rec.Code, rec.Header())
	}
	zr, err := zip.NewReader(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, zf := range zr.File {
		names[zf.Name] = true
	}
	if !names["meta.json"] || !names["timeline.json"] || !names["pipelines/A-1.json"] {
		t.Errorf("ZIP: %v", names)
	}
	// unbekannt → 404; Löschen
	for _, h := range []http.HandlerFunc{handleDownloadFreeze(st), handleDeleteFreeze(st)} {
		r := httptest.NewRequest("GET", "/x", nil)
		r.SetPathValue("id", "gibtsnicht")
		rec := httptest.NewRecorder()
		h(rec, r)
		if rec.Code != http.StatusNotFound {
			t.Errorf("unbekannt: %d", rec.Code)
		}
	}
	del := httptest.NewRequest("DELETE", "/x", nil)
	del.SetPathValue("id", m.ID)
	rec = httptest.NewRecorder()
	handleDeleteFreeze(st)(rec, del)
	if rec.Code != http.StatusNoContent {
		t.Errorf("löschen: %d", rec.Code)
	}
}

func TestSupportAccessMayListAndDownloadFreezesButNotDelete(t *testing.T) {
	for _, tc := range []struct {
		method, path string
		want         bool
	}{
		{"GET", "/api/v1/freezes", true},
		{"GET", "/api/v1/freezes/abc123/download", true},
		{"POST", "/api/v1/freezes", false},
		{"DELETE", "/api/v1/freezes/abc123", false},
		{"GET", "/api/v1/freezes/abc/def/download", false},
		{"GET", "/api/v1/freezes//download", false},
	} {
		if got := supportMayRead(tc.method, tc.path); got != tc.want {
			t.Errorf("%s %s = %v, erwartet %v", tc.method, tc.path, got, tc.want)
		}
	}
}
