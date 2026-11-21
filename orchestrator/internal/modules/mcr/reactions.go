package mcr

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// Reaktionsregeln und Alarm-PiP (106.13e). Regeln sind Daten am Event (`monitoring.reactions`), zur Laufzeit änderbar und Stop/Start-fest.
// Das Alarm-PiP ist ein eigener `omp-switcher` je Event mit festem Ausgangssender; der Multiviewer zeigt ihn als eigene Kachel. Das Umschalten
// ändert nur die Quelle des Switchers — der Multiviewer wird nicht neu aufgebaut, die übrigen Kacheln laufen ohne Lücke weiter.

const (
	ActBorder = "border" // Rahmenfarbe an der Kachel (Voreinstellung der Ampel)
	ActPip    = "pip"    // Quelle ins Alarm-PiP aufschalten
	ActNotice = "notice" // Hinweis an die Bedienung (Toast in der Wand)
	ActGPIO   = "gpio"   // Kontaktausgang setzen

	NodeSwitcher = "omp-switcher"
	monRoleAlarm = "alarm"
	pipTileID    = "alarm-pip"
	// pipDebounce: höchstens alle 2 s umschalten.
	pipDebounce = 2 * time.Second
)

// ReactionTrigger sagt, welche Alarme eine Regel auslösen. Leer = jeder Wert passt.
type ReactionTrigger struct {
	Kinds       []string `json:"kinds,omitempty"`       // Alarmart (`signal-black`) oder Gruppe (`signal`, `signal-`)
	MinSeverity string   `json:"minSeverity,omitempty"` // info | warning | error | critical
	Lines       []string `json:"lines,omitempty"`       // Leitungs-ID oder -Name
}

// ReactionFallback: was das Alarm-PiP zeigt, wenn nichts mehr ansteht.
type ReactionFallback struct {
	Mode   string `json:"mode,omitempty"` // empty (leer) | last (letzte Quelle behalten) | fixed (feste Leitung)
	LineID string `json:"lineId,omitempty"`
}

// GPIOAction: Kontaktausgang eines `omp-gpio`-Nodes (Instanz-ID oder Bezeichnung).
type GPIOAction struct {
	Target string `json:"target"`
	Pin    int    `json:"pin"`
}

// Reaction ist eine Regel.
type Reaction struct {
	ID          string           `json:"id"`
	Name        string           `json:"name,omitempty"`
	Enabled     *bool            `json:"enabled,omitempty"`
	Trigger     ReactionTrigger  `json:"trigger"`
	Actions     []string         `json:"actions"`
	GPIO        *GPIOAction      `json:"gpio,omitempty"`
	HoldSeconds int              `json:"holdSeconds,omitempty"` // Haltezeit nach Alarmende
	Select      string           `json:"select,omitempty"`      // highest (Standard) | latest
	Fallback    ReactionFallback `json:"fallback,omitempty"`
}

func (r Reaction) on() bool { return r.Enabled == nil || *r.Enabled }

func (r Reaction) has(act string) bool {
	for _, a := range r.Actions {
		if a == act {
			return true
		}
	}
	return false
}

// ValidateReactions prüft die Regeln.
func ValidateReactions(label string, rs []Reaction) error {
	if len(rs) > 20 {
		return bad("%s: höchstens 20 Reaktionsregeln", label)
	}
	seen := map[string]bool{}
	for i, r := range rs {
		if !stageIDRe.MatchString(r.ID) || seen[r.ID] {
			return bad("%s: Regel %d braucht eine eigene Kennung (a–z, 0–9, Bindestrich)", label, i+1)
		}
		seen[r.ID] = true
		if len(r.Actions) == 0 {
			return bad("%s: Regel „%s“ hat keine Reaktion", label, r.ID)
		}
		for _, a := range r.Actions {
			if a != ActBorder && a != ActPip && a != ActNotice && a != ActGPIO {
				return bad("%s: Regel „%s“: Reaktion „%s“ unbekannt (border, pip, notice, gpio)", label, r.ID, a)
			}
		}
		if r.has(ActGPIO) && (r.GPIO == nil || strings.TrimSpace(r.GPIO.Target) == "" || r.GPIO.Pin < 1 || r.GPIO.Pin > 64) {
			return bad("%s: Regel „%s“: Kontaktausgang braucht Ziel und Pin 1…64", label, r.ID)
		}
		if r.Trigger.MinSeverity != "" && sevRank(r.Trigger.MinSeverity) < 0 {
			return bad("%s: Regel „%s“: Schweregrad „%s“ unbekannt", label, r.ID, r.Trigger.MinSeverity)
		}
		if r.HoldSeconds < 0 || r.HoldSeconds > 3600 {
			return bad("%s: Regel „%s“: Haltezeit 0…3600 s", label, r.ID)
		}
		if r.Select != "" && r.Select != "highest" && r.Select != "latest" {
			return bad("%s: Regel „%s“: Auswahl „highest“ oder „latest“", label, r.ID)
		}
		if m := r.Fallback.Mode; m != "" && m != "empty" && m != "last" && m != "fixed" {
			return bad("%s: Regel „%s“: Rückfall „empty“, „last“ oder „fixed“", label, r.ID)
		}
		if r.Fallback.Mode == "fixed" && r.Fallback.LineID == "" {
			return bad("%s: Regel „%s“: fester Rückfall braucht eine Leitung", label, r.ID)
		}
	}
	return nil
}

