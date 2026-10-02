package nodeversions

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"github.com/infantilo/openmediaplatform/update"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fakeBinary(t *testing.T, dir, name, version string, pad int) string {
	t.Helper()
	body := strings.Repeat("x", pad) + `OMPBUILD1{"version":"` + version + `","commit":"abc1234","builtAt":"2026-10-02T10:00:00Z"}OMPBUILD1END` + strings.Repeat("y", 100)
	p := filepath.Join(dir, fmt.Sprintf("%s-%s-%d", name, version, pad))
	if err := os.WriteFile(p, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestReadMarkerAcrossChunkBoundaries(t *testing.T) {
	dir := t.TempDir()
	// Marker liegt hinter dem ersten 4-MiB-Chunk und quer über eine Grenze.
	for _, pad := range []int{10, 4<<20 - 20, 4<<20 + 7, 9 << 20} {
		p := fakeBinary(t, dir, "omp-x", "2026.10.1", pad)
		info, err := ReadMarker(p)
		if err != nil || info.Version != "2026.10.1" || info.Commit != "abc1234" {
			t.Fatalf("pad %d: %+v %v", pad, info, err)
		}
	}
}

func TestReadMarkerMissing(t *testing.T) {
	p := filepath.Join(t.TempDir(), "plain")
	_ = os.WriteFile(p, []byte("kein stempel"), 0o755)
	if _, err := ReadMarker(p); !errors.Is(err, ErrNoMarker) {
		t.Fatalf("want ErrNoMarker, got %v", err)
	}
}

func TestStoreAddProductiveRollback(t *testing.T) {
	src, st := t.TempDir(), New(t.TempDir())
	v1 := fakeBinary(t, src, "omp-mixer", "2026.10.1", 100)
	v2 := fakeBinary(t, src, "omp-mixer", "2026.10.2", 100)

	a, err := st.Add("omp-mixer", v1, "Update")
	if err != nil || a.ID != "2026.10.1" {
		t.Fatalf("add v1: %+v %v", a, err)
	}
	if again, err := st.Add("omp-mixer", v1, "installiert"); err != nil || again.Source != "Update" {
		t.Fatalf("zweites Add derselben Datei muss den Bestand liefern: %+v %v", again, err)
	}
	if _, err := st.Add("omp-mixer", v2, "Update"); err != nil {
		t.Fatal(err)
	}
	if got := len(st.List("omp-mixer")); got != 2 {
		t.Fatalf("2 Versionen erwartet, %d", got)
	}

	if p, id := st.Resolve("omp-mixer"); p != "" || id != "" {
		t.Fatal("ohne Markierung gilt das installierte Binary")
	}
	if err := st.SetProductive("omp-mixer", "2026.10.2"); err != nil {
		t.Fatal(err)
	}
	p, id := st.Resolve("omp-mixer")
	if id != "2026.10.2" || !strings.HasSuffix(p, filepath.Join("2026.10.2", "omp-mixer")) {
		t.Fatalf("resolve: %q %q", p, id)
	}
	// Downgrade = andere Version markieren.
	if err := st.SetProductive("omp-mixer", "2026.10.1"); err != nil {
		t.Fatal(err)
	}
	if _, id := st.Resolve("omp-mixer"); id != "2026.10.1" {
		t.Fatal("Downgrade fehlgeschlagen")
	}
	if err := st.Delete("omp-mixer", "2026.10.1"); err == nil {
		t.Fatal("produktive Version darf nicht gelöscht werden")
	}
	if err := st.Delete("omp-mixer", "2026.10.2"); err != nil {
		t.Fatal(err)
	}
	if err := st.SetProductive("omp-mixer", "gibt-es-nicht"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unbekannte Version: %v", err)
	}
	if err := st.SetProductive("omp-mixer", ""); err != nil {
		t.Fatal(err)
	}
	if p, _ := st.Resolve("omp-mixer"); p != "" {
		t.Fatal("Markierung aufgehoben: wieder installiertes Binary")
	}
}

func TestSameVersionDifferentContentConflictsButDevDoesNot(t *testing.T) {
	src, st := t.TempDir(), New(t.TempDir())
	a := fakeBinary(t, src, "omp-m", "2026.10.1", 100)
	if _, err := st.Add("omp-m", a, ""); err != nil {
		t.Fatal(err)
	}
	b := fakeBinary(t, src, "omp-m", "2026.10.1", 200) // gleicher Stempel, anderer Inhalt
	if _, err := st.Add("omp-m", b, ""); !errors.Is(err, ErrConflict) {
		t.Fatalf("want ErrConflict, got %v", err)
	}
	d1 := fakeBinary(t, src, "omp-m", "dev", 100)
	d2 := fakeBinary(t, src, "omp-m", "dev", 300)
	v1, err1 := st.Add("omp-m", d1, "")
	v2, err2 := st.Add("omp-m", d2, "")
	if err1 != nil || err2 != nil || v1.ID == v2.ID || !strings.HasPrefix(v1.ID, "dev-") {
		t.Fatalf("dev-Builds sind eigene Stände: %+v %+v %v %v", v1, v2, err1, err2)
	}
}

func TestMissingProductiveFileFallsBack(t *testing.T) {
	src, st := t.TempDir(), New(t.TempDir())
	_, _ = st.Add("omp-m", fakeBinary(t, src, "omp-m", "1.0", 10), "")
	_ = st.SetProductive("omp-m", "1.0")
	_ = os.RemoveAll(filepath.Join(st.dir, "omp-m", "1.0"))
	if p, _ := st.Resolve("omp-m"); p != "" {
		t.Fatal("gelöschte produktive Version muss auf das installierte Binary zurückfallen")
	}
}

func TestRegisterPackageStoresNodeComponentsAndInstalledSkipsDev(t *testing.T) {
	src, st := t.TempDir(), New(t.TempDir())
	bin := fakeBinary(t, src, "omp-m", "2026.10.5", 50)
	data, _ := os.ReadFile(bin)
	sum := sha256.Sum256(data)

	pkg := filepath.Join(src, "pkg.tar.gz")
	f, _ := os.Create(pkg)
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	_ = tw.WriteHeader(&tar.Header{Name: "nodes/omp-m", Mode: 0o755, Size: int64(len(data)), Typeflag: tar.TypeReg})
	_, _ = tw.Write(data)
	_ = tw.Close()
	_ = gz.Close()
	_ = f.Close()

	m := update.Manifest{Version: "2026.10.5", Components: []update.Component{
		{ID: "n", Path: "nodes/omp-m", SHA256: hex.EncodeToString(sum[:]), Target: "node:omp-m"},
		{ID: "o", Path: "orchestrator/omp-orchestrator", SHA256: "x", Target: "bin/omp-orchestrator"},
	}}
	got, err := st.RegisterPackage(pkg, m, "Update 2026.10.5")
	if err != nil || len(got) != 1 || got[0].ID != "2026.10.5" || got[0].Source != "Update 2026.10.5" {
		t.Fatalf("RegisterPackage: %+v %v", got, err)
	}
	if _, err := st.Path("omp-m", "2026.10.5"); err != nil {
		t.Fatal(err)
	}

	dev := fakeBinary(t, src, "omp-d", "dev", 10)
	added, skipped := st.RegisterInstalled(map[string]string{"omp-d": dev, "omp-m2": bin})
	if len(added) != 1 || added[0].Name != "omp-m2" || skipped["omp-d"] == "" {
		t.Fatalf("added=%+v skipped=%+v", added, skipped)
	}
}
