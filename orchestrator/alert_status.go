package main

import (
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/alertsink"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/cluster"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/graph"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/version"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/workflows"
)

// alertStatusProvider baut die Statusbeilage einer Alarm-Mail (Empfängerregel „Status“): Orchestrator, Hosts,
// betroffene Workflows und den Signalweg vom Alarm-Node aufwärts bis zur Wurzel (Kanten des Graphen).
func alertStatusProvider(cl *cluster.Node, reg *registry.Store, gs *graph.Service, hs *hosts.Store, hm *hosts.Tracker, wf *workflows.Service) func(alertsink.Alert) *alertsink.StatusReport {
	return func(a alertsink.Alert) *alertsink.StatusReport {
		r := &alertsink.StatusReport{Time: time.Now()}
		st := cl.Status()
		host := st.NodeID
		r.Orchestrator = alertsink.OrchestratorInfo{Name: host, Version: version.Current().Version, Leader: st.IsLeader, Peers: max(len(st.Peers)-1, 0)}

		views := reg.List()
		label := map[string]string{}
		ok := map[string]bool{}
		bySender, byReceiver := map[string]string{}, map[string]string{}
		for _, v := range views {
			if len(v.Devices) == 0 {
				continue
			}
			label[v.ID] = v.Label
			ok[v.ID] = v.Online
			for _, s := range v.Senders {
				bySender[s.ID] = v.ID
			}
			for _, rc := range v.Receivers {
				byReceiver[rc.ID] = v.ID
			}
		}
		var edges []alertsink.FlowEdge
		for _, e := range gs.Edges() {
			from, ok1 := bySender[e.FromSender]
			to, ok2 := byReceiver[e.ToReceiver]
			if ok1 && ok2 {
				edges = append(edges, alertsink.FlowEdge{From: from, To: to})
			}
		}
		focus := a.Subject
		if _, known := label[focus]; !known {
			for _, v := range views { // Alarm-Gegenstand kann auch die Instanz-ID sein
				if v.InstanceID != "" && v.InstanceID == a.Subject {
					focus = v.ID
				}
			}
		}
		r.Flow = alertsink.UpstreamOf(focus, edges, label, ok)

		affectedHosts := map[string]bool{}
		hostID, _, _ := strings.Cut(a.Subject, "/")
		switch a.Kind {
		case "host-offline", "host-online", "load-high", "load-recovered":
			affectedHosts[hostID] = true
		}
		refs := a.Workflows
		if a.Kind == "marker" || a.Kind == "freeze" { // kein einzelner Gegenstand: alle laufenden Workflows
			if all, err := wf.List(); err == nil {
				for _, w := range all {
					if w.Status == workflows.StatusStarted {
						name := w.Definition.Title
						if name == "" {
							name = w.Name
						}
						refs = append(refs, alertsink.WorkflowRef{ID: w.ID, Name: name})
					}
				}
			}
		}
		for _, ref := range refs {
			w, err := wf.Get(ref.ID)
			if err != nil {
				r.Workflows = append(r.Workflows, alertsink.WorkflowInfo{Name: ref.Name, Status: "?"})
				continue
			}
			info := alertsink.WorkflowInfo{Name: ref.Name, Status: w.Status}
			for _, rt := range w.Runtime {
				if rt.InstanceID == "" {
					continue
				}
				info.Nodes++
				if rt.NodeID != "" && !ok[rt.NodeID] {
					info.Down++
				}
				if rt.HostID != "" && (rt.NodeID == focus || rt.NodeID == a.Subject) {
					affectedHosts[rt.HostID] = true
				}
			}
			r.Workflows = append(r.Workflows, info)
		}
		if all, err := hs.ListHosts(); err == nil {
			for _, h := range all {
				m, seen := hm.Get(h.ID)
				hi := alertsink.HostInfo{Name: h.Label, Online: seen && !m.Goodbye && time.Since(m.ReceivedAt) < 15*time.Second}
				if seen {
					hi.CPU = m.CPUPercent
					if m.MemTotalBytes > 0 {
						hi.Mem = float64(m.MemUsedBytes) / float64(m.MemTotalBytes) * 100
					}
				}
				if affectedHosts[h.ID] {
					hi.Note = "betroffen"
				}
				r.Hosts = append(r.Hosts, hi)
			}
		}
		return r
	}
}
