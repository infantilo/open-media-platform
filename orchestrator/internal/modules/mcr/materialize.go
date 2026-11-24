package mcr

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/workflows"
)

// Materialisierung (UMSETZUNG 106.10): Event → Workflow-Definition. Rein, ohne Datenbank und ohne Dienste.
//
// Je Leitung: Eingangsrolle (außer bei `mxl` ohne Quellrolle) → Rolle `omp-normalizer` → Interface-Ausgang mit dem Leitungsnamen.
// Verbindungen verwenden die Port-Bezeichnungen der Nodes ("Sender 1" = Bild, "Sender 2" = Ton; "Receiver 1"/"Receiver 2").
// **Geheimnisse stehen nie in der Definition:** Passphrasen kommen über den Schlüsselnamen aus einer Datei im Geheimnis-Verzeichnis.

// DescriptionPrefix kennzeichnet MCR-Workflows; dahinter steht die Event-ID. Der Rollen-Umgebungs-Beobachter liest damit die Startumgebung
// bei **jedem** Start frisch aus der Datenbank.
const DescriptionPrefix = "mcr:"

const (
	NodeContribIn   = "omp-contribution-in"
	NodeGateway2110 = "omp-2110-gateway-ingest"
	NodeHLS         = "omp-hls-source"
	NodeNormalizer  = "omp-normalizer"
	NodeContribOut  = "omp-contribution-out"
	NodeAudioSplit  = "omp-audio-split"
)

// LineRoles nennt die Rollen einer Leitung im Workflow (Eingang kann leer sein).
type LineRoles struct {
	Input      string `json:"input,omitempty"`
	Normalizer string `json:"normalizer"`
	// Return: Rolle der SRT-/RIST-Rückleitung dieser Leitung (nur bei Rückweg mit Art „mix“ und Ziel).
	Return string `json:"return,omitempty"`
	// Split: Rolle des Tonteilers dieser Leitung (leer = keiner); SplitOutputs: seine Ausgänge in Hauskanälen.
	Split        string     `json:"split,omitempty"`
	SplitOutputs []SplitOut `json:"splitOutputs,omitempty"`
	// Matrix: Rolle der Ton-Matrix dieser Leitung (leer = keine); MatrixOutputs: Namen ihrer Ausgänge.
	Matrix        string   `json:"matrix,omitempty"`
	MatrixOutputs []string `json:"matrixOutputs,omitempty"`
	// Verarbeitungskette (106.13g): Stufen vor und nach dem Normalizer in Reihenfolge.
	Pre  []StageRole `json:"pre,omitempty"`
	Post []StageRole `json:"post,omitempty"`
	// EntryVideo/EntryAudio: erste Rolle der Kette, die Bild bzw. Ton annimmt (hierhin geht eine vorhandene Quelle).
	// OutVideo/OutAudio: letzte Rolle, die Bild bzw. Ton liefert (Quellname, Überwachung, Rückweg, Schnittstelle).
	EntryVideo string `json:"entryVideo,omitempty"`
	EntryAudio string `json:"entryAudio,omitempty"`
	OutVideo   string `json:"outVideo,omitempty"`
	OutAudio   string `json:"outAudio,omitempty"`
	// OutData: letzte Rolle der Kette, die die Datenspur trägt (nur gesetzt, wenn die Leitung eine Datenquelle hat).
	OutData string `json:"outData,omitempty"`
}

// ChainRoles: alle Stufen-Rollen der Leitung in Kettenreihenfolge.
func (lr LineRoles) ChainRoles() []StageRole {
	return append(append([]StageRole{}, lr.Pre...), lr.Post...)
}

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)

func slug(s string) string {
	s = strings.Trim(slugRe.ReplaceAllString(strings.ToLower(s), "-"), "-")
	if s == "" {
		return "leitung"
	}
	if len(s) > 24 {
		s = strings.Trim(s[:24], "-")
	}
	return s
}

// lineBase bildet den Rollen-Grundnamen einer Leitung (eindeutig innerhalb des Events) und merkt ihn in `used`.
func lineBase(l Line, i int, used map[string]bool) string {
	base := slug(l.Name)
	for used[base] {
		base = base + "-" + strconv.Itoa(i+1)
	}
	used[base] = true
	return base
}

