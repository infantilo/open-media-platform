// Package tracing erzeugt und trägt eine trace_id/span_id-Korrelation
// durch die Orchestrator→Node-Aufrufkette (ARCHITECTURE.md §25.1) —
// bewusst ein eigenes, schmales Schema statt vollem W3C-Trace-Context:
// der Zusatznutzen von W3C läge in Interop mit fremden OTel-Werkzeugen
// (s. ARCHITECTURE.md §25.4 Option C, dortiger optionaler OTLP-Export-
// Pfad), solange OMP selbst der einzige Konsument ist reicht ein
// schmalerer eigener Header.
package tracing

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
)

// Header-Namen, mit denen ein Trace/Span über eine Orchestrator→Node-
// HTTP-Anfrage getragen wird.
const (
	HeaderTraceID = "X-OMP-Trace-Id"
	HeaderSpanID  = "X-OMP-Span-Id"
)

type ctxKey int

const (
	traceIDKey ctxKey = iota
	spanIDKey
)

// NewID liefert eine neue Korrelations-ID — dieselbe Konvention wie
// workflows.newID/launcher.newInstanceID (16 Zufallsbytes, hex-codiert):
// kein UUID-Format nötig, es ist kein NMOS-Resource-Identifier, nur ein
// interner Korrelationsschlüssel.
func NewID() string {
	var b [16]byte
	// crypto/rand.Read auf einem festen 16-Byte-Array schlägt praktisch
	// nie fehl (gleiche Annahme wie workflows.newID) — ein Fehler hier
	// würde nur eine leere ID liefern, nie einen Absturz.
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// WithTrace hängt eine feste trace_id/span_id-Zuordnung an ctx.
func WithTrace(ctx context.Context, traceID, spanID string) context.Context {
	ctx = context.WithValue(ctx, traceIDKey, traceID)
	ctx = context.WithValue(ctx, spanIDKey, spanID)
	return ctx
}

// TraceID liest die trace_id aus ctx, "" falls keine gesetzt ist.
func TraceID(ctx context.Context) string {
	id, _ := ctx.Value(traceIDKey).(string)
	return id
}

// SpanID liest die span_id aus ctx, "" falls keine gesetzt ist.
func SpanID(ctx context.Context) string {
	id, _ := ctx.Value(spanIDKey).(string)
	return id
}

// Ensure liefert ctx unverändert zurück, falls es bereits eine trace_id
// trägt — sonst beginnt hier ein neuer Trace (neue trace_id + span_id).
// Aufrufer an der Wurzel einer Operation (z. B. ein HTTP-Handler, der
// eine IS-05-Verbindung oder einen Proxy-Aufruf entgegennimmt) rufen
// dies zuerst auf.
func Ensure(ctx context.Context) context.Context {
	if TraceID(ctx) != "" {
		return ctx
	}
	return WithTrace(ctx, NewID(), NewID())
}

// NewSpan beginnt einen neuen Span innerhalb desselben Trace (oder,
// falls ctx noch keinen trägt, einen komplett neuen Trace) — für einen
// Aufrufer, der innerhalb einer bereits laufenden Operation zu einem
// weiteren Node verzweigt (z. B. Connect, das sowohl den Receiver- als
// auch den Sender-Node PATCHt) und jedem Zweig eine eigene span_id
// geben will, ohne den gemeinsamen Trace zu verlieren.
func NewSpan(ctx context.Context) context.Context {
	trace := TraceID(ctx)
	if trace == "" {
		trace = NewID()
	}
	return WithTrace(ctx, trace, NewID())
}

// SetHeaders setzt die Trace-Header auf einer ausgehenden Anfrage —
// erzeugt bei Bedarf selbst einen Trace (ein Aufrufer, der Ensure/
// NewSpan vergessen hat, bekommt trotzdem eine Korrelations-ID, nur als
// Trace mit einem einzigen Span statt absichtlich verzweigt).
func SetHeaders(req *http.Request, ctx context.Context) {
	ctx = Ensure(ctx)
	req.Header.Set(HeaderTraceID, TraceID(ctx))
	req.Header.Set(HeaderSpanID, SpanID(ctx))
}

// FromRequest liest eingehende Trace-Header (z. B. ein Node, der einen
// vom Orchestrator weitergereichten Trace übernimmt) oder beginnt einen
// neuen, falls keine vorhanden sind — liefert immer einen gültigen
// Trace-Kontext.
func FromRequest(r *http.Request) context.Context {
	trace := r.Header.Get(HeaderTraceID)
	if trace == "" {
		return Ensure(r.Context())
	}
	span := r.Header.Get(HeaderSpanID)
	if span == "" {
		span = NewID()
	}
	return WithTrace(r.Context(), trace, span)
}
