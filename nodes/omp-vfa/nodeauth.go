package main

import (
	"crypto/subtle"
	"net/http"
	"os"
	"strings"
)

// requireNodeToken (Audit 2026-10-23 B1): ist OMP_NODE_API_TOKEN gesetzt (der Orchestrator gibt es jedem Node, den er startet), bedient der Node nur
// Anfragen mit dem Header X-OMP-Node-Token. Offen bleiben CORS-Preflight, GET /https-info und lesende NMOS-Routen — dieselbe Regel wie
// omp_node_sdk::nodeauth im Rust-SDK. Ohne die Variable ändert sich nichts.
func requireNodeToken(next http.Handler) http.Handler {
	want := os.Getenv("OMP_NODE_API_TOKEN")
	if want == "" {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		open := r.Method == http.MethodOptions ||
			(r.Method == http.MethodGet && (r.URL.Path == "/https-info" || r.URL.Path == "/x-nmos" || strings.HasPrefix(r.URL.Path, "/x-nmos/")))
		if !open && subtle.ConstantTimeCompare([]byte(r.Header.Get("X-OMP-Node-Token")), []byte(want)) != 1 {
			http.Error(w, "node api token required", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
