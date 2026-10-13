package workflows

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

func TestSenderPairsMatchFormatAndLabelNotPosition(t *testing.T) {
	old := []registry.SenderView{
		{ID: "oa", Label: "Q Sender 2", Format: "audio"},
		{ID: "ov", Label: "Q Sender 1", Format: "video"},
	}
	// Registry liefert die neue Instanz in anderer Reihenfolge.
	nu := []registry.SenderView{
		{ID: "nv", Label: "Q Sender 1", Format: "video"},
		{ID: "na", Label: "Q Sender 2", Format: "audio"},
	}
	got := senderPairs(old, nu)
	if len(got) != 2 || got[0] != [2]string{"oa", "na"} || got[1] != [2]string{"ov", "nv"} {
		t.Fatalf("pairs = %v", got)
	}
	// Ohne Label-Treffer: nächster freier Sender gleichen Formats.
	got = senderPairs([]registry.SenderView{{ID: "o", Label: "x", Format: "video"}}, []registry.SenderView{{ID: "n", Label: "y", Format: "video"}})
	if len(got) != 1 || got[0] != [2]string{"o", "n"} {
		t.Fatalf("fallback pairs = %v", got)
	}
}

func TestWaitHandoverIdle(t *testing.T) {
	var polls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/params/handoverPending" {
			http.NotFound(w, r)
			return
		}
		// zwei Abfragen "läuft noch", danach fertig
		_, _ = w.Write([]byte(map[bool]string{true: `{"value":true}`, false: `{"value":false}`}[polls.Add(1) <= 2]))
	}))
	defer srv.Close()
	s := &Service{httpClient: srv.Client()}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if !s.waitHandoverIdle(ctx, srv.URL) {
		t.Fatal("expected idle")
	}
	if polls.Load() != 3 {
		t.Fatalf("polls = %d, want 3", polls.Load())
	}

	// Node ohne den Parameter: nichts abzuwarten
	missing := httptest.NewServer(http.NotFoundHandler())
	defer missing.Close()
	if !(&Service{httpClient: missing.Client()}).waitHandoverIdle(ctx, missing.URL) {
		t.Fatal("unsupported node must not block")
	}
}