// SourceNames: Rollenname des Normalizers → Anzeigename „MCR/<Event>/<Leitung>“ für alle Leitungen des Events.
func SourceNames(e Event, chain ...ChainConfig) map[string]string {
	used := map[string]bool{}
	out := map[string]string{}
	for i, l := range e.Lines {
		out[lineBase(l, i, used)+"-norm"] = "MCR/" + e.Name + "/" + l.Name
	}
	// Mit Verarbeitungskette trägt der **letzte** Baustein der Kette den Quellnamen (Bild und Ton einzeln).
	if _, roles, _, err := Materialize(e, nil, "", chain...); err == nil {
		out = map[string]string{}
		for _, l := range e.Lines {
			lr := roles[l.ID]
			name := "MCR/" + e.Name + "/" + l.Name
			for _, r := range []string{lr.Normalizer, lr.OutVideo, lr.OutAudio, lr.OutData} {
				if r != "" {
					out[r] = name
				}
			}
		}
	}
	return out
}

// VideoOut/AudioOut: Rolle, deren Ausgang die Leitung nach außen zeigt (Ende der Kette; ohne Angabe der Normalizer).
func (lr LineRoles) VideoOut() string {
	if lr.OutVideo != "" {
		return lr.OutVideo
	}
	return lr.Normalizer
}
func (lr LineRoles) AudioOut() string {
	if lr.OutAudio != "" {
		return lr.OutAudio
	}
	return lr.Normalizer
}

// VideoIn/AudioIn: Rolle, die eine vorhandene Quelle als Erstes annimmt.
func (lr LineRoles) VideoIn() string {
	if lr.EntryVideo != "" {
		return lr.EntryVideo
	}
	return lr.Normalizer
}
func (lr LineRoles) AudioIn() string {
	if lr.EntryAudio != "" {
		return lr.EntryAudio
	}
	return lr.Normalizer
}

// WorkflowName: stabiler Name je Event.
func WorkflowName(e Event) string {
	id := e.ID
	if len(id) > 8 {
		id = id[:8]
	}
	return "mcr-" + slug(e.Name) + "-" + id
}

// inputRoleFor: Node-Typ der Eingangsrolle einer Leitungsart ("" = keine).
func inputRoleFor(l Line) string {
	if ExistingSourceOf(l) != nil {
		return "" // vorhandener Node als Quelle: kein eigener Eingang, der Normalizer wird mit ihm verbunden
	}
	switch l.Kind {
	case KindSRT, KindRIST:
		return NodeContribIn
	case KindST2110:
		return NodeGateway2110
	case KindHLS:
		return NodeHLS
	case KindMXL:
		// Quelle im Workflow (z. B. omp-source) nur, wenn die Leitung sie nennt; sonst wird der Normalizer von Hand verbunden.
		var t struct {
			SourceNodeType string `json:"sourceNodeType"`
		}
		_ = json.Unmarshal(l.Transport, &t)
		return t.SourceNodeType
	}
	return ""
}

func str(m map[string]any, k string) string {
	switch v := m[k].(type) {
	case string:
		return v
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	}
	return ""
}

