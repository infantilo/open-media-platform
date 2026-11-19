package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/accessrules"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/graph"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sourcetags"
)

// AccessRuleStore ist die Verwaltung der Zugriffsregeln (implementiert von *accessrules.Store).
type AccessRuleStore interface {
	List() ([]accessrules.Rule, error)
	Get(id string) (accessrules.Rule, error)
	Create(r accessrules.Rule, createdBy string) (accessrules.Rule, error)
	Update(id string, r accessrules.Rule) (accessrules.Rule, error)
	Delete(id string) error
}

// AccessEngine wertet die Regeln für einen Nutzer aus (implementiert von *accessrules.Engine).
type AccessEngine interface {
	PolicyFor(username string) (*accessrules.Policy, error)
}

// WithAccessRules aktiviert die Zugriffsregeln für Quellen und Senken: Verwaltung (/api/v1/access-rules) und Durchsetzung
// (gefilterte Listen, gesperrtes Schalten). Ohne diese Option bleibt alles offen.
func WithAccessRules(store AccessRuleStore, engine AccessEngine) HandlerOption {
	return func(o *handlerOptions) { o.accessStore, o.accessEngine = store, engine }
}

// accessChecker setzt die Regeln gegen die laufende Anfrage durch.
type accessChecker struct {
	engine AccessEngine
	nodes  NodeLister
	tags   SourceTagStore
	roles  func(string) (string, string, string, bool)
	authz  AuthzChecker
}

// accessScope gilt für genau eine Anfrage: die Policy des Nutzers und die bekannten Endpunkte.
type accessScope struct {
	pol *accessrules.Policy
	src map[string]accessrules.Endpoint
	snk map[string]accessrules.Endpoint
}

func (a *accessChecker) endpoints() (src, snk map[string]accessrules.Endpoint) {
	var explicit map[sourcetags.Key][]string
	if a.tags != nil {
		explicit, _ = a.tags.All()
	}
	nodes := a.nodes.List()
	src, snk = map[string]accessrules.Endpoint{}, map[string]accessrules.Endpoint{}
	for _, s := range buildSources(nodes, explicit, a.roles) {
		src[s.SenderID] = endpointOfSource(s)
	}
	for _, s := range buildSinks(nodes, explicit, a.roles) {
		snk[s.ReceiverID] = endpointOfSink(s)
	}
	return src, snk
}

func tagNames(ts []sourcetags.Tag) []string {
	out := make([]string, 0, len(ts))
	for _, t := range ts {
		out = append(out, t.Tag)
	}
	return out
}

func endpointOfSource(s SourceInfo) accessrules.Endpoint {
	return accessrules.Endpoint{ID: s.SenderID, NodeID: s.NodeID, NodeLabel: s.NodeLabel, Label: s.Label, MediaType: s.MediaType, WorkflowID: s.WorkflowID, Tags: tagNames(s.Tags)}
}

func endpointOfSink(s SinkInfo) accessrules.Endpoint {
	return accessrules.Endpoint{ID: s.ReceiverID, NodeID: s.NodeID, NodeLabel: s.NodeLabel, Label: s.Label, MediaType: s.MediaType, WorkflowID: s.WorkflowID, Tags: tagNames(s.Tags)}
}

// exempt: wer den Regeln nicht unterliegt — Engineering (configure), Dienst-Konten der Nodes, Support, und der Betrieb ohne
// Anmeldung.
func (a *accessChecker) exempt(r *http.Request) bool {
	p, ok := principalFromContext(r)
	if !ok || p.Service || p.Support {
		return true
	}
	if a.authz != nil {
		if allowed, err := a.authz.Check(p.Username, authz.AnyNode, authz.VerbConfigure); err == nil && allowed {
			return true
		}
	}
	return false
}

