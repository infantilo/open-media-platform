package alertsink

import (
	"fmt"
	"net/mail"
	"strings"
)

// Route ist eine Empfängerregel: passt ein Alarm (Art UND Schweregrad), gehen die Mails an To.
// Leere Listen heißen „alle“. Eine passende Regel ohne Empfänger unterdrückt die Mail.
type Route struct {
	Name       string   `json:"name"`
	Enabled    bool     `json:"enabled"`
	Kinds      []string `json:"kinds"`
	Severities []string `json:"severities"`
	// Workflows (IDs): nur Alarme, die zu einem dieser Workflows gehören; leer = alle (auch ohne Workflow).
	Workflows []string `json:"workflows"`
	// Processes (Definitions-IDs): wie Workflows, für Prozess-Alarme. Sind Workflows UND Prozesse gesetzt, genügt ein Treffer in einer der Listen.
	Processes []string `json:"processes"`
	// Actions: nur für die Art „user-action“: Benutzeraktionen als „objektart.aktion“ (z. B. review.rejected); „review.*“ = alle der Objektart.
	Actions []string `json:"actions"`
	// Status: Statusbeilage in der Mail — "" (keine) | "text" (Orchestrator, Hosts, Workflows, Signalweg als Text) | "graph" (zusätzlich Node-Grafik als PNG) | "graph-svg" (als SVG-Anhang).
	Status string `json:"status,omitempty"`
	To     string `json:"to"` // durch Komma/Semikolon getrennt
}

// Matches prüft Art und Schweregrad.
func (r Route) Matches(a Alert) bool {
	if !r.Enabled {
		return false
	}
	if len(r.Kinds) == 0 && isOptIn(a.Kind) {
		return false // Opt-in-Arten nur auf ausdrückliche Nennung
	}
	if !contains(r.Kinds, a.Kind) || !contains(r.Severities, a.Severity) {
		return false
	}
	if len(r.Actions) > 0 && !actionMatches(r.Actions, a.Action) {
		return false
	}
	if len(r.Workflows) == 0 && len(r.Processes) == 0 {
		return true
	}
	for _, w := range a.Workflows {
		if member(r.Workflows, w.ID) {
			return true
		}
	}
	for _, p := range a.Processes {
		if member(r.Processes, p.ID) {
			return true
		}
	}
	return false
}

// actionMatches: exakt oder „objektart.*“.
func actionMatches(list []string, action string) bool {
	for _, p := range list {
		if p == action || (strings.HasSuffix(p, ".*") && strings.HasPrefix(action, strings.TrimSuffix(p, "*"))) {
			return true
		}
	}
	return false
}

func member(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func contains(list []string, v string) bool {
	if len(list) == 0 {
		return true
	}
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func splitAddrs(s string) []string {
	var out []string
	for _, r := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == ';' || r == ' ' || r == '\n' }) {
		if r = strings.TrimSpace(r); r != "" {
			out = append(out, r)
		}
	}
	return out
}

// Validate prüft Namen der Arten/Schweregrade und die Adressen.
func (r Route) Validate() error {
	for _, k := range r.Kinds {
		if !validKindName(k) {
			return fmt.Errorf("Regel „%s“: ungültige Alarmart %q", r.Name, k)
		}
	}
	if !validStatusMode(r.Status) {
		return fmt.Errorf("Regel „%s“: unbekannter Status-Modus %q (text|graph|graph-svg)", r.Name, r.Status)
	}
	for _, a := range r.Actions {
		if strings.TrimSpace(a) == "" || len(a) > 128 || strings.ContainsAny(a, " \t\r\n,;") {
			return fmt.Errorf("Regel „%s“: ungültige Benutzeraktion %q", r.Name, a)
		}
	}
	for _, s := range r.Severities {
		if !validSeverity(s) {
			return fmt.Errorf("Regel „%s“: unbekannter Schweregrad %q", r.Name, s)
		}
	}
	for _, a := range splitAddrs(r.To) {
		if _, err := mail.ParseAddress(a); err != nil {
			return fmt.Errorf("Regel „%s“: Empfänger %q: %w", r.Name, a, err)
		}
	}
	return nil
}

// Recipients bestimmt die Empfänger eines Alarms: Vereinigung aller passenden Regeln;
// passt keine, die Standard-Empfänger.
func (m *Mailer) Recipients(a Alert) []string {
	matched := false
	seen := map[string]bool{}
	var out []string
	for _, r := range m.Routes {
		if !r.Matches(a) {
			continue
		}
		matched = true
		for _, x := range splitAddrs(r.To) {
			if k := strings.ToLower(x); !seen[k] {
				seen[k] = true
				out = append(out, x)
			}
		}
	}
	if matched {
		return out
	}
	if isOptIn(a.Kind) {
		return nil // Opt-in-Arten gehen nie an die Standard-Empfänger
	}
	return m.To
}

// allRecipients: Standard-Empfänger plus alle Regel-Empfänger (für die ungerichtete Testmail).
func (m *Mailer) allRecipients() []string {
	seen := map[string]bool{}
	var out []string
	add := func(l []string) {
		for _, x := range l {
			if k := strings.ToLower(x); !seen[k] {
				seen[k] = true
				out = append(out, x)
			}
		}
	}
	add(m.To)
	for _, r := range m.Routes {
		if r.Enabled {
			add(splitAddrs(r.To))
		}
	}
	return out
}

// StatusMode bestimmt, welche Statusbeilage die Mail zu a bekommt: der „größte“ Wunsch aller passenden Regeln
// (graph vor text vor keine). Gilt für die ganze Mail, also für alle Empfänger gleich.
func (m *Mailer) StatusMode(a Alert) string {
	mode := StatusNone
	for _, r := range m.Routes {
		if !r.Matches(a) || len(splitAddrs(r.To)) == 0 {
			continue
		}
		switch {
		case r.Status == StatusGraph || r.Status == StatusSVG:
			if mode == StatusGraph || mode == StatusSVG {
				continue // erste Grafik-Regel bestimmt das Format (entweder/oder, nicht beides)
			}
			mode = r.Status
		case r.Status == StatusText && mode == StatusNone:
			mode = StatusText
		}
	}
	return mode
}
