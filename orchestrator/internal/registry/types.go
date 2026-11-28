package registry

import "encoding/json"

// Die folgenden Typen decoden nur die Felder, die für das normalisierte
// Node-Inventar gebraucht werden — bewusst kein vollständiges Abbild der
// IS-04-Schemas (siehe specs.amwa.tv, AMWA-TV/is-04 v1.3.x). Unbekannte
// Felder werden von encoding/json stillschweigend ignoriert.

type is04Node struct {
	ID    string              `json:"id"`
	Label string              `json:"label"`
	API   is04NodeAPI         `json:"api"`
	Tags  map[string][]string `json:"tags"`
}

// is04NodeAPI/is04NodeEndpoint decoden nur das erste Node-API-Endpoint —
// Standard-IS-04-Feld (node.json "api.endpoints"), keine Node-Typ-
// Kenntnis. Wird als Basis-URL für den generischen Parameter-/Methoden-
// Proxy (A8) genutzt.
type is04NodeAPI struct {
	Endpoints []is04NodeEndpoint `json:"endpoints"`
}

type is04NodeEndpoint struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Protocol string `json:"protocol"`
}

type is04Device struct {
	ID       string        `json:"id"`
	Label    string        `json:"label"`
	NodeID   string        `json:"node_id"`
	Controls []is04Control `json:"controls"`
}

// is04Control ist ein Eintrag aus "controls" eines IS-04-Device
// (device.json, IS-04 v1.3): über ihn meldet ein Device, unter welcher
// Adresse es welche Steuer-API anbietet. Für IS-05 ist der Typ
// "urn:x-nmos:control:sr-ctrl/<Version>" (IS-05 v1.2, "Interoperability –
// IS-04").
type is04Control struct {
	Href string `json:"href"`
	Type string `json:"type"`
}

type is04Sender struct {
	ID        string  `json:"id"`
	Label     string  `json:"label"`
	DeviceID  string  `json:"device_id"`
	FlowID    *string `json:"flow_id"`
	Transport string  `json:"transport"`
	// Tags: nur für `urn:x-nmos:tag:grouphint/v1.0` gelesen (s. GroupHintTag).
	Tags map[string][]string `json:"tags"`
}

// GroupHintTag ist der NMOS-Parameter-Registry-Tag für Natural Groups
// (Format "<group>:<role>[:<scope>]", Sender/Receiver-Tag).
const GroupHintTag = "urn:x-nmos:tag:grouphint/v1.0"

// OMPTagsTag ist der OMP-eigene IS-04-Tag für semantische Quell-Tags
// (Namespace `urn:x-omp:`, wie `urn:x-omp:workflow`/`urn:x-omp:instance`;
// Werte `domain.name`, z. B. `audio.commentator`). Eine Tag-MAP je Ressource
// ist IS-04-konform (`map<string,string[]>`), das Schema bleibt unberührt.
const OMPTagsTag = "urn:x-omp:tags"

// groupHint liefert den ersten Grouphint-Tag-Wert unverändert ("" wenn
// keiner vorhanden) — Parsing (Gruppe/Rolle) macht die UI
// (ui/kit/source-selector-logic.ts), damit es genau eine Parse-Stelle gibt.
func (s is04Sender) groupHint() string {
	if v := s.Tags[GroupHintTag]; len(v) > 0 {
		return v[0]
	}
	return ""
}

type is04Receiver struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	DeviceID  string `json:"device_id"`
	Format    string `json:"format"`
	Transport string `json:"transport"`
	// Tags: IS-04-Receiver-Tags (Quelle der DiscoveredTags, s. OMPTagsTag).
	Tags map[string][]string `json:"tags"`
}

type is04Flow struct {
	ID       string `json:"id"`
	Format   string `json:"format"`
	SourceID string `json:"source_id"`
	// Format-Merkmale (IS-04 v1.3): Bild-Raster/-Rate, Abtastrate; für Host-Brücken (Kap. 108).
	FrameWidth  int       `json:"frame_width,omitempty"`
	FrameHeight int       `json:"frame_height,omitempty"`
	GrainRate   *is04Rate `json:"grain_rate,omitempty"`
	SampleRate  *is04Rate `json:"sample_rate,omitempty"`
}

type is04Rate struct {
	Numerator   int `json:"numerator"`
	Denominator int `json:"denominator,omitempty"`
}

// is04Source: nur die Audio-Kanalliste wird gebraucht (Kanalanzahl → abgeleitete
// Tags audio.mono/stereo/…, UMSETZUNG.md Kapitel 27 / P4).
type is04Source struct {
	ID       string            `json:"id"`
	Channels []json.RawMessage `json:"channels"`
}

// NodeView ist die vom Orchestrator normalisierte Sicht auf einen
// IS-04-Node samt seiner Devices, Senders und Receivers
// (ARCHITECTURE.md §2/§11.1: "kein Orchestrator-Sonderwissen", nur
// Standard-IS-04-Felder).
type NodeView struct {
	ID         string         `json:"id"`
	Label      string         `json:"label"`
	Online     bool           `json:"online"`
	Devices    []DeviceView   `json:"devices"`
	Senders    []SenderView   `json:"senders"`
	Receivers  []ReceiverView `json:"receivers"`
	APIBaseURL string         `json:"api_base_url"`
	// InstanceID ist der Wert des IS-04-Tags "urn:x-omp:instance" (leer,
	// wenn der Tag fehlt) — vom Instanz-Launcher gesetzt
	// (UMSETZUNG.md C8), erlaubt der UI, einen Stop-Control nur an
	// Kacheln zu zeigen, die tatsächlich vom Launcher gestartet wurden.
	InstanceID string `json:"instance_id,omitempty"`
	// Build ist der vom Node gemeldete Build-Stempel (IS-04-Tag
	// "urn:x-omp:build" = [version, commit, builtAt]); nil bei Nodes ohne Tag.
	Build *BuildInfo `json:"build,omitempty"`
}

