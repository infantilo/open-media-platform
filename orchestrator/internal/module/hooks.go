package module

import (
	"log/slog"
	"net/http"
	"sync"
)

// MethodCall beschreibt einen erfolgreichen Methodenaufruf an einer Node (`POST /api/v1/nodes/{id}/methods/{name}`).
type MethodCall struct {
	NodeID     string
	InstanceID string
	Name       string
	// Body ist der (auf 1 MiB begrenzte) Anfragekörper des Aufrufs.
	Body []byte
	// Actor: Nutzername des Aufrufers ("" im Bootstrap-Modus).
	Actor   string
	Request *http.Request
}

type methodObserver struct {
	names map[string]bool
	fn    func(MethodCall)
}

// Hooks sind Beobachtungspunkte im Kern, die Module nutzen können, ohne dass der Kern sie kennt (UMSETZUNG.md Kapitel 36.8).
type Hooks struct {
	mu   sync.RWMutex
	meth []methodObserver
}

func NewHooks() *Hooks { return &Hooks{} }

// OnNodeMethod meldet einen Beobachter für erfolgreiche Methodenaufrufe mit den genannten Namen an. Er läuft nach dem Aufruf
// (Status < 300), kann diesen nie beeinflussen, und eine Panik darin wird abgefangen und geloggt.
func (h *Hooks) OnNodeMethod(names []string, fn func(MethodCall)) {
	set := map[string]bool{}
	for _, n := range names {
		set[n] = true
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.meth = append(h.meth, methodObserver{names: set, fn: fn})
}

// WantsMethod meldet, ob ein Beobachter den Namen kennt — der Kern liest den Körper nur dann (kein Zusatzaufwand für alle anderen Aufrufe).
func (h *Hooks) WantsMethod(name string) bool {
	if h == nil {
		return false
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, o := range h.meth {
		if o.names[name] {
			return true
		}
	}
	return false
}

// NotifyMethod ruft alle passenden Beobachter in Anmeldereihenfolge.
func (h *Hooks) NotifyMethod(c MethodCall) {
	if h == nil {
		return
	}
	h.mu.RLock()
	obs := append([]methodObserver(nil), h.meth...)
	h.mu.RUnlock()
	for _, o := range obs {
		if !o.names[c.Name] {
			continue
		}
		func() {
			defer func() {
				if p := recover(); p != nil {
					slog.Error("module method observer panicked", "method", c.Name, "panic", p)
				}
			}()
			o.fn(c)
		}()
	}
}
