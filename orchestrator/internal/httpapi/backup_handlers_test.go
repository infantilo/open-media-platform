package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandleRestoreRequiresConfirm(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/restore", strings.NewReader(`{"file":"omp-fake.sql.gz"}`))
	handleRestore(fakeBackupSvc{}, fakeSupervisorClient{})(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (missing confirm)", rec.Code)
	}
}

func TestHandleRestoreRejectsUnknownBackupFile(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/restore", strings.NewReader(`{"file":"omp-fake.sql.gz","confirm":true}`))
	handleRestore(fakeBackupSvcRejectingPath{}, fakeSupervisorClient{})(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (unknown backup file)", rec.Code)
	}
}

func TestHandleRestoreSucceedsAndTriggersSupervisor(t *testing.T) {
	var gotFile string
	supervisor := fakeSupervisorClientCapturing{onTrigger: func(file string) { gotFile = file }}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/restore", strings.NewReader(`{"file":"omp-fake.sql.gz","confirm":true}`))
	handleRestore(fakeBackupSvc{}, supervisor)(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202, body=%s", rec.Code, rec.Body.String())
	}
	if gotFile != "omp-fake.sql.gz" {
		t.Errorf("supervisor got file %q, want omp-fake.sql.gz", gotFile)
	}
}

func TestHandleRestoreReportsSupervisorUnavailable(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/restore", strings.NewReader(`{"file":"omp-fake.sql.gz","confirm":true}`))
	handleRestore(fakeBackupSvc{}, fakeSupervisorClient{err: errors.New("connection refused")})(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (supervisor unreachable)", rec.Code)
	}
}

// fakeBackupSvcRejectingPath — Path() lehnt jeden Dateinamen ab, wie es
// ein echter backup.Service für eine nicht existierende Datei täte.
type fakeBackupSvcRejectingPath struct{ fakeBackupSvc }

func (fakeBackupSvcRejectingPath) Path(name string) (string, error) {
	return "", errors.New("backup nicht gefunden")
}

// fakeSupervisorClientCapturing — zeichnet den übergebenen Dateinamen auf.
type fakeSupervisorClientCapturing struct{ onTrigger func(file string) }

func (f fakeSupervisorClientCapturing) TriggerRestore(_ context.Context, file string) error {
	f.onTrigger(file)
	return nil
}
