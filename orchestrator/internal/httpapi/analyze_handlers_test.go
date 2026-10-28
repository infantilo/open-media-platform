package httpapi

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/support"
)

func TestAnalyzeUpload(t *testing.T) {
	var z bytes.Buffer
	_ = support.WriteZip(&z, []support.File{{Name: "meta.json", Data: []byte(`{"trigger":"manual"}`)}}, time.Now())
	rec := httptest.NewRecorder()
	handleAnalyzeUpload()(rec, httptest.NewRequest("POST", "/x?format=md&lang=en", bytes.NewReader(z.Bytes())))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "Frozen snapshot") {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	handleAnalyzeUpload()(rec, httptest.NewRequest("POST", "/x", strings.NewReader("junk")))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
}
