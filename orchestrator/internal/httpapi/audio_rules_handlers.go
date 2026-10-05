package httpapi

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
)

// Dynamische Audio-Zuordnung (docs/ENTWURF-AUDIO-REGELN.md, A2): ein
// Einstellungsdokument für die ganze Plattform — Ausgabeprofil (Zielgruppen),
// Spurschemata, Zuordnungsvorlagen und Regelsatz. Persistiert im generischen
// NodeSettingsStore unter dem Schlüssel "audio-rules"; Auflösung und
// Ausführung passieren in den Nodes (Rust-Crate omp-audio-rules), der
// Orchestrator speichert und prüft nur die Struktur.
//
// Die Standardwerte (fünf ORF-Programmgruppen, 8-Spur-MXF-Schema, 13 ORF-
// Presets als Vorlagen, Ersatzregeln) erzeugt das Rust-Crate; die Datei hier
// ist deren Abzug (ein Rust-Test hält beide synchron, s.
// omp-audio-rules/src/defaults.rs).

const audioRulesKey = "audio-rules"

//go:embed audio_rules_default.json
var defaultAudioRulesJSON []byte

type audioProcessorRef struct {
	Name   string         `json:"name"`
	Params map[string]any `json:"params,omitempty"`
}

type audioSourceSpec struct {
	Tracks *[]int              `json:"tracks,omitempty"`
	Select *string             `json:"select,omitempty"`
	Via    *string             `json:"via,omitempty"`
	Chain  []audioProcessorRef `json:"chain,omitempty"`
}

type audioTargetGroup struct {
	ID       string           `json:"id"`
	Label    string           `json:"label"`
	Layout   string           `json:"layout,omitempty"`
	Channels []string         `json:"channels,omitempty"`
	Tags     []string         `json:"tags,omitempty"`
	Default  *audioSourceSpec `json:"default,omitempty"`
}

type audioSourceTrack struct {
	N        int      `json:"n"`
	Layout   string   `json:"layout,omitempty"`
	Channels []string `json:"channels,omitempty"`
	Tags     []string `json:"tags,omitempty"`
}

type audioSchemaMatch struct {
	Format *string `json:"format,omitempty"`
	Tracks *int    `json:"tracks,omitempty"`
	Path   *string `json:"path,omitempty"`
}

type audioTrackSchema struct {
	ID     string             `json:"id"`
	Match  audioSchemaMatch   `json:"match"`
	Tracks []audioSourceTrack `json:"tracks"`
}

type audioMapping struct {
	ID     string                     `json:"id"`
	Label  string                     `json:"label,omitempty"`
	Groups map[string]audioSourceSpec `json:"groups"`
}

type audioWhen struct {
	Missing *string `json:"missing,omitempty"`
	Has     *string `json:"has,omitempty"`
	Source  *string `json:"source,omitempty"`
}

type audioAction struct {
	Use     *audioSourceSpec `json:"use,omitempty"`
	Silence bool             `json:"silence,omitempty"`
	Fail    bool             `json:"fail,omitempty"`
	Warn    *string          `json:"warn,omitempty"`
}

type audioRule struct {
	ID    string        `json:"id,omitempty"`
	Group string        `json:"group"`
	When  audioWhen     `json:"when"`
	Then  []audioAction `json:"then"`
}

type audioRulesDoc struct {
	OutputProfile struct {
		Groups []audioTargetGroup `json:"groups"`
	} `json:"outputProfile"`
	TrackSchemas []audioTrackSchema `json:"trackSchemas"`
	Mappings     []audioMapping     `json:"mappings"`
	RuleSet      struct {
		Rules []audioRule `json:"rules"`
	} `json:"ruleSet"`
}

var (
	audioLayouts     = map[string]bool{"": true, "mono": true, "stereo": true, "5.1": true, "7.1": true, "custom": true}
	audioMatrixProcs = map[string]bool{"auto": true, "matrix": true, "mono-to-stereo": true, "stereo-to-mono": true, "upmix51": true, "downmix": true, "downmix-mono": true}
	audioDSPProcs    = map[string]bool{"dialog-enhance": true, "loudness": true, "gain": true, "delay": true}
)

// handleGetAudioRules: für jeden authentifizierten Nutzer lesbar; Nodes holen
// das Dokument beim Start per Service-Token. Ohne gespeicherten Stand: Standardwerte.
func handleGetAudioRules(store NodeSettingsStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, err := store.Get(audioRulesKey)
		if errors.Is(err, launcher.ErrNodeSettingsNotFound) {
			data = defaultAudioRulesJSON
		} else if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}
}

