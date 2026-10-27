package support

import (
	"archive/zip"
	"bytes"
	"os"
	"strings"
	"testing"
	"time"
)

var now = time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)

func find(r Report, id string) *Check {
	for i := range r.Checks {
		if r.Checks[i].ID == id {
			return &r.Checks[i]
		}
	}
	return nil
}

func TestEvaluateHealthy(t *testing.T) {
	in := Inputs{Local: Local{
		Disks:    []Disk{{Path: "/", Label: "System", FreeBytes: 200 << 30, TotalBytes: 500 << 30}},
		MemTotal: 16 << 30, MemAvailable: 10 << 30, ShmTotal: 8 << 30, ShmFree: 7 << 30,
		Load1: 1, CPUs: 8, OpenFDs: 100, FDLimit: 1024, DatabaseError: "",
	}}
	r := Evaluate(in, "", now)
	if r.Level != LevelOK || r.Errors != 0 || r.Warnings != 0 || r.Summary != "Alles in Ordnung" {
		t.Fatalf("report = %+v", r)
	}
}

func TestEvaluateProblemsSortedAndExplained(t *testing.T) {
	in := Inputs{
		Local: Local{
			Disks:    []Disk{{Path: "/", Label: "System", FreeBytes: 1 << 30, TotalBytes: 100 << 30}},
			MemTotal: 16 << 30, MemAvailable: 512 << 20,
			ShmTotal: 8 << 30, ShmFree: 6 << 30, DatabaseError: "connection refused",
		},
		Hosts:     []Host{{ID: "h1", Label: "Regie", TelemetryAge: 2 * time.Minute}, {ID: "h2", Label: "Cut", TelemetryAge: time.Second, ClockProblem: "Uhr springt"}},
		Instances: []Instance{{Label: "Mixer", Crashed: true}, {Label: "Quelle", RestartCount: 5}},
		Cluster:   Cluster{Known: true, QuorumLost: true, NoLeaderSeconds: 40},
	}
	r := Evaluate(in, "", now)
	if r.Level != LevelErr {
		t.Fatalf("level = %s", r.Level)
	}
	for _, id := range []string{"disk:/", "memory", "database", "cluster", "host:h1", "host:h2", "instances-crashed"} {
		c := find(r, id)
		if c == nil || c.Level != LevelErr || c.Fix == "" {
			t.Errorf("%s: %+v (Fehler mit nächstem Schritt erwartet)", id, c)
		}
	}
	if c := find(r, "instances-restarts"); c == nil || c.Level != LevelWarn {
		t.Errorf("restarts = %+v", c)
	}
	// Fehler stehen vor Hinweisen vor „in Ordnung“.
	last := 0
	for _, c := range r.Checks {
		if rank(c.Level) < last {
			t.Fatalf("nicht nach Schwere sortiert: %v", r.Checks)
		}
		last = rank(c.Level)
	}
}

func TestEvaluateEnglishAndGoodbyeHost(t *testing.T) {
	in := Inputs{Hosts: []Host{{ID: "h", Label: "A", Goodbye: true, TelemetryAge: time.Hour}}}
	r := Evaluate(in, "en", now)
	if r.Level != LevelOK || !strings.Contains(find(r, "host:h").Detail, "stopped on purpose") {
		t.Fatalf("%+v", r)
	}
}

func TestProbeLocalRuns(t *testing.T) {
	l := ProbeLocal([]DiskTarget{{Path: "/", Label: "x"}, {Path: "/nonexistent-dir", Label: "y"}})
	if len(l.Disks) != 2 || l.Disks[0].TotalBytes == 0 || l.Disks[1].Err == "" || l.CPUs == 0 {
		t.Fatalf("%+v", l)
	}
}

func TestRedact(t *testing.T) {
	js := RedactJSON([]byte(`{"user":"anna","password":"hunter2","nested":{"apiToken":"abc","launchSecret":"s","ok":"fine"},
	  "list":[{"msg":"login with token=XYZ123 failed"}],"dsn":"postgres://omp:geheim@db:5432/omp","empty":{"token":""}}`))
	s := string(js)
	for _, bad := range []string{"hunter2", "abc\"", "XYZ123", "geheim", `"s"`} {
		if strings.Contains(s, bad) {
			t.Errorf("%q nicht geschwärzt: %s", bad, s)
		}
	}
	for _, good := range []string{"anna", "fine", "login with token=" + redacted} {
		if !strings.Contains(s, good) {
			t.Errorf("%q fehlt: %s", good, s)
		}
	}
	txt := RedactText("OMP_DB_PASSWORD=abc123\nAuthorization: Bearer eyJhbGciOi.xyz.abc\nurl postgres://u:pw@host/db\n-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\nnormal line")
	for _, bad := range []string{"abc123", "eyJhbGciOi", ":pw@", "AAAA"} {
		if strings.Contains(txt, bad) {
			t.Errorf("%q nicht geschwärzt: %s", bad, txt)
		}
	}
	if got := RedactText("node --api-token abc999 --port 80 --password=xyz"); strings.Contains(got, "abc999") || strings.Contains(got, "xyz") || !strings.Contains(got, "--port 80") {
		t.Errorf("Kommandozeile: %q", got)
	}
	if got := RedactText(`curl -d '{"username":"a","password":"adminpass123"}' -H "x"`); strings.Contains(got, "adminpass123") || !strings.Contains(got, `"username":"a"`) {
		t.Errorf("JSON in Kommandozeile: %q", got)
	}
	if !strings.Contains(txt, "normal line") {
		t.Error("normaler Text verloren")
	}
	if got := string(Redact("x.txt", []byte("not json {"))); got != "not json {" {
		t.Errorf("Text verändert: %q", got)
	}
}

