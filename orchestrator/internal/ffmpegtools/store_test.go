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

func TestStoreGlobalOptionsAgainstRealFfmpeg(t *testing.T) {
	path := requireFfmpeg(t)
	s := NewStore(path)

	opts, err := s.GlobalOptions()
	if err != nil {
		t.Fatalf("GlobalOptions: %v", err)
	}
	if len(opts) < 50 {
		t.Fatalf("expected at least 50 global CLI flags from a real ffmpeg build, got %d", len(opts))
	}
	foundY, foundLoglevel := false, false
	for _, o := range opts {
		if o.Name == "-y" {
			foundY = true
			if o.HasArg {
				t.Errorf("expected -y to be a value-less flag: %+v", o)
			}
		}
		if o.Name == "-loglevel" {
			foundLoglevel = true
			if !o.HasArg {
				t.Errorf("expected -loglevel to take an argument: %+v", o)
			}
		}
		// Der riesige, absichtlich ausgesparte Per-Codec-Teil darf nicht
		// auftauchen (z. B. "b" — eine AVOption, kein CLI-Flag).
		if o.Name == "b" {
			t.Errorf("parsing leaked into the per-codec AVOptions dump: %+v", o)
		}
	}
	if !foundY || !foundLoglevel {
		t.Errorf("expected both -y and -loglevel among global options, foundY=%v foundLoglevel=%v", foundY, foundLoglevel)
	}

	// Zweiter Aufruf muss aus dem Cache kommen (kein erneuter, teurer
	// `-h full`-Spawn) — nur indirekt geprüft (gleiches Ergebnis).
	opts2, err := s.GlobalOptions()
	if err != nil {
		t.Fatalf("GlobalOptions zweiter Aufruf: %v", err)
	}
	if len(opts2) != len(opts) {
		t.Errorf("gecachtes Ergebnis weicht ab: %d vs %d", len(opts2), len(opts))
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
	if _, err := s.GlobalOptions(); err == nil {
		t.Error("expected an error when ffmpeg is unavailable")
	}
}