// handleGetAudioRulesDefault liefert immer die Standardwerte („Auf Standard zurücksetzen“ im Editor).
func handleGetAudioRulesDefault() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(defaultAudioRulesJSON)
	}
}

// handlePutAudioRules ersetzt das gesamte Dokument (admin-only, expliziter
// Ganz-Speichern-Vorgang) nach Validierung.
func handlePutAudioRules(store NodeSettingsStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var doc audioRulesDoc
		dec := json.NewDecoder(r.Body)
		dec.DisallowUnknownFields()
		if err := dec.Decode(&doc); err != nil {
			http.Error(w, "invalid JSON body: "+err.Error(), http.StatusBadRequest)
			return
		}
		if errs := validateAudioRules(doc); len(errs) > 0 {
			http.Error(w, strings.Join(errs, "\n"), http.StatusBadRequest)
			return
		}
		data, err := json.Marshal(doc)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if err := store.Put(audioRulesKey, data); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, doc)
	}
}

// validateAudioRules spiegelt omp-audio-rules::validate (Rust); die Nodes
// prüfen beim Laden erneut.
func validateAudioRules(d audioRulesDoc) []string {
	var errs []string
	groups := map[string]audioTargetGroup{}
	for _, g := range d.OutputProfile.Groups {
		if g.ID == "" {
			errs = append(errs, "Zielgruppe ohne ID")
			continue
		}
		if _, dup := groups[g.ID]; dup {
			errs = append(errs, fmt.Sprintf("Zielgruppe '%s': doppelte ID", g.ID))
		}
		groups[g.ID] = g
		if !audioLayouts[g.Layout] {
			errs = append(errs, fmt.Sprintf("Zielgruppe '%s': unbekanntes Layout '%s'", g.ID, g.Layout))
		}
		if g.Layout == "custom" && len(g.Channels) == 0 {
			errs = append(errs, fmt.Sprintf("Zielgruppe '%s': Layout 'custom' braucht Kanalnamen", g.ID))
		}
		if g.Default != nil {
			errs = append(errs, checkAudioSpec(fmt.Sprintf("Zielgruppe '%s' Vorgabe", g.ID), *g.Default, &g)...)
		}
	}
	if len(d.OutputProfile.Groups) == 0 {
		errs = append(errs, "mindestens eine Zielgruppe ist nötig")
	}
	seenSchema := map[string]bool{}
	for _, s := range d.TrackSchemas {
		if s.ID == "" || seenSchema[s.ID] {
			errs = append(errs, fmt.Sprintf("Spurschema '%s': ID leer oder doppelt", s.ID))
		}
		seenSchema[s.ID] = true
		seenN := map[int]bool{}
		for _, t := range s.Tracks {
			if t.N < 1 || seenN[t.N] {
				errs = append(errs, fmt.Sprintf("Spurschema '%s': Spurnummer %d ungültig oder doppelt", s.ID, t.N))
			}
			seenN[t.N] = true
			if !audioLayouts[t.Layout] {
				errs = append(errs, fmt.Sprintf("Spurschema '%s' Spur %d: unbekanntes Layout '%s'", s.ID, t.N, t.Layout))
			}
		}
	}
	seenMap := map[string]bool{}
	for _, m := range d.Mappings {
		if m.ID == "" || seenMap[m.ID] {
			errs = append(errs, fmt.Sprintf("Zuordnung '%s': ID leer oder doppelt", m.ID))
		}
		seenMap[m.ID] = true
		for gid, spec := range m.Groups {
			g, ok := groups[gid]
			if !ok {
				errs = append(errs, fmt.Sprintf("Zuordnung '%s': unbekannte Zielgruppe '%s'", m.ID, gid))
				continue
			}
			errs = append(errs, checkAudioSpec(fmt.Sprintf("Zuordnung '%s' / %s", m.ID, gid), spec, &g)...)
		}
	}
	for _, r := range d.RuleSet.Rules {
		var target *audioTargetGroup
		if r.Group != "*" {
			g, ok := groups[r.Group]
			if !ok {
				errs = append(errs, fmt.Sprintf("Regel '%s': unbekannte Zielgruppe '%s'", r.ID, r.Group))
			} else {
				target = &g
			}
		}
		for _, e := range []*string{r.When.Missing, r.When.Has} {
			if e != nil {
				if err := parseAudioTagExpr(*e); err != nil {
					errs = append(errs, fmt.Sprintf("Regel '%s': Tag-Ausdruck '%s': %v", r.ID, *e, err))
				}
			}
		}
		if r.When.Source != nil && *r.When.Source != "file" && *r.When.Source != "live" {
			errs = append(errs, fmt.Sprintf("Regel '%s': source muss 'file' oder 'live' sein", r.ID))
		}
		for _, a := range r.Then {
			if a.Use != nil {
				errs = append(errs, checkAudioSpec(fmt.Sprintf("Regel '%s'", r.ID), *a.Use, target)...)
			}
		}
	}
	return errs
}

