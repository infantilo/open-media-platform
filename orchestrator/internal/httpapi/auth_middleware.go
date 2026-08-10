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
	Authenticate(ctx context.Context, token string) (auth.Principal, error)
	Login(ctx context.Context, username, password string) (token string, expiresAt time.Time, err error)
	CreateUser(ctx context.Context, username, password string) (auth.User, error)
	ListUsers(ctx context.Context) ([]auth.User, error)
	DeleteUser(ctx context.Context, username string) error
	SetPassword(ctx context.Context, username, password string) error
	// RevokeSessions (Sicherheits-Härtung 2026-08-10, ARCHITECTURE.md
	// §20.4) — s. handleRevokeSessions.
	RevokeSessions(ctx context.Context, username string) error
	// IssueServiceToken (ARCHITECTURE.md §24.1, UMSETZUNG.md C16) — s.
	// handleIssueServiceToken.
	IssueServiceToken(instanceID string) (token string, expiresAt time.Time, err error)
}

// AuthzChecker prüft Rollenbindungen (implementiert von *authz.Store).
type AuthzChecker interface {
	Check(subject, nodeID string, minVerb authz.Verb) (bool, error)
	// CheckWorkflow (Kapitel 12 Teil 4, §12.3e) prüft eine Workflow-
	// gescopte Bindung — role ist ein Rollenname aus
	// workflows.Definition.Roles, keine Instanz-ID.
	CheckWorkflow(subject, workflowID, role string, minVerb authz.Verb) (bool, error)
	Load() ([]authz.Binding, error)
	Create(subject, workflowID, nodeID string, verb authz.Verb) (authz.Binding, error)
	Delete(id string) error
}

// WorkflowRoleFinder löst auf, ob ein Node aktuell eine Rolle in einem
// Workflow erfüllt (implementiert von *workflows.Service, Kapitel 12
// Teil 4) — für requireVerbOnNode, um eine konkrete Node-ID auf einen
// stabilen (Workflow, Rolle)-Wirkungsbereich abzubilden.
type WorkflowRoleFinder interface {
	FindRoleForNode(nodeID string) (workflowID, workflowName, role string, ok bool)
}

// AuditLogger protokolliert schreibende Zugriffe (implementiert von
// *audit.Store) — best-effort, kein Fehler-Rückgabewert (s.
// audit.Store.Log).
type AuditLogger interface {
	Log(username, method, path, nodeID string, status int)
}

// LoginRateLimiter drosselt Login-Versuche pro Nutzername (implementiert
// von *auth.LoginLockout, Sicherheits-Härtung 2026-08-10,
// ARCHITECTURE.md §20.4) — s. handleLogin.
type LoginRateLimiter interface {
	Locked(username string) bool
	RecordFailure(username string)
	RecordSuccess(username string)
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
	auth      AuthService
	authz     AuthzChecker
	audit     AuditLogger
	nodes     NodeLister
	workflows WorkflowRoleFinder // Kapitel 12 Teil 4 — darf nil sein (Tests)
}

// queryTokenAllowedPath meldet, ob r.URL.Path einer der wenigen Routen
// entspricht, für die bearerToken() unten den ?access_token=-Fallback
// akzeptiert — jede davon wird vom Browser über eine Web-API aufgerufen,
// die keine eigenen Header setzen kann:
//   - GET /api/v1/events (SSE, EventSource-API).
//   - GET /api/v1/nodes/<id>/ui/bundle.js (natives import() umgeht den
//     in ui/shell/auth.ts gepatchten fetch()-Wrapper, s. dortige Doku in
//     ui/shell/ui-bundle.ts).
//   - GET /api/v1/nodes/<id>/stream/<name> (Node-Stream-Proxy, K4 —
//     MJPEG-Vorschau/Level-SSE je nach Stream-Typ, aus demselben Grund).
//
// Explizite Allowlist statt Header-Heuristik (z. B. `Accept: text/
// event-stream`): eine Heuristik hätte den import()-Fall übersehen
// (dessen Accept-Header ist nicht text/event-stream) — live beim
// Schreiben dieser Änderung bemerkt, bevor es zur Regression wurde. Beim
// Hinzufügen eines künftigen Endpunkts mit demselben "Browser-API ohne
// eigene Header"-Bedürfnis: hier ergänzen.
func queryTokenAllowedPath(path string) bool {
	if path == "/api/v1/events" {
		return true
	}
	if !strings.HasPrefix(path, "/api/v1/nodes/") {
		return false
	}
	return strings.HasSuffix(path, "/ui/bundle.js") || strings.Contains(path, "/stream/")
}

