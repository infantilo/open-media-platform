package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/audit"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/auth"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
)

// AuditReader liest protokollierte Zugriffe (implementiert von
// *audit.Store). before/limit sind der S5-Cursor (docs/REVIEW-2026-07-17-
// SKALIERUNG-24-7.md) — before == 0 liefert die erste Seite.
type AuditReader interface {
	List(before int64, limit int) ([]audit.Entry, error)
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
//
// `isAdmin` (Kapitel 11 Teil 1, docs/END-GOAL-FEATURES.md §11.4) sagt der
// Shell, ob der Administration-Tab gerendert werden soll — im Bootstrap-
// Fall (count==0) bewusst true, sonst könnte niemand je den allerersten
// Nutzer über die UI anlegen (derselbe Bypass-Gedanke wie in
// handleCreateUser/authGate.authenticate).
func handleWhoami(authSvc AuthService, authzStore AuthzChecker) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		count, err := authSvc.UserCount(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if count == 0 {
			writeJSON(w, http.StatusOK, map[string]any{"authRequired": false, "authenticated": false, "isAdmin": true})
			return
		}
		token, present := bearerToken(r)
		if !present {
			writeJSON(w, http.StatusOK, map[string]any{"authRequired": true, "authenticated": false, "isAdmin": false})
			return
		}
		p, err := authSvc.Authenticate(token)
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"authRequired": true, "authenticated": false, "isAdmin": false})
			return
		}
		isAdmin, err := authzStore.Check(p.Username, authz.AnyNode, authz.VerbAdmin)
		if err != nil {
			isAdmin = false
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"authRequired": true, "authenticated": true, "username": p.Username, "isAdmin": isAdmin,
		})
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

type userResponse struct {
	ID        string    `json:"id"`
	Username  string    `json:"username"`
	CreatedAt time.Time `json:"createdAt"`
	IsAdmin   bool      `json:"isAdmin"`
}

// globalAdminSubjects liefert die Menge der Subjects mit einer
// "*"-admin-Bindung — sowohl für die isAdmin-Markierung in
// handleListUsers als auch für die Selbstschutz-Prüfung in
// handleDeleteUser/handleDeleteRoleBinding (§11.4b: "Der letzte
// verbleibende Admin darf sich nicht selbst löschen/degradieren").
func globalAdminSubjects(bindings []authz.Binding) map[string]bool {
	admins := make(map[string]bool)
	for _, b := range bindings {
		if b.NodeID == authz.AnyNode && b.Verb == authz.VerbAdmin {
			admins[b.Subject] = true
		}
	}
	return admins
}

// handleListUsers ist GET /api/v1/auth/users — admin-only (server.go).
func handleListUsers(authSvc AuthService, authzStore AuthzChecker) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		users, err := authSvc.ListUsers(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		bindings, err := authzStore.Load()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		admins := globalAdminSubjects(bindings)
		out := make([]userResponse, len(users))
		for i, u := range users {
			out[i] = userResponse{ID: u.ID, Username: u.Username, CreatedAt: u.CreatedAt, IsAdmin: admins[u.Username]}
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// handleDeleteUser ist DELETE /api/v1/auth/users/{name} — admin-only
// (server.go). Selbstschutz: wer sich selbst löscht und der einzige
// globale Admin ist, wird abgewiesen (§11.4b) — sonst könnte sich der
// letzte Admin versehentlich aussperren, ohne Henne-Ei-Ausweg (derselbe
// Bootstrap-Mechanismus in handleCreateUser greift nur beim allerersten
// Nutzer, nicht danach).
func handleDeleteUser(authSvc AuthService, authzStore AuthzChecker) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		if p, ok := principalFromContext(r); ok && p.Username == name {
			bindings, err := authzStore.Load()
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			admins := globalAdminSubjects(bindings)
			if admins[name] && len(admins) == 1 {
				http.Error(w, "cannot delete the last remaining admin", http.StatusConflict)
				return
			}
		}
		if err := authSvc.DeleteUser(r.Context(), name); err != nil {
			if errors.Is(err, auth.ErrUserNotFound) {
				http.Error(w, "user not found", http.StatusNotFound)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

type resetPasswordRequest struct {
	Password string `json:"password"`
}

// handleResetPassword ist PUT /api/v1/auth/users/{name}/password —
// admin-only (server.go). Kein Selbstschutz nötig (im Gegensatz zu
// Löschen/Derank verliert niemand dadurch Rechte).
func handleResetPassword(authSvc AuthService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req resetPasswordRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Password == "" {
			http.Error(w, "password required", http.StatusBadRequest)
			return
		}
		if err := authSvc.SetPassword(r.Context(), r.PathValue("name"), req.Password); err != nil {
			if errors.Is(err, auth.ErrUserNotFound) {
				http.Error(w, "user not found", http.StatusNotFound)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
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

// handleDeleteRoleBinding ist DELETE /api/v1/admin/role-bindings/{id} —
// admin-only (server.go). Selbstschutz analog handleDeleteUser: die
// eigene "*"-admin-Bindung zu entfernen, während man der einzige globale
// Admin ist, wird abgewiesen (§11.4b "…nicht selbst löschen/degradieren").
func handleDeleteRoleBinding(store AuthzChecker) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if p, ok := principalFromContext(r); ok {
			bindings, err := store.Load()
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			admins := globalAdminSubjects(bindings)
			for _, b := range bindings {
				if b.ID == id && b.Subject == p.Username && b.NodeID == authz.AnyNode && b.Verb == authz.VerbAdmin && len(admins) == 1 {
					http.Error(w, "cannot remove your own last remaining admin binding", http.StatusConflict)
					return
				}
			}
		}
		if err := store.Delete(id); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// defaultAuditLogLimit/maxAuditLogLimit begrenzen ?limit= (S5,
// docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md) — maxAuditLogLimit
// entspricht dem bisherigen festen Fenster, jetzt als Obergrenze statt
// als einzige Option.
const (
	defaultAuditLogLimit = 50
	maxAuditLogLimit     = 200
)

// handleListAuditLog ist GET /api/v1/admin/audit-log?before=<id>&limit=
// — admin-only (ARCHITECTURE.md §12 Punkt 4). Cursor-Pagination (S5):
// before fehlt/0 liefert die erste (neueste) Seite, ein späterer Aufruf
// mit before = kleinste bisher gesehene ID liefert die nächste Seite
// ("Mehr laden" in admin-view.ts). Ungültige/fehlende Query-Parameter
// fallen still auf ihre Defaults zurück statt eines 400 — dieselbe
// Nachsichtigkeit wie bei anderen rein lesenden List-Endpunkten in
// diesem Paket.
func handleListAuditLog(reader AuditReader) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var before int64
		if v := r.URL.Query().Get("before"); v != "" {
			if parsed, err := strconv.ParseInt(v, 10, 64); err == nil && parsed > 0 {
				before = parsed
			}
		}
		limit := defaultAuditLogLimit
		if v := r.URL.Query().Get("limit"); v != "" {
			if parsed, err := strconv.Atoi(v); err == nil && parsed > 0 {
				limit = parsed
			}
		}
		if limit > maxAuditLogLimit {
			limit = maxAuditLogLimit
		}

		entries, err := reader.List(before, limit)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, entries)
	}
}
