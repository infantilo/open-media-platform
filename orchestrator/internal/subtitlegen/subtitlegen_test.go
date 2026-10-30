package subtitlegen

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// fakeNode ahmt die Schnittstelle des Auto-Untertitel-Nodes nach.
func fakeNode(t *testing.T, diarization bool) (*httptest.Server, *[]map[string]any) {
	t.Helper()
	var calls []map[string]any
	mux := http.NewServeMux()
	mux.HandleFunc("POST /methods/file.transcribe", func(w http.ResponseWriter, r *http.Request) {
		var b map[string]any
		_ = json.NewDecoder(r.Body).Decode(&b)
		calls = append(calls, b)
		if b["file"] == "" {
			w.WriteHeader(400)
			_, _ = w.Write([]byte(`{"error":"file: absoluter Pfad erwartet"}`))
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("GET /params/fileJobs", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"value":[{"id":"j1","state":"transcribing","progress":55,"speakersFound":2},{"id":"j2","state":"done","progress":100,"cues":11}]}`))
	})
	mux.HandleFunc("GET /params/fileJobSrt.j2", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"value":"1\n00:00:00,000 --> 00:00:01,000\nHallo\n\n"}`))
	})
	mux.HandleFunc("GET /params/fileJobSrt.j1", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"value":null}`))
	})
	mux.HandleFunc("GET /params/role", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"value":"file"}`))
	})
	mux.HandleFunc("GET /params/diarization", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"value": diarization})
	})
	return httptest.NewServer(mux), &calls
}

func TestSubmitSendsAllArguments(t *testing.T) {
	srv, calls := fakeNode(t, true)
	defer srv.Close()
	c := &Client{}
	tg := Target{Label: "ASR", BaseURL: srv.URL}
	err := c.Submit(context.Background(), tg, Request{ID: "j1", File: "/m/a.mxf", Track: 2, Language: "de", Speakers: 3, Names: []string{"Anna", "Ben"}, Word: "Sprecher", Style: "colon", Name: "a"})
	if err != nil {
		t.Fatal(err)
	}
	got := (*calls)[0]
	if got["file"] != "/m/a.mxf" || got["track"] != float64(2) || got["speakers"] != float64(3) || got["names"] != "Anna,Ben" || got["id"] != "j1" || got["style"] != "colon" {
		t.Fatalf("Aufruf = %v", got)
	}
	// Fehlermeldung des Nodes kommt im Klartext an
	err = c.Submit(context.Background(), tg, Request{ID: "j9"})
	if err == nil || !strings.Contains(err.Error(), "absoluter Pfad") {
		t.Fatalf("Fehler = %v", err)
	}
}

func TestStatusResultAndLostJob(t *testing.T) {
	srv, _ := fakeNode(t, true)
	defer srv.Close()
	c := &Client{}
	tg := Target{Label: "ASR", BaseURL: srv.URL}
	j, err := c.Status(context.Background(), tg, "j1")
	if err != nil || !j.Running() || j.Progress != 55 || j.SpeakersFound != 2 {
		t.Fatalf("Status = %+v, %v", j, err)
	}
	j, _ = c.Status(context.Background(), tg, "j2")
	if j.Running() || j.State != "done" || j.Cues != 11 {
		t.Fatalf("fertig: %+v", j)
	}
	if _, err := c.Status(context.Background(), tg, "gibts-nicht"); !errors.Is(err, ErrJobLost) {
		t.Fatalf("verlorener Auftrag: %v", err)
	}
	srt, err := c.Result(context.Background(), tg, "j2")
	if err != nil || !strings.Contains(srt, "Hallo") {
		t.Fatalf("Ergebnis: %q %v", srt, err)
	}
	if _, err := c.Result(context.Background(), tg, "j1"); err == nil {
		t.Fatal("Ergebnis eines laufenden Auftrags muss scheitern")
	}
}

func TestPickPrefersNodeWithDiarization(t *testing.T) {
	without, _ := fakeNode(t, false)
	defer without.Close()
	with, _ := fakeNode(t, true)
	defer with.Close()
	c := &Client{}
	a, b := Target{Label: "ohne", BaseURL: without.URL}, Target{Label: "mit", BaseURL: with.URL}
	got, err := c.Pick(context.Background(), []Target{a, b}, 0)
	if err != nil || got.Label != "mit" {
		t.Fatalf("Pick = %+v, %v", got, err)
	}
	// ein Sprecher: kein Bedarf an Sprechererkennung
	if got, _ := c.Pick(context.Background(), []Target{a, b}, 1); got.Label != "ohne" {
		t.Fatalf("Pick(1) = %+v", got)
	}
	// nur ein Node ohne Sprechererkennung: klare Meldung statt stillem Ergebnis ohne Namen
	if _, err := c.Pick(context.Background(), []Target{a}, 0); err == nil || !strings.Contains(err.Error(), "install-diarization") {
		t.Fatalf("Fehler = %v", err)
	}
	if _, err := c.Pick(context.Background(), nil, 0); !errors.Is(err, ErrNoNode) {
		t.Fatalf("kein Node: %v", err)
	}
}

func TestLiveNodesNeverGetFileJobs(t *testing.T) {
	live := httptest.NewServer(http.NewServeMux()) // älterer Node ohne Parameter „role“ = Live
	defer live.Close()
	file, _ := fakeNode(t, true)
	defer file.Close()
	c := &Client{}
	lv, fl := Target{Label: "live", BaseURL: live.URL}, Target{Label: "datei", BaseURL: file.URL}
	if got, err := c.Pick(context.Background(), []Target{lv, fl}, 0); err != nil || got.Label != "datei" {
		t.Fatalf("Pick = %+v, %v", got, err)
	}
	if _, err := c.Pick(context.Background(), []Target{lv}, 1); !errors.Is(err, ErrNoFileNode) {
		t.Fatalf("nur Live-Nodes: %v", err)
	}
	if got := c.FileNodes(context.Background(), []Target{lv, fl}); len(got) != 1 || got[0].Label != "datei" {
		t.Fatalf("FileNodes = %+v", got)
	}
}