// inputEnv übersetzt das Transport-JSON einer Leitung in die Startumgebung des Eingangs. Unbekannte Schlüssel werden ignoriert.
func inputEnv(l Line, secretsDir string) (map[string]string, error) {
	t := map[string]any{}
	if len(l.Transport) > 0 {
		_ = json.Unmarshal(l.Transport, &t)
	}
	env := map[string]string{}
	set := func(k, v string) {
		if v != "" {
			env[k] = v
		}
	}
	switch l.Kind {
	case KindSRT, KindRIST:
		set("OMP_CONTRIB_URI", str(t, "uri"))
		set("OMP_CONTRIB_MODE", str(t, "mode"))
		set("OMP_CONTRIB_LATENCY_MS", str(t, "latencyMs"))
		set("OMP_CONTRIB_STREAMID", str(t, "streamId"))
		set("OMP_CONTRIB_AUDIO_PIDS", str(t, "audioPids"))
		set("OMP_CONTRIB_RELAY_URI", str(t, "relayUri"))
		set("OMP_CONTRIB_RELAY_MODE", str(t, "relayMode"))
		if key := str(t, "passphraseKey"); key != "" {
			if secretsDir == "" {
				return nil, bad("Leitung „%s“: passphraseKey gesetzt, aber kein Geheimnis-Verzeichnis (mcr.secretsDir) eingestellt", l.Name)
			}
			if strings.ContainsAny(key, "/\\") || strings.Contains(key, "..") {
				return nil, bad("Leitung „%s“: passphraseKey darf kein Pfad sein", l.Name)
			}
			set("OMP_CONTRIB_PASSPHRASE_FILE", strings.TrimRight(secretsDir, "/")+"/"+key)
		}
	case KindST2110:
		set("OMP_2110_GATEWAY_LISTEN_PORT", str(t, "videoPort"))
		set("OMP_2110_GATEWAY_MULTICAST_GROUP", str(t, "group"))
		set("OMP_2110_GATEWAY_WIDTH", str(t, "width"))
		set("OMP_2110_GATEWAY_HEIGHT", str(t, "height"))
		set("OMP_2110_GATEWAY_FPS_NUM", str(t, "fpsNum"))
		set("OMP_2110_GATEWAY_FPS_DEN", str(t, "fpsDen"))
		set("OMP_2110_GATEWAY_AUDIO_LISTEN_PORT", str(t, "audioPort"))
		set("OMP_2110_GATEWAY_AUDIO_MULTICAST_GROUP", str(t, "audioGroup"))
		set("OMP_2110_GATEWAY_AUDIO_CHANNELS", str(t, "audioChannels"))
	case KindHLS:
		set("OMP_HLS_URL", str(t, "url"))
		set("OMP_HLS_MAX_BITRATE_KBPS", str(t, "maxBitrateKbps"))
	}
	return env, nil
}

// normalizerEnv: Startumgebung des Normalizers aus dem **wirksamen** Hausformat der Leitung und den Einstellungen.
func normalizerEnv(l Line, eff HouseFormat, sl Slots) (map[string]string, error) {
	env := map[string]string{}
	if eff.Video != nil || eff.Audio != nil {
		b, err := json.Marshal(eff)
		if err != nil {
			return nil, err
		}
		env["OMP_HOUSE_FORMAT"] = string(b)
	}
	var n struct {
		Mode     string          `json:"mode"`
		AudioMap json.RawMessage `json:"audioMap"`
	}
	if len(l.Normalize) > 0 {
		_ = json.Unmarshal(l.Normalize, &n)
	}
	switch n.Mode {
	case "", "auto":
	case "copyOnly":
		env["OMP_NORMALIZE_MODE"] = "copyOnly"
	default:
		return nil, bad("Leitung „%s“: normalize.mode „%s“ unbekannt (auto, copyOnly)", l.Name, n.Mode)
	}
	if _, strict := sl.normalizerOverrides(); strict {
		env["OMP_NORMALIZE_MODE"] = "copyOnly"
	}
	if len(n.AudioMap) > 0 && string(n.AudioMap) != "null" {
		env["OMP_AUDIO_MAP"] = string(n.AudioMap)
	} else if m := TrackAudioMap(l); m != nil {
		env["OMP_AUDIO_MAP"] = string(m)
	}
	return env, nil
}

