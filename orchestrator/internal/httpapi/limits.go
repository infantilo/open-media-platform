package httpapi

import (
	"net/http"
	"strings"
	"time"
)

// Grenzen des HTTP-Servers (Audit 2026-10-23 H8): ohne sie hielt ein langsamer oder riesiger Request Verbindungen
// und Speicher beliebig lange. SSE/WebSocket/Downloads/Uploads haben bewusst keine Gesamtzeit — dafür gilt die
// Kopfzeit-Grenze, und nur JSON-Bodies bekommen Größe und Lesezeit.
const (
	ServerReadHeaderTimeout = 10 * time.Second
	ServerIdleTimeout       = 2 * time.Minute
	ServerMaxHeaderBytes    = 256 << 10
	maxJSONBodyBytes        = 32 << 20
	jsonBodyReadTimeout     = 60 * time.Second
)

// ConfigureServer setzt Kopf-/Leerlauf-Grenzen.
func ConfigureServer(srv *http.Server) {
	srv.ReadHeaderTimeout = ServerReadHeaderTimeout
	srv.IdleTimeout = ServerIdleTimeout
	srv.MaxHeaderBytes = ServerMaxHeaderBytes
}

// LimitRequests begrenzt JSON-Bodies auf maxJSONBodyBytes und deren Lesezeit auf jsonBodyReadTimeout. Andere
// Inhaltstypen (Uploads, Medien) bleiben unberührt; Handler mit engerem eigenen Limit behalten es.
func LimitRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil && r.Body != http.NoBody && strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
			r.Body = http.MaxBytesReader(w, r.Body, maxJSONBodyBytes)
			rc := http.NewResponseController(w)
			if err := rc.SetReadDeadline(time.Now().Add(jsonBodyReadTimeout)); err == nil {
				defer func() { _ = rc.SetReadDeadline(time.Time{}) }()
			}
		}
		next.ServeHTTP(w, r)
	})
}
