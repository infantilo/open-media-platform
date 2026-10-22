package extsvc

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// Verträge (UMSETZUNG.md Kapitel 49): Ein Diensttyp (`Manifest.Kind`, z. B. „intercom“) ist eine **herstellerunabhängige**
// Schnittstelle, nicht ein bestimmtes Produkt. Jede Implementierung — unsere oder die einer anderen Firma — meldet im
// Manifest dieselben **Rollen** (`RouteDef.Role`); Plattform-Teile wie das Stream Deck suchen den Dienst über Typ und Rolle,
// nie über einen Produktnamen. Die Beschreibung der Verträge steht in `docs/CONTRACT-*.md`.

// RoleSpec beschreibt eine Rolle eines Vertrags.
type RoleSpec struct {
	Method string
	// Params: Anzahl der Pfad-Platzhalter (`{x}`), die die Route haben muss.
	Params   int
	Required bool
}

// Contract: Diensttyp → Rollen.
type Contract map[string]RoleSpec

// Contracts sind die bekannten Diensttypen. Ein Manifest mit unbekanntem `Kind` ist erlaubt (Dienst ohne Vertrag), eines mit
// bekanntem muss den Vertrag erfüllen.
var Contracts = map[string]Contract{
	// Intercom: Sprechstellen-Panels, Betriebsstatus und (optional) Fernbedienung einer Sprechstelle (Stream Deck).
	"intercom": {
		"panels":       {Method: "GET", Params: 0, Required: true},
		"status":       {Method: "GET", Params: 0, Required: true},
		"deck.state":   {Method: "GET", Params: 1},
		"deck.command": {Method: "POST", Params: 1},
		// Gäste (Kapitel 50, z. B. Handy-Kamera): Kanäle zur Auswahl, befristeten Zugang ausstellen/widerrufen.
		"channels":     {Method: "GET", Params: 0},
		"guest.create": {Method: "POST", Params: 0},
		"guest.revoke": {Method: "DELETE", Params: 1},
	},
}

func placeholders(path string) int {
	n := 0
	for _, seg := range strings.Split(strings.Trim(path, "/"), "/") {
		if strings.HasPrefix(seg, "{") && strings.HasSuffix(seg, "}") {
			n++
		}
	}
	return n
}

// CheckContract prüft, ob das Manifest den Vertrag seines Typs erfüllt (Pflichtrollen vorhanden, Methoden und Platzhalter
// passend, keine unbekannten Rollen, jede Rolle höchstens einmal).
func (m Manifest) CheckContract() error {
	for _, r := range m.Routes {
		if r.Role != "" && m.Kind == "" {
			return fmt.Errorf("Route %s %s hat eine Rolle, das Manifest aber keinen Typ", r.Method, r.Path)
		}
	}
	if m.Kind == "" {
		return nil
	}
	c, known := Contracts[m.Kind]
	if !known {
		return nil
	}
	seen := map[string]bool{}
	for _, r := range m.Routes {
		if r.Role == "" {
			continue
		}
		spec, ok := c[r.Role]
		if !ok {
			return fmt.Errorf("Rolle %q gehört nicht zum Vertrag %q", r.Role, m.Kind)
		}
		if seen[r.Role] {
			return fmt.Errorf("Rolle %q doppelt", r.Role)
		}
		seen[r.Role] = true
		if r.Method != spec.Method {
			return fmt.Errorf("Rolle %q verlangt %s, ist %s", r.Role, spec.Method, r.Method)
		}
		if placeholders(r.Path) != spec.Params {
			return fmt.Errorf("Rolle %q verlangt %d Pfad-Platzhalter, Route %s hat %d", r.Role, spec.Params, r.Path, placeholders(r.Path))
		}
	}
	var missing []string
	for role, spec := range c {
		if spec.Required && !seen[role] {
			missing = append(missing, role)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		return fmt.Errorf("Vertrag %q: Pflichtrollen fehlen: %s", m.Kind, strings.Join(missing, ", "))
	}
	return nil
}

// CheckShape prüft die Antwort einer Rolle gegen die im Vertrag beschriebene Form (nur die Pflichtfelder; zusätzliche
// Felder sind erlaubt). Für Typen oder Rollen ohne Formvorgabe: nil.
func CheckShape(kind, role string, body []byte) error {
	var v map[string]any
	if err := json.Unmarshal(body, &v); err != nil {
		return fmt.Errorf("keine JSON-Objekt-Antwort: %w", err)
	}
	need := func(obj map[string]any, where string, keys ...string) error {
		for _, k := range keys {
			if _, ok := obj[k]; !ok {
				return fmt.Errorf("%s: Feld %q fehlt", where, k)
			}
		}
		return nil
	}
	if kind != "intercom" {
		return nil
	}
	switch role {
	case "panels":
		list, ok := v["panels"].([]any)
		if !ok {
			return fmt.Errorf("Feld \"panels\" (Liste) fehlt")
		}
		for i, e := range list {
			o, _ := e.(map[string]any)
			if err := need(o, fmt.Sprintf("panels[%d]", i), "party_id", "name", "url"); err != nil {
				return err
			}
		}
	case "status":
		list, ok := v["parties"].([]any)
		if !ok {
			return fmt.Errorf("Feld \"parties\" (Liste) fehlt")
		}
		for i, e := range list {
			o, _ := e.(map[string]any)
			if err := need(o, fmt.Sprintf("parties[%d]", i), "id", "name", "online"); err != nil {
				return err
			}
		}
	case "channels":
		list, ok := v["channels"].([]any)
		if !ok {
			return fmt.Errorf("Feld \"channels\" (Liste) fehlt")
		}
		for i, e := range list {
			o, _ := e.(map[string]any)
			if err := need(o, fmt.Sprintf("channels[%d]", i), "id", "name"); err != nil {
				return err
			}
		}
	case "guest.create":
		return need(v, "Gast", "id", "url", "expires")
	case "deck.state":
		if err := need(v, "Zustand", "me", "channels", "parties"); err != nil {
			return err
		}
		me, _ := v["me"].(map[string]any)
		return need(me, "me", "id", "muted", "forced")
	}
	return nil
}
