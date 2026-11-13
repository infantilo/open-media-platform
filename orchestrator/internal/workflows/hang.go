// Kapitel 100 Punkt 8 — hängender Node.
//
// Der Launcher erkennt nur das Prozessende. Ein Prozess, der lebt, aber nichts mehr tut (Deadlock, angehalten),
// wurde bisher nur als "Health veraltet" angezeigt. Hier folgt daraus eine Aktion — mit mehreren Sicherungen gegen
// Fehlalarm und Schleifen:
//
//   - "Hängt" heißt: die Rolle hatte einen registrierten Node, der jetzt seit hangAfter entweder offline gemeldet
//     wird (kein Health-Ereignis mehr) oder ganz aus der Registry verschwunden ist, UND seine Node-API antwortet
//     nicht. Antwortet die API, lebt der Prozess — dann fehlt nur der Weg zum Bus, und ein Neustart hülfe nicht.
//   - Sind gleichzeitig mehr als die Hälfte der Rollen-Nodes betroffen, ist die Überwachung selbst gestört (Bus oder
//     Registry) — dann geschieht nichts.
//   - Rollen im Umzug, mit vorgemerktem Stop, auf ausgefallenem Host oder als abgestürzt geführt sind ausgenommen.
//   - Je Instanz höchstens hangMaxKicks Anstöße in hangKickWindow; danach nur noch Alarm.
//
// Aktion: hat die Rolle einen laufenden Standby, übernimmt er (wie bei einem Absturz ohne Ende). Sonst wird der
// Prozess hart beendet (launcher.Kick) — sein Ende läuft dann durch die normale Absturzbehandlung: Neustart unter
// derselben ID, Neuverkabelung, gesicherter Zustand bleibt gehalten.
package workflows

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/safego"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

const (
	defaultHangAfter = 30 * time.Second
	hangMaxKicks     = 3
	hangKickWindow   = 30 * time.Minute
)

// hangAction liest OMP_HANG_ACTION: "restart" (Standard: Standby übernimmt, sonst harter Neustart) oder "off"
// (nur anzeigen wie bisher).
func hangAction() string {
	if strings.ToLower(strings.TrimSpace(os.Getenv("OMP_HANG_ACTION"))) == "off" {
		return "off"
	}
	return "restart"
}

// hangAfter liest OMP_HANG_AFTER (Go-Dauer, mindestens 15 s).
func hangAfter() time.Duration {
	if d, err := time.ParseDuration(os.Getenv("OMP_HANG_AFTER")); err == nil && d >= 15*time.Second {
		return d
	}
	return defaultHangAfter
}

type hangState struct {
	mu sync.Mutex
	// since: Instanz -> seit wann ihr Node als nicht gesund beobachtet wird.
	since map[string]time.Time
	// apiBase: zuletzt bekannte Node-API je Instanz (ein hängender Node fällt nach kurzer Zeit aus der Registry).
	apiBase map[string]string
	// kicks: Zeitpunkte der Anstöße je Instanz (Schleifenschutz).
	kicks map[string][]time.Time
	// gaveUp: Instanzen, für die der Schleifenschutz bereits gemeldet wurde.
	gaveUp map[string]bool
}

type hangCandidate struct {
	wf         Workflow
	role       string
	instanceID string
	apiBase    string
}

type hangEvent struct {
	WorkflowID string    `json:"workflowId"`
	Role       string    `json:"role"`
	InstanceID string    `json:"instanceId"`
	Action     string    `json:"action"` // "failover" | "restart" | "gave-up" | "restart-failed"
	At         time.Time `json:"at"`
}

func (s *Service) publishHang(ev hangEvent) {
	slog.Warn("workflows: node hangs", "workflow", ev.WorkflowID, "role", ev.Role, "instance", ev.InstanceID, "action", ev.Action)
	if s.events == nil {
		return
	}
	if data, err := json.Marshal(ev); err == nil {
		s.events.Broadcast(sse.Event{Type: "instance.hung", Data: data})
	}
}

