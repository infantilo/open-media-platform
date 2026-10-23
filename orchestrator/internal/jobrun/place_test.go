package jobrun

import (
	"strings"
	"testing"
	"time"
)

func host(id string, cpu float64) HostState {
	return HostState{ID: id, Label: id, Online: true, Capable: true, MaxJobs: 4, CPUPercent: cpu, CPUCores: 8, NetUtil: -1,
		Tools: map[string]ToolCaps{"ffmpeg": {}, "ffprobe": {}}}
}

func spec(args ...string) Spec {
	return Spec{Caller: "qc", Tool: "ffmpeg", Args: args, Class: ClassBatch}
}

func TestTargetParse(t *testing.T) {
	for _, s := range []string{"auto", "local", "host:a", "pool:render"} {
		if _, err := ParseTarget(s); err != nil {
			t.Errorf("%s: %v", s, err)
		}
	}
	for _, s := range []string{"", "host:", "x", "pool"} {
		if _, err := ParseTarget(s); err == nil {
			t.Errorf("%q muss abgelehnt werden", s)
		}
	}
}

func TestZielRangfolge(t *testing.T) {
	c := DefaultConfig()
	c.Defaults = map[string]string{"qc": "auto"}
	c.DefaultTarget = "host:x"
	if g, _ := c.TargetFor(Spec{Caller: "qc", Target: "local"}); g.Kind != "local" {
		t.Error("Job vor Aufrufer")
	}
	if g, _ := c.TargetFor(Spec{Caller: "qc"}); g.Kind != "auto" {
		t.Error("Aufrufer vor System")
	}
	if g, _ := c.TargetFor(Spec{Caller: "script"}); g.String() != "host:x" {
		t.Error("System-Standard")
	}
	if c2, _ := ParseConfig(nil); c2.DefaultTarget != "local" {
		t.Error("Auslieferungswert local")
	}
	if _, err := ParseConfig([]byte(`{"defaultTarget":"kaputt"}`)); err == nil {
		t.Error("ungültiges Standardziel")
	}
}

func TestGleichmaessigeVerteilungUndGleichstand(t *testing.T) {
	cfg := DefaultConfig()
	a, b := host("a", 20), host("b", 20)
	if d := Place(spec(), Target{Kind: "auto"}, []HostState{b, a}, cfg, PlaceCtx{}); d.Host != "a" {
		t.Fatalf("Gleichstand nach ID: %s", d.Host)
	}
	a.Running = 2
	if d := Place(spec(), Target{Kind: "auto"}, []HostState{a, b}, cfg, PlaceCtx{}); d.Host != "b" {
		t.Fatalf("weniger Jobs gewinnt: %s", d.Host)
	}
	// Reservierungen: zehn Zuweisungen nacheinander verteilen sich ~gleichmäßig
	hs := map[string]*HostState{"a": ptr(host("a", 10)), "b": ptr(host("b", 10))}
	cnt := map[string]int{}
	for i := 0; i < 8; i++ {
		d := Place(spec(), Target{Kind: "auto"}, []HostState{*hs["a"], *hs["b"]}, cfg, PlaceCtx{})
		if d.Host == "" {
			t.Fatalf("Zuweisung %d: %s", i, d.Reason)
		}
		cnt[d.Host]++
		hs[d.Host].Reserved++
		hs[d.Host].ReservedCPU += 5
	}
	if cnt["a"] != 4 || cnt["b"] != 4 {
		t.Fatalf("Verteilung %v", cnt)
	}
	// alle Plätze belegt → nichts gewählt, mit Begründung
	d := Place(spec(), Target{Kind: "auto"}, []HostState{*hs["a"], *hs["b"]}, cfg, PlaceCtx{})
	if d.Host != "" || !strings.Contains(d.Reason, "Job-Plätze") {
		t.Fatalf("%+v", d)
	}
}

func ptr(h HostState) *HostState { return &h }

