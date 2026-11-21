package mcr

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Überwachungseinstellungen (106.13d/e): Profil und Abweichungen der Signalprüfung sowie Reaktionsregeln, je Event und je Leitung.
// Alles Daten in der Datenbank (Quelle der Wahrheit, Stop/Start-fest); die Leitung überstimmt das Event.

// MonCfg ist das Überwachungs-JSON eines Events oder einer Leitung.
type MonCfg struct {
	// Profil der Signalprüfung (`standard`, `strict`, `off` oder ein vom Administrator angelegtes); leer = Voreinstellung des Scope.
	Profile string `json:"profile,omitempty"`
	// Abweichungen vom Profil: `<Prüfung>.<Feld>` → Wert, z. B. `black.holdSeconds: 5`. Felder: enabled, threshold, holdSeconds, severity.
	Overrides map[string]any `json:"overrides,omitempty"`
	// Reaktionsregeln (nur am Event, 106.13e).
	Reactions []Reaction `json:"reactions,omitempty"`
}

var overrideKeyRe = regexp.MustCompile(`^[a-zA-Z]+\.(enabled|threshold|holdSeconds|severity)$`)
var profileNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$`)

// ParseMon liest ein Überwachungs-JSON; leer/null = keine Angaben.
func ParseMon(raw json.RawMessage) (MonCfg, error) {
	var c MonCfg
	t := strings.TrimSpace(string(raw))
	if t == "" || t == "null" {
		return c, nil
	}
	if err := json.Unmarshal(raw, &c); err != nil {
		return c, fmt.Errorf("Überwachung: %v", err)
	}
	return c, nil
}

// ValidateMon prüft Profilname, Abweichungen und Reaktionsregeln.
func ValidateMon(label string, raw json.RawMessage, isEvent bool) error {
	c, err := ParseMon(raw)
	if err != nil {
		return bad("%s: %v", label, err)
	}
	if c.Profile != "" && !profileNameRe.MatchString(c.Profile) {
		return bad("%s: Profilname ungültig", label)
	}
	for k := range c.Overrides {
		if !overrideKeyRe.MatchString(k) {
			return bad("%s: Abweichung „%s“ ungültig (<Prüfung>.enabled|threshold|holdSeconds|severity)", label, k)
		}
	}
	if len(c.Reactions) > 0 && !isEvent {
		return bad("%s: Reaktionsregeln gehören ans Event", label)
	}
	return ValidateReactions(label, c.Reactions)
}

// EffectiveMon: Profil und Abweichungen der Leitung überstimmen die des Events; Reaktionsregeln kommen vom Event.
func EffectiveMon(event, line json.RawMessage) MonCfg {
	e, _ := ParseMon(event)
	l, _ := ParseMon(line)
	out := MonCfg{Profile: e.Profile, Overrides: map[string]any{}, Reactions: e.Reactions}
	for k, v := range e.Overrides {
		out.Overrides[k] = v
	}
	if l.Profile != "" {
		out.Profile = l.Profile
	}
	for k, v := range l.Overrides {
		out.Overrides[k] = v
	}
	return out
}

// Off: Profil `off` schaltet die Prüfung der Leitung ab (kein Alarm, keine Weitergabe).
func (c MonCfg) Off() bool { return strings.EqualFold(c.Profile, "off") }

// ScopeParams: Parameter der Scope-Instanz in fester Reihenfolge (erst Profil, dann Abweichungen), damit Tests und Protokolle stabil sind.
func (c MonCfg) ScopeParams() []ParamSet {
	var out []ParamSet
	if c.Profile != "" {
		out = append(out, ParamSet{"qc.profile", c.Profile})
	}
	keys := make([]string, 0, len(c.Overrides))
	for k := range c.Overrides {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		out = append(out, ParamSet{"qc." + k, c.Overrides[k]})
	}
	return out
}
