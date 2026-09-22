// Package statemachine validiert benannte Zustandsübergänge anhand einer
// festen Liste erlaubter (from, to)-Paare — kein Rahmenwerk, nur die eine
// wiederkehrende Prüfung "ist dieser Übergang erlaubt".
//
// Entstanden aus Kapitel 21 Phase 1 (UMSETZUNG.md §6b, B8): sowohl der
// Asset-Lifecycle (internal/asset) als auch der Prozess-/Schritt-
// Ausführungszustand (internal/process) brauchen dieselbe Semantik
// ("Transitions sollen validiert und auditierbar sein", B8 wörtlich:
// "nicht als verstreute if/else-Statements") — echte Zweitnutzung
// rechtfertigt die gemeinsame Abstraktion, keine spekulative
// Vorab-Verallgemeinerung (§ Grundprinzipien "keine Abstraktion ohne
// echten zweiten Aufrufer").
package statemachine

import (
	"errors"
	"fmt"
)

// ErrInvalidTransition wird von Validate zurückgegeben, wenn der Übergang
// nicht in der Erlaubt-Liste steht.
var ErrInvalidTransition = errors.New("statemachine: invalid transition")

// Machine hält eine feste Erlaubt-Liste von (from, to)-Zustandsübergängen.
// Ein Zustand ohne jeden ausgehenden Eintrag ist ein Endzustand.
type Machine struct {
	allowed map[string]map[string]struct{}
}

// New baut eine Machine aus einer expliziten Liste erlaubter Übergänge —
// bewusst als flache [from, to]-Paar-Liste (kein verschachteltes
// Konfigurationsformat), damit der komplette Zustandsgraph an einer
// Stelle im aufrufenden Paket lesbar bleibt (Domain-Doku, kein
// generisches State-Machine-DSL).
func New(pairs [][2]string) *Machine {
	m := &Machine{allowed: make(map[string]map[string]struct{}, len(pairs))}
	for _, p := range pairs {
		from, to := p[0], p[1]
		if m.allowed[from] == nil {
			m.allowed[from] = make(map[string]struct{})
		}
		m.allowed[from][to] = struct{}{}
	}
	return m
}

// Allowed meldet, ob der Übergang from->to in der Erlaubt-Liste steht.
func (m *Machine) Allowed(from, to string) bool {
	_, ok := m.allowed[from][to]
	return ok
}

// Validate liefert nil, wenn der Übergang erlaubt ist, sonst
// ErrInvalidTransition (per errors.Is prüfbar, mit from/to im Text für
// Log-/Fehlerausgaben).
func (m *Machine) Validate(from, to string) error {
	if m.Allowed(from, to) {
		return nil
	}
	return fmt.Errorf("%w: %s -> %s", ErrInvalidTransition, from, to)
}

// IsTerminal meldet, ob state kein einziges erlaubtes Ziel hat (Endzustand
// — z. B. COMPLETED/CANCELLED/DELETED, je nach Domäne).
func (m *Machine) IsTerminal(state string) bool {
	return len(m.allowed[state]) == 0
}