func TestFilter(t *testing.T) {
	cfg := DefaultConfig()
	off := host("off", 0)
	off.Online = false
	mnt := host("mnt", 0)
	mnt.Maintenance = true
	nocap := host("nocap", 0)
	nocap.Capable = false
	live := host("live", 75) // Reserve 30 % → Batch-Grenze 56 %
	good := host("good", 30)
	d := Place(spec(), Target{Kind: "auto"}, []HostState{off, mnt, nocap, live, good}, cfg, PlaceCtx{})
	if d.Host != "good" {
		t.Fatalf("%+v", d)
	}
	rej := map[string]string{}
	for _, c := range d.Candidates {
		rej[c.Host] = c.Rejected
	}
	for h, want := range map[string]string{"off": "offline", "mnt": "Wartung", "nocap": "tools.json", "live": "Live-Reserve CPU"} {
		if !strings.Contains(rej[h], want) {
			t.Errorf("%s: %q enthält nicht %q", h, rej[h], want)
		}
	}
	// interactive darf bis 70 % → auf live (75 %) trotzdem nicht
	s := spec()
	s.Class = ClassInteractive
	mid := host("mid", 65)
	if d := Place(s, Target{Kind: "host", Name: "mid"}, []HostState{mid}, cfg, PlaceCtx{}); d.Host != "mid" {
		t.Errorf("interactive unter Grenze: %+v", d)
	}
	if d := Place(spec(), Target{Kind: "host", Name: "mid"}, []HostState{mid}, cfg, PlaceCtx{}); d.Host != "" {
		t.Errorf("batch über Soft-Grenze muss warten: %+v", d)
	}
}

func TestZieleHostPoolLocal(t *testing.T) {
	cfg := DefaultConfig()
	l := host("local", 10)
	l.Local = true
	a := host("a", 10)
	b := host("b", 10)
	b.Pools = []string{"render"}
	all := []HostState{l, a, b}
	if d := Place(spec(), Target{Kind: "local"}, all, cfg, PlaceCtx{}); d.Host != "local" || len(d.Candidates) != 1 {
		t.Errorf("local: %+v", d)
	}
	if d := Place(spec(), Target{Kind: "pool", Name: "render"}, all, cfg, PlaceCtx{}); d.Host != "b" {
		t.Errorf("pool: %+v", d)
	}
	if d := Place(spec(), Target{Kind: "host", Name: "zz"}, all, cfg, PlaceCtx{}); d.Host != "" || !strings.Contains(d.Reason, "kein Host") {
		t.Errorf("host fehlt: %+v", d)
	}
	// Datenlokalität bevorzugt den lokalen Host bei sonst gleicher Last
	if d := Place(spec(), Target{Kind: "auto"}, all, cfg, PlaceCtx{}); d.Host != "local" {
		t.Errorf("Datenlokalität: %+v", d)
	}
}

func TestLiveNodesUndBatchOnly(t *testing.T) {
	cfg := DefaultConfig()
	a := host("a", 20)
	a.LiveInstances, a.LiveCPUPercent = 5, 20
	b := host("b", 20)
	if d := Place(spec(), Target{Kind: "auto"}, []HostState{a, b}, cfg, PlaceCtx{}); d.Host != "b" {
		t.Fatalf("Host ohne Live-Nodes bevorzugt: %+v", d)
	}
	cfg.LiveHostPolicy = "interactive-only"
	if d := Place(spec(), Target{Kind: "host", Name: "a"}, []HostState{a}, cfg, PlaceCtx{}); d.Host != "" {
		t.Fatalf("interactive-only: %+v", d)
	}
	a.BatchOnly = true
	if d := Place(spec(), Target{Kind: "host", Name: "a"}, []HostState{a}, cfg, PlaceCtx{}); d.Host != "a" {
		t.Fatalf("batchOnly erlaubt: %+v", d)
	}
	n := host("n", 0)
	n.NoBatch = true
	if d := Place(spec(), Target{Kind: "host", Name: "n"}, []HostState{n}, cfg, PlaceCtx{}); d.Host != "" {
		t.Fatalf("noBatch: %+v", d)
	}
}

