package mcr

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Konfigurierbare Verarbeitungskette je Leitung (106.13g, ENTWURF-MCR.md §8). Eine Stufe ist ein beliebiger zugelassener Node-Typ
// vor (`pre`) oder nach (`post`) dem Normalizer. Die Kette kommt aus Daten: global → Event → Leitung, die nächstbesondere
// vorhandene Liste gilt ganz.

const (
	SettingChain      = "mcr.chain"
	SettingStageTypes = "mcr.stageTypes"
	SettingSlots      = "mcr.slots"
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
	Ports    Ports  `json:"ports,omitempty"`
	// Env: Vorlage der Start-Umgebung aus dem wirksamen Hausformat der Leitung (Platzhalter siehe houseEnv). Leer = Standard des Typs.
	Env map[string]string `json:"env,omitempty"`
}

// DefaultStageTypes: was ohne Einstellung zulässig ist (der Skalierer trägt nur Bild).
func DefaultStageTypes() []StageType {
	return []StageType{{NodeType: "omp-scaler", Label: "Scaler", Video: true}}
}

// Ports: Bezeichnungen der Ein-/Ausgänge einer Stufe. Leer = Standard der MCR-Nodes („Receiver 1“/„Sender 1“ = Bild,
// „Receiver 2“/„Sender 2“ = Ton). Fremde Nodes mit anderen Bezeichnungen tragen sie hier ein.
type Ports struct {
	VideoIn  string `json:"videoIn,omitempty"`
	VideoOut string `json:"videoOut,omitempty"`
	AudioIn  string `json:"audioIn,omitempty"`
	AudioOut string `json:"audioOut,omitempty"`
}

func orDefault(v, def string) string {
	if strings.TrimSpace(v) == "" {
		return def
	}
	return v
}

// resolved: Ports mit Standardwerten.
func (p Ports) resolved() Ports {
	return Ports{orDefault(p.VideoIn, "Receiver 1"), orDefault(p.VideoOut, "Sender 1"), orDefault(p.AudioIn, "Receiver 2"), orDefault(p.AudioOut, "Sender 2")}
}

// Slot benennt den Node-Typ, der eine MCR-Funktion erfüllt. Austausch = anderen Typ eintragen (Einstellung `mcr.slots`),
// ohne Codeänderung; wirksam beim nächsten Aufbau der Leitung.
type Slot struct {
	NodeType string `json:"nodeType"`
	// Video/Audio: welche Arten der Node trägt (nur bei Converter/AVDelay; der Normalizer trägt immer beides).
	Video bool `json:"video,omitempty"`
	Audio bool `json:"audio,omitempty"`
	// Strict (nur Converter): der Normalizer wandelt nicht mehr selbst (`copyOnly`); bleibt eine Abweichung, blockiert er mit Alarm
	// statt heimlich nachzuwandeln. Ohne Strict bleibt er Sicherheitsnetz (`auto`: kopiert bei passendem Format, wandelt sonst).
	Strict bool `json:"strict,omitempty"`
	// Ports: abweichende Port-Bezeichnungen des Nodes (leer = MCR-Standard).
	Ports Ports `json:"ports,omitempty"`
	// Env: Vorlage der Start-Umgebung aus dem Hausformat (leer = Standard des Typs, z. B. Skalierer).
	Env map[string]string `json:"env,omitempty"`
	// Params: Parameter, die nach dem Start an den Node gehen (z. B. Startverzögerung des A/V-Delays).
	Params map[string]any `json:"params,omitempty"`
}

// Slots: austauschbare Funktionen des MCR.
//   - Normalizer: der Hauptknoten je Leitung (Standard `omp-normalizer`, Alleskönner: Format, Versatz).
//   - Converter: getrennter Up-/Down-Converter vor dem Normalizer; leer = Wandlung intern im Normalizer.
//   - AVDelay: getrennter A/V-Delay-Node nach dem Normalizer; leer = Ausgleich intern im Normalizer.
type Slots struct {
	Normalizer Slot `json:"normalizer"`
	Converter  Slot `json:"converter"`
	AVDelay    Slot `json:"avdelay"`
}

// DefaultSlots: ohne Einstellung wie bisher (alles im Normalizer).
func DefaultSlots() Slots {
	return Slots{Normalizer: Slot{NodeType: NodeNormalizer, Video: true, Audio: true}}
}