func TestWriteZip(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteZip(&buf, []File{{"a.txt", []byte("hallo")}, {"b/c.json", []byte("{}")}}, now); err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil || len(zr.File) != 2 || zr.File[1].Name != "b/c.json" {
		t.Fatalf("%v %v", zr, err)
	}
}

func TestEvaluateDevProfileAndStaleHost(t *testing.T) {
	in := Inputs{Profile: "dev",
		Findings: []Finding{{ID: "x", Severity: "critical", Message: "Dev-Passwort"}},
		Hosts:    []Host{{ID: "h", Label: "Alt", TelemetryAge: -1}}}
	r := Evaluate(in, "", now)
	if r.Level != LevelWarn || find(r, "profile:x").Level != LevelWarn || find(r, "host:h").Level != LevelWarn {
		t.Fatalf("%+v", r)
	}
	in.Profile = "production"
	if r := Evaluate(in, "", now); find(r, "profile:x").Level != LevelErr {
		t.Fatal("Produktionsprofil muss kritische Befunde als Fehler zeigen")
	}
}

func TestNodesOfflineSameLabelCountedOnce(t *testing.T) {
	r := Evaluate(Inputs{NodesOffline: []string{"Mixer", "Mixer", "Mixer", "Quelle"}}, "", now)
	if d := find(r, "nodes").Detail; d != "Mixer (×3), Quelle" {
		t.Fatalf("Detail = %q", d)
	}
}

func TestEvaluateHostMachineChecks(t *testing.T) {
	sys := Local{Disks: []Disk{{Path: "/", Label: "System", FreeBytes: 1 << 30, TotalBytes: 100 << 30}}, MemTotal: 8 << 30, MemAvailable: 4 << 30}
	r := Evaluate(Inputs{Hosts: []Host{{ID: "h1", Label: "Regie", TelemetryAge: time.Second, Sys: &sys}}}, "", now)
	c := find(r, "host:h1:disk:/")
	if c == nil || c.Level != LevelErr || c.Group != "Hosts: Regie" || c.Fix == "" {
		t.Fatalf("Platte des Hosts: %+v", c)
	}
	if m := find(r, "host:h1:memory"); m == nil || m.Level != LevelOK {
		t.Fatalf("Speicher des Hosts: %+v", m)
	}
}

func nodeLevels(cs []Check) map[string]Level {
	m := map[string]Level{}
	for _, c := range cs {
		m[c.ID] = c.Level
	}
	return m
}

