package jobs

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/jobrun"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/profiles"
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func (m *Module) Mount(r module.Routes, d module.Deps) error {
	m.mu.Lock()
	m.d = d
	m.mu.Unlock()
	r.Handle("GET /api/v1/jobs", module.Feature("jobs.view", "jobs.run", "jobs.configure"), m.list)
	r.Handle("GET /api/v1/jobs/hosts", module.Feature("jobs.view", "jobs.run", "jobs.configure"), m.hosts)
	r.Handle("POST /api/v1/jobs/preview", module.Feature("jobs.view", "jobs.run", "jobs.configure"), m.preview)
	r.Handle("GET /api/v1/jobs/calibration", module.Feature("jobs.view", "jobs.run", "jobs.configure"), m.calibration)
	r.Handle("POST /api/v1/jobs/calibration/apply", module.Feature("jobs.configure"), m.applyCalibration)
	r.Handle("GET /api/v1/jobs/config", module.Feature("jobs.view", "jobs.run", "jobs.configure"), m.getConfig)
	r.Handle("PUT /api/v1/jobs/config", module.Feature("jobs.configure"), m.putConfig)
	r.Handle("GET /api/v1/jobs/{id}", module.Feature("jobs.view", "jobs.run", "jobs.configure"), m.get)
	r.Handle("POST /api/v1/jobs", module.Feature("jobs.run", "jobs.configure"), m.submit)
	r.Handle("DELETE /api/v1/jobs/{id}", module.Feature("jobs.run", "jobs.configure"), m.cancel)
	return nil
}

func (m *Module) list(w http.ResponseWriter, r *http.Request) {
	jobs := m.disp.List(jobrun.State(r.URL.Query().Get("state")))
	run, wait := m.disp.Counts()
	writeJSON(w, 200, map[string]any{"jobs": jobs, "running": run, "waiting": wait})
}

func (m *Module) get(w http.ResponseWriter, r *http.Request) {
	j, ok := m.disp.Get(r.PathValue("id"))
	if !ok {
		writeErr(w, 404, "Job unbekannt")
		return
	}
	writeJSON(w, 200, j)
}

func (m *Module) hosts(w http.ResponseWriter, r *http.Request) {
	cfg := m.Config()
	writeJSON(w, 200, map[string]any{"hosts": m.disp.HostStates(), "pools": cfg.Pools(), "limitCpu": map[string]float64{
		"interactive": jobrun.CPULimit(jobrun.ClassInteractive, cfg), "scheduled": jobrun.CPULimit(jobrun.ClassScheduled, cfg), "batch": jobrun.CPULimit(jobrun.ClassBatch, cfg)}})
}

// submitBody: erlaubte Felder eines vom Menschen eingereichten Jobs (Testjob/Wartung).
type submitBody struct {
	Tool      string   `json:"tool"`
	Args      []string `json:"args"`
	Target    string   `json:"target"`
	Class     string   `json:"class"`
	Label     string   `json:"label"`
	Inputs    []string `json:"inputs"`
	Outputs   []string `json:"outputs"`
	Atomic    bool     `json:"atomic"`
	TimeoutS  int      `json:"timeoutS"`
	EstimateS int      `json:"estimateS"`
}

func (b submitBody) spec() jobrun.Spec {
	cl := jobrun.Class(b.Class)
	if b.Class == "" {
		cl = jobrun.ClassInteractive
	}
	return jobrun.Spec{Caller: "manual", Tool: b.Tool, Args: b.Args, Target: b.Target, Class: cl, Label: b.Label,
		Inputs: b.Inputs, Outputs: b.Outputs, Atomic: b.Atomic, TimeoutS: b.TimeoutS, EstimateS: b.EstimateS}
}

func (m *Module) submit(w http.ResponseWriter, r *http.Request) {
	var b submitBody
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&b); err != nil {
		writeErr(w, 400, "ungültiger Body: "+err.Error())
		return
	}
	id, err := m.disp.Submit(b.spec())
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if a := m.deps().Audit; a != nil {
		a.Log(m.deps().Actor(r), "job", id, "submit", map[string]any{"tool": b.Tool, "target": b.Target, "label": b.Label})
	}
	writeJSON(w, 202, map[string]string{"id": id})
}

func (m *Module) preview(w http.ResponseWriter, r *http.Request) {
	var b submitBody
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&b); err != nil {
		writeErr(w, 400, "ungültiger Body: "+err.Error())
		return
	}
	dec, err := m.disp.Preview(b.spec())
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	writeJSON(w, 200, dec)
}