// bearerToken liest das Token aus dem Authorization-Header oder,
// ersatzweise (nur für queryTokenAllowedPath-Routen), aus ?access_token=.
//
// Sicherheits-Härtung 2026-08-10 (ARCHITECTURE.md §20.4): der Fallback
// galt zuvor für JEDEN Request, nicht nur für die drei Routen, die ihn
// tatsächlich brauchen — ein Token in der URL landet in Browser-
// Historie/Server-Logs/Referrer-Headern, eine unnötig breite
// Angriffsfläche für alle anderen (insbesondere schreibenden)
// Endpunkte, die den Fallback nie nutzen.
func bearerToken(r *http.Request) (string, bool) {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return strings.TrimPrefix(h, "Bearer "), true
	}
	if queryTokenAllowedPath(r.URL.Path) {
		if t := r.URL.Query().Get("access_token"); t != "" {
			return t, true
		}
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
	p, err = g.auth.Authenticate(r.Context(), token)
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
//
// Kapitel 12 Teil 4 (§12.3e): eine global/Node-gescopte Bindung (wie
// bisher) genügt weiterhin; fehlt die, wird zusätzlich geprüft, ob der
// Node gerade eine Rolle in einem Workflow erfüllt, für die subject eine
// Workflow-gescopte Bindung hat (der Bildmeister-Fall: "nur den
// Bildmischer in Regieplatz 1", stabil über Rollen-Neustarts hinweg,
// anders als eine Instanz-ID-Bindung).
func (g *authGate) requireVerbOnNode(minVerb authz.Verb, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, bypass, ok := g.authenticate(r)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		pathID := r.PathValue("id")
		nodeRoleID := pathID
		rawNodeID := pathID
		if node, found := g.nodes.Get(pathID); found {
			nodeRoleID = consoles.NodeRoleID(consoles.NodeInfo{ID: node.ID, InstanceID: node.InstanceID})
			rawNodeID = node.ID
		}

		if !bypass {
			allowed, err := g.authz.Check(p.Username, nodeRoleID, minVerb)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			if !allowed && g.workflows != nil {
				if workflowID, _, role, found := g.workflows.FindRoleForNode(rawNodeID); found {
					allowed, err = g.authz.CheckWorkflow(p.Username, workflowID, role, minVerb)
					if err != nil {
						http.Error(w, err.Error(), http.StatusInternalServerError)
						return
					}
				}
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

// Flush leitet an den zugrundeliegenden ResponseWriter weiter, sofern er
// http.Flusher unterstützt — ohne das würde eine Einbettung von
// http.ResponseWriter als Interface-Feld die Flusher-Fähigkeit *nicht*
// automatisch mitbringen (Go promotet nur Methoden des statischen
// Feld-Typs, nicht die des zugrundeliegenden konkreten Werts). S8
// (docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md) wickelt mit
// countRequests jetzt *jeden* Request in einen statusRecorder — ohne
// dieses Flush() bräche das SSE-Streaming (GET /api/v1/events)
// still, weil dessen eigener `w.(http.Flusher)`-Type-Assert dann immer
// fehlschlägt (per Testlauf gefunden:
// TestHandleEventsStreamsBroadcastEvents scheiterte mit "streaming
// unsupported").
func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