func TestEvaluateNodeHealthyAndBroken(t *testing.T) {
	cpu := 30.0
	ok := EvaluateNode(NodeFacts{Label: "Quelle", Known: true, Online: true,
		Instance:  &InstanceFacts{CPUPercent: &cpu},
		Process:   &ProcessFacts{Threads: 20, OpenFDs: 40, FDLimit: 1024, RSSBytes: 100 << 20, HostMemory: 8 << 30},
		Media:     &MediaFacts{Ready: true, EverReady: true, ObservedSecs: 100, VideoFPS: &Rate{Last: 25, Avg: 25}},
		Pipelines: []PipelineFacts{{Name: "main", State: "Playing", Elements: []ElementFacts{{Name: "q", Factory: "queue", State: "Playing", Level: &QueueLevel{Buffers: 1, MaxBuffers: 200}}}}},
	}, "")
	for _, c := range ok {
		if c.Level != LevelOK {
			t.Errorf("gesund, aber %+v", c)
		}
	}

	hot := 99.0
	bad := EvaluateNode(NodeFacts{Label: "Mixer", Known: true, Online: true,
		Instance: &InstanceFacts{Crashed: true, CrashMessage: "signal: killed", RestartCount: 6, Outdated: true, CPUPercent: &hot},
		Process:  &ProcessFacts{Threads: 900, OpenFDs: 1000, FDLimit: 1024, RSSBytes: 5 << 30, HostMemory: 8 << 30},
		Media:    &MediaFacts{Ready: false, EverReady: true, ObservedSecs: 100},
		Pipelines: []PipelineFacts{{Name: "main", State: "Playing", Elements: []ElementFacts{
			{Name: "enc", State: "Paused"}, {Name: "q", Factory: "queue", State: "Playing", Level: &QueueLevel{Buffers: 200, MaxBuffers: 200}}}}},
		RecentErrors: 4,
	}, "")
	lv := nodeLevels(bad)
	for _, id := range []string{"crashed", "fds", "media", "pipeline-elements:main", "pipeline-queues:main", "cpu", "memory", "threads", "outdated", "errors"} {
		if _, ok := lv[id]; !ok {
			t.Errorf("Befund %s fehlt: %v", id, lv)
		}
	}
	if lv["crashed"] != LevelErr || lv["fds"] != LevelErr || lv["media"] != LevelErr || lv["pipeline-queues:main"] != LevelWarn {
		t.Errorf("Stufen: %v", lv)
	}
	for _, c := range bad {
		if c.Level != LevelOK && c.Fix == "" && c.ID != "errors" {
			t.Errorf("Befund ohne „Was tun?“: %+v", c)
		}
	}
	// Fehler stehen vor Hinweisen vor „in Ordnung“
	last := 0
	for _, c := range bad {
		if rank(c.Level) < last {
			t.Fatalf("nicht sortiert: %v", bad)
		}
		last = rank(c.Level)
	}
}

func TestEvaluateNodeOfflineNeverReadyAndPipelineState(t *testing.T) {
	off := nodeLevels(EvaluateNode(NodeFacts{Label: "X", Known: true, Online: false}, ""))
	if off["online"] != LevelErr {
		t.Fatalf("%v", off)
	}
	unknown := nodeLevels(EvaluateNode(NodeFacts{Label: "X"}, "en"))
	if unknown["registry"] != LevelErr {
		t.Fatalf("%v", unknown)
	}
	// nie bereit gewesen: nur Hinweis (manche Typen melden keine Bereitschaft)
	nr := nodeLevels(EvaluateNode(NodeFacts{Label: "X", Known: true, Online: true, Media: &MediaFacts{Ready: false, ObservedSecs: 60}}, ""))
	if nr["media"] != LevelWarn {
		t.Fatalf("%v", nr)
	}
	// zu kurz beobachtet: noch kein Befund gegen den Node
	young := nodeLevels(EvaluateNode(NodeFacts{Label: "X", Known: true, Online: true, Media: &MediaFacts{Ready: false, ObservedSecs: 3}}, ""))
	if young["media"] != LevelOK {
		t.Fatalf("%v", young)
	}
	pl := nodeLevels(EvaluateNode(NodeFacts{Label: "X", Known: true, Online: true, Pipelines: []PipelineFacts{{Name: "main", State: "Paused"}}}, ""))
	if pl["pipeline:main"] != LevelWarn {
		t.Fatalf("%v", pl)
	}
	// Bildrate: Einbruch und Stillstand
	fps := func(last, avg float64) Level {
		return nodeLevels(EvaluateNode(NodeFacts{Label: "X", Known: true, Online: true, Media: &MediaFacts{Ready: true, EverReady: true, ObservedSecs: 100, VideoFPS: &Rate{Last: last, Avg: avg}}}, ""))["fps"]
	}
	if fps(25, 25) != LevelOK || fps(18, 25) != LevelWarn || fps(0, 25) != LevelErr {
		t.Errorf("fps: %v %v %v", fps(25, 25), fps(18, 25), fps(0, 25))
	}
}

func TestReadProcessOwn(t *testing.T) {
	p, err := ReadProcess(os.Getpid())
	if err != nil || p.Threads < 1 || p.OpenFDs < 3 || p.RSSBytes == 0 || p.HostMemory == 0 {
		t.Fatalf("%+v %v", p, err)
	}
	if _, err := ReadProcess(1 << 30); err == nil {
		t.Fatal("unbekannter Prozess muss einen Fehler liefern")
	}
}

func TestSummary(t *testing.T) {
	if l, s := Summary(nil, ""); l != LevelOK || s != "Alles in Ordnung" {
		t.Fatal(l, s)
	}
	if l, _ := Summary([]Check{{Level: LevelWarn}, {Level: LevelErr}}, "en"); l != LevelErr {
		t.Fatal(l)
	}
}

