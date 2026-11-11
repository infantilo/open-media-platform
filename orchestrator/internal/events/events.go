// Package events ist der dynamische Ereigniskatalog des Orchestrators. Jede Quelle (Kern, Module) meldet ihre Ereignisarten mit
// Register an und veröffentlicht mit Emit; zusätzlich merkt sich der Katalog jedes tatsächlich auf dem Bus gesehene Subject
// (Observe), sodass auch künftige, noch nicht angemeldete Ereignisse als Auslöser für Prozesse wählbar sind. Alarme sind
// ebenfalls Ereignisse (omp.alarm.<Art>, siehe alertsink.Sink.OnAlert) — jede angemeldete Alarmart erscheint automatisch.
package events

import (
	"encoding/json"
	"log/slog"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Field beschreibt ein Feld der Nutzlast (wird im Prozess-Editor als input.<Pfad> angeboten).
type Field struct {
	Path  string `json:"path"`
	Label string `json:"label,omitempty"`
}

// Info beschreibt eine Ereignisart. Subject darf Platzhalter tragen (* = ein Teil, > = Rest), z. B. "omp.ingest.*.completed".
type Info struct {
	ID       string     `json:"id"`
	Subject  string     `json:"subject"`
	Group    string     `json:"group"`
	Label    string     `json:"label"`
	LabelEN  string     `json:"labelEn,omitempty"`
	Fields   []Field    `json:"fields,omitempty"`
	Observed bool       `json:"observed,omitempty"` // nur auf dem Bus gesehen, nicht angemeldet
	Count    int64      `json:"count,omitempty"`    // nur bei beobachteten Arten
	LastSeen *time.Time `json:"lastSeen,omitempty"`
}

// Publisher ist der Teil des NATS-Clients, den Emit braucht.
type Publisher interface {
	Publish(subject string, data []byte) error
}

const maxObserved = 1000

var (
	mu        sync.RWMutex
	registry  []Info
	observed  = map[string]*Info{}
	publisher Publisher
	// Beobachtet werden nur Subjects, die dem Namensschema entsprechen.
	idLike = regexp.MustCompile(`^([0-9a-f]{8,}(-[0-9a-f]{4,})*|[0-9]+|[a-z0-9]*[0-9][a-z0-9-]{7,})$`)
)

// SetPublisher legt den Bus fest (nil = Emit tut nichts).
func SetPublisher(p Publisher) {
	mu.Lock()
	publisher = p
	mu.Unlock()
}

// Register meldet eine Ereignisart an (erneutes Anmelden mit gleicher ID ersetzt sie).
func Register(i Info) {
	if i.ID == "" {
		i.ID = i.Subject
	}
	i.Observed = false
	mu.Lock()
	defer mu.Unlock()
	for k := range registry {
		if registry[k].ID == i.ID {
			registry[k] = i
			return
		}
	}
	registry = append(registry, i)
}

// Unregister nimmt eine Art zurück (z. B. Modul abgeschaltet).
func Unregister(id string) {
	mu.Lock()
	defer mu.Unlock()
	for k := range registry {
		if registry[k].ID == id {
			registry = append(registry[:k], registry[k+1:]...)
			return
		}
	}
}

// Emit veröffentlicht ein Ereignis (Nutzlast als JSON). Nie blockierend, nie fatal.
func Emit(subject string, payload any) {
	mu.RLock()
	p := publisher
	mu.RUnlock()
	if p == nil {
		return
	}
	b, err := json.Marshal(payload)
	if err != nil {
		slog.Warn("events: Nutzlast nicht serialisierbar", "subject", subject, "error", err)
		return
	}
	if err := p.Publish(subject, b); err != nil {
		slog.Warn("events: Veröffentlichen fehlgeschlagen", "subject", subject, "error", err)
	}
}

// Normalize ersetzt ID-artige Teile eines Subjects durch * (aus „omp.ingest.8f3c….completed“ wird „omp.ingest.*.completed“).
func Normalize(subject string) string {
	parts := strings.Split(subject, ".")
	for i, p := range parts {
		if i >= 2 && idLike.MatchString(p) {
			parts[i] = "*"
		}
	}
	return strings.Join(parts, ".")
}

// Observe vermerkt ein auf dem Bus gesehenes Subject. Angemeldete Arten (auch solche mit Platzhaltern) werden nicht doppelt geführt.
func Observe(subject string, payload []byte) {
	if !strings.HasPrefix(subject, "omp.") || strings.HasPrefix(subject, "_") {
		return
	}
	norm := Normalize(subject)
	mu.Lock()
	defer mu.Unlock()
	for _, r := range registry {
		if Covers(r.Subject, norm) || Covers(r.Subject, subject) {
			return
		}
	}
	now := time.Now().UTC()
	if o, ok := observed[norm]; ok {
		o.Count++
		o.LastSeen = &now
		return
	}
	if len(observed) >= maxObserved {
		return
	}
	var fields []Field
	var m map[string]any
	if json.Unmarshal(payload, &m) == nil {
		keys := make([]string, 0, len(m))
		for k := range m {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			fields = append(fields, Field{Path: k})
		}
	}
	observed[norm] = &Info{ID: norm, Subject: norm, Group: "bus", Label: norm, Fields: fields, Observed: true, Count: 1, LastSeen: &now}
}

// List liefert angemeldete und beobachtete Arten (angemeldete zuerst, nach Gruppe, dann Anmeldereihenfolge; beobachtete alphabetisch).
func List() []Info {
	mu.RLock()
	defer mu.RUnlock()
	out := append([]Info(nil), registry...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].Group < out[j].Group })
	obs := make([]Info, 0, len(observed))
	for _, o := range observed {
		obs = append(obs, *o)
	}
	sort.Slice(obs, func(i, j int) bool { return obs[i].Subject < obs[j].Subject })
	return append(out, obs...)
}

// Covers meldet, ob das Subject-Muster pattern jedes Subject abdeckt, das sub abdecken kann (NATS-Regeln: * ein Teil, > Rest).
func Covers(pattern, sub string) bool {
	pt, st := strings.Split(pattern, "."), strings.Split(sub, ".")
	for i, p := range pt {
		if p == ">" {
			return len(st) > i
		}
		if i >= len(st) {
			return false
		}
		switch {
		case p == "*":
			if st[i] == ">" {
				return false
			}
		case p != st[i]:
			return false
		}
	}
	return len(pt) == len(st)
}
