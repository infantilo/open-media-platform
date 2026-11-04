package httpapi

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/catalogdist"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/hostsoftware"
)

type fakeDist struct {
	distributed []string
	withdrawn   []string
	err         error
	file        string
}

func (f *fakeDist) Distribute(typ, version string, hosts []string) error {
	f.distributed = append(f.distributed, typ+"@"+version+":"+strings.Join(hosts, ","))
	return f.err
}
func (f *fakeDist) Withdraw(typ, version string, hosts []string) error {
	f.withdrawn = append(f.withdrawn, typ+"@"+version+":"+strings.Join(hosts, ","))
	return f.err
}
func (f *fakeDist) Retry(typ, version, host string) error { return f.err }
func (f *fakeDist) Rows() ([]catalogdist.Row, error) {
	return []catalogdist.Row{{Type: "svc", Version: "1", HostID: "h1", State: "ok"}}, nil
}
func (f *fakeDist) BundleFile(id string) (string, bool) { return f.file, id == "good" }
func (f *fakeDist) CheckToken(id, token string) bool    { return token == "tok-"+id }

func TestDistributeHandler(t *testing.T) {
	f := &fakeDist{}
	h := handleDistributeCatalog(f, nil)
	r := httptest.NewRequest("POST", "/api/v1/catalog/svc/hosts", strings.NewReader(`{"version":"1","hostIds":["h1","h2"]}`))
	r.SetPathValue("type", "svc")
	w := httptest.NewRecorder()
	h(w, r)
	if w.Code != http.StatusAccepted || len(f.distributed) != 1 || f.distributed[0] != "svc@1:h1,h2" {
		t.Fatalf("%d %v", w.Code, f.distributed)
	}
	// unbekannter Typ → 404, unzulässig → 400
	f.err = catalogdist.ErrUnknownType
	w = httptest.NewRecorder()
	r = httptest.NewRequest("POST", "/x", strings.NewReader(`{"version":"1","hostIds":["h1"]}`))
	r.SetPathValue("type", "nope")
	h(w, r)
	if w.Code != http.StatusNotFound {
		t.Fatalf("unbekannter Typ: %d", w.Code)
	}
	w = httptest.NewRecorder()
	h(w, httptest.NewRequest("POST", "/x", strings.NewReader(`not json`)))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("kaputtes JSON: %d", w.Code)
	}
	// deaktiviert
	w = httptest.NewRecorder()
	handleDistributeCatalog(nil, nil)(w, httptest.NewRequest("POST", "/x", strings.NewReader(`{}`)))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("ohne Verteiler: %d", w.Code)
	}
}

func TestWithdrawHandlerPassesHostAndVersion(t *testing.T) {
	f := &fakeDist{}
	r := httptest.NewRequest("DELETE", "/api/v1/catalog/svc/hosts?version=2&hostId=h9", nil)
	r.SetPathValue("type", "svc")
	w := httptest.NewRecorder()
	handleWithdrawCatalog(f, nil)(w, r)
	if w.Code != http.StatusAccepted || f.withdrawn[0] != "svc@2:h9" {
		t.Fatalf("%d %v", w.Code, f.withdrawn)
	}
	r = httptest.NewRequest("DELETE", "/api/v1/catalog/svc/hosts?version=2", nil)
	r.SetPathValue("type", "svc")
	handleWithdrawCatalog(f, nil)(httptest.NewRecorder(), r)
	if f.withdrawn[1] != "svc@2:" {
		t.Fatalf("ohne hostId = alle Hosts: %v", f.withdrawn)
	}
}

func TestListDistributionWithoutDistributorIsEmptyList(t *testing.T) {
	w := httptest.NewRecorder()
	handleListCatalogDistribution(nil)(w, httptest.NewRequest("GET", "/x", nil))
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatalf("%d %q", w.Code, w.Body.String())
	}
}

func TestHostCatalogDownloadNeedsToken(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "b.tar")
	os.WriteFile(file, []byte("BUNDLE"), 0o600)
	f := &fakeDist{file: file}
	get := func(id, token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", "/api/v1/host-catalog/"+id+"?token="+token, nil)
		r.SetPathValue("id", id)
		w := httptest.NewRecorder()
		handleHostCatalogDownload(f)(w, r)
		return w
	}
	if w := get("good", ""); w.Code != http.StatusForbidden {
		t.Fatalf("ohne Token: %d", w.Code)
	}
	if w := get("good", "tok-other"); w.Code != http.StatusForbidden {
		t.Fatalf("falsches Token: %d", w.Code)
	}
	if w := get("bad", "tok-bad"); w.Code != http.StatusNotFound {
		t.Fatalf("unbekanntes Bundle: %d", w.Code)
	}
	if w := get("good", "tok-good"); w.Code != 200 || w.Body.String() != "BUNDLE" {
		t.Fatalf("gültig: %d %q", w.Code, w.Body.String())
	}
	w := httptest.NewRecorder()
	handleHostCatalogDownload(nil)(w, httptest.NewRequest("GET", "/x", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("deaktiviert: %d", w.Code)
	}
}

func TestNotInstalledStartIsConflict(t *testing.T) {
	w := httptest.NewRecorder()
	writeLauncherError(w, fmt.Errorf("start: %w", catalogdist.ErrNotInstalled))
	if w.Code != http.StatusConflict {
		t.Fatalf("erwartet 409, bekam %d", w.Code)
	}
}

type fakeSW struct{ force bool }

func (f *fakeSW) Collect(force bool) (hostsoftware.Report, error) {
	f.force = force
	return hostsoftware.Report{Orchestrator: hostsoftware.Build{Version: "dev"}, Hosts: []hostsoftware.Host{{Label: "A"}}}, nil
}

func TestHostSoftwareHandler(t *testing.T) {
	f := &fakeSW{}
	w := httptest.NewRecorder()
	handleHostSoftware(f)(w, httptest.NewRequest("GET", "/api/v1/hosts/software?refresh=1", nil))
	if w.Code != 200 || !f.force || !strings.Contains(w.Body.String(), `"label":"A"`) {
		t.Fatalf("%d %v %s", w.Code, f.force, w.Body.String())
	}
	w = httptest.NewRecorder()
	handleHostSoftware(nil)(w, httptest.NewRequest("GET", "/x", nil))
	if w.Code != 404 {
		t.Fatalf("deaktiviert: %d", w.Code)
	}
}
