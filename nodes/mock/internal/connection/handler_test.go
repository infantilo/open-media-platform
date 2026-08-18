package connection

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandlerGetStagedAndActive(t *testing.T) {
	store := NewReceiverStore([]string{"recv-1"})
	h := Handler(store)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x-nmos/connection/v1.1/single/receivers/recv-1/staged", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET staged status = %d, want 200", rec.Code)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x-nmos/connection/v1.1/single/receivers/recv-1/active", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET active status = %d, want 200", rec.Code)
	}
}

func TestHandlerPatchStagedActivatesImmediately(t *testing.T) {
	store := NewReceiverStore([]string{"recv-1"})
	h := Handler(store)

	body := `{"sender_id":"sender-1","master_enable":true,"activation":{"mode":"activate_immediate"}}`
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/x-nmos/connection/v1.1/single/receivers/recv-1/staged", strings.NewReader(body))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("PATCH status = %d, want 200", rec.Code)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x-nmos/connection/v1.1/single/receivers/recv-1/active", nil))
	var active ReceiverResource
	if err := json.Unmarshal(rec.Body.Bytes(), &active); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if active.SenderID == nil || *active.SenderID != "sender-1" {
		t.Fatalf("active.sender_id = %v, want sender-1", active.SenderID)
	}
}

func TestHandlerUnknownReceiverReturns404(t *testing.T) {
	store := NewReceiverStore([]string{"recv-1"})
	h := Handler(store)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x-nmos/connection/v1.1/single/receivers/nope/staged", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

// D9-Basis-Discovery: die Pfade, an denen AMWA IS-05-01 vor D9 sofort mit
// 0 ausgeführten Tests abbrach (docs/decisions.md 2026-07-13).
func TestHandlerBaseDiscovery(t *testing.T) {
	store := NewReceiverStore([]string{"recv-1", "recv-2"})
	h := Handler(store)

	get := func(path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		return rec
	}

	cases := []struct {
		path string
		want string
	}{
		{"/x-nmos/connection/v1.1/", `["single/"]`},
		{"/x-nmos/connection/v1.1/single/", `["senders/","receivers/"]`},
		{"/x-nmos/connection/v1.1/single/senders/", `[]`},
		{"/x-nmos/connection/v1.1/single/receivers/", `["recv-1/","recv-2/"]`},
		{"/x-nmos/connection/v1.1/single/receivers/recv-1/", `["constraints/","staged/","active/","transporttype/"]`},
		{"/x-nmos/connection/v1.1/single/receivers/recv-1/transporttype", `"urn:x-nmos:transport:rtp"`},
	}
	for _, c := range cases {
		rec := get(c.path)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s status = %d, want 200 (body: %s)", c.path, rec.Code, rec.Body.String())
		}
		got := strings.TrimSpace(rec.Body.String())
		if got != c.want {
			t.Fatalf("GET %s body = %s, want %s", c.path, got, c.want)
		}
	}

	rec := get("/x-nmos/connection/v1.1/single/receivers/recv-1/constraints")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET constraints status = %d, want 200", rec.Code)
	}
	var constraints []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &constraints); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if len(constraints) != 1 {
		t.Fatalf("constraints legs = %d, want 1", len(constraints))
	}
	if _, ok := constraints[0]["rtp_enabled"]; !ok {
		t.Fatalf("constraints missing rtp_enabled key: %v", constraints[0])
	}

	for _, path := range []string{
		"/x-nmos/connection/v1.1/single/receivers/nope/",
		"/x-nmos/connection/v1.1/single/receivers/nope/constraints",
		"/x-nmos/connection/v1.1/single/receivers/nope/transporttype",
	} {
		if rec := get(path); rec.Code != http.StatusNotFound {
			t.Fatalf("GET %s status = %d, want 404", path, rec.Code)
		}
	}
}

// TestHandlerTrailingSlashLeafPathsMatchBarePaths — live am echten
// AMWA-IS-05-01-Tool-Lauf gefunden (UMSETZUNG.md D9, docs/decisions.md):
// das Tool ruft staged/active/constraints/transporttype sowohl mit als
// auch ohne abschließendes "/" ab. Vor dem Fix fing Gos `ServeMux` die
// Slash-Variante fälschlich im `{id}/`-Wurzel-Listing-Handler ab (der auf
// "/" endet und damit als Teilbaum-Muster jede längere Anfrage ohne
// spezifischeres Muster verschluckt) und lieferte das Listing-Array statt
// der eigentlichen Ressource — reproduzierbarer Absturz zweier echter
// AMWA-Tests (`test_12_02`/`test_16`, `TypeError: list indices must be
// integers`, da `response["transport_params"]` auf einer Liste
// aufgerufen wurde).
// TestHandlerRootDoesNotSwallowUnknownSubpaths — live an AMWA-`test_34`/
// `test_35` gefunden (docs/decisions.md D9): das Wurzel-Teilbaummuster
// `/x-nmos/connection/v1.1/` fing vorher jeden nicht anderweitig
// registrierten Unterpfad (z. B. `bulk/senders`) fälschlich mit dem
// Wurzel-Listing statt 404 ab.
func TestHandlerRootDoesNotSwallowUnknownSubpaths(t *testing.T) {
	store := NewReceiverStore([]string{"recv-1"})
	h := Handler(store)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x-nmos/connection/v1.1/nonexistent-path", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET unknown subpath status = %d, want 404 (body: %s)", rec.Code, rec.Body.String())
	}
}

