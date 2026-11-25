package httpapi

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/safego"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/tracing"
)

// CommandMirror (Kapitel 109 Stufe C): hat der Node die Primärrolle mit einem Live-Standby, liefert MirrorTarget die
// API-Basis-URL des Standby; Bedienbefehle an den Primär werden dann zusätzlich an den Standby gesendet, damit dessen
// Bedienzustand dem des Primär laufend folgt. MirrorFailed meldet einen nicht zugestellten Befehl (der Standby wird dann
// beim nächsten Takt vollständig nachgezogen). Implementiert von *workflows.Service.
type CommandMirror interface {
	MirrorTarget(nodeID string) (baseURL string, ok bool)
	MirrorFailed(nodeID string)
}

// commandMirrorTap leitet einen erfolgreich beantworteten ändernden Aufruf (Methode, Parameter, Zustand) zusätzlich an den
// Live-Standby des Nodes weiter. Der Primär antwortet zuerst und unverändert; der Standby bekommt denselben Pfad und
// Body kurz danach (Zehntelmillisekunden bis wenige Millisekunden — „wirksam im selben Bild“ ist damit wahrscheinlich, aber
// nicht garantiert; ein Zeitstempel je Befehl wäre Stufe D).
func commandMirrorTap(next http.HandlerFunc, mirror CommandMirror, client *http.Client) http.HandlerFunc {
	if mirror == nil {
		return next
	}
	if client == nil {
		client = http.DefaultClient
	}
	return func(w http.ResponseWriter, r *http.Request) {
		nodeID := r.PathValue("id")
		target, ok := mirror.MirrorTarget(nodeID)
		if !ok {
			next(w, r)
			return
		}
		var raw []byte
		if r.Body != nil {
			raw, _ = io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
			r.Body = io.NopCloser(bytes.NewReader(raw))
		}
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next(rec, r)
		if rec.status >= 300 {
			return
		}
		// Pfad hinter /api/v1/nodes/{id} unverändert übernehmen
		prefix := "/api/v1/nodes/" + nodeID
		path := strings.TrimPrefix(r.URL.Path, prefix)
		if path == r.URL.Path {
			return
		}
		url := strings.TrimRight(target, "/") + path
		if r.URL.RawQuery != "" {
			url += "?" + r.URL.RawQuery
		}
		method, ct, ctx := r.Method, r.Header.Get("Content-Type"), tracing.FromRequest(r)
		safego.Go("httpapi.commandMirror", func() {
			cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer cancel()
			req, err := http.NewRequestWithContext(cctx, method, url, bytes.NewReader(raw))
			if err != nil {
				mirror.MirrorFailed(nodeID)
				return
			}
			if ct != "" {
				req.Header.Set("Content-Type", ct)
			}
			tracing.SetHeaders(req, ctx)
			resp, err := client.Do(req)
			if err != nil || resp.StatusCode >= 300 {
				if resp != nil {
					resp.Body.Close()
				}
				slog.Warn("command mirror: standby did not accept the command", "node", nodeID, "path", path, "error", err)
				mirror.MirrorFailed(nodeID)
				return
			}
			resp.Body.Close()
		})
	}
}
