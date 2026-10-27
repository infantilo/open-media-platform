package support

import (
	"archive/zip"
	"bytes"
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
