package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// mock ist ein kleiner Segue-Player nach Vertrag. Mit den Schaltern lässt er sich absichtlich verderben.
type mock struct {
	mu          sync.Mutex
	voices      map[string]*mv
	brokenDup   bool // Wiederholung erzeugt eine zweite Stimme
	missingStop bool // Descriptor ohne `stop`
	acceptAny   bool // nimmt alles an (keine 4xx)
}

type mv struct {
	state string
	born  time.Time
}

func (m *mock) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/descriptor.json", func(w http.ResponseWriter, r *http.Request) {
		methods := []map[string]any{}
		for name, args := range requiredMethods {
			if m.missingStop && name == "stop" {
				continue
			}
			as := []map[string]string{}
			for _, a := range args {
				as = append(as, map[string]string{"name": a})
			}
			methods = append(methods, map[string]any{"name": name, "args": as})
		}
		params := []map[string]string{}
		for _, p := range requiredParams {
			params = append(params, map[string]string{"name": p})
		}
		json.NewEncoder(w).Encode(map[string]any{"methods": methods, "parameters": params})
	})
	mux.HandleFunc("/params/", func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		defer m.mu.Unlock()
		switch strings.TrimPrefix(r.URL.Path, "/params/") {
		case "taiNowNs":
			json.NewEncoder(w).Encode(map[string]any{"value": 1.79e18})
		case "voices":
			list := []map[string]any{}
			for id, v := range m.voices {
				if v.state == "stopping" && time.Since(v.born) > 300*time.Millisecond {
					v.state = "ended"
				}
				list = append(list, map[string]any{"voiceId": id, "state": v.state, "error": ""})
			}
			json.NewEncoder(w).Encode(map[string]any{"value": list})
		default:
			json.NewEncoder(w).Encode(map[string]any{"value": 0})
		}
	})
	mux.HandleFunc("/methods/", func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		defer m.mu.Unlock()
		var a map[string]any
		_ = json.NewDecoder(r.Body).Decode(&a)
		id, _ := a["voiceId"].(string)
		bad := func() { http.Error(w, "abgelehnt", http.StatusBadRequest) }
		switch strings.TrimPrefix(r.URL.Path, "/methods/") {
		case "play":
			ok := id != "" && !strings.ContainsAny(id, " ü")
			if f, _ := a["file"].(string); strings.HasPrefix(f, "/gibt/es/nicht") {
				ok = false
			}
			if !ok && !m.acceptAny {
				bad()
				return
			}
			if _, dup := m.voices[id]; dup && !m.brokenDup {
				w.Write([]byte(`{"ok":true}`))
				return
			}
			key := id
			if _, dup := m.voices[id]; dup {
				key = id + "-2"
			}
			m.voices[key] = &mv{state: "scheduled", born: time.Now()}
		case "stop":
			v, ok := m.voices[id]
			if !ok && !m.acceptAny {
				bad()
				return
			}
			if ok {
				v.state, v.born = "stopping", time.Now()
			}
		}
		w.Write([]byte(`{"ok":true}`))
	})
	return mux
}

func run(m *mock, withFile bool) (failed []string) {
	m.voices = map[string]*mv{}
	srv := httptest.NewServer(m.handler())
	defer srv.Close()
	c := &client{base: srv.URL, http: srv.Client()}
	res := Structure(c)
	if withFile {
		res = append(res, Behaviour(c, "/tmp/x.wav")...)
	}
	for _, r := range res {
		if !r.OK {
			failed = append(failed, r.Name)
		}
	}
	return failed
}

func TestConformingMockPasses(t *testing.T) {
	if f := run(&mock{}, true); len(f) != 0 {
		t.Fatalf("vertragstreuer Mock fällt durch: %v", f)
	}
}

func TestMissingMethodIsDetected(t *testing.T) {
	f := run(&mock{missingStop: true}, false)
	if len(f) != 1 || f[0] != "Methode stop" {
		t.Fatalf("fehlende Methode stop nicht gemeldet: %v", f)
	}
}

func TestDoubleStartIsDetected(t *testing.T) {
	f := run(&mock{brokenDup: true}, true)
	found := false
	for _, n := range f {
		if strings.Contains(n, "Idempotenz") {
			found = true
		}
	}
	if !found {
		t.Fatalf("Doppelstart nicht erkannt: %v", f)
	}
}

func TestAcceptingEverythingIsDetected(t *testing.T) {
	f := run(&mock{acceptAny: true}, true)
	if len(f) < 2 {
		t.Fatalf("ein Mock, der Ungültiges annimmt, muss mehrfach durchfallen: %v", f)
	}
}
