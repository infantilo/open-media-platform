package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/audit"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/auth"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
)

// AuditReader liest protokollierte Zugriffe (implementiert von
// *audit.Store).
type AuditReader interface {
	List(limit int) ([]audit.Entry, error)
}

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type loginResponse struct {
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expiresAt"`
	Username  string    `json:"username"`
}

// handleLogin ist POST /api/v1/auth/login — unauthentifiziert erreichbar
// (sonst könnte sich niemand je anmelden), liefert ein Bearer-Token
// (NMOS IS-10/BCP-003-02-Transportkonvention, ARCHITECTURE.md §12).
func handleLogin(authSvc AuthService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req loginRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		token, exp, err := authSvc.Login(r.Context(), req.Username, req.Password)
		if err != nil {
			http.Error(w, "invalid credentials", http.StatusUnauthorized)
			return
		}
		writeJSON(w, http.StatusOK, loginResponse{Token: token, ExpiresAt: exp, Username: req.Username})
	}
}

// handleWhoami ist GET /api/v1/auth/whoami — bewusst unauthentifiziert
// erreichbar (nicht hinter authGate), damit die UI vor dem ersten Login
// herausfinden kann, ob überhaupt eine Anmeldung nötig ist
// (`authRequired`), ohne selbst raten zu müssen.
func handleWhoami(authSvc AuthService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		count, err := authSvc.UserCount(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if count == 0 {
			writeJSON(w, http.StatusOK, map[string]any{"authRequired": false, "authenticated": false})
			return
		}
		token, present := bearerToken(r)
		if !present {
			writeJSON(w, http.StatusOK, map[string]any{"authRequired": true, "authenticated": false})
			return
		}
		p, err := authSvc.Authenticate(token)
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"authRequired": true, "authenticated": false})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"authRequired": true, "authenticated": true, "username": p.Username})
	}
}

type createUserRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// handleCreateUser ist POST /api/v1/auth/users. Ob der Aufruf
// unauthentifiziert erlaubt ist, entscheidet ausschließlich das Routing
// in server.go (hinter g.requireVerbGlobal(authz.VerbAdmin, …) — dessen
// Bootstrap-Bypass greift automatisch, solange UserCount()==0, s.
// authGate.authenticate). Dieser Handler kümmert sich nur um die zweite
// Hälfte des Bootstrap-Falls: der allererste angelegte Nutzer bekommt
// automatisch eine Wildcard-admin-Bindung, sonst könnte sich niemand
// mehr Rechte geben (kein Henne-Ei-Ausweg sonst).
func handleCreateUser(authSvc AuthService, bindings AuthzChecker) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req createUserRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Username == "" || req.Password == "" {
			http.Error(w, "username and password required", http.StatusBadRequest)
			return
		}
		count, err := authSvc.UserCount(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		isFirstUser := count == 0

		u, err := authSvc.CreateUser(r.Context(), req.Username, req.Password)
		if err != nil {
			if errors.Is(err, auth.ErrUserExists) {
				http.Error(w, "username already exists", http.StatusConflict)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		if isFirstUser {
			if _, err := bindings.Create(u.Username, authz.AnyNode, authz.VerbAdmin); err != nil {
				http.Error(w, "user created but bootstrap admin binding failed: "+err.Error(), http.StatusInternalServerError)
				return
			}
		}
		writeJSON(w, http.StatusCreated, map[string]string{"id": u.ID, "username": u.Username})
	}
}

type roleBindingRequest struct {
	Subject string `json:"subject"`
	NodeID  string `json:"nodeId"`
	Verb    string `json:"verb"`
}

type roleBindingResponse struct {
	ID      string `json:"id"`
	Subject string `json:"subject"`
	NodeID  string `json:"nodeId"`
	Verb    string `json:"verb"`
}

var validVerbs = map[string]authz.Verb{
	"view":      authz.VerbView,
	"operate":   authz.VerbOperate,
	"configure": authz.VerbConfigure,
	"admin":     authz.VerbAdmin,
}

// handleListRoleBindings ist GET /api/v1/admin/role-bindings — admin-
// only (server.go), löst data/role-bindings.json (C13-Stub) als
// verwaltbare Ressource ab.
func handleListRoleBindings(store AuthzChecker) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		bindings, err := store.Load()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]roleBindingResponse, len(bindings))
		for i, b := range bindings {
			out[i] = roleBindingResponse{ID: b.ID, Subject: b.Subject, NodeID: b.NodeID, Verb: string(b.Verb)}
		}
		writeJSON(w, http.StatusOK, out)
	}
}

func handleCreateRoleBinding(store AuthzChecker) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req roleBindingRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Subject == "" || req.NodeID == "" {
			http.Error(w, "subject and nodeId required", http.StatusBadRequest)
			return
		}
		verb, ok := validVerbs[req.Verb]
		if !ok {
			http.Error(w, "invalid verb (want view|operate|configure|admin)", http.StatusBadRequest)
			return
		}
		b, err := store.Create(req.Subject, req.NodeID, verb)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusCreated, roleBindingResponse{ID: b.ID, Subject: b.Subject, NodeID: b.NodeID, Verb: string(b.Verb)})
	}
}

func handleDeleteRoleBinding(store AuthzChecker) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := store.Delete(r.PathValue("id")); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// handleListAuditLog ist GET /api/v1/admin/audit-log — admin-only
// (ARCHITECTURE.md §12 Punkt 4).
func handleListAuditLog(reader AuditReader) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		entries, err := reader.List(200)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, entries)
	}
}
