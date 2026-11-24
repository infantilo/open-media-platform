package instancemigrate

// Kapitel 108: Umzug über Hostgrenzen trotz MXL-Gegenstellen. Statt den Umzug zu verweigern, baut der Umzug
// Gateway-Ketten (hostbridge) zwischen dem neuen Node und seinen Gegenstellen auf anderen Hosts. Reihenfolge
// (make-before-break): neue Instanz starten, Brücken bauen, Quelle in die Brücke schalten, kurz einschwingen, ERST DANN
// die Gegenstellen auf den Brücken-Ausgang umschalten, Verbraucher übernehmen lassen, alte Instanz stoppen.
// Scheitert ein Schritt vor dem Stopp, werden Brücken und neue Instanz entfernt und die Gegenstellen auf die alte
// Instanz zurückgeschaltet — die alte läuft unverändert weiter.

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/graph"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/hostbridge"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

// BridgeRunner baut Brücken (*hostbridge.Runner).
type BridgeRunner interface {
	Build(ctx context.Context, b hostbridge.Bridge) (*hostbridge.Built, error)
}

// bridgeSettle: so lange läuft die Brücke ein, bevor die Gegenstellen auf sie umgeschaltet werden. var für Tests.
var bridgeSettle = 2 * time.Second

// SetBridges aktiviert den Umzug über Hostgrenzen. caps liefert die Fähigkeiten eines Hosts (nil = alles unbekannt).
func (s *Service) SetBridges(r BridgeRunner, caps func(hostID string) hostbridge.Caps) {
	s.bridges = r
	s.bridgeCaps = caps
}

// bridgeJob: eine zu bauende Brücke samt der Kanten, die darüber laufen.
type bridgeJob struct {
	plan        hostbridge.Bridge
	oldIsSender bool
	built       *hostbridge.Built
}

type instInfo struct {
	hostOf map[string]string
	byID   map[string]launcher.Instance
}

func (s *Service) instanceInfo() instInfo {
	out := instInfo{hostOf: map[string]string{}, byID: map[string]launcher.Instance{}}
	if ll, ok := s.launcher.(interface{ List() []launcher.Instance }); ok {
		for _, in := range ll.List() {
			out.hostOf[in.ID] = in.HostID
			out.byID[in.ID] = in
		}
	}
	return out
}

type bridgeGroup struct {
	entry, exit  registry.NodeView
	haveE, haveX bool
	instances    []string
}

// bridgeGroups sammelt die laufenden Brücken (Marke OMP_BRIDGE_ID) mit Ein- und Ausgang.
func (s *Service) bridgeGroups(info instInfo) map[string]*bridgeGroup {
	groups := map[string]*bridgeGroup{}
	byInst := map[string]registry.NodeView{}
	for _, n := range s.nodes.List() {
		if n.InstanceID != "" {
			byInst[n.InstanceID] = n
		}
	}
	for id, in := range info.byID {
		bid := in.ExtraEnv[hostbridge.EnvID]
		if bid == "" {
			continue
		}
		g := groups[bid]
		if g == nil {
			g = &bridgeGroup{}
			groups[bid] = g
		}
		g.instances = append(g.instances, id)
		n, ok := byInst[id]
		if !ok {
			continue
		}
		switch in.ExtraEnv[hostbridge.EnvRole] {
		case "entry":
			g.entry, g.haveE = n, true
		case "exit":
			g.exit, g.haveX = n, true
		}
	}
	return groups
}

func portSet(n registry.NodeView, senders bool) map[string]bool {
	m := map[string]bool{}
	if senders {
		for _, s := range n.Senders {
			m[s.ID] = true
		}
	} else {
		for _, r := range n.Receivers {
			m[r.ID] = true
		}
	}
	return m
}