func (m *Module) cancel(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := m.disp.Cancel(id); err != nil {
		code := 409
		if strings.Contains(err.Error(), "unbekannt") {
			code = 404
		}
		writeErr(w, code, err.Error())
		return
	}
	if a := m.deps().Audit; a != nil {
		a.Log(m.deps().Actor(r), "job", id, "cancel", nil)
	}
	w.WriteHeader(204)
}

func (m *Module) getConfig(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, m.Config())
}

func (m *Module) putConfig(w http.ResponseWriter, r *http.Request) {
	raw := make([]byte, 0, 4096)
	buf := http.MaxBytesReader(w, r.Body, 1<<20)
	dec := json.NewDecoder(buf)
	var doc json.RawMessage
	if err := dec.Decode(&doc); err != nil {
		writeErr(w, 400, "ungültiger Body: "+err.Error())
		return
	}
	raw = append(raw, doc...)
	cfg, err := jobrun.ParseConfig(raw)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	d := m.deps()
	if d.Settings == nil {
		writeErr(w, 503, "Einstellungsspeicher nicht verfügbar")
		return
	}
	m.saveConfig(w, r, cfg)
}

// saveConfig speichert die vollständig normalisierte Konfiguration und antwortet mit ihr.
func (m *Module) saveConfig(w http.ResponseWriter, r *http.Request, cfg jobrun.Config) {
	if err := cfg.Normalize(); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	d := m.deps()
	if d.Settings == nil {
		writeErr(w, 503, "Einstellungsspeicher nicht verfügbar")
		return
	}
	norm, _ := json.Marshal(cfg)
	if err := d.Settings.Put(jobrun.SettingsKey, norm); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	m.invalidate()
	if d.Audit != nil {
		d.Audit.Log(d.Actor(r), "settings", jobrun.SettingsKey, "update", map[string]any{"defaultTarget": cfg.DefaultTarget, "calibration": cfg.Calibration.Mode})
	}
	writeJSON(w, 200, cfg)
}

// ProfileLister liefert die typische Last je Node-Typ auf einem Host (profiles.Store).
type ProfileLister interface {
	List(ctx context.Context, hostID string) ([]profiles.Snapshot, error)
}

type nodeTypical struct {
	NodeType string  `json:"nodeType"`
	CPUAvg   float64 `json:"cpuAvg"`
	CPUP95   float64 `json:"cpuP95"`
	CPUMax   float64 `json:"cpuMax"`
	RSSAvgMB float64 `json:"rssAvgMb"`
	RSSMaxMB float64 `json:"rssMaxMb"`
	GPUP95   float64 `json:"gpuP95,omitempty"`
	Samples  int     `json:"samples"`
}

// calibration: gemessener Live-Bedarf, Vorschlag und geltende Reserve je Host plus die typische Last je Node-Typ.
func (m *Module) calibration(w http.ResponseWriter, r *http.Request) {
	cfg := m.Config()
	cals := m.disp.Calibrations()
	typical := map[string][]nodeTypical{}
	if m.Profiles != nil {
		for _, c := range cals {
			pid := c.Host
			if pid == jobrun.LocalHostID {
				pid = "" // Profile des Orchestrator-Hosts tragen eine leere Host-ID
			}
			snaps, err := m.Profiles.List(r.Context(), pid)
			if err != nil {
				continue
			}
			for _, s := range snaps {
				typical[c.Host] = append(typical[c.Host], nodeTypical{NodeType: s.NodeType, CPUAvg: s.CPUAvg, CPUP95: s.CPUP95, CPUMax: s.CPUMax,
					RSSAvgMB: float64(s.RSSAvg) / 1048576, RSSMaxMB: float64(s.RSSMax) / 1048576, GPUP95: s.GPUP95, Samples: s.SampleCount})
			}
		}
	}
	writeJSON(w, 200, map[string]any{"mode": cfg.Calibration.Mode, "config": cfg.Calibration, "hosts": cals, "nodes": typical})
}

// applyCalibration übernimmt den Vorschlag eines Hosts als feste Reserve dieses Hosts ({"host":"<id>"}).
func (m *Module) applyCalibration(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Host string `json:"host"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&body); err != nil || body.Host == "" {
		writeErr(w, 400, "host fehlt")
		return
	}
	var sug *jobrun.Calibration
	for _, c := range m.disp.Calibrations() {
		if c.Host == body.Host {
			c := c
			sug = &c
		}
	}
	if sug == nil || !sug.Enough {
		writeErr(w, 409, "für diesen Host liegt noch kein belastbarer Vorschlag vor")
		return
	}
	cfg := m.Config()
	rs := sug.Suggested
	if body.Host == jobrun.LocalHostID {
		cfg.Local.Reserve = &rs
	} else {
		o := cfg.Hosts[body.Host]
		o.Reserve = &rs
		cfg.Hosts[body.Host] = o
	}
	m.saveConfig(w, r, cfg)
}
