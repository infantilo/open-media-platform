package main

import (
	"log/slog"
	"net"
	"net/http"
	"net/http/pprof"
	"os"
)

// startPprof öffnet auf Wunsch (OMP_PPROF_ADDR, z. B. 127.0.0.1:6060) einen CPU-/Heap-Profil-Zugang für die Fehlersuche
// bei hoher Grundlast. Standard aus. Nur auf Loopback erlaubt — ein Profil verrät Interna und gehört nie ins Netz.
func startPprof() {
	addr := os.Getenv("OMP_PPROF_ADDR")
	if addr == "" {
		return
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil || (host != "127.0.0.1" && host != "::1" && host != "localhost") {
		slog.Warn("OMP_PPROF_ADDR ignoriert: nur Loopback-Adressen erlaubt (z. B. 127.0.0.1:6060)", "addr", addr)
		return
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/heap", pprof.Index)
	mux.HandleFunc("/debug/pprof/goroutine", pprof.Index)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	go func() {
		slog.Info("pprof-Zugang offen (nur Loopback)", "addr", addr)
		if err := http.ListenAndServe(addr, mux); err != nil {
			slog.Warn("pprof-Zugang beendet", "error", err)
		}
	}()
}
