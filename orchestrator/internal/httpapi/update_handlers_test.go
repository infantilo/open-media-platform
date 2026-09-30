package httpapi

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/backup"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/updates"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/version"
	"github.com/infantilo/openmediaplatform/update"
)

type updateEnv struct {
	svc  *updates.Service
	priv ed25519.PrivateKey
	dir  string
}

func newUpdateEnv(t *testing.T, allowUnsigned bool) updateEnv {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	keyFile := filepath.Join(dir, "trusted.pub")
	if err := os.WriteFile(keyFile, []byte(base64.StdEncoding.EncodeToString(pub)+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return updateEnv{svc: updates.New(filepath.Join(dir, "updates"), keyFile, allowUnsigned, "", 0), priv: priv, dir: dir}
}

func (e updateEnv) pkg(t *testing.T, ver string, migrations []string, sign bool) []byte {
	t.Helper()
	src := filepath.Join(e.dir, "bin-"+ver)
	if err := os.WriteFile(src, []byte("BINARY "+ver), 0o755); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(e.dir, "pkg-"+ver+".tar.gz")
	var priv ed25519.PrivateKey
	if sign {
		priv = e.priv
	}
	err := update.Build(out, update.Manifest{Version: ver, Arch: "linux/amd64", Migrations: migrations}, priv,
		[]update.BuildFile{{ID: "orchestrator", Source: src, Path: "bin/omp-orchestrator", Target: "bin/omp-orchestrator"}})
	if err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(out)
	return data
}

func (e updateEnv) upload(t *testing.T, data []byte) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	handleUploadUpdate(e.svc, nil)(rec, httptest.NewRequest(http.MethodPost, "/api/v1/admin/updates/upload", bytes.NewReader(data)))
	return rec
}

type fakeUpdateSupervisor struct {
	file string
	err  error
}

func (f *fakeUpdateSupervisor) TriggerUpdate(_ context.Context, file string) error {
	f.file = file
	return f.err
}
func (f *fakeUpdateSupervisor) Status(context.Context) (json.RawMessage, error) {
	return json.RawMessage(`{"busy":false}`), nil
}

type countingBackup struct {
	fakeBackupSvc
	created int
}

func (c *countingBackup) Create(ctx context.Context) (backup.Result, error) {
	c.created++
	return backup.Result{Name: "omp-test.sql.gz"}, nil
}

func decodeEntry(t *testing.T, rec *httptest.ResponseRecorder) updates.Entry {
	t.Helper()
	var e updates.Entry
	if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil {
		t.Fatalf("decode entry: %v (%s)", err, rec.Body.String())
	}
	return e
}

func TestUploadUpdateAcceptsSignedRejectsOthers(t *testing.T) {
	e := newUpdateEnv(t, false)

	rec := e.upload(t, e.pkg(t, "2026.10.0", nil, true))
	if rec.Code != http.StatusCreated {
		t.Fatalf("signed upload: status = %d body=%s", rec.Code, rec.Body.String())
	}
	entry := decodeEntry(t, rec)
	if !entry.Signed || entry.Version != "2026.10.0" {
		t.Errorf("entry = %+v", entry)
	}

	if rec := e.upload(t, e.pkg(t, "2026.10.1", nil, false)); rec.Code != http.StatusBadRequest {
		t.Errorf("unsigned upload: status = %d, want 400", rec.Code)
	}
	if rec := e.upload(t, []byte("das ist kein archiv")); rec.Code != http.StatusBadRequest {
		t.Errorf("garbage upload: status = %d, want 400", rec.Code)
	}
	list, _ := e.svc.List()
	if len(list) != 1 {
		t.Errorf("stored packages = %d, want exactly the one valid package", len(list))
	}
	// nach abgelehnten Uploads dürfen keine Reste im Verzeichnis liegen
	left, _ := filepath.Glob(filepath.Join(e.svc.Dir(), "incoming-*"))
	if len(left) != 0 {
		t.Errorf("leftover temp files: %v", left)
	}
}

func TestUploadUpdateAllowUnsignedDevSwitch(t *testing.T) {
	e := newUpdateEnv(t, true)
	if rec := e.upload(t, e.pkg(t, "2026.10.0", nil, false)); rec.Code != http.StatusCreated {
		t.Fatalf("unsigned with switch: status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func apply(e updateEnv, id string, sup UpdateSupervisor, bk BackupService, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/updates/"+id+"/apply", strings.NewReader(body))
	req.SetPathValue("id", id)
	handleApplyUpdate(e.svc, sup, bk, nil)(rec, req)
	return rec
}

func TestApplyUpdateFlow(t *testing.T) {
	old := version.Version
	defer func() { version.Version = old }()
	version.Version = "2026.9.0"

	e := newUpdateEnv(t, false)
	entry := decodeEntry(t, e.upload(t, e.pkg(t, "2026.10.0", nil, true)))
	entry, _ = e.svc.Get(entry.ID) // File ist nicht Teil des JSON
	sup := &fakeUpdateSupervisor{}
	bk := &countingBackup{}

	if rec := apply(e, entry.ID, sup, bk, `{"version":"2026.10.0"}`); rec.Code != http.StatusBadRequest {
		t.Errorf("missing confirm: status = %d, want 400", rec.Code)
	}
	if rec := apply(e, entry.ID, sup, bk, `{"confirm":true,"version":"9.9"}`); rec.Code != http.StatusBadRequest {
		t.Errorf("wrong typed version: status = %d, want 400", rec.Code)
	}
	if sup.file != "" || bk.created != 0 {
		t.Fatal("nothing may happen before the confirmation is valid")
	}

	rec := apply(e, entry.ID, sup, bk, `{"confirm":true,"version":"2026.10.0"}`)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("apply: status = %d body=%s", rec.Code, rec.Body.String())
	}
	if sup.file != entry.File {
		t.Errorf("supervisor got %q, want %q", sup.file, entry.File)
	}
	if bk.created != 1 {
		t.Errorf("backup created %d times, want 1 (default on)", bk.created)
	}
}

func TestApplyUpdateBackupMandatoryWithMigrations(t *testing.T) {
	old := version.Version
	defer func() { version.Version = old }()
	version.Version = "2026.9.0"

	e := newUpdateEnv(t, false)
	entry := decodeEntry(t, e.upload(t, e.pkg(t, "2026.10.0", []string{"0031_x.sql"}, true)))
	bk := &countingBackup{}
	rec := apply(e, entry.ID, &fakeUpdateSupervisor{}, bk, `{"confirm":true,"version":"2026.10.0","backup":false}`)
	if rec.Code != http.StatusAccepted || bk.created != 1 {
		t.Errorf("status=%d backups=%d — backup must not be skippable when migrations exist", rec.Code, bk.created)
	}
}

func TestApplyUpdateDowngradeAndMinVersion(t *testing.T) {
	old := version.Version
	defer func() { version.Version = old }()
	version.Version = "2026.11.0"

	e := newUpdateEnv(t, false)
	entry := decodeEntry(t, e.upload(t, e.pkg(t, "2026.10.0", nil, true)))
	sup := &fakeUpdateSupervisor{}
	if rec := apply(e, entry.ID, sup, &countingBackup{}, `{"confirm":true,"version":"2026.10.0"}`); rec.Code != http.StatusConflict {
		t.Errorf("downgrade: status = %d, want 409", rec.Code)
	}
	if rec := apply(e, entry.ID, sup, &countingBackup{}, `{"confirm":true,"version":"2026.10.0","force":true}`); rec.Code != http.StatusAccepted {
		t.Errorf("forced downgrade: status = %d, want 202", rec.Code)
	}
}

func TestApplyUpdateSupervisorDownAborts(t *testing.T) {
	old := version.Version
	defer func() { version.Version = old }()
	version.Version = "dev"

	e := newUpdateEnv(t, false)
	entry := decodeEntry(t, e.upload(t, e.pkg(t, "2026.10.0", nil, true)))
	rec := apply(e, entry.ID, &fakeUpdateSupervisor{err: errors.New("refused")}, &countingBackup{}, `{"confirm":true,"version":"2026.10.0"}`)
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", rec.Code)
	}
}

