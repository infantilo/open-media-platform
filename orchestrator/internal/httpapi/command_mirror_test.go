package httpapi

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeMirror struct {
	url    string
	mu     sync.Mutex
	failed int
}

func (f *fakeMirror) MirrorTarget(string) (string, bool) { return f.url, f.url != "" }
func (f *fakeMirror) MirrorFailed(string)                { f.mu.Lock(); f.failed++; f.mu.Unlock() }

func TestCommandMirrorTapForwardsSuccessfulCommand(t *testing.T) {
	var gotPath, gotBody string
	done := make(chan struct{})
	standby := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotPath, gotBody = r.URL.Path+"?"+r.URL.RawQuery, string(b)
		close(done)
	}))
	defer standby.Close()

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/nodes/{id}/methods/{name}", commandMirrorTap(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusNoContent)
	}, &fakeMirror{url: standby.URL}, nil))
	srv := httptest.NewServer(mux)
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/api/v1/nodes/n1/methods/crosspoint.cut?x=1", "application/json", strings.NewReader(`{"a":1}`))
	if err != nil || resp.StatusCode != 204 {
		t.Fatalf("primary call: %v %v", resp, err)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("standby never received the command")
	}
	if gotPath != "/methods/crosspoint.cut?x=1" || gotBody != `{"a":1}` {
		t.Errorf("standby got path %q body %q", gotPath, gotBody)
	}
}

func TestCommandMirrorTapSkipsFailedPrimaryCommand(t *testing.T) {
	called := make(chan struct{}, 1)
	standby := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called <- struct{}{} }))
	defer standby.Close()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/nodes/{id}/methods/{name}", commandMirrorTap(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusBadRequest)
	}, &fakeMirror{url: standby.URL}, nil))
	srv := httptest.NewServer(mux)
	defer srv.Close()
	http.Post(srv.URL+"/api/v1/nodes/n1/methods/x", "application/json", nil)
	select {
	case <-called:
		t.Fatal("rejected command must not be mirrored")
	case <-time.After(300 * time.Millisecond):
	}
}

func TestCommandMirrorTapReportsUnreachableStandby(t *testing.T) {
	m := &fakeMirror{url: "http://127.0.0.1:1"} // nichts lauscht
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/nodes/{id}/methods/{name}", commandMirrorTap(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }, m, nil))
	srv := httptest.NewServer(mux)
	defer srv.Close()
	http.Post(srv.URL+"/api/v1/nodes/n1/methods/x", "application/json", nil)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		m.mu.Lock()
		f := m.failed
		m.mu.Unlock()
		if f == 1 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("MirrorFailed not reported")
}
