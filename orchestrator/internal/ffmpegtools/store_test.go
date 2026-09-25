package ffmpegtools

import (
	"os/exec"
	"testing"
)

// Diese Tests laufen nur, wenn ffmpeg tatsächlich installiert ist (kein
// Zwang in CI, s. UMSETZUNG.md Kapitel 22 W1-Verifikation) — sie
// verifizieren das Zusammenspiel aus store.go + parse.go gegen die
// ECHTE Ausgabe des Hosts, zusätzlich zu den fest eingebetteten
// Fixtures in parse_test.go.
func requireFfmpeg(t *testing.T) string {
	t.Helper()
	path, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg nicht installiert, überspringe Integrationstest")
	}
	return path
}

func TestStoreListsAgainstRealFfmpeg(t *testing.T) {
	path := requireFfmpeg(t)
	s := NewStore(path)

	encoders, err := s.Encoders()
	if err != nil {
		t.Fatalf("Encoders: %v", err)
	}
	if len(encoders) == 0 {
		t.Fatal("expected at least one encoder")
	}

	formats, err := s.Formats()
	if err != nil {
		t.Fatalf("Formats: %v", err)
	}
	foundMxf := false
	for _, f := range formats {
		if f.Name == "mxf" {
			foundMxf = true
		}
	}
	if !foundMxf {
		t.Error("expected 'mxf' among the muxers this build was compiled with")
	}

	pixFmts, err := s.PixFmts()
	if err != nil {
		t.Fatalf("PixFmts: %v", err)
	}
	if len(pixFmts) == 0 {
		t.Fatal("expected at least one pixel format")
	}

	filters, err := s.Filters()
	if err != nil {
		t.Fatalf("Filters: %v", err)
	}
	foundScale := false
	for _, f := range filters {
		if f.Name == "scale" {
			foundScale = true
		}
	}
	if !foundScale {
		t.Error("expected the 'scale' filter to be listed")
	}
}

func TestStoreDetailAgainstRealFfmpeg(t *testing.T) {
	path := requireFfmpeg(t)
	s := NewStore(path)

	d, err := s.Detail("filter", "scale")
	if err != nil {
		t.Fatalf("Detail(filter, scale): %v", err)
	}
	if d.Description == "" {
		t.Error("expected a non-empty description for the 'scale' filter")
	}
	foundW := false
	for _, o := range d.Options {
		if o.Name == "w" {
			foundW = true
		}
	}
	if !foundW {
		t.Errorf("expected 'scale' to have a 'w' option, got %+v", d.Options)
	}

	// zweiter Aufruf muss aus dem Cache kommen, nicht erneut ffmpeg
	// spawnen — hier nur indirekt geprüft (gleiches Ergebnis, kein
	// Crash); ein echter Spawn-Zähler wäre ein Test-Hook zu viel für
	// diesen Zweck.
	d2, err := s.Detail("filter", "scale")
	if err != nil {
		t.Fatalf("Detail(filter, scale) zweiter Aufruf: %v", err)
	}
	if len(d2.Options) != len(d.Options) {
		t.Errorf("gecachtes Ergebnis weicht ab: %d vs %d Optionen", len(d2.Options), len(d.Options))
	}
}

func TestValidKindRejectsUnknown(t *testing.T) {
	path := requireFfmpeg(t)
	s := NewStore(path)
	if _, err := s.Detail("not-a-kind", "scale"); err == nil {
		t.Error("expected an error for an invalid kind")
	}
}

func TestStoreUnavailableWithoutPath(t *testing.T) {
	s := NewStore("")
	if s.Available() {
		t.Error("expected Available() to be false without a resolved path")
	}
	if _, err := s.Encoders(); err == nil {
		t.Error("expected an error when ffmpeg is unavailable")
	}
	if _, err := s.Detail("filter", "scale"); err == nil {
		t.Error("expected an error when ffmpeg is unavailable")
	}
}
