package ingest

import (
	"fmt"
	"strings"
)

// Grenzen des Kanalplans (Kapitel 45). Der Rekorder erzwingt dieselben Werte noch einmal.
const (
	maxAudioInputs   = 7  // weitere Quellen neben der Hauptquelle (Rekorder: höchstens 8 Audio-Receiver)
	maxOutChannels   = 32 // Ausgabekanäle der Datei
	maxOutChannelsAV = 8  // AAC in Matroska
	minGainDb        = -96.0
	maxGainDb        = 24.0
)

// validateAudio prüft einen Kanalplan; leere Liste = in Ordnung. `profile` bestimmt das Containerformat (MXF trägt PCM beliebiger Kanalzahl,
// andere Formate nur bis 8 Kanäle). `channelCount` (optional) liefert die Kanalzahl einer Quelle, wenn sie gerade bekannt ist.
func validateAudio(p *AudioPlan, primary Source, prof Profile, channelCount func(Source) (int, bool)) []string {
	if p == nil {
		return nil
	}
	var out []string
	if len(p.Channels) == 0 {
		return []string{"Kanalplan hat keine Ausgabekanäle"}
	}
	limit := maxOutChannelsAV
	if strings.EqualFold(prof.Ext, ".mxf") {
		limit = maxOutChannels
	}
	if len(p.Channels) > limit {
		out = append(out, fmt.Sprintf("Kanalplan: höchstens %d Ausgabekanäle bei Profil %q (MXF: %d)", limit, prof.ID, maxOutChannels))
	}
	if len(p.Inputs) > maxAudioInputs {
		out = append(out, fmt.Sprintf("Kanalplan: höchstens %d weitere Quellen", maxAudioInputs))
	}
	for i, s := range p.Inputs {
		if s.Key() == "unknown" {
			out = append(out, fmt.Sprintf("Kanalplan: weitere Quelle %d hat keine Quelle (Instanz oder Sender)", i+1))
		}
	}
	srcOf := func(i int) Source {
		if i == 0 {
			return primary
		}
		return p.Inputs[i-1]
	}
	mapped := 0
	for n, c := range p.Channels {
		if c.Input == nil {
			continue
		}
		mapped++
		i := *c.Input
		if i < 0 || i > len(p.Inputs) {
			out = append(out, fmt.Sprintf("Ausgabekanal %d: Quelle %d gibt es nicht", n+1, i))
			continue
		}
		if c.Channel < 0 || c.Channel >= 64 {
			out = append(out, fmt.Sprintf("Ausgabekanal %d: Eingangskanal %d ungültig", n+1, c.Channel+1))
		} else if channelCount != nil {
			if cnt, ok := channelCount(srcOf(i)); ok && c.Channel >= cnt {
				out = append(out, fmt.Sprintf("Ausgabekanal %d: Quelle %d hat nur %d Kanäle (Kanal %d gewählt)", n+1, i, cnt, c.Channel+1))
			}
		}
		if c.GainDb < minGainDb || c.GainDb > maxGainDb {
			out = append(out, fmt.Sprintf("Ausgabekanal %d: Gain %.1f dB außerhalb %.0f…%.0f", n+1, c.GainDb, minGainDb, maxGainDb))
		}
	}
	if mapped == 0 {
		out = append(out, "Kanalplan: kein Ausgabekanal ist mit einer Quelle belegt")
	}
	return out
}

// normalizeAudio: leerer Plan zählt als „kein Plan“; Beschriftungen werden getrimmt.
func normalizeAudio(p *AudioPlan) *AudioPlan {
	if p == nil || (len(p.Channels) == 0 && len(p.Inputs) == 0) {
		return nil
	}
	for i := range p.Channels {
		p.Channels[i].Label = strings.TrimSpace(p.Channels[i].Label)
	}
	return p
}

// inputs: weitere Quellen (nil-sicher).
func (p *AudioPlan) inputs() []Source {
	if p == nil {
		return nil
	}
	return p.Inputs
}

// Layout: lesbare Beschreibung der Ausgabekanäle für die Asset-Metadaten („1: Quelle 1 Kanal 2 (−3 dB) · Kommentar“).
func (p *AudioPlan) Layout() []map[string]any {
	var out []map[string]any
	for n, c := range p.Channels {
		e := map[string]any{"channel": n + 1, "label": c.Label}
		if c.Input == nil {
			e["silence"] = true
		} else {
			e["input"], e["inputChannel"], e["gainDb"] = *c.Input, c.Channel+1, c.GainDb
			if *c.Input >= 0 && *c.Input <= len(p.Inputs) && *c.Input > 0 {
				e["source"] = p.Inputs[*c.Input-1].Label
			}
		}
		out = append(out, e)
	}
	return out
}
