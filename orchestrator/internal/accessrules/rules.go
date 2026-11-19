// Package accessrules legt fest, welche Quellen (Sender) und Senken (Empfänger) ein Nutzer sehen und schalten darf.
//
// Modell (bewusst klein und erklärbar):
//   - Eine Regel gilt für ein Subjekt (alle = global, ein Nutzer oder eine Gruppe), für Quellen oder Senken, für die Handlung
//     „sehen“ oder „schalten“, mit Wirkung „erlauben“ oder „sperren“, und trifft Endpunkte über einen Selektor (alle, ein
//     Endpunkt, ein Node, ein Workflow, ein Tag, ein Medientyp oder ein Namensmuster).
//   - Ohne irgendeine Regel ist alles offen (der bisherige Zustand).
//   - Sperren gewinnt immer (Blacklist). Gibt es für Art und Handlung mindestens eine Erlauben-Regel im Geltungsbereich des
//     Nutzers (global, er selbst oder eine seiner Gruppen), gilt eine Freigabeliste: nur was eine Erlauben-Regel trifft, ist
//     erlaubt. Erlauben-Regeln mehrerer Bereiche vereinigen sich.
//   - Schalten setzt Sehen voraus: was ein Nutzer nicht sieht, schaltet er nicht.
//   - Nutzer mit dem Recht „configure“ (Engineering), Dienst-Konten der Nodes und der Support-Zugang unterliegen den Regeln nicht.
package accessrules

import (
	"fmt"
	"strings"
)

const (
	SubjectGlobal = "global"
	SubjectUser   = "user"
	SubjectGroup  = "group"

	KindSource = "source"
	KindSink   = "sink"

	ActionSee   = "see"
	ActionRoute = "route"

	EffectAllow = "allow"
	EffectDeny  = "deny"

	SelAll      = "all"
	SelEndpoint = "endpoint"
	SelNode     = "node"
	SelWorkflow = "workflow"
	SelTag      = "tag"
	SelMedia    = "media"
	SelLabel    = "label"
)

// Rule ist eine Zugriffsregel.
type Rule struct {
	ID            string `json:"id"`
	SubjectType   string `json:"subjectType"`
	Subject       string `json:"subject,omitempty"` // Nutzername bzw. Gruppen-ID; leer bei global
	Kind          string `json:"kind"`
	Action        string `json:"action"`
	Effect        string `json:"effect"`
	SelectorType  string `json:"selectorType"`
	SelectorValue string `json:"selectorValue,omitempty"`
	Note          string `json:"note,omitempty"`
	CreatedBy     string `json:"createdBy,omitempty"`
	CreatedAt     string `json:"createdAt,omitempty"`
}

// Endpoint beschreibt, was ein Selektor trifft: eine Quelle oder Senke samt Zuordnung.
type Endpoint struct {
	ID         string
	NodeID     string
	NodeLabel  string
	Label      string
	MediaType  string
	WorkflowID string
	Tags       []string
}

// Validate prüft eine Regel und gibt den ersten Fehler (deutsch) zurück.
func (r Rule) Validate() error {
	switch r.SubjectType {
	case SubjectGlobal:
		if r.Subject != "" {
			return fmt.Errorf("eine globale Regel hat kein Subjekt")
		}
	case SubjectUser, SubjectGroup:
		if strings.TrimSpace(r.Subject) == "" {
			return fmt.Errorf("Nutzer bzw. Gruppe fehlt")
		}
	default:
		return fmt.Errorf("unbekannter Subjekt-Typ %q", r.SubjectType)
	}
	if r.Kind != KindSource && r.Kind != KindSink {
		return fmt.Errorf("unbekannte Art %q (source oder sink)", r.Kind)
	}
	if r.Action != ActionSee && r.Action != ActionRoute {
		return fmt.Errorf("unbekannte Handlung %q (see oder route)", r.Action)
	}
	if r.Effect != EffectAllow && r.Effect != EffectDeny {
		return fmt.Errorf("unbekannte Wirkung %q (allow oder deny)", r.Effect)
	}
	switch r.SelectorType {
	case SelAll:
		if r.SelectorValue != "" {
			return fmt.Errorf("der Selektor „alle“ hat keinen Wert")
		}
	case SelEndpoint, SelNode, SelWorkflow, SelTag, SelMedia, SelLabel:
		if strings.TrimSpace(r.SelectorValue) == "" {
			return fmt.Errorf("dem Selektor %q fehlt der Wert", r.SelectorType)
		}
		if len(r.SelectorValue) > 200 {
			return fmt.Errorf("der Selektor-Wert ist zu lang")
		}
	default:
		return fmt.Errorf("unbekannter Selektor %q", r.SelectorType)
	}
	return nil
}

