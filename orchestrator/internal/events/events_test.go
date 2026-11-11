package events

import "testing"

type rec struct{ subj []string }

func (r *rec) Publish(s string, _ []byte) error { r.subj = append(r.subj, s); return nil }

func TestCovers(t *testing.T) {
	cases := []struct {
		p, s string
		want bool
	}{
		{"omp.asset.>", "omp.asset.1.created", true},
		{"omp.asset.*.created", "omp.asset.*.created", true},
		{"omp.asset.*.created", "omp.asset.7.created", true},
		{"omp.asset.7.created", "omp.asset.*.created", false},
		{"omp.asset.*", "omp.asset.1.created", false},
		{"omp.>", "omp.>", true},
		{"omp.asset.*", "omp.asset.>", false},
		{"omp.alarm.*", "omp.alarm.host-offline", true},
	}
	for _, c := range cases {
		if got := Covers(c.p, c.s); got != c.want {
			t.Errorf("Covers(%q,%q)=%v, erwartet %v", c.p, c.s, got, c.want)
		}
	}
}

func TestNormalizeAndObserve(t *testing.T) {
	if got := Normalize("omp.ingest.8f3c1a2b-1111-2222-3333-444455556666.completed"); got != "omp.ingest.*.completed" {
		t.Fatalf("Normalize: %s", got)
	}
	if got := Normalize("omp.alarm.host-offline"); got != "omp.alarm.host-offline" {
		t.Fatalf("Normalize: %s", got)
	}
	observed = map[string]*Info{}
	registry = nil
	samples = map[string]*sample{}
	Observe("omp.newthing.abc", []byte(`{"b":1,"a":2}`))
	Observe("omp.newthing.abc", []byte(`{}`))
	l := List()
	if len(l) != 1 || l[0].Count != 2 || !l[0].Observed || len(l[0].Fields) != 2 || l[0].Fields[0].Path != "a" {
		t.Fatalf("Observe: %+v", l)
	}
	Register(Info{Subject: "omp.newthing.*", Group: "x", Label: "Neu"})
	Observe("omp.newthing.xyz", nil) // bereits angemeldet gedeckt
	if l = List(); len(l) != 2 || l[0].Observed {
		t.Fatalf("Register: %+v", l)
	}
}

func TestEmit(t *testing.T) {
	r := &rec{}
	SetPublisher(r)
	defer SetPublisher(nil)
	Emit("omp.x.y", map[string]any{"a": 1})
	if len(r.subj) != 1 || r.subj[0] != "omp.x.y" {
		t.Fatalf("Emit: %v", r.subj)
	}
}

func TestSamplesAndFlatten(t *testing.T) {
	observed, registry, samples = map[string]*Info{}, nil, map[string]*sample{}
	Register(Info{Subject: "omp.ingest.*.completed", Group: "ingest", Label: "x"})
	Observe("omp.ingest.8f3c1a2b-1111-2222-3333-444455556666.completed", []byte(`{"jobId":"j","detail":{"a":1,"b":{"c":2}}}`))
	l := List()
	if len(l) != 1 || l[0].Count != 1 || l[0].LastSeen == nil || len(l[0].Sample) == 0 {
		t.Fatalf("Muster ohne Beispiel: %+v", l)
	}
	p, n, _ := SampleFor("omp.ingest.>")
	if n != 1 || len(p) == 0 {
		t.Fatalf("SampleFor: %s %d", p, n)
	}
	var paths []string
	for _, f := range FlattenFields(p) {
		paths = append(paths, f.Path)
	}
	if len(paths) != 3 || paths[0] != "detail.a" || paths[1] != "detail.b.c" || paths[2] != "jobId" {
		t.Fatalf("Flatten: %v", paths)
	}
}
