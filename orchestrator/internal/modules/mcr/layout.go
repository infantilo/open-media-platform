package mcr

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
)

// Reine Anordnung und Beschriftung der Multiviewer-Kacheln eines Events (106.13).

// Alarmstufen einer Kachel (Rahmenfarbe im Multiviewer).
const (
	AlarmNone = ""
	AlarmOK   = "ok"
	AlarmWarn = "warn"
	AlarmBad  = "bad"
)

// Tile ist eine Kachel vor der Anordnung: eine Leitung.
type Tile struct {
	ID       string
	SenderID string
	UMD      string
	Alarm    string
}

// MVPip ist das Wire-Format einer Kachel von `POST /state` des Multiviewers.
type MVPip struct {
	ID       string `json:"id"`
	SenderID string `json:"senderId,omitempty"`
	X        int    `json:"x"`
	Y        int    `json:"y"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	UMD      string `json:"umd"`
	Alarm    string `json:"alarm,omitempty"`
}

// MVLayout ist der Zustand des Multiviewers.
type MVLayout struct {
	CanvasWidth  int     `json:"canvasWidth"`
	CanvasHeight int     `json:"canvasHeight"`
	Pips         []MVPip `json:"pips"`
}

const (
	mvCanvasW = 1280
	mvCanvasH = 720
	mvGap     = 8
)

// Grid ordnet n Kacheln in einem möglichst quadratischen Raster auf der Fläche w×h an (ohne Überlappung, mit Abstand).
// Bei einer unvollständigen letzten Zeile bleiben die Kacheln gleich groß und stehen links.
func Grid(n, w, h int) [][4]int {
	if n <= 0 {
		return nil
	}
	cols := int(math.Ceil(math.Sqrt(float64(n))))
	rows := (n + cols - 1) / cols
	cw := (w - mvGap*(cols+1)) / cols
	ch := (h - mvGap*(rows+1)) / rows
	cw -= cw % 2
	ch -= ch % 2
	out := make([][4]int, n)
	for i := 0; i < n; i++ {
		c, r := i%cols, i/cols
		out[i] = [4]int{mvGap + c*(cw+mvGap), mvGap + r*(ch+mvGap), cw, ch}
	}
	return out
}

// BuildLayout ordnet die Kacheln an.
func BuildLayout(tiles []Tile) MVLayout {
	l := MVLayout{CanvasWidth: mvCanvasW, CanvasHeight: mvCanvasH, Pips: []MVPip{}}
	for i, c := range Grid(len(tiles), mvCanvasW, mvCanvasH) {
		t := tiles[i]
		l.Pips = append(l.Pips, MVPip{ID: t.ID, SenderID: t.SenderID, X: c[0], Y: c[1], Width: c[2], Height: c[3], UMD: t.UMD, Alarm: t.Alarm})
	}
	return l
}

// UMDText: „Name · Eingangsformat · unverändert/gewandelt · A/V ± ms“; fehlende Teile entfallen.
func UMDText(name string, norm map[string]any) string {
	parts := []string{name}
	if f := inputFormatText(norm["normalize.inputFormat"]); f != "" {
		parts = append(parts, f)
	}
	switch s, _ := norm["normalize.state"].(string); s {
	case "copy":
		parts = append(parts, "unverändert")
	case "convert":
		parts = append(parts, "gewandelt")
	case "blocked":
		parts = append(parts, "blockiert")
	case "error":
		parts = append(parts, "Fehler")
	}
	if ms, ok := num(norm["avsync.appliedMs"]); ok && ms != 0 {
		parts = append(parts, fmt.Sprintf("A/V %+.0f ms", ms))
	}
	return strings.Join(parts, " · ")
}

func num(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int:
		return float64(x), true
	}
	return 0, false
}

// inputFormatText liest `normalize.inputFormat` (JSON-Text mit `video`) als „1080i25“.
func inputFormatText(v any) string {
	s, _ := v.(string)
	if s == "" {
		return ""
	}
	var f struct {
		Video struct {
			Height int    `json:"height"`
			Scan   string `json:"scan"`
			Rate   any    `json:"rate"`
		} `json:"video"`
	}
	if json.Unmarshal([]byte(s), &f) != nil || f.Video.Height == 0 {
		return ""
	}
	rate := 0.0
	switch r := f.Video.Rate.(type) {
	case float64:
		rate = r
	case map[string]any:
		n, _ := num(r["numerator"])
		d, _ := num(r["denominator"])
		if n2, ok := num(r["num"]); ok {
			n = n2
		}
		if d2, ok := num(r["den"]); ok {
			d = d2
		}
		if d > 0 {
			rate = n / d
		}
	}
	interlaced := strings.HasPrefix(f.Video.Scan, "interlaced")
	if interlaced {
		rate *= 2
	}
	suffix := "p"
	if interlaced {
		suffix = "i"
	}
	rs := ""
	if rate > 0 {
		rs = strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.2f", rate), "0"), ".")
	}
	return fmt.Sprintf("%d%s%s", f.Video.Height, suffix, rs)
}

// AlarmLevel: Ampel einer Leitung aus Normalizer-Zustand und aktiven Signalalarmen (grün/gelb/rot).
func AlarmLevel(norm map[string]any, activeAlarms int) string {
	s, _ := norm["normalize.state"].(string)
	switch {
	case s == "error" || activeAlarms > 0:
		return AlarmBad
	case s == "copy" || s == "convert":
		return AlarmOK
	case s == "blocked" || s == "waiting" || s == "":
		return AlarmWarn
	}
	return AlarmWarn
}