// Materialize baut die Workflow-Definition eines Events. `global` ist das Hausformat der Vorgabe; `secretsDir` das Verzeichnis der
// Passphrase-Dateien (leer = keine). Rückgabe: Definition und Rollen je Leitungs-ID.
func Materialize(e Event, global *HouseFormat, secretsDir string, chain ...ChainConfig) (workflows.Definition, map[string]LineRoles, map[string]map[string]string, error) {
	var cc ChainConfig
	if len(chain) > 0 {
		cc = chain[0]
	}
	def := workflows.Definition{Title: e.Name, Category: "mcr", Tags: []string{"mcr"}, Description: DescriptionPrefix + e.ID}
	envs := map[string]map[string]string{}
	def.Interface = &workflows.Interface{}
	roles := map[string]LineRoles{}
	used := map[string]bool{}
	ev, _ := ParseHouse(e.HouseFormat)
	for i, l := range e.Lines {
		base := lineBase(l, i, used)
		lh, _ := ParseHouse(l.HouseFormat)
		eff := Effective(global, ev, lh)
		lr := LineRoles{Normalizer: base + "-norm"}
		if nt := inputRoleFor(l); nt != "" {
			lr.Input = base + "-in"
			env, err := inputEnv(l, secretsDir)
			if err != nil {
				return def, nil, nil, err
			}
			def.Roles = append(def.Roles, workflows.Role{Name: lr.Input, NodeType: nt})
			envs[lr.Input] = env
		}
		if err := validateTracks(l); err != nil {
			return def, nil, nil, err
		}
		nenv, err := normalizerEnv(l, eff, cc.Slots)
		if err != nil {
			return def, nil, nil, err
		}
		stages := append(cc.autoStages(), ResolveChain(cc.Global, e.Chain, l.Chain)...)
		for _, st := range stages {
			if _, ok := cc.typeOf(st.NodeType); !ok {
				return def, nil, nil, bad("Leitung „%s“: Stufe „%s“: Node-Typ „%s“ ist nicht zugelassen", l.Name, st.ID, st.NodeType)
			}
			sr := StageRole{Stage: st}
			if st.Where == WherePost {
				sr.Role = fmt.Sprintf("%s-post-%s", base, st.ID)
				lr.Post = append(lr.Post, sr)
			} else {
				sr.Role = fmt.Sprintf("%s-pre-%s", base, st.ID)
				lr.Pre = append(lr.Pre, sr)
			}
		}
		for _, sr := range lr.Pre {
			def.Roles = append(def.Roles, workflows.Role{Name: sr.Role, NodeType: sr.Stage.NodeType})
			if env := cc.stageEnv(sr.Stage.NodeType, eff); env != nil {
				envs[sr.Role] = env
			}
		}
		def.Roles = append(def.Roles, workflows.Role{Name: lr.Normalizer, NodeType: cc.normalizerType()})
		envs[lr.Normalizer] = nenv
		// Gemessener/vorgegebener A/V-Versatz geht an den getrennten Delay-Node (statt an den Normalizer, dessen Ausgleich dann aus ist).
		for i := range lr.Post {
			if lr.Post[i].Stage.ID != "avdelay" || strings.TrimSpace(cc.Slots.AVDelay.NodeType) == "" {
				continue
			}
			// Der Node bekommt immer ausdrückliche Werte, damit er nach „Zurücksetzen“ oder Moduswechsel wieder auf 0 geht:
			// Grundwert 0, darüber die Startwerte des Slots, darüber der Plan aus Modus und Messwert der Leitung.
			merged := map[string]any{ParamDelayVideoFrames: 0, ParamDelayAudioMs: 0.0}
			for k, v := range lr.Post[i].Stage.Params {
				merged[k] = v
			}
			if plan, ok := PlanDelay(l.Avsync, frameDuration(eff), cc.Slots.AVDelay.MaxFrames); ok {
				for k, v := range plan.Params() {
					merged[k] = v
				}
			}
			lr.Post[i].Stage.Params = merged
		}
		for _, sr := range lr.Post {
			def.Roles = append(def.Roles, workflows.Role{Name: sr.Role, NodeType: sr.Stage.NodeType})
			if env := cc.stageEnv(sr.Stage.NodeType, eff); env != nil {
				envs[sr.Role] = env
			}
		}
		w := wire(lr.Input, lr.Pre, lr.Normalizer, lr.Post, cc)
		lr.EntryVideo, lr.EntryAudio, lr.OutVideo, lr.OutAudio = w.entryVideo, w.entryAudio, w.outVideo, w.outAudio
		for _, c := range w.conns {
			def.Connections = append(def.Connections, workflows.Connection{FromRole: c[0], FromSender: c[1], ToRole: c[2], ToReceiver: c[3]})
		}
		// Rückleitung zum Veranstaltungsort (106.11/106.12): eigene Rolle, wenn die Leitung einen Rückweg „mix“ mit Ziel hat.
		if p := PlanReturn(l, e.Lines); p.Wanted && p.Mode == "mix" && len(p.Transport) > 0 && p.Action != "warn" {
			lr.Return = base + "-ret"
			renv, err := returnEnv(l, p.Transport, secretsDir)
			if err != nil {
				return def, nil, nil, err
			}
			def.Roles = append(def.Roles, workflows.Role{Name: lr.Return, NodeType: NodeContribOut})
			envs[lr.Return] = renv
		}
		// Tonteiler (normalize.audioSplit): hängt hinter dem Ton-Ausgang der Kette, jeder Ausgang wird ein Workflow-Ausgang.
		houseCh := 0
		if eff.Audio != nil {
			houseCh = eff.Audio.Channels
		}
		splitOuts, err := ResolveAudioSplit(l, houseCh)
		if err != nil {
			return def, nil, nil, err
		}
		if len(splitOuts) > 0 && w.outAudio != "" {
			lr.Split = base + "-split"
			lr.SplitOutputs = splitOuts
			def.Roles = append(def.Roles, workflows.Role{Name: lr.Split, NodeType: cc.splitterType()})
			envs[lr.Split] = SplitterEnv(splitOuts, houseCh)
			def.Connections = append(def.Connections, workflows.Connection{FromRole: w.outAudio, FromSender: w.outAudioPort, ToRole: lr.Split, ToReceiver: cc.splitterIn()})
			for _, so := range splitOuts {
				pn := l.Name + " · " + so.Name
				def.Interface.Outputs = append(def.Interface.Outputs, workflows.InterfacePort{Name: pn, Label: pn, Members: []workflows.InterfaceMember{{Role: lr.Split, Port: so.Name}}})
			}
		}
		// Ton-Matrix (normalize.audioMatrix): wie der Tonteiler hinter dem Ton-Ausgang der Kette; der erste Eingang bekommt den Haus-Ton.
		matrixCfg, err := ResolveAudioMatrix(l, houseCh)
		if err != nil {
			return def, nil, nil, err
		}
		if matrixCfg != nil && w.outAudio != "" {
			lr.Matrix = base + "-matrix"
			def.Roles = append(def.Roles, workflows.Role{Name: lr.Matrix, NodeType: cc.matrixType()})
			envs[lr.Matrix] = MatrixEnv(*matrixCfg)
			def.Connections = append(def.Connections, workflows.Connection{FromRole: w.outAudio, FromSender: w.outAudioPort, ToRole: lr.Matrix, ToReceiver: cc.matrixIn(strings.TrimSpace(matrixCfg.Inputs[0].Name))})
			for _, o := range matrixCfg.Outputs {
				name := strings.TrimSpace(o.Name)
				lr.MatrixOutputs = append(lr.MatrixOutputs, name)
				pn := l.Name + " · " + name
				def.Interface.Outputs = append(def.Interface.Outputs, workflows.InterfacePort{Name: pn, Label: pn, Members: []workflows.InterfaceMember{{Role: lr.Matrix, Port: name}}})
			}
		}
		// Die Datenspur (ANC, Zeitcode, Untertitel) geht nur mit, wenn die Leitung eine Datenquelle hat.
		members := []workflows.InterfaceMember{{Role: lr.OutVideo, Port: w.outVideoPort}, {Role: lr.OutAudio, Port: w.outAudioPort}}
		if HasDataSource(l) && w.outData != "" {
			lr.OutData = w.outData
			members = append(members, workflows.InterfaceMember{Role: w.outData, Port: w.outDataPort})
		}
		def.Interface.Outputs = append(def.Interface.Outputs, workflows.InterfacePort{Name: l.Name, Label: l.Name, Members: members})
		roles[l.ID] = lr
	}
	// Bestätigung beim Stoppen ab `live` (Fehlbedienung auf Sendung vermeiden).
	def.Settings.ConfirmStop = e.State == StateLive
	if len(def.Roles) == 0 {
		return def, roles, envs, bad("Event ohne Leitungen: nichts zu starten")
	}
	return def, roles, envs, nil
}