// unwrapBridges ersetzt Kanten von/zu Brücken, die an x hängen, durch die direkten Kanten x ↔ Gegenstelle (die Brücke
// gehört zu x und wird nach dem Umzug neu gebaut). Liefert die wirksamen Kanten und die Instanzen der abgelösten Brücken.
func unwrapBridges(edges []graph.Edge, x registry.NodeView, groups map[string]*bridgeGroup) ([]graph.Edge, []string) {
	xSend, xRecv := portSet(x, true), portSet(x, false)
	removed := map[int]bool{}
	var added []graph.Edge
	var old []string
	for _, g := range groups {
		if !g.haveE || !g.haveX {
			continue
		}
		entryRecv, exitSend := portSet(g.entry, false), portSet(g.exit, true)
		var srcEdges, sinkEdges []int
		for i, e := range edges {
			if entryRecv[e.ToReceiver] && xSend[e.FromSender] {
				srcEdges = append(srcEdges, i)
			}
			if exitSend[e.FromSender] && xRecv[e.ToReceiver] {
				sinkEdges = append(sinkEdges, i)
			}
		}
		if len(srcEdges) == 0 && len(sinkEdges) == 0 {
			continue
		}
		if len(srcEdges) > 0 {
			src := edges[srcEdges[0]]
			removed[srcEdges[0]] = true
			for i, e := range edges {
				if exitSend[e.FromSender] && !xRecv[e.ToReceiver] {
					added = append(added, graph.Edge{FromSender: src.FromSender, ToReceiver: e.ToReceiver, State: e.State})
					removed[i] = true
				}
			}
		}
		for _, si := range sinkEdges {
			sink := edges[si]
			removed[si] = true
			for i, e := range edges {
				if entryRecv[e.ToReceiver] && !xSend[e.FromSender] {
					added = append(added, graph.Edge{FromSender: e.FromSender, ToReceiver: sink.ToReceiver, State: e.State})
					removed[i] = true
				}
			}
		}
		old = append(old, g.instances...)
	}
	var out []graph.Edge
	for i, e := range edges {
		if !removed[i] {
			out = append(out, e)
		}
	}
	return append(out, added...), old
}

type edgeKey struct{ side, port, other string }

func keyOf(e edgeRef) edgeKey { return edgeKey{e.side, e.portID, e.otherPortID} }

// planBridges findet die Kanten des alten Nodes, die nach dem Umzug eine Hostgrenze überqueren, und plant die Brücken.
func (s *Service) planBridges(oldNode registry.NodeView, edges []graph.Edge, targetHost string, info instInfo) (map[edgeKey]*bridgeJob, []*bridgeJob, error) {
	type port struct {
		node   registry.NodeView
		sender *registry.SenderView
	}
	senders, receivers := map[string]port{}, map[string]registry.NodeView{}
	for _, n := range s.nodes.List() {
		for i := range n.Senders {
			senders[n.Senders[i].ID] = port{node: n, sender: &n.Senders[i]}
		}
		for _, r := range n.Receivers {
			receivers[r.ID] = n
		}
	}
	xSend, xRecv := portSet(oldNode, true), portSet(oldNode, false)
	type crossing struct {
		key         edgeKey
		oldIsSender bool
		edge        hostbridge.Edge
	}
	var cross []crossing
	for _, e := range edges {
		sp, okS := senders[e.FromSender]
		rn, okR := receivers[e.ToReceiver]
		if !okS || !okR || sp.sender == nil || !strings.Contains(strings.ToLower(sp.sender.Transport), "mxl") {
			continue
		}
		var peer registry.NodeView
		var side string
		switch {
		case xSend[e.FromSender]:
			peer, side = rn, "output"
		case xRecv[e.ToReceiver]:
			peer, side = sp.node, "input"
		default:
			continue
		}
		if peer.InstanceID == "" {
			continue // Host unbekannt: wie bisher nicht als Konflikt werten
		}
		peerHost := info.hostOf[peer.InstanceID]
		if peerHost == targetHost {
			continue
		}
		he := hostbridge.Edge{
			Medium: hostbridge.MediumOfFormat(sp.sender.Format),
			Format: hostbridge.Format{Width: sp.sender.Width, Height: sp.sender.Height, RateNum: sp.sender.RateNum, RateDen: sp.sender.RateDen,
				SampleRate: sp.sender.SampleRate, Channels: sp.sender.ChannelCount},
			FromSender: e.FromSender, ToReceiver: e.ToReceiver, Peer: peer.Label,
		}
		if side == "output" {
			he.SenderHost, he.ReceiverHost = targetHost, peerHost
			cross = append(cross, crossing{edgeKey{side, e.FromSender, e.ToReceiver}, true, he})
		} else {
			he.SenderHost, he.ReceiverHost = peerHost, targetHost
			cross = append(cross, crossing{edgeKey{side, e.ToReceiver, e.FromSender}, false, he})
		}
	}
	if len(cross) == 0 {
		return nil, nil, nil
	}
	hes := make([]hostbridge.Edge, len(cross))
	for i, c := range cross {
		hes[i] = c.edge
	}
	caps := s.bridgeCaps
	if caps == nil {
		caps = func(string) hostbridge.Caps { return hostbridge.Caps{} }
	}
	plan, err := hostbridge.Plan(hes, caps)
	if err != nil {
		return nil, nil, err
	}
	jobs := make([]*bridgeJob, len(plan))
	for i := range plan {
		jobs[i] = &bridgeJob{plan: plan[i]}
	}
	byEdge := map[edgeKey]*bridgeJob{}
	for _, c := range cross {
		for _, j := range jobs {
			if j.plan.FromSender == c.edge.FromSender && j.plan.SenderHost == c.edge.SenderHost && j.plan.ReceiverHost == c.edge.ReceiverHost &&
				j.plan.Medium == c.edge.Medium && contains(j.plan.Receivers, c.edge.ToReceiver) {
				j.oldIsSender = c.oldIsSender
				byEdge[c.key] = j
				break
			}
		}
	}
	return byEdge, jobs, nil
}

