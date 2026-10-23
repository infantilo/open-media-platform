package hosts

import (
	"math"
	"time"
)

// Trend ist die lineare Tendenz einer Messgröße über ein Fenster (Kapitel 54): Steigung in Prozentpunkten je Stunde, der
// ausgeglichene Wert am Ende des Fensters und die Güte der Geraden (R², 0–1). Grundlage der Vorwarnung „Host läuft voraus-
// sichtlich in N Minuten über die Grenze“.
type Trend struct {
	SlopePerHour float64 `json:"slopePerHour"`
	Fitted       float64 `json:"fitted"`
	R2           float64 `json:"r2"`
	SpanMin      float64 `json:"spanMin"`
	Points       int     `json:"points"`
}

type tp struct{ t, v float64 } // t in Minuten

// fitTrend: Ausgleichsgerade durch Minutenmittelwerte. ok=false bei zu wenig Punkten oder Zeitspanne.
func fitTrend(pts []tp) (Trend, bool) {
	n := float64(len(pts))
	if len(pts) < 8 {
		return Trend{}, false
	}
	var sx, sy, sxx, sxy, syy float64
	for _, p := range pts {
		sx += p.t
		sy += p.v
		sxx += p.t * p.t
		sxy += p.t * p.v
		syy += p.v * p.v
	}
	den := n*sxx - sx*sx
	if den == 0 {
		return Trend{}, false
	}
	slope := (n*sxy - sx*sy) / den
	icpt := (sy - slope*sx) / n
	r2 := 0.0
	if vy := n*syy - sy*sy; vy > 0 {
		r := (n*sxy - sx*sy) / math.Sqrt(den*vy)
		r2 = r * r
	}
	last := pts[len(pts)-1].t
	return Trend{SlopePerHour: slope * 60, Fitted: slope*last + icpt, R2: r2, SpanMin: last - pts[0].t, Points: len(pts)}, true
}

// Trend liefert die Tendenz von CPU und Speicher eines Hosts über die letzten `window` (aus den Rohwerten, auf Minuten gemittelt).
func (h *History) Trend(hostID string, window time.Duration) (cpu, mem Trend, ok bool) {
	h.mu.Lock()
	hh, found := h.byHost[hostID]
	if !found {
		h.mu.Unlock()
		return
	}
	cutoff := time.Now().Add(-window)
	type acc struct {
		cs, ms float64
		n      int
	}
	buckets := map[int64]*acc{}
	var keys []int64
	for _, s := range hh.raw {
		if s.Timestamp.Before(cutoff) {
			continue
		}
		k := s.Timestamp.Unix() / 60
		b := buckets[k]
		if b == nil {
			b = &acc{}
			buckets[k] = b
			keys = append(keys, k)
		}
		b.cs += s.CPUPercent
		b.ms += s.MemPercent
		b.n++
	}
	h.mu.Unlock()
	var cp, mp []tp
	for _, k := range keys {
		b := buckets[k]
		cp = append(cp, tp{float64(k), b.cs / float64(b.n)})
		mp = append(mp, tp{float64(k), b.ms / float64(b.n)})
	}
	c, ok1 := fitTrend(cp)
	m, ok2 := fitTrend(mp)
	return c, m, ok1 && ok2
}
