// Package descriptor implementiert das Self-Describe-HTTP-API des
// Mock-Nodes: GET /descriptor.json beschreibt die verfügbaren Parameter,
// GET/PATCH /params/<name> liest bzw. ändert ihren Wert. Format ist
// bewusst minimal gehalten (nur "label", schreibbar) — Schema-
// Formalisierung und Methoden (z. B. reset()) kommen in Schritt A8
// (UMSETZUNG.md).
package descriptor

import (
	"encoding/json"
	"net/http"
	"sync"
)

// ParamSpec beschreibt einen einzelnen Parameter im Descriptor.
type ParamSpec struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	ReadOnly bool   `json:"readonly"`
}

// Descriptor ist der Body von GET /descriptor.json.
type Descriptor struct {
	Parameters []ParamSpec `json:"parameters"`
	Methods    []string    `json:"methods"`
}

// Store hält die aktuellen Parameterwerte des Mock-Nodes und ist
// nebenläufig sicher nutzbar.
type Store struct {
	mu     sync.RWMutex
	specs  []ParamSpec
	values map[string]any
}

// NewStore erstellt einen Store mit dem einzigen für A7 vorgesehenen
// Parameter "label".
func NewStore(initialLabel string) *Store {
	return &Store{
		specs:  []ParamSpec{{Name: "label", Type: "string", ReadOnly: false}},
		values: map[string]any{"label": initialLabel},
	}
}

// Descriptor liefert die aktuelle Selbstbeschreibung.
func (s *Store) Descriptor() Descriptor {
	return Descriptor{Parameters: s.specs, Methods: []string{}}
}

// Get liefert den aktuellen Wert eines Parameters.
func (s *Store) Get(name string) (any, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	v, ok := s.values[name]
	return v, ok
}

// Set setzt den Wert eines bekannten, nicht schreibgeschützten Parameters.
// Liefert false, wenn der Parameter unbekannt oder readonly ist.
func (s *Store) Set(name string, value any) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, spec := range s.specs {
		if spec.Name == name {
			if spec.ReadOnly {
				return false
			}
			s.values[name] = value
			return true
		}
	}
	return false
}

// Handler baut den HTTP-Handler für /descriptor.json und /params/<name>.
func Handler(store *Store) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /descriptor.json", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, store.Descriptor())
	})

	mux.HandleFunc("GET /params/{name}", func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		value, ok := store.Get(name)
		if !ok {
			http.Error(w, "unknown parameter", http.StatusNotFound)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"value": value})
	})

	mux.HandleFunc("PATCH /params/{name}", func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")

		var body struct {
			Value any `json:"value"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}

		if !store.Set(name, body.Value) {
			http.Error(w, "unknown or readonly parameter", http.StatusNotFound)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"value": body.Value})
	})

	return mux
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
