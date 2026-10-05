package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
)

type memSettings struct{ m map[string]json.RawMessage }

func (s *memSettings) Get(k string) (json.RawMessage, error) {
	if v, ok := s.m[k]; ok {
		return v, nil
	}
	return nil, launcher.ErrNodeSettingsNotFound
}
func (s *memSettings) Put(k string, v json.RawMessage) error { s.m[k] = v; return nil }

func TestDefaultAudioRulesDocumentIsValid(t *testing.T) {
	var d audioRulesDoc
	dec := json.NewDecoder(strings.NewReader(string(defaultAudioRulesJSON)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&d); err != nil {
		t.Fatalf("Standarddokument nicht lesbar: %v", err)
	}
	if errs := validateAudioRules(d); len(errs) != 0 {
		t.Fatalf("Standarddokument ungültig: %v", errs)
	}
	if len(d.Mappings) != 13 || len(d.OutputProfile.Groups) != 5 {
		t.Fatalf("erwartet 13 Zuordnungen/5 Gruppen, got %d/%d", len(d.Mappings), len(d.OutputProfile.Groups))
	}
}

func TestAudioRulesGetPutRoundtrip(t *testing.T) {
	store := &memSettings{m: map[string]json.RawMessage{}}
	rec := httptest.NewRecorder()
	handleGetAudioRules(store)(rec, httptest.NewRequest("GET", "/", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "surround51") {
		t.Fatalf("GET ohne Speicherstand muss Standardwerte liefern: %d", rec.Code)
	}
	put := func(body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		handlePutAudioRules(store)(rec, httptest.NewRequest("PUT", "/", strings.NewReader(body)))
		return rec
	}
	if rec := put(string(defaultAudioRulesJSON)); rec.Code != http.StatusOK {
		t.Fatalf("PUT Standarddokument: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := store.Get(audioRulesKey); err != nil {
		t.Fatalf("nicht gespeichert: %v", err)
	}
	bad := `{"outputProfile":{"groups":[{"id":"a","label":"A","tags":["bitexact"],"default":{"select":"x","via":"upmix51"}},{"id":"a","label":"A2"}]},
	  "mappings":[{"id":"m","groups":{"zz":{"tracks":[1]}}}],
	  "ruleSet":{"rules":[{"group":"a","when":{"missing":"a AND"},"then":[]}]}}`
	rec = put(bad)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("ungültiges Dokument muss 400 liefern, got %d", rec.Code)
	}
	for _, want := range []string{"doppelte ID", "bit-exakt", "unbekannte Zielgruppe 'zz'", "Tag-Ausdruck"} {
		if !strings.Contains(rec.Body.String(), want) {
			t.Errorf("Fehlertext enthält %q nicht: %s", want, rec.Body.String())
		}
	}
	if rec := put(`{"outputProfile":{"groups":[]},"bogus":1}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("unbekannte Felder müssen abgelehnt werden")
	}
}

func TestAudioTagExprSyntax(t *testing.T) {
	for _, ok := range []string{"a", "role:pt AND (layout:stereo or layout:mono) and not lang:en"} {
		if err := parseAudioTagExpr(ok); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "a AND", "(a", "a b c ) )", "a & b", "OR a"} {
		if parseAudioTagExpr(bad) == nil {
			t.Errorf("%q muss ein Fehler sein", bad)
		}
	}
}

func TestSimulateAudioRulesUsesTheConfiguredBinary(t *testing.T) {
	script := t.TempDir() + "/sim.sh"
	if err := os.WriteFile(script, []byte("#!/bin/sh\ncat >/dev/null\necho '{\"ok\":true}'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OMP_AUDIO_SIM_BIN", script)
	rec := httptest.NewRecorder()
	handleSimulateAudioRules()(rec, httptest.NewRequest("POST", "/", strings.NewReader(`{"x":1}`)))
	if rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"ok":true}` {
		t.Fatalf("unerwartete Antwort: %d %s", rec.Code, rec.Body.String())
	}
	t.Setenv("OMP_AUDIO_SIM_BIN", "/nonexistent/audio-sim")
	rec = httptest.NewRecorder()
	handleSimulateAudioRules()(rec, httptest.NewRequest("POST", "/", strings.NewReader(`{}`)))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("fehlendes Programm muss 502 liefern, got %d", rec.Code)
	}
}