func TestEncoderUndGPU(t *testing.T) {
	cfg := DefaultConfig()
	tr := TraitsOf(strings.Fields("-hwaccel cuda -c:v h264_cuvid -i in.mxf -c:v h264_nvenc -c:a aac out.mp4"))
	if !tr.UsesGPU || !has(tr.Encoders, "h264_nvenc") || !has(tr.Decoders, "h264_cuvid") || !has(tr.Encoders, "aac") {
		t.Fatalf("%+v", tr)
	}
	if TraitsOf(strings.Fields("-i in.mxf -c:v libx264 -c copy out.mp4")).UsesGPU {
		t.Error("CPU-Encoder ist keine GPU-Nutzung")
	}
	cpu := host("cpu", 5)
	cpu.Tools = map[string]ToolCaps{"ffmpeg": {Encoders: []string{"libx264", "aac"}}}
	gpu := host("gpu", 40)
	gpu.Tools = map[string]ToolCaps{"ffmpeg": {Encoders: []string{"libx264", "h264_nvenc"}, Hwaccels: []string{"cuda"}}}
	gpu.Gpu = &GPUState{UtilPercent: 20}
	s := spec("-i", "in.mxf", "-c:v", "h264_nvenc", "out.mp4")
	d := Place(s, Target{Kind: "auto"}, []HostState{cpu, gpu}, cfg, PlaceCtx{})
	if d.Host != "gpu" {
		t.Fatalf("GPU-Job auf GPU-Host: %+v", d)
	}
	for _, c := range d.Candidates {
		if c.Host == "cpu" && !strings.Contains(c.Rejected, "h264_nvenc") {
			t.Errorf("cpu: %q", c.Rejected)
		}
	}
	// zwei GPU-Hosts: höhere GPU-Last verliert; unbekannt ≠ leer
	g1, g2, g3 := host("g1", 20), host("g2", 20), host("g3", 20)
	for _, h := range []*HostState{&g1, &g2, &g3} {
		h.Tools = gpu.Tools
	}
	g1.Gpu = &GPUState{UtilPercent: 10}
	g2.Gpu = &GPUState{UtilPercent: 60}
	d = Place(s, Target{Kind: "auto"}, []HostState{g3, g2, g1}, cfg, PlaceCtx{})
	if d.Host != "g1" || d.Candidates[1].Host != "g3" {
		t.Fatalf("GPU-Reihenfolge: %+v", d.Candidates)
	}
	g1.Gpu = &GPUState{UtilPercent: 75}
	if d := Place(s, Target{Kind: "host", Name: "g1"}, []HostState{g1}, cfg, PlaceCtx{}); d.Host != "" || !strings.Contains(d.Reason, "GPU") {
		t.Fatalf("GPU-Reserve: %+v", d)
	}
	// Job ohne GPU ignoriert GPU-Last
	g1.Gpu = &GPUState{UtilPercent: 99}
	if d := Place(spec("-i", "a", "-c:v", "libx264", "o.mp4"), Target{Kind: "host", Name: "g1"}, []HostState{g1}, cfg, PlaceCtx{}); d.Host != "g1" {
		t.Fatalf("%+v", d)
	}
}

func TestPfadUndBuchung(t *testing.T) {
	cfg := DefaultConfig()
	a, b := host("a", 10), host("b", 10)
	pc := PlaceCtx{
		PathOK: func(h HostState) (bool, string) { return h.ID != "a", "nicht eingehängt" },
		Busy: func(h HostState, w time.Duration) (bool, string) {
			return h.ID == "b" && w > time.Minute, "Aufnahme 20:00"
		},
	}
	d := Place(spec(), Target{Kind: "auto"}, []HostState{a, b}, cfg, pc)
	if d.Host != "" {
		t.Fatalf("beide ungeeignet: %+v", d)
	}
	s := spec()
	s.EstimateS = 30
	if d := Place(s, Target{Kind: "auto"}, []HostState{a, b}, cfg, pc); d.Host != "b" {
		t.Fatalf("kurzer Job passt vor die Buchung: %+v", d)
	}
}
