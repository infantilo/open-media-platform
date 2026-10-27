// Package trends: „das ist nicht normal für dieses System“ (UMSETZUNG.md Kap. 72.11). Aus Stundenwerten erkennt es
//   - Abweichungen vom Üblichen: der Wert liegt deutlich über dem, was zur selben Tageszeit (und am selben Tagtyp, Werktag/Wochenende)
//     an den Tagen davor üblich war, und
//   - stetiges Wachstum (Lecks): Speicher, offene Dateien oder Threads steigen seit Stunden gleichmäßig an — mit Hochrechnung, wann eine
//     Grenze erreicht wäre.
//
// Alles sind reine Funktionen auf Stundenwerten; die Datenquellen (Hosts, Instanzen, Orchestrator) kommen von außen.
package trends

import (
	"math"
	"sort"
	"time"
)

// Point ist ein Stundenwert (Mittel und Maximum der Stunde).
type Point struct {
	T   time.Time `json:"t"`
	Avg float64   `json:"avg"`
	Max float64   `json:"max"`
}

// Spec beschreibt, wie eine Messgröße geprüft wird.
type Spec struct {
	Metric string
	Unit   string // "%" | "B" | "" (Anzahl)
	// Deviation: Abweichung vom Üblichen prüfen; MinDelta: mindestens so viel über dem Üblichen (absolut), sonst zählt es nicht.
	Deviation bool
	MinDelta  float64
	// Drift: stetiges Wachstum prüfen; MinGrowth: mindestens so viel Zuwachs im Beobachtungsfenster (absolut).
	Drift     bool
	MinGrowth float64
}

// Specs sind die geprüften Messgrößen.
var Specs = map[string]Spec{
	"host.cpu":        {Metric: "host.cpu", Unit: "%", Deviation: true, MinDelta: 20},
	"host.mem":        {Metric: "host.mem", Unit: "%", Deviation: true, MinDelta: 10, Drift: true, MinGrowth: 8},
	"host.net":        {Metric: "host.net", Unit: "%", Deviation: true, MinDelta: 15},
	"proc.rss":        {Metric: "proc.rss", Unit: "B", Drift: true, MinGrowth: 50 << 20},
	"proc.cpu":        {Metric: "proc.cpu", Unit: "%", Deviation: true, MinDelta: 40},
	"proc.fds":        {Metric: "proc.fds", Drift: true, MinGrowth: 50},
	"proc.threads":    {Metric: "proc.threads", Drift: true, MinGrowth: 30},
	"orch.heap":       {Metric: "orch.heap", Unit: "B", Drift: true, MinGrowth: 100 << 20},
	"orch.goroutines": {Metric: "orch.goroutines", Drift: true, MinGrowth: 200},
	"orch.fds":        {Metric: "orch.fds", Drift: true, MinGrowth: 100},
}

// Schwellen
const (
	driftWindow      = 24 * time.Hour
	driftMinPoints   = 8
	driftMinR2       = 0.85
	driftMinRelative = 0.15           // mindestens 15 % des Mittelwerts
	devMinDays       = 3              // so viele Vergleichswerte zur selben Tageszeit braucht die Abweichung
	devRatio         = 1.5            // und mindestens das 1,5-Fache des Üblichen
	devMADFactor     = 3.0            // und außerhalb von 3 Streuungen
	baselineExclude  = 24 * time.Hour // die letzten 24 Stunden gehören nicht zum „Üblichen“
)

// Kind einer Auffälligkeit.
const (
	KindDeviation = "deviation"
	KindDrift     = "drift"
)

// Finding ist eine Auffälligkeit.
type Finding struct {
	Subject string  `json:"subject"` // "host:<id>" | "instance:<Typ>:<Name>" | "orchestrator"
	Label   string  `json:"label"`
	Metric  string  `json:"metric"`
	Kind    string  `json:"kind"`
	Unit    string  `json:"unit,omitempty"`
	Value   float64 `json:"value"`
	// Deviation: das Übliche (Median zur selben Tageszeit); Drift: Wert am Anfang des Fensters.
	Baseline float64 `json:"baseline"`
	// Drift: Zuwachs je Stunde, Stunden seit Beginn des Anstiegs und Hochrechnung bis zur Grenze (0 = unbekannt).
	SlopePerHour float64   `json:"slopePerHour,omitempty"`
	Hours        float64   `json:"hours,omitempty"`
	HoursToLimit float64   `json:"hoursToLimit,omitempty"`
	Since        time.Time `json:"since"`
	Points       []Point   `json:"points,omitempty"` // zum Zeichnen (letzte 48 Stunden)
}

