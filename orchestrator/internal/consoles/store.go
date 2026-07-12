// Package consoles löst Rollenbindungen zu Konsolen-Einträgen auf
// (ARCHITECTURE.md §14, UMSETZUNG.md C13): eine bewusst vereinfachte
// Rollen-Stub-Prüfung, da das eigentliche §12-Nutzer-/Rollenmodell erst
// mit D3 (Auth) entsteht ("echte Durchsetzung folgt mit D3" laut
// UMSETZUNG.md C13). Bindungen liegen handgepflegt als JSON-Datei vor,
// analog zu deploy/catalog.json — keine CRUD-UI, das ist Community-/
// D3-Scope, nicht Teil dieses Schritts.
package consoles

import (
	"encoding/json"
	"errors"
	"os"
)

// Verb ist die Wirkungsart einer Rollenbindung (ARCHITECTURE.md §12
// Punkt 1: Tripel Rolle/Wirkungsbereich/Verb — hier nur der Verb-Teil,
// Wirkungsbereich ist NodeID/"*").
type Verb string

const (
	VerbOperate   Verb = "operate"
	VerbConfigure Verb = "configure"
	VerbAdmin     Verb = "admin"
)

// Binding bindet einen Stub-Nutzer an einen Node (per stabiler
// Instanz-ID, s. resolve.go) oder an "*" (alle Nodes) mit einem Verb.
type Binding struct {
	UserID string `json:"userId"`
	NodeID string `json:"nodeId"`
	Verb   Verb   `json:"verb"`
}

// Store liest Rollenbindungen aus einer einzelnen JSON-Datei (nicht,
// wie layouts/snapshots, mehrere benannte Blobs — es gibt nur eine
// Bindungsliste).
type Store struct {
	path string
}

// NewStore erstellt einen Store, der Bindungen aus path liest.
func NewStore(path string) *Store {
	return &Store{path: path}
}

// Load liefert alle Bindungen. Eine fehlende Datei ist kein Fehler
// (leeres Bindungs-Set) — der Stub soll auch ohne vorbereitete Datei
// starten, analog zu launcher.LoadCatalog bei fehlendem Katalog.
func (s *Store) Load() ([]Binding, error) {
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var bindings []Binding
	if err := json.Unmarshal(data, &bindings); err != nil {
		return nil, err
	}
	return bindings, nil
}
