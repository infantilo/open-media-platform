// Package state persistiert die Host-ID, die der Orchestrator bei der
// Erstregistrierung vergeben hat (ARCHITECTURE.md §18.3), lokal auf dem
// Host-Agent-Rechner — ein Neustart des Agent-Prozesses registriert sich
// nicht erneut (das Bootstrap-Token ist ohnehin nach der ersten
// Registrierung verbraucht, s. host_bootstrap_tokens.used_at), sondern
// nimmt die Telemetrie unter derselben Host-ID wieder auf.
package state

import (
	"encoding/json"
	"errors"
	"os"
)

// State ist der lokal gespeicherte Registrierungszustand.
type State struct {
	HostID string `json:"hostId"`
	Label  string `json:"label"`
}

// Load liest den Zustand aus path (ok=false, wenn die Datei fehlt — noch
// nicht registriert).
func Load(path string) (State, bool, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return State{}, false, nil
	}
	if err != nil {
		return State{}, false, err
	}
	var s State
	if err := json.Unmarshal(data, &s); err != nil {
		return State{}, false, err
	}
	return s, true, nil
}

// Save schreibt s nach path (0600 — enthält keine Geheimnisse, aber
// gleiche restriktive Berechtigung wie auth.LoadOrCreateSecret im
// Orchestrator, konsistente Konvention für lokale State-Dateien).
func Save(path string, s State) error {
	data, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}