// scope liefert die Regeln für die Anfrage oder nil, wenn nichts einzuschränken ist.
func (a *accessChecker) scope(r *http.Request) *accessScope {
	if a == nil || a.engine == nil || a.exempt(r) {
		return nil
	}
	p, _ := principalFromContext(r)
	pol, err := a.engine.PolicyFor(p.Username)
	if err != nil || pol.Empty() {
		return nil
	}
	src, snk := a.endpoints()
	return &accessScope{pol: pol, src: src, snk: snk}
}

// Unbekannte Endpunkte (nicht in der Registry) lassen sich nicht auswerten und bleiben unberührt: dort entscheidet die bisherige
// Prüfung.
func (s *accessScope) sourceVisible(id string) bool {
	ep, ok := s.src[id]
	return !ok || s.pol.Visible(accessrules.KindSource, ep).Allowed
}

func (s *accessScope) sinkVisible(id string) bool {
	ep, ok := s.snk[id]
	return !ok || s.pol.Visible(accessrules.KindSink, ep).Allowed
}

func (s *accessScope) canRoute(from, to string) (bool, string) {
	if ep, ok := s.src[from]; ok {
		if d := s.pol.Routable(accessrules.KindSource, ep); !d.Allowed {
			return false, "Quelle: " + d.Reason
		}
	}
	if ep, ok := s.snk[to]; ok {
		if d := s.pol.Routable(accessrules.KindSink, ep); !d.Allowed {
			return false, "Senke: " + d.Reason
		}
	}
	return true, ""
}

// jsonRecorder fängt die Antwort eines Handlers ab, damit sie gefiltert werden kann.
type jsonRecorder struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (j *jsonRecorder) Header() http.Header         { return j.header }
func (j *jsonRecorder) WriteHeader(code int)        { j.status = code }
func (j *jsonRecorder) Write(b []byte) (int, error) { return j.body.Write(b) }

// filterJSON ruft next auf und lässt eine erfolgreiche JSON-Antwort von fn umschreiben. fn bekommt den Roh-Body und liefert den
// neuen (oder nil = unverändert).
func (a *accessChecker) filterJSON(next http.HandlerFunc, fn func(s *accessScope, body []byte) []byte) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sc := a.scope(r)
		if sc == nil {
			next(w, r)
			return
		}
		rec := &jsonRecorder{header: http.Header{}, status: http.StatusOK}
		next(rec, r)
		out := rec.body.Bytes()
		if rec.status == http.StatusOK {
			if nb := fn(sc, out); nb != nil {
				out = nb
			}
		}
		for k, v := range rec.header {
			if k == "Content-Length" {
				continue
			}
			w.Header()[k] = v
		}
		w.WriteHeader(rec.status)
		_, _ = w.Write(out)
	}
}

func (a *accessChecker) filterSources(next http.HandlerFunc) http.HandlerFunc {
	return a.filterJSON(next, func(s *accessScope, body []byte) []byte {
		var list []SourceInfo
		if json.Unmarshal(body, &list) != nil {
			return nil
		}
		out := list[:0]
		for _, x := range list {
			if s.sourceVisible(x.SenderID) {
				out = append(out, x)
			}
		}
		b, err := json.Marshal(out)
		if err != nil {
			return nil
		}
		return b
	})
}

func (a *accessChecker) filterSinks(next http.HandlerFunc) http.HandlerFunc {
	return a.filterJSON(next, func(s *accessScope, body []byte) []byte {
		var list []SinkInfo
		if json.Unmarshal(body, &list) != nil {
			return nil
		}
		out := list[:0]
		for _, x := range list {
			if s.sinkVisible(x.ReceiverID) {
				out = append(out, x)
			}
		}
		b, err := json.Marshal(out)
		if err != nil {
			return nil
		}
		return b
	})
}

