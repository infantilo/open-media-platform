package jobrun

import (
	"encoding/json"
	"errors"
	"fmt"
	"github.com/infantilo/openmediaplatform/jobwire"
	"sort"
	"strings"
	"time"
)

// Wire-Format: gemeinsam mit dem Host-Agent (Paket jobwire). Die allgemeine Antwort auf Kommandos hat dieselbe Form wie
// die der Instanz-Aktionen (host-agent/internal/commands.Response).
type agentResponse struct {
	OK     bool   `json:"ok"`
	PID    int    `json:"pid,omitempty"`
	Error  string `json:"error,omitempty"`
	Detail string `json:"detail,omitempty"`
}

type agentRequest = jobwire.Request
type agentEvent = jobwire.Event

func jobReq(action, jobID string) agentRequest {
	return agentRequest{Action: action, Exec: jobwire.Exec{JobID: jobID}}
}

func (d *Dispatcher) agentCmd(host string, r agentRequest) (agentResponse, error) {
	if d.Bus == nil {
		return agentResponse{}, errors.New("kein Kommandokanal zu den Host-Agents (NATS)")
	}
	payload, _ := json.Marshal(r)
	data, err := d.Bus.Request(jobwire.CommandSubject(host), payload, 3*time.Second)
	if err != nil {
		return agentResponse{}, err
	}
	var resp agentResponse
	if err := json.Unmarshal(data, &resp); err != nil {
		return agentResponse{}, fmt.Errorf("Antwort des Agents unlesbar: %w", err)
	}
	return resp, nil
}

// startAgent schickt den Job an den Agent; Ergebnis und Fortschritt kommen als Ereignisse.
func (d *Dispatcher) startAgent(e *entry, h HostState, gen int, args []string, parts [][2]string, cfg Config) error {
	if d.Bus == nil {
		return errors.New("kein Kommandokanal zu den Host-Agents (NATS)")
	}
	jobID := fmt.Sprintf("%s-%d", e.job.ID, gen)
	subject := jobwire.EventSubject(h.ID, jobID)
	var tail []string
	chunks := map[int][]byte{}
	finished := false
	var unsub func()
	handler := func(data []byte) {
		var ev agentEvent
		if json.Unmarshal(data, &ev) != nil {
			return
		}
		switch ev.Type {
		case "progress":
			d.setProgress(e, gen, ev.Line)
			if e.spec.OnStderr != nil {
				e.spec.OnStderr(ev.Line)
			}
		case "stdout":
			chunks[ev.Seq] = ev.Data
		case "done":
			if finished {
				return
			}
			finished = true
			if unsub != nil {
				go unsub()
			}
			tail = ev.Tail
			if e.spec.OnStderr != nil {
				for _, l := range tail {
					e.spec.OnStderr(l)
				}
			}
			keys := make([]int, 0, len(chunks))
			for k := range chunks {
				keys = append(keys, k)
			}
			sort.Ints(keys)
			var out []byte
			for _, k := range keys {
				out = append(out, chunks[k]...)
			}
			var execErr error
			switch {
			case ev.Error == jobwire.ErrTimeout:
				execErr = errTimeout
			case ev.Error != "":
				execErr = errors.New(ev.Error)
			case len(chunks) != ev.Chunks:
				execErr = fmt.Errorf("Ausgabe unvollständig (%d von %d Stücken)", len(chunks), ev.Chunks)
			}
			d.completed(e, gen, h.ID, ev.ExitCode, out, tail, execErr, mapParts(parts), cfg)
		}
	}
	var err error
	unsub, err = d.Bus.Subscribe(subject, handler)
	if err != nil {
		return err
	}
	nice := cfg.hostOpts(h.ID).Nice
	resp, err := d.agentCmd(h.ID, agentRequest{Action: jobwire.ActionExec, Exec: jobwire.Exec{JobID: jobID, Tool: e.spec.Tool, Args: mapArgs(cfg, h.ID, args), TimeoutS: e.spec.TimeoutS, Nice: nice}})
	if err != nil || !resp.OK {
		unsub()
		if err == nil {
			err = errors.New(resp.Error)
			if resp.Detail == jobwire.DetailRejected {
				err = &rejectedError{msg: resp.Error}
			}
		}
		return err
	}
	cancel := func() { _, _ = d.agentCmd(h.ID, jobReq(jobwire.ActionCancel, jobID)) }
	pause := func(on bool) error {
		a := jobwire.ActionResume
		if on {
			a = jobwire.ActionPause
		}
		r, err := d.agentCmd(h.ID, jobReq(a, jobID))
		if err == nil && !r.OK {
			err = errors.New(r.Error)
		}
		return err
	}
	renice := func(n int) error {
		r, err := d.agentCmd(h.ID, agentRequest{Action: jobwire.ActionNice, Exec: jobwire.Exec{JobID: jobID, Nice: n}})
		if err == nil && !r.OK {
			err = errors.New(r.Error)
		}
		return err
	}
	if !d.markStarted(e, gen, cancel, pause, renice) {
		cancel()
	}
	return nil
}

// mapParts: Umbenennen geschieht auf der Orchestrator-Seite (gemeinsamer Speicher), die Pfade sind schon Orchestrator-Sicht.
func mapParts(p [][2]string) [][2]string { return p }

// Probe ist ein Einzeiler für Diagnosen: Agent-Jobliste eines Hosts.
func (d *Dispatcher) AgentJobs(host string) (string, error) {
	r, err := d.agentCmd(host, jobReq(jobwire.ActionList, ""))
	if err != nil {
		return "", err
	}
	if !r.OK {
		return "", errors.New(strings.TrimSpace(r.Error))
	}
	return r.Detail, nil
}

// rejectedError: der Agent lehnt den Job grundsätzlich ab — kein Wiederholen, kein Sperren des Hosts.
type rejectedError struct{ msg string }

func (e *rejectedError) Error() string { return "vom Host abgelehnt: " + e.msg }
