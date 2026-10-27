package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRequireNodeToken(t *testing.T) {
	t.Setenv("OMP_NODE_API_TOKEN", "secret")
	h := requireNodeToken(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	do := func(method, path, tok string) int {
		req := httptest.NewRequest(method, path, nil)
		if tok != "" {
			req.Header.Set("X-OMP-Node-Token", tok)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}
	for _, c := range []struct {
		method, path, tok string
		want              int
	}{
		{"PATCH", "/params/x", "", 401}, {"PATCH", "/params/x", "bad", 401}, {"PATCH", "/params/x", "secret", 204},
		{"OPTIONS", "/params/x", "", 204}, {"GET", "/https-info", "", 204}, {"GET", "/x-nmos/node/v1.3/self", "", 204},
		{"PATCH", "/x-nmos/connection/v1.1/single/receivers/r/staged", "", 401},
	} {
		if got := do(c.method, c.path, c.tok); got != c.want {
			t.Errorf("%s %s tok=%q: got %d want %d", c.method, c.path, c.tok, got, c.want)
		}
	}
}

func TestRequireNodeTokenOffWithoutEnv(t *testing.T) {
	t.Setenv("OMP_NODE_API_TOKEN", "")
	rec := httptest.NewRecorder()
	requireNodeToken(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })).ServeHTTP(rec, httptest.NewRequest("PATCH", "/params/x", nil))
	if rec.Code != 204 {
		t.Fatalf("got %d", rec.Code)
	}
}
