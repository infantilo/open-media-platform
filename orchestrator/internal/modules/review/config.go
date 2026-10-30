package review

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// Config ist das Einstellungsdokument des Moduls (Schlüssel „review.config“ im Einstellungsspeicher). Alles hier ist
// ohne Neustart änderbar; fehlende Felder bekommen die Standardwerte aus DefaultConfig.
type Config struct {
	// Richtlinie: darf ein Asset geprüft werden, bevor die QC fertig ist / obwohl sie nicht ausführbar war?
	AllowReviewWhileQCRunning  bool `json:"allowReviewWhileQcRunning"`
	AllowReviewAfterQCExecFail bool `json:"allowReviewAfterQcExecFail"`
	// Segment-Regeln (workflow-spezifisch überschreibbar über Profile).
	AllowOverlap     bool  `json:"allowOverlap"`
	AllowGaps        bool  `json:"allowGaps"`
	MinSegmentFrames int64 `json:"minSegmentFrames"`
	// Freigabe: none | single | dual. Bei dual darf der Einreicher nicht selbst freigeben (ausser AllowSelfApproval).
	ApprovalMode      string `json:"approvalMode"`
	AllowSelfApproval bool   `json:"allowSelfApproval"`
	// QC
	DefaultQCProfile string               `json:"defaultQcProfile"`
	QCProfiles       map[string]QCProfile `json:"qcProfiles"`
	QCWorkers        int                  `json:"qcWorkers"`
	AutoQC           bool                 `json:"autoQc"`
	// Review-Proxy
	ProxyHeight   int `json:"proxyHeight"`
	ProxyCRF      int `json:"proxyCrf"`
	ProxyMaxAudio int `json:"proxyMaxAudioTracks"`
	// Metadatenformular
	MetadataFields []MetaField `json:"metadataFields"`
	// Medienverzeichnis, aus dem Dateien direkt importiert werden dürfen (leer = Import abgeschaltet).
	ImportDir string `json:"importDir"`
}

// MetaField beschreibt ein Feld des redaktionellen Metadatenformulars (Pflichtfelder, erlaubte Werte).
type MetaField struct {
	ID       string   `json:"id"`
	Label    string   `json:"label"`
	Type     string   `json:"type"` // text | longtext | select | multiselect | tags | date | number
	Required bool     `json:"required,omitempty"`
	Values   []string `json:"values,omitempty"`
	Segment  bool     `json:"segment,omitempty"` // Feld gilt je Segment statt je Asset
	Max      int      `json:"max,omitempty"`     // Länge (text) bzw. Anzahl (tags)
}

