package commands

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/infantilo/openmediaplatform/host-agent/internal/jobs"
	"github.com/infantilo/openmediaplatform/jobwire"
)

// SetJobs aktiviert die Job-Ausführung (tools.json). Ohne Runner lehnt der Agent jede Job-Aktion ab.
func (e *Executor) SetJobs(r *jobs.Runner) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.jobs = r
}

// JobsInfo liefert die Fähigkeitsmeldung für die Telemetrie (nil ohne Job-Freigabe).
func (e *Executor) JobsInfo() *jobs.Info {
	e.mu.Lock()
	r := e.jobs
	e.mu.Unlock()
	if r == nil {
		return nil
	}
	return r.Info()
}

func (e *Executor) handleJob(req Request) Response {
	e.mu.Lock()
	r := e.jobs
	e.mu.Unlock()
	if r == nil {
		return Response{OK: false, Error: "Job-Ausführung auf diesem Host nicht freigegeben (tools.json fehlt)"}
	}
	fail := func(err error) Response {
		var rej *jobs.RejectError
		if errors.As(err, &rej) {
			return Response{OK: false, Error: err.Error(), Detail: jobwire.DetailRejected}
		}
		return Response{OK: false, Error: err.Error()}
	}
	switch req.Action {
	case jobwire.ActionExec:
		pid, err := r.Exec(jobs.Request{JobID: req.JobID, Tool: req.Tool, Args: req.Args, TimeoutS: req.TimeoutS, Nice: req.Nice})
		if err != nil {
			return fail(err)
		}
		return Response{OK: true, PID: pid}
	case jobwire.ActionCancel:
		if err := r.Cancel(req.JobID); err != nil {
			return fail(err)
		}
	case jobwire.ActionPause:
		if err := r.Pause(req.JobID, true); err != nil {
			return fail(err)
		}
	case jobwire.ActionResume:
		if err := r.Pause(req.JobID, false); err != nil {
			return fail(err)
		}
	case jobwire.ActionNice:
		if err := r.Renice(req.JobID, req.Nice); err != nil {
			return fail(err)
		}
	case jobwire.ActionList:
		data, _ := json.Marshal(r.List())
		return Response{OK: true, Detail: string(data)}
	}
	return Response{OK: true}
}

// ShutdownJobs beendet laufende Jobs beim Beenden des Agents (siehe jobs.Runner.Shutdown).
func (e *Executor) ShutdownJobs() {
	e.mu.Lock()
	r := e.jobs
	e.mu.Unlock()
	if r != nil {
		r.Shutdown(4 * time.Second)
	}
}