// TestHandlerBulkGetIsMethodNotAllowed — `bulk/senders`+`bulk/receivers`
// sind laut RAML (ConnectionAPI.raml) feste Pfade, die GET immer mit 405
// beantworten (nicht 404, auch ohne echte Bulk-POST-Implementierung).
func TestHandlerBulkGetIsMethodNotAllowed(t *testing.T) {
	store := NewReceiverStore([]string{"recv-1"})
	h := Handler(store)

	for _, path := range []string{
		"/x-nmos/connection/v1.1/bulk/senders",
		"/x-nmos/connection/v1.1/bulk/receivers",
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("GET %s status = %d, want 405", path, rec.Code)
		}
	}
}

// TestHandlerErrorsAreJSON — live an AMWA-`test_34`/`test_35`/
// `auto_connection_22` gefunden (docs/decisions.md D9): `http.Error`
// liefert hartcodiert `text/plain`, das AMWA-Tool erwartet für JEDE
// Fehlerantwort `application/json` nach `error-schema.json`.
func TestHandlerErrorsAreJSON(t *testing.T) {
	store := NewReceiverStore([]string{"recv-1"})
	h := Handler(store)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x-nmos/connection/v1.1/single/receivers/nope/staged", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", ct)
	}
	var body errorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON error body: %v (%s)", err, rec.Body.String())
	}
	if body.Code != http.StatusNotFound || body.Error == "" {
		t.Fatalf("unexpected error body: %+v", body)
	}
}

func TestHandlerTrailingSlashLeafPathsMatchBarePaths(t *testing.T) {
	store := NewReceiverStore([]string{"recv-1"})
	h := Handler(store)

	get := func(path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		return rec
	}

	for _, leaf := range []string{"staged", "active", "constraints", "transporttype"} {
		bare := get("/x-nmos/connection/v1.1/single/receivers/recv-1/" + leaf)
		slashed := get("/x-nmos/connection/v1.1/single/receivers/recv-1/" + leaf + "/")
		if bare.Code != http.StatusOK || slashed.Code != http.StatusOK {
			t.Fatalf("leaf %s: bare status = %d, slashed status = %d, want both 200", leaf, bare.Code, slashed.Code)
		}
		if bare.Body.String() != slashed.Body.String() {
			t.Fatalf("leaf %s: bare body = %s, slashed body = %s, want identical", leaf, bare.Body.String(), slashed.Body.String())
		}
	}
}

// TestHandlerBulkReceiversPost — live an AMWA-test_37 gefunden
// (docs/decisions.md D11): POST /bulk/receivers muss echte PATCHes
// ausführen, nicht nur mit 200 antworten.
func TestHandlerBulkReceiversPost(t *testing.T) {
	store := NewReceiverStore([]string{"recv-1"})
	h := Handler(store)

	body := `[
		{"id": "recv-1", "params": {"transport_params": [{"destination_port": 6000}]}},
		{"id": "does-not-exist", "params": {"master_enable": true}},
		{"id": "recv-1", "params": {"bad": "data"}}
	]`
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/x-nmos/connection/v1.1/bulk/receivers", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST bulk/receivers status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}

	var results []bulkResultItem
	if err := json.Unmarshal(rec.Body.Bytes(), &results); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if len(results) != 3 {
		t.Fatalf("results len = %d, want 3", len(results))
	}
	if results[0].ID != "recv-1" || results[0].Code != http.StatusOK {
		t.Fatalf("results[0] = %+v, want {recv-1, 200}", results[0])
	}
	if results[1].ID != "does-not-exist" || results[1].Code != http.StatusNotFound || results[1].Error == nil {
		t.Fatalf("results[1] = %+v, want {does-not-exist, 404, error set}", results[1])
	}
	if results[2].Code != http.StatusBadRequest || results[2].Error == nil {
		t.Fatalf("results[2] = %+v, want {400, error set} for the unknown field", results[2])
	}

	staged, _ := store.Staged("recv-1")
	if staged.TransportParams[0]["destination_port"] != float64(6000) {
		t.Fatalf("destination_port after bulk PATCH = %v, want 6000 (real effect, not just a 200 stub)", staged.TransportParams[0]["destination_port"])
	}
}