// checkHungNodes läuft im Takt des Failover-Wächters (nur Leader).
func (s *Service) checkHungNodes(wfs []Workflow) {
	if hangAction() == "off" {
		return
	}
	h := &s.hang
	crashed, pending := map[string]bool{}, map[string]bool{}
	if ll, ok := s.launcher.(interface{ List() []launcher.Instance }); ok {
		for _, in := range ll.List() {
			crashed[in.ID] = in.Crashed
			pending[in.ID] = in.StopPending
		}
	}
	online := map[string]bool{} // Node-ID -> gesund gemeldet
	apiOf := map[string]string{}
	for _, n := range s.nodes.List() {
		online[n.ID] = n.Online
		apiOf[n.ID] = n.APIBaseURL
	}

	after := hangAfter()
	now := time.Now()
	total, unhealthy := 0, 0
	var due []hangCandidate
	seen := map[string]bool{}

	h.mu.Lock()
	if h.since == nil {
		h.since, h.apiBase, h.kicks, h.gaveUp = map[string]time.Time{}, map[string]string{}, map[string][]time.Time{}, map[string]bool{}
	}
	for _, wf := range wfs {
		if wf.Status != StatusStarted {
			continue
		}
		for role, rt := range wf.Runtime {
			// Ohne Node-ID hat sich die Rolle noch nie registriert (Start läuft); die Standby-Rolle teilt nach einer
			// Übernahme ihre Instanz mit der Primärrolle und wird dort mitbetrachtet.
			if rt.InstanceID == "" || rt.NodeID == "" || seen[rt.InstanceID] {
				continue
			}
			seen[rt.InstanceID] = true
			if rt.MigratingTo != "" || rt.MigratedFrom != nil || crashed[rt.InstanceID] || pending[rt.InstanceID] || s.hostOffline(rt.HostID) {
				delete(h.since, rt.InstanceID)
				continue
			}
			total++
			if isOnline, registered := online[rt.NodeID]; registered && isOnline {
				delete(h.since, rt.InstanceID)
				if apiOf[rt.NodeID] != "" {
					h.apiBase[rt.InstanceID] = apiOf[rt.NodeID]
				}
				continue
			}
			unhealthy++
			first, ok := h.since[rt.InstanceID]
			if !ok {
				h.since[rt.InstanceID] = now
				continue
			}
			if now.Sub(first) >= after {
				base := apiOf[rt.NodeID]
				if base == "" {
					base = h.apiBase[rt.InstanceID]
				}
				due = append(due, hangCandidate{wf: wf, role: role, instanceID: rt.InstanceID, apiBase: base})
			}
		}
	}
	for id := range h.since {
		if !seen[id] {
			delete(h.since, id)
			delete(h.apiBase, id)
			delete(h.kicks, id)
			delete(h.gaveUp, id)
		}
	}
	h.mu.Unlock()

	if len(due) == 0 {
		return
	}
	// Mehr als die Hälfte gleichzeitig "krank": die Überwachung ist gestört, nicht die Nodes.
	if total >= 2 && unhealthy*2 > total {
		slog.Warn("workflows: many nodes look unhealthy at once, assuming a monitoring problem — no action", "unhealthy", unhealthy, "of", total)
		return
	}
	for _, c := range due {
		c := c
		safego.Go("workflows.handleHungNode", func() { s.handleHungNode(c) })
	}
}

func (s *Service) handleHungNode(c hangCandidate) {
	// Lebt der Prozess noch (API antwortet), fehlt nur die Meldung am Bus: kein Fall für einen Neustart. Ohne
	// bekannte Node-API (dieser Orchestrator hat den Node nie gesund gesehen) lässt sich das nicht unterscheiden —
	// dann geschieht nichts, statt auf Verdacht eine laufende Sendung neu zu starten.
	alive := c.apiBase == ""
	if !alive {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		alive = s.nodeAPIAnswers(ctx, c.apiBase)
		cancel()
	}
	if alive {
		s.hang.mu.Lock()
		s.hang.since[c.instanceID] = time.Now() // neu anfangen zu zählen
		s.hang.mu.Unlock()
		return
	}
	if _, ok := s.stillBacks(c.wf.ID, c.role, c.instanceID); !ok {
		return
	}
	h := &s.hang
	h.mu.Lock()
	now := time.Now()
	recent := h.kicks[c.instanceID][:0]
	for _, t := range h.kicks[c.instanceID] {
		if now.Sub(t) < hangKickWindow {
			recent = append(recent, t)
		}
	}
	if len(recent) >= hangMaxKicks {
		h.kicks[c.instanceID] = recent
		already := h.gaveUp[c.instanceID]
		h.gaveUp[c.instanceID] = true
		h.since[c.instanceID] = now
		h.mu.Unlock()
		if !already {
			s.publishHang(hangEvent{WorkflowID: c.wf.ID, Role: c.role, InstanceID: c.instanceID, Action: "gave-up", At: now})
		}
		return
	}
	h.kicks[c.instanceID] = append(recent, now)
	h.since[c.instanceID] = now // bis zur nächsten Bewertung vergeht wieder hangAfter
	h.mu.Unlock()

	// Standby vorhanden und gesund: übernehmen lassen (promoteStandby prüft das selbst und stoppt danach die
	// hängende Instanz).
	if sb := s.standbyRoleFor(c.wf, c.role); sb != "" && !c.wf.Runtime[c.role].StandbyActive {
		s.promoteStandby(c.wf, c.role, sb, "hang")
		if now, err := s.store.Get(c.wf.ID); err == nil && now.Runtime[c.role].InstanceID != c.instanceID {
			s.publishHang(hangEvent{WorkflowID: c.wf.ID, Role: c.role, InstanceID: c.instanceID, Action: "failover", At: time.Now()})
			return
		}
	}
	kicker, ok := s.launcher.(interface{ Kick(string) error })
	if !ok {
		return
	}
	if err := kicker.Kick(c.instanceID); err != nil {
		slog.Warn("workflows: hard restart of the hung instance failed", "workflow", c.wf.ID, "role", c.role, "instance", c.instanceID, "error", err)
		s.publishHang(hangEvent{WorkflowID: c.wf.ID, Role: c.role, InstanceID: c.instanceID, Action: "restart-failed", At: time.Now()})
		return
	}
	s.publishHang(hangEvent{WorkflowID: c.wf.ID, Role: c.role, InstanceID: c.instanceID, Action: "restart", At: time.Now()})
}
