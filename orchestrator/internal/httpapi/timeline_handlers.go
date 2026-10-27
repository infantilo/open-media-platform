package httpapi

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/timeline"
)

// Ereignis-Zeitleiste (UMSETZUNG.md Kap. 72.6).

// WithTimeline aktiviert GET /api/v1/timeline und POST /api/v1/timeline/marker.
func WithTimeline(src timeline.Sources) HandlerOption {
	return func(o *handlerOptions) { o.timeline = &src }
}

const (
	defaultTimelineWindow = 6 * time.Hour
	defaultTimelineLimit  = 500
	maxTimelineLimit      = 2000
	markerCooldown        = 3 * time.Second // ein versehentlicher Doppelklick ist ein Marker
	maxMarkerNote         = 200
)

// handleTimeline liefert GET /api/v1/timeline?since=&until=&limit=&operate=1 — neueste zuerst. since/until RFC 3339
// (Standard: die letzten 6 Stunden); operate=1 nimmt Bedienung (Regler, Schnitte) mit auf.
func handleTimeline(src *timeline.Sources) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		now := time.Now()
		until := now.Add(time.Minute)
		if v, err := time.Parse(time.RFC3339, q.Get("until")); err == nil {
			until = v
		}
		since := until.Add(-defaultTimelineWindow)
		if v, err := time.Parse(time.RFC3339, q.Get("since")); err == nil {
			since = v
		}
		if !since.Before(until) {
			http.Error(w, "since must be before until", http.StatusBadRequest)
			return
		}
		limit := defaultTimelineLimit
		if v, err := strconv.Atoi(q.Get("limit")); err == nil && v > 0 {
			limit = min(v, maxTimelineLimit)
		}
		items, err := src.Query(since, until, limit, q.Get("operate") == "1")
		if err != nil {
			http.Error(w, "failed to read timeline", http.StatusInternalServerError)
			return
		}
		if items == nil {
			items = []timeline.Item{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"now": now.UTC(), "since": since.UTC(), "until": until.UTC(), "truncated": len(items) >= limit, "items": items})
	}
}

// handlePostTimelineMarker liefert POST /api/v1/timeline/marker {"note": "…"} (Notiz optional): ein Marker „Problem jetzt“
// ohne Tippen, damit der Support später genau diese Minute findet.
func handlePostTimelineMarker(src *timeline.Sources, events EventSubscriber) http.HandlerFunc {
	var mu sync.Mutex
	last := map[string]time.Time{}
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Note string `json:"note"`
		}
		if r.Body != nil {
			_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)
		}
		note := strings.TrimSpace(body.Note)
		if len([]rune(note)) > maxMarkerNote {
			note = string([]rune(note)[:maxMarkerNote])
		}
		actor := ""
		if p, ok := principalFromContext(r); ok {
			actor = p.Username
		}
		now := time.Now()
		mu.Lock()
		dup := now.Sub(last[actor]) < markerCooldown
		if !dup {
			last[actor] = now
		}
		mu.Unlock()
		if dup {
			writeJSON(w, http.StatusOK, map[string]any{"at": now.UTC(), "duplicate": true})
			return
		}
		ev := timeline.Event{At: now, Kind: "marker", Severity: timeline.SevWarn, Actor: actor, Data: map[string]any{"note": note}}
		if err := src.Store.Insert(ev); err != nil {
			http.Error(w, "failed to store marker", http.StatusInternalServerError)
			return
		}
		if events != nil {
			events.Broadcast(sse.Event{Type: "timeline.appended", Data: json.RawMessage("null")})
		}
		writeJSON(w, http.StatusOK, map[string]any{"at": now.UTC()})
	}
}
