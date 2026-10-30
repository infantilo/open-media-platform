package review

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/subtitlegen"
)

// fakeASR ahmt den Auto-Untertitel-Node nach: nimmt Aufträge an und meldet sie auf Zuruf als fertig, fehlgeschlagen oder verloren.
type fakeASR struct {
	mu        sync.Mutex
	submitted []map[string]any
	state     string // Zustand, den fileJobs meldet
	lost      bool
	message   string
	srt       string
}

func (f *fakeASR) server(t *testing.T, diarization bool) *httptest.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /params/role", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"value":"file"}`))
	})
	mux.HandleFunc("POST /methods/file.transcribe", func(w http.ResponseWriter, r *http.Request) {
		var b map[string]any
		_ = json.NewDecoder(r.Body).Decode(&b)
		f.mu.Lock()
		f.submitted = append(f.submitted, b)
		f.mu.Unlock()
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("POST /methods/{m}", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(`{"ok":true}`)) })
	mux.HandleFunc("GET /params/fileJobs", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.lost || len(f.submitted) == 0 {
			_, _ = w.Write([]byte(`{"value":[]}`))
			return
		}
		id := f.submitted[0]["id"]
		_ = json.NewEncoder(w).Encode(map[string]any{"value": []map[string]any{{"id": id, "state": f.state, "progress": 60, "message": f.message, "speakersFound": 2, "cues": 3, "durationS": 12.5}}})
	})
	mux.HandleFunc("GET /params/{p}", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.PathValue("p"), "fileJobSrt.") {
			f.mu.Lock()
			defer f.mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{"value": f.srt})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"value": diarization})
	})
	return httptest.NewServer(mux)
}

func subEnv(t *testing.T, f *fakeASR, diarization bool) (*testEnv, string) {
	t.Helper()
	e := newEnv(t, nil)
	srv := f.server(t, diarization)
	t.Cleanup(srv.Close)
	play := filepath.Join(t.TempDir(), "subtitles")
	e.cfg.SubtitleDir = play
	e.svc.SubNodes = func() []subtitlegen.Target {
		return []subtitlegen.Target{{NodeID: "n1", Label: "ASR", BaseURL: srv.URL}}
	}
	return e, play
}

