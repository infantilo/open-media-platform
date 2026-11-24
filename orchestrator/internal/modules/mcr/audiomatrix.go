package mcr

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
)

// Ton-Matrix je Leitung (Kap. 107.4, Nutzerauftrag 2026-11-24): Verallgemeinerung des Tonteilers. Ein Node `omp-audio-matrix` (Slot
// „matrix“) hängt hinter dem Ton-Ausgang der Kette; sein **erster Eingang** bekommt den Haus-Ton der Leitung, jeder Ausgang
// (Mono, Stereo, … bis 64 Kanäle, mit Namen und Kanal-Labels) wird Workflow-Ausgang „<Leitung> · <Name>“. Weitere Eingänge
// (z. B. Kommentator aus einer anderen Quelle) verbindet der Nutzer im Event; sie bleiben bis dahin ohne Signal.
//
// Einstellung (`normalize.audioMatrix`, JSON), entweder
//   - `{"mode":"tracks"|"pairs"}`: wie beim Tonteiler, aber als Matrix umgesetzt (ein Eingang „Input“, je Ausgang Kopierkreuzpunkte), oder
//   - die vollständige Konfiguration `{"inputs":[…],"outputs":[…],"routes":[…]}` des Nodes (siehe `omp_mediaio::matrix`):
//     Ports mit `id`, `name`, `channels` (Text oder `{"label","symbol"}`), Kreuzpunkte `{"out","ch","in","inCh","gainDb"}`.
//
// Neben `audioSplit` nicht erlaubt. Die Prüfung spiegelt `omp_mediaio::matrix::validate` (Grenzen, Namen, Symbole nach VSF TR-03).

const (
	MatrixMaxInputs   = 16
	MatrixMaxOutputs  = 32
	MatrixMaxChannels = 64
	MatrixMaxSources  = 16
	MatrixGainMin     = -120.0
	MatrixGainMax     = 24.0
	NodeAudioMatrix   = "omp-audio-matrix"
)

// MatrixChan: Kanal eines Ports; in JSON Text oder Objekt.
type MatrixChan struct {
	Label  string `json:"label"`
	Symbol string `json:"symbol,omitempty"`
}

func (c *MatrixChan) UnmarshalJSON(b []byte) error {
	var s string
	if json.Unmarshal(b, &s) == nil {
		*c = MatrixChan{Label: s}
		return nil
	}
	type plain MatrixChan
	var p plain
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*c = MatrixChan(p)
	return nil
}

type MatrixPort struct {
	ID       string       `json:"id"`
	Name     string       `json:"name"`
	Channels []MatrixChan `json:"channels"`
}

type MatrixRoute struct {
	Out    string   `json:"out"`
	Ch     int      `json:"ch"`
	In     string   `json:"in"`
	InCh   int      `json:"inCh"`
	GainDb *float64 `json:"gainDb,omitempty"`
}

// MatrixConfig ist die Konfiguration des Nodes (`OMP_MATRIX_CONFIG`/Parameter `matrix.config`).
type MatrixConfig struct {
	Inputs  []MatrixPort  `json:"inputs"`
	Outputs []MatrixPort  `json:"outputs"`
	Routes  []MatrixRoute `json:"routes"`
}

var matrixSymbols = map[string]bool{"L": true, "R": true, "C": true, "LFE": true, "Ls": true, "Rs": true, "Lss": true, "Rss": true, "Lrs": true, "Rrs": true, "Lc": true, "Rc": true, "Cs": true, "HI": true, "VIN": true, "M1": true, "M2": true, "Lt": true, "Rt": true, "Lst": true, "Rst": true, "S": true}

func digitsIn(s string, n, lo, hi int) bool {
	if len(s) != n {
		return false
	}
	v := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
		v = v*10 + int(r-'0')
	}
	return v >= lo && v <= hi
}

// ValidMatrixSymbol: Kanalsymbole nach VSF TR-03 Anhang A (Aufzählung aus IS-04 v1.3 `source_audio.json`), `NSCnnn`, `Unn`.
func ValidMatrixSymbol(s string) bool {
	if matrixSymbols[s] {
		return true
	}
	if strings.HasPrefix(s, "NSC") {
		return digitsIn(s[3:], 3, 0, 128)
	}
	if strings.HasPrefix(s, "U") {
		return digitsIn(s[1:], 2, 1, 64)
	}
	return false
}

