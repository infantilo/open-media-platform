package mcr

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// Konfigurierbare Verarbeitungskette je Leitung (106.13g, ENTWURF-MCR.md §8). Eine Stufe ist ein beliebiger zugelassener Node-Typ
// vor (`pre`) oder nach (`post`) dem Normalizer. Die Kette kommt aus Daten: global → Event → Leitung, die nächstbesondere
// vorhandene Liste gilt ganz.

const (
	SettingChain      = "mcr.chain"
	SettingStageTypes = "mcr.stageTypes"
	MaxStages         = 8

	WherePre  = "pre"
	WherePost = "post"
)

// Stage ist eine Verarbeitungsstufe.
type Stage struct {
	ID       string         `json:"id"`
	NodeType string         `json:"nodeType"`
	Where    string         `json:"where"`
	Enabled  *bool          `json:"enabled,omitempty"`
	Label    string         `json:"label,omitempty"`
	Params   map[string]any `json:"params,omitempty"`
}

// On: ist die Stufe eingeschaltet (Standard ja).
func (s Stage) On() bool { return s.Enabled == nil || *s.Enabled }

// StageType beschreibt einen zugelassenen Node-Typ und welche Arten er trägt (Bild über Sender 1/Receiver 1, Ton über Sender 2/Receiver 2).
// Fehlt eine Art, geht sie an der Stufe vorbei direkt zur nächsten, die sie hat.
type StageType struct {
	NodeType string `json:"nodeType"`
	Label    string `json:"label,omitempty"`
	Video    bool   `json:"video"`
	Audio    bool   `json:"audio"`
}

// DefaultStageTypes: was ohne Einstellung zulässig ist (der Skalierer trägt nur Bild).
func DefaultStageTypes() []StageType {
	return []StageType{{NodeType: "omp-scaler", Label: "Scaler", Video: true}}
}

// ChainConfig sind die globalen Vorgaben für `Materialize`.
type ChainConfig struct {
	Global json.RawMessage // mcr.chain
	Types  []StageType     // mcr.stageTypes; leer = DefaultStageTypes
}

func (c ChainConfig) types() []StageType {
	if len(c.Types) == 0 {
		return DefaultStageTypes()
	}
	return c.Types
}

func (c ChainConfig) typeOf(nodeType string) (StageType, bool) {
	for _, t := range c.types() {
		if t.NodeType == nodeType {
			return t, true
		}
	}
	return StageType{}, false
}

// ParseChain liest eine Liste; `present` = false bei fehlender oder null-Angabe (erbt).
func ParseChain(raw json.RawMessage) (stages []Stage, present bool, err error) {
	t := strings.TrimSpace(string(raw))
	if t == "" || t == "null" {
		return nil, false, nil
	}
	if err := json.Unmarshal(raw, &stages); err != nil {
		return nil, true, fmt.Errorf("Kette ist keine Liste von Stufen: %v", err)
	}
	return stages, true, nil
}

// ResolveChain: die nächstbesondere vorhandene Liste gilt ganz (Leitung vor Event vor global); nur eingeschaltete Stufen.
func ResolveChain(global, event, line json.RawMessage) []Stage {
	for _, raw := range []json.RawMessage{line, event, global} {
		list, present, err := ParseChain(raw)
		if err != nil || !present {
			continue
		}
		out := []Stage{}
		for _, s := range list {
			if s.On() {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

var stageIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,23}$`)

// ValidateChain prüft eine Liste: Typ zugelassen, Platz gültig, IDs eindeutig, Größe begrenzt, keine Geheimnisse in Parametern.
func ValidateChain(label string, raw json.RawMessage, cfg ChainConfig) error {
	list, present, err := ParseChain(raw)
	if err != nil {
		return bad("%s: %v", label, err)
	}
	if !present {
		return nil
	}
	if len(list) > MaxStages {
		return bad("%s: höchstens %d Stufen", label, MaxStages)
	}
	seen := map[string]bool{}
	for i, s := range list {
		if !stageIDRe.MatchString(s.ID) {
			return bad("%s: Stufe %d hat keine gültige Kennung (a–z, 0–9, Bindestrich, höchstens 24 Zeichen)", label, i+1)
		}
		if seen[s.ID] {
			return bad("%s: Kennung „%s“ doppelt", label, s.ID)
		}
		seen[s.ID] = true
		if _, ok := cfg.typeOf(s.NodeType); !ok {
			return bad("%s: Node-Typ „%s“ ist als Stufe nicht zugelassen", label, s.NodeType)
		}
		if s.Where != WherePre && s.Where != WherePost {
			return bad("%s: Stufe „%s“: Platz muss „pre“ oder „post“ sein", label, s.ID)
		}
		for k := range s.Params {
			if strings.TrimSpace(k) == "" {
				return bad("%s: Stufe „%s“: leerer Parametername", label, s.ID)
			}
		}
		if b, err := json.Marshal(s.Params); err == nil && len(s.Params) > 0 {
			if err := checkNoSecrets(label+" Stufe "+s.ID, b); err != nil {
				return err
			}
		}
	}
	return nil
}

// StageRole verbindet eine Rolle des Workflows mit ihrer Stufe.
type StageRole struct {
	Role  string `json:"role"`
	Stage Stage  `json:"stage"`
}

// chainWiring: Reihenfolge der Rollen je Art. `entry` = erste Rolle der Art, `out` = letzte; `pairs` = Verbindungen (von, nach).
type chainWiring struct {
	entryVideo, entryAudio string
	outVideo, outAudio     string
	conns                  [][4]string // fromRole, fromPort, toRole, toPort
}

// wire legt die Verbindungen der Kette fest. `input` darf leer sein (vorhandene Quelle: der Normalizer-Zufluss kommt vom Quell-Node).
func wire(input string, pre []StageRole, norm string, post []StageRole, cfg ChainConfig) chainWiring {
	type member struct {
		role         string
		video, audio bool
	}
	var order []member
	if input != "" {
		order = append(order, member{input, true, true})
	}
	for _, s := range pre {
		t, _ := cfg.typeOf(s.Stage.NodeType)
		order = append(order, member{s.Role, t.Video, t.Audio})
	}
	order = append(order, member{norm, true, true})
	for _, s := range post {
		t, _ := cfg.typeOf(s.Stage.NodeType)
		order = append(order, member{s.Role, t.Video, t.Audio})
	}
	var w chainWiring
	prevV, prevA := "", ""
	for _, m := range order {
		if m.video {
			if prevV != "" {
				w.conns = append(w.conns, [4]string{prevV, "Sender 1", m.role, "Receiver 1"})
			} else if m.role != input {
				w.entryVideo = m.role
			}
			if w.entryVideo == "" && prevV == "" && m.role != input {
				w.entryVideo = m.role
			}
			prevV = m.role
		}
		if m.audio {
			if prevA != "" {
				w.conns = append(w.conns, [4]string{prevA, "Sender 2", m.role, "Receiver 2"})
			}
			if w.entryAudio == "" && prevA == "" && m.role != input {
				w.entryAudio = m.role
			}
			prevA = m.role
		}
	}
	w.outVideo, w.outAudio = prevV, prevA
	return w
}
