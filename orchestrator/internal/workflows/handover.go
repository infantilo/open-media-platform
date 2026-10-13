// Make-before-break über Node-Grenzen hinweg (Host-Wartung): Nach dem Umverkabeln darf die alte Instanz erst
// stoppen, wenn alle Verbraucher nachweislich auf die neue umgeschaltet haben und deren Bild/Ton läuft.
// Nodes, die einen Quellenwechsel weich vollziehen können (Viewer, Bildmischer), melden das über den Parameter
// `handoverPending`; der Bildmischer entdeckt Quellen selbst und bekommt den Sender-Tausch per POST /handover.
package workflows

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

const (
	// handoverWaitTimeout begrenzt das Warten; danach wird trotzdem umgezogen (wie ohne Übergabe-Schutz).
	handoverWaitTimeout  = 25 * time.Second
	handoverPollInterval = 250 * time.Millisecond
)

// senderPairs koppelt die Sender zweier Instanzen derselben Rolle: bevorzugt gleiches Format UND gleiches Label
// (Label = Rolle + Index, bei jeder Instanz gleich), sonst der nächste freie Sender gleichen Formats. Die
// Reihenfolge der Registry-Liste ist nicht stabil — reine Positionszuordnung würde Audio und Video vertauschen.
func senderPairs(oldSenders, newSenders []registry.SenderView) [][2]string {
	used := make([]bool, len(newSenders))
	pairs := make([][2]string, 0, len(oldSenders))
	take := func(match func(n registry.SenderView) bool) (string, bool) {
		for i, n := range newSenders {
			if !used[i] && match(n) {
				used[i] = true
				return n.ID, true
			}
		}
		return "", false
	}
	for _, o := range oldSenders {
		id, ok := take(func(n registry.SenderView) bool { return n.Format == o.Format && n.Label == o.Label })
		if !ok {
			id, ok = take(func(n registry.SenderView) bool { return n.Format == o.Format })
		}
		if ok {
			pairs = append(pairs, [2]string{o.ID, id})
		}
	}
	return pairs
}

// awaitHandover meldet den Sender-Tausch allen anderen Rollen des Workflows (Nodes ohne /handover ignorieren es)
// und wartet, bis jeder Node mit `handoverPending` fertig ist — inklusive des umgezogenen Nodes selbst.
func (s *Service) awaitHandover(wf Workflow, role, oldNodeID, newNodeID string) {
	var oldNode registry.NodeView
	nodes := s.nodes.List()
	for _, n := range nodes {
		if n.ID == oldNodeID {
			oldNode = n
		}
	}
	var newNode registry.NodeView
	for _, n := range nodes {
		if n.ID == newNodeID {
			newNode = n
		}
	}
	pairs := senderPairs(oldNode.Senders, newNode.Senders)

	var bases []string
	for r := range wf.Runtime {
		node, ok := s.nodeForRole(wf, r)
		if !ok || node.APIBaseURL == "" {
			continue
		}
		if r != role && len(pairs) > 0 {
			s.notifyHandover(node.APIBaseURL, pairs)
		}
		bases = append(bases, node.APIBaseURL)
	}

	ctx, cancel := context.WithTimeout(context.Background(), handoverWaitTimeout)
	defer cancel()
	for _, base := range bases {
		if !s.waitHandoverIdle(ctx, base) {
			slog.Warn("workflows: handover did not finish in time, continuing", "workflow", wf.ID, "role", role, "node", base)
		}
	}
}

// notifyHandover schickt den Sender-Tausch best effort an einen Node.
func (s *Service) notifyHandover(base string, pairs [][2]string) {
	type repl struct {
		Old string `json:"old"`
		New string `json:"new"`
	}
	body := struct {
		Replacements []repl `json:"replacements"`
	}{}
	for _, p := range pairs {
		body.Replacements = append(body.Replacements, repl{Old: p[0], New: p[1]})
	}
	raw, _ := json.Marshal(body)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/handover", bytes.NewReader(raw))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
}

// waitHandoverIdle wartet, bis `handoverPending` des Nodes false meldet. Unterstützt der Node den Parameter nicht
// (kein 200), gibt es nichts abzuwarten.
func (s *Service) waitHandoverIdle(ctx context.Context, base string) bool {
	for {
		pending, supported := s.handoverPending(ctx, base)
		if !supported || !pending {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(handoverPollInterval):
		}
	}
}

func (s *Service) handoverPending(ctx context.Context, base string) (pending, supported bool) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/params/handoverPending", nil)
	if err != nil {
		return false, false
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return false, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, false
	}
	var out struct {
		Value bool `json:"value"`
	}
	if json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&out) != nil {
		return false, false
	}
	return out.Value, true
}