func validateMatrixPorts(label, kind string, ports []MatrixPort, max int) error {
	if len(ports) > max {
		return bad("%s: höchstens %d %s", label, max, kind)
	}
	ids, names := map[string]bool{}, map[string]bool{}
	for _, p := range ports {
		id, name := strings.TrimSpace(p.ID), strings.TrimSpace(p.Name)
		if id == "" || len([]rune(id)) > 40 {
			return bad("%s: %s: ID leer oder länger als 40 Zeichen", label, kind)
		}
		if name == "" || len([]rune(name)) > 40 {
			return bad("%s: %s „%s“: Name leer oder länger als 40 Zeichen", label, kind, id)
		}
		if ids[id] {
			return bad("%s: %s-ID „%s“ doppelt", label, kind, id)
		}
		if names[name] {
			return bad("%s: %s-Name „%s“ doppelt", label, kind, name)
		}
		ids[id], names[name] = true, true
		if len(p.Channels) < 1 || len(p.Channels) > MatrixMaxChannels {
			return bad("%s: %s „%s“: 1…%d Kanäle", label, kind, name, MatrixMaxChannels)
		}
		for i, c := range p.Channels {
			if len([]rune(c.Label)) > 40 {
				return bad("%s: %s „%s“: Kanal %d Label länger als 40 Zeichen", label, kind, name, i+1)
			}
			if c.Symbol != "" && !ValidMatrixSymbol(c.Symbol) {
				return bad("%s: %s „%s“: Kanal %d Symbol „%s“ unbekannt (VSF TR-03 Anhang A)", label, kind, name, i+1, c.Symbol)
			}
		}
	}
	return nil
}

// ValidateMatrix prüft die Konfiguration wie der Node; für den MCR zusätzlich mindestens ein Eingang (erster = Haus-Ton) und ein Ausgang.
func ValidateMatrix(label string, c MatrixConfig) error {
	if len(c.Inputs) == 0 || len(c.Outputs) == 0 {
		return bad("%s: mindestens ein Eingang und ein Ausgang", label)
	}
	if err := validateMatrixPorts(label, "Eingang", c.Inputs, MatrixMaxInputs); err != nil {
		return err
	}
	if err := validateMatrixPorts(label, "Ausgang", c.Outputs, MatrixMaxOutputs); err != nil {
		return err
	}
	in, out := map[string]int{}, map[string]int{}
	for _, p := range c.Inputs {
		in[p.ID] = len(p.Channels)
	}
	for _, p := range c.Outputs {
		out[p.ID] = len(p.Channels)
	}
	seen := map[string]bool{}
	per := map[string]int{}
	for _, r := range c.Routes {
		no, ok := out[r.Out]
		if !ok {
			return bad("%s: Kreuzpunkt: Ausgang „%s“ gibt es nicht", label, r.Out)
		}
		ni, ok := in[r.In]
		if !ok {
			return bad("%s: Kreuzpunkt: Eingang „%s“ gibt es nicht", label, r.In)
		}
		if r.Ch < 1 || r.Ch > no {
			return bad("%s: Kreuzpunkt: Ausgang „%s“ hat keinen Kanal %d", label, r.Out, r.Ch)
		}
		if r.InCh < 1 || r.InCh > ni {
			return bad("%s: Kreuzpunkt: Eingang „%s“ hat keinen Kanal %d", label, r.In, r.InCh)
		}
		if r.GainDb != nil && (math.IsNaN(*r.GainDb) || math.IsInf(*r.GainDb, 0) || *r.GainDb < MatrixGainMin || *r.GainDb > MatrixGainMax) {
			return bad("%s: Kreuzpunkt %s→%s: Gain außerhalb %v…%v dB", label, r.In, r.Out, MatrixGainMin, MatrixGainMax)
		}
		key := fmt.Sprintf("%s|%d|%s|%d", r.Out, r.Ch, r.In, r.InCh)
		if seen[key] {
			return bad("%s: Kreuzpunkt %s:%d → %s:%d doppelt", label, r.In, r.InCh, r.Out, r.Ch)
		}
		seen[key] = true
		t := fmt.Sprintf("%s|%d", r.Out, r.Ch)
		per[t]++
		if per[t] > MatrixMaxSources {
			return bad("%s: Ausgang „%s“ Kanal %d: höchstens %d Quellen", label, r.Out, r.Ch, MatrixMaxSources)
		}
	}
	return nil
}

// AudioMatrix ist die Einstellung an der Leitung: Voreinstellung (`mode`) oder vollständige Konfiguration.
type AudioMatrix struct {
	Mode   string        `json:"mode,omitempty"`
	Config *MatrixConfig `json:"-"`
}

