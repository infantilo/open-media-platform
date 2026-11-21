package mcr

import "testing"

func overlaps(a, b MVPip) bool {
	return a.X < b.X+b.Width && b.X < a.X+a.Width && a.Y < b.Y+b.Height && b.Y < a.Y+a.Height
}

func TestLayoutNoOverlapAndInsideCanvas(t *testing.T) {
	for _, n := range []int{1, 2, 3, 4, 5, 6, 9, 13} {
		tiles := make([]Tile, n)
		for i := range tiles {
			tiles[i] = Tile{ID: string(rune('a' + i))}
		}
		l := BuildLayout(tiles)
		if len(l.Pips) != n {
			t.Fatalf("n=%d: %d Kacheln", n, len(l.Pips))
		}
		for i, p := range l.Pips {
			if p.X < 0 || p.Y < 0 || p.X+p.Width > l.CanvasWidth || p.Y+p.Height > l.CanvasHeight || p.Width < 64 || p.Height < 64 {
				t.Fatalf("n=%d: Kachel %d außerhalb/zu klein: %+v", n, i, p)
			}
			for j := i + 1; j < n; j++ {
				if overlaps(p, l.Pips[j]) {
					t.Fatalf("n=%d: Kacheln %d und %d überlappen", n, i, j)
				}
			}
		}
	}
}

func TestLayoutShapes(t *testing.T) {
	if g := Grid(1, 1920, 1080); len(g) != 1 || g[0][2] < 1800 {
		t.Fatalf("eine Leitung füllt die Fläche: %v", g)
	}
	if g := Grid(4, 1920, 1080); g[0][2] != g[3][2] || g[1][0] <= g[0][0] {
		t.Fatalf("4 Leitungen: 2×2: %v", g)
	}
	if Grid(0, 100, 100) != nil {
		t.Fatal("keine Leitung, kein Raster")
	}
}

func TestUMDText(t *testing.T) {
	n := map[string]any{"normalize.state": "copy", "normalize.inputFormat": `{"video":{"height":1080,"scan":"interlaced_tff","rate":{"numerator":25,"denominator":1}}}`, "avsync.appliedMs": 40.0}
	if got := UMDText("Stadion", n); got != "Stadion · 1080i50 · unverändert · A/V +40 ms" {
		t.Fatalf("UMD: %q", got)
	}
	// 25 Hz Vollbild-Rate bei interlaced ist die Bildrate; die Halbbildrate wäre 50 — wie in der Oberfläche
	n2 := map[string]any{"normalize.state": "convert", "normalize.inputFormat": `{"video":{"height":720,"scan":"progressive","rate":50}}`}
	if got := UMDText("Cam", n2); got != "Cam · 720p50 · gewandelt" {
		t.Fatalf("UMD: %q", got)
	}
	if got := UMDText("Leer", nil); got != "Leer" {
		t.Fatalf("UMD ohne Daten: %q", got)
	}
}

func TestAlarmLevel(t *testing.T) {
	copyN := map[string]any{"normalize.state": "copy"}
	if AlarmLevel(copyN, 0) != AlarmOK || AlarmLevel(copyN, 1) != AlarmBad {
		t.Fatal("Ampel: copy grün, mit Alarm rot")
	}
	if AlarmLevel(map[string]any{"normalize.state": "waiting"}, 0) != AlarmWarn || AlarmLevel(map[string]any{"normalize.state": "error"}, 0) != AlarmBad {
		t.Fatal("Ampel: waiting gelb, error rot")
	}
}
