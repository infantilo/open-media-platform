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
