package descriptor

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestStoreGetSet(t *testing.T) {
	s := NewStore("Mock Node")

	v, ok := s.Get("label")
	if !ok || v != "Mock Node" {
		t.Fatalf("Get(label) = %v, %v; want Mock Node, true", v, ok)
	}

	if !s.Set("label", "Renamed") {
		t.Fatal("Set(label) = false, want true")
	}
	v, _ = s.Get("label")
	if v != "Renamed" {
		t.Fatalf("Get(label) after Set = %v, want Renamed", v)
	}
}

func TestStoreSetUnknownParamFails(t *testing.T) {
	s := NewStore("Mock Node")
	if s.Set("does-not-exist", "x") {
		t.Fatal("Set(unknown) = true, want false")
	}
}

func TestHandlerDescriptorJSON(t *testing.T) {
	s := NewStore("Mock Node")
	h := Handler(s)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/descriptor.json", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var d Descriptor
	if err := json.Unmarshal(rec.Body.Bytes(), &d); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if len(d.Parameters) != 2 {
		t.Fatalf("parameters = %+v, want label and gain", d.Parameters)
	}
	names := map[string]bool{}
	for _, p := range d.Parameters {
		names[p.Name] = true
	}
	if !names["label"] || !names["gain"] {
		t.Fatalf("parameters = %+v, want label and gain", d.Parameters)
	}
	if len(d.Methods) != 1 || d.Methods[0].Name != "reset" {
		t.Fatalf("methods = %+v, want one 'reset' method", d.Methods)
	}
}

func TestHandlerGetAndPatchGainParam(t *testing.T) {
	s := NewStore("Mock Node")
	h := Handler(s)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/params/gain", strings.NewReader(`{"value":-6}`))
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("PATCH status = %d, want 200", rec.Code)
	}

	v, _ := s.Get("gain")
	if v != -6.0 {
		t.Fatalf("gain after PATCH = %v, want -6", v)
	}
}

func TestHandlerInvokeReset(t *testing.T) {
	s := NewStore("Mock Node")
	s.Set("gain", -6.0)
	s.Set("label", "Renamed")
	h := Handler(s)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/methods/reset", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST status = %d, want 200", rec.Code)
	}

	gain, _ := s.Get("gain")
	if gain != 0.0 {
		t.Fatalf("gain after reset = %v, want 0", gain)
	}
	label, _ := s.Get("label")
	if label != "Mock Node" {
		t.Fatalf("label after reset = %v, want 'Mock Node'", label)
	}
}

func TestHandlerInvokeUnknownMethodReturns404(t *testing.T) {
	s := NewStore("Mock Node")
	h := Handler(s)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/methods/nope", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestHandlerGetAndPatchParam(t *testing.T) {
	s := NewStore("Mock Node")
	h := Handler(s)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/params/label", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET status = %d, want 200", rec.Code)
	}

	rec = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/params/label", strings.NewReader(`{"value":"New Label"}`))
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("PATCH status = %d, want 200", rec.Code)
	}

	v, _ := s.Get("label")
	if v != "New Label" {
		t.Fatalf("label after PATCH = %v, want 'New Label'", v)
	}
}

func TestHandlerPatchUnknownParamReturns404(t *testing.T) {
	s := NewStore("Mock Node")
	h := Handler(s)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPatch, "/params/nope", strings.NewReader(`{"value":"x"}`))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}