// QCProfile: konfigurierbare Schwellen. Ein Nullwert in „Expect“ bedeutet „nicht prüfen“.
type QCProfile struct {
	ID      string `json:"id"`
	Version int    `json:"version"`
	Name    string `json:"name"`

	Black struct {
		MinDurationS float64 `json:"minDurationS"` // kürzere Schwarzphasen zählen nicht
		PixTh        float64 `json:"pixTh"`        // blackdetect pix_th
		PicTh        float64 `json:"picTh"`
		WarnAboveS   float64 `json:"warnAboveS"`  // Einzelphase länger → Warnung
		FailAboveS   float64 `json:"failAboveS"`  // → Fehler
		IgnoreHeadS  float64 `json:"ignoreHeadS"` // Schwarz am Dateianfang bis dahin ist normal
		IgnoreTailS  float64 `json:"ignoreTailS"`
	} `json:"black"`
	Freeze struct {
		NoiseDb      float64 `json:"noiseDb"`
		MinDurationS float64 `json:"minDurationS"`
		WarnAboveS   float64 `json:"warnAboveS"`
		FailAboveS   float64 `json:"failAboveS"`
	} `json:"freeze"`
	Silence struct {
		NoiseDb      float64 `json:"noiseDb"`
		MinDurationS float64 `json:"minDurationS"`
		WarnAboveS   float64 `json:"warnAboveS"`
		FailAboveS   float64 `json:"failAboveS"`
	} `json:"silence"`
	Loudness struct {
		Enabled         bool    `json:"enabled"`
		TargetLUFS      float64 `json:"targetLufs"`
		WarnToleranceLU float64 `json:"warnToleranceLu"`
		FailToleranceLU float64 `json:"failToleranceLu"`
		MaxTruePeakDB   float64 `json:"maxTruePeakDbtp"`
		MaxLRA          float64 `json:"maxLra"` // 0 = nicht prüfen
	} `json:"loudness"`
	ClipPeakDB float64 `json:"clipPeakDb"` // Sample-Peak ≥ Wert → Clipping-Verdacht
	Sync       struct {
		MaxStartOffsetMs      float64 `json:"maxStartOffsetMs"`
		MaxDurationMismatchMs float64 `json:"maxDurationMismatchMs"`
	} `json:"sync"`
	Expect struct {
		Width       int      `json:"width,omitempty"`
		Height      int      `json:"height,omitempty"`
		FrameRate   string   `json:"frameRate,omitempty"`  // "25/1"
		FieldOrder  string   `json:"fieldOrder,omitempty"` // progressive | tt | bb | any
		VideoCodecs []string `json:"videoCodecs,omitempty"`
		Container   string   `json:"container,omitempty"`   // Teilstring von format_name, z. B. "mxf"
		AudioTracks int      `json:"audioTracks,omitempty"` // Mindestanzahl
		SampleRate  int      `json:"sampleRate,omitempty"`
		MinBitDepth int      `json:"minBitDepth,omitempty"`
		Captions    bool     `json:"captions,omitempty"` // Untertitel-/Datenstrom erwartet
	} `json:"expect"`
	MaxAudioStreams int `json:"maxAudioStreams"` // Analyse begrenzen
	TimeoutSec      int `json:"timeoutSec"`
}

// Ruleset ist die Kennung "<id>@<version>" in jedem Befund.
func (p QCProfile) Ruleset() string { return fmt.Sprintf("%s@%d", p.ID, p.Version) }

// DefaultQCProfile ist ein allgemeines Rundfunk-Anlieferprofil (EBU R128, ±1 LU Warnung).
func DefaultQCProfile() QCProfile {
	p := QCProfile{ID: "broadcast-default", Version: 1, Name: "Broadcast (Standard)"}
	p.Black.MinDurationS, p.Black.PixTh, p.Black.PicTh = 0.5, 0.10, 0.98
	p.Black.WarnAboveS, p.Black.FailAboveS, p.Black.IgnoreHeadS, p.Black.IgnoreTailS = 1.0, 10, 0, 0
	p.Freeze.NoiseDb, p.Freeze.MinDurationS, p.Freeze.WarnAboveS, p.Freeze.FailAboveS = -50, 2, 2, 10 // -60 dB (ffmpeg-Standard) übersieht Standbilder in verlustbehaftet kodiertem Material
	p.Silence.NoiseDb, p.Silence.MinDurationS, p.Silence.WarnAboveS, p.Silence.FailAboveS = -60, 2, 2, 10
	p.Loudness.Enabled, p.Loudness.TargetLUFS = true, -23
	p.Loudness.WarnToleranceLU, p.Loudness.FailToleranceLU, p.Loudness.MaxTruePeakDB, p.Loudness.MaxLRA = 1, 3, -1, 0
	p.ClipPeakDB = -0.1
	p.Sync.MaxStartOffsetMs, p.Sync.MaxDurationMismatchMs = 40, 80
	p.MaxAudioStreams, p.TimeoutSec = 16, 1800
	return p
}

