package update

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestReadBuildMarker(t *testing.T) {
	dir := t.TempDir()
	// Marker mitten in großem Füllmaterial, damit die Chunk-Grenze überquert wird
	pad := bytes.Repeat([]byte{0x41}, 4<<20+100)
	data := append(append(append([]byte{}, pad...), []byte(`OMPBUILD1{"version":"1.2","commit":"abc"}OMPBUILD1END`)...), pad[:1000]...)
	p := filepath.Join(dir, "bin")
	os.WriteFile(p, data, 0o755)
	raw, err := ReadBuildMarker(p)
	if err != nil || string(raw) != `{"version":"1.2","commit":"abc"}` {
		t.Fatalf("%q %v", raw, err)
	}
	os.WriteFile(p, pad, 0o755)
	if _, err := ReadBuildMarker(p); !errors.Is(err, ErrNoBuildMarker) {
		t.Fatalf("ohne Marker: %v", err)
	}
	if _, err := ReadBuildMarker(filepath.Join(dir, "fehlt")); err == nil {
		t.Fatal("fehlende Datei")
	}
}
