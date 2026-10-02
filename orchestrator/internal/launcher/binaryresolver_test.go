package launcher

import "testing"

func TestApplyProductiveBinaryReplacesOnlyTheCopy(t *testing.T) {
	l := &Launcher{}
	entry := CatalogEntry{Type: "audio-mixer", Runner: "process", Command: []string{"../nodes/target/debug/omp-audio-mixer", "--x"}}

	if got, id := l.applyProductiveBinary(entry); id != "" || got.Command[0] != entry.Command[0] {
		t.Fatal("ohne Resolver bleibt der Eintrag unverändert")
	}
	l.SetBinaryResolver(func(name string) (string, string) {
		if name == "omp-audio-mixer" {
			return "/store/omp-audio-mixer/2026.10.1/omp-audio-mixer", "2026.10.1"
		}
		return "", ""
	})
	got, id := l.applyProductiveBinary(entry)
	if id != "2026.10.1" || got.Command[0] != "/store/omp-audio-mixer/2026.10.1/omp-audio-mixer" || got.Command[1] != "--x" {
		t.Fatalf("erwartet produktives Binary + Argumente: %+v %q", got.Command, id)
	}
	if entry.Command[0] != "../nodes/target/debug/omp-audio-mixer" {
		t.Fatal("der Katalogeintrag darf nicht verändert werden")
	}
	if l.ProductiveVersion("omp-audio-mixer") != "2026.10.1" || l.ProductiveVersion("omp-anderer") != "" {
		t.Fatal("ProductiveVersion")
	}
}

func TestApplyBinaryPins(t *testing.T) {
	l := &Launcher{}
	entry := CatalogEntry{Type: "audio-mixer", Runner: "process", Command: []string{"../nodes/target/debug/omp-audio-mixer"}}
	l.SetBinaryResolver(func(string) (string, string) { return "/store/prod/omp-audio-mixer", "2.0" })
	l.SetBinaryLookup(func(name, id string) (string, bool) {
		if name == "omp-audio-mixer" && id == "1.0" {
			return "/store/1.0/omp-audio-mixer", true
		}
		return "", false
	})
	if e, id, err := l.applyBinary(entry, ""); err != nil || id != "2.0" || e.Command[0] != "/store/prod/omp-audio-mixer" {
		t.Fatalf("ohne Pin: produktiv: %v %q %v", e.Command, id, err)
	}
	if e, id, err := l.applyBinary(entry, PinInstalled); err != nil || id != "" || e.Command[0] != entry.Command[0] {
		t.Fatalf("PinInstalled: Katalog-Binary trotz produktiver Version: %v %q %v", e.Command, id, err)
	}
	if e, id, err := l.applyBinary(entry, "1.0"); err != nil || id != "1.0" || e.Command[0] != "/store/1.0/omp-audio-mixer" {
		t.Fatalf("Pin auf Version: %v %q %v", e.Command, id, err)
	}
	if _, _, err := l.applyBinary(entry, "9.9"); err == nil {
		t.Fatal("unbekannte Version muss scheitern, nicht still auf ein anderes Binary fallen")
	}
	if entry.Command[0] != "../nodes/target/debug/omp-audio-mixer" {
		t.Fatal("Katalogeintrag unverändert")
	}
}
