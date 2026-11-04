package hostsoftware

import (
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func svc(req func(string, []byte, time.Duration) ([]byte, error)) *Service {
	return &Service{
		Hosts:        func() ([]HostRef, error) { return []HostRef{{"h2", "B"}, {"h1", "A"}, {"h3", "C"}}, nil },
		Online:       func(id string) bool { return id != "h3" },
		Request:      req,
		Local:        func() Host { return Host{Label: "Orchestrator", Nodes: []Node{{Type: "x", Version: "1"}}} },
		Orchestrator: func() Build { return Build{Version: "dev", Commit: "abc"} },
	}
}

func TestCollectLocalFirstThenSortedHostsWithErrors(t *testing.T) {
	s := svc(func(subject string, data []byte, _ time.Duration) ([]byte, error) {
		if !strings.Contains(string(data), `"software"`) {
			t.Errorf("falsche Aktion: %s", data)
		}
		if subject == "omp.host.h2.cmd" {
			return nil, errors.New("timeout")
		}
		d, _ := json.Marshal(map[string]any{"agent": map[string]any{"version": "dev", "commit": "abc"}, "nodes": []Node{{Type: "omp-source", Version: "2026.11.1", Running: 2}}})
		return json.Marshal(map[string]any{"ok": true, "detail": string(d)})
	})
	r, err := s.Collect(true)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Hosts) != 4 || !r.Hosts[0].Local || r.Hosts[0].Label != "Orchestrator" {
		t.Fatalf("lokaler Host zuerst erwartet: %+v", r.Hosts)
	}
	if r.Hosts[1].Label != "A" || r.Hosts[1].Agent == nil || r.Hosts[1].Nodes[0].Running != 2 {
		t.Fatalf("A: %+v", r.Hosts[1])
	}
	if !strings.Contains(r.Hosts[2].Error, "keine Antwort") || r.Hosts[2].Online != true {
		t.Fatalf("B: %+v", r.Hosts[2])
	}
	if r.Hosts[3].Online || r.Hosts[3].Error == "" {
		t.Fatalf("C offline: %+v", r.Hosts[3])
	}
}

func TestOldAgentGetsClearMessageAndCacheWorks(t *testing.T) {
	var calls int32
	s := svc(func(string, []byte, time.Duration) ([]byte, error) {
		atomic.AddInt32(&calls, 1)
		return json.Marshal(map[string]any{"ok": false, "error": `unknown action "software"`})
	})
	r, _ := s.Collect(false)
	if !strings.Contains(r.Hosts[1].Error, "zu alt") {
		t.Fatalf("%+v", r.Hosts[1])
	}
	n := atomic.LoadInt32(&calls)
	s.Collect(false)
	if atomic.LoadInt32(&calls) != n {
		t.Fatal("zweiter Aufruf muss aus dem Zwischenspeicher kommen")
	}
	s.Collect(true)
	if atomic.LoadInt32(&calls) == n {
		t.Fatal("force muss neu abfragen")
	}
}
