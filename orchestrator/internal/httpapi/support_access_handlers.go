package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/supportaccess"
)

// Befristeter Support-Zugang (UMSETZUNG.md Kap. 72.9): ein Administrator erzeugt einen Zugang mit Ablaufzeit, der Support meldet sich damit nur
// lesend an. Erlaubt sind ausschließlich die unten aufgeführten lesenden Pfade (Positivliste); jeder Versuch zu schreiben wird abgewiesen und im
// Audit-Log festgehalten.

// SupportVerifier prüft Support-Token (implementiert von *supportaccess.Store).
type SupportVerifier interface {
	Verify(ctx context.Context, token string) (supportaccess.Grant, error)
	Touch(ctx context.Context, id string)
}

// SupportAccessStore ist die Verwaltung der Zugänge (implementiert von *supportaccess.Store).
type SupportAccessStore interface {
	SupportVerifier
	Create(ctx context.Context, by, note string, d time.Duration) (supportaccess.Grant, string, error)
	List(ctx context.Context, limit int) ([]supportaccess.Grant, error)
	Revoke(ctx context.Context, id string) error
	MarkLogin(ctx context.Context, id string) error
}

// WithSupportAccess aktiviert den Support-Zugang (Verwaltung unter /api/v1/admin/support-access, Anmeldung unter /api/v1/auth/support-login).
func WithSupportAccess(s SupportAccessStore) HandlerOption {
	return func(o *handlerOptions) { o.supportAccess = s }
}

// Lesende Pfade, die ein Support-Zugang abrufen darf: alles, was zur Diagnose nötig ist, nichts mit Zugangsdaten, Nutzern oder Schreibwirkung.
var (
	supportExactPaths = map[string]bool{
		"/api/v1/version": true, "/api/v1/info": true, "/api/v1/errorcodes": true, "/api/v1/modules": true, "/api/v1/features": true,
		"/api/v1/me/features": true, "/api/v1/me/consoles": true, "/api/v1/nodes": true, "/api/v1/graph": true, "/api/v1/graph/network": true,
		"/api/v1/instances": true, "/api/v1/hosts": true, "/api/v1/hosts/local": true, "/api/v1/cluster/status": true, "/api/v1/kpi/media": true,
		"/api/v1/logs": true, "/api/v1/logs/summary": true, "/api/v1/timeline": true, "/api/v1/admin/selftest": true, "/api/v1/admin/support-bundle": true,
		"/api/v1/admin/profile": true, "/api/v1/workflows": true, "/api/v1/workflows/runs": true, "/api/v1/alarms/acks": true,
		"/api/v1/placement/advice": true, "/api/v1/scheduler/resources": true, "/api/v1/events": true, "/api/v1/catalog": true,
		"/api/v1/auth/whoami": true,
	}
	supportNodeSuffixes = []string{"/diagnosis", "/diag/pipelines"}
)

// supportMayRead: darf ein Support-Zugang diese Anfrage stellen?
func supportMayRead(method, path string) bool {
	if method != http.MethodGet && method != http.MethodHead {
		return false
	}
	if supportExactPaths[path] {
		return true
	}
	if strings.HasPrefix(path, "/api/v1/hosts/") && strings.HasSuffix(path, "/metrics/history") {
		return true
	}
	if rest, ok := strings.CutPrefix(path, "/api/v1/nodes/"); ok {
		for _, suf := range supportNodeSuffixes {
			if id, ok := strings.CutSuffix(rest, suf); ok && id != "" && !strings.Contains(id, "/") {
				return true
			}
		}
	}
	return false
}

// blockedReads merkt sich, wann ein gesperrter Lesezugriff zuletzt ins Audit-Log ging.
var blockedReads = &recentSet{window: time.Minute}

type recentSet struct {
	window time.Duration
	mu     sync.Mutex
	seen   map[string]time.Time
}

// first meldet true, wenn der Schlüssel im Zeitfenster noch nicht vorkam, und merkt ihn sich.
func (s *recentSet) first(key string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.seen == nil || len(s.seen) > 512 {
		s.seen = map[string]time.Time{}
	}
	if t, ok := s.seen[key]; ok && now.Sub(t) < s.window {
		return false
	}
	s.seen[key] = now
	return true
}

// supportReadOnly weist Anfragen eines Support-Zugangs ab, die nicht auf der Positivliste stehen (403), und hält den Versuch im Audit-Log fest.
// Anfragen ohne Support-Token laufen unverändert durch.
func supportReadOnly(g *authGate, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if g.support == nil || !strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/api/v1/auth/support-login" {
			next.ServeHTTP(w, r)
			return
		}
		token, present := bearerToken(r)
		if !present || !strings.HasPrefix(token, supportaccess.TokenPrefix) {
			next.ServeHTTP(w, r)
			return
		}
		grant, err := g.support.Verify(r.Context(), token)
		if err != nil {
			next.ServeHTTP(w, r) // ungültig/abgelaufen: die normale Prüfung antwortet 401
			return
		}
		name := "support:" + grant.ID
		if !supportMayRead(r.Method, r.URL.Path) {
			// Schreibversuche immer; gesperrte Lesezugriffe (die Administration fragt sie im Sekundentakt) höchstens einmal pro Minute und Pfad.
			if r.Method != http.MethodGet && r.Method != http.MethodHead || blockedReads.first(name+" "+r.URL.Path, time.Now()) {
				g.audit.Log(name, r.Method, r.URL.Path, "", http.StatusForbidden)
			}
			http.Error(w, "support access is read-only: this request is not allowed", http.StatusForbidden)
			return
		}
		// Das Herunterladen des Support-Pakets ist ein Datenabfluss: immer vermerken.
		if r.URL.Path == "/api/v1/admin/support-bundle" {
			g.audit.Log(name, r.Method, r.URL.Path, "", http.StatusOK)
		}
		next.ServeHTTP(w, r)
	})
}