// DefaultConfig: Standardwerte.
func DefaultConfig() Config {
	p := DefaultQCProfile()
	return Config{
		AllowReviewWhileQCRunning: false, AllowReviewAfterQCExecFail: true,
		AllowOverlap: true, AllowGaps: true, MinSegmentFrames: 1,
		ApprovalMode: "single", AllowSelfApproval: true,
		DefaultQCProfile: p.ID, QCProfiles: map[string]QCProfile{p.ID: p}, QCWorkers: 1, AutoQC: true,
		ProxyHeight: 540, ProxyCRF: 23, ProxyMaxAudio: 8, ImportDir: "data/media",
		MetadataFields: []MetaField{
			{ID: "title", Label: "Titel", Type: "text", Required: true, Max: 200},
			{ID: "description", Label: "Beschreibung", Type: "longtext", Max: 4000},
			{ID: "category", Label: "Kategorie", Type: "select", Values: []string{"Nachrichten", "Magazin", "Doku", "Spielfilm", "Serie", "Sport", "Unterhaltung", "Werbung", "Sonstiges"}},
			{ID: "language", Label: "Sprache", Type: "select", Values: []string{"de", "en", "fr", "es", "it"}},
			{ID: "keywords", Label: "Schlagworte", Type: "tags", Max: 30},
			{ID: "people", Label: "Personen / Organisationen", Type: "tags", Max: 50},
			{ID: "recordedAt", Label: "Aufnahmedatum", Type: "date"},
			{ID: "source", Label: "Quelle", Type: "text", Max: 200},
			{ID: "rights", Label: "Rechte / Nutzung", Type: "longtext", Max: 2000},
			{ID: "notes", Label: "Redaktionelle Notizen", Type: "longtext", Max: 4000},
		},
	}
}

// Normalize füllt Lücken (aus einem teilweise gespeicherten Dokument) und prüft Wertebereiche.
func (c *Config) Normalize() error {
	d := DefaultConfig()
	if c.MinSegmentFrames < 1 {
		c.MinSegmentFrames = 1
	}
	switch c.ApprovalMode {
	case "":
		c.ApprovalMode = d.ApprovalMode
	case "none", "single", "dual":
	default:
		return fmt.Errorf("approvalMode muss none, single oder dual sein")
	}
	if len(c.QCProfiles) == 0 {
		c.QCProfiles = d.QCProfiles
	}
	for k, p := range c.QCProfiles {
		if p.ID == "" {
			p.ID = k
		}
		if p.ID != k {
			return fmt.Errorf("QC-Profil %q: id %q passt nicht zum Schlüssel", k, p.ID)
		}
		if p.Version < 1 {
			p.Version = 1
		}
		if strings.TrimSpace(p.Name) == "" {
			p.Name = p.ID
		}
		if p.MaxAudioStreams < 1 {
			p.MaxAudioStreams = 16
		}
		if p.TimeoutSec < 30 {
			p.TimeoutSec = 1800
		}
		if p.Expect.FrameRate != "" {
			if _, err := ParseRate(p.Expect.FrameRate); err != nil {
				return fmt.Errorf("QC-Profil %q: %w", k, err)
			}
		}
		if err := p.Validate(); err != nil {
			return fmt.Errorf("QC-Profil %q: %w", k, err)
		}
		c.QCProfiles[k] = p
	}
	if c.DefaultQCProfile == "" {
		c.DefaultQCProfile = d.DefaultQCProfile
	}
	if _, ok := c.QCProfiles[c.DefaultQCProfile]; !ok {
		return fmt.Errorf("defaultQcProfile %q existiert nicht", c.DefaultQCProfile)
	}
	if c.QCWorkers < 1 {
		c.QCWorkers = 1
	}
	if c.QCWorkers > 4 {
		c.QCWorkers = 4
	}
	if c.ProxyHeight < 120 {
		c.ProxyHeight = d.ProxyHeight
	}
	if c.ProxyCRF < 10 || c.ProxyCRF > 40 {
		c.ProxyCRF = d.ProxyCRF
	}
	if c.ProxyMaxAudio < 1 {
		c.ProxyMaxAudio = d.ProxyMaxAudio
	}
	if len(c.MetadataFields) == 0 {
		c.MetadataFields = d.MetadataFields
	}
	seen := map[string]bool{}
	for _, f := range c.MetadataFields {
		if f.ID == "" || seen[f.ID] {
			return fmt.Errorf("Metadatenfeld ohne eindeutige id: %q", f.ID)
		}
		seen[f.ID] = true
		switch f.Type {
		case "text", "longtext", "select", "multiselect", "tags", "date", "number":
		default:
			return fmt.Errorf("Metadatenfeld %q: unbekannter Typ %q", f.ID, f.Type)
		}
		if (f.Type == "select" || f.Type == "multiselect") && len(f.Values) == 0 {
			return fmt.Errorf("Metadatenfeld %q: Auswahlfeld ohne Werte", f.ID)
		}
	}
	return nil
}

