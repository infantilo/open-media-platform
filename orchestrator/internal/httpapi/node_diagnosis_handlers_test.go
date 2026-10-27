package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/support"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/timeline"
)

func diagTestMux(pipelines func(w http.ResponseWriter)) *http.ServeMux {
	mux := http.NewServeMux()
	serve := func(path, body string) {
		mux.HandleFunc("GET "+path, func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer caller-token" {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			io.WriteString(w, body)
		})
	}
	serve("/api/v1/nodes", `[{"id":"n1","label":"Mixer","online":true,"instance_id":"i1"},{"id":"n2","label":"Fremd","online":true}]`)
	serve("/api/v1/instances", `[{"id":"i1","type":"omp-video-mixer-me","label":"Mixer","pid":0,"restartCount":4,"cpuPercent":97.5}]`)
	serve("/api/v1/kpi/media", `{"nodes":[{"nodeId":"n1","currentlyReady":true,"availability":1,"observedSeconds":300,"rates":{"video_fps":{"last":12,"avg":25,"min":10}}}]}`)
	mux.HandleFunc("GET /api/v1/nodes/{id}/diag/pipelines", func(w http.ResponseWriter, r *http.Request) {
		if r.PathValue("id") != "n1" {
			http.NotFound(w, r)
			return
		}
		pipelines(w)
	})
	return mux
}

func TestNodeDiagnosisCollectsFactsAndFindings(t *testing.T) {
	db := dbtest.Open(t)
	if _, err := db.Exec(`TRUNCATE timeline_events`); err != nil {
		t.Fatal(err)
	}
	store := timeline.NewStore(db)
	now := time.Now()
	_ = store.Insert(timeline.Event{At: now.Add(-time.Minute), Kind: "instance.restarted", Severity: timeline.SevWarn, Subject: "i1", Data: map[string]any{"label": "Mixer"}})
	_ = store.Insert(timeline.Event{At: now.Add(-2 * time.Minute), Kind: "node.notready", Severity: timeline.SevError, Subject: "n1"})
	_ = store.Insert(timeline.Event{At: now.Add(-time.Minute), Kind: "instance.crashed", Severity: timeline.SevError, Subject: "anderer"}) // fremder Node: darf nicht erscheinen
	src := &timeline.Sources{Store: store}

	mux := diagTestMux(func(w http.ResponseWriter) {
		io.WriteString(w, `{"pipelines":[{"name":"main","state":"Playing","elements":[
		  {"name":"enc","factory":"x264enc","state":"Paused"},
		  {"name":"q","factory":"queue","state":"Playing","level":{"buffers":200,"maxBuffers":200}}]}]}`)
	})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/nodes/n1/diagnosis", nil)
	req.Header.Set("Authorization", "Bearer caller-token")
	req.SetPathValue("id", "n1")
	rec := httptest.NewRecorder()
	handleNodeDiagnosis(mux, src)(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatal(rec.Code, rec.Body.String())
	}
	var d nodeDiagnosis
	if err := json.Unmarshal(rec.Body.Bytes(), &d); err != nil {
		t.Fatal(err)
	}
	if d.Node.Label != "Mixer" || !d.Node.Online || d.Node.InstanceID != "i1" || d.Node.Type != "omp-video-mixer-me" {
		t.Fatalf("node %+v", d.Node)
	}
	ids := map[string]support.Level{}
	for _, c := range d.Findings {
		ids[c.ID] = c.Level
	}
	for id, lv := range map[string]support.Level{"restarts": support.LevelWarn, "cpu": support.LevelWarn, "fps": support.LevelWarn,
		"pipeline-elements:main": support.LevelWarn, "pipeline-queues:main": support.LevelWarn, "online": support.LevelOK} {
		if ids[id] != lv {
			t.Errorf("%s = %q, erwartet %q (alle: %v)", id, ids[id], lv, ids)
		}
	}
	if d.Level != support.LevelWarn || len(d.Pipelines) == 0 || d.PipelinesNote != "" {
		t.Errorf("level %s, pipelines %d, note %q", d.Level, len(d.Pipelines), d.PipelinesNote)
	}
	var kinds []string
	for _, it := range d.Timeline {
		kinds = append(kinds, it.Kind)
	}
	if len(kinds) != 2 || kinds[0] != "instance.restarted" || kinds[1] != "node.notready" {
		t.Errorf("Ereignisse nur dieses Nodes, neueste zuerst: %v", kinds)
	}
}

func TestNodeDiagnosisUnsupportedPipelineUnknownNodeAndNoAuth(t *testing.T) {
	mux := diagTestMux(func(w http.ResponseWriter) { http.NotFound(w, nil) })
	get := func(id, token string) nodeDiagnosis {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/nodes/"+id+"/diagnosis", nil)
		if token != "" {
			req.Header.Set("Authorization", token)
		}
		req.SetPathValue("id", id)
		rec := httptest.NewRecorder()
		handleNodeDiagnosis(mux, nil)(rec, req)
		var d nodeDiagnosis
		_ = json.Unmarshal(rec.Body.Bytes(), &d)
		return d
	}
	// Node ohne Pipeline-Anmeldung (Antwort 404): Erklärung statt Fehler
	if d := get("n2", "Bearer caller-token"); d.PipelinesNote != "unsupported" || d.Node.Label != "Fremd" {
		t.Errorf("%+v", d)
	}
	// unbekannter Node: rote Meldung „nicht in der Registry“
	d := get("gibtsnicht", "Bearer caller-token")
	if d.Level != support.LevelErr || d.Node.Known || d.PipelinesNote != "offline" {
		t.Errorf("%+v", d)
	}
	// ohne Anmeldedaten sieht die Diagnose nichts (Rechte des Aufrufers, kein Umweg)
	if d := get("n2", ""); d.Node.Known {
		t.Errorf("ohne Anmeldung sichtbar: %+v", d.Node)
	}
}
