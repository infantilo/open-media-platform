package httpapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/nodeversions"
	"github.com/infantilo/openmediaplatform/update"
)

func stampedBinary(version string) []byte {
	return []byte("ELF.." + `OMPBUILD1{"version":"` + version + `","commit":"c0ffee1"}OMPBUILD1END` + "..tail")
}

// Upload eines signierten Pakets legt die Node-Binaries im Versionsspeicher ab;
// produktiv setzen/zurücknehmen verändert die Auflösung und das Veraltet-Flag.
func TestNodeVersionsFromUploadToProductiveAndBack(t *testing.T) {
	e := newUpdateEnv(t, false)
	store := nodeversions.New(filepath.Join(e.dir, "nv"))

	// Paket mit einem Node-Binary (Ziel node:omp-mixer) bauen und hochladen.
	src := filepath.Join(e.dir, "omp-mixer-src")
	if err := os.WriteFile(src, stampedBinary("2026.10.2"), 0o755); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(e.dir, "pkg.tar.gz")
	if err := update.Build(out, update.Manifest{Version: "2026.10.2", Arch: "linux/amd64"}, e.priv,
		[]update.BuildFile{{ID: "mixer", Source: src, Path: "nodes/omp-mixer", Target: "node:omp-mixer"}}); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(out)
	rec := httptest.NewRecorder()
	handleUploadUpdate(e.svc, store, nil)(rec, httptest.NewRequest(http.MethodPost, "/u", bytes.NewReader(data)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("upload: %d %s", rec.Code, rec.Body)
	}
	if got := store.List("omp-mixer"); len(got) != 1 || got[0].ID != "2026.10.2" {
		t.Fatalf("Versionsspeicher nach Upload: %+v", got)
	}

	// Installiertes Binary (ältere Version) im Katalog.
	installed := filepath.Join(e.dir, "omp-mixer")
	_ = os.WriteFile(installed, stampedBinary("2026.10.1"), 0o755)
	svc := fakeLauncherService{
		catalog:   []launcher.CatalogEntry{{Type: "audio-mixer", Runner: "process", Command: []string{installed}}},
		instances: []launcher.Instance{{ID: "i1", Type: "audio-mixer", Label: "A", PID: 0}},
	}

	list := func() nodeVersionType {
		rec := httptest.NewRecorder()
		handleListNodeVersions(store, svc)(rec, httptest.NewRequest(http.MethodGet, "/l", nil))
		var out struct {
			Types []nodeVersionType `json:"types"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || len(out.Types) != 1 {
			t.Fatalf("list: %v %s", err, rec.Body)
		}
		return out.Types[0]
	}
	l := list()
	if l.Installed == nil || l.Installed.Version != "2026.10.1" || l.Productive != "" || len(l.Versions) != 1 {
		t.Fatalf("Ausgangslage: %+v", l)
	}

	set := func(v string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPut, "/p", strings.NewReader(`{"version":"`+v+`"}`))
		req.SetPathValue("name", "omp-mixer")
		handleSetProductiveNodeVersion(store, svc, nil)(rec, req)
		return rec
	}
	if rec := set("2026.10.2"); rec.Code != http.StatusOK {
		t.Fatalf("set: %d %s", rec.Code, rec.Body)
	}
	if l := list(); l.Productive != "2026.10.2" {
		t.Fatalf("produktiv: %+v", l)
	}
	if p, id := store.Resolve("omp-mixer"); id != "2026.10.2" || p == "" {
		t.Fatalf("Resolve: %q %q", p, id)
	}
	if rec := set("9.9.9"); rec.Code != http.StatusNotFound {
		t.Fatalf("unbekannte Version: %d", rec.Code)
	}
	if rec := set(""); rec.Code != http.StatusOK {
		t.Fatalf("Zurücksetzen: %d", rec.Code)
	}
	if _, id := store.Resolve("omp-mixer"); id != "" {
		t.Fatal("nach dem Zurücksetzen gilt das installierte Binary")
	}

	// Rescan archiviert die installierte Version.
	rec = httptest.NewRecorder()
	handleRescanNodeVersions(store, svc, nil)(rec, httptest.NewRequest(http.MethodPost, "/r", nil))
	if rec.Code != http.StatusOK || len(store.List("omp-mixer")) != 2 {
		t.Fatalf("rescan: %d %s / %+v", rec.Code, rec.Body, store.List("omp-mixer"))
	}
}

func TestNodeVersionsDisabledIs501(t *testing.T) {
	rec := httptest.NewRecorder()
	handleListNodeVersions(nil, fakeLauncherService{})(rec, httptest.NewRequest(http.MethodGet, "/l", nil))
	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("want 501, got %d", rec.Code)
	}
}

func stampedContract(version string, contract int) []byte {
	return []byte("ELF.." + `OMPBUILD1{"contract":` + strconv.Itoa(contract) + `,"version":"` + version + `"}OMPBUILD1END` + "..")
}

// Wechsel über Contract-Generationen: unbekannte Generation nie, bekannte nur mit Bestätigung.
func TestSetProductiveChecksContractGeneration(t *testing.T) {
	dir := t.TempDir()
	store := nodeversions.New(filepath.Join(dir, "nv"))
	put := func(file string, b []byte) string {
		p := filepath.Join(dir, file)
		_ = os.WriteFile(p, b, 0o755)
		return p
	}
	installed := put("omp-mixer", stampedContract("1.0", 1))
	if _, err := store.Add("omp-mixer", put("v-same", stampedContract("1.1", 1)), ""); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Add("omp-mixer", put("v-new", stampedContract("2.0", 2)), ""); err != nil {
		t.Fatal(err)
	}
	svc := fakeLauncherService{catalog: []launcher.CatalogEntry{{Type: "audio-mixer", Runner: "process", Command: []string{installed}}}}
	set := func(v string, force bool) int {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPut, "/p", strings.NewReader(fmt.Sprintf(`{"version":%q,"force":%v}`, v, force)))
		req.SetPathValue("name", "omp-mixer")
		handleSetProductiveNodeVersion(store, svc, nil)(rec, req)
		return rec.Code
	}
	if c := set("1.1", false); c != 200 {
		t.Fatalf("gleiche Generation: %d", c)
	}
	if c := set("2.0", true); c != 409 {
		t.Fatalf("unbekannte Generation 2 darf auch mit force nie produktiv werden: %d", c)
	}
	if store.Productive("omp-mixer") != "1.1" {
		t.Fatal("Markierung darf sich nicht geändert haben")
	}
}