// filterGraph entfernt nicht sichtbare Ein- und Ausgänge und die Kanten, die einen davon berühren.
func (a *accessChecker) filterGraph(next http.HandlerFunc) http.HandlerFunc {
	return a.filterJSON(next, func(s *accessScope, body []byte) []byte {
		var g graph.Graph
		if json.Unmarshal(body, &g) != nil {
			return nil
		}
		for i := range g.Nodes {
			outs := g.Nodes[i].Outputs[:0]
			for _, p := range g.Nodes[i].Outputs {
				if s.sourceVisible(p.ID) {
					outs = append(outs, p)
				}
			}
			g.Nodes[i].Outputs = outs
			ins := g.Nodes[i].Inputs[:0]
			for _, p := range g.Nodes[i].Inputs {
				if s.sinkVisible(p.ID) {
					ins = append(ins, p)
				}
			}
			g.Nodes[i].Inputs = ins
		}
		edges := g.Edges[:0]
		for _, e := range g.Edges {
			if s.sourceVisible(e.FromSender) && s.sinkVisible(e.ToReceiver) {
				edges = append(edges, e)
			}
		}
		g.Edges = edges
		b, err := json.Marshal(g)
		if err != nil {
			return nil
		}
		return b
	})
}

func (a *accessChecker) forbid(w http.ResponseWriter, r *http.Request, reason string) {
	p, _ := principalFromContext(r)
	_ = p
	http.Error(w, "forbidden: "+reason, http.StatusForbidden)
}

// guardEdgePost sperrt POST /api/v1/graph/edges, wenn Quelle oder Senke für den Nutzer nicht schaltbar ist.
func (a *accessChecker) guardEdgePost(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if sc := a.scope(r); sc != nil {
			raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
			if err != nil {
				http.Error(w, "invalid body", http.StatusBadRequest)
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(raw))
			var b struct {
				From string `json:"from"`
				To   string `json:"to"`
			}
			_ = json.Unmarshal(raw, &b)
			if ok, why := sc.canRoute(b.From, b.To); !ok {
				a.forbid(w, r, why)
				return
			}
		}
		next(w, r)
	}
}

// guardEdgeDelete sperrt DELETE /api/v1/graph/edges/{id}, wenn die Senke nicht schaltbar ist.
func (a *accessChecker) guardEdgeDelete(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if sc := a.scope(r); sc != nil {
			if ok, why := sc.canRoute("", r.PathValue("id")); !ok {
				a.forbid(w, r, why)
				return
			}
		}
		next(w, r)
	}
}

// guardInterfaceConnect sperrt das Schalten von Quellen auf einen Workflow-Eingang, wenn eine der Quellen nicht schaltbar ist.
func (a *accessChecker) guardInterfaceConnect(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if sc := a.scope(r); sc != nil {
			raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
			if err != nil {
				http.Error(w, "invalid body", http.StatusBadRequest)
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(raw))
			var b struct {
				SenderIDs []string `json:"senderIds"`
			}
			_ = json.Unmarshal(raw, &b)
			for _, id := range b.SenderIDs {
				if ok, why := sc.canRoute(id, ""); !ok {
					a.forbid(w, r, why)
					return
				}
			}
		}
		next(w, r)
	}
}

// ---- Verwaltung ---------------------------------------------------------------------------------------------------

func writeAccessError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, accessrules.ErrNotFound):
		http.Error(w, "not found", http.StatusNotFound)
	case errors.Is(err, accessrules.ErrValidation):
		http.Error(w, err.Error(), http.StatusBadRequest)
	default:
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func handleListAccessRules(store AccessRuleStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := store.List()
		if err != nil {
			writeAccessError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

func decodeRule(r *http.Request) (accessrules.Rule, error) {
	var rule accessrules.Rule
	err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&rule)
	return rule, err
}

func handleCreateAccessRule(store AccessRuleStore, audit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rule, err := decodeRule(r)
		if err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		by := actorFromRequest(r)
		created, err := store.Create(rule, by)
		if err != nil {
			writeAccessError(w, err)
			return
		}
		logDomainAudit(audit, by, "access-rule", created.ID, "created", map[string]any{"rule": created.Describe()})
		writeJSON(w, http.StatusOK, created)
	}
}

