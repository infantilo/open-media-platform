package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/graph"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/mxldomains"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/mxlflows"
	"github.com/infantilo/openmediaplatform/podmanrun"
)

// mxlFlowView ist ein Flow der lokalen MXL-Domain mit der zugeordneten OMP-Instanz (falls der Schreiber ein
// vom Orchestrator gestarteter Node ist).
type mxlFlowView struct {
	mxlflows.Flow
	// Instance: Instanz-ID des Schreibers, Label dazu. Leer bei Fremdprozessen (z. B. ein Container oder ein
	// von Hand gestartetes Werkzeug) und bei Resten ohne Schreiber.
	Instance      string `json:"instance,omitempty"`
	InstanceLabel string `json:"instanceLabel,omitempty"`
	InstanceType  string `json:"instanceType,omitempty"`
}

// handleMXLFlows liefert GET /api/v1/admin/mxl/flows: die Flows der lokalen MXL-Domain (OMP_MXL_DOMAIN, Standard
// /dev/shm/omp-mxl) mit Schreiber (PID, Programm, Container) und Rest-Erkennung. Gilt nur für den Rechner des
// Orchestrators: MXL ist host-lokal, entfernte Hosts hätten eine eigene Domain.
func handleMXLFlows(ls LauncherService, ds MXLDomainStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		domain := os.Getenv("OMP_MXL_DOMAIN")
		if domain == "" {
			domain = "/dev/shm/omp-mxl"
		}
		name := r.URL.Query().Get("domain")
		// ?domain=<Name>: eine benannte Domain statt der Standarddomain (Kap. 103).
		if name != "" && name != mxldomains.DefaultName {
			if ds == nil {
				http.Error(w, "MXL domains are not enabled", http.StatusNotFound)
				return
			}
			p, err := ds.Resolve(name)
			if err != nil {
				http.Error(w, err.Error(), http.StatusNotFound)
				return
			}
			domain = p
		}
		// ?host=<Host-ID>: die Domain eines entfernten Hosts (der Agent scannt sein eigenes /dev/shm).
		hostID := r.URL.Query().Get("host")
		var flows []mxlflows.Flow
		if hostID != "" {
			rf, ok := ls.(interface {
				MXLFlowsOnHost(hostID, domain string) (json.RawMessage, error)
			})
			if !ok {
				http.Error(w, "remote hosts not supported", http.StatusNotImplemented)
				return
			}
			raw, err := rf.MXLFlowsOnHost(hostID, name)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadGateway)
				return
			}
			var resp struct {
				Domain string          `json:"domain"`
				Flows  []mxlflows.Flow `json:"flows"`
			}
			if err := json.Unmarshal(raw, &resp); err != nil {
				http.Error(w, "unreadable host answer: "+err.Error(), http.StatusBadGateway)
				return
			}
			domain, flows = resp.Domain, resp.Flows
		} else {
			var err error
			flows, err = mxlflows.Scan(domain, mxlflows.Options{})
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
		}
		// PID → Instanz derselben Maschine (lokal: HostID leer; entfernt: die Host-ID).
		byPID := map[int]struct{ id, label, typ string }{}
		if ls != nil {
			for _, in := range ls.List() {
				if in.PID > 0 && in.HostID == hostID {
					byPID[in.PID] = struct{ id, label, typ string }{in.ID, in.Label, in.Type}
				}
			}
		}
		out := make([]mxlFlowView, 0, len(flows))
		for _, f := range flows {
			if f.Writers == nil {
				f.Writers = []mxlflows.Writer{}
			}
			v := mxlFlowView{Flow: f}
			for _, wr := range f.Writers {
				if in, ok := byPID[wr.PID]; ok {
					v.Instance, v.InstanceLabel, v.InstanceType = in.id, in.label, in.typ
					break
				}
			}
			out = append(out, v)
		}
		writeJSON(w, http.StatusOK, map[string]any{"domain": domain, "host": hostID, "flows": out})
	}
}

