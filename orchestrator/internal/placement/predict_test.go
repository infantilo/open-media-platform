package placement

import (
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
)

type fakeTrends map[string][2]hosts.Trend

func (f fakeTrends) Trend(id string, _ time.Duration) (hosts.Trend, hosts.Trend, bool) {
	t, ok := f[id]
	return t[0], t[1], ok
}

type recObs struct{ raised, cleared []string }

func (r *recObs) OnAdviceRaised(a Advice)   { r.raised = append(r.raised, a.HostID) }
func (r *recObs) OnAdviceCleared(id string) { r.cleared = append(r.cleared, id) }

func rising(fitted, slope float64) hosts.Trend {
	return hosts.Trend{Fitted: fitted, SlopePerHour: slope, R2: 0.95, SpanMin: 40, Points: 40}
}

func TestPredictMinutes(t *testing.T) {
	p := DefaultPrediction
	if m, ok := predictMinutes(rising(70, 30), 85, p, false); !ok || m != 30 { // 15 Punkte bei 30/h = 30 min
		t.Fatalf("%d %v", m, ok)
	}
	for name, tr := range map[string]hosts.Trend{
		"flach":        rising(70, 2),
		"zu weit weg":  rising(60, 10), // 25 Punkte bei 10/h = 150 min > 60
		"unter 60 %":   rising(40, 60),
		"schon drüber": rising(86, 30),
		"Rauschen":     {Fitted: 70, SlopePerHour: 30, R2: 0.2, SpanMin: 40},
		"zu kurz":      {Fitted: 70, SlopePerHour: 30, R2: 0.9, SpanMin: 10},
		"fallend":      rising(70, -10),
	} {
		if _, ok := predictMinutes(tr, 85, p, false); ok {
			t.Errorf("%s darf keine Vorwarnung auslösen", name)
		}
	}
}

func predictSetup(mode string) (*Engine, *recObs) {
	hl := fakeHosts{hosts: []hosts.Host{{ID: "h1", Label: "Host 1"}, {ID: "h2", Label: "Host 2"}}}
	mr := fakeMetrics{
		"h1": {CPUPercent: 70, MemUsedBytes: 1000, MemTotalBytes: 4000},
		"h2": {CPUPercent: 20, MemUsedBytes: 1000, MemTotalBytes: 4000},
	}
	il := fakeInstances{instances: []launcher.Instance{{ID: "i1", HostID: "h1"}}}
	e := NewEngine(hl, mr, il, &fakeEvents{}, testThresholds(), nil)
	obs := &recObs{}
	e.SetAdviceObserver(obs)
	p := DefaultPrediction
	p.Mode = mode
	e.SetPrediction(fakeTrends{"h1": {rising(70, 30), rising(25, 0)}}, p)
	return e, obs
}

func TestVorwarnungWarnModus(t *testing.T) {
	e, obs := predictSetup("warn")
	e.evaluateOnce()
	got := e.List()
	if len(got) != 1 || !got[0].Predicted || got[0].Reason != "cpu" || got[0].MinutesToLimit != 30 || got[0].SuggestedHostID != "h2" {
		t.Fatalf("%+v", got)
	}
	if len(obs.raised) != 0 {
		t.Fatalf("im Modus warn keine automatische Eskalation: %v", obs.raised)
	}
}

func TestVorwarnungActModusEskaliert(t *testing.T) {
	e, obs := predictSetup("act")
	e.evaluateOnce()
	if len(obs.raised) != 1 || obs.raised[0] != "h1" {
		t.Fatalf("im Modus act greift die Eskalation: %v", obs.raised)
	}
}

func TestVorwarnungAusUndEchterAlarmHatVorrang(t *testing.T) {
	e, _ := predictSetup("off")
	e.evaluateOnce()
	if len(e.List()) != 0 {
		t.Fatal("aus")
	}
	e, _ = predictSetup("warn")
	e.metrics = fakeMetrics{"h1": {CPUPercent: 90, MemUsedBytes: 1000, MemTotalBytes: 4000}, "h2": {CPUPercent: 20, MemUsedBytes: 1000, MemTotalBytes: 4000}}
	e.evaluateOnce()
	if got := e.List(); len(got) != 1 || got[0].Predicted {
		t.Fatalf("ein echter Alarm ersetzt die Vorwarnung: %+v", got)
	}
}

func TestHystereseHaeltVorwarnungAnDerKante(t *testing.T) {
	p := DefaultPrediction
	edge := hosts.Trend{Fitted: 60, SlopePerHour: 62, R2: 0.46, SpanMin: 22} // knapp unter R² 0,5
	if _, ok := predictMinutes(edge, 85, p, false); ok {
		t.Fatal("neu: R² 0,46 reicht nicht")
	}
	if _, ok := predictMinutes(edge, 85, p, true); !ok {
		t.Fatal("bestehende Vorwarnung bleibt bei R² 0,46")
	}
	if _, ok := predictMinutes(hosts.Trend{Fitted: 60, SlopePerHour: 62, R2: 0.2, SpanMin: 22}, 85, p, true); ok {
		t.Fatal("deutlich schlechtere Güte beendet sie")
	}
}
