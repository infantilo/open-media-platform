package analyze

import (
	"bytes"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/support"
)

func zipOf(t *testing.T, m map[string]string) []byte {
	var fs []support.File
	for k, v := range m {
		fs = append(fs, support.File{Name: k, Data: []byte(v)})
	}
	var b bytes.Buffer
	if err := support.WriteZip(&b, fs, time.Now()); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func TestFreezeAnalysis(t *testing.T) {
	z := zipOf(t, map[string]string{
		"meta.json":         `{"trigger":"auto","reason":"Medien weg","from":"2026-10-28T10:00:00Z","to":"2026-10-28T10:10:00Z","failed":{"graph":"timeout"}}`,
		"timeline.json":     `[{"at":"2026-10-28T10:05:00Z","source":"event","kind":"node.crashed","severity":"error","subject":"cam1"}]`,
		"series/nodes.json": `[{"id":"n1","label":"Cam","samples":[{"t":"2026-10-28T10:00:00Z","ready":true},{"t":"2026-10-28T10:01:00Z","ready":false},{"t":"2026-10-28T10:02:00Z","ready":true}]}]`,
		"logs.json":         `[{"occurredAt":"2026-10-28T10:01:00Z","level":"error","message":"x 12 failed","source":"orchestrator"},{"occurredAt":"2026-10-28T10:02:00Z","level":"error","message":"x 13 failed","source":"orchestrator"}]`,
	})
	r, err := Analyze(z, "de")
	if err != nil {
		t.Fatal(err)
	}
	if r.Kind != KindFreeze || r.Verdict != "err" || len(r.Outages) != 1 || r.Outages[0].Seconds != 60 {
		t.Fatalf("%+v", r)
	}
	if len(r.LogGroups) != 1 || r.LogGroups[0].Count != 2 {
		t.Fatalf("log groups %+v", r.LogGroups)
	}
	if !strings.Contains(Markdown(r, "de"), "node.crashed") {
		t.Fatal("markdown lacks timeline")
	}
}

func TestBundleAndRejects(t *testing.T) {
	z := zipOf(t, map[string]string{
		"manifest.json": `{"createdAt":"2026-10-28T10:00:00Z","window":"120 min"}`,
		"selftest.json": `{"checks":[{"id":"a","group":"g","level":"err","title":"Platte voll","fix":"aufräumen"},{"id":"b","level":"ok","title":"fine"}]}`,
	})
	r, err := Analyze(z, "en")
	if err != nil || r.Kind != KindBundle || len(r.Findings) != 1 || r.From.IsZero() {
		t.Fatalf("%v %+v", err, r)
	}
	if _, err := Analyze([]byte("nope"), "de"); err == nil {
		t.Fatal("want error")
	}
	if _, err := Analyze(zipOf(t, map[string]string{"x.txt": "y"}), "de"); err == nil {
		t.Fatal("want error for unknown zip")
	}
}

func TestRSSGrowthFlag(t *testing.T) {
	var sb strings.Builder
	sb.WriteString(`[{"instanceId":"i","label":"mixer","samples":[`)
	for i := 0; i < 20; i++ {
		if i > 0 {
			sb.WriteString(",")
		}
		sb.WriteString(`{"t":"` + time.Date(2026, 10, 28, 10, i, 0, 0, time.UTC).Format(time.RFC3339) + `","rssBytes":` + itoa(200<<20+i*20<<20) + `}`)
	}
	sb.WriteString("]}]")
	r, err := Analyze(zipOf(t, map[string]string{"meta.json": `{}`, "series/processes.json": sb.String()}), "de")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, s := range r.Series {
		if s.Metric == "rss" && s.Flag == "growing" {
			found = true
		}
	}
	if !found {
		t.Fatalf("%+v", r.Findings)
	}
}

func itoa(i int) string { return strconv.Itoa(i) }