func contains(l []string, v string) bool {
	for _, x := range l {
		if x == v {
			return true
		}
	}
	return false
}

// newPortFor ordnet den Port einer Kante dem neuen Node zu (gleiche Regel wie reconnect: ID, sonst Index).
func newPortFor(newNode registry.NodeView, e edgeRef) (string, bool) {
	if e.side == "output" {
		idx := e.index
		for i, sn := range newNode.Senders {
			if e.portID != "" && sn.ID == e.portID {
				idx = i
				break
			}
		}
		if idx >= len(newNode.Senders) {
			return "", false
		}
		return newNode.Senders[idx].ID, true
	}
	idx := e.index
	for i, r := range newNode.Receivers {
		if e.portID != "" && r.ID == e.portID {
			idx = i
			break
		}
	}
	if idx >= len(newNode.Receivers) {
		return "", false
	}
	return newNode.Receivers[idx].ID, true
}

func uniqueJobs(edges []edgeRef) []*bridgeJob {
	seen := map[*bridgeJob]bool{}
	var out []*bridgeJob
	for _, e := range edges {
		if e.job != nil && !seen[e.job] {
			seen[e.job] = true
			out = append(out, e.job)
		}
	}
	return out
}

// buildAndWire baut die Brücken und schaltet erst um, wenn sie laufen. Bei Fehler: nichts bleibt zurück, die alte
// Instanz ist unberührt (die Gegenstellen sind auf sie zurückgeschaltet).
func (s *Service) buildAndWire(ctx context.Context, newInst launcher.Instance, newNode registry.NodeView, edges []edgeRef) error {
	jobs := uniqueJobs(edges)
	if len(jobs) == 0 {
		return nil
	}
	if s.bridges == nil {
		return ErrMXLPeer
	}
	teardown := func() {
		for _, j := range jobs {
			if j.built != nil {
				for i := len(j.built.Instances) - 1; i >= 0; i-- {
					if err := s.launcher.Stop(j.built.Instances[i]); err != nil && !errors.Is(err, launcher.ErrStopDeferred) {
						slog.Warn("instancemigrate: Brücken-Glied ließ sich nicht stoppen", "instance", j.built.Instances[i], "error", err)
					}
				}
			}
		}
	}
	for _, j := range jobs {
		j.plan.Owner = newInst.ID
		built, err := s.bridges.Build(ctx, j.plan)
		if err != nil {
			teardown()
			return fmt.Errorf("bridge to %s: %w", strings.Join(j.plan.Peers, ", "), err)
		}
		j.built = built
		slog.Info("instancemigrate: Brücke gebaut", "transport", built.Transport, "medium", j.plan.Medium, "from", j.plan.SenderHost, "to", j.plan.ReceiverHost)
	}
	// 1. Quelle in die Brücke (rein additiv: bestehende Verbindungen bleiben).
	for _, j := range jobs {
		from := j.plan.FromSender
		if j.oldIsSender {
			from = ""
			for _, e := range edges {
				if e.job == j {
					from, _ = newPortFor(newNode, e)
					break
				}
			}
		}
		if from == "" {
			teardown()
			return errors.New("new node has no sender for the bridge")
		}
		cctx, cancel := context.WithTimeout(ctx, registrationTimeout)
		err := s.graph.Connect(cctx, from, j.built.EntryReceiver())
		cancel()
		if err != nil {
			teardown()
			return fmt.Errorf("source into bridge: %w", err)
		}
	}
	// 2. Einschwingen, dann die Gegenstellen auf den Brücken-Ausgang umschalten.
	select {
	case <-time.After(bridgeSettle):
	case <-ctx.Done():
	}
	var switched []edgeRef
	var failed error
	for _, e := range edges {
		if e.job == nil {
			continue
		}
		cctx, cancel := context.WithTimeout(ctx, registrationTimeout)
		var err error
		if e.side == "output" {
			err = s.graph.Connect(cctx, e.job.built.ExitSender(), e.otherPortID)
		} else if np, ok := newPortFor(newNode, e); ok {
			err = s.graph.Connect(cctx, e.job.built.ExitSender(), np)
		} else {
			err = errors.New("new node has no matching receiver")
		}
		cancel()
		if err != nil {
			failed = fmt.Errorf("switch to bridge output: %w", err)
			break
		}
		switched = append(switched, e)
	}
	if failed != nil {
		for _, e := range switched { // Gegenstellen zurück auf die alte Instanz
			if e.side == "output" {
				_ = s.graph.Connect(ctx, e.portID, e.otherPortID)
			}
		}
		teardown()
		return failed
	}
	return nil
}

