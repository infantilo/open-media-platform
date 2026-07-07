// Package descriptor implementiert das Self-Describe-HTTP-API des
// Mock-Nodes: GET /descriptor.json beschreibt die verfügbaren Parameter
// und Methoden (Format siehe docs/descriptor-v0.schema.json),
// GET/PATCH /params/<name> liest bzw. ändert einen Parameterwert,
// POST /methods/<name> ruft eine Methode auf.
package descriptor

import (
	"encoding/json"
	"log/slog"
	"maps"
	"net/http"
	"sync"
)

// Range ist der Wertebereich eines Parameters: entweder Min/Max (Zahlen)
// oder Values (enum) — siehe docs/descriptor-v0.schema.json.
type Range struct {
	Min    *float64 `json:"min,omitempty"`
	Max    *float64 `json:"max,omitempty"`
	Values []string `json:"values,omitempty"`
}

// ParamSpec beschreibt einen einzelnen Parameter im Descriptor.
type ParamSpec struct {
	Name     string  `json:"name"`
	Type     string  `json:"type"`
	Unit     *string `json:"unit"`
	Range    *Range  `json:"range"`
	ReadOnly bool    `json:"readonly"`
}

// MethodArg beschreibt ein Argument einer Methode.
type MethodArg struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// MethodSpec beschreibt eine Methode im Descriptor.
type MethodSpec struct {
	Name string      `json:"name"`
	Args []MethodArg `json:"args"`
}

// Descriptor ist der Body von GET /descriptor.json.
type Descriptor struct {
	Parameters []ParamSpec  `json:"parameters"`
	Methods    []MethodSpec `json:"methods"`
}

// Store hält die aktuellen Parameterwerte des Mock-Nodes und die
// verfügbaren Methoden; nebenläufig sicher nutzbar.
type Store struct {
	mu       sync.RWMutex
	specs    []ParamSpec
	values   map[string]any
	defaults map[string]any
	methods  []MethodSpec
	actions  map[string]func()
}

func floatPtr(f float64) *float64 { return &f }
func strPtr(s string) *string     { return &s }

// NewStore erstellt einen Store mit den Beispiel-Parametern "label"
// (string) und "gain" (number, dB) sowie der Methode "reset" (UMSETZUNG.md
// A8), die beide Parameter auf ihren Ausgangswert zurücksetzt.
func NewStore(initialLabel string) *Store {
	s := &Store{
		specs: []ParamSpec{
			{Name: "label", Type: "string", ReadOnly: false},
			{Name: "gain", Type: "number", Unit: strPtr("dB"), Range: &Range{Min: floatPtr(-96), Max: floatPtr(12)}, ReadOnly: false},
		},
		defaults: map[string]any{"label": initialLabel, "gain": 0.0},
		methods:  []MethodSpec{{Name: "reset", Args: []MethodArg{}}},
	}
	s.values = maps.Clone(s.defaults)
	s.actions = map[string]func(){
		"reset": s.reset,
	}
	return s
}

func (s *Store) reset() {
	s.values = maps.Clone(s.defaults)
	slog.Info("mock node: reset() invoked", "values", s.values)
}

// Descriptor liefert die aktuelle Selbstbeschreibung.
func (s *Store) Descriptor() Descriptor {
	return Descriptor{Parameters: s.specs, Methods: s.methods}
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
			slog.Info("mock node: parameter changed", "name", name, "value", value)
			return true
		}
	}
	return false
}

// Invoke ruft eine bekannte Methode auf. Liefert false, wenn die Methode
// unbekannt ist.
func (s *Store) Invoke(name string) bool {
	s.mu.Lock()
	action, ok := s.actions[name]
	s.mu.Unlock()
	if !ok {
		return false
	}
	action()
	return true
}

// Handler baut den HTTP-Handler für /descriptor.json, /params/<name> und
// /methods/<name>.
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

	mux.HandleFunc("POST /methods/{name}", func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		if !store.Invoke(name) {
			http.Error(w, "unknown method", http.StatusNotFound)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})

	return mux
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