func TestApplyUpdateRejectsTamperedPackage(t *testing.T) {
	e := newUpdateEnv(t, false)
	entry := decodeEntry(t, e.upload(t, e.pkg(t, "2026.10.0", nil, true)))
	entry, _ = e.svc.Get(entry.ID)
	// Archiv nach dem Upload verändern.
	f, err := os.OpenFile(entry.File, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.Write([]byte("tampered"))
	_ = f.Close()
	sup := &fakeUpdateSupervisor{}
	rec := apply(e, entry.ID, sup, &countingBackup{}, `{"confirm":true,"version":"2026.10.0"}`)
	if rec.Code != http.StatusBadRequest || sup.file != "" {
		t.Errorf("tampered: status=%d supervisorCalled=%v, want 400 and no call", rec.Code, sup.file != "")
	}
}

func TestDeleteAndUnknownUpdate(t *testing.T) {
	e := newUpdateEnv(t, false)
	entry := decodeEntry(t, e.upload(t, e.pkg(t, "2026.10.0", nil, true)))

	del := func(id string) int {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodDelete, "/api/v1/admin/updates/"+id, nil)
		req.SetPathValue("id", id)
		handleDeleteUpdate(e.svc, nil)(rec, req)
		return rec.Code
	}
	if c := del("../../etc/passwd"); c != http.StatusNotFound {
		t.Errorf("traversal id: status = %d, want 404", c)
	}
	if c := del(entry.ID); c != http.StatusNoContent {
		t.Errorf("delete: status = %d, want 204", c)
	}
	if c := del(entry.ID); c != http.StatusNotFound {
		t.Errorf("second delete: status = %d, want 404", c)
	}
}