func nonEmpty(m map[string]string) map[string]string {
	if len(m) == 0 {
		return nil
	}
	return m
}

// NodeParams: Parameter, die nach dem Start aus der Datenbank an den Normalizer einer Leitung gehen (Quelle der Wahrheit =
// Datenbank; der Node behält sie nicht von selbst). Reihenfolge fest, damit Tests und Protokolle stabil sind.
type ParamSet struct {
	Name  string
	Value any
}

func NodeParams(l Line, eff HouseFormat, slots ...Slots) []ParamSet {
	var out []ParamSet
	if eff.Video != nil || eff.Audio != nil {
		b, _ := json.Marshal(eff)
		out = append(out, ParamSet{"normalize.houseFormat", string(b)})
	}
	var an struct {
		AudioMap json.RawMessage `json:"audioMap"`
	}
	if len(l.Normalize) > 0 {
		_ = json.Unmarshal(l.Normalize, &an)
	}
	if len(an.AudioMap) > 0 && string(an.AudioMap) != "null" {
		out = append(out, ParamSet{"normalize.audioMap", string(an.AudioMap)})
	} else if m := TrackAudioMap(l); m != nil {
		out = append(out, ParamSet{"normalize.audioMap", string(m)})
	}
	var a struct {
		Mode            string   `json:"mode"`
		ManualMs        *float64 `json:"manualMs"`
		HeldMs          *float64 `json:"heldMs"`
		DeadbandMs      *float64 `json:"deadbandMs"`
		MaxSlewPermille *float64 `json:"maxSlewPermille"`
	}
	if len(l.Avsync) > 0 {
		_ = json.Unmarshal(l.Avsync, &a)
	}
	if a.DeadbandMs != nil {
		out = append(out, ParamSet{"avsync.deadbandMs", *a.DeadbandMs})
	}
	if a.MaxSlewPermille != nil {
		out = append(out, ParamSet{"avsync.maxSlewPermille", *a.MaxSlewPermille})
	}
	if a.ManualMs != nil {
		out = append(out, ParamSet{"avsync.manualMs", *a.ManualMs})
	}
	if a.HeldMs != nil {
		out = append(out, ParamSet{"avsync.heldMs", *a.HeldMs})
	}
	if a.Mode != "" {
		out = append(out, ParamSet{"avsync.mode", a.Mode}) // zuletzt: erst Werte, dann Modus
	}
	if len(slots) > 0 {
		off, strict := slots[0].normalizerOverrides()
		if off {
			out = append(out, ParamSet{"avsync.mode", "off"}) // getrennter A/V-Delay-Node: nicht doppelt ausgleichen
		}
		if strict {
			out = append(out, ParamSet{"normalize.mode", "copyOnly"})
		}
	}
	return out
}

