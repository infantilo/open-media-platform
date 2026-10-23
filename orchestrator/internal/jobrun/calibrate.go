package jobrun

import (
	"math"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
)

// Auto-Kalibrierung der Live-Reserve (Kapitel 54): Die Reserve eines Hosts richtet sich nach dem, was die Live-Nodes dort
// tatsächlich brauchen — gemessen als Anteil der Hostkapazität (CPU-Kerne der Instanzen, RSS, GPU der Instanzen), ohne die Last
// der Jobs selbst (sonst schaukelte sich die Reserve an den eigenen Jobs hoch). Reserve = max(P95, Gewicht·Spitze) + Sicherheitsabstand,
// begrenzt auf [Min, Max]. Netz wird nicht kalibriert (die Karte trägt auch den Verkehr der Jobs).

// CalibConfig steuert die Kalibrierung.
type CalibConfig struct {
	// Mode: "manual" (Standard: nur anzeigen/vorschlagen) | "auto" (Vorschlag wird als Reserve verwendet).
	Mode string `json:"mode"`
	// Margin: Sicherheitsabstand auf den Bedarf (Anteil, Standard 0,10).
	Margin float64 `json:"margin"`
	// Min/Max: Grenzen der Reserve (Anteil).
	Min float64 `json:"min"`
	Max float64 `json:"max"`
	// PeakWeight: Gewicht der Spitze gegenüber P95 (Standard 0,75).
	PeakWeight float64 `json:"peakWeight"`
	// MinHours: so lange muss gemessen worden sein, bevor kalibriert wird (Standard 2).
	MinHours float64 `json:"minHours"`
	// WindowDays: Betrachtungszeitraum (Standard 7, höchstens 30).
	WindowDays int `json:"windowDays"`
}

func defaultCalib() CalibConfig {
	return CalibConfig{Mode: "manual", Margin: 0.10, Min: 0.10, Max: 0.60, PeakWeight: 0.75, MinHours: 2, WindowDays: 7}
}

func (c *CalibConfig) normalize() error {
	d := defaultCalib()
	if c.Mode == "" {
		c.Mode = d.Mode
	}
	if c.Mode != "manual" && c.Mode != "auto" {
		return errCalib("mode: manual | auto")
	}
	if c.Margin <= 0 {
		c.Margin = d.Margin
	}
	if c.Min <= 0 {
		c.Min = d.Min
	}
	if c.Max <= 0 {
		c.Max = d.Max
	}
	if c.PeakWeight <= 0 {
		c.PeakWeight = d.PeakWeight
	}
	if c.MinHours <= 0 {
		c.MinHours = d.MinHours
	}
	if c.WindowDays <= 0 {
		c.WindowDays = d.WindowDays
	}
	if c.Margin >= 1 || c.Min >= c.Max || c.Max >= 1 || c.PeakWeight > 1 || c.WindowDays > 30 {
		return errCalib("Werte außerhalb des zulässigen Bereichs (margin < 1, min < max < 1, peakWeight ≤ 1, windowDays ≤ 30)")
	}
	return nil
}

type errCalib string

func (e errCalib) Error() string { return "calibration: " + string(e) }

// Share ist ein gemessener Anteil an der Hostkapazität in Prozent.
type Share struct {
	Now  float64 `json:"now"`
	P95  float64 `json:"p95"`
	Peak float64 `json:"peak"`
}

// Calibration ist das Ergebnis für einen Host.
type Calibration struct {
	Host   string  `json:"host"`
	Label  string  `json:"label,omitempty"`
	Enough bool    `json:"enough"`
	SpanH  float64 `json:"spanH"`
	// Reason: "ok" | "no-data" | "too-short".
	Reason    string  `json:"reason"`
	CPU       Share   `json:"cpu"`
	Mem       Share   `json:"mem"`
	GPU       *Share  `json:"gpu,omitempty"`
	Suggested Reserve `json:"suggested"`
	// Applied: die tatsächlich verwendete Reserve; Source: "config" | "auto" | "host".
	Applied Reserve `json:"applied"`
	Source  string  `json:"source"`
}

func clampf(v, lo, hi float64) float64 { return math.Max(lo, math.Min(hi, v)) }

func round2(v float64) float64 { return math.Round(v*100) / 100 }

// Calibrate berechnet den Vorschlag. base liefert die Werte für nicht kalibrierte Größen (Netz) und als Rückfall.
func Calibrate(d hosts.LiveDemand, ok bool, cores float64, hasGPU bool, base Reserve, c CalibConfig) Calibration {
	out := Calibration{Suggested: base}
	if !ok || d.Samples == 0 {
		out.Reason = "no-data"
		return out
	}
	out.SpanH = round2(d.Span.Hours())
	if cores <= 0 {
		cores = 4
	}
	out.CPU = Share{Now: d.CPUNow / cores * 100, P95: d.CPUP95 / cores * 100, Peak: d.CPUPeak / cores * 100}
	out.Mem = Share{Now: d.MemNow, P95: d.MemP95, Peak: d.MemPeak}
	if hasGPU {
		out.GPU = &Share{Now: d.GPUNow, P95: d.GPUP95, Peak: d.GPUPeak}
	}
	if d.Span < time.Duration(c.MinHours*float64(time.Hour)) {
		out.Reason = "too-short"
		return out
	}
	need := func(s Share) float64 { return math.Max(s.P95, c.PeakWeight*s.Peak) / 100 }
	out.Suggested.CPU = round2(clampf(need(out.CPU)+c.Margin, c.Min, c.Max))
	out.Suggested.Mem = round2(clampf(need(out.Mem)+c.Margin, c.Min, c.Max))
	if out.GPU != nil {
		out.Suggested.GPU = round2(clampf(need(*out.GPU)+c.Margin, c.Min, c.Max))
	}
	out.Enough, out.Reason = true, "ok"
	return out
}

// smooth: steigt der Bedarf, gilt er sofort; sinkt er, geht die Reserve höchstens um `step` (Anteil) zurück.
func smooth(prev, next Reserve, step float64) Reserve {
	f := func(p, n float64) float64 {
		if p == 0 || n >= p {
			return n
		}
		return math.Max(n, p-step)
	}
	return Reserve{CPU: f(prev.CPU, next.CPU), Mem: f(prev.Mem, next.Mem), GPU: f(prev.GPU, next.GPU), Net: next.Net}
}