func TestUpdatesDisabledWithoutOption(t *testing.T) {
	rec := httptest.NewRecorder()
	handleUploadUpdate(nil, nil)(rec, httptest.NewRequest(http.MethodPost, "/x", nil))
	if rec.Code != http.StatusNotImplemented {
		t.Errorf("status = %d, want 501", rec.Code)
	}
}

func TestProcessStartTimePlausible(t *testing.T) {
	st, ok := processStartTime(os.Getpid())
	if !ok {
		t.Skip("/proc nicht verfügbar")
	}
	if d := st.Sub(time.Now()); d > 2*1e9 || d < -3600*1e9*24*365 {
		t.Errorf("start time %v implausible", st)
	}
}

type fakeDistributor struct {
	started  []updates.Entry
	busy     bool
	tokenFor map[string]string
}

func (f *fakeDistributor) Start(e updates.Entry) (updates.Distribution, error) {
	if f.busy {
		return updates.Distribution{}, updates.ErrBusy
	}
	f.started = append(f.started, e)
	return updates.Distribution{PackageID: e.ID, Version: e.Version, Running: true}, nil
}
func (f *fakeDistributor) Last() *updates.Distribution { return nil }
func (f *fakeDistributor) CheckToken(id, token string) bool {
	return f.tokenFor[id] != "" && f.tokenFor[id] == token
}

func TestDistributeUpdate(t *testing.T) {
	e := newUpdateEnv(t, false)
	entry := decodeEntry(t, e.upload(t, e.pkg(t, "2026.10.0", nil, true)))
	dist := &fakeDistributor{}
	call := func(body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(body))
		req.SetPathValue("id", entry.ID)
		handleDistributeUpdate(e.svc, dist, nil)(rec, req)
		return rec
	}
	if rec := call(`{"version":"2026.10.0"}`); rec.Code != http.StatusBadRequest {
		t.Errorf("missing confirm: %d", rec.Code)
	}
	if rec := call(`{"confirm":true,"version":"1"}`); rec.Code != http.StatusBadRequest {
		t.Errorf("wrong version: %d", rec.Code)
	}
	if len(dist.started) != 0 {
		t.Fatal("nothing may start before a valid confirmation")
	}
	if rec := call(`{"confirm":true,"version":"2026.10.0"}`); rec.Code != http.StatusAccepted || len(dist.started) != 1 {
		t.Errorf("valid: status=%d started=%d", rec.Code, len(dist.started))
	}
	dist.busy = true
	if rec := call(`{"confirm":true,"version":"2026.10.0"}`); rec.Code != http.StatusConflict {
		t.Errorf("busy: %d, want 409", rec.Code)
	}
}

func TestHostUpdateDownloadNeedsValidToken(t *testing.T) {
	e := newUpdateEnv(t, false)
	entry := decodeEntry(t, e.upload(t, e.pkg(t, "2026.10.0", nil, true)))
	dist := &fakeDistributor{tokenFor: map[string]string{entry.ID: "good"}}
	get := func(id, token string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/v1/host-updates/"+id+"?token="+token, nil)
		req.SetPathValue("id", id)
		handleHostUpdateDownload(e.svc, dist)(rec, req)
		return rec
	}
	if rec := get(entry.ID, ""); rec.Code != http.StatusForbidden {
		t.Errorf("no token: %d, want 403", rec.Code)
	}
	if rec := get(entry.ID, "bad"); rec.Code != http.StatusForbidden {
		t.Errorf("bad token: %d, want 403", rec.Code)
	}
	rec := get(entry.ID, "good")
	if rec.Code != http.StatusOK || rec.Body.Len() == 0 {
		t.Fatalf("good token: %d len=%d", rec.Code, rec.Body.Len())
	}
	// Token einer anderen Paket-ID gilt nicht.
	if rec := get("2026.10.1-aaaaaaaaaaaa", "good"); rec.Code != http.StatusForbidden {
		t.Errorf("token for other package: %d, want 403", rec.Code)
	}
}
