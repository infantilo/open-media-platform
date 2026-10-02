package materialize

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/asset"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/process"
)

type fakeAssets struct {
	assets map[string]asset.Asset
	reps   map[string]asset.Representation
}

func (f fakeAssets) GetAsset(id string) (asset.Asset, error) {
	a, ok := f.assets[id]
	if !ok {
		return asset.Asset{}, asset.ErrNotFound
	}
	return a, nil
}
func (f fakeAssets) GetRepresentation(id string) (asset.Representation, error) {
	r, ok := f.reps[id]
	if !ok {
		return asset.Representation{}, asset.ErrNotFound
	}
	return r, nil
}
func (f fakeAssets) ListRepresentations(v string) ([]asset.Representation, error) {
	var out []asset.Representation
	for _, r := range f.reps {
		if r.AssetVersionID == v {
			out = append(out, r)
		}
	}
	return out, nil
}

func ip(v int64) *int64 { return &v }

func setup(t *testing.T, content string, mutate func(*asset.Representation)) (*Manager, Ref, Target, string) {
	t.Helper()
	srcDir, mediaDir := t.TempDir(), t.TempDir()
	srcFile := filepath.Join(srcDir, "clip.mxf")
	if err := os.WriteFile(srcFile, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(content))
	rep := asset.Representation{ID: "r1", AssetVersionID: "v1", Type: "playout", Storage: asset.StorageLocation{Provider: "filesystem", URI: srcFile},
		SizeBytes: ip(int64(len(content))), Checksum: "sha256:" + hex.EncodeToString(sum[:])}
	if mutate != nil {
		mutate(&rep)
	}
	a := fakeAssets{assets: map[string]asset.Asset{"a1": {ID: "a1", Title: "Clip", CurrentVersionID: "v1"}}, reps: map[string]asset.Representation{"r1": rep}}
	return NewManager(a, nil), Ref{AssetID: "a1"}, Target{MediaDir: mediaDir}, srcFile
}