// ParseConfig liest ein gespeichertes Dokument (leer = Standard).
func ParseConfig(raw []byte) (Config, error) {
	c := DefaultConfig()
	if len(strings.TrimSpace(string(raw))) > 0 {
		// Felder, die im Dokument fehlen, behalten ihren Standardwert; Slices/Maps ersetzt das Dokument komplett.
		if err := json.Unmarshal(raw, &c); err != nil {
			return Config{}, fmt.Errorf("Konfiguration unlesbar: %w", err)
		}
	}
	if err := c.Normalize(); err != nil {
		return Config{}, err
	}
	return c, nil
}

// Profile liefert ein Profil (leer = Standardprofil).
func (c Config) Profile(id string) (QCProfile, bool) {
	if id == "" {
		id = c.DefaultQCProfile
	}
	p, ok := c.QCProfiles[id]
	return p, ok
}

// ProfileIDs sortiert.
func (c Config) ProfileIDs() []string {
	ids := make([]string, 0, len(c.QCProfiles))
	for k := range c.QCProfiles {
		ids = append(ids, k)
	}
	sort.Strings(ids)
	return ids
}

// ValidateMetadata prüft Asset-Metadaten (segment=false) bzw. Segment-Metadaten (segment=true) gegen das Formularschema.
// Pflichtfelder werden nur geprüft, wenn requireComplete gesetzt ist (Einreichen); Entwürfe dürfen unvollständig sein,
// aber nie ungültige Werte enthalten.
func (c Config) ValidateMetadata(values map[string]any, segment, requireComplete bool) []string {
	var errs []string
	known := map[string]MetaField{}
	for _, f := range c.MetadataFields {
		if f.Segment == segment {
			known[f.ID] = f
		}
	}
	for k := range values {
		if _, ok := known[k]; !ok {
			errs = append(errs, fmt.Sprintf("unbekanntes Feld %q", k))
		}
	}
	for _, f := range known {
		v, present := values[f.ID]
		empty := !present || v == nil || v == "" || isEmptySlice(v)
		if empty {
			if f.Required && requireComplete {
				errs = append(errs, fmt.Sprintf("Pflichtfeld %q fehlt", f.Label))
			}
			continue
		}
		errs = append(errs, validateField(f, v)...)
	}
	sort.Strings(errs)
	return errs
}

func isEmptySlice(v any) bool {
	s, ok := v.([]any)
	return ok && len(s) == 0
}

func validateField(f MetaField, v any) []string {
	bad := func(msg string) []string { return []string{fmt.Sprintf("Feld %q: %s", f.Label, msg)} }
	switch f.Type {
	case "text", "longtext":
		s, ok := v.(string)
		if !ok {
			return bad("Text erwartet")
		}
		if f.Max > 0 && len([]rune(s)) > f.Max {
			return bad(fmt.Sprintf("höchstens %d Zeichen", f.Max))
		}
	case "date":
		s, ok := v.(string)
		if !ok || len(s) != 10 || s[4] != '-' || s[7] != '-' {
			return bad("Datum im Format JJJJ-MM-TT erwartet")
		}
	case "number":
		if _, ok := v.(float64); !ok {
			return bad("Zahl erwartet")
		}
	case "select":
		s, ok := v.(string)
		if !ok || !contains(f.Values, s) {
			return bad("Wert nicht erlaubt")
		}
	case "multiselect", "tags":
		arr, ok := v.([]any)
		if !ok {
			return bad("Liste erwartet")
		}
		if f.Max > 0 && len(arr) > f.Max {
			return bad(fmt.Sprintf("höchstens %d Einträge", f.Max))
		}
		for _, e := range arr {
			s, ok := e.(string)
			if !ok || strings.TrimSpace(s) == "" {
				return bad("Einträge müssen nicht-leerer Text sein")
			}
			if f.Type == "multiselect" && !contains(f.Values, s) {
				return bad(fmt.Sprintf("Wert %q nicht erlaubt", s))
			}
		}
	}
	return nil
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