var _ = fmt.Sprintf

// returnEnv: Startumgebung der Rückleitung aus ihrem Transport-JSON (Ziel, Betriebsart, Latenz, Bitraten, Passphrase-Datei).
func returnEnv(l Line, transport json.RawMessage, secretsDir string) (map[string]string, error) {
	t := map[string]any{}
	_ = json.Unmarshal(transport, &t)
	env := map[string]string{}
	set := func(k, v string) {
		if v != "" {
			env[k] = v
		}
	}
	set("OMP_CONTRIB_URI", str(t, "uri"))
	set("OMP_CONTRIB_MODE", str(t, "mode"))
	set("OMP_CONTRIB_LATENCY_MS", str(t, "latencyMs"))
	set("OMP_CONTRIB_STREAMID", str(t, "streamId"))
	set("OMP_CONTRIB_AUDIO_BITRATE_KBPS", str(t, "audioBitrateKbps"))
	if v, ok := t["videoEnabled"].(bool); ok && v {
		env["OMP_CONTRIB_VIDEO_ENABLED"] = "1"
	}
	set("OMP_CONTRIB_VIDEO_BITRATE_KBPS", str(t, "videoBitrateKbps"))
	if key := str(t, "passphraseKey"); key != "" {
		if secretsDir == "" {
			return nil, bad("Rückleitung „%s“: passphraseKey gesetzt, aber kein Geheimnis-Verzeichnis eingestellt", l.Name)
		}
		if strings.ContainsAny(key, "/\\") || strings.Contains(key, "..") {
			return nil, bad("Rückleitung „%s“: passphraseKey darf kein Pfad sein", l.Name)
		}
		env["OMP_CONTRIB_PASSPHRASE_FILE"] = strings.TrimRight(secretsDir, "/") + "/" + key
	}
	return env, nil
}

