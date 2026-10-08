package workflows

// Erweiterungspunkte für Module (UMSETZUNG.md Kapitel 36.5): `workflows` kennt keine Sende-Fachlichkeit. Ein Modul meldet
// stattdessen (a) Node-Typen an, die als Control-Plane-Instanz eines Workflows gelten, und (b) Hooks, die die Start-Umgebung
// einer Rolle ergänzen (z. B. die Automations-Ziele der Playout-Automation).

// RoleEnvHook liefert zusätzliche Start-Umgebung für eine Rolle (nil = nichts). Er darf `def`/`role` nicht verändern.
type RoleEnvHook func(def Definition, role Role) map[string]string

// RegisterRoleEnvHook fügt einen Hook hinzu (vor dem ersten Workflow-Start aufrufen). Hooks laufen in der
// Registrierungsreihenfolge; ausdrücklich gesetzte Werte der Rolle/des Workflows gewinnen immer gegen Hook-Werte, und bei
// widersprüchlichen Hooks gewinnt der frühere.
func (s *Service) RegisterRoleEnvHook(h RoleEnvHook) {
	s.extMu.Lock()
	defer s.extMu.Unlock()
	s.envHooks = append(s.envHooks, h)
}

// RegisterControlPlaneType meldet einen Node-Typ als Control-Plane-Node an: seine Instanz bekommt bei Workflow-Start
// automatisch eine Workflow-gescopte VerbOperate-Rollenbindung (ARCHITECTURE.md §24.1) und kann sich per Service-Token am
// generischen Proxy anmelden.
func (s *Service) RegisterControlPlaneType(nodeType string) {
	s.extMu.Lock()
	defer s.extMu.Unlock()
	if s.controlPlane == nil {
		s.controlPlane = map[string]bool{}
	}
	s.controlPlane[nodeType] = true
}

// IsControlPlaneNodeType meldet, ob nodeType als Control-Plane-Node angemeldet ist — auch für den manuellen Katalogstart
// (httpapi.handlePostInstance, kein Workflow-Kontext), damit die Liste nur einmal gepflegt wird.
func (s *Service) IsControlPlaneNodeType(nodeType string) bool {
	s.extMu.RLock()
	defer s.extMu.RUnlock()
	return s.controlPlane[nodeType]
}

// withRoleHooks ergänzt `base` um die Werte der Hooks (neue Map, `base` bleibt unverändert; Werte in `base` gewinnen).
func (s *Service) withRoleHooks(base map[string]string, def Definition, role Role) map[string]string {
	s.extMu.RLock()
	hooks := append([]RoleEnvHook(nil), s.envHooks...)
	s.extMu.RUnlock()
	var add map[string]string
	for _, h := range hooks {
		for k, v := range h(def, role) {
			if add == nil {
				add = map[string]string{}
			}
			if _, taken := add[k]; !taken {
				add[k] = v
			}
		}
	}
	if add == nil {
		return base
	}
	merged := make(map[string]string, len(base)+len(add))
	for k, v := range add {
		merged[k] = v
	}
	for k, v := range base {
		merged[k] = v
	}
	return merged
}