// normalized füllt den Normalizer-Standard nach.
func (sl Slots) normalized() Slots {
	if strings.TrimSpace(sl.Normalizer.NodeType) == "" {
		sl.Normalizer = DefaultSlots().Normalizer
	}
	return sl
}

// Validate: Typnamen plausibel; ein getrennter Node muss mindestens eine Art tragen.
func (sl Slots) Validate() error {
	sl = sl.normalized()
	for name, s := range map[string]Slot{"Normalizer": sl.Normalizer, "Converter": sl.Converter, "A/V-Delay": sl.AVDelay} {
		t := strings.TrimSpace(s.NodeType)
		if t == "" {
			continue
		}
		if !nodeTypeRe.MatchString(t) {
			return bad("Funktion %s: Node-Typ „%s“ ungültig", name, s.NodeType)
		}
		if name != "Normalizer" && !s.Video && !s.Audio {
			return bad("Funktion %s: Node trägt weder Bild noch Ton", name)
		}
	}
	return nil
}

var nodeTypeRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

// ChainConfig sind die globalen Vorgaben für `Materialize`.
type ChainConfig struct {
	Global json.RawMessage // mcr.chain
	Types  []StageType     // mcr.stageTypes; leer = DefaultStageTypes
	Slots  Slots           // mcr.slots; leer = DefaultSlots
}

// autoStages: aus den Slots abgeleitete Stufen (Converter vorn, A/V-Delay hinten), die vor der Benutzerkette stehen.
func (c ChainConfig) autoStages() []Stage {
	sl := c.Slots.normalized()
	var out []Stage
	if t := strings.TrimSpace(sl.Converter.NodeType); t != "" {
		out = append(out, Stage{ID: "conv", NodeType: t, Where: WherePre, Label: "Converter", Params: sl.Converter.Params})
	}
	if t := strings.TrimSpace(sl.AVDelay.NodeType); t != "" {
		out = append(out, Stage{ID: "avdelay", NodeType: t, Where: WherePost, Label: "A/V-Delay", Params: sl.AVDelay.Params})
	}
	return out
}

// normalizerType: Node-Typ des Hauptknotens je Leitung.
func (c ChainConfig) normalizerType() string { return c.Slots.normalized().Normalizer.NodeType }

func (c ChainConfig) types() []StageType {
	if len(c.Types) == 0 {
		return DefaultStageTypes()
	}
	return c.Types
}

func (c ChainConfig) typeOf(nodeType string) (StageType, bool) {
	sl := c.Slots.normalized()
	for _, x := range []Slot{sl.Converter, sl.AVDelay} {
		if x.NodeType != "" && x.NodeType == nodeType {
			return StageType{NodeType: nodeType, Video: x.Video, Audio: x.Audio, Ports: x.Ports, Env: x.Env}, true
		}
	}
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
	outVideoPort           string // Ausgangsport der letzten Rolle je Art
	outAudioPort           string
	conns                  [][4]string // fromRole, fromPort, toRole, toPort
}

// wire legt die Verbindungen der Kette fest. `input` darf leer sein (vorhandene Quelle: der Normalizer-Zufluss kommt vom Quell-Node).
func wire(input string, pre []StageRole, norm string, post []StageRole, cfg ChainConfig) chainWiring {
	type member struct {
		role         string
		video, audio bool
		ports        Ports
	}
	std := Ports{}.resolved()
	var order []member
	if input != "" {
		order = append(order, member{input, true, true, std})
	}
	for _, s := range pre {
		t, _ := cfg.typeOf(s.Stage.NodeType)
		order = append(order, member{s.Role, t.Video, t.Audio, t.Ports.resolved()})
	}
	order = append(order, member{norm, true, true, std})
	for _, s := range post {
		t, _ := cfg.typeOf(s.Stage.NodeType)
		order = append(order, member{s.Role, t.Video, t.Audio, t.Ports.resolved()})
	}
	var w chainWiring
	prevV, prevA := "", ""
	var prevVP, prevAP string // Ausgangsport der vorigen Rolle je Art
	for _, m := range order {
		if m.video {
			if prevV != "" {
				w.conns = append(w.conns, [4]string{prevV, prevVP, m.role, m.ports.VideoIn})
			} else if m.role != input {
				w.entryVideo = m.role
			}
			if w.entryVideo == "" && prevV == "" && m.role != input {
				w.entryVideo = m.role
			}
			prevV, prevVP = m.role, m.ports.VideoOut
		}
		if m.audio {
			if prevA != "" {
				w.conns = append(w.conns, [4]string{prevA, prevAP, m.role, m.ports.AudioIn})
			}
			if w.entryAudio == "" && prevA == "" && m.role != input {
				w.entryAudio = m.role
			}
			prevA, prevAP = m.role, m.ports.AudioOut
		}
	}
	w.outVideo, w.outAudio = prevV, prevA
	w.outVideoPort, w.outAudioPort = prevVP, prevAP
	return w
}

