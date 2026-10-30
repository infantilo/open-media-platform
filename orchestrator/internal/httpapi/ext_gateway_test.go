package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/modules/extsvc"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
)

type extNodes []registry.NodeView

func (e extNodes) List() []registry.NodeView { return e }

type extSecrets struct{}

func (extSecrets) Secret(string) string { return "geheim" }

type extAccess struct{ can bool }

func (a extAccess) Can(*http.Request, string) bool { return a.can }
func (extAccess) Identity(*http.Request) module.Identity {
	return module.Identity{User: "alice", Groups: []string{"g1"}}
}

// Das Dienst-Gateway hängt wie jedes Modul hinter der Anmeldung des Kerns: ohne gültiges Token nie bis zum Dienst,
// mit Token kommt der angemeldete Nutzer als Identität an, und das Funktionsrecht der Route entscheidet.
func TestExtGatewayIsBehindCoreAuthAndPassesTheLoggedInUser(t *testing.T) {
	var mu sync.Mutex // der Dienst läuft im Server-Goroutine, der Test liest nach der Antwort
	var seenUser, seenFeatures string
	node := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/service.json" {
			_ = json.NewEncoder(w).Encode(extsvc.Manifest{
				Name: "demo", Version: 1, Base: "/service",
				Features: []module.FeatureDef{{ID: "demo.use", Label: map[string]string{"de": "x"}}},
				Routes:   []extsvc.RouteDef{{Method: "GET", Path: "/ping", Features: []string{"demo.use"}}},
			})
			return
		}
		mu.Lock()
		seenUser, seenFeatures = r.Header.Get(extsvc.HUser), r.Header.Get(extsvc.HFeatures)
		mu.Unlock()
		io.WriteString(w, `{"pong":true}`)
	}))
	defer node.Close()

	run := func(can bool, token string) *httptest.ResponseRecorder {
		mod := extsvc.New(extsvc.Services{Nodes: extNodes{{ID: "n1", Online: true, APIBaseURL: node.URL, InstanceID: "i1"}}, Secrets: extSecrets{}})
		mux := http.NewServeMux()
		g := featureGate(&featureAuthz{}, 1)
		if err := mod.Mount(moduleRoutes{mux: mux, g: g}, module.Deps{Access: extAccess{can: can}}); err != nil {
			t.Fatal(err)
		}
		mod.RefreshForTest(context.Background())
		req := httptest.NewRequest(http.MethodGet, "/api/v1/ext/demo/ping", nil)
		if token != "" {
			req.Header.Set("Authorization", token)
		}
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}
	if rec := run(true, ""); rec.Code != http.StatusUnauthorized {
		t.Errorf("ohne Anmeldung: %d", rec.Code)
	}
	if rec := run(false, "Bearer valid"); rec.Code != http.StatusForbidden {
		t.Errorf("ohne Funktionsrecht: %d", rec.Code)
	}
	rec := run(true, "Bearer valid")
	if rec.Code != http.StatusOK || rec.Body.String() != `{"pong":true}`+"\n" && rec.Body.String() != `{"pong":true}` {
		t.Fatalf("mit Recht: %d %s", rec.Code, rec.Body.String())
	}
	mu.Lock()
	defer mu.Unlock()
	if seenUser != "alice" || seenFeatures != "demo.use" {
		t.Errorf("Identität am Dienst: user=%q features=%q", seenUser, seenFeatures)
	}
}