func checkAudioSpec(ctx string, s audioSourceSpec, g *audioTargetGroup) []string {
	var errs []string
	switch {
	case s.Tracks != nil && s.Select == nil:
		for _, n := range *s.Tracks {
			if n < 0 {
				errs = append(errs, fmt.Sprintf("%s: Spurnummer %d ungültig", ctx, n))
			}
		}
	case s.Tracks == nil && s.Select != nil:
		if err := parseAudioTagExpr(*s.Select); err != nil {
			errs = append(errs, fmt.Sprintf("%s: Tag-Ausdruck '%s': %v", ctx, *s.Select, err))
		}
	default:
		errs = append(errs, ctx+": genau eines von 'tracks' oder 'select' angeben")
	}
	if s.Via != nil && !audioMatrixProcs[*s.Via] {
		errs = append(errs, fmt.Sprintf("%s: unbekannter Prozessor '%s'", ctx, *s.Via))
	}
	for _, p := range s.Chain {
		if !audioDSPProcs[p.Name] {
			errs = append(errs, fmt.Sprintf("%s: unbekannter Verarbeitungsschritt '%s'", ctx, p.Name))
		}
	}
	if g != nil {
		for _, t := range g.Tags {
			if strings.EqualFold(t, "bitexact") && (len(s.Chain) > 0 || (s.Via != nil && *s.Via != "auto" && *s.Via != "matrix")) {
				errs = append(errs, fmt.Sprintf("%s: Gruppe '%s' ist bit-exakt, keine Verarbeitung erlaubt", ctx, g.ID))
			}
		}
	}
	return errs
}

// parseAudioTagExpr prüft nur die Syntax von `a AND (b OR NOT c)` (Auswertung: Rust).
func parseAudioTagExpr(src string) error {
	var tokens []string
	var cur strings.Builder
	flush := func() {
		if cur.Len() > 0 {
			tokens = append(tokens, cur.String())
			cur.Reset()
		}
	}
	for _, c := range src {
		switch {
		case c == '(' || c == ')':
			flush()
			tokens = append(tokens, string(c))
		case c == ' ' || c == '\t' || c == '\n':
			flush()
		case c == '_' || c == '.' || c == ':' || c == '-' || c == '+' || c == '/' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c > 127:
			cur.WriteRune(c)
		default:
			return fmt.Errorf("ungültiges Zeichen '%c'", c)
		}
	}
	flush()
	if len(tokens) == 0 {
		return errors.New("leerer Ausdruck")
	}
	pos := 0
	kw := func(k string) bool { return pos < len(tokens) && strings.EqualFold(tokens[pos], k) }
	var or func() error
	var not func() error
	not = func() error {
		if kw("not") {
			pos++
			return not()
		}
		if pos >= len(tokens) {
			return errors.New("Ausdruck endet unerwartet")
		}
		t := tokens[pos]
		pos++
		if t == "(" {
			if err := or(); err != nil {
				return err
			}
			if pos >= len(tokens) || tokens[pos] != ")" {
				return errors.New("schließende Klammer fehlt")
			}
			pos++
			return nil
		}
		if t == ")" || strings.EqualFold(t, "and") || strings.EqualFold(t, "or") {
			return fmt.Errorf("unerwartetes '%s'", t)
		}
		return nil
	}
	and := func() error {
		if err := not(); err != nil {
			return err
		}
		for kw("and") {
			pos++
			if err := not(); err != nil {
				return err
			}
		}
		return nil
	}
	or = func() error {
		if err := and(); err != nil {
			return err
		}
		for kw("or") {
			pos++
			if err := and(); err != nil {
				return err
			}
		}
		return nil
	}
	if err := or(); err != nil {
		return err
	}
	if pos != len(tokens) {
		return fmt.Errorf("unerwartetes '%s'", tokens[pos])
	}
	return nil
}
