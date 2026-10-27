package httpapi

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/support"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/trends"
)

func trendAnalyzerWithDeviation(t *testing.T) *trends.Analyzer {
	now := time.Date(2026, 10, 28, 14, 30, 0, 0, time.UTC)
	hosts := func() []trends.HostHours {
		var cpu []trends.Point
		for ts := now.Add(-7 * 24 * time.Hour).Truncate(time.Hour); !ts.After(now); ts = ts.Add(time.Hour) {
			v := 20.0
			if ts.After(now.Add(-3 * time.Hour)) {
				v = 90
			}
			cpu = append(cpu, trends.Point{T: ts, Avg: v, Max: v})
		}
		return []trends.HostHours{{ID: "h1", Label: "Regie", CPU: cpu}}
	}
	a := trends.NewAnalyzer(nil, trends.Sources{Hosts: hosts})
	if err := a.Analyze(context.Background(), now); err != nil {
		t.Fatal(err)
	}
	return a
}

func TestTrendsEndpointAndSelftestIntegration(t *testing.T) {
	a := trendAnalyzerWithDeviation(t)
	rec := httptest.NewRecorder()
	handleTrends(a)(rec, httptest.NewRequest("GET", "/api/v1/admin/trends", nil))
	var rep trends.Report
	if err := json.Unmarshal(rec.Body.Bytes(), &rep); err != nil || len(rep.Findings) != 1 || rep.Findings[0].Kind != "deviation" || rep.Findings[0].Label != "Regie" || len(rep.Findings[0].Points) == 0 || rep.CoverageHours < 150 {
		t.Fatalf("%v %s", err, rec.Body.String())
	}
	// Der Selbsttest trägt den Befund samt Code
	rec = httptest.NewRecorder()
	handleSelftest(supportTestMux(t), "", nil, nil, a)(rec, authed("/api/v1/admin/selftest"))
	var r support.Report
	if err := json.Unmarshal(rec.Body.Bytes(), &r); err != nil {
		t.Fatal(err)
	}
	var found *support.Check
	for i := range r.Checks {
		if r.Checks[i].Code == "OMP-1013" {
			found = &r.Checks[i]
		}
	}
	if found == nil || found.Group != "Trends" || !strings.Contains(found.Title, "Regie") {
		t.Fatalf("Trend-Befund fehlt: %+v", r.Checks)
	}
	// Ohne Auswertung bleibt der Selbsttest unverändert
	rec = httptest.NewRecorder()
	handleSelftest(supportTestMux(t), "", nil, nil)(rec, authed("/api/v1/admin/selftest"))
	if strings.Contains(rec.Body.String(), "OMP-1013") {
		t.Error("ohne Analyzer darf kein Trend-Befund erscheinen")
	}
}

func TestSupportAccessMayReadTrends(t *testing.T) {
	if !supportMayRead("GET", "/api/v1/admin/trends") || supportMayRead("POST", "/api/v1/admin/trends") {
		t.Error("Positivliste: Trends nur lesend")
	}
}
