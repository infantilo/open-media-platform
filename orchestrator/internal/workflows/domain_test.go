package workflows

import (
	"errors"
	"testing"
)

type fakeDomains map[string]bool

func (f fakeDomains) Resolve(n string) (string, error) {
	if f[n] {
		return "/dev/shm/omp-mxl-" + n, nil
	}
	return "", errors.New("unbekannt")
}

func defWith(settingsDomain string, roles ...Role) Definition {
	return Definition{Settings: Settings{Domain: settingsDomain}, Roles: roles}
}

func TestEffectiveDomainAndEnv(t *testing.T) {
	def := defWith("studio", Role{Name: "a", NodeType: "omp-source"}, Role{Name: "b", NodeType: "omp-viewer", Domain: "test"}, Role{Name: "c", NodeType: "omp-viewer", Domain: "default"})
	if got := effectiveDomain(def, def.Roles[0]); got != "studio" {
		t.Errorf("Workflow-Domain: %q", got)
	}
	if got := effectiveDomain(def, def.Roles[1]); got != "test" {
		t.Errorf("Rollen-Überschreibung: %q", got)
	}
	if got := effectiveDomain(def, def.Roles[2]); got != "" {
		t.Errorf("default in der Rolle hebt die Workflow-Domain auf: %q", got)
	}
	base := map[string]string{"X": "1"}
	env := withRoleDomain(base, def, def.Roles[0])
	if env["OMP_MXL_DOMAIN_NAME"] != "studio" || env["X"] != "1" {
		t.Errorf("env = %v", env)
	}
	if _, has := base["OMP_MXL_DOMAIN_NAME"]; has {
		t.Error("die übergebene Map darf nicht verändert werden")
	}
	if env := withRoleDomain(base, def, def.Roles[2]); len(env) != 1 {
		t.Errorf("Standarddomain: kein Zusatz, env = %v", env)
	}
	if env := withRoleDomain(nil, defWith(""), Role{Name: "x"}); env != nil {
		t.Errorf("nil bleibt nil: %v", env)
	}
}

func TestValidateDomainNames(t *testing.T) {
	if err := validateDomainNames(defWith("ok-1", Role{Name: "a", Domain: "test"})); err != nil {
		t.Errorf("gültig: %v", err)
	}
	for _, bad := range []string{"Test", "../x", "a b", "a--b"} {
		if err := validateDomainNames(defWith(bad, Role{Name: "a"})); !errors.Is(err, ErrValidation) {
			t.Errorf("Settings %q: %v", bad, err)
		}
		if err := validateDomainNames(defWith("", Role{Name: "a", Domain: bad})); !errors.Is(err, ErrValidation) {
			t.Errorf("Rolle %q: %v", bad, err)
		}
	}
}

func TestCheckDomains(t *testing.T) {
	s := &Service{}
	if err := s.checkDomains(defWith("", Role{Name: "a"})); err != nil {
		t.Errorf("ohne Domain muss alles beim Alten bleiben: %v", err)
	}
	if err := s.checkDomains(defWith("test", Role{Name: "a"})); !errors.Is(err, ErrValidation) {
		t.Errorf("Domain ohne Verwaltung: %v", err)
	}
	s.SetDomains(fakeDomains{"test": true})
	if err := s.checkDomains(defWith("test", Role{Name: "a"})); err != nil {
		t.Errorf("bekannte Domain: %v", err)
	}
	if err := s.checkDomains(defWith("", Role{Name: "a", Domain: "weg"})); !errors.Is(err, ErrValidation) {
		t.Errorf("unbekannte Domain: %v", err)
	}
}

func TestCheckDomainLinks(t *testing.T) {
	roles := []Role{{Name: "src", NodeType: "omp-source", Domain: "a"}, {Name: "mix", NodeType: "omp-video-mixer-me", Domain: "b"}, {Name: "br", NodeType: "omp-mxl-bridge", Domain: "a", TargetDomain: "b"}}
	def := Definition{Roles: roles, Connections: []Connection{{FromRole: "src", ToRole: "mix"}}}
	if err := checkDomainLinks(def); !errors.Is(err, ErrValidation) {
		t.Errorf("a → b ohne Brücke muss abgelehnt werden: %v", err)
	}
	def.Connections = []Connection{{FromRole: "src", ToRole: "br"}, {FromRole: "br", ToRole: "mix"}}
	if err := checkDomainLinks(def); err != nil {
		t.Errorf("über die Brücke: %v", err)
	}
	def.Connections = []Connection{{FromRole: "src", ToRole: "src"}}
	if err := checkDomainLinks(def); err != nil {
		t.Errorf("gleiche Domain: %v", err)
	}
}

func TestBridgeEnvAndTargetCheck(t *testing.T) {
	def := Definition{Roles: []Role{{Name: "br", NodeType: "omp-mxl-bridge", Domain: "a", TargetDomain: "b"}}}
	env := withRoleDomain(nil, def, def.Roles[0])
	if env["OMP_MXL_DOMAIN_NAME"] != "a" || env["OMP_MXL_TARGET_DOMAIN_NAME"] != "b" {
		t.Errorf("env = %v", env)
	}
	// Ziel nur bei Brücken
	other := Definition{Roles: []Role{{Name: "x", NodeType: "omp-source", Domain: "a", TargetDomain: "b"}}}
	if env := withRoleDomain(nil, other, other.Roles[0]); env["OMP_MXL_TARGET_DOMAIN_NAME"] != "" {
		t.Errorf("Ziel nur für Brücken: %v", env)
	}
	s := &Service{}
	s.SetDomains(fakeDomains{"a": true, "b": true})
	if err := s.checkDomains(def); err != nil {
		t.Errorf("gültige Brücke: %v", err)
	}
	noTarget := Definition{Roles: []Role{{Name: "br", NodeType: "omp-mxl-bridge", Domain: "a"}}}
	if err := s.checkDomains(noTarget); !errors.Is(err, ErrValidation) {
		t.Errorf("Brücke ohne Ziel: %v", err)
	}
	unknown := Definition{Roles: []Role{{Name: "br", NodeType: "omp-mxl-bridge", Domain: "a", TargetDomain: "weg"}}}
	if err := s.checkDomains(unknown); !errors.Is(err, ErrValidation) {
		t.Errorf("unbekanntes Ziel: %v", err)
	}
	toDefault := Definition{Roles: []Role{{Name: "br", NodeType: "omp-mxl-bridge", Domain: "a", TargetDomain: "default"}}}
	if err := s.checkDomains(toDefault); err != nil {
		t.Errorf("Ziel Standarddomain: %v", err)
	}
}
