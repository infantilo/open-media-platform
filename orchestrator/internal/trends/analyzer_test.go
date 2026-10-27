package trends

import (
	"context"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
)

func newCollector(t *testing.T) *Collector {
	db := dbtest.Open(t)
	if _, err := db.Exec(`TRUNCATE trend_hourly`); err != nil {
		t.Fatal(err)
	}
	return NewCollector(db)
}

func TestCollectorAggregatesHoursAndResumesWithoutDoubleCounting(t *testing.T) {
	c := newCollector(t)
	ctx := context.Background()
	h := time.Date(2026, 10, 28, 10, 0, 0, 0, time.UTC)
	for i := 0; i < 4; i++ { // 10:00–10:30: 10, 20, 30, 40
		c.Observe("instance:omp-source:Kamera", "Kamera", "proc.rss", float64(10*(i+1)), h.Add(time.Duration(i)*10*time.Minute))
	}
	if err := c.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	if err := c.Flush(ctx); err != nil { // zweites Nachtragen ohne neue Werte ändert nichts
		t.Fatal(err)
	}
	c.Observe("instance:omp-source:Kamera", "Kamera", "proc.rss", 50, h.Add(40*time.Minute))
	c.Observe("instance:omp-source:Kamera", "Kamera", "proc.rss", 100, h.Add(time.Hour+time.Minute)) // nächste Stunde
	if err := c.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	all, err := c.All(ctx, h.Add(-time.Hour))
	if err != nil || len(all) != 1 || all[0].Label != "Kamera" || len(all[0].Points) != 2 {
		t.Fatalf("%v %+v", err, all)
	}
	p := all[0].Points[0]
	if p.Avg != 30 || p.Max != 50 { // (10+20+30+40+50)/5
		t.Errorf("erste Stunde: %+v", p)
	}
	if all[0].Points[1].Avg != 100 {
		t.Errorf("zweite Stunde: %+v", all[0].Points[1])
	}
	// Neustart des Orchestrators mitten in der Stunde: die neue Instanz des Collectors setzt die Stunde fort
	c2 := NewCollector(c.db)
	c2.Observe("instance:omp-source:Kamera", "Kamera", "proc.rss", 100, h.Add(50*time.Minute))
	if err := c2.Flush(ctx); err != nil {
		t.Fatal(err)
	}
	all, _ = c2.All(ctx, h.Add(-time.Hour))
	// 150 über 5 Werte (erste Sitzung) plus 100 nach dem Neustart: 250 / 6
	if got := all[0].Points[0]; got.Avg < 41.6 || got.Avg > 41.7 || got.Max != 100 {
		t.Errorf("fortgesetzte Stunde: %+v", got)
	}
}

func TestAnalyzerFindsLeakAndDeviationAndAnnouncesOnce(t *testing.T) {
	c := newCollector(t)
	ctx := context.Background()
	base := time.Date(2026, 10, 28, 14, 30, 0, 0, time.UTC)
	// Instanz mit Speicherleck: 12 Stunden, +25 MB je Stunde
	for i := 12; i >= 0; i-- {
		at := base.Add(-time.Duration(i) * time.Hour)
		c.Observe("instance:omp-video-mixer-me:Mischer", "Mischer", "proc.rss", float64(400<<20)+float64(12-i)*25*(1<<20), at)
		c.Observe("orchestrator", "Orchestrator", "orch.goroutines", 300, at) // stabil
	}
	hosts := func() []HostHours {
		var cpu []Point
		for t := base.Add(-7 * 24 * time.Hour).Truncate(time.Hour); !t.After(base); t = t.Add(time.Hour) {
			v := 20.0
			if t.After(base.Add(-3 * time.Hour)) {
				v = 90
			}
			cpu = append(cpu, Point{T: t, Avg: v, Max: v})
		}
		return []HostHours{{ID: "h1", Label: "Regie", CPU: cpu}}
	}
	a := NewAnalyzer(c, Sources{Hosts: hosts, Limit: func(subject, metric string) float64 {
		if metric == "proc.rss" {
			return 2 << 30
		}
		return 0
	}})
	var announced []string
	a.OnNew = func(f Finding) { announced = append(announced, f.Kind+":"+f.Subject+":"+f.Metric) }
	if err := a.Analyze(ctx, base); err != nil {
		t.Fatal(err)
	}
	rep := a.Current()
	got := map[string]Finding{}
	for _, f := range rep.Findings {
		got[f.Kind+":"+f.Subject] = f
	}
	drift, dev := got["drift:instance:omp-video-mixer-me:Mischer"], got["deviation:host:h1"]
	if drift.Label != "Mischer" || drift.HoursToLimit <= 0 || dev.Label != "Regie" || dev.Metric != "host.cpu" || dev.Baseline != 20 {
		t.Fatalf("%+v", rep.Findings)
	}
	if len(rep.Findings) != 2 || rep.SeriesChecked < 3 || rep.CoverageHours < 150 {
		t.Errorf("Findings %d, geprüft %d, Abdeckung %.0f h", len(rep.Findings), rep.SeriesChecked, rep.CoverageHours)
	}
	// zweite Auswertung: gleiche Auffälligkeiten werden nicht erneut gemeldet, nach der Sperrzeit schon
	_ = a.Analyze(ctx, base.Add(time.Minute))
	if len(announced) != 2 {
		t.Fatalf("gemeldet: %v", announced)
	}
	a.Renotify = time.Minute
	_ = a.Analyze(ctx, base.Add(2*time.Minute))
	if len(announced) != 4 {
		t.Errorf("nach der Sperrzeit erneut: %v", announced)
	}
	// Reihen ohne frische Werte (beendete Instanz) werden nicht mehr bewertet
	a2 := NewAnalyzer(c, Sources{})
	_ = a2.Analyze(ctx, base.Add(10*time.Hour))
	if n := len(a2.Current().Findings); n != 0 {
		t.Errorf("veraltete Reihen: %d Findings", n)
	}
}

func TestCurrentBeforeFirstAnalysisIsEmptyNotNull(t *testing.T) {
	a := NewAnalyzer(nil, Sources{})
	if a.Current().Findings == nil {
		t.Error("Findings darf nie nil sein (JSON null)")
	}
}
