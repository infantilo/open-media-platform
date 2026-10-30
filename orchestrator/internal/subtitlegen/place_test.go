package subtitlegen

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSlugAndUniqueName(t *testing.T) {
	if got := Slug("  Wetter Abend/ZIB 1: Größe!  "); got != "Wetter-Abend-ZIB-1-Groesse" {
		t.Errorf("Slug = %q", got)
	}
	if Slug("../../etc") != "etc" || Slug("!!!") != "" {
		t.Errorf("Pfadanteile entfernt: %q / %q", Slug("../../etc"), Slug("!!!"))
	}
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "a.srt"), nil, 0o644)
	_ = os.WriteFile(filepath.Join(dir, "a-2.srt"), nil, 0o644)
	if got := UniqueName("a", dir); got != "a-3" {
		t.Errorf("UniqueName = %q", got)
	}
	if UniqueName("b", dir, "") != "b" {
		t.Error("freier Name bleibt")
	}
}

func TestPlaceWithoutAssetWritesBothCopiesAndNeverOverwrites(t *testing.T) {
	a, p := filepath.Join(t.TempDir(), "asset"), filepath.Join(t.TempDir(), "play")
	one, err := Place(nil, "", "Wetter", "1\n00:00:00,000 --> 00:00:01,000\nHallo\n\n", a, p)
	if err != nil || one.Name != "Wetter" || one.RepID != "" || one.Warning != "" {
		t.Fatalf("erste: %+v %v", one, err)
	}
	for _, f := range []string{one.Path, one.PlayoutPath} {
		if b, err := os.ReadFile(f); err != nil || len(b) == 0 {
			t.Fatalf("%s: %v", f, err)
		}
	}
	two, err := Place(nil, "", "Wetter", "x", a, p)
	if err != nil || two.Name != "Wetter-2" {
		t.Fatalf("zweite: %+v %v", two, err)
	}
	if b, _ := os.ReadFile(one.Path); len(b) < 5 {
		t.Fatal("die erste Datei darf nicht überschrieben sein")
	}
	// ohne Playout-Verzeichnis: nur die Asset-Datei, keine Warnung
	three, err := Place(nil, "", "Nur-Asset", "x", a, "")
	if err != nil || three.PlayoutPath != "" || three.Warning != "" {
		t.Fatalf("ohne Playout: %+v %v", three, err)
	}
}
