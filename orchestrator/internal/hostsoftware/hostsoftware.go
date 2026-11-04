// Package hostsoftware sammelt, welcher Host (einschließlich des Orchestrator-Rechners) mit welcher Version läuft:
// Build-Stempel des Host-Agents beziehungsweise des Orchestrators, Stempel der Node-Binaries aus dem jeweiligen Katalog,
// installierte Microservices und laufende Instanzen je Typ (Kap. 85). Die Entfernten werden per signiertem
// Host-Kommando „software“ befragt (parallel, kurzes Zeitlimit); die Antwort wird einige Sekunden zwischengespeichert.
package hostsoftware

import (
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"time"
)

// Node entspricht host-agent/internal/commands.SoftwareNode.
type Node struct {
	Type     string `json:"type"`
	Runner   string `json:"runner"`
	Binary   string `json:"binary,omitempty"`
	Version  string `json:"version,omitempty"`
	Commit   string `json:"commit,omitempty"`
	BuiltAt  string `json:"builtAt,omitempty"`
	Modified string `json:"modified,omitempty"`
	Source   string `json:"source,omitempty"`
	Error    string `json:"error,omitempty"`
	Running  int    `json:"running"`
	Outdated int    `json:"outdated,omitempty"`
}

// Build ist der Stempel eines Agents/Orchestrators.
type Build struct {
	Version string `json:"version"`
	Commit  string `json:"commit,omitempty"`
	BuiltAt string `json:"builtAt,omitempty"`
	Release string `json:"release,omitempty"`
}

// Host ist die Auskunft eines Hosts.
type Host struct {
	HostID  string    `json:"hostId"`
	Label   string    `json:"label"`
	Local   bool      `json:"local,omitempty"`
	Online  bool      `json:"online"`
	Agent   *Build    `json:"agent,omitempty"`
	Nodes   []Node    `json:"nodes"`
	Error   string    `json:"error,omitempty"`
	Updated time.Time `json:"updated,omitempty"`
}

// Report ist die Gesamtantwort.
type Report struct {
	Orchestrator Build  `json:"orchestrator"`
	Hosts        []Host `json:"hosts"`
}

// HostRef identifiziert einen registrierten Host.
type HostRef struct{ ID, Label string }

const (
	hostTimeout = 5 * time.Second
	cacheTTL    = 8 * time.Second
)

// Service sammelt die Auskünfte. Alle Fremdzugriffe sind Funktionsfelder (in main.go verdrahtet, in Tests ersetzt).
type Service struct {
	Hosts   func() ([]HostRef, error)
	Online  func(hostID string) bool
	Request func(subject string, data []byte, timeout time.Duration) ([]byte, error)
	// Local liefert die Auskunft des Orchestrator-Rechners.
	Local func() Host
	// Orchestrator: Stempel dieses Orchestrators.
	Orchestrator func() Build

	mu     sync.Mutex
	cached *Report
	at     time.Time
}

// Collect liefert den aktuellen Stand (höchstens alle cacheTTL neu; force umgeht den Zwischenspeicher).
func (s *Service) Collect(force bool) (Report, error) {
	s.mu.Lock()
	if !force && s.cached != nil && time.Since(s.at) < cacheTTL {
		r := *s.cached
		s.mu.Unlock()
		return r, nil
	}
	s.mu.Unlock()

	refs, err := s.Hosts()
	if err != nil {
		return Report{}, err
	}
	sort.Slice(refs, func(i, j int) bool { return refs[i].Label < refs[j].Label })
	rep := Report{Orchestrator: s.Orchestrator()}
	if s.Local != nil {
		l := s.Local()
		l.Local, l.Online = true, true
		rep.Hosts = append(rep.Hosts, l)
	}
	out := make([]Host, len(refs))
	var wg sync.WaitGroup
	for i, h := range refs {
		wg.Add(1)
		go func(i int, h HostRef) {
			defer wg.Done()
			out[i] = s.ask(h)
		}(i, h)
	}
	wg.Wait()
	rep.Hosts = append(rep.Hosts, out...)

	s.mu.Lock()
	s.cached, s.at = &rep, time.Now()
	s.mu.Unlock()
	return rep, nil
}

func (s *Service) ask(h HostRef) Host {
	res := Host{HostID: h.ID, Label: h.Label, Nodes: []Node{}}
	if !s.Online(h.ID) {
		res.Error = "Host meldet keine Telemetrie"
		return res
	}
	res.Online = true
	raw, err := s.Request(fmt.Sprintf("omp.host.%s.cmd", h.ID), []byte(`{"action":"software"}`), hostTimeout)
	if err != nil {
		res.Error = "keine Antwort: " + err.Error()
		return res
	}
	var resp struct {
		OK     bool   `json:"ok"`
		Error  string `json:"error"`
		Detail string `json:"detail"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		res.Error = "ungültige Antwort"
		return res
	}
	if !resp.OK {
		// ältere Agents kennen die Aktion nicht
		res.Error = resp.Error
		if res.Error == `unknown action "software"` {
			res.Error = "Host-Agent zu alt (kennt die Software-Auskunft nicht) — Agent aktualisieren"
		}
		return res
	}
	var body struct {
		Agent   Build     `json:"agent"`
		Nodes   []Node    `json:"nodes"`
		Updated time.Time `json:"updated"`
	}
	if err := json.Unmarshal([]byte(resp.Detail), &body); err != nil {
		res.Error = "Antwort unlesbar"
		return res
	}
	res.Agent, res.Nodes, res.Updated = &body.Agent, body.Nodes, body.Updated
	if res.Nodes == nil {
		res.Nodes = []Node{}
	}
	return res
}
