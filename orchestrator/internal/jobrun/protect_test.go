package jobrun

import (
	"testing"
	"time"
)

func pj(id string, c Class, age int) RunningJob {
	return RunningJob{ID: id, Class: c, Pausable: true, Started: time.Now().Add(-time.Duration(age) * time.Second)}
}

func prot(cpu float64, degraded bool, jobs ...RunningJob) ([]Action, Config) {
	cfg := DefaultConfig()
	h := host("h", cpu)
	h.Jobs = jobs
	return Evaluate(ProtectInput{Host: h, Degraded: degraded, Now: time.Now()}, cfg), cfg
}

func TestSchutzStufen(t *testing.T) {
	// Grenze 70 %: 50 % = unauffällig
	if a, _ := prot(50, false, pj("b", ClassBatch, 5)); len(a) != 0 {
		t.Fatalf("%v", a)
	}
	// ab 63 % drosseln (Batch auf 19, interaktiv auf 15)
	a, _ := prot(65, false, pj("b", ClassBatch, 5), pj("i", ClassInteractive, 9))
	if len(a) != 2 || a[0].Kind != ActThrottle || a[0].JobID != "b" || a[0].Nice != 19 || a[1].Nice != 15 {
		t.Fatalf("%v", a)
	}
	// ab 70 %: der zuletzt gestartete Batch-Job wird pausiert, genau einer
	a, _ = prot(72, false, pj("alt", ClassBatch, 50), pj("neu", ClassBatch, 5), pj("i", ClassInteractive, 1))
	if len(a) != 1 || a[0].Kind != ActPause || a[0].JobID != "neu" {
		t.Fatalf("%v", a)
	}
	// Live-Eingang kann nicht pausiert werden → gedrosselt
	live := pj("l", ClassBatch, 5)
	live.Pausable = false
	if a, _ = prot(72, false, live); len(a) != 1 || a[0].Kind != ActThrottle {
		t.Fatalf("%v", a)
	}
	// ab 80,5 % (1,15 · 70): Batch wird abgebrochen, interaktiv nie allein wegen Last
	a, _ = prot(85, false, pj("b", ClassBatch, 5), pj("i", ClassInteractive, 1))
	if len(a) != 1 || a[0].Kind != ActCancel || a[0].JobID != "b" {
		t.Fatalf("%v", a)
	}
	if a, _ = prot(85, false, pj("i", ClassInteractive, 1)); len(a) == 1 && a[0].Kind == ActCancel {
		t.Fatalf("interaktiv wegen Last nicht abbrechen: %v", a)
	}
	// Aussetzer eines Live-Nodes: Batch zuerst abbrechen, notfalls auch interaktiv
	if a, _ = prot(10, true, pj("b", ClassBatch, 5), pj("i", ClassInteractive, 1)); len(a) != 1 || a[0].JobID != "b" || a[0].Kind != ActCancel {
		t.Fatalf("%v", a)
	}
	if a, _ = prot(10, true, pj("i", ClassInteractive, 1)); len(a) != 1 || a[0].JobID != "i" {
		t.Fatalf("%v", a)
	}
}

func TestFortsetzenUndPauseLimit(t *testing.T) {
	p := pj("p", ClassBatch, 50)
	p.Paused, p.PausedSince = true, time.Now().Add(-10*time.Second)
	if a, _ := prot(30, false, p); len(a) != 1 || a[0].Kind != ActResume {
		t.Fatalf("unter 80 %% fortsetzen: %v", a)
	}
	if a, _ := prot(60, false, p); len(a) != 0 { // zwischen Resume- und Throttle-Schwelle: halten
		t.Fatalf("%v", a)
	}
	p.PausedSince = time.Now().Add(-10 * time.Minute)
	if a, _ := prot(60, false, p); len(a) != 1 || a[0].Kind != ActCancel {
		t.Fatalf("zu lange pausiert: %v", a)
	}
}

func TestSchutzAus(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Protect.Enabled = false
	h := host("h", 99)
	h.Jobs = []RunningJob{pj("b", ClassBatch, 1)}
	if a := Evaluate(ProtectInput{Host: h}, cfg); len(a) != 0 {
		t.Fatal(a)
	}
	bad := DefaultConfig()
	bad.Protect.PauseAt = 0.5
	if err := bad.Normalize(); err == nil {
		t.Fatal("unsortierte Schwellen müssen abgelehnt werden")
	}
}
