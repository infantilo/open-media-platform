package workflows

import (
	"fmt"

	"github.com/infantilo/openmediaplatform/podmanrun"
)

// Getrennte MXL-Domains (Kap. 103, docs/ENTWURF-MXL-DOMAIN-TRENNUNG.md D3): Settings.Domain gilt für alle Rollen des
// Workflows, Role.Domain überschreibt sie je Rolle. Leer/"default" = Standarddomain (unverändertes Verhalten). Der
// Domainname reist als extraEnv (podmanrun.DomainNameKey); den Pfad leitet der Ort ab, an dem die Instanz läuft
// (Orchestrator-Rechner, Host-Agent, Container) — Umzug, Hot-Standby und Host-Ausfall behalten die Domain, weil sie
// dieselbe Rollenumgebung neu aufbauen.

// DomainResolver sagt, ob eine benannte Domain angelegt ist (implementiert von *mxldomains.Store).
type DomainResolver interface {
	Resolve(name string) (string, error)
}

// SandboxChecker: optional — sagt, ob eine Domain abgeschottet ist (D7); *mxldomains.Store kann es.
type SandboxChecker interface {
	Isolated(name string) bool
}

// SetDomains verdrahtet die Domain-Verwaltung nachträglich (nil = Domains nicht eingeschaltet).
func (s *Service) SetDomains(d DomainResolver) { s.domains = d }

// effectiveDomain: die Domain einer Rolle ("" = Standard).
func effectiveDomain(def Definition, role Role) string {
	d := role.Domain
	if d == "" {
		d = def.Settings.Domain
	}
	if d == "default" {
		return ""
	}
	return d
}

// withRoleDomain ergänzt die Rollenumgebung um die Domain; die übergebene Map bleibt unverändert.
func (s *Service) withRoleDomain(env map[string]string, def Definition, role Role) map[string]string {
	d := effectiveDomain(def, role)
	target := ""
	if isBridgeType(role.NodeType) && role.TargetDomain != "" && role.TargetDomain != "default" {
		target = role.TargetDomain
	}
	if d == "" && target == "" {
		return env
	}
	out := make(map[string]string, len(env)+2)
	for k, v := range env {
		out[k] = v
	}
	if d != "" {
		out[podmanrun.DomainNameKey] = d
	}
	if target != "" {
		out[podmanrun.TargetDomainNameKey] = target
	}
	// Abgeschottete Domain (eigene oder Ziel): die Rolle startet in der Mount-Sandbox.
	if sc, ok := s.domains.(SandboxChecker); ok && ((d != "" && sc.Isolated(d)) || (target != "" && sc.Isolated(target))) {
		out[podmanrun.SandboxKey] = "1"
	}
	return out
}

// validateDomainNames prüft nur die Schreibweise (beim Speichern); ob die Domain existiert, prüft checkDomains beim Start.
func validateDomainNames(def Definition) error {
	check := func(where, d string) error {
		if d == "" || d == "default" || podmanrun.ValidDomainName(d) {
			return nil
		}
		return fmt.Errorf("%w: %s: ungültiger MXL-Domainname %q", ErrValidation, where, d)
	}
	if err := check("settings", def.Settings.Domain); err != nil {
		return err
	}
	for _, r := range def.Roles {
		if err := check("role "+r.Name, r.Domain); err != nil {
			return err
		}
		if err := check("role "+r.Name+" targetDomain", r.TargetDomain); err != nil {
			return err
		}
	}
	return nil
}

// checkDomainLinks: eine Verbindung des Workflows darf nicht über eine Domain-Grenze laufen — Flows sind nur innerhalb
// einer Domain lesbar, die Kante bliebe still ohne Bild. Eine Brücke (omp-mxl-bridge) liegt in der Domain ihres
// Eingangs und schreibt in `TargetDomain` — so verbindet sie zwei Domains, und beide Kanten werden regulär geprüft.
func checkDomainLinks(def Definition) error {
	role := map[string]Role{}
	for _, r := range def.Roles {
		role[r.Name] = r
	}
	for _, c := range def.Connections {
		from, ok1 := role[c.FromRole]
		to, ok2 := role[c.ToRole]
		if !ok1 || !ok2 {
			continue
		}
		a, b := outDomain(def, from), effectiveDomain(def, to) // Ausgang der Quelle → Eingang des Ziels
		if a == b {
			continue
		}
		return fmt.Errorf("%w: Verbindung %s → %s läuft über eine MXL-Domain-Grenze (%s → %s); dafür ist eine Brücke nötig",
			ErrValidation, c.FromRole, c.ToRole, domainLabel(a), domainLabel(b))
	}
	return nil
}

// outDomain: Domain, in die eine Rolle schreibt — für eine Brücke ihre Zieldomain, sonst die eigene.
func outDomain(def Definition, role Role) string {
	if isBridgeType(role.NodeType) {
		t := role.TargetDomain
		if t == "default" {
			t = ""
		}
		return t
	}
	return effectiveDomain(def, role)
}

func domainLabel(d string) string {
	if d == "" {
		return "default"
	}
	return d
}

// isBridgeType: Node-Typen, die absichtlich zwei Domains verbinden.
func isBridgeType(nodeType string) bool { return nodeType == "omp-mxl-bridge" }

// checkDomains: jede genutzte Domain muss angelegt sein — sonst Startabbruch VOR dem ersten Node (ErrValidation).
func (s *Service) checkDomains(def Definition) error {
	for _, r := range def.Roles {
		if isBridgeType(r.NodeType) {
			t := r.TargetDomain
			if t == "" || t == "default" {
				// Zieldomain "default" ist erlaubt (Brücke von einer benannten in die Standarddomain), leer nicht.
				if t == "" {
					return fmt.Errorf("%w: Brücke %q braucht eine Zieldomain (targetDomain)", ErrValidation, r.Name)
				}
			}
		}
	}
	if err := checkDomainLinks(def); err != nil {
		return err
	}
	seen := map[string]bool{}
	need := func(d, role string) error {
		if d == "" || seen[d] {
			return nil
		}
		seen[d] = true
		if s.domains == nil {
			return fmt.Errorf("%w: MXL-Domain %q verlangt, aber die Domain-Verwaltung ist nicht eingeschaltet", ErrValidation, d)
		}
		if _, err := s.domains.Resolve(d); err != nil {
			return fmt.Errorf("%w: MXL-Domain %q (Rolle %q) ist nicht angelegt", ErrValidation, d, role)
		}
		return nil
	}
	for _, r := range def.Roles {
		if err := need(effectiveDomain(def, r), r.Name); err != nil {
			return err
		}
		if isBridgeType(r.NodeType) && r.TargetDomain != "default" {
			if err := need(r.TargetDomain, r.Name); err != nil {
				return err
			}
		}
	}
	return nil
}