func TestSubtitleJobStoresResultForPlayoutAndAsset(t *testing.T) {
	f := &fakeASR{state: "transcribing", srt: "1\n00:00:00,000 --> 00:00:02,000\nAnna: Guten Abend.\n\n"}
	e, play := subEnv(t, f, true)
	ctx := context.Background()
	it := e.importReady(t)

	j, err := e.svc.StartSubtitles(ctx, it.AssetID, "tester", "", SubtitleParams{Language: "de", Speakers: 0, Names: []string{" Anna ", ""}})
	if err != nil {
		t.Fatal(err)
	}
	if j.State != "running" || j.Params.Style != "colon" || len(j.Params.Names) != 1 || j.Params.Names[0] != "Anna" {
		t.Fatalf("Auftrag = %+v", j)
	}
	if len(f.submitted) != 1 || !strings.HasSuffix(f.submitted[0]["file"].(string), ".mxf") || f.submitted[0]["names"] != "Anna" || f.submitted[0]["id"] != j.ID {
		t.Fatalf("an den Node gereicht: %v", f.submitted)
	}
	if !strings.Contains(j.Name, "-de") {
		t.Errorf("Standardname enthält Sprache: %q", j.Name)
	}

	// läuft noch: Fortschritt wird übernommen
	e.svc.PollSubtitles(ctx)
	got, _ := e.svc.St.getSubtitle(ctx, j.ID)
	if got.State != "running" || got.Progress != 60 || got.SpeakersFound != 2 {
		t.Fatalf("laufend: %+v", got)
	}

	// fertig: Datei im Asset-Ordner, Kopie fürs Playout, Darstellung am Asset
	f.mu.Lock()
	f.state = "done"
	f.mu.Unlock()
	e.svc.PollSubtitles(ctx)
	got, _ = e.svc.St.getSubtitle(ctx, j.ID)
	if got.State != "done" || !got.Downloadable || got.RepID == "" || got.PlayoutTrack == "" || got.Cues != 3 {
		t.Fatalf("fertig: %+v", got)
	}
	b, err := os.ReadFile(filepath.Join(play, got.PlayoutTrack+".srt"))
	if err != nil || !strings.Contains(string(b), "Anna: Guten Abend.") {
		t.Fatalf("Kopie fürs Playout: %v %q", err, b)
	}
	path, fname, err := e.svc.SubtitleFile(ctx, j.ID)
	if err != nil || !strings.HasSuffix(fname, ".srt") {
		t.Fatalf("Download: %v %q", err, fname)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	rep, err := e.svc.Assets.GetRepresentation(got.RepID)
	if err != nil || rep.Type != "subtitle" || rep.Format != "srt" || rep.Storage.URI != path {
		t.Fatalf("Darstellung: %+v %v", rep, err)
	}
	// neue, veröffentlichte Version: übernimmt die Quelle und ergänzt die SRT; der Eintrag der Eingangskontrolle bleibt unverändert
	as, _ := e.svc.Assets.GetAsset(it.AssetID)
	if as.CurrentVersionID == it.SourceVersionID {
		t.Fatalf("es muss eine neue aktuelle Version geben")
	}
	reps, _ := e.svc.Assets.ListRepresentations(as.CurrentVersionID)
	types := map[string]bool{}
	for _, r := range reps {
		types[r.Type] = true
	}
	if !types["source"] || !types["subtitle"] {
		t.Fatalf("Darstellungen der neuen Version: %v", types)
	}
	if again, _ := e.svc.St.GetItem(ctx, it.AssetID); again.SourceVersionID != it.SourceVersionID || again.SourceRepID != it.SourceRepID {
		t.Fatalf("Quelle des Eingangs-Eintrags darf sich nicht ändern")
	}
	// zweiter Lauf mit gleichem Namen bekommt einen eigenen Dateinamen (nichts wird überschrieben)
	f.mu.Lock()
	f.submitted, f.state = nil, "transcribing"
	f.mu.Unlock()
	j2, err := e.svc.StartSubtitles(ctx, it.AssetID, "tester", got.Name, SubtitleParams{Language: "de", Speakers: 1})
	if err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.state = "done"
	f.mu.Unlock()
	e.svc.PollSubtitles(ctx)
	g2, _ := e.svc.St.getSubtitle(ctx, j2.ID)
	if g2.State != "done" || g2.Name == got.Name {
		t.Fatalf("zweiter Auftrag: %+v (erster hieß %q)", g2, got.Name)
	}

	// Löschen räumt Dateien und Darstellung auf
	if err := e.svc.DeleteSubtitle(ctx, j.ID, "tester"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Errorf("Datei der Version gehört zum Verlauf und bleibt: %v", err)
	}
	if _, err := os.Stat(filepath.Join(play, got.PlayoutTrack+".srt")); !os.IsNotExist(err) {
		t.Errorf("Playout-Kopie bleibt liegen: %v", err)
	}
	if _, err := e.svc.Assets.GetRepresentation(got.RepID); err != nil {
		t.Errorf("Darstellung bleibt bestehen: %v", err)
	}
	if list, _ := e.svc.St.listSubtitles(ctx, it.AssetID); len(list) != 1 {
		t.Errorf("Liste nach Löschen: %d", len(list))
	}
}

func TestSubtitleJobFailureAndLostJob(t *testing.T) {
	f := &fakeASR{state: "failed", message: "Tonspur 5 nicht lesbar"}
	e, _ := subEnv(t, f, true)
	ctx := context.Background()
	it := e.importReady(t)
	j, err := e.svc.StartSubtitles(ctx, it.AssetID, "t", "x", SubtitleParams{Language: "de", Speakers: 0, Track: 5})
	if err != nil {
		t.Fatal(err)
	}
	e.svc.PollSubtitles(ctx)
	got, _ := e.svc.St.getSubtitle(ctx, j.ID)
	if got.State != "failed" || !strings.Contains(got.Message, "Tonspur 5") || got.Downloadable {
		t.Fatalf("Fehler: %+v", got)
	}
	// Node hat den Auftrag vergessen (Neustart)
	f.mu.Lock()
	f.submitted, f.state, f.lost = nil, "transcribing", false
	f.mu.Unlock()
	j2, _ := e.svc.StartSubtitles(ctx, it.AssetID, "t", "y", SubtitleParams{Language: "de", Speakers: 0})
	f.mu.Lock()
	f.lost = true
	f.mu.Unlock()
	e.svc.PollSubtitles(ctx)
	g2, _ := e.svc.St.getSubtitle(ctx, j2.ID)
	if g2.State != "failed" || !strings.Contains(g2.Message, "nicht mehr vorhanden") {
		t.Fatalf("verlorener Auftrag: %+v", g2)
	}
	if err := e.svc.DeleteSubtitle(ctx, j.ID, "t"); err != nil {
		t.Errorf("fehlgeschlagene Aufträge lassen sich entfernen: %v", err)
	}
}

func TestSubtitleStartRejectsBadInputAndMissingCapabilities(t *testing.T) {
	f := &fakeASR{state: "transcribing"}
	e, _ := subEnv(t, f, false) // Node ohne Sprechererkennung
	ctx := context.Background()
	it := e.importReady(t)
	// Sprecher gewünscht, Node kann es nicht → klare Meldung, nichts eingereicht
	_, err := e.svc.StartSubtitles(ctx, it.AssetID, "t", "", SubtitleParams{Language: "de", Speakers: 0})
	if !errors.Is(err, ErrValidation) || !strings.Contains(err.Error(), "install-diarization") {
		t.Fatalf("ohne Sprechererkennung: %v", err)
	}
	if len(f.submitted) != 0 {
		t.Fatal("nichts darf eingereicht werden")
	}
	// ohne Namen geht es auch ohne Sprechererkennung
	if _, err := e.svc.StartSubtitles(ctx, it.AssetID, "t", "", SubtitleParams{Language: "de", Speakers: 1}); err != nil {
		t.Fatalf("1 Sprecher: %v", err)
	}
	for _, bad := range []SubtitleParams{{Track: 99}, {Speakers: 40}, {Style: "fett"}, {Language: strings.Repeat("x", 30)}, {Names: []string{strings.Repeat("n", 50)}}} {
		if _, err := ValidateSubtitleParams(bad); !errors.Is(err, ErrValidation) {
			t.Errorf("%+v: erwartet Validierungsfehler, bekam %v", bad, err)
		}
	}
	e.svc.SubNodes = func() []subtitlegen.Target { return nil }
	if _, err := e.svc.StartSubtitles(ctx, it.AssetID, "t", "", SubtitleParams{Speakers: 1}); err == nil || !strings.Contains(err.Error(), "Auto-Untertitel") {
		t.Fatalf("ohne Node: %v", err)
	}
	if _, err := e.svc.StartSubtitles(ctx, "gibts-nicht", "t", "", SubtitleParams{Speakers: 1}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unbekanntes Asset: %v", err)
	}
}