// BuildInfo ist der Build-Stempel eines Node-Binaries (Kapitel 28).
type BuildInfo struct {
	Version string `json:"version"`
	Commit  string `json:"commit,omitempty"`
	BuiltAt string `json:"builtAt,omitempty"`
	// Contract: Contract-Generation des Node-Binaries (Kapitel 28 Schritt 4); 0 = nicht gemeldet.
	Contract int `json:"contract,omitempty"`
}

// DeviceView ist die normalisierte Sicht auf ein IS-04-Device.
type DeviceView struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// ConnectionAPIs sind die versionierten IS-05-Wurzeln, die das Device in
	// seinen "controls" meldet (z. B. "http://10.0.0.4:8090/x-nmos/
	// connection/v1.1"), bevorzugte zuerst; leer, wenn es keine passende
	// meldet.
	ConnectionAPIs []string `json:"connection_apis,omitempty"`
}

// ConnectionAPIs liefert die IS-05-Wurzeln für den Sender oder Receiver
// portID dieser Node: die vom Device gemeldeten, sonst die bisherige
// Annahme "Node-API-Endpoint + /x-nmos/connection/v1.2" (OMP-eigene Nodes
// melden keine "controls", bedienen aber v1.2, docs/decisions.md
// Nachtrag 189). Leer, wenn die Node keinen API-Endpoint meldet.
func (n NodeView) ConnectionAPIs(portID string) []string {
	deviceID := ""
	for _, s := range n.Senders {
		if s.ID == portID {
			deviceID = s.DeviceID
		}
	}
	for _, r := range n.Receivers {
		if r.ID == portID {
			deviceID = r.DeviceID
		}
	}
	for _, d := range n.Devices {
		if d.ID == deviceID && len(d.ConnectionAPIs) > 0 {
			return d.ConnectionAPIs
		}
	}
	if n.APIBaseURL == "" {
		return nil
	}
	return []string{n.APIBaseURL + "/x-nmos/connection/v1.2"}
}

// SenderView ist die normalisierte Sicht auf einen IS-04-Sender inkl. des
// über den referenzierten Flow aufgelösten Medien-Formats. Transport kommt
// unverändert aus dem IS-04-Snapshot (z. B. "urn:x-nmos:transport:mxl" oder
// "urn:x-nmos:transport:rtp", s. nodes/omp-node-sdk/src/is04.rs) — Kapitel
// 13 Teil 2 (docs/END-GOAL-FEATURES.md §13.4) nutzt das im Flow-Editor zur
// Kanten-Klassifizierung über Zonengrenzen (MXL ist host-lokal, §13.1).
type SenderView struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	DeviceID  string `json:"device_id"`
	Format    string `json:"format"`
	Transport string `json:"transport,omitempty"`
	// FlowID: der referenzierte IS-04-Flow (leer, wenn keiner).
	FlowID string `json:"flow_id,omitempty"`
	// DiscoveredTags: Werte des IS-04-Sender-Tags OMPTagsTag (`urn:x-omp:tags`) —
	// semantische Tags, die der Node selbst meldet (Herkunft DISCOVERED).
	DiscoveredTags []string `json:"discovered_tags,omitempty"`
	// ChannelCount: Audio-Kanäle der Quelle des Flows (0 = unbekannt/kein Audio).
	ChannelCount int `json:"channel_count,omitempty"`
	// Width/Height/RateNum/RateDen (Bild) bzw. SampleRate (Ton) des Flows; 0 = unbekannt (Kap. 108).
	Width      int `json:"width,omitempty"`
	Height     int `json:"height,omitempty"`
	RateNum    int `json:"rate_num,omitempty"`
	RateDen    int `json:"rate_den,omitempty"`
	SampleRate int `json:"sample_rate,omitempty"`
	// GroupHint ist der rohe erste `urn:x-nmos:tag:grouphint/v1.0`-Wert
	// des Senders (leer, wenn nicht gesetzt) — Grundlage für die
	// Natural-Group-Darstellung im Source-Selector.
	GroupHint string `json:"group_hint,omitempty"`
}

// ReceiverView ist die normalisierte Sicht auf einen IS-04-Receiver. Das
// Format steht bei Receivern (anders als bei Sendern) direkt am Resource,
// nicht über einen Flow. Transport s. SenderView-Doku.
type ReceiverView struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	DeviceID  string `json:"device_id"`
	Format    string `json:"format"`
	Transport string `json:"transport,omitempty"`
	// DiscoveredTags: Werte des IS-04-Receiver-Tags OMPTagsTag — semantische
	// Tags der Senke (z. B. `audio.commentator`), Grundlage der tag-basierten
	// Schaltung im X/Y-Panel.
	DiscoveredTags []string `json:"discovered_tags,omitempty"`
}