func waitState(t *testing.T, m *Manager, ref Ref, tg Target, want string) Result {
	t.Helper()
	var res Result
	for i := 0; i < 200; i++ {
		res = m.Check(ref, tg, nil)
		if res.State == want {
			return res
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("Zustand %s nicht erreicht, zuletzt %+v", want, res)
	return res
}

func TestFileNameAndRepresentationPick(t *testing.T) {
	for in, want := range map[string]string{"/mnt/a/clip.mxf": "clip.mxf", "s3://b/x/y/clip.mov?sig=1": "clip.mov", "https://h/a/b.mp4#t": "b.mp4", "": "", "/": "", "/a/..": ""} {
		if got := FileNameOf(in); got != want {
			t.Errorf("FileNameOf(%q) = %q, want %q", in, got, want)
		}
	}
	reps := []asset.Representation{
		{ID: "p", Type: "proxy", Storage: asset.StorageLocation{URI: "/x/p.mp4"}},
		{ID: "o", Type: "original", Storage: asset.StorageLocation{URI: "/x/o.mxf"}},
		{ID: "n", Type: "thumbnail"},
	}
	if r, ok := PickRepresentation(reps, ""); !ok || r.ID != "o" {
		t.Fatalf("Vorzugsreihenfolge: %+v", r)
	}
	if r, ok := PickRepresentation(reps, "proxy"); !ok || r.ID != "p" {
		t.Fatalf("gewünschter Typ: %+v", r)
	}
	if _, ok := PickRepresentation(reps, "playout"); ok {
		t.Fatal("gewünschter Typ fehlt → nichts (kein stiller Ersatz)")
	}
}

func TestResolveRejectsBadRefsAndMissingRepresentation(t *testing.T) {
	m, _, tg, _ := setup(t, "x", nil)
	if _, _, err := Resolve(m.Assets, Ref{}, tg); !errors.Is(err, ErrBadRef) {
		t.Fatal(err)
	}
	if _, _, err := Resolve(m.Assets, Ref{AssetID: "gibts-nicht"}, tg); err == nil {
		t.Fatal("unbekanntes Asset")
	}
	if _, _, err := Resolve(m.Assets, Ref{AssetID: "a1", VersionID: "v-leer"}, tg); !errors.Is(err, ErrNoRepresentation) {
		t.Fatalf("Version ohne Representation: %v", err)
	}
}

func TestPreflightMaterializeAndReady(t *testing.T) {
	m, ref, tg, _ := setup(t, "MXF-INHALT", nil)
	res := m.Check(ref, tg, nil)
	if res.State != StateRemoteOnly || !res.Materializable || res.FileName != "clip.mxf" {
		t.Fatalf("vor der Materialisierung: %+v", res)
	}
	spec, _, _ := Resolve(m.Assets, ref, tg)
	m.Ensure(spec)
	res = waitState(t, m, ref, tg, StateReady)
	if res.Progress != 0 {
		t.Fatalf("%+v", res)
	}
	b, err := os.ReadFile(filepath.Join(tg.MediaDir, "clip.mxf"))
	if err != nil || string(b) != "MXF-INHALT" {
		t.Fatalf("Datei im Medienverzeichnis: %q %v", b, err)
	}
	if _, err := os.Stat(filepath.Join(tg.MediaDir, "clip.mxf.part")); err == nil {
		t.Fatal(".part-Datei darf nicht zurückbleiben")
	}
	// Ensure ist idempotent: erneuter Aufruf startet keinen neuen Job.
	if j := m.Ensure(spec); j.State != "done" {
		t.Fatalf("%+v", j)
	}
}

func TestChecksumAndSizeMismatchFailAndLeaveNoFile(t *testing.T) {
	for name, mutate := range map[string]func(*asset.Representation){
		"Prüfsumme": func(r *asset.Representation) {
			r.Checksum = "sha256:" + string(make([]byte, 0)) + hex.EncodeToString(make([]byte, 32))
		},
		"Größe": func(r *asset.Representation) { r.SizeBytes = ip(999) },
	} {
		m, ref, tg, _ := setup(t, "INHALT", mutate)
		spec, _, _ := Resolve(m.Assets, ref, tg)
		m.Ensure(spec)
		res := waitState(t, m, ref, tg, StateFailed)
		if res.Detail == "" || !res.Materializable {
			t.Fatalf("%s: %+v", name, res)
		}
		if _, err := os.Stat(filepath.Join(tg.MediaDir, "clip.mxf")); err == nil {
			t.Fatalf("%s: unvollständige/falsche Datei darf nicht als fertig im Medienverzeichnis liegen", name)
		}
		// Wiederholung ist möglich (neuer Job).
		if j := m.Ensure(spec); j.State != "running" && j.State != "failed" {
			t.Fatalf("%s: %+v", name, j)
		}
	}
}

func TestMissingSourceAndRemoteTarget(t *testing.T) {
	m, ref, tg, src := setup(t, "x", nil)
	_ = os.Remove(src)
	if res := m.Check(ref, tg, nil); res.State != StateMissing || res.Detail == "" {
		t.Fatalf("Quelle fehlt: %+v", res)
	}
	m2, ref2, _, _ := setup(t, "x", nil)
	remote := Target{HostID: "h1", MediaDir: "/mnt/media"}
	res := m2.Check(ref2, remote, nil)
	if res.State != StateRemoteOnly || res.Materializable {
		t.Fatalf("Remote-Ziel: nur prüfbar, nicht beschreibbar: %+v", res)
	}
	spec, _, _ := Resolve(m2.Assets, ref2, remote)
	m2.Ensure(spec)
	if res := waitState(t, m2, ref2, remote, StateFailed); res.Materializable {
		t.Fatalf("%+v", res)
	}
}

type fakeHosts struct{ exists bool }

func (f fakeHosts) CheckFileOnHost(string, string) (bool, error) { return f.exists, nil }

func TestRemoteTargetReadyWhenTheHostHasTheFile(t *testing.T) {
	m, ref, _, _ := setup(t, "x", nil)
	if res := m.Check(ref, Target{HostID: "h1", MediaDir: "/mnt/media"}, fakeHosts{exists: true}); res.State != StateReady {
		t.Fatalf("%+v", res)
	}
}

func TestExistingMatchingFileIsNotCopiedAgain(t *testing.T) {
	m, ref, tg, src := setup(t, "ABC", nil)
	dst := filepath.Join(tg.MediaDir, "clip.mxf")
	_ = os.WriteFile(dst, []byte("ABC"), 0o644)
	if res := m.Check(ref, tg, nil); res.State != StateReady {
		t.Fatalf("%+v", res)
	}
	_ = os.Remove(src) // Quelle weg: der Job darf trotzdem nicht scheitern, die Datei ist ja schon da
	spec, _, _ := Resolve(m.Assets, ref, tg)
	if j := m.Ensure(spec); j.State == "failed" {
		t.Fatalf("%+v", j)
	}
	time.Sleep(50 * time.Millisecond)
	if j, _ := m.Get(spec.Key()); j.State != "done" {
		t.Fatalf("%+v", j)
	}
}

func TestEstimateUsesMeasuredThroughput(t *testing.T) {
	m := NewManager(fakeAssets{}, nil)
	if m.Estimate(60<<20) != 2*time.Second {
		t.Fatalf("Default 30 MB/s: %v", m.Estimate(60<<20))
	}
	if m.Estimate(0) != 0 {
		t.Fatal("unbekannte Größe")
	}
	j := &Job{StartedAt: time.Unix(0, 0), Bytes: 100 << 20}
	m.Now = func() time.Time { return time.Unix(2, 0) } // 50 MB/s
	m.finish(j, nil)
	if got := m.Throughput(); got < 49<<20 || got > 51<<20 {
		t.Fatalf("gemessener Durchsatz: %v", got)
	}
}

func TestExecutorWaitsThenSucceedsAndReportsFailure(t *testing.T) {
	m, ref, tg, _ := setup(t, "DATA", nil)
	spec, _, _ := Resolve(m.Assets, ref, tg)
	in, _ := json.Marshal(spec)
	ex := Executor{Manager: m}
	ec := process.ExecutionCtx{Execution: process.ProcessExecution{Input: in}}
	var out json.RawMessage
	var err error
	for i := 0; i < 200; i++ {
		out, err = ex.Execute(context.Background(), ec, process.Step{})
		if !errors.Is(err, process.ErrStepWaiting) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil || len(out) == 0 {
		t.Fatalf("%s %v", out, err)
	}
	if _, err := ex.Execute(context.Background(), process.ExecutionCtx{Execution: process.ProcessExecution{Input: []byte(`{}`)}}, process.Step{}); err == nil {
		t.Fatal("ungültige Eingabe muss ein Fehler sein")
	}
	// Fehlerfall wird als Fehler des Schritts gemeldet.
	m2, ref2, tg2, src2 := setup(t, "DATA", nil)
	_ = os.Remove(src2)
	spec2, _, _ := Resolve(m2.Assets, ref2, tg2)
	in2, _ := json.Marshal(spec2)
	var err2 error
	for i := 0; i < 200; i++ {
		_, err2 = Executor{Manager: m2}.Execute(context.Background(), process.ExecutionCtx{Execution: process.ProcessExecution{Input: in2}}, process.Step{})
		if err2 != nil && !errors.Is(err2, process.ErrStepWaiting) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err2 == nil || errors.Is(err2, process.ErrStepWaiting) {
		t.Fatalf("fehlende Quelle muss den Schritt fehlschlagen lassen: %v", err2)
	}
}
