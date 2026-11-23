package mcr

import (
	"encoding/json"
	"math"
	"strings"
)

// Übergabe des gemessenen A/V-Versatzes an einen getrennten A/V-Delay-Node (Slot „avdelay“, 106.13h).
//
// Der Normalizer misst weiter (`avsync.measure`) und hält den Wert (`avsync.heldMs`, Datenbank = Quelle der Wahrheit); sein eigener
// Ausgleich steht dann auf „aus“. Hier wird aus Modus und Wert dieselbe Verzögerung berechnet, die der Normalizer selbst anwenden
// würde (`omp-normalizer::offset`/`avsync`), und als Parameter an den Delay-Node gegeben.
//
// **Vertrag eines Nodes im Slot „avdelay“:** Zahl-Parameter `delay.videoFrames` (Bildverzögerung in ganzen Bildern) und
// `delay.audioMs` (Tonverzögerung in ms, ≥ 0). Der Slot trägt die Obergrenze der Bilder (`maxFrames`, Standard 25).

const (
	ParamDelayVideoFrames = "delay.videoFrames"
	ParamDelayAudioMs     = "delay.audioMs"
	DefaultMaxDelayFrames = 25
	defaultDeadbandMs     = 10.0
)

// DelayPlan ist die berechnete Verzögerung.
type DelayPlan struct {
	VideoFrames int
	AudioMs     float64
	// OffsetMs: der ausgeglichene Versatz in Normkonvention (positiv = Ton war früh, 0 = nichts zu tun).
	OffsetMs float64
	// Exceeds: der Versatz ist größer als der Bildring zulässt; es bleibt ein Restfehler.
	Exceeds bool
}

type avsyncSettings struct {
	Mode       string   `json:"mode"`
	ManualMs   *float64 `json:"manualMs"`
	HeldMs     *float64 `json:"heldMs"`
	DeadbandMs *float64 `json:"deadbandMs"`
}

// PlanDelay berechnet die Verzögerung aus den Ausgleichs-Einstellungen einer Leitung, wie der Normalizer es selbst täte: „off“ und
// „once“ ohne gehaltenen Messwert ergeben 0 (so geht der Node nach „Zurücksetzen“ wieder auf 0). ok=false nur, wenn die Leitung
// gar keine Einstellung hat (dann gelten die Startwerte des Slots) oder der Modus nicht umgesetzt ist („tracking“).
// `frameMs` ist die Dauer eines Bildes, `maxFrames` die Obergrenze des Bildrings.
func PlanDelay(raw json.RawMessage, frameMs float64, maxFrames int) (DelayPlan, bool) {
	var a avsyncSettings
	if t := strings.TrimSpace(string(raw)); t == "" || t == "null" || t == "{}" {
		return DelayPlan{}, false
	}
	_ = json.Unmarshal(raw, &a)
	if frameMs <= 0 || math.IsNaN(frameMs) {
		return DelayPlan{}, false
	}
	if maxFrames <= 0 {
		maxFrames = DefaultMaxDelayFrames
	}
	var ms, deadband float64
	switch a.Mode {
	case "manual":
		if a.ManualMs != nil {
			ms = *a.ManualMs // ausdrückliche Vorgabe: kein Totband
		}
	case "", "once":
		if a.HeldMs != nil {
			ms = *a.HeldMs
		}
		deadband = defaultDeadbandMs
		if a.DeadbandMs != nil {
			deadband = *a.DeadbandMs
		}
	case "off":
	default: // tracking (nicht umgesetzt)
		return DelayPlan{}, false
	}
	if math.IsNaN(ms) || math.IsInf(ms, 0) {
		return DelayPlan{}, false
	}
	// Korrektur nach Normkonvention: positiv = Ton früh → Ton verzögern; negativ → Bild verzögern; im Totband nichts.
	var audioMs, videoMs float64
	switch {
	case math.Abs(ms) < math.Abs(deadband):
	case ms > 0:
		audioMs = ms
	default:
		videoMs = -ms
	}
	frames, rest := 0, 0.0
	exceeds := videoMs > float64(maxFrames)*frameMs+1e-6
	if videoMs > 0 {
		want := int(math.Ceil(videoMs/frameMs - 1e-9))
		if want <= maxFrames {
			frames, rest = want, math.Max(float64(want)*frameMs-videoMs, 0)
		} else {
			frames = maxFrames
		}
	}
	p := DelayPlan{VideoFrames: frames, AudioMs: audioMs + rest, Exceeds: exceeds}
	if audioMs != 0 || videoMs != 0 {
		p.OffsetMs = ms
	}
	return p, true
}

// DelayParams: Parameter für den Delay-Node (nur wenn es etwas zu übergeben gibt).
func (p DelayPlan) Params() map[string]any {
	return map[string]any{ParamDelayVideoFrames: p.VideoFrames, ParamDelayAudioMs: math.Round(p.AudioMs*1000) / 1000}
}

// frameDuration: Dauer eines Bildes in ms aus dem Hausformat (0 = unbekannt).
func frameDuration(eff HouseFormat) float64 {
	if eff.Video == nil {
		return 0
	}
	num, den, err := parseRate(eff.Video.Rate)
	if err != nil {
		return 0
	}
	return 1000 * float64(den) / float64(num)
}
