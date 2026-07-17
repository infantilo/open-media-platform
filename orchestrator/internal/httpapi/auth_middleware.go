package httpapi

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/auth"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/consoles"
)

// AuthService authentifiziert Bearer-Tokens und meldet den Bootstrap-
// Zustand (implementiert von *auth.Service, UMSETZUNG.md D3 Teil 2).
type AuthService interface {
	UserCount(ctx context.Context) (int, error)
	Authenticate(token string) (auth.Principal, error)
	Login(ctx context.Context, username, password string) (token string, expiresAt time.Time, err error)
	CreateUser(ctx context.Context, username, password string) (auth.User, error)
	ListUsers(ctx context.Context) ([]auth.User, error)
	DeleteUser(ctx context.Context, username string) error
	SetPassword(ctx context.Context, username, password string) error
}

// AuthzChecker prüft Rollenbindungen (implementiert von *authz.Store).
type AuthzChecker interface {
	Check(subject, nodeID string, minVerb authz.Verb) (bool, error)
	Load() ([]authz.Binding, error)
	Create(subject, nodeID string, verb authz.Verb) (authz.Binding, error)
	Delete(id string) error
}

// AuditLogger protokolliert schreibende Zugriffe (implementiert von
// *audit.Store) — best-effort, kein Fehler-Rückgabewert (s.
// audit.Store.Log).
type AuditLogger interface {
	Log(username, method, path, nodeID string, status int)
}

type principalContextKey struct{}

// principalFromContext liefert den authentifizierten Nutzer, den eine
// der Middleware-Funktionen unten im Erfolgsfall im Request-Kontext
// abgelegt hat. ok=false im Bootstrap-Modus (noch kein Nutzer angelegt,
// s. authGate.authenticate) — Handler behandeln das wie "kein
// spezifischer Nutzer", nicht wie einen Fehler.
func principalFromContext(r *http.Request) (auth.Principal, bool) {
	p, ok := r.Context().Value(principalContextKey{}).(auth.Principal)
	return p, ok
}

// authGate bündelt Authentifizierung, Rollenprüfung und Audit-Logging
// für die HTTP-Handler dieses Pakets.
type authGate struct {
	auth  AuthService
	authz AuthzChecker
	audit AuditLogger
	nodes NodeLister
}

// bearerToken liest das Token aus dem Authorization-Header oder,
// ersatzweise, aus ?access_token= — der Browser-EventSource-API (für
// /api/v1/events, SSE) fehlt die Möglichkeit, eigene Header zu setzen,
// das ist eine dokumentierte Einschränkung der Web-Plattform, kein
// Design-Fehler hier. Query-Param-Tokens sind allgemein üblich für genau
// diesen Streaming-Fall (z. B. auch bei WebSockets).
func bearerToken(r *http.Request) (string, bool) {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return strings.TrimPrefix(h, "Bearer "), true
	}
	if t := r.URL.Query().Get("access_token"); t != "" {
		return t, true
	}
	return "", false
}

// authenticate liefert den Principal, ob der Bootstrap-Bypass griff
// (noch kein Nutzer angelegt — ARCHITECTURE.md §12: "Auth deaktivierbar
// solange kein Nutzer angelegt ist", Muster aus PIPELINE CONTROLLER
// übernommen, s. docs/decisions.md D3 Teil 2) und ob die Anfrage
// überhaupt authentifiziert werden konnte.
func (g *authGate) authenticate(r *http.Request) (p auth.Principal, bypass bool, ok bool) {
	count, err := g.auth.UserCount(r.Context())
	if err != nil {
		return auth.Principal{}, false, false
	}
	if count == 0 {
		return auth.Principal{}, true, true
	}
	token, present := bearerToken(r)
	if !present {
		return auth.Principal{}, false, false
	}
	p, err = g.auth.Authenticate(token)
	if err != nil {
		return auth.Principal{}, false, false
	}
	return p, false, true
}

// requireAuth verlangt nur eine gültige Anmeldung (kein Rollen-/
// Node-Scope) — für lesende Endpunkte, deren Sichtbarkeit heute noch
// nicht pro Workflow gefiltert wird (§12 Punkt 3: "Filterung ist Komfort
// … Durchsetzung bleibt beim Orchestrator", hier gibt es aktuell nur den
// einen impliziten Workflow, s. consoles.StubWorkflowID — feingranulare
// Sichtbarkeits-Filterung ist erst mit echten Workflow-Objekten, D7,
// sinnvoll).
func (g *authGate) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, bypass, ok := g.authenticate(r)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if !bypass {
			r = r.WithContext(context.WithValue(r.Context(), principalContextKey{}, p))
		}
		next(w, r)
	}
}

// requireVerbOnNode verlangt minVerb auf der Rolle des Nodes aus
// {id} im Pfad — für den generischen Node-Proxy (A8): PATCH params,
// POST methods. Node-Rolle wird exakt wie in internal/consoles aufgelöst
// (Instanz-ID, ersatzweise rohe Node-ID), damit dieselbe Bindung gilt,
// die auch die Operator-Console (§14) nutzt.
func (g *authGate) requireVerbOnNode(minVerb authz.Verb, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, bypass, ok := g.authenticate(r)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		nodeRoleID := r.PathValue("id")
		if node, found := g.nodes.Get(nodeRoleID); found {
			nodeRoleID = consoles.NodeRoleID(consoles.NodeInfo{ID: node.ID, InstanceID: node.InstanceID})
		}

		if !bypass {
			allowed, err := g.authz.Check(p.Username, nodeRoleID, minVerb)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			if !allowed {
				g.audit.Log(p.Username, r.Method, r.URL.Path, nodeRoleID, http.StatusForbidden)
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			r = r.WithContext(context.WithValue(r.Context(), principalContextKey{}, p))
		}

		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next(rec, r)
		if !bypass && r.Method != http.MethodGet {
			g.audit.Log(p.Username, r.Method, r.URL.Path, nodeRoleID, rec.status)
		}
	}
}

// requireVerbGlobal verlangt minVerb auf einer "*"-Bindung (kein
// Node-Bezug) — für Aktionen, die den ganzen (heute einzigen impliziten)
// Workflow betreffen: Graph-Verkabelung, Layouts, Snapshots, Instanz-
// Launcher, Admin-Endpunkte.
func (g *authGate) requireVerbGlobal(minVerb authz.Verb, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, bypass, ok := g.authenticate(r)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		if !bypass {
			allowed, err := g.authz.Check(p.Username, authz.AnyNode, minVerb)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			if !allowed {
				g.audit.Log(p.Username, r.Method, r.URL.Path, "", http.StatusForbidden)
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
			r = r.WithContext(context.WithValue(r.Context(), principalContextKey{}, p))
		}

		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next(rec, r)
		if !bypass && r.Method != http.MethodGet {
			g.audit.Log(p.Username, r.Method, r.URL.Path, "", rec.status)
		}
	}
}

// statusRecorder fängt den vom Handler gesetzten Status-Code ab, damit
// requireVerbOnNode/-Global ihn nach next() für den Audit-Log-Eintrag
// kennen (der generische Node-Proxy, proxy.go, ruft WriteHeader selbst
// auf — ohne diesen Wrapper bliebe der Status für den Aufrufer unsichtbar).
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}
