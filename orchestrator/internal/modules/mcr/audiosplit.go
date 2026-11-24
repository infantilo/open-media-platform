package mcr

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Tonteiler je Leitung (Nutzerwunsch 2026-11-23): liefert eine Leitung Mehrkanalton (z. B. 16 Spuren, auf 1/2 das Stereo-Programm,
// auf 3/4 der internationale Ton, …), kann er in einzelne Ausgangs-Flows geteilt werden, damit z. B. der Audiomischer jeden einzeln
// bekommt. Ein eigener Node (Slot „splitter“, Standard `omp-audio-split`) hängt hinter dem letzten Glied der Kette; seine Ausgänge
// erscheinen als zusätzliche Ausgänge des Event-Workflows („<Leitung> · <Name>“).
//
// Einstellung an der Leitung (`normalize.audioSplit`, JSON); alle Kanäle sind **Hauskanäle** der Leitung (nach dem Normalizer):
//   - `{"mode":"tracks"}`: je gewählter Tonspur (`transport.existing.audioTracks`) ein Ausgang; Name = Bezeichnung der Spur
//     (sonst „Spur n“), Kanäle = die Hauskanäle, auf die der Normalizer die Spur legt (Spur 1 zuerst).
//   - `{"mode":"pairs"}`: je zwei Hauskanäle ein Ausgang („1/2“, „3/4“, …; ein ungerader letzter wird Mono).
//   - `{"outputs":[{"name":"Programm","channels":[1,2]},…]}`: ausdrücklich.
//
// Vertrag eines Nodes im Slot: ein Audio-Empfänger; je Ausgang ein Audio-Sender, **bezeichnet mit dem Ausgangsnamen**; Ausgänge
// kommen beim Start über `OMP_SPLIT_OUTPUTS` (JSON `[{"name":…,"channels":[…]}]`).

const (
	SplitModeTracks = "tracks"
	SplitModePairs  = "pairs"
	MaxSplitOutputs = 32
)

// SplitOut ist ein Ausgang des Tonteilers.
type SplitOut struct {
	Name     string `json:"name"`
	Channels []int  `json:"channels"`
}

// AudioSplit ist die Einstellung an der Leitung.
type AudioSplit struct {
	Mode    string     `json:"mode,omitempty"`
	Outputs []SplitOut `json:"outputs,omitempty"`
}

// ParseAudioSplit liest `normalize.audioSplit`; nil = nicht eingestellt (kein Tonteiler).
func ParseAudioSplit(l Line) (*AudioSplit, error) {
	if len(l.Normalize) == 0 {
		return nil, nil
	}
	var n struct {
		AudioSplit json.RawMessage `json:"audioSplit"`
	}
	if err := json.Unmarshal(l.Normalize, &n); err != nil {
		return nil, nil // andere Fehler meldet die übrige Prüfung
	}
	t := strings.TrimSpace(string(n.AudioSplit))
	if t == "" || t == "null" || t == "{}" || t == "false" {
		return nil, nil
	}
	var a AudioSplit
	if err := json.Unmarshal(n.AudioSplit, &a); err != nil {
		return nil, bad("Leitung „%s“: audioSplit: %v", l.Name, err)
	}
	switch a.Mode {
	case "", SplitModeTracks, SplitModePairs:
	default:
		return nil, bad("Leitung „%s“: audioSplit.mode „%s“ unbekannt (tracks, pairs)", l.Name, a.Mode)
	}
	if a.Mode == "" && len(a.Outputs) == 0 {
		return nil, bad("Leitung „%s“: audioSplit braucht mode (tracks, pairs) oder outputs", l.Name)
	}
	if a.Mode != "" && len(a.Outputs) > 0 {
		return nil, bad("Leitung „%s“: audioSplit: entweder mode oder outputs, nicht beides", l.Name)
	}
	return &a, nil
}

// ValidateSplitOutputs prüft Namen (eindeutig, nicht leer, ≤ 40 Zeichen) und Kanäle (1…64, je Ausgang ohne Doppelte).
func ValidateSplitOutputs(label string, outs []SplitOut) error {
	if len(outs) == 0 {
		return bad("%s: mindestens ein Ausgang", label)
	}
	if len(outs) > MaxSplitOutputs {
		return bad("%s: höchstens %d Ausgänge", label, MaxSplitOutputs)
	}
	names := map[string]bool{}
	for i, o := range outs {
		n := strings.TrimSpace(o.Name)
		if n == "" || len([]rune(n)) > 40 {
			return bad("%s: Ausgang %d: Name leer oder länger als 40 Zeichen", label, i+1)
		}
		if names[n] {
			return bad("%s: Ausgangsname „%s“ doppelt", label, n)
		}
		names[n] = true
		if len(o.Channels) == 0 || len(o.Channels) > 64 {
			return bad("%s: Ausgang „%s“: 1…64 Kanäle", label, n)
		}
		seen := map[int]bool{}
		for _, c := range o.Channels {
			if c < 1 || c > 64 {
				return bad("%s: Ausgang „%s“: Kanal %d außerhalb 1…64", label, n, c)
			}
			if seen[c] {
				return bad("%s: Ausgang „%s“: Kanal %d doppelt", label, n, c)
			}
			seen[c] = true
		}
	}
	return nil
}

// ResolveAudioSplit liefert die Ausgänge der Leitung in Hauskanälen. `houseChannels` = Kanalzahl des Haustons (0 = unbekannt).
// nil = kein Tonteiler.
func ResolveAudioSplit(l Line, houseChannels int) ([]SplitOut, error) {
	a, err := ParseAudioSplit(l)
	if err != nil || a == nil {
		return nil, err
	}
	return resolveSplitOuts(l, a, fmt.Sprintf("Leitung „%s“ Tonteiler", l.Name), houseChannels)
}

// resolveSplitOuts löst `tracks`/`pairs`/ausdrückliche Ausgänge in Ausgänge mit Hauskanälen auf (gemeinsam für Tonteiler und Ton-Matrix).
func resolveSplitOuts(l Line, a *AudioSplit, label string, houseChannels int) ([]SplitOut, error) {
	var outs []SplitOut
	switch {
	case len(a.Outputs) > 0:
		outs = append(outs, a.Outputs...)
	case a.Mode == SplitModeTracks:
		ex := ExistingSourceOf(l)
		if ex == nil || len(ex.AudioTracks) == 0 {
			return nil, bad("%s: mode „tracks“ braucht gewählte Tonspuren (Matrix oder Leitungsformular)", label)
		}
		pos := 0
		for i, t := range ex.AudioTracks {
			name := strings.TrimSpace(t.Label)
			if name == "" {
				name = fmt.Sprintf("Spur %d", i+1)
			}
			o := SplitOut{Name: name}
			for range t.Channels {
				pos++
				o.Channels = append(o.Channels, pos)
			}
			outs = append(outs, o)
		}
	case a.Mode == SplitModePairs:
		if houseChannels < 1 {
			return nil, bad("%s: mode „pairs“ braucht die Kanalzahl des Haustons (Hausformat, Ton)", label)
		}
		for c := 1; c <= houseChannels && len(outs) < MaxSplitOutputs; c += 2 {
			if c+1 <= houseChannels {
				outs = append(outs, SplitOut{Name: fmt.Sprintf("%d/%d", c, c+1), Channels: []int{c, c + 1}})
			} else {
				outs = append(outs, SplitOut{Name: fmt.Sprintf("%d", c), Channels: []int{c}})
			}
		}
	}
	if err := ValidateSplitOutputs(label, outs); err != nil {
		return nil, err
	}
	if houseChannels > 0 {
		for _, o := range outs {
			for _, c := range o.Channels {
				if c > houseChannels {
					return nil, bad("%s: Ausgang „%s“ nennt Hauskanal %d, der Haus-Ton hat %d Kanäle", label, o.Name, c, houseChannels)
				}
			}
		}
	}
	return outs, nil
}

// SplitterEnv: Startumgebung des Tonteilers.
func SplitterEnv(outs []SplitOut, houseChannels int) map[string]string {
	b, _ := json.Marshal(outs)
	env := map[string]string{"OMP_SPLIT_OUTPUTS": string(b)}
	if houseChannels > 0 {
		env["OMP_SPLIT_INPUT_CHANNELS"] = fmt.Sprint(houseChannels)
	}
	return env
}
