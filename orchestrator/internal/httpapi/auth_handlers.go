package httpapi

import (
	"encoding/json"
	"errors"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/supportaccess"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/audit"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/auth"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"

	"github.com/jackc/pgx/v5/pgconn"
)

// AuditReader liest protokollierte Zugriffe (implementiert von
// *audit.Store). before/limit sind der S5-Cursor (docs/REVIEW-2026-07-17-
// SKALIERUNG-24-7.md) — before == 0 liefert die erste Seite.
type AuditReader interface {
	List(before int64, limit int) ([]audit.Entry, error)
}

// AuditFilterReader ist die optionale Erweiterung von AuditReader um
// Filter (implementiert von *audit.Store).
type AuditFilterReader interface {
	ListFiltered(f audit.Filter) ([]audit.Entry, error)
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
//
// Sicherheits-Härtung 2026-08-10 (ARCHITECTURE.md §20.4): vorher war
// dieser Endpunkt beliebig oft aufrufbar, bcryptes Rechenkosten die
// einzige Bremse gegen automatisiertes Durchprobieren, und weder
// erfolgreiche noch fehlgeschlagene Versuche landeten im Audit-Log —
// ein Credential-Stuffing-Angriff wäre komplett spurlos geblieben.
// lockout (s. auth.LoginLockout) sperrt einen Nutzernamen nach
// wiederholten Fehlversuchen; audit protokolliert jeden Versuch
// (Erfolg/Fehlschlag/Sperre) mit dem versuchten Nutzernamen — auch bei
// einem nicht existierenden Nutzernamen, s. LoginLockout-Doku, sonst
// wäre "wird nicht geloggt" selbst wieder ein Enumerations-Orakel.
// loginLimits sind die drei Sperren des Logins (Audit 2026-10-23 M3): vorher zählte nur der Nutzername — wer ihn kannte, sperrte
// den echten Nutzer von überall aus aus. Jetzt sperrt (1) Name + Adresse (5 Fehlversuche, trifft den Angreifer, nicht den
// Nutzer an seiner Adresse), (2) die Adresse allein (viele Namen durchprobieren) und (3) der Name über alle Adressen mit
// hoher Schwelle (verteiltes Durchprobieren). `lockout` ist (1); ip und name dürfen nil sein (Tests).
type loginLimits struct{ ip, name LoginRateLimiter }

// clientIP: Adresse des Aufrufers; hinter einem Reverse-Proxy auf demselben Rechner zählt der letzte X-Forwarded-For-Eintrag
// (vom Proxy angehängt), sonst die Verbindungsadresse.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			if last := strings.TrimSpace(parts[len(parts)-1]); net.ParseIP(last) != nil {
				return last
			}
		}
	}
	return host
}

func handleLogin(authSvc AuthService, audit AuditLogger, lockout LoginRateLimiter, extra ...loginLimits) http.HandlerFunc {
	var lim loginLimits
	if len(extra) > 0 {
		lim = extra[0]
	}
	return func(w http.ResponseWriter, r *http.Request) {
		var req loginRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		ip := clientIP(r)
		nameIP := req.Username + "|" + ip

		if lockout.Locked(nameIP) || (lim.ip != nil && lim.ip.Locked(ip)) || (lim.name != nil && lim.name.Locked(req.Username)) {
			audit.Log(req.Username, r.Method, r.URL.Path, "", http.StatusTooManyRequests)
			http.Error(w, "too many failed login attempts, try again later", http.StatusTooManyRequests)
			return
		}

		token, exp, err := authSvc.Login(r.Context(), req.Username, req.Password)
		if err != nil {
			lockout.RecordFailure(nameIP)
			if lim.ip != nil {
				lim.ip.RecordFailure(ip)
			}
			if lim.name != nil {
				lim.name.RecordFailure(req.Username)
			}
			audit.Log(req.Username, r.Method, r.URL.Path, "", http.StatusUnauthorized)
			http.Error(w, "invalid credentials", http.StatusUnauthorized)
			return
		}
		lockout.RecordSuccess(nameIP)
		if lim.name != nil {
			lim.name.RecordSuccess(req.Username)
		}
		audit.Log(req.Username, r.Method, r.URL.Path, "", http.StatusOK)
		setSessionCookie(w, r, token)
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
func handleWhoami(authSvc AuthService, authzStore AuthzChecker, support ...SupportVerifier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		count, err := authSvc.UserCount(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if count == 0 {
			writeJSON(w, http.StatusOK, map[string]any{"authRequired": false, "authenticated": false, "isAdmin": true, "canConfigure": true})
			return
		}
		token, present := bearerToken(r)
		if !present {
			writeJSON(w, http.StatusOK, map[string]any{"authRequired": true, "authenticated": false, "isAdmin": false})
			return
		}
		if strings.HasPrefix(token, supportaccess.TokenPrefix) {
			var g supportaccess.Grant
			err := errors.New("support access not enabled")
			if len(support) > 0 && support[0] != nil {
				g, err = support[0].Verify(r.Context(), token)
			}
			if err != nil {
				writeJSON(w, http.StatusOK, map[string]any{"authRequired": true, "authenticated": false, "isAdmin": false})
				return
			}
			// Der Support sieht die Administration (Diagnose, Support, Zeitleiste), darf dort aber nur lesen.
			writeJSON(w, http.StatusOK, map[string]any{"authRequired": true, "authenticated": true, "username": "support:" + g.ID, "isAdmin": true, "canConfigure": false,
				"support": true, "supportExpiresAt": g.ExpiresAt, "supportNote": g.Note})
			return
		}
		p, err := authSvc.Authenticate(r.Context(), token)
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{"authRequired": true, "authenticated": false, "isAdmin": false})
			return
		}
		isAdmin, err := authzStore.Check(p.Username, authz.AnyNode, authz.VerbAdmin)
		if err != nil {
			isAdmin = false
		}
		canConfigure, err := authzStore.Check(p.Username, authz.AnyNode, authz.VerbConfigure)
		if err != nil {
			canConfigure = false
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"authRequired": true, "authenticated": true, "username": p.Username, "isAdmin": isAdmin, "canConfigure": canConfigure,
		})
	}
}

type createUserRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
	// OrgID (Kapitel 21 B14, Nachtrag 283) — leer = Default-
	// Organisation (organizations.DefaultOrgID). Ein Admin kann hier
	// gezielt eine andere, bereits angelegte Organisation angeben.
	OrgID string `json:"orgId"`
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

		// req.OrgID leer -> auth.Service.CreateUser füllt selbst den
		// Default (auth.DefaultOrgID), s. dortige Doku.
		u, err := authSvc.CreateUser(r.Context(), req.Username, req.Password, req.OrgID)
		if err != nil {
			if errors.Is(err, auth.ErrUserExists) {
				http.Error(w, "username already exists", http.StatusConflict)
				return
			}
			if errors.Is(err, auth.ErrWeakPassword) {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		if isFirstUser {
			if _, err := bindings.Create(u.Username, "", authz.AnyNode, authz.VerbAdmin); err != nil {
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
	// OrgID (Kapitel 21 B14 UI-Anbindung, Nachtrag 284) — bisher nur
	// serverseitig gepflegt (org_enforcement.go), aber nie an die UI
	// zurückgegeben; ohne dieses Feld konnte die Administration-Ansicht
	// nicht zeigen/bedienen, welcher Organisation ein Nutzer angehört.
	OrgID string `json:"orgId"`
}

// globalAdminSubjects liefert die Menge der Subjects mit einer
// "*"-admin-Bindung — sowohl für die isAdmin-Markierung in
// handleListUsers als auch für die Selbstschutz-Prüfung in
// handleDeleteUser/handleDeleteRoleBinding (§11.4b: "Der letzte
// verbleibende Admin darf sich nicht selbst löschen/degradieren").
// groupSvc darf nil sein (Gruppen-Feature nicht verdrahtet, z. B. in
// Tests) — dann bleibt das Verhalten auf direkte Bindungen beschränkt.
// Wichtig, damit die "letzter Admin"-Selbstschutzprüfung unten korrekt
// bleibt, sobald ein Admin-Recht NUR über eine Gruppe kommt (Nutzer-
// auftrag 2026-09-24: gruppenbasierte Rechteverwaltung) — sonst könnte
// sich so ein Nutzer versehentlich aussperren, ohne dass die Prüfung
// es bemerkt.
func globalAdminSubjects(bindings []authz.Binding, groupSvc GroupService) map[string]bool {
	admins := make(map[string]bool)
	for _, b := range bindings {
		if b.NodeID != authz.AnyNode || b.Verb != authz.VerbAdmin {
			continue
		}
		if b.SubjectType == authz.SubjectTypeGroup {
			if groupSvc == nil {
				continue
			}
			members, err := groupSvc.ListMembers(b.Subject)
			if err != nil {
				continue
			}
			for _, m := range members {
				admins[m] = true
			}
			continue
		}
		admins[b.Subject] = true
	}
	return admins
}

// handleListUsers ist GET /api/v1/auth/users — admin-only (server.go).
func handleListUsers(authSvc AuthService, authzStore AuthzChecker, groupSvc GroupService) http.HandlerFunc {
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
		admins := globalAdminSubjects(bindings, groupSvc)
		out := make([]userResponse, len(users))
		for i, u := range users {
			out[i] = userResponse{ID: u.ID, Username: u.Username, CreatedAt: u.CreatedAt, IsAdmin: admins[u.Username], OrgID: u.OrgID}
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
func handleDeleteUser(authSvc AuthService, authzStore AuthzChecker, groupSvc GroupService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		if p, ok := principalFromContext(r); ok && p.Username == name {
			bindings, err := authzStore.Load()
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			admins := globalAdminSubjects(bindings, groupSvc)
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
		// Nutzerfund 2026-09-24: group_members räumt sich per FK/CASCADE
		// selbst auf, role_bindings.subject ist aber polymorph (kein
		// Fremdschlüssel möglich, s. authz.Store.DeleteBySubject-Doku) —
		// ohne diesen Aufruf blieben Bindungen des gelöschten Nutzers
		// verwaist und könnten bei Wiederverwendung desselben Nutzernamens
		// alte Rechte zurückbringen. Best effort wie DeleteByWorkflow in
		// workflows.Service.Delete: ein Fehler hier bricht das bereits
		// erfolgreiche Löschen des Nutzers selbst nicht mehr ab.
		if err := authzStore.DeleteBySubject(name); err != nil {
			slog.Warn("auth: failed to clean up role bindings after user delete", "user", name, "error", err)
		}
		if fs, ok := authzStore.(featureStore); ok {
			if err := fs.DeleteFeatureGrantsBySubject(authz.SubjectTypeUser, name); err != nil {
				slog.Warn("auth: failed to clean up feature grants after user delete", "user", name, "error", err)
			}
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
			if errors.Is(err, auth.ErrWeakPassword) {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
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

type updateUserOrgRequest struct {
	OrgID string `json:"orgId"`
}

// handleUpdateUserOrg ist PUT /api/v1/auth/users/{name}/org — admin-only
// (server.go), Kapitel 21 B14 UI-Anbindung (Nachtrag 284): bisher ließ
// sich die Organisation eines Nutzers nur bei dessen Anlage setzen
// (createUserRequest.OrgID), nie danach ändern. orgId leer = Default-
// Organisation (auth.Service.UpdateUserOrg-Doku). Wirkt sofort, kein
// Re-Login nötig (OrgID kommt nie aus dem Token).
func handleUpdateUserOrg(authSvc AuthService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req updateUserOrgRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		if err := authSvc.UpdateUserOrg(r.Context(), r.PathValue("name"), req.OrgID); err != nil {
			if errors.Is(err, auth.ErrUserNotFound) {
				http.Error(w, "user not found", http.StatusNotFound)
				return
			}
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23503" {
				// Fremdschlüssel-Verstoß — orgId existiert nicht (gleiche
				// Übersetzung wie writeOrganizationError).
				http.Error(w, "organization does not exist", http.StatusBadRequest)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// handleRevokeSessions ist POST /api/v1/auth/users/{name}/revoke-sessions
// — admin-only (server.go). Sicherheits-Härtung 2026-08-10
// (ARCHITECTURE.md §20.4): invalidiert sofort jedes zuvor für {name}
// ausgestellte Token, unabhängig von einem Passwort-Wechsel (der das
// ohnehin schon automatisch mit auslöst, s. auth.Service.SetPassword)
// — für den Fall, dass ein Admin nur ein vermutlich geleaktes Token
// sperren will, ohne dem Nutzer gleich ein neues Passwort aufzuzwingen.
func handleRevokeSessions(authSvc AuthService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := authSvc.RevokeSessions(r.Context(), r.PathValue("name")); err != nil {
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
	// SubjectType (Nutzerauftrag 2026-09-24: gruppenbasierte Rechte-
	// verwaltung) — "" oder "user" (Default, unverändertes Verhalten:
	// subject ist ein Nutzername) oder "group" (subject ist eine
	// groups.id).
	SubjectType string `json:"subjectType"`
	// WorkflowID (Kapitel 12 Teil 4, §12.3e) — leer = globale/Node-
	// gescopte Bindung (unverändert), gesetzt = Workflow-Scope; NodeID
	// ist dann ein Rollenname statt einer Instanz-ID (s. authz.Binding-
	// Doku).
	WorkflowID string `json:"workflowId"`
	NodeID     string `json:"nodeId"`
	Verb       string `json:"verb"`
}

type roleBindingResponse struct {
	ID          string `json:"id"`
	Subject     string `json:"subject"`
	SubjectType string `json:"subjectType"`
	WorkflowID  string `json:"workflowId,omitempty"`
	NodeID      string `json:"nodeId"`
	Verb        string `json:"verb"`
}

func toRoleBindingResponse(b authz.Binding) roleBindingResponse {
	subjectType := b.SubjectType
	if subjectType == "" {
		subjectType = authz.SubjectTypeUser
	}
	return roleBindingResponse{ID: b.ID, Subject: b.Subject, SubjectType: subjectType, WorkflowID: b.WorkflowID, NodeID: b.NodeID, Verb: string(b.Verb)}
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
			out[i] = toRoleBindingResponse(b)
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
		var b authz.Binding
		var err error
		if req.SubjectType == authz.SubjectTypeGroup {
			b, err = store.CreateGroupBinding(req.Subject, req.WorkflowID, req.NodeID, verb)
		} else {
			b, err = store.Create(req.Subject, req.WorkflowID, req.NodeID, verb)
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusCreated, toRoleBindingResponse(b))
	}
}

// handleDeleteRoleBinding ist DELETE /api/v1/admin/role-bindings/{id} —
// admin-only (server.go). Selbstschutz analog handleDeleteUser: die
// eigene "*"-admin-Bindung zu entfernen, während man der einzige globale
// Admin ist, wird abgewiesen (§11.4b "…nicht selbst löschen/degradieren").
func handleDeleteRoleBinding(store AuthzChecker, groupSvc GroupService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if p, ok := principalFromContext(r); ok {
			bindings, err := store.Load()
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			admins := globalAdminSubjects(bindings, groupSvc)
			for _, b := range bindings {
				if b.ID != id || b.NodeID != authz.AnyNode || b.Verb != authz.VerbAdmin {
					continue
				}
				// Direkte Bindung des anfragenden Nutzers ODER eine
				// Gruppen-Bindung, in der er Mitglied ist (Nutzerauftrag
				// 2026-09-24: gruppenbasierte Rechteverwaltung — sonst
				// könnte man sich über das Löschen einer Gruppen-Bindung
				// genauso aussperren wie über eine direkte).
				affectsSelf := b.SubjectType != authz.SubjectTypeGroup && b.Subject == p.Username
				if !affectsSelf && b.SubjectType == authz.SubjectTypeGroup && groupSvc != nil {
					if members, err := groupSvc.ListMembers(b.Subject); err == nil {
						for _, m := range members {
							if m == p.Username {
								affectsSelf = true
								break
							}
						}
					}
				}
				if affectsSelf && len(admins) == 1 {
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

		q := r.URL.Query()
		var entries []audit.Entry
		var err error
		if fr, ok := reader.(AuditFilterReader); ok {
			f := audit.Filter{Before: before, Limit: limit, User: q.Get("user"), Result: q.Get("result")}
			if v, e := time.Parse(time.RFC3339, q.Get("since")); e == nil {
				f.Since = v
			}
			if v, e := time.Parse(time.RFC3339, q.Get("until")); e == nil {
				f.Until = v
			}
			// Trennzeichen U+001F: Begriffe und Muster dürfen Kommas enthalten.
			if v := q.Get("terms"); v != "" {
				f.Terms = strings.Split(v, "\x1f")
			}
			if v := q.Get("exclude"); v != "" {
				f.ExcludeLike = strings.Split(v, "\x1f")
			}
			entries, err = fr.ListFiltered(f)
		} else {
			entries, err = reader.List(before, limit)
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, entries)
	}
}

// handleSession ist POST /api/v1/auth/session: tauscht ein gültiges Bearer-Token gegen das Sitzungs-Cookie (Umstellung einer bestehenden Anmeldung aus
// localStorage, Audit H1). Nur mit Authorization-Header — ein Cookie allein erzeugt kein neues Cookie.
func handleSession(authSvc AuthService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h := r.Header.Get("Authorization")
		if !strings.HasPrefix(h, "Bearer ") {
			http.Error(w, "bearer token required", http.StatusUnauthorized)
			return
		}
		token := strings.TrimPrefix(h, "Bearer ")
		if _, err := authSvc.Authenticate(r.Context(), token); err != nil {
			http.Error(w, "invalid token", http.StatusUnauthorized)
			return
		}
		setSessionCookie(w, r, token)
		w.WriteHeader(http.StatusNoContent)
	}
}

// handleLogout ist POST /api/v1/auth/logout: löscht das Sitzungs-Cookie (das Token selbst bleibt bis zum Ablauf gültig — es gibt keinen Widerruf einzelner Tokens;
// der Sitzungszähler des Nutzers macht alle ungültig).
func handleLogout() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		clearSessionCookie(w, r)
		w.WriteHeader(http.StatusNoContent)
	}
}