func median(v []float64) float64 {
	s := append([]float64(nil), v...)
	sort.Float64s(s)
	n := len(s)
	if n == 0 {
		return 0
	}
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}

func mad(v []float64, med float64) float64 {
	d := make([]float64, len(v))
	for i, x := range v {
		d[i] = math.Abs(x - med)
	}
	return median(d)
}

func weekend(t time.Time) bool {
	d := t.UTC().Weekday()
	return d == time.Saturday || d == time.Sunday
}

// baselineFor liefert die Vergleichswerte zu p: dieselbe Stunde des Tages (UTC) an früheren Tagen, bevorzugt am selben Tagtyp
// (Werktag/Wochenende); gibt es dort zu wenige, alle Tage. Die letzten 24 Stunden zählen nicht mit.
func baselineFor(pts []Point, p Point, now time.Time) []float64 {
	var same, all []float64
	for _, q := range pts {
		if q.T.After(now.Add(-baselineExclude)) || q.T.UTC().Hour() != p.T.UTC().Hour() {
			continue
		}
		all = append(all, q.Avg)
		if weekend(q.T) == weekend(p.T) {
			same = append(same, q.Avg)
		}
	}
	if len(same) >= devMinDays {
		return same
	}
	return all
}

// DetectDeviation prüft, ob die letzten beiden Stundenwerte deutlich über dem Üblichen für ihre Tageszeit liegen (beide, damit eine
// einzelne Spitze nichts auslöst).
func DetectDeviation(pts []Point, spec Spec, now time.Time) (Finding, bool) {
	if !spec.Deviation || len(pts) < 2 {
		return Finding{}, false
	}
	last := pts[len(pts)-2:]
	var base float64
	for _, p := range last {
		b := baselineFor(pts, p, now)
		if len(b) < devMinDays {
			return Finding{}, false
		}
		m := median(b)
		thr := m + math.Max(devMADFactor*1.4826*mad(b, m), spec.MinDelta)
		if p.Avg <= thr || p.Avg < devRatio*m {
			return Finding{}, false
		}
		base = m
	}
	cur := last[1]
	since := last[0].T
	return Finding{Metric: spec.Metric, Kind: KindDeviation, Unit: spec.Unit, Value: cur.Avg, Baseline: base, Since: since, Points: tail(pts, 48)}, true
}

// DetectDrift prüft auf stetiges Wachstum in den letzten 24 Stunden: Ausgleichsgerade mit gutem Bestimmtheitsmaß und spürbarem Zuwachs.
// limit > 0 ist die Obergrenze für die Hochrechnung (z. B. Gesamtspeicher); 0 = keine.
func DetectDrift(pts []Point, spec Spec, limit float64, now time.Time) (Finding, bool) {
	if !spec.Drift {
		return Finding{}, false
	}
	var win []Point
	for _, p := range pts {
		if p.T.After(now.Add(-driftWindow)) {
			win = append(win, p)
		}
	}
	if len(win) < driftMinPoints {
		return Finding{}, false
	}
	t0 := win[0].T
	n := float64(len(win))
	var sx, sy, sxx, sxy, syy float64
	for _, p := range win {
		x := p.T.Sub(t0).Hours()
		sx, sy, sxx, sxy, syy = sx+x, sy+p.Avg, sxx+x*x, sxy+x*p.Avg, syy+p.Avg*p.Avg
	}
	den := n*sxx - sx*sx
	if den == 0 {
		return Finding{}, false
	}
	slope := (n*sxy - sx*sy) / den
	r2 := 0.0
	if v := (n*sxx - sx*sx) * (n*syy - sy*sy); v > 0 {
		r := (n*sxy - sx*sy) / math.Sqrt(v)
		r2 = r * r
	}
	span := win[len(win)-1].T.Sub(t0).Hours()
	growth := slope * span
	mean := sy / n
	if slope <= 0 || r2 < driftMinR2 || growth < spec.MinGrowth || (mean > 0 && growth < driftMinRelative*mean) {
		return Finding{}, false
	}
	last := win[len(win)-1].Avg
	f := Finding{Metric: spec.Metric, Kind: KindDrift, Unit: spec.Unit, Value: last, Baseline: win[0].Avg, SlopePerHour: slope, Hours: span, Since: t0, Points: tail(pts, 48)}
	if limit > last {
		f.HoursToLimit = (limit - last) / slope
	}
	return f, true
}

func tail(pts []Point, n int) []Point {
	if len(pts) <= n {
		return append([]Point(nil), pts...)
	}
	return append([]Point(nil), pts[len(pts)-n:]...)
}
