package trends

import (
	"context"
	"sort"
	"sync"
	"time"
)

// HostHours ist der Stundenverlauf eines Hosts (aus host_metrics_hourly über hosts.History).
type HostHours struct {
	ID, Label     string
	CPU, Mem, Net []Point
}

// Sources sind die Datenquellen der Auswertung.
type Sources struct {
	Hosts func() []HostHours
	// Limit liefert die Obergrenze für die Hochrechnung (0 = keine): Arbeitsspeicher des Rechners, 100 % …
	Limit func(subject, metric string) float64
}

// Report ist das Ergebnis der letzten Auswertung.
type Report struct {
	AnalyzedAt    time.Time `json:"analyzedAt"`
	Findings      []Finding `json:"findings"`
	SeriesChecked int       `json:"seriesChecked"`
	// CoverageHours: wie viele Stunden Verlauf die längste Reihe hat — die Baseline braucht mindestens 3 Tage (72 Stunden).
	CoverageHours float64 `json:"coverageHours"`
}

// Analyzer wertet Stundenverläufe regelmäßig aus und merkt sich die aktuellen Auffälligkeiten.
type Analyzer struct {
	Col *Collector
	Src Sources
	// OnNew wird einmal je Auffälligkeit aufgerufen (nicht bei jeder Auswertung): Eintrag in der Zeitleiste.
	OnNew func(Finding)
	// Renotify: so lange bleibt eine gemeldete Auffälligkeit still, bevor sie erneut gemeldet wird.
	Renotify time.Duration

	mu        sync.Mutex
	report    Report
	announced map[string]time.Time
}

func NewAnalyzer(col *Collector, src Sources) *Analyzer {
	return &Analyzer{Col: col, Src: src, Renotify: 6 * time.Hour, announced: map[string]time.Time{}}
}

// Current liefert die letzte Auswertung.
func (a *Analyzer) Current() Report {
	a.mu.Lock()
	defer a.mu.Unlock()
	r := a.report
	r.Findings = append([]Finding{}, r.Findings...) // nie null: die Oberfläche iteriert darüber
	return r
}

// Analyze wertet alle Reihen aus (Hosts und Collector) und aktualisiert Current().
func (a *Analyzer) Analyze(ctx context.Context, now time.Time) error {
	type item struct {
		subject, label, metric string
		pts                    []Point
	}
	var items []item
	if a.Src.Hosts != nil {
		for _, h := range a.Src.Hosts() {
			s := "host:" + h.ID
			items = append(items, item{s, h.Label, "host.cpu", h.CPU}, item{s, h.Label, "host.mem", h.Mem}, item{s, h.Label, "host.net", h.Net})
		}
	}
	if a.Col != nil {
		if err := a.Col.Flush(ctx); err != nil {
			return err
		}
		all, err := a.Col.All(ctx, now.Add(-RetentionDays*24*time.Hour))
		if err != nil {
			return err
		}
		for _, s := range all {
			items = append(items, item{s.Subject, s.Label, s.Metric, s.Points})
		}
	}
	rep := Report{AnalyzedAt: now.UTC(), Findings: []Finding{}}
	for _, it := range items {
		spec, ok := Specs[it.metric]
		if !ok || len(it.pts) == 0 {
			continue
		}
		rep.SeriesChecked++
		if cov := it.pts[len(it.pts)-1].T.Sub(it.pts[0].T).Hours(); cov > rep.CoverageHours {
			rep.CoverageHours = cov
		}
		// Veraltete Reihen (z. B. beendete Instanz) werden nicht mehr bewertet: nur was in den letzten 3 Stunden noch Werte hatte.
		if now.Sub(it.pts[len(it.pts)-1].T) > 3*time.Hour {
			continue
		}
		var limit float64
		if a.Src.Limit != nil {
			limit = a.Src.Limit(it.subject, it.metric)
		}
		for _, fn := range []func() (Finding, bool){
			func() (Finding, bool) { return DetectDrift(it.pts, spec, limit, now) },
			func() (Finding, bool) { return DetectDeviation(it.pts, spec, now) },
		} {
			if f, ok := fn(); ok {
				f.Subject, f.Label = it.subject, it.label
				rep.Findings = append(rep.Findings, f)
			}
		}
	}
	sort.SliceStable(rep.Findings, func(i, j int) bool { return rep.Findings[i].Kind < rep.Findings[j].Kind })
	a.mu.Lock()
	a.report = rep
	var fresh []Finding
	for _, f := range rep.Findings {
		k := f.Subject + "|" + f.Metric + "|" + f.Kind
		if last, ok := a.announced[k]; !ok || now.Sub(last) > a.Renotify {
			a.announced[k] = now
			fresh = append(fresh, f)
		}
	}
	a.mu.Unlock()
	if a.OnNew != nil {
		for _, f := range fresh {
			a.OnNew(f)
		}
	}
	return nil
}

// Run wertet sofort (nach kurzer Wartezeit) und danach alle 10 Minuten aus, bis ctx endet.
func (a *Analyzer) Run(ctx context.Context, onError func(error)) {
	tick := time.NewTicker(10 * time.Minute)
	defer tick.Stop()
	first := time.NewTimer(30 * time.Second)
	defer first.Stop()
	run := func() {
		if err := a.Analyze(ctx, time.Now()); err != nil && onError != nil {
			onError(err)
		}
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-first.C:
			run()
		case <-tick.C:
			run()
		}
	}
}
