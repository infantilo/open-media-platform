package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/materialize"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/playout"
)

type fakePreflight struct {
	result  materialize.Result
	gotRef  materialize.Ref
	gotTgt  materialize.Target
	started []materialize.Spec
}

func (f *fakePreflight) Check(ref materialize.Ref, t materialize.Target, _ materialize.HostPaths) materialize.Result {
	f.gotRef, f.gotTgt = ref, t
	return f.result
}
func (f *fakePreflight) Resolve(ref materialize.Ref, t materialize.Target) (materialize.Spec, error) {
	return materialize.Spec{Ref: ref, RepresentationID: "r1", FileName: "clip.mxf", Target: t}, nil
}
func (f *fakePreflight) Start(spec materialize.Spec, _ string) (string, error) {
	f.started = append(f.started, spec)
	return "exec-1", nil
}

func preflightFixture() (*fakePlayout, optLauncher, *memValues) {
	svc := &fakePlayout{ch: playout.Channel{ID: "ch1", Name: "National", Instance: "inst-1"}}
	l := optLauncher{fakeLauncherService: fakeLauncherService{
		catalog:   []launcher.CatalogEntry{{Type: "omp-mxf-player", Label: "MXF"}},
		instances: []launcher.Instance{{ID: "p1", Type: "omp-mxf-player", Label: "Player A", PID: 3}, {ID: "p2", Type: "omp-mxf-player", Label: "Player R", PID: 4, HostID: "h1"}},
	}}
	return svc, l, &memValues{m: map[string]string{}}
}

func TestPreflightResolvesTheTargetMediaDirFromInstanceThenTypeThenDefault(t *testing.T) {
	svc, l, vals := preflightFixture()
	fp := &fakePreflight{result: materialize.Result{State: materialize.StateRemoteOnly, Materializable: true}}
	h := handlePlayoutPreflight(fp, svc, fakeVerbs{}, nil, l, vals)
	call := func() map[string]any {
		w := httptest.NewRecorder()
		h(w, playoutReq("POST", "/x", `{"target":{"nodeLabel":"Player A"},"items":[{"key":"i1","assetId":"a1"}]}`, "inst-1"))
		if w.Code != http.StatusOK {
			t.Fatalf("%d %s", w.Code, w.Body)
		}
		var out map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return out
	}
	call()
	if !strings.HasSuffix(fp.gotTgt.MediaDir, "/data/media") || fp.gotTgt.MediaDir[0] != '/' {
		t.Fatalf("Standard der Option, relativ → absolut ab Arbeitsverzeichnis: %q", fp.gotTgt.MediaDir)
	}
	_ = vals.Set("type", "omp-mxf-player", "OMP_MEDIA_DIR", "/mnt/typ", "t")
	call()
	if fp.gotTgt.MediaDir != "/mnt/typ" || fp.gotTgt.HostID != "" {
		t.Fatalf("Typ-Wert: %+v", fp.gotTgt)
	}
	_ = vals.Set("instance", "p1", "OMP_MEDIA_DIR", "/mnt/inst", "t")
	call()
	if fp.gotTgt.MediaDir != "/mnt/inst" {
		t.Fatalf("Instanz-Wert gewinnt: %+v", fp.gotTgt)
	}
	// Remote-Instanz: Host wird mitgegeben.
	_ = vals.Set("instance", "p2", "OMP_MEDIA_DIR", "/mnt/remote", "t")
	w := httptest.NewRecorder()
	h(w, playoutReq("POST", "/x", `{"target":{"nodeLabel":"Player R"},"items":[{"key":"i1","assetId":"a1"}]}`, "inst-1"))
	if w.Code != 200 || fp.gotTgt.HostID != "h1" || fp.gotTgt.MediaDir != "/mnt/remote" {
		t.Fatalf("%d %+v", w.Code, fp.gotTgt)
	}
	// Fehler: unbekanntes Ziel, fehlende Items, fremde Instanz.
	for name, c := range map[string]struct {
		body, user string
		want       int
	}{
		"Ziel unbekannt": {`{"target":{"nodeLabel":"Nix"},"items":[{"key":"i","assetId":"a"}]}`, "inst-1", 400},
		"ohne Items":     {`{"target":{"nodeLabel":"Player A"},"items":[]}`, "inst-1", 400},
		"fremd":          {`{"target":{"nodeLabel":"Player A"},"items":[{"key":"i","assetId":"a"}]}`, "inst-2", 403},
	} {
		w := httptest.NewRecorder()
		h(w, playoutReq("POST", "/x", c.body, c.user))
		if w.Code != c.want {
			t.Errorf("%s: %d %s", name, w.Code, w.Body)
		}
	}
}

func TestMaterializeStartsOnlyWhenNeededAndPossible(t *testing.T) {
	svc, l, vals := preflightFixture()
	fp := &fakePreflight{}
	h := handlePlayoutMaterialize(fp, svc, fakeVerbs{}, nil, l, vals, nil)
	_ = vals.Set("type", "omp-mxf-player", "OMP_MEDIA_DIR", "/mnt/typ", "t")
	body := `{"target":{"nodeLabel":"Player A"},"item":{"key":"i1","assetId":"a1"}}`
	post := func() *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		h(w, playoutReq("POST", "/x", body, "inst-1"))
		return w
	}
	fp.result = materialize.Result{State: materialize.StateRemoteOnly, Materializable: true}
	if w := post(); w.Code != http.StatusAccepted || len(fp.started) != 1 || !strings.Contains(w.Body.String(), "exec-1") {
		t.Fatalf("starten: %d %s", w.Code, w.Body)
	}
	for _, st := range []string{materialize.StateReady, materialize.StateTransferring} {
		fp.result = materialize.Result{State: st}
		if w := post(); w.Code != http.StatusOK || len(fp.started) != 1 {
			t.Fatalf("%s: kein neuer Prozess: %d", st, w.Code)
		}
	}
	fp.result = materialize.Result{State: materialize.StateMissing, Detail: "Quelle weg"}
	if w := post(); w.Code != http.StatusConflict {
		t.Fatalf("MISSING: %d", w.Code)
	}
	fp.result = materialize.Result{State: materialize.StateRemoteOnly, Materializable: false, Detail: "Remote"}
	if w := post(); w.Code != http.StatusConflict || len(fp.started) != 1 {
		t.Fatalf("nicht materialisierbar: %d", w.Code)
	}
}