type supportAccessView struct {
	supportaccess.Grant
	Status string `json:"status"`
}

type createSupportAccessRequest struct {
	Minutes int    `json:"minutes"`
	Note    string `json:"note"`
}

func currentUser(r *http.Request) string {
	if p, ok := principalFromContext(r); ok {
		return p.Username
	}
	return ""
}

// handleCreateSupportAccess: POST /api/v1/admin/support-access {"minutes": 240, "note": "Ticket 4711"} → das Token steht nur in dieser Antwort.
func handleCreateSupportAccess(store SupportAccessStore, audit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req createSupportAccessRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if req.Minutes == 0 {
			req.Minutes = 240
		}
		by := currentUser(r)
		g, token, err := store.Create(r.Context(), by, req.Note, time.Duration(req.Minutes)*time.Minute)
		switch {
		case errors.Is(err, supportaccess.ErrBadTime):
			http.Error(w, "duration must be between 5 minutes and 7 days", http.StatusBadRequest)
			return
		case errors.Is(err, supportaccess.ErrTooMany):
			http.Error(w, "too many active support accesses — revoke one first", http.StatusConflict)
			return
		case err != nil:
			http.Error(w, "failed to create support access", http.StatusInternalServerError)
			return
		}
		if audit != nil {
			audit.Log(by, "support_access", g.ID, "created", map[string]any{"expiresAt": g.ExpiresAt, "note": g.Note})
		}
		writeJSON(w, http.StatusOK, map[string]any{"id": g.ID, "token": token, "expiresAt": g.ExpiresAt, "note": g.Note})
	}
}

// handleListSupportAccess: GET /api/v1/admin/support-access — nie mit Token.
func handleListSupportAccess(store SupportAccessStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := store.List(r.Context(), 50)
		if err != nil {
			http.Error(w, "failed to list support accesses", http.StatusInternalServerError)
			return
		}
		now := time.Now()
		out := make([]supportAccessView, 0, len(list))
		for _, g := range list {
			out = append(out, supportAccessView{Grant: g, Status: g.Status(now)})
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// handleRevokeSupportAccess: DELETE /api/v1/admin/support-access/{id} — wirkt ab der nächsten Anfrage.
func handleRevokeSupportAccess(store SupportAccessStore, audit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		err := store.Revoke(r.Context(), id)
		if errors.Is(err, supportaccess.ErrUnknown) {
			http.Error(w, "support access not found", http.StatusNotFound)
			return
		}
		if err != nil {
			http.Error(w, "failed to revoke support access", http.StatusInternalServerError)
			return
		}
		if audit != nil {
			audit.Log(currentUser(r), "support_access", id, "revoked", nil)
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// handleSupportLogin: POST /api/v1/auth/support-login {"token": "ompsup_…"} (ohne Anmeldung) — setzt die Sitzung bis zum Ablauf des Zugangs.
func handleSupportLogin(store SupportAccessStore, audit DomainAuditLogger, lockout LoginRateLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Token string `json:"token"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&req); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		ip := clientIP(r)
		if lockout.Locked(ip) {
			http.Error(w, "too many failed attempts, try again later", http.StatusTooManyRequests)
			return
		}
		grant, err := store.Verify(r.Context(), strings.TrimSpace(req.Token))
		if err != nil {
			lockout.RecordFailure(ip)
			status, msg := http.StatusUnauthorized, "invalid support access"
			switch {
			case errors.Is(err, supportaccess.ErrExpired):
				msg = "support access expired"
			case errors.Is(err, supportaccess.ErrRevoked):
				msg = "support access revoked"
			}
			http.Error(w, msg, status)
			return
		}
		lockout.RecordSuccess(ip)
		_ = store.MarkLogin(r.Context(), grant.ID)
		if audit != nil {
			audit.Log("support:"+grant.ID, "support_access", grant.ID, "login", map[string]any{"ip": ip})
		}
		http.SetCookie(w, &http.Cookie{
			Name: sessionCookieName, Value: strings.TrimSpace(req.Token), Path: "/", HttpOnly: true, Secure: secureRequest(r), SameSite: http.SameSiteStrictMode,
			MaxAge: int(time.Until(grant.ExpiresAt).Seconds()), Expires: grant.ExpiresAt,
		})
		writeJSON(w, http.StatusOK, map[string]any{"username": "support:" + grant.ID, "expiresAt": grant.ExpiresAt, "note": grant.Note, "createdBy": grant.CreatedBy})
	}
}
