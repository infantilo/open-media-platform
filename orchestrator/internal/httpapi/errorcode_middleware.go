package httpapi

import (
	"bytes"
	"net/http"
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/errcodes"
)

// ErrorCodeHeader ist der Antwort-Header mit dem Fehlercode (OMP-nnnn) einer fehlgeschlagenen Anfrage (UMSETZUNG.md Kap. 72.8).
// Der Katalog (GET /api/v1/errorcodes) erklärt ihn mit Ursache und Lösungsschritten; Aufrufer (Oberfläche, Skripte, Support) müssen den
// Antworttext nicht erst selbst deuten.
const ErrorCodeHeader = "X-Omp-Error-Code"

// maxErrorBody begrenzt, wie viel einer Fehlerantwort für die Zuordnung gepuffert wird.
const maxErrorBody = 8 << 10

// errorCodeHeader ergänzt Antworten ab Status 400 um ErrorCodeHeader. Nur Fehlerantworten werden kurz gepuffert (der Header muss vor dem
// Status stehen); Erfolgsantworten, Ströme (SSE) und Weiterleitungen laufen unverändert durch.
func errorCodeHeader(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		cw := &codeWriter{ResponseWriter: w}
		next.ServeHTTP(cw, r)
		cw.finish()
	})
}

type codeWriter struct {
	http.ResponseWriter
	status    int
	wrote     bool
	buffering bool
	buf       bytes.Buffer
}

func (w *codeWriter) WriteHeader(code int) {
	if w.wrote {
		return
	}
	w.wrote, w.status = true, code
	if code >= 400 {
		w.buffering = true
		return
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *codeWriter) Write(b []byte) (int, error) {
	if !w.wrote {
		w.WriteHeader(http.StatusOK)
	}
	if !w.buffering {
		return w.ResponseWriter.Write(b)
	}
	if room := maxErrorBody - w.buf.Len(); room > 0 {
		w.buf.Write(b[:min(len(b), room)])
	}
	return len(b), nil
}

// Flush gibt nur Erfolgsantworten und Ströme frei; eine gepufferte Fehlerantwort geht erst in finish hinaus.
func (w *codeWriter) Flush() {
	if w.buffering {
		return
	}
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (w *codeWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *codeWriter) finish() {
	if !w.buffering {
		return
	}
	if code := errorCodeFor(w.status, w.buf.String()); code != "" {
		w.Header().Set(ErrorCodeHeader, code)
	}
	w.ResponseWriter.WriteHeader(w.status)
	_, _ = w.ResponseWriter.Write(w.buf.Bytes())
}

// errorCodeFor ordnet eine Fehlerantwort einem Code zu: erst nach dem Text, sonst nach dem Status (401/403).
func errorCodeFor(status int, body string) string {
	if e, ok := errcodes.Classify(body); ok {
		return e.Code
	}
	switch status {
	case http.StatusUnauthorized:
		return "OMP-6001"
	case http.StatusForbidden:
		return "OMP-6002"
	}
	return ""
}
