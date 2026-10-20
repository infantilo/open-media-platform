package service

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/infantilo/openmediaplatform/nodes/omp-vfa/internal/engine"
	"github.com/infantilo/openmediaplatform/nodes/omp-vfa/internal/orch"
)

// fakeOrch ersetzt den Orchestrator: Knotenliste, Mischereingänge, Methodenaufrufe.
type fakeOrch struct {
	mu    sync.Mutex
	calls []string
	auth  string
}

func (f *fakeOrch) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/instances/i1/service-token", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{"token": "tok"})
	})
	mux.HandleFunc("GET /api/v1/nodes", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`[{"id":"camA","label":"Kamera A","online":true,"senders":[{"id":"sA"}]},{"id":"camB","label":"Kamera B","online":true,"senders":[{"id":"sB"}]}]`))
	})
	mux.HandleFunc("GET /api/v1/nodes/vm/params/crosspoint.inputs", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"value":[{"senderId":"sB","label":"Kamera B Sender 1"},{"senderId":"sA","label":"Kamera A Sender 1"}]}`))
	})
	mux.HandleFunc("GET /api/v1/nodes/am/state", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"state":{"channels":[{"id":"ch1","label":"Mic 1"}]}}`))
	})
	mux.HandleFunc("POST /api/v1/nodes/vm/methods/{m}", func(w http.ResponseWriter, r *http.Request) {
		var a map[string]any
		json.NewDecoder(r.Body).Decode(&a)
		b, _ := json.Marshal(a)
		f.mu.Lock()
		f.calls = append(f.calls, r.PathValue("m")+string(b))
		f.auth = r.Header.Get("Authorization")
		f.mu.Unlock()
		w.Write([]byte(`{}`))
	})
	return mux
}

func newTestService(t *testing.T) (*Service, *fakeOrch) {
	f := &fakeOrch{}
	srv := httptest.NewServer(f.handler())
	t.Cleanup(srv.Close)
	s := New(orch.New(srv.URL, "i1", "secret"), nil, filepath.Join(t.TempDir(), "cfg.json"))
	cfg := engine.DefaultConfig()
	cfg.Enabled, cfg.VideoMixer, cfg.AudioMixer = true, "vm", "am"
	cfg.SpeakHoldMs, cfg.MinShotMs = 0, 0
	cfg.Cameras = []engine.Camera{{ID: "cam-1", Name: "A", NodeID: "camA"}, {ID: "cam-2", Name: "B", NodeID: "camB"}}
	cfg.People = []engine.Person{{ID: "anna", Name: "Anna", Mic: "ch1", Shots: []engine.Shot{{CameraID: "cam-2", CenterX: 0.3, SizePercent: 15}}}}
	s.SetConfig(cfg)
	return s, f
}

func TestSpeakerCutsMixerToCameraSender(t *testing.T) {
	s, f := newTestService(t)
	s.onLevel([]byte(`{"type":"dsp","channelId":"ch1","inDb":-20}`))
	s.onVision(&nats.Msg{Data: []byte(`{"camera_id":"cam-2","faces":[{"center_x":0.31,"size_percent":15}]}`)})
	s.tick(context.Background(), time.Now())
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		f.mu.Lock()
		n := len(f.calls)
		f.mu.Unlock()
		if n >= 2 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.calls) != 2 || f.calls[0] != `crosspoint.select{"senderId":"sB"}` || f.calls[1] != "crosspoint.cut{}" {
		t.Fatalf("Aufrufe: %v", f.calls)
	}
	if f.auth != "Bearer tok" {
		t.Fatalf("Auth: %q", f.auth)
	}
}

func TestLearnAndConfirm(t *testing.T) {
	s, _ := newTestService(t)
	if err := s.LearnStart("anna"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 10; i++ {
		s.onLevel([]byte(`{"type":"dsp","channelId":"ch1","inDb":-20}`))
		s.mu.Lock()
		s.faces["cam-1"] = faceSeen{[]engine.Face{{CenterX: 0.5, SizePercent: 12}}, time.Now()}
		s.learnStep(time.Now(), map[string]float64{"ch1": -20}, map[string][]engine.Face{"cam-1": {{CenterX: 0.5, SizePercent: 12}}})
		s.mu.Unlock()
	}
	s.mu.Lock()
	s.learn.until = time.Now().Add(-time.Second)
	s.learnStep(time.Now(), nil, nil)
	cands := s.learn.Candidates
	s.mu.Unlock()
	if len(cands) != 1 || cands[0].CameraID != "cam-1" {
		t.Fatalf("Vorschläge: %+v", cands)
	}
	if err := s.ConfirmShots("anna", []engine.Shot{{CameraID: "cam-1", CenterX: 0.5, SizePercent: 12}}); err != nil {
		t.Fatal(err)
	}
	if got := s.Config().People[0].Shots; len(got) != 1 || got[0].CameraID != "cam-1" {
		t.Fatalf("Shots: %+v", got)
	}
	// Konfiguration übersteht Neustart
	s2 := New(nil, nil, s.dataFile)
	if len(s2.Config().People) != 1 || len(s2.Config().People[0].Shots) != 1 {
		t.Fatal("Config nicht geladen")
	}
}

func TestChannelsAndLearnErrors(t *testing.T) {
	s, _ := newTestService(t)
	ch, err := s.Channels(context.Background())
	if err != nil || len(ch) != 1 || ch[0]["id"] != "ch1" {
		t.Fatalf("%v %v", ch, err)
	}
	if err := s.LearnStart("nobody"); err == nil {
		t.Fatal("unbekannte Person muss Fehler sein")
	}
}