// ParseAudioMatrix liest `normalize.audioMatrix`; nil = nicht eingestellt. Prüft schon die Form (nicht gegen den Haus-Ton).
func ParseAudioMatrix(l Line) (*AudioMatrix, error) {
	if len(l.Normalize) == 0 {
		return nil, nil
	}
	var n struct {
		AudioMatrix json.RawMessage `json:"audioMatrix"`
	}
	if err := json.Unmarshal(l.Normalize, &n); err != nil {
		return nil, nil // andere Fehler meldet die übrige Prüfung
	}
	t := strings.TrimSpace(string(n.AudioMatrix))
	if t == "" || t == "null" || t == "{}" || t == "false" {
		return nil, nil
	}
	label := fmt.Sprintf("Leitung „%s“ Ton-Matrix", l.Name)
	var raw struct {
		Mode    string          `json:"mode"`
		Inputs  json.RawMessage `json:"inputs"`
		Outputs json.RawMessage `json:"outputs"`
		Routes  json.RawMessage `json:"routes"`
	}
	if err := json.Unmarshal(n.AudioMatrix, &raw); err != nil {
		return nil, bad("%s: %v", label, err)
	}
	full := len(raw.Inputs) > 0 || len(raw.Outputs) > 0 || len(raw.Routes) > 0
	switch {
	case raw.Mode != "" && full:
		return nil, bad("%s: entweder mode oder Konfiguration (inputs/outputs/routes), nicht beides", label)
	case raw.Mode != "":
		if raw.Mode != SplitModeTracks && raw.Mode != SplitModePairs {
			return nil, bad("%s: mode „%s“ unbekannt (tracks, pairs)", label, raw.Mode)
		}
		return &AudioMatrix{Mode: raw.Mode}, nil
	case full:
		var c MatrixConfig
		if err := json.Unmarshal(n.AudioMatrix, &c); err != nil {
			return nil, bad("%s: %v", label, err)
		}
		if err := ValidateMatrix(label, c); err != nil {
			return nil, err
		}
		return &AudioMatrix{Config: &c}, nil
	}
	return nil, bad("%s: braucht mode (tracks, pairs) oder inputs/outputs/routes", label)
}

// matrixFromSplit setzt Tonteiler-Ausgänge in eine Matrix um: ein Eingang „Input“ mit `channels` Kanälen, je Ausgang Kopierkreuzpunkte.
func matrixFromSplit(outs []SplitOut, channels int) MatrixConfig {
	for _, o := range outs {
		for _, c := range o.Channels {
			if c > channels {
				channels = c
			}
		}
	}
	in := MatrixPort{ID: "in1", Name: "Input"}
	for i := 1; i <= channels; i++ {
		in.Channels = append(in.Channels, MatrixChan{Label: fmt.Sprint(i)})
	}
	c := MatrixConfig{Inputs: []MatrixPort{in}}
	for k, o := range outs {
		p := MatrixPort{ID: fmt.Sprintf("out%d", k+1), Name: strings.TrimSpace(o.Name)}
		for j, ch := range o.Channels {
			p.Channels = append(p.Channels, MatrixChan{Label: fmt.Sprint(ch)})
			c.Routes = append(c.Routes, MatrixRoute{Out: p.ID, Ch: j + 1, In: "in1", InCh: ch})
		}
		c.Outputs = append(c.Outputs, p)
	}
	return c
}

// ResolveAudioMatrix liefert die Matrix der Leitung (nil = keine). `houseChannels` = Kanalzahl des Haustons (0 = unbekannt).
func ResolveAudioMatrix(l Line, houseChannels int) (*MatrixConfig, error) {
	a, err := ParseAudioMatrix(l)
	if err != nil || a == nil {
		return nil, err
	}
	label := fmt.Sprintf("Leitung „%s“ Ton-Matrix", l.Name)
	if a.Mode != "" {
		outs, err := resolveSplitOuts(l, &AudioSplit{Mode: a.Mode}, label, houseChannels)
		if err != nil {
			return nil, err
		}
		c := matrixFromSplit(outs, houseChannels)
		if err := ValidateMatrix(label, c); err != nil {
			return nil, err
		}
		return &c, nil
	}
	c := *a.Config
	if houseChannels > 0 && len(c.Inputs[0].Channels) > houseChannels {
		return nil, bad("%s: erster Eingang „%s“ hat %d Kanäle, der Haus-Ton nur %d", label, c.Inputs[0].Name, len(c.Inputs[0].Channels), houseChannels)
	}
	return &c, nil
}

// MatrixEnv: Startumgebung des Matrix-Nodes.
func MatrixEnv(c MatrixConfig) map[string]string {
	b, _ := json.Marshal(c)
	return map[string]string{"OMP_MATRIX_CONFIG": string(b)}
}
