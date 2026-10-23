package jobs

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

type memSettings struct {
	mu sync.Mutex
	m  map[string][]byte
}

func (s *memSettings) Get(k string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if v, ok := s.m[k]; ok {
		return v, nil
	}
	return nil, module.ErrNotFound
}
func (s *memSettings) Put(k string, v []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[k] = v
	return nil
}

type routes struct{ mux *http.ServeMux }

func (r routes) Handle(p string, _ module.Auth, h http.HandlerFunc) { r.mux.HandleFunc(p, h) }

func setup(t *testing.T) (*Module, *http.ServeMux) {
	m := New()
	mux := http.NewServeMux()
	if err := m.Mount(routes{mux}, module.Deps{Settings: &memSettings{m: map[string][]byte{}}, Actor: func(*http.Request) string { return "tester" }}); err != nil {
		t.Fatal(err)
	}
	return m, mux
}

func do(mux *http.ServeMux, method, path, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(method, path, strings.NewReader(body)))
	return rec
}

func TestKonfigurationLesenUndSpeichern(t *testing.T) {
	m, mux := setup(t)
	if rec := do(mux, "GET", "/api/v1/jobs/config", ""); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"defaultTarget":"local"`) {
		t.Fatalf("Auslieferungswert local: %d %s", rec.Code, rec.Body)
	}
	if rec := do(mux, "PUT", "/api/v1/jobs/config", `{"defaultTarget":"pool:render","defaults":{"qc":"auto"}}`); rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if c := m.Config(); c.DefaultTarget != "pool:render" || c.Defaults["qc"] != "auto" || c.Protect.PauseAt != 1.0 {
		t.Fatalf("gespeichert und mit Standardwerten ergänzt: %+v", c)
	}
	for _, bad := range []string{`{"defaultTarget":"unsinn"}`, `{"protect":{"throttleAt":2,"pauseAt":1,"cancelAt":3,"resumeAt":0.5}}`, `{"liveReserve":{"cpu":1.5}}`, `nicht json`} {
		if rec := do(mux, "PUT", "/api/v1/jobs/config", bad); rec.Code != 400 {
			t.Errorf("%s muss abgelehnt werden: %d", bad, rec.Code)
		}
	}
}

func TestJobEinreichenPruefenUndVorschau(t *testing.T) {
	_, mux := setup(t)
	if rec := do(mux, "POST", "/api/v1/jobs", `{"tool":"rm","args":["-rf","/"]}`); rec.Code != 400 {
		t.Fatalf("fremdes Programm: %d", rec.Code)
	}
	if rec := do(mux, "POST", "/api/v1/jobs", `{"tool":"ffmpeg","target":"quatsch"}`); rec.Code != 400 {
		t.Fatalf("ungültiges Ziel: %d", rec.Code)
	}
	if rec := do(mux, "POST", "/api/v1/jobs/preview", `{"tool":"ffmpeg","args":["-version"],"target":"host:gibtesnicht"}`); rec.Code != 200 || !strings.Contains(rec.Body.String(), "kein Host") {
		t.Fatalf("Vorschau begründet: %d %s", rec.Code, rec.Body)
	}
	rec := do(mux, "POST", "/api/v1/jobs", `{"tool":"ffprobe","args":["-version"],"target":"local"}`)
	if rec.Code != 202 {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if rec := do(mux, "GET", "/api/v1/jobs", ""); !strings.Contains(rec.Body.String(), `"waiting":1`) {
		t.Fatalf("ohne Leader-Schleife bleibt der Job wartend: %s", rec.Body)
	}
	if rec := do(mux, "DELETE", "/api/v1/jobs/unbekannt", ""); rec.Code != 404 {
		t.Fatalf("%d", rec.Code)
	}
	if rec := do(mux, "GET", "/api/v1/jobs/hosts", ""); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"ID":"local"`) {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
}

func TestKalibrierungsEndpunkt(t *testing.T) {
	_, mux := setup(t)
	rec := do(mux, "GET", "/api/v1/jobs/calibration", "")
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"mode":"manual"`) || !strings.Contains(rec.Body.String(), `"reason":"no-data"`) {
		t.Fatalf("ohne Verlauf: keine Daten, Modus manuell: %d %s", rec.Code, rec.Body)
	}
	if rec := do(mux, "POST", "/api/v1/jobs/calibration/apply", `{"host":"local"}`); rec.Code != 409 {
		t.Fatalf("ohne belastbaren Vorschlag nichts übernehmen: %d", rec.Code)
	}
	if rec := do(mux, "POST", "/api/v1/jobs/calibration/apply", `{}`); rec.Code != 400 {
		t.Fatalf("%d", rec.Code)
	}
	if rec := do(mux, "PUT", "/api/v1/jobs/config", `{"calibration":{"mode":"auto","margin":0.15}}`); rec.Code != 200 || !strings.Contains(rec.Body.String(), `"mode":"auto"`) {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if rec := do(mux, "PUT", "/api/v1/jobs/config", `{"calibration":{"mode":"magie"}}`); rec.Code != 400 {
		t.Fatalf("%d", rec.Code)
	}
	if rec := do(mux, "PUT", "/api/v1/jobs/config", `{"local":{"reserve":{"cpu":1.5}}}`); rec.Code != 400 {
		t.Fatalf("Host-Reserve prüfen: %d", rec.Code)
	}
}
