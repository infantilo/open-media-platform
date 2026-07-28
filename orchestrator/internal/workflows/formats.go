package workflows

import (
	"strconv"
)

// videoFormat ist ein benanntes Standard-Auflösung+Framerate-Preset
// (Nutzerwunsch 2026-07-28: "test sources brauchen einstellbares Format,
// Standardformate vorgeben, 1080p50 im Endausbau am wichtigsten, jetzt
// minimalstes Format wegen schwacher CPU") — pro Rolle wählbar (s.
// Role.Format), nicht workflow-weit wie die bestehende Settings.Program-
// Width/-Height (Kapitel 15): unterschiedliche Quellen im selben
// Workflow können unterschiedliche native Formate haben, ein
// Scaler-/Framerate-Converter-Node gleicht Unterschiede zwischen ihnen
// bei Bedarf aus (separater Node-Typ, nicht Teil dieser Datei).
type videoFormat struct {
	Width                uint32
	Height               uint32
	FramerateNumerator   uint32
	FramerateDenominator uint32
}

// standardFormats: bewusst nur progressive 16:9-Formate (kein
// interlaced) — ein synthetisches Testbild braucht keine
// Interlace-Semantik, das hätte nur unnötige GStreamer-Feld-Komplexität
// ohne Gegenwert gebracht. "480p25" bleibt der günstigste Eintrag
// (kleiner als der bisherige 640×480-Node-Default, für schwache Dev-
// Hardware); "1080p50" ist das im Endausbau wichtigste Zielformat.
// Reihenfolge hier ist auch die UI-Anzeigereihenfolge (StandardFormatNames).
//
// **Breite 848 statt der web-üblichen 854 bei "480p25" (live gefundener
// Bug, 2026-07-28):** 854 ist nicht durch 8 teilbar (854/8=106,75) —
// MXLs v210-Schreibpfad verlangt eine durch 8 teilbare Breite, ohne das
// bricht `MxlVideoInput::new` beim NÄCHSTEN Node in der Kette mit
// "flow_def: frame_width fehlt" (live reproduziert: source(480p25,854)
// → viewer UND source(480p25,854) → scaler schlugen beide exakt so
// fehl). Alle anderen Breiten hier (640/720/1280/1920) sind bereits
// durch 16 teilbar und unauffällig; 848 ist der in der Videotechnik
// übliche Ersatz für 854 aus genau diesem Ausrichtungsgrund (durch 16
// teilbar: 848/16=53).
var standardFormats = map[string]videoFormat{
	"480p25":  {Width: 848, Height: 480, FramerateNumerator: 25, FramerateDenominator: 1},
	"576p25":  {Width: 720, Height: 576, FramerateNumerator: 25, FramerateDenominator: 1},
	"720p50":  {Width: 1280, Height: 720, FramerateNumerator: 50, FramerateDenominator: 1},
	"1080p25": {Width: 1920, Height: 1080, FramerateNumerator: 25, FramerateDenominator: 1},
	"1080p50": {Width: 1920, Height: 1080, FramerateNumerator: 50, FramerateDenominator: 1},
}

var standardFormatOrder = []string{"480p25", "576p25", "720p50", "1080p25", "1080p50"}

// StandardFormatNames liefert die gültigen Preset-Namen für
// Role.Format in aufsteigender Qualitätsreihenfolge (günstigstes zuerst)
// — von der UI (Formular-Dropdown) und von validate() genutzt, damit
// beide dieselbe, einzige Quelle der Wahrheit verwenden.
func StandardFormatNames() []string {
	out := make([]string, len(standardFormatOrder))
	copy(out, standardFormatOrder)
	return out
}

// formatExtraEnv übersetzt ein Role.Format-Preset in die vom Node
// gelesenen Umgebungsvariablen (OMP_WIDTH/OMP_HEIGHT wie bei der
// bestehenden Workflow-weiten Programm-Auflösung, Kapitel 15, plus neu
// OMP_FRAMERATE_NUM/OMP_FRAMERATE_DEN) — leer/unbekannt liefert nil
// (Node behält seinen eigenen Default, keine Änderung ggü. vor diesem
// Feld).
func formatExtraEnv(name string) map[string]string {
	f, ok := standardFormats[name]
	if !ok {
		return nil
	}
	return map[string]string{
		"OMP_WIDTH":         strconv.FormatUint(uint64(f.Width), 10),
		"OMP_HEIGHT":        strconv.FormatUint(uint64(f.Height), 10),
		"OMP_FRAMERATE_NUM": strconv.FormatUint(uint64(f.FramerateNumerator), 10),
		"OMP_FRAMERATE_DEN": strconv.FormatUint(uint64(f.FramerateDenominator), 10),
	}
}