func handleUpdateAccessRule(store AccessRuleStore, audit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rule, err := decodeRule(r)
		if err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		updated, err := store.Update(r.PathValue("id"), rule)
		if err != nil {
			writeAccessError(w, err)
			return
		}
		logDomainAudit(audit, actorFromRequest(r), "access-rule", updated.ID, "updated", map[string]any{"rule": updated.Describe()})
		writeJSON(w, http.StatusOK, updated)
	}
}

func handleDeleteAccessRule(store AccessRuleStore, audit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		old, _ := store.Get(id)
		if err := store.Delete(id); err != nil {
			writeAccessError(w, err)
			return
		}
		logDomainAudit(audit, actorFromRequest(r), "access-rule", id, "deleted", map[string]any{"rule": old.Describe()})
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

type effectiveEntry struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Node     string `json:"node"`
	Media    string `json:"mediaType"`
	Visible  bool   `json:"visible"`
	Routable bool   `json:"routable"`
	Reason   string `json:"reason"`
}

// handleEffectiveAccess liefert GET /api/v1/access-rules/effective?user=<name>: was dieser Nutzer mit den Regeln sieht und
// schaltet, mit Begründung je Eintrag (Vorschau für die Verwaltung). Engineering-Konten (configure) unterliegen den Regeln
// nicht; das meldet die Antwort mit `exempt`.
func handleEffectiveAccess(a *accessChecker) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user := r.URL.Query().Get("user")
		if user == "" {
			http.Error(w, "user required", http.StatusBadRequest)
			return
		}
		exempt := false
		if a.authz != nil {
			if ok, err := a.authz.Check(user, authz.AnyNode, authz.VerbConfigure); err == nil && ok {
				exempt = true
			}
		}
		pol, err := a.engine.PolicyFor(user)
		if err != nil {
			writeAccessError(w, err)
			return
		}
		src, snk := a.endpoints()
		build := func(kind string, eps map[string]accessrules.Endpoint) []effectiveEntry {
			out := make([]effectiveEntry, 0, len(eps))
			for _, ep := range eps {
				v := pol.Visible(kind, ep)
				rt := pol.Routable(kind, ep)
				reason := rt.Reason
				if !v.Allowed {
					reason = v.Reason
				}
				if exempt {
					v, rt, reason = accessrules.Decision{Allowed: true}, accessrules.Decision{Allowed: true}, "unterliegt den Regeln nicht (Engineering)"
				}
				out = append(out, effectiveEntry{ID: ep.ID, Label: ep.Label, Node: ep.NodeLabel, Media: ep.MediaType, Visible: v.Allowed, Routable: rt.Allowed, Reason: reason})
			}
			sort.Slice(out, func(i, j int) bool {
				if out[i].Node != out[j].Node {
					return out[i].Node < out[j].Node
				}
				return out[i].Label < out[j].Label
			})
			return out
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"user": user, "exempt": exempt, "hasRules": !pol.Empty(),
			"sources": build(accessrules.KindSource, src), "sinks": build(accessrules.KindSink, snk),
		})
	}
}

// afterDelete ruft cleanup auf, wenn der Handler erfolgreich war (Status < 300): Aufräumen der Zugriffsregeln eines gelöschten
// Nutzers bzw. einer gelöschten Gruppe, ohne deren Handler zu ändern.
func afterDelete(h http.HandlerFunc, cleanup func(r *http.Request)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		h(rec, r)
		if rec.status < 300 {
			cleanup(r)
		}
	}
}

// accessRuleCleaner ist die optionale Fähigkeit des Regelspeichers, die Regeln eines Subjekts zu entfernen.
type accessRuleCleaner interface {
	DeleteForSubject(subjectType, subject string) error
}

func cleanAccessRules(store AccessRuleStore, subjectType, subject string) {
	if c, ok := store.(accessRuleCleaner); ok && subject != "" {
		_ = c.DeleteForSubject(subjectType, subject)
	}
}
