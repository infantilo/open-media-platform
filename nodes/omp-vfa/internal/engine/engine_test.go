package engine

import (
	"testing"
	"time"
)

func cfg() Config {
	c := DefaultConfig()
	c.WideCamera = "cam-3"
	c.People = []Person{
		{ID: "anna", Mic: "ch1", Shots: []Shot{{"cam-1", 0.25, 15}, {"cam-2", 0.7, 20}}},
		{ID: "ben", Mic: "ch2", Shots: []Shot{{"cam-2", 0.3, 18}}},
	}
	return c
}

var t0 = time.Unix(1000, 0)

func at(ms int) time.Time { return t0.Add(time.Duration(ms) * time.Millisecond) }

func TestHoldTimeBeforeCut(t *testing.T) {
	e := New(cfg())
	faces := map[string][]Face{"cam-1": {{CenterX: 0.25}}}
	lv := map[string]float64{"ch1": -20}
	if c := e.Tick(at(0), lv, faces); c != nil {
		t.Fatalf("zu früh: %+v", c)
	}
	if c := e.Tick(at(500), lv, faces); c != nil {
		t.Fatalf("zu früh: %+v", c)
	}
	c := e.Tick(at(800), lv, faces)
	if c == nil || c.CameraID != "cam-1" || c.PersonID != "anna" {
		t.Fatalf("erwartet cam-1/anna, bekam %+v", c)
	}
	if e.Tick(at(900), lv, faces) != nil {
		t.Fatal("kein zweiter Schnitt auf dieselbe Kamera")
	}
}

func TestPrefersCameraWhereFaceIsVisible(t *testing.T) {
	e := New(cfg())
	// Anna ist in cam-1 nicht zu sehen (Gesicht fehlt), aber in cam-2 an ihrer Stelle.
	faces := map[string][]Face{"cam-2": {{CenterX: 0.72}}}
	lv := map[string]float64{"ch1": -20}
	e.Tick(at(0), lv, faces)
	c := e.Tick(at(800), lv, faces)
	if c == nil || c.CameraID != "cam-2" {
		t.Fatalf("erwartet cam-2, bekam %+v", c)
	}
}

func TestMinShotDurationAndLoudestWins(t *testing.T) {
	e := New(cfg())
	faces := map[string][]Face{"cam-1": {{CenterX: 0.25}}, "cam-2": {{CenterX: 0.3}}}
	e.Tick(at(0), map[string]float64{"ch1": -20}, faces)
	e.Tick(at(800), map[string]float64{"ch1": -20}, faces) // cut cam-1
	// Ben wird lauter, aber Mindestdauer läuft noch.
	lv := map[string]float64{"ch1": -40, "ch2": -15}
	e.Tick(at(1000), lv, faces)
	if c := e.Tick(at(1800), lv, faces); c != nil {
		t.Fatalf("Mindestdauer verletzt: %+v", c)
	}
	c := e.Tick(at(3500), lv, faces)
	if c == nil || c.CameraID != "cam-2" || c.PersonID != "ben" {
		t.Fatalf("erwartet cam-2/ben, bekam %+v", c)
	}
}

func TestSilenceGoesWide(t *testing.T) {
	e := New(cfg())
	faces := map[string][]Face{"cam-1": {{CenterX: 0.25}}}
	e.Tick(at(0), map[string]float64{"ch1": -20}, faces)
	e.Tick(at(800), map[string]float64{"ch1": -20}, faces)
	quiet := map[string]float64{"ch1": -80}
	if c := e.Tick(at(5000), quiet, faces); c != nil {
		t.Fatalf("zu früh Totale: %+v", c)
	}
	c := e.Tick(at(9000), quiet, faces)
	if c == nil || c.CameraID != "cam-3" || c.Reason != "wide" {
		t.Fatalf("erwartet Totale, bekam %+v", c)
	}
	if e.Tick(at(12000), quiet, faces) != nil {
		t.Fatal("Totale nur einmal")
	}
}

func TestBelowThresholdIgnored(t *testing.T) {
	e := New(cfg())
	if _, ok := e.Speaker(map[string]float64{"ch1": -60}); ok {
		t.Fatal("Rauschen ist kein Sprecher")
	}
}
