package microsvc

import (
	"crypto/ed25519"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/infantilo/openmediaplatform/update"
)

func setup(t *testing.T, allow string) (*Store, ed25519.PrivateKey, string) {
	t.Helper()
	s, err := NewStore(t.TempDir(), ParseAllow(allow))
	if err != nil {
		t.Fatal(err)
	}
	s.MinFreeBytes = 0
	priv, pub, _ := update.GenerateDistKey()
	loadImage = func(string) error { return nil }
	imageID = func(string) (string, error) { return "sha256:abc", nil }
	t.Cleanup(func() { loadImage = nil })
	return s, priv, pub
}

func bundle(t *testing.T, priv ed25519.PrivateKey, entry map[string]any, imageID string) string {
	t.Helper()
	dir := t.TempDir()
	img := filepath.Join(dir, "img")
	os.WriteFile(img, []byte("IMG"), 0o600)
	e, _ := json.Marshal(entry)
	out := filepath.Join(dir, "b.tar")
	_, err := update.WriteBundle(out, update.BundleManifest{Format: update.BundleFormat, Type: "svc", Version: "2", Image: "localhost/svc:2", ImageID: imageID, Entry: e}, priv, img)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

var baseEntry = map[string]any{"type": "svc", "runner": "podman", "image": "localhost/svc:2"}

func TestInstallNeedsTrustedKey(t *testing.T) {
	s, priv, pub := setup(t, "")
	b := bundle(t, priv, baseEntry, "sha256:abc")
	if _, err := s.Install(b); err == nil || !strings.Contains(err.Error(), "Verteilschlüssel") {
		t.Fatalf("ohne Schlüssel muss abgelehnt werden: %v", err)
	}
	if err := s.TrustKey(pub); err != nil {
		t.Fatal(err)
	}
	in, err := s.Install(b)
	if err != nil || in.Version != "2" {
		t.Fatalf("%v %+v", err, in)
	}
	if e, ok := s.Find("svc", ""); !ok || e.Version != "2" {
		t.Fatalf("Find: %v %+v", ok, e)
	}
	// Neustart: neuer Store auf demselben Verzeichnis sieht die Installation
	s2, _ := NewStore(s.Dir(), ParseAllow(""))
	if _, ok := s2.Find("svc", "2"); !ok {
		t.Fatal("Installation geht beim Neustart verloren")
	}
}

func TestTrustKeyDoesNotSilentlyReplace(t *testing.T) {
	s, _, pub := setup(t, "")
	_, _, other := func() (int, int, string) { _, p, _ := update.GenerateDistKey(); return 0, 0, p }()
	if err := s.TrustKey(pub); err != nil {
		t.Fatal(err)
	}
	if err := s.TrustKey(pub); err != nil {
		t.Fatal("gleicher Schlüssel muss ok sein")
	}
	if err := s.TrustKey(other); err == nil {
		t.Fatal("anderer Schlüssel darf nicht ersetzen")
	}
}

func TestForeignSignatureRejected(t *testing.T) {
	s, _, pub := setup(t, "")
	s.TrustKey(pub)
	evil, _, _ := update.GenerateDistKey()
	if _, err := s.Install(bundle(t, evil, baseEntry, "sha256:abc")); err == nil {
		t.Fatal("fremd signiertes Bundle muss abgelehnt werden")
	}
	if len(s.List()) != 0 {
		t.Fatal("nichts darf installiert sein")
	}
}

func TestAllowlistRejectsInsteadOfWeakening(t *testing.T) {
	s, priv, pub := setup(t, "")
	s.TrustKey(pub)
	e := map[string]any{"type": "svc", "runner": "podman", "image": "localhost/svc:2", "hostNetwork": true, "mxlAccess": true}
	_, err := s.Install(bundle(t, priv, e, "sha256:abc"))
	if err == nil || !strings.Contains(err.Error(), "hostNetwork") || !strings.Contains(err.Error(), "mxlAccess") {
		t.Fatalf("erwartet Ablehnung mit beiden Opt-ins: %v", err)
	}
	s2, priv2, pub2 := setup(t, "hostNetwork, mxlAccess")
	s2.TrustKey(pub2)
	if _, err := s2.Install(bundle(t, priv2, e, "sha256:abc")); err != nil {
		t.Fatalf("mit Allowlist erwartet ok: %v", err)
	}
}

func TestImageIDMismatchRemovesImage(t *testing.T) {
	s, priv, pub := setup(t, "")
	s.TrustKey(pub)
	if _, err := s.Install(bundle(t, priv, baseEntry, "sha256:other")); err == nil || !strings.Contains(err.Error(), "Image-ID") {
		t.Fatalf("erwartet Image-ID-Fehler: %v", err)
	}
	if len(s.List()) != 0 {
		t.Fatal("bei falscher Image-ID darf nichts installiert sein")
	}
}

func TestRemoveBlockedWhileInUseThenOk(t *testing.T) {
	s, priv, pub := setup(t, "")
	s.TrustKey(pub)
	s.Install(bundle(t, priv, baseEntry, "sha256:abc"))
	if err := s.Remove("svc", "2", func(string, string) bool { return true }); err == nil {
		t.Fatal("laufende Instanz muss das Entfernen verhindern")
	}
	if err := s.Remove("svc", "2", func(string, string) bool { return false }); err != nil {
		t.Fatal(err)
	}
	if len(s.List()) != 0 {
		t.Fatal("noch installiert")
	}
	if err := s.Remove("svc", "2", nil); err != nil {
		t.Fatal("zweites Entfernen muss idempotent sein")
	}
	if err := s.Remove("../x", "2", nil); err == nil {
		t.Fatal("unzulässiger Name")
	}
}

func TestTwoVersionsParallel(t *testing.T) {
	s, priv, pub := setup(t, "")
	s.TrustKey(pub)
	s.Install(bundle(t, priv, baseEntry, "sha256:abc"))
	// zweite Version
	dir := t.TempDir()
	img := filepath.Join(dir, "img")
	os.WriteFile(img, []byte("IMG"), 0o600)
	e, _ := json.Marshal(map[string]any{"type": "svc", "runner": "podman", "image": "localhost/svc:3"})
	out := filepath.Join(dir, "b.tar")
	update.WriteBundle(out, update.BundleManifest{Format: update.BundleFormat, Type: "svc", Version: "3", Image: "localhost/svc:3", ImageID: "sha256:abc", Entry: e}, priv, img)
	if _, err := s.Install(out); err != nil {
		t.Fatal(err)
	}
	if e, _ := s.Find("svc", ""); e.Version != "3" {
		t.Fatalf("neueste erwartet, bekam %s", e.Version)
	}
	if e, ok := s.Find("svc", "2"); !ok || e.Version != "2" {
		t.Fatal("alte Version muss weiter findbar sein")
	}
}
