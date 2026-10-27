package trends

import (
	"math"
	"testing"
	"time"
)

// Mittwoch, 28.10.2026 14:30 UTC
var now = time.Date(2026, 10, 28, 14, 30, 0, 0, time.UTC)

// hourly baut Stundenwerte von from bis (ausschließlich) to; f liefert den Wert je Stunde.
func hourly(from, to time.Time, f func(t time.Time) float64) []Point {
	var out []Point
	for t := from.Truncate(time.Hour); t.Before(to); t = t.Add(time.Hour) {
		v := f(t)
		out = append(out, Point{T: t, Avg: v, Max: v})
	}
	return out
}

func TestDeviationFromUsualTimeOfDay(t *testing.T) {
	spec := Specs["host.cpu"]
	// 7 Tage lang tagsüber 30 %, nachts 5 %; heute ab 12 Uhr 85 %
	pts := hourly(now.Add(-7*24*time.Hour), now.Add(time.Hour), func(t time.Time) float64 {
		if t.Hour() >= 12 && t.After(now.Add(-3*time.Hour)) {
			return 85
		}
		if t.Hour() >= 8 && t.Hour() < 20 {
			return 30
		}
		return 5
	})
	f, ok := DetectDeviation(pts, spec, now)
	if !ok || f.Kind != KindDeviation || f.Value != 85 || f.Baseline != 30 {
		t.Fatalf("%v %+v", ok, f)
	}
	if len(f.Points) != 48 {
		t.Errorf("Punkte zum Zeichnen: %d", len(f.Points))
	}
	// Dieselbe Last, die zu dieser Tageszeit üblich ist, ist keine Abweichung
	normal := hourly(now.Add(-7*24*time.Hour), now.Add(time.Hour), func(t time.Time) float64 {
		if t.Hour() >= 8 && t.Hour() < 20 {
			return 85
		}
		return 5
	})
	if _, ok := DetectDeviation(normal, spec, now); ok {
		t.Error("üblicher Tageslauf darf nichts melden")
	}
	// eine einzelne Spitze (nur die letzte Stunde) löst nicht aus
	spike := hourly(now.Add(-7*24*time.Hour), now.Add(time.Hour), func(t time.Time) float64 {
		if t.Equal(now.Truncate(time.Hour)) {
			return 95
		}
		return 30
	})
	if _, ok := DetectDeviation(spike, spec, now); ok {
		t.Error("einzelne Spitze darf nichts melden")
	}
	// zu wenig Vergleich (2 Tage Verlauf): kein Urteil
	short := hourly(now.Add(-2*24*time.Hour), now.Add(time.Hour), func(t time.Time) float64 { return 90 })
	if _, ok := DetectDeviation(short, spec, now); ok {
		t.Error("ohne drei Vergleichstage kein Urteil")
	}
	// kleiner Unterschied (30 → 40 %) liegt unter der Mindestabweichung
	small := hourly(now.Add(-7*24*time.Hour), now.Add(time.Hour), func(t time.Time) float64 {
		if t.After(now.Add(-3 * time.Hour)) {
			return 45
		}
		return 30
	})
	if _, ok := DetectDeviation(small, spec, now); ok {
		t.Error("+15 Punkte sind unter MinDelta 20")
	}
}

func TestDeviationUsesWeekdayVersusWeekend(t *testing.T) {
	spec := Specs["host.net"]
	// Werktags 60 %, am Wochenende 5 %. Heute (Samstag) 60 % wäre werktags normal, am Wochenende aber auffällig.
	sat := time.Date(2026, 10, 31, 14, 30, 0, 0, time.UTC)
	pts := hourly(sat.Add(-14*24*time.Hour), sat.Add(time.Hour), func(t time.Time) float64 {
		if t.After(sat.Add(-3*time.Hour)) || !weekend(t) {
			return 60
		}
		return 5
	})
	if f, ok := DetectDeviation(pts, spec, sat); !ok || f.Baseline != 5 {
		t.Fatalf("Samstag mit Werktagslast: %v %+v", ok, f)
	}
}

func TestDriftDetectsSteadyGrowthAndProjects(t *testing.T) {
	spec := Specs["proc.rss"]
	// +20 MB je Stunde über 12 Stunden (240 MB), Start 300 MB; Grenze 1 GB
	start := now.Add(-12 * time.Hour)
	pts := hourly(start, now.Add(time.Hour), func(t time.Time) float64 {
		return 300<<20 + t.Sub(start.Truncate(time.Hour)).Hours()*20*(1<<20)
	})
	f, ok := DetectDrift(pts, spec, 1<<30, now)
	if !ok || f.Kind != KindDrift {
		t.Fatalf("%v %+v", ok, f)
	}
	if math.Abs(f.SlopePerHour-20*(1<<20)) > 1<<18 || f.Hours < 11 || f.Hours > 13 {
		t.Errorf("Steigung %.0f/h, %.1f h", f.SlopePerHour, f.Hours)
	}
	wantH := (float64(1<<30) - f.Value) / f.SlopePerHour
	if math.Abs(f.HoursToLimit-wantH) > 0.01 || f.HoursToLimit < 20 || f.HoursToLimit > 30 {
		t.Errorf("Hochrechnung %.1f h (erwartet %.1f)", f.HoursToLimit, wantH)
	}
	// gleichmäßig hoch bleibt unauffällig, ebenso Auf und Ab
	flat := hourly(start, now.Add(time.Hour), func(time.Time) float64 { return 500 << 20 })
	if _, ok := DetectDrift(flat, spec, 0, now); ok {
		t.Error("konstant")
	}
	saw := hourly(start, now.Add(time.Hour), func(t time.Time) float64 { return float64(300<<20) + float64(t.Hour()%2)*float64(200<<20) })
	if _, ok := DetectDrift(saw, spec, 0, now); ok {
		t.Error("Sägezahn ist kein stetiger Anstieg")
	}
	// kleiner Zuwachs (unter MinGrowth) und fallender Verlauf
	tiny := hourly(start, now.Add(time.Hour), func(t time.Time) float64 { return float64(300<<20) + t.Sub(start).Hours()*float64(1<<20) })
	if _, ok := DetectDrift(tiny, spec, 0, now); ok {
		t.Error("12 MB sind kein Leck")
	}
	down := hourly(start, now.Add(time.Hour), func(t time.Time) float64 { return float64(900<<20) - t.Sub(start).Hours()*float64(20<<20) })
	if _, ok := DetectDrift(down, spec, 0, now); ok {
		t.Error("fallend")
	}
	// zu wenig Punkte
	if _, ok := DetectDrift(pts[len(pts)-5:], spec, 0, now); ok {
		t.Error("weniger als 8 Stunden")
	}
	// Metrik ohne Drift-Prüfung
	if _, ok := DetectDrift(pts, Specs["host.cpu"], 0, now); ok {
		t.Error("host.cpu wird nicht auf Drift geprüft")
	}
}

func TestSpecsAreConsistent(t *testing.T) {
	for k, s := range Specs {
		if s.Metric != k || (!s.Deviation && !s.Drift) || (s.Deviation && s.MinDelta <= 0) || (s.Drift && s.MinGrowth <= 0) {
			t.Errorf("%s: %+v", k, s)
		}
	}
}
