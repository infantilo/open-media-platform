package audiorules

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func channelDocWithGroup(t *testing.T, id string) string {
	t.Helper()
	var d audioRulesDoc
	if err := json.Unmarshal(defaultAudioRulesJSON, &d); err != nil {
		t.Fatal(err)
	}
	d.OutputProfile.Groups[0].Label = id
	b, _ := json.Marshal(d)
	return string(b)
}

func TestChannelAudioRulesOverrideInheritAndReset(t *testing.T) {
	store := &memSettings{m: map[string][]byte{}}
	c := &channelRules{settings: store}
	get := func(url string) (*httptest.ResponseRecorder, map[string]any) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest("GET", url, nil)
		if strings.Contains(url, "/channel/") {
			req.SetPathValue("id", "ch1")
			c.handleGetChannel()(rec, req)
		} else {
			c.handleGetEffective()(rec, req)
		}
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec, out
	}

	// Ohne eigenes Dokument: Plattform-Standard, Quelle „platform“.
	rec, _ := get("/api/v1/audio-rules?channelId=ch1")
	if rec.Header().Get("X-Audio-Rules-Source") != "platform" {
		t.Fatalf("ohne Kanal-Dokument muss der Plattform-Standard gelten, got %q", rec.Header().Get("X-Audio-Rules-Source"))
	}
	_, ch := get("/api/v1/audio-rules/channel/ch1")
	if ch["source"] != "platform" {
		t.Fatalf("source = %v, want platform", ch["source"])
	}

	// Eigenes Dokument speichern.
	put := httptest.NewRecorder()
	req := httptest.NewRequest("PUT", "/", strings.NewReader(channelDocWithGroup(t, "KANAL-EINS")))
	req.SetPathValue("id", "ch1")
	c.handlePutChannel()(put, req)
	if put.Code != http.StatusOK {
		t.Fatalf("PUT: %d %s", put.Code, put.Body.String())
	}
	rec, _ = get("/api/v1/audio-rules?channelId=ch1")
	if rec.Header().Get("X-Audio-Rules-Source") != "channel" || !strings.Contains(rec.Body.String(), "KANAL-EINS") {
		t.Fatalf("Kanal-Dokument erwartet: %s / %s", rec.Header().Get("X-Audio-Rules-Source"), rec.Body.String())
	}
	// Ein anderer Channel und der Plattform-Aufruf bleiben unberührt.
	rec, _ = get("/api/v1/audio-rules?channelId=ch2")
	if rec.Header().Get("X-Audio-Rules-Source") != "platform" || strings.Contains(rec.Body.String(), "KANAL-EINS") {
		t.Fatalf("anderer Channel darf nichts erben: %s", rec.Header().Get("X-Audio-Rules-Source"))
	}
	rec, _ = get("/api/v1/audio-rules")
	if rec.Header().Get("X-Audio-Rules-Source") != "platform" {
		t.Fatalf("ohne Channel gilt der Plattform-Standard")
	}

	// Ungültiges Dokument wird abgewiesen und überschreibt nichts.
	bad := httptest.NewRecorder()
	req = httptest.NewRequest("PUT", "/", strings.NewReader(`{"outputProfile":{"groups":[{"id":"","label":"x"}]},"trackSchemas":[],"mappings":[],"ruleSet":{"rules":[]}}`))
	req.SetPathValue("id", "ch1")
	c.handlePutChannel()(bad, req)
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("ungültiges Dokument: %d", bad.Code)
	}

	// Zurücknehmen: der Channel erbt wieder.
	del := httptest.NewRecorder()
	req = httptest.NewRequest("DELETE", "/", nil)
	req.SetPathValue("id", "ch1")
	c.handleDeleteChannel()(del, req)
	if del.Code != http.StatusNoContent {
		t.Fatalf("DELETE: %d", del.Code)
	}
	rec, _ = get("/api/v1/audio-rules?channelId=ch1")
	if rec.Header().Get("X-Audio-Rules-Source") != "platform" {
		t.Fatalf("nach Rücknahme gilt wieder der Plattform-Standard")
	}
}

func TestChannelIDIsValidated(t *testing.T) {
	c := &channelRules{settings: &memSettings{m: map[string][]byte{}}}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/", nil)
	req.SetPathValue("id", "../../etc")
	c.handleGetChannel()(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("ungültige ID muss 400 liefern, got %d", rec.Code)
	}
}
