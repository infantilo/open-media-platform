package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestErrorCodesEndpointLocalized(t *testing.T) {
	get := func(lang string) []errorCodeView {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/errorcodes", nil)
		if lang != "" {
			req.Header.Set("Accept-Language", lang)
		}
		rec := httptest.NewRecorder()
		handleErrorCodes(rec, req)
		var out []errorCodeView
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || rec.Code != http.StatusOK {
			t.Fatal(rec.Code, err)
		}
		return out
	}
	de, en := get(""), get("en-US")
	if len(de) < 30 || len(de) != len(en) {
		t.Fatalf("%d / %d Einträge", len(de), len(en))
	}
	for i := range de {
		if de[i].Code != en[i].Code || de[i].Title == en[i].Title || len(de[i].Steps) == 0 || len(de[i].Steps) != len(en[i].Steps) || de[i].Doc == "" {
			t.Fatalf("%s: %+v / %+v", de[i].Code, de[i], en[i])
		}
	}
}
