// Package uiorigin trennt die Oberflächen der Nodes von der Shell (Audit 2026-10-23 H1: „Node-JS im Orchestrator-Ursprung“). Ein Node-Bundle läuft sonst als JavaScript im
// Ursprung der Shell und handelt mit den vollen Rechten des angemeldeten Nutzers. Hier läuft es in einem iframe auf einem **zweiten Ursprung** (anderer Port desselben Rechners):
// der Browser verbietet ihm jeden Zugriff auf die Shell (DOM, localStorage), und sein einziger Weg zum Orchestrator ist ein Proxy, der ihn auf **seinen eigenen Node** beschränkt.
//
// Ablauf: die Shell fordert beim Orchestrator (angemeldet, Ursprung 1) ein Einmal-Grant für einen Node an und setzt den iframe auf `<Ursprung 2>/enter/<node>?g=<grant>`. Dort wird
// das Grant eingelöst (einmalig, 30 s), eine Sitzung nur für diesen Node angelegt und per HttpOnly-Cookie `omp_ui_<node>` an den iframe gebunden; die Sitzung trägt das Token des
// Nutzers serverseitig — der Browser-Code des Bundles sieht es nie. Anfragen des Bundles an `/api/v1/nodes/<node>/…` werden mit diesem Token an den Orchestrator weitergereicht;
// alles andere (andere Nodes, Administration, andere Pfade) wird mit 403 abgewiesen, außer ausdrücklich freigegebenen Pfaden (ExtraPaths, aus der Konfiguration des Orchestrators, nicht aus dem Node).
package uiorigin

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	grantTTL   = 30 * time.Second
	sessionTTL = 12 * time.Hour
	cookiePref = "omp_ui_"
)

var nodeIDRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

type grant struct {
	nodeID, token string
	exp           time.Time
}

type session struct {
	nodeID, token string
	exp           time.Time
}

// Manager hält Grants und Sitzungen (im Speicher; ein Neustart des Orchestrators beendet alle — die Shell holt dann ein neues Grant).
type Manager struct {
	mu       sync.Mutex
	grants   map[string]grant
	sessions map[string]session
	now      func() time.Time
}

func NewManager() *Manager {
	return &Manager{grants: map[string]grant{}, sessions: map[string]session{}, now: time.Now}
}

func randomID() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// NewGrant legt ein Einmal-Grant für (Node, Token des Nutzers) an.
func (m *Manager) NewGrant(nodeID, userToken string) (string, bool) {
	if !nodeIDRe.MatchString(nodeID) || userToken == "" {
		return "", false
	}
	id := randomID()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.gc()
	m.grants[id] = grant{nodeID: nodeID, token: userToken, exp: m.now().Add(grantTTL)}
	return id, true
}

// redeem löst ein Grant ein (einmalig) und legt die Sitzung an.
func (m *Manager) redeem(id, nodeID string) (sid string, ok bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	g, found := m.grants[id]
	delete(m.grants, id)
	if !found || g.nodeID != nodeID || !m.now().Before(g.exp) {
		return "", false
	}
	sid = randomID()
	m.sessions[sid] = session{nodeID: g.nodeID, token: g.token, exp: m.now().Add(sessionTTL)}
	return sid, true
}

func (m *Manager) lookup(sid, nodeID string) (token string, ok bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, found := m.sessions[sid]
	if !found || s.nodeID != nodeID || !m.now().Before(s.exp) {
		return "", false
	}
	return s.token, true
}

func (m *Manager) gc() {
	now := m.now()
	for k, g := range m.grants {
		if !now.Before(g.exp) {
			delete(m.grants, k)
		}
	}
	for k, s := range m.sessions {
		if !now.Before(s.exp) {
			delete(m.sessions, k)
		}
	}
}

// Config des zweiten Ursprungs.
type Config struct {
	// Main ist der Handler des Orchestrators (Ursprung 1), an den berechtigte Anfragen weitergereicht werden.
	Main http.Handler
	// ExtraPaths: zusätzlich freigegebene Pfadpräfixe (nur GET), z. B. "/api/v1/events". Kommen aus der Konfiguration des Orchestrators, nie vom Node.
	ExtraPaths []string
	// HostPage/HostJS/DesignTokens: statische Inhalte der Bundle-Hülle.
	HostJS, DesignTokens []byte
}

const hostPage = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/design-tokens.css"><style>html,body{margin:0;background:transparent;color:var(--omp-text,#e8eaed);font-family:var(--omp-font,system-ui,sans-serif)}</style><script type="module" src="/ui-host.js"></script></head><body><div id="mount"></div></body></html>`

func csp(r *http.Request) string {
	host := r.Host
	if h, _, err := splitHostPort(r.Host); err == nil {
		host = h
	}
	// Einbetten dürfen nur Seiten desselben Rechners (die Shell auf dem anderen Port).
	return "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self' data:; " +
		"object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors http://" + host + ":* https://" + host + ":*"
}

