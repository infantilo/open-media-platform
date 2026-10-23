package hosts

import (
	"testing"
	"time"
)

func TestFitTrendSteigendRauschenUndZuWenig(t *testing.T) {
	var up []tp
	for i := 0; i < 40; i++ {
		up = append(up, tp{float64(i), 30 + 0.5*float64(i)}) // +30 Punkte je Stunde
	}
	tr, ok := fitTrend(up)
	if !ok || tr.SlopePerHour < 29.9 || tr.SlopePerHour > 30.1 || tr.Fitted < 49.4 || tr.Fitted > 49.6 || tr.R2 < 0.99 {
		t.Fatalf("%+v %v", tr, ok)
	}
	var noise []tp
	for i := 0; i < 40; i++ {
		v := 50.0
		if i%2 == 0 {
			v = 60
		}
		noise = append(noise, tp{float64(i), v})
	}
	if tr, _ := fitTrend(noise); tr.R2 > 0.1 {
		t.Fatalf("Rauschen hat keine Tendenz: %+v", tr)
	}
	if _, ok := fitTrend(up[:5]); ok {
		t.Fatal("zu wenig Punkte")
	}
}

func TestHistoryTrend(t *testing.T) {
	h := NewHistory()
	start := time.Now().Add(-40 * time.Minute)
	for i := 0; i < 40*12; i++ { // alle 5 s, CPU steigt 20 → 60 %
		ts := start.Add(time.Duration(i) * 5 * time.Second)
		h.Record("h", Metrics{CPUPercent: 20 + 40*float64(i)/480, MemUsedBytes: 4 << 30, MemTotalBytes: 16 << 30, ReceivedAt: ts})
	}
	c, m, ok := h.Trend("h", 45*time.Minute)
	if !ok || c.SlopePerHour < 55 || c.SlopePerHour > 65 || c.R2 < 0.98 {
		t.Fatalf("%+v %v", c, ok)
	}
	if m.SlopePerHour > 0.5 || m.SlopePerHour < -0.5 {
		t.Fatalf("Speicher konstant: %+v", m)
	}
	if _, _, ok := h.Trend("unbekannt", time.Hour); ok {
		t.Fatal("unbekannter Host")
	}
}