// sevRank: Schweregrad als Zahl; unbekannt = -1.
func sevRank(s string) int {
	switch strings.ToLower(s) {
	case "info":
		return 0
	case "warning", "warn":
		return 1
	case "error":
		return 2
	case "critical":
		return 3
	}
	return -1
}

// Matches: löst der Alarm die Regel aus?
func (r Reaction) Matches(a Alarm) bool {
	if !r.on() {
		return false
	}
	if len(r.Trigger.Kinds) > 0 {
		ok := false
		for _, k := range r.Trigger.Kinds {
			if k == a.Kind || (strings.HasSuffix(k, "-") && strings.HasPrefix(a.Kind, k)) || strings.HasPrefix(a.Kind, k+"-") {
				ok = true
			}
		}
		if !ok {
			return false
		}
	}
	if r.Trigger.MinSeverity != "" && sevRank(a.Severity) < sevRank(r.Trigger.MinSeverity) {
		return false
	}
	if len(r.Trigger.Lines) > 0 {
		ok := false
		for _, l := range r.Trigger.Lines {
			if l == a.LineID || l == a.LineName {
				ok = true
			}
		}
		if !ok {
			return false
		}
	}
	return true
}

// ActionsFor: alle Reaktionen, die für den Alarm gelten (Vereinigung aller passenden Regeln).
func ActionsFor(rs []Reaction, a Alarm) []string {
	seen := map[string]bool{}
	var out []string
	for _, r := range rs {
		if r.Matches(a) {
			for _, act := range r.Actions {
				if !seen[act] {
					seen[act] = true
					out = append(out, act)
				}
			}
		}
	}
	return out
}

// HasPip: braucht das Event ein Alarm-PiP?
func HasPip(rs []Reaction) bool {
	for _, r := range rs {
		if r.on() && r.has(ActPip) {
			return true
		}
	}
	return false
}

// PipState ist der Zustand des Alarm-PiPs eines Events (im Speicher; die Sperre ist eine Bedienhandlung und gilt bis zum Aufheben).
type PipState struct {
	Lock       string    // Leitungs-ID, die der Operator festhält; leer = automatisch
	Current    string    // Leitung, die zurzeit aufgeschaltet ist
	LastSwitch time.Time // letzte Umschaltung (Entprellen)
}

// SelectPip wählt die Leitung für das Alarm-PiP. Rein: Regeln, Alarme (offene und kürzlich beendete), Zeit, Zustand.
// Vorrang: Sperre → Regeln in Reihenfolge, je Regel nach `select`; Haltezeit nach Ende; sonst Rückfall der ersten Pip-Regel; Entprellen.
func SelectPip(rs []Reaction, alarms []Alarm, now time.Time, st PipState) (string, PipState) {
	target := ""
	switch {
	case st.Lock != "":
		target = st.Lock
	default:
		var pipRules []Reaction
		for _, r := range rs {
			if r.on() && r.has(ActPip) {
				pipRules = append(pipRules, r)
			}
		}
		for _, r := range pipRules {
			var best *Alarm
			for i := range alarms {
				a := &alarms[i]
				if !r.Matches(*a) {
					continue
				}
				if a.EndedAt != nil && now.After(a.EndedAt.Add(time.Duration(r.HoldSeconds)*time.Second)) {
					continue // Haltezeit abgelaufen
				}
				if best == nil || better(r.Select, *a, *best) {
					best = a
				}
			}
			if best != nil {
				target = best.LineID
				break
			}
		}
		if target == "" && len(pipRules) > 0 {
			switch fb := pipRules[0].Fallback; fb.Mode {
			case "last":
				target = st.Current
			case "fixed":
				target = fb.LineID
			}
		}
	}
	if target != st.Current && !st.LastSwitch.IsZero() && now.Sub(st.LastSwitch) < pipDebounce && st.Lock == "" {
		return st.Current, st // zu schnell hintereinander: bleiben
	}
	if target != st.Current {
		st.Current, st.LastSwitch = target, now
	}
	return st.Current, st
}