// BridgePreview beschreibt eine Brücke, die der Umzug bauen würde (Vorschau im Umzugsdialog).
type BridgePreview struct {
	Medium     hostbridge.Medium      `json:"medium"`
	FromHost   string                 `json:"fromHost"`
	ToHost     string                 `json:"toHost"`
	Peers      []string               `json:"peers"`
	Transport  hostbridge.Transport   `json:"transport"`
	Candidates []hostbridge.Transport `json:"candidates"`
}

// Preview ist das Ergebnis von PreviewMigration.
type Preview struct {
	Bridges []BridgePreview `json:"bridges"`
	// DissolvedBridges: Zahl der Brücken-Glieder der Instanz, die nach dem Umzug entfallen (neu gebaut oder unnötig).
	DissolvedBridges int `json:"dissolvedBridges"`
}

// PreviewMigration prüft einen Umzug wie MigrateInstance, verändert aber nichts: sie meldet dieselben Fehler
// (ErrSameHost, ErrMXLPeer mit Grund …) und liefert sonst die Brücken, die der Umzug bauen würde.
func (s *Service) PreviewMigration(ctx context.Context, oldInstanceID, targetHostID string) (Preview, error) {
	_, edges, carry, err := s.prepareMigration(ctx, oldInstanceID, targetHostID, false)
	if err != nil {
		return Preview{}, err
	}
	out := Preview{Bridges: []BridgePreview{}, DissolvedBridges: len(carry.oldBridges)}
	for _, j := range uniqueJobs(edges) {
		out.Bridges = append(out.Bridges, BridgePreview{Medium: j.plan.Medium, FromHost: j.plan.SenderHost, ToHost: j.plan.ReceiverHost,
			Peers: j.plan.Peers, Transport: j.plan.Candidates[0], Candidates: j.plan.Candidates})
	}
	return out, nil
}
