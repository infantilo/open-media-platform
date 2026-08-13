package supervisorclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTriggerRestoreSendsFileAndSucceedsOn202(t *testing.T) {
	var gotBody map[string]string
	var gotPath, gotMethod string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotMethod = r.Method
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	c := New(srv.URL)
	if err := c.TriggerRestore(context.Background(), "omp-test.sql.gz"); err != nil {
		t.Fatalf("TriggerRestore: %v", err)
	}
	if gotMethod != http.MethodPost {
		t.Errorf("method = %q, want POST", gotMethod)
	}
	if gotPath != "/restore" {
		t.Errorf("path = %q, want /restore", gotPath)
	}
	if gotBody["file"] != "omp-test.sql.gz" {
		t.Errorf("body file = %q, want omp-test.sql.gz", gotBody["file"])
	}
}

func TestTriggerRestoreFailsOnNon202(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "ein Restore läuft bereits", http.StatusConflict)
	}))
	defer srv.Close()

	c := New(srv.URL)
	if err := c.TriggerRestore(context.Background(), "omp-test.sql.gz"); err == nil {
		t.Fatal("TriggerRestore should fail on a non-202 response")
	}
}

func TestTriggerRestoreFailsWhenUnreachable(t *testing.T) {
	c := New("http://127.0.0.1:1") // nobody listens on port 1
	if err := c.TriggerRestore(context.Background(), "omp-test.sql.gz"); err == nil {
		t.Fatal("TriggerRestore should fail when the supervisor is unreachable")
	}
}