// better: ist a für die Auswahl besser als b? `highest` (Standard): Schweregrad vor Alter; offene vor beendeten; `latest`: neuester zuerst.
func better(sel string, a, b Alarm) bool {
	aOpen, bOpen := a.EndedAt == nil, b.EndedAt == nil
	if aOpen != bOpen {
		return aOpen
	}
	if sel != "latest" && sevRank(a.Severity) != sevRank(b.Severity) {
		return sevRank(a.Severity) > sevRank(b.Severity)
	}
	return a.StartedAt.After(b.StartedAt)
}

// ---- Anbindung ----

// GPIOSetter setzt einen Kontaktausgang (im Orchestrator: Methode `setOutput` des `omp-gpio`-Nodes).
type GPIOSetter func(ctx context.Context, target string, pin int, level bool) error

// onAlarm führt die Reaktionen auf Eintritt/Ende eines Alarms aus (Kontaktausgang); Rahmen und PiP laufen über den Abgleich.
func (rt *Runtime) onAlarm(ctx context.Context, s *Service, e Event, a Alarm, raised bool) {
	mon, _ := ParseMon(e.Monitoring)
	if rt.GPIO == nil {
		return
	}
	for _, r := range mon.Reactions {
		if !r.on() || !r.has(ActGPIO) || r.GPIO == nil || !r.Matches(a) {
			continue
		}
		level := raised
		if !raised {
			// Entwarnung: Ausgang erst zurück, wenn kein anderer Alarm dieser Regel mehr offen ist
			open, err := s.St.EventAlarms(ctx, e.ID, true)
			if err != nil {
				continue
			}
			for _, o := range open {
				if r.Matches(o) {
					level = true
				}
			}
		}
		if err := rt.GPIO(ctx, r.GPIO.Target, r.GPIO.Pin, level); err != nil {
			slog.Warn("mcr: Kontaktausgang", "event", e.ID, "rule", r.ID, "error", err)
		}
	}
}

// PipLock hält eine Leitung im Alarm-PiP fest (leer = automatisch).
func (rt *Runtime) PipLock(eventID, lineID string) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if rt.pip == nil {
		rt.pip = map[string]PipState{}
	}
	st := rt.pip[eventID]
	st.Lock = lineID
	rt.pip[eventID] = st
}

// reconcilePip bestimmt die Quelle des Alarm-PiPs und schaltet den Switcher um; gibt die Leitung zurück, die gezeigt wird.
func (rt *Runtime) reconcilePip(ctx context.Context, s *Service, e Event, outSender map[string]string, switcherInst string) string {
	mon, _ := ParseMon(e.Monitoring)
	if !HasPip(mon.Reactions) {
		return ""
	}
	alarms, err := s.St.EventAlarms(ctx, e.ID, false)
	if err != nil {
		return ""
	}
	rt.mu.Lock()
	st := rt.pip[e.ID]
	rt.mu.Unlock()
	target, next := SelectPip(mon.Reactions, alarms, time.Now(), st)
	rt.mu.Lock()
	if rt.pip == nil {
		rt.pip = map[string]PipState{}
	}
	prevCur := rt.pip[e.ID].Current
	rt.pip[e.ID] = next
	rt.mu.Unlock()
	if switcherInst == "" {
		return target
	}
	// Schalten, wenn sich die Wahl geändert hat oder der Switcher neu ist (je Instanz einmal)
	key := e.ID + "/pip"
	want := switcherInst + "|" + target + "|" + outSender[target]
	rt.mu.Lock()
	same := rt.applied[key] == want
	rt.mu.Unlock()
	if same {
		return target
	}
	_ = prevCur
	base, ok := rt.Nodes.BaseURL(switcherInst)
	if !ok {
		return target
	}
	b, code, err := rt.Nodes.Do(ctx, http.MethodPost, base+"/methods/select", map[string]any{"senderId": outSender[target]})
	if err != nil || code >= 300 {
		slog.Warn("mcr: Alarm-PiP umschalten", "event", e.ID, "error", err, "status", code, "body", strings.TrimSpace(string(b)))
		return target
	}
	rt.mu.Lock()
	if rt.applied == nil {
		rt.applied = map[string]string{}
	}
	rt.applied[key] = want
	rt.mu.Unlock()
	return target
}
