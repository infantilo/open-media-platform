package freeze

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/blackbox"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
)

func openStore(t *testing.T) *Store {
	db := dbtest.Open(t)
	if _, err := db.Exec(`TRUNCATE freezes`); err != nil {
		t.Fatal(err)
	}
	return NewStore(db)
}

func fakeDeps(box *blackbox.Recorder) Deps {
	return Deps{
		Timeline: func(since, until time.Time) (any, error) { return []string{"ereignis"}, nil },
		Logs: func(since, until time.Time) (any, error) {
			return []map[string]string{{"message": "login password=hunter2 failed"}}, nil
		},
		Nodes:     func() (any, error) { return []string{"n1"}, nil },
		Instances: func() (any, error) { return nil, errors.New("launcher down") },
		Pipelines: func(ctx context.Context, scope []string, max int) (map[string][]byte, error) {
			return map[string][]byte{"Kamera.json": []byte(`{"pipelines":[{"name":"main","state":"Playing"}]}`)}, nil
		},
		Box: box,
	}
}

func readZip(t *testing.T, data []byte) map[string]string {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, f := range zr.File {
		rc, _ := f.Open()
		b, _ := io.ReadAll(rc)
		rc.Close()
		out[f.Name] = string(b)
	}
	return out
}

func TestFreezeBuildsRedactedZipAndReportsMissingParts(t *testing.T) {
	box := blackbox.New()
	ready := true
	box.Record("n1", "Kamera", &ready, map[string]float64{"video_fps": 25}, time.Now())
	f := New(fakeDeps(box), openStore(t))
	var announced Meta
	f.OnFrozen = func(m Meta) { announced = m }
	m, err := f.Freeze(context.Background(), Request{By: "anna", Note: "  Bild weg  ", Window: 5 * time.Minute, Scope: []string{"n1"}})
	if err != nil {
		t.Fatal(err)
	}
	if m.WindowMinutes != 5 || m.Trigger != "manual" || m.Note != "Bild weg" || m.SizeBytes == 0 || announced.ID != m.ID {
		t.Fatalf("%+v / %+v", m, announced)
	}
	_, data, err := f.Store.Get(context.Background(), m.ID)
	if err != nil {
		t.Fatal(err)
	}
	files := readZip(t, data)
	for _, name := range []string{"meta.json", "README.txt", "timeline.json", "logs.json", "series/nodes.json", "series/processes.json", "state/nodes.json", "pipelines/Kamera.json"} {
		if _, ok := files[name]; !ok {
			t.Errorf("%s fehlt: %v", name, keys(files))
		}
	}
	if _, ok := files["state/instances.json"]; ok {
		t.Error("fehlgeschlagene Quelle darf keine Datei erzeugen")
	}
	var meta struct {
		Failed map[string]string `json:"failed"`
		Scope  []string          `json:"scope"`
	}
	_ = json.Unmarshal([]byte(files["meta.json"]), &meta)
	if meta.Failed["state/instances.json"] != "launcher down" || len(meta.Scope) != 1 {
		t.Errorf("meta: %s", files["meta.json"])
	}
	if strings.Contains(files["logs.json"], "hunter2") || !strings.Contains(files["logs.json"], "[entfernt]") {
		t.Errorf("Passwort nicht geschwärzt: %s", files["logs.json"])
	}
	if !strings.Contains(files["series/nodes.json"], `"video_fps": 25`) {
		t.Errorf("Messreihe fehlt: %s", files["series/nodes.json"])
	}
}

func keys(m map[string]string) []string {
	var k []string
	for n := range m {
		k = append(k, n)
	}
	return k
}

func TestClampWindow(t *testing.T) {
	for in, want := range map[time.Duration]time.Duration{0: DefaultWindow, time.Second: MinWindow, 7 * time.Minute: 7 * time.Minute, time.Hour: MaxWindow} {
		if got := ClampWindow(in); got != want {
			t.Errorf("%v → %v, erwartet %v", in, got, want)
		}
	}
}

func TestAutoFreezeDebouncesAndOnlyForFaults(t *testing.T) {
	var n atomic.Int32
	f := New(Deps{Timeline: func(time.Time, time.Time) (any, error) { n.Add(1); return nil, nil }}, openStore(t))
	f.AutoDelay = 0
	base := time.Now()
	f.now = func() time.Time { return base }
	f.Observe("node.ready", "Q")          // kein Auslöser
	f.Observe("host.resumed", "A")        // kein Auslöser
	f.Observe("instance.crashed", "Q")    // löst aus
	f.Observe("node.notready", "Q")       // innerhalb der Sperrzeit
	f.Observe("workflow.failover", "WF1") // innerhalb der Sperrzeit
	if n.Load() != 1 {
		t.Fatalf("Momentaufnahmen: %d, erwartet 1", n.Load())
	}
	f.now = func() time.Time { return base.Add(6 * time.Minute) }
	f.Observe("host.silent", "Host A")
	if n.Load() != 2 {
		t.Fatalf("nach der Sperrzeit: %d, erwartet 2", n.Load())
	}
	list, _ := f.Store.List(context.Background(), 10)
	if len(list) != 2 || list[0].Trigger != "auto" || !strings.HasPrefix(list[0].Reason, "host.silent") {
		t.Fatalf("%+v", list)
	}
	f.AutoEnabled = false
	f.now = func() time.Time { return base.Add(20 * time.Minute) }
	f.Observe("instance.crashed", "Q")
	if n.Load() != 2 {
		t.Error("abgeschaltete Automatik hat ausgelöst")
	}
}

func TestStoreLimitsAndDelete(t *testing.T) {
	s := openStore(t)
	ctx := context.Background()
	mk := func(id, trigger string, age time.Duration) Meta {
		return Meta{ID: id, CreatedAt: time.Now().Add(-age), Trigger: trigger, WindowMinutes: 10}
	}
	for i := 0; i < MaxAutoKept+5; i++ {
		if err := s.Create(ctx, mk("a"+string(rune('a'+i)), "auto", time.Duration(i)*time.Minute), []byte("x")); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Create(ctx, mk("von-hand", "manual", 90*time.Minute), []byte("x")); err != nil {
		t.Fatal(err)
	}
	list, _ := s.List(ctx, 100)
	autos, manual := 0, 0
	for _, m := range list {
		if m.Trigger == "auto" {
			autos++
		} else {
			manual++
		}
	}
	if autos != MaxAutoKept || manual != 1 {
		t.Errorf("auto %d (erwartet %d), manuell %d — die von Hand angelegte darf nie von Automatik verdrängt werden", autos, MaxAutoKept, manual)
	}
	// zu alt wird gelöscht, zu groß wird abgelehnt
	if err := s.Create(ctx, mk("uralt", "manual", 40*24*time.Hour), []byte("x")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Get(ctx, "uralt"); !errors.Is(err, ErrUnknown) {
		t.Errorf("uralt bleibt: %v", err)
	}
	if err := s.Create(ctx, mk("riesig", "manual", 0), make([]byte, MaxBytes+1)); !errors.Is(err, ErrTooLarge) {
		t.Errorf("zu groß: %v", err)
	}
	if err := s.Delete(ctx, "von-hand"); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(ctx, "von-hand"); !errors.Is(err, ErrUnknown) {
		t.Errorf("zweimal löschen: %v", err)
	}
}