// Matches sagt, ob der Selektor der Regel den Endpunkt trifft.
func (r Rule) Matches(ep Endpoint) bool {
	v := r.SelectorValue
	switch r.SelectorType {
	case SelAll:
		return true
	case SelEndpoint:
		return ep.ID == v
	case SelNode:
		return ep.NodeID == v
	case SelWorkflow:
		return ep.WorkflowID == v
	case SelMedia:
		return strings.EqualFold(ep.MediaType, v)
	case SelTag:
		for _, t := range ep.Tags {
			if strings.EqualFold(t, v) {
				return true
			}
		}
		return false
	case SelLabel:
		return glob(strings.ToLower(v), strings.ToLower(ep.Label)) || glob(strings.ToLower(v), strings.ToLower(ep.NodeLabel+" / "+ep.Label))
	}
	return false
}

// glob: „*“ steht für beliebig viele Zeichen (auch keine); kein weiteres Sonderzeichen.
func glob(pattern, s string) bool {
	parts := strings.Split(pattern, "*")
	if len(parts) == 1 {
		return pattern == s
	}
	if !strings.HasPrefix(s, parts[0]) {
		return false
	}
	s = s[len(parts[0]):]
	for _, mid := range parts[1 : len(parts)-1] {
		i := strings.Index(s, mid)
		if i < 0 {
			return false
		}
		s = s[i+len(mid):]
	}
	return strings.HasSuffix(s, parts[len(parts)-1])
}

// Describe liefert einen kurzen lesbaren Text für eine Regel (Auswertungs-Begründungen, Protokoll).
func (r Rule) Describe() string {
	who := "alle"
	switch r.SubjectType {
	case SubjectUser:
		who = "Nutzer " + r.Subject
	case SubjectGroup:
		who = "Gruppe " + r.Subject
	}
	what := map[string]string{SelAll: "alles", SelEndpoint: "Endpunkt", SelNode: "Node", SelWorkflow: "Workflow", SelTag: "Tag", SelMedia: "Medientyp", SelLabel: "Name"}[r.SelectorType]
	if r.SelectorValue != "" {
		what += " " + r.SelectorValue
	}
	effect := map[string]string{EffectAllow: "erlaubt", EffectDeny: "sperrt"}[r.Effect]
	act := map[string]string{ActionSee: "Sehen", ActionRoute: "Schalten"}[r.Action]
	kind := map[string]string{KindSource: "Quellen", KindSink: "Senken"}[r.Kind]
	return fmt.Sprintf("%s: %s %s von %s (%s)", who, effect, act, kind, what)
}

// Policy ist die für einen Nutzer geltende Regelmenge (seine eigenen, die seiner Gruppen und die globalen).
type Policy struct {
	rules []Rule
}

// NewPolicy baut eine Policy aus den für den Nutzer geltenden Regeln.
func NewPolicy(applicable []Rule) *Policy { return &Policy{rules: applicable} }

// Empty: keine Regel gilt — alles offen.
func (p *Policy) Empty() bool { return p == nil || len(p.rules) == 0 }

// Decision ist das Ergebnis einer Auswertung mit Begründung.
type Decision struct {
	Allowed bool   `json:"allowed"`
	Reason  string `json:"reason"`
}

func (p *Policy) decide(kind, action string, ep Endpoint) Decision {
	if p == nil {
		return Decision{true, "keine Einschränkung"}
	}
	hasAllow := false
	var matchedAllow bool
	for _, r := range p.rules {
		if r.Kind != kind || r.Action != action {
			continue
		}
		hit := r.Matches(ep)
		if r.Effect == EffectDeny && hit {
			return Decision{false, "gesperrt durch " + r.Describe()}
		}
		if r.Effect == EffectAllow {
			hasAllow = true
			if hit {
				matchedAllow = true
			}
		}
	}
	if hasAllow && !matchedAllow {
		return Decision{false, "nicht in der Freigabeliste"}
	}
	if hasAllow {
		return Decision{true, "in der Freigabeliste"}
	}
	return Decision{true, "keine Einschränkung"}
}

// Visible: darf der Nutzer die Quelle/Senke sehen?
func (p *Policy) Visible(kind string, ep Endpoint) Decision { return p.decide(kind, ActionSee, ep) }

// Routable: darf er sie schalten? Setzt Sehen voraus.
func (p *Policy) Routable(kind string, ep Endpoint) Decision {
	if v := p.Visible(kind, ep); !v.Allowed {
		return v
	}
	return p.decide(kind, ActionRoute, ep)
}