func splitHostPort(hp string) (string, string, error) {
	u, err := url.Parse("//" + hp)
	if err != nil {
		return "", "", err
	}
	return u.Hostname(), u.Port(), nil
}

func secure(r *http.Request) bool {
	return r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

// Handler ist der Handler des zweiten Ursprungs.
func (m *Manager) Handler(cfg Config) http.Handler {
	mux := http.NewServeMux()
	headers := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", csp(r))
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
	}
	mux.HandleFunc("GET /enter/{node}", func(w http.ResponseWriter, r *http.Request) {
		headers(w, r)
		node := r.PathValue("node")
		sid, ok := "", false
		if nodeIDRe.MatchString(node) {
			sid, ok = m.redeem(r.URL.Query().Get("g"), node)
		}
		if !ok {
			http.Error(w, "grant invalid or expired", http.StatusForbidden)
			return
		}
		http.SetCookie(w, &http.Cookie{Name: cookiePref + node, Value: sid, Path: "/", HttpOnly: true, Secure: secure(r), SameSite: http.SameSiteLaxMode, MaxAge: int(sessionTTL.Seconds())})
		http.Redirect(w, r, "/ui/"+node, http.StatusSeeOther)
	})
	mux.HandleFunc("GET /ui/{node}", func(w http.ResponseWriter, r *http.Request) {
		headers(w, r)
		if _, ok := m.fromCookie(r, r.PathValue("node")); !ok {
			http.Error(w, "no session", http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(hostPage))
	})
	mux.HandleFunc("GET /ui-host.js", func(w http.ResponseWriter, r *http.Request) {
		headers(w, r)
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		_, _ = w.Write(cfg.HostJS)
	})
	mux.HandleFunc("GET /design-tokens.css", func(w http.ResponseWriter, r *http.Request) {
		headers(w, r)
		w.Header().Set("Content-Type", "text/css; charset=utf-8")
		_, _ = w.Write(cfg.DesignTokens)
	})
	mux.HandleFunc("/api/v1/", func(w http.ResponseWriter, r *http.Request) {
		headers(w, r)
		m.proxy(cfg, w, r)
	})
	return mux
}

func (m *Manager) fromCookie(r *http.Request, nodeID string) (string, bool) {
	c, err := r.Cookie(cookiePref + nodeID)
	if err != nil || c.Value == "" {
		return "", false
	}
	return m.lookup(c.Value, nodeID)
}

// ownNodePath: der Node, auf dessen Pfad die Anfrage zielt ("" = kein Node-Pfad).
func ownNodePath(path string) string {
	const p = "/api/v1/nodes/"
	if !strings.HasPrefix(path, p) {
		return ""
	}
	rest := strings.TrimPrefix(path, p)
	id, _, _ := strings.Cut(rest, "/")
	if !nodeIDRe.MatchString(id) {
		return ""
	}
	return id
}

func (m *Manager) proxy(cfg Config, w http.ResponseWriter, r *http.Request) {
	// Verändernde Anfragen nur aus der eigenen Seite (der Ursprung 2 trägt ein Cookie, das der Browser von selbst mitschickt).
	if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodOptions {
		if o := r.Header.Get("Origin"); o != "" {
			u, err := url.Parse(o)
			if err != nil || !strings.EqualFold(u.Host, r.Host) {
				http.Error(w, "cross-origin request refused", http.StatusForbidden)
				return
			}
		}
		if s := r.Header.Get("Sec-Fetch-Site"); s != "" && s != "same-origin" {
			http.Error(w, "cross-origin request refused", http.StatusForbidden)
			return
		}
	}
	token := ""
	if id := ownNodePath(r.URL.Path); id != "" {
		t, ok := m.fromCookie(r, id)
		if !ok {
			http.Error(w, "no session for this node", http.StatusForbidden)
			return
		}
		token = t
	} else {
		allowed := false
		if r.Method == http.MethodGet {
			for _, p := range cfg.ExtraPaths {
				if r.URL.Path == p || strings.HasPrefix(r.URL.Path, strings.TrimSuffix(p, "/")+"/") {
					allowed = true
				}
			}
		}
		if !allowed {
			http.Error(w, "path not available to node interfaces", http.StatusForbidden)
			return
		}
		// Gemeinsame Pfade (z. B. Ereignisstrom): irgendeine gültige Sitzung genügt.
		for _, c := range r.Cookies() {
			if strings.HasPrefix(c.Name, cookiePref) {
				if t, ok := m.lookup(c.Value, strings.TrimPrefix(c.Name, cookiePref)); ok {
					token = t
					break
				}
			}
		}
		if token == "" {
			http.Error(w, "no session", http.StatusForbidden)
			return
		}
	}
	r2 := r.Clone(r.Context())
	r2.Header = r.Header.Clone()
	r2.Header.Del("Cookie")
	r2.Header.Del("Origin")
	r2.Header.Del("Sec-Fetch-Site")
	r2.Header.Set("Authorization", "Bearer "+token)
	cfg.Main.ServeHTTP(w, r2)
}
