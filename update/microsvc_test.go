package update

import (
	"crypto/ed25519"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func mkBundle(t *testing.T) (path string, priv ed25519.PrivateKey, pub ed25519.PublicKey) {
	t.Helper()
	dir := t.TempDir()
	img := filepath.Join(dir, "img.tar")
	os.WriteFile(img, []byte("fake image bytes"), 0o600)
	pub, priv, _ = ed25519.GenerateKey(nil)
	entry, _ := json.Marshal(map[string]any{"type": "svc", "runner": "podman", "image": "localhost/svc:1"})
	path = filepath.Join(dir, "b.tar")
	if _, err := WriteBundle(path, BundleManifest{Format: BundleFormat, Type: "svc", Version: "1", Image: "localhost/svc:1", ImageID: "sha256:abc", Entry: entry}, priv, img); err != nil {
		t.Fatal(err)
	}
	return path, priv, pub
}

func TestBundleRoundtrip(t *testing.T) {
	path, _, pub := mkBundle(t)
	dst := filepath.Join(t.TempDir(), "out.tar")
	m, _, err := OpenBundle(path, []ed25519.PublicKey{pub}, dst)
	if err != nil || m.Type != "svc" {
		t.Fatalf("%v %+v", err, m)
	}
	if b, _ := os.ReadFile(dst); string(b) != "fake image bytes" {
		t.Fatalf("image: %q", b)
	}
}

func TestBundleRejectsForeignKeyAndTamper(t *testing.T) {
	path, _, _ := mkBundle(t)
	other, _, _ := ed25519.GenerateKey(nil)
	dst := filepath.Join(t.TempDir(), "out.tar")
	if _, _, err := OpenBundle(path, []ed25519.PublicKey{other}, dst); err == nil {
		t.Fatal("fremder Schlüssel muss abgelehnt werden")
	}
	if _, err := os.Stat(dst); err == nil {
		t.Fatal("bei ungültiger Signatur darf nichts extrahiert werden")
	}
	// Image-Bytes manipulieren (Signatur bleibt gültig, Prüfsumme nicht)
	path2, _, pub2 := mkBundle(t)
	b, _ := os.ReadFile(path2)
	i := indexOf(b, []byte("fake image bytes"))
	b[i] ^= 0xff
	os.WriteFile(path2, b, 0o600)
	if _, _, err := OpenBundle(path2, []ed25519.PublicKey{pub2}, dst); err == nil {
		t.Fatal("manipuliertes Image muss abgelehnt werden")
	}
	if _, err := os.Stat(dst); err == nil {
		t.Fatal("manipuliertes Image darf nicht liegen bleiben")
	}
}

func TestBundleNames(t *testing.T) {
	for _, bad := range []string{"", "../x", "a/b", "-x", "a b"} {
		if ValidBundleName(bad) {
			t.Errorf("%q gilt fälschlich als gültig", bad)
		}
	}
	if !ValidBundleName("omp-svc_1.2") {
		t.Error("gültiger Name abgelehnt")
	}
}

func indexOf(b, sub []byte) int {
	for i := 0; i+len(sub) <= len(b); i++ {
		if string(b[i:i+len(sub)]) == string(sub) {
			return i
		}
	}
	return -1
}
