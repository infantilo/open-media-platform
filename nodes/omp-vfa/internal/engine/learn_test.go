package engine

import "testing"

func TestLearnerSuggestsOnlyWhileSpeaking(t *testing.T) {
	l := NewLearner(-45)
	f := map[string][]Face{"cam-1": {{CenterX: 0.26, SizePercent: 15}}, "cam-2": {{CenterX: 0.7, SizePercent: 20}}}
	for i := 0; i < 8; i++ {
		l.Add(-20, f)
	}
	// Stille: darf nicht zählen, auch wenn andere Gesichter zu sehen sind.
	for i := 0; i < 20; i++ {
		l.Add(-80, map[string][]Face{"cam-3": {{CenterX: 0.5}}})
	}
	// Nur 1 von 8: unter der Schwelle von 40 %.
	l.Add(-20, map[string][]Face{"cam-1": {{CenterX: 0.85, SizePercent: 9}}})
	c := l.Candidates(40)
	if len(c) != 2 || c[0].CameraID != "cam-1" || c[0].SeenPct < 80 {
		t.Fatalf("%+v", c)
	}
	if l.Samples() != 9 {
		t.Fatalf("Samples=%d", l.Samples())
	}
}