// ---- Getrennte MXL-Domains (Kap. 103, Entwurf docs/ENTWURF-MXL-DOMAIN-TRENNUNG.md, D1/D2) ----

// MXLDomainStore ist die Domain-Verwaltung (implementiert von *mxldomains.Store).
type MXLDomainStore interface {
	List() ([]mxldomains.Domain, error)
	Resolve(name string) (string, error)
	NameForPath(path string) string
	PathFor(name string) string
	Create(name, description, by string, isolated bool) (mxldomains.Domain, error)
	Isolated(name string) bool
	Delete(name string) error
}

// WithMXLDomains schaltet die Verwaltung getrennter MXL-Domains ein.
func WithMXLDomains(s MXLDomainStore) HandlerOption {
	return func(o *handlerOptions) { o.mxlDomains = s }
}

// instanceDomain: der Domainname einer vom Launcher gestarteten Instanz (extraEnv OMP_MXL_DOMAIN_NAME, auch auf
// entfernten Hosts und für Container-Nodes); leer = Standarddomain.
func instanceDomain(in launcher.Instance) string { return in.ExtraEnv[podmanrun.DomainNameKey] }

type mxlDomainView struct {
	mxldomains.Domain
	Flows     int `json:"flows"`
	Stale     int `json:"stale"`
	Instances int `json:"instances"`
}

// handleListMXLDomains liefert GET /api/v1/admin/mxl/domains: alle Domains mit Flow- und Instanz-Zahl.
func handleListMXLDomains(ds MXLDomainStore, ls LauncherService) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		list, err := ds.List()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		perDomain := map[string]int{}
		if ls != nil {
			for _, in := range ls.List() {
				perDomain[domainOrDefault(instanceDomain(in))]++
			}
		}
		out := make([]mxlDomainView, 0, len(list))
		for _, d := range list {
			v := mxlDomainView{Domain: d, Instances: perDomain[d.Name]}
			if flows, err := mxlflows.Scan(d.Path, mxlflows.Options{}); err == nil {
				v.Flows = len(flows)
				for _, f := range flows {
					if f.Stale {
						v.Stale++
					}
				}
			}
			out = append(out, v)
		}
		writeJSON(w, http.StatusOK, map[string]any{"domains": out})
	}
}

