package main

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"time"
)

// cancellableRequests gibt allen Anfragen von srv einen gemeinsamen Kontext und liefert die Funktion, die ihn beendet.
func cancellableRequests(srv *http.Server) context.CancelFunc {
	ctx, cancel := context.WithCancel(context.Background())
	srv.BaseContext = func(net.Listener) context.Context { return ctx }
	return cancel
}

// drain fährt srv herunter: laufende Anfragen bekommen grace Zeit, danach endet ihr Kontext. Server-Shutdown allein
// wartet auf Dauerverbindungen (SSE, Vorschau-Streams) bis zur Frist — jeder Stopp mit offener Oberfläche dauerte so
// lange, dass das Stop-Skript den Prozess hart beendete.
func drain(srv *http.Server, endRequests context.CancelFunc, grace, timeout time.Duration) {
	defer endRequests()
	timer := time.AfterFunc(grace, endRequests)
	defer timer.Stop()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		slog.Warn("graceful shutdown failed, forcing close", "error", err)
		_ = srv.Close()
	}
}
