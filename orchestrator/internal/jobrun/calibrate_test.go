package jobrun

import (
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
)

func demand(spanH float64, cpuP95, cpuPeak, memP95, memPeak float64) hosts.LiveDemand {
	return hosts.LiveDemand{Span: time.Duration(spanH * float64(time.Hour)), Samples: 1000, CPUP95: cpuP95, CPUPeak: cpuPeak, CPUNow: cpuP95, MemP95: memP95, MemPeak: memPeak, MemNow: memP95}
}

func TestKalibrierung(t *testing.T) {
	base := DefaultConfig().Reserve
	c := defaultCalib()
	// 8 Kerne; Live-Nodes: P95 2 Kerne (25 %), Spitze 3,2 Kerne (40 %) → max(25, 0,75·40=30) + 10 = 40 %
	r := Calibrate(demand(30, 2, 3.2, 20, 30), true, 8, false, base, c)
	if !r.Enough || r.Suggested.CPU != 0.40 || r.Suggested.Mem < 0.32 || r.Suggested.Mem > 0.33 {
		t.Fatalf("%+v", r)
	}
	if r.Suggested.Net != base.Net || r.Suggested.GPU != base.GPU {
		t.Fatalf("Netz/GPU bleiben auf dem Grundwert: %+v", r.Suggested)
	}
	// wenig Live-Last → Untergrenze 10 %; sehr viel → Obergrenze 60 %
	if r := Calibrate(demand(30, 0.01, 0.02, 0.1, 0.2), true, 8, false, base, c); r.Suggested.CPU != 0.10 {
		t.Fatalf("%+v", r.Suggested)
	}
	if r := Calibrate(demand(30, 7, 8, 90, 95), true, 8, false, base, c); r.Suggested.CPU != 0.60 || r.Suggested.Mem != 0.60 {
		t.Fatalf("%+v", r.Suggested)
	}
	// GPU nur mit GPU
	d := demand(30, 1, 1, 5, 5)
	d.GPUP95, d.GPUPeak = 40, 60
	if r := Calibrate(d, true, 8, true, base, c); r.GPU == nil || r.Suggested.GPU != 0.55 {
		t.Fatalf("%+v", r)
	}
	// zu wenig Daten
	if r := Calibrate(demand(1, 2, 3, 20, 30), true, 8, false, base, c); r.Enough || r.Reason != "too-short" || r.Suggested != base {
		t.Fatalf("%+v", r)
	}
	if r := Calibrate(hosts.LiveDemand{}, false, 8, false, base, c); r.Reason != "no-data" || r.Enough {
		t.Fatalf("%+v", r)
	}
}

func TestGlaettung(t *testing.T) {
	prev := Reserve{CPU: 0.40, Mem: 0.30, GPU: 0.30, Net: 0.25}
	up := smooth(prev, Reserve{CPU: 0.55, Mem: 0.30, GPU: 0.30, Net: 0.25}, 0.01)
	if up.CPU != 0.55 {
		t.Fatalf("steigt sofort: %+v", up)
	}
	down := smooth(prev, Reserve{CPU: 0.10, Mem: 0.29, GPU: 0.30, Net: 0.25}, 0.01)
	if down.CPU != 0.39 || down.Mem != 0.29 {
		t.Fatalf("sinkt höchstens einen Schritt: %+v", down)
	}
	if smooth(Reserve{}, Reserve{CPU: 0.2}, 0.01).CPU != 0.2 {
		t.Fatal("ohne Vorwert direkt")
	}
}

func TestKalibrierungKonfiguration(t *testing.T) {
	c := defaultCalib()
	c.Mode = "irgendwas"
	if c.normalize() == nil {
		t.Fatal("Modus prüfen")
	}
	c = CalibConfig{}
	if err := c.normalize(); err != nil || c.Mode != "manual" || c.WindowDays != 7 {
		t.Fatalf("%v %+v", err, c)
	}
	c = CalibConfig{Min: 0.5, Max: 0.4}
	if c.normalize() == nil {
		t.Fatal("min < max")
	}
}