func handleCreateMXLDomain(ds MXLDomainStore, audit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			// Isolated: Nodes in dieser Domain laufen in einer Mount-Sandbox (D7). Nur beim Anlegen wählbar.
			Isolated bool `json:"isolated"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		if body.Isolated {
			// Die Sandbox muss auf dem Orchestrator-Rechner möglich sein (Agents prüfen beim Start selbst und lehnen sonst ab).
			if err := podmanrun.SandboxAvailable(); err != nil {
				http.Error(w, "sandbox not available on this machine: "+err.Error(), http.StatusBadRequest)
				return
			}
		}
		d, err := ds.Create(strings.TrimSpace(body.Name), strings.TrimSpace(body.Description), actorFromRequest(r), body.Isolated)
		switch {
		case errors.Is(err, mxldomains.ErrValidation):
			http.Error(w, err.Error(), http.StatusBadRequest)
		case errors.Is(err, mxldomains.ErrExists):
			http.Error(w, err.Error(), http.StatusConflict)
		case err != nil:
			http.Error(w, err.Error(), http.StatusInternalServerError)
		default:
			logDomainAudit(audit, actorFromRequest(r), "mxl-domain", d.Name, "create", map[string]any{"description": d.Description, "isolated": d.Isolated})
			writeJSON(w, http.StatusCreated, d)
		}
	}
}

// handleDeleteMXLDomain liefert DELETE /api/v1/admin/mxl/domains/{name}: nur ohne Instanzen und ohne Schreiber. Reste
// (Flow-Verzeichnisse ohne Schreiber) werden mit entfernt, danach das Verzeichnis, falls leer.
func handleDeleteMXLDomain(ds MXLDomainStore, ls LauncherService, audit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		path, err := ds.Resolve(name)
		if errors.Is(err, mxldomains.ErrValidation) {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if errors.Is(err, mxldomains.ErrNotFound) {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		if err != nil || name == "" || name == mxldomains.DefaultName {
			http.Error(w, "domain cannot be deleted", http.StatusBadRequest)
			return
		}
		if ls != nil {
			for _, in := range ls.List() {
				if instanceDomain(in) == name {
					http.Error(w, fmt.Sprintf("domain %q is used by instance %q (%s)", name, in.Label, in.ID), http.StatusConflict)
					return
				}
			}
		}
		flows, _ := mxlflows.Scan(path, mxlflows.Options{})
		for _, f := range flows {
			if f.Active {
				http.Error(w, fmt.Sprintf("domain %q still has an active writer (flow %s)", name, f.ID), http.StatusConflict)
				return
			}
		}
		// Reste entfernen: nur die Flow-Verzeichnisse, die Scan gefunden hat (Namen `<id>.mxl-flow`, validiert).
		for _, f := range flows {
			_ = os.RemoveAll(filepath.Join(path, f.ID+".mxl-flow"))
		}
		if err := ds.Delete(name); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		logDomainAudit(audit, actorFromRequest(r), "mxl-domain", name, "delete", nil)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// domainStartEnv übersetzt den Domainnamen eines Instanzstarts in extraEnv (D2). Standarddomain → kein Env. Der Pfad
// entsteht erst dort, wo die Instanz läuft (Launcher, Host-Agent, Container: podmanrun.DomainPath). Für den
// Orchestrator-Rechner wird das Verzeichnis sofort angelegt; entfernte Hosts legen es selbst an.
func domainStartEnv(ds MXLDomainStore, name, target string) (map[string]string, error) {
	env := map[string]string{}
	for key, n := range map[string]string{podmanrun.DomainNameKey: name, podmanrun.TargetDomainNameKey: target} {
		if n == "" || n == mxldomains.DefaultName {
			continue
		}
		if ds == nil {
			return nil, fmt.Errorf("MXL domains are not enabled on this orchestrator")
		}
		if _, err := ds.Resolve(n); err != nil {
			return nil, err
		}
		env[key] = n
		if ds.Isolated(n) {
			env[podmanrun.SandboxKey] = "1" // abgeschottet: der Node startet in der Mount-Sandbox (D7)
		}
	}
	if len(env) == 0 {
		return nil, nil
	}
	return env, nil
}

func domainOrDefault(n string) string {
	if n == "" {
		return mxldomains.DefaultName
	}
	return n
}

// sameMXLDomain prüft vor einer Verbindung, ob Sender und Empfänger in derselben MXL-Domain liegen. Nur vom Launcher
// gestartete Nodes sind bekannt; alle anderen gelten als Standarddomain. Nicht verbindbar → Fehlertext.
func sameMXLDomain(g graph.Graph, ls LauncherService, fromSender, toReceiver string) error {
	if ls == nil {
		return nil
	}
	var fromInst, toInst string
	for _, n := range g.Nodes {
		for _, p := range n.Outputs {
			if p.ID == fromSender {
				fromInst = n.InstanceID
			}
		}
		for _, p := range n.Inputs {
			if p.ID == toReceiver {
				toInst = n.InstanceID
			}
		}
	}
	// Eingang einer Instanz = ihre Domain; Ausgang einer Domain-Brücke = ihre Zieldomain.
	domainOf := func(id string, output bool) string {
		if id == "" {
			return mxldomains.DefaultName
		}
		if in, ok := ls.Get(id); ok {
			if t := in.ExtraEnv[podmanrun.TargetDomainNameKey]; output && t != "" {
				return t
			}
			return domainOrDefault(instanceDomain(in))
		}
		return mxldomains.DefaultName
	}
	a, b := domainOf(fromInst, true), domainOf(toInst, false)
	if a == b {
		return nil
	}
	return fmt.Errorf("sender and receiver are in different MXL domains (%s / %s); a bridge between the domains is needed", a, b)
}

// handleChangeInstanceDomain liefert POST /api/v1/instances/{id}/domain {"domain":"…","targetDomain":"…"}: legt eine
// freistehende Instanz in eine andere MXL-Domain (Stop + Start mit demselben Typ, Label, Host und denselben
// Instanz-Einstellungen; die Instanz-ID ändert sich). Bewusst eng:
//   - nicht für Workflow-Rollen (dort die Domain im Workflow ändern, sonst läuft die Rolle gegen ihre Definition),
//   - nur ohne Verbindungen (die Gegenstellen liegen in der alten Domain; die Plattform kann sie nicht mitnehmen) — 409
//     mit der Aufforderung, vorher zu trennen.
func handleChangeInstanceDomain(svc LauncherService, gs GraphService, ds MXLDomainStore, nodeValues NodeOptionValues, audit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Domain       string `json:"domain"`
			TargetDomain string `json:"targetDomain"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		inst, ok := svc.Get(r.PathValue("id"))
		if !ok {
			http.Error(w, "unknown instance", http.StatusNotFound)
			return
		}
		if inst.ExtraEnv["OMP_WORKFLOW_ID"] != "" {
			http.Error(w, "instance belongs to a workflow: change the domain in the workflow settings or the role", http.StatusConflict)
			return
		}
		if inst.Type == "omp-mxl-bridge" && (body.TargetDomain == "" || body.TargetDomain == body.Domain || (body.Domain == "" && body.TargetDomain == mxldomains.DefaultName)) {
			http.Error(w, "omp-mxl-bridge needs a targetDomain different from its own domain", http.StatusBadRequest)
			return
		}
		if inst.Type != "omp-mxl-bridge" && body.TargetDomain != "" {
			http.Error(w, "targetDomain is only valid for omp-mxl-bridge", http.StatusBadRequest)
			return
		}
		env, err := domainStartEnv(ds, body.Domain, body.TargetDomain)
		if err != nil {
			status := http.StatusBadRequest
			if errors.Is(err, mxldomains.ErrNotFound) {
				status = http.StatusNotFound
			}
			http.Error(w, err.Error(), status)
			return
		}
		// Verbindungen? Dann nicht verschieben: die Gegenstellen bleiben in der alten Domain.
		if gs != nil {
			g := gs.Graph(r.Context())
			ports := map[string]bool{}
			for _, n := range g.Nodes {
				if n.InstanceID != inst.ID {
					continue
				}
				for _, p := range n.Inputs {
					ports[p.ID] = true
				}
				for _, p := range n.Outputs {
					ports[p.ID] = true
				}
			}
			for _, e := range g.Edges {
				if ports[e.FromSender] || ports[e.ToReceiver] {
					http.Error(w, "instance still has connections: disconnect them first (the connected nodes stay in the old domain)", http.StatusConflict)
					return
				}
			}
		}
		old := inst
		next := make(map[string]string, len(inst.ExtraEnv)+2)
		for k, v := range inst.ExtraEnv {
			if k != podmanrun.DomainNameKey && k != podmanrun.TargetDomainNameKey {
				next[k] = v
			}
		}
		for k, v := range env {
			next[k] = v
		}
		old.ExtraEnv = next
		if err := svc.Stop(inst.ID); err != nil {
			http.Error(w, "stop: "+err.Error(), http.StatusBadGateway)
			return
		}
		started, err := startKeepingOptions(svc, old)
		if err != nil {
			http.Error(w, "start: "+err.Error(), http.StatusBadGateway)
			return
		}
		if nodeValues != nil {
			_ = nodeValues.MoveInstance(inst.ID, started.ID)
		}
		logDomainAudit(audit, actorFromRequest(r), "instance", started.ID, "change-mxl-domain", map[string]any{"from": instanceDomain(inst), "to": body.Domain, "target": body.TargetDomain})
		writeJSON(w, http.StatusOK, map[string]string{"id": started.ID})
	}
}