// normalizerOverrides: Einstellungen, die der Normalizer bekommt, weil Funktionen an getrennte Nodes abgegeben sind.
//   - A/V-Delay getrennt: sein eigener Ausgleich ist aus (`avsync.mode=off`), sonst würde der Versatz doppelt korrigiert.
//     Das gilt auch gegen die Einstellung der Leitung. Messen bleibt möglich, Übernehmen wirkt dann nicht auf den Normalizer.
//   - Converter getrennt und `strict`: `normalize.mode=copyOnly`.
//   - Converter getrennt ohne `strict`: nichts; ein passendes Format wird ohnehin nur kopiert, der Normalizer wandelt nur bei Abweichung.
func (sl Slots) normalizerOverrides() (avsyncOff, copyOnly bool) {
	sl = sl.normalized()
	return strings.TrimSpace(sl.AVDelay.NodeType) != "", strings.TrimSpace(sl.Converter.NodeType) != "" && sl.Converter.Strict
}

// defaultStageEnv: Start-Umgebung bekannter Stufen-Typen aus dem Hausformat. Der Skalierer bekommt sein Ziel nur beim Start
// (Parameter sind schreibgeschützt); ohne Vorlage fiele er auf 640×480@25 zurück und der Normalizer müsste nachwandeln.
var defaultStageEnv = map[string]map[string]string{
	"omp-avdelay": {"OMP_WIDTH": "{width}", "OMP_HEIGHT": "{height}", "OMP_FRAMERATE_NUM": "{rateNum}", "OMP_FRAMERATE_DEN": "{rateDen}", "OMP_AUDIO_CHANNELS": "{channels}"},
	"omp-scaler":  {"OMP_WIDTH": "{width}", "OMP_HEIGHT": "{height}", "OMP_FRAMERATE_NUM": "{rateNum}", "OMP_FRAMERATE_DEN": "{rateDen}"},
}

// houseEnv setzt eine Vorlage mit dem Hausformat ein. Bild-Platzhalter: {width} {height} {rate} (25/1) {rateNum} {rateDen} {scan};
// Ton-Platzhalter: {channels} {sampleRate}. Ein Eintrag, dessen Platzhalter fehlen (Hausformat ohne Bild bzw. Ton), entfällt;
// der Node behält dann seinen eigenen Standard.
func houseEnv(tpl map[string]string, h HouseFormat) map[string]string {
	if len(tpl) == 0 {
		return nil
	}
	var pairs []string
	if v := h.Video; v != nil {
		if num, den, err := parseRate(v.Rate); err == nil {
			pairs = append(pairs, "{width}", strconv.Itoa(v.Width), "{height}", strconv.Itoa(v.Height), "{rate}", v.Rate,
				"{rateNum}", strconv.Itoa(num), "{rateDen}", strconv.Itoa(den), "{scan}", v.Scan)
		}
	}
	if a := h.Audio; a != nil {
		pairs = append(pairs, "{channels}", strconv.Itoa(a.Channels), "{sampleRate}", strconv.Itoa(a.SampleRate))
	}
	r := strings.NewReplacer(pairs...)
	var out map[string]string
	for k, val := range tpl {
		res := r.Replace(val)
		if strings.Contains(res, "{") {
			continue // Platzhalter ohne Wert
		}
		if out == nil {
			out = map[string]string{}
		}
		out[k] = res
	}
	return out
}

// stageEnv: Start-Umgebung einer Stufe (Vorlage des Typs oder Standard des Node-Typs) für das wirksame Hausformat.
func (c ChainConfig) stageEnv(nodeType string, eff HouseFormat) map[string]string {
	tpl := defaultStageEnv[nodeType]
	if t, ok := c.typeOf(nodeType); ok && len(t.Env) > 0 {
		tpl = t.Env
	}
	return houseEnv(tpl, eff)
}