// Existing benennt einen schon laufenden Node als Quelle einer Leitung (statt einen Eingang zu starten): z. B. ein dedizierter
// SRT-/ST-2110-Node, eine Kamera-Quelle oder ein beliebiger Sender mit MXL-Flow. Der Normalizer wird mit ihm verbunden (IS-05).
type Existing struct {
	NodeID        string `json:"nodeId"`
	NodeLabel     string `json:"nodeLabel,omitempty"`
	VideoSenderID string `json:"videoSenderId,omitempty"`
	AudioSenderID string `json:"audioSenderId,omitempty"`
	// Bild, Ton und Daten dürfen aus verschiedenen Nodes kommen: ist der Node einer Art gesetzt, gilt er für diese Art; sonst
	// gilt NodeID/NodeLabel (ältere Leitungen mit einer gemeinsamen Quelle bleiben gültig).
	VideoNodeID    string `json:"videoNodeId,omitempty"`
	VideoNodeLabel string `json:"videoNodeLabel,omitempty"`
	AudioNodeID    string `json:"audioNodeId,omitempty"`
	AudioNodeLabel string `json:"audioNodeLabel,omitempty"`
	DataNodeID     string `json:"dataNodeId,omitempty"`
	DataNodeLabel  string `json:"dataNodeLabel,omitempty"`
	DataSenderID   string `json:"dataSenderId,omitempty"`
	// AudioTracks: die Tonspuren, die diese Leitung aus dem Ton-Flow der Quelle nimmt (leer = alle Kanäle unverändert).
	// Mehrere Leitungen dürfen dieselbe Quelle (und dasselbe Bild) mit verschiedenen Tonspuren nutzen.
	AudioTracks []AudioTrack `json:"audioTracks,omitempty"`
}

// AudioTrack ist eine Tonspur: Name und die Eingangskanäle (1-basiert) des Ton-Flows, aus denen sie besteht.
type AudioTrack struct {
	Label    string `json:"label,omitempty"`
	Channels []int  `json:"channels"`
}

// TrackAudioMap leitet die Kanalzuordnung des Normalizers aus den Tonspuren ab: die Hauskanäle werden der Reihe nach mit den
// Kanälen der Tonspuren belegt (Spur 1 zuerst). Gibt nil zurück, wenn die Leitung keine Tonspuren wählt.
func TrackAudioMap(l Line) json.RawMessage {
	ex := ExistingSourceOf(l)
	if ex == nil || len(ex.AudioTracks) == 0 {
		return nil
	}
	type entry struct {
		Out int `json:"out"`
		In  int `json:"in"`
	}
	var outs []entry
	for _, t := range ex.AudioTracks {
		for _, c := range t.Channels {
			outs = append(outs, entry{Out: len(outs) + 1, In: c})
		}
	}
	b, _ := json.Marshal(map[string]any{"outputs": outs})
	return b
}

// validateTracks prüft die Tonspuren einer Leitung.
func validateTracks(l Line) error {
	ex := ExistingSourceOf(l)
	if ex == nil {
		return nil
	}
	total := 0
	for i, t := range ex.AudioTracks {
		if len(t.Channels) == 0 {
			return bad("Leitung „%s“: Tonspur %d hat keine Kanäle", l.Name, i+1)
		}
		for _, c := range t.Channels {
			if c < 1 || c > 64 {
				return bad("Leitung „%s“: Tonspur %d: Kanal %d außerhalb 1…64", l.Name, i+1, c)
			}
		}
		total += len(t.Channels)
	}
	if total > 64 {
		return bad("Leitung „%s“: zusammen höchstens 64 Tonkanäle", l.Name)
	}
	return nil
}

// Signature kennzeichnet die Verdrahtung einer Quelle (zum Erkennen von Änderungen).
func (x Existing) Signature() string {
	return strings.Join([]string{x.NodeID, x.NodeLabel, x.VideoSenderID, x.AudioSenderID, x.VideoNodeID, x.VideoNodeLabel, x.AudioNodeID, x.AudioNodeLabel, x.DataNodeID, x.DataNodeLabel, x.DataSenderID}, "|")
}

// ExistingSourceOf liest `transport.existing`; nil, wenn die Leitung keinen vorhandenen Node nennt.
// HasDataSource: die Leitung nennt eine Datenquelle (Node oder Sender für ANC/Zeitcode/Untertitel).
func HasDataSource(l Line) bool {
	ex := ExistingSourceOf(l)
	return ex != nil && (ex.DataNodeID != "" || ex.DataSenderID != "" || ex.DataNodeLabel != "")
}

func ExistingSourceOf(l Line) *Existing {
	if len(l.Transport) == 0 {
		return nil
	}
	var t struct {
		Existing *Existing `json:"existing"`
	}
	if json.Unmarshal(l.Transport, &t) != nil || t.Existing == nil {
		return nil
	}
	x := t.Existing
	if x.NodeID == "" && x.NodeLabel == "" && x.VideoSenderID == "" && x.AudioSenderID == "" && x.VideoNodeID == "" && x.AudioNodeID == "" && x.DataNodeID == "" && x.DataSenderID == "" {
		return nil
	}
	return t.Existing
}