func TestChecksCarryErrorCodes(t *testing.T) {
	in := Inputs{
		Local:     Local{Disks: []Disk{{Path: "/", Label: "System", FreeBytes: 1 << 30, TotalBytes: 100 << 30}}, DatabaseError: "refused"},
		Hosts:     []Host{{ID: "h1", Label: "A", TelemetryAge: 2 * time.Minute}},
		Instances: []Instance{{Label: "Q", Crashed: true}},
	}
	codes := map[string]string{}
	for _, c := range Evaluate(in, "", now).Checks {
		codes[c.ID] = c.Code
	}
	for id, want := range map[string]string{"disk:/": "OMP-1005", "database": "OMP-1001", "host:h1": "OMP-5001", "instances-crashed": "OMP-2004"} {
		if codes[id] != want {
			t.Errorf("%s: Code %q, erwartet %q", id, codes[id], want)
		}
	}
	// „in Ordnung“ trägt keinen Code
	for _, c := range Evaluate(Inputs{Local: Local{DatabaseError: ""}}, "", now).Checks {
		if c.Level == LevelOK && c.Code != "" {
			t.Errorf("%s: OK mit Code %s", c.ID, c.Code)
		}
	}
	// Absturzmeldung mit genauerem Code: fehlendes Image statt allgemeinem Absturz
	cs := EvaluateNode(NodeFacts{Label: "X", Known: true, Online: true,
		Instance: &InstanceFacts{Crashed: true, CrashMessage: "podman run localhost/x: exit status 125: Trying to pull"}}, "")
	for _, c := range cs {
		if c.ID == "crashed" && c.Code != "OMP-2002" {
			t.Errorf("Absturz mit Image-Meldung: %s", c.Code)
		}
	}
	cs = EvaluateNode(NodeFacts{Label: "X", Known: true, Online: true, Instance: &InstanceFacts{Crashed: true, CrashMessage: "signal: killed"}}, "")
	for _, c := range cs {
		if c.ID == "crashed" && c.Code != "OMP-2004" {
			t.Errorf("Absturz allgemein: %s", c.Code)
		}
	}
}

func TestHostChecksGetSpecificCodes(t *testing.T) {
	in := Inputs{Hosts: []Host{
		{ID: "silent", Label: "A", TelemetryAge: 2 * time.Minute},
		{ID: "clock", Label: "B", TelemetryAge: time.Second, ClockProblem: "unsynced"},
		{ID: "busy", Label: "C", TelemetryAge: time.Second, CPUPercent: 95},
	}}
	codes := map[string]string{}
	for _, c := range Evaluate(in, "", now).Checks {
		codes[c.ID] = c.Code
	}
	if codes["host:silent"] != "OMP-5001" || codes["host:clock"] != "OMP-5002" || codes["host:busy"] != "OMP-1012" {
		t.Fatalf("%v", codes)
	}
}

func TestEvaluateTrendFindings(t *testing.T) {
	in := Inputs{Trends: []TrendFinding{
		{Subject: "instance:omp-source:Kamera", Label: "Kamera", Metric: "proc.rss", Kind: "drift", Unit: "B", Value: 700 << 20, Baseline: 400 << 20, SlopePerHour: 25 << 20, Hours: 12, HoursToLimit: 40},
		{Subject: "host:h1", Label: "Regie-Host-A", Metric: "host.cpu", Kind: "deviation", Unit: "%", Value: 85, Baseline: 30},
	}}
	r := Evaluate(in, "", now)
	if r.Level != LevelWarn || r.Warnings != 2 {
		t.Fatalf("%+v", r)
	}
	var drift, dev *Check
	for i := range r.Checks {
		switch r.Checks[i].Code {
		case "OMP-1014":
			drift = &r.Checks[i]
		case "OMP-1013":
			dev = &r.Checks[i]
		}
	}
	if drift == nil || dev == nil {
		t.Fatalf("Codes fehlen: %+v", r.Checks)
	}
	if drift.Group != "Trends" || !strings.Contains(drift.Title, "Kamera: Speicher wächst stetig") || !strings.Contains(drift.Detail, "seit 12 Stunden") || !strings.Contains(drift.Detail, "25 MiB/h") || !strings.Contains(drift.Detail, "40 Stunden") {
		t.Errorf("Drift: %+v", drift)
	}
	if !strings.Contains(dev.Title, "Regie-Host-A: Prozessorlast ungewöhnlich hoch") || !strings.Contains(dev.Detail, "jetzt 85 %") || !strings.Contains(dev.Detail, "üblich sind 30 %") || dev.Fix == "" {
		t.Errorf("Abweichung: %+v", dev)
	}
	en := Evaluate(in, "en", now)
	if !strings.Contains(en.Checks[0].Title+en.Checks[1].Title, "keeps growing") {
		t.Errorf("englisch: %+v", en.Checks)
	}
}
