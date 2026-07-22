package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
)

// ARCHITECTURE.md §24.1, UMSETZUNG.md C16.

func TestHandleIssueServiceTokenWithValidSecretIssuesToken(t *testing.T) {
	launcherSvc := fakeLauncherService{
		instances: []launcher.Instance{{ID: "inst-1", LaunchSecret: "correct-secret"}},
	}
	expires := time.Now().Add(24 * time.Hour)
	authSvc := fakeAuthSvc{serviceToken: "signed-token", serviceExpires: expires}

	h := handleIssueServiceToken(launcherSvc, authSvc)

	body, _ := json.Marshal(serviceTokenRequest{LaunchSecret: "correct-secret"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/instances/inst-1/service-token", bytes.NewReader(body))
	req.SetPathValue("id", "inst-1")
	rec := httptest.NewRecorder()
	h(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", rec.Code, rec.Body.String())
	}
	var got serviceTokenResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if got.Token != "signed-token" {
		t.Errorf("token = %q, want %q", got.Token, "signed-token")
	}
}

func TestHandleIssueServiceTokenWithWrongSecretForbidden(t *testing.T) {
	launcherSvc := fakeLauncherService{
		instances: []launcher.Instance{{ID: "inst-1", LaunchSecret: "correct-secret"}},
	}
	authSvc := fakeAuthSvc{serviceToken: "signed-token"}
	h := handleIssueServiceToken(launcherSvc, authSvc)

	body, _ := json.Marshal(serviceTokenRequest{LaunchSecret: "wrong-secret"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/instances/inst-1/service-token", bytes.NewReader(body))
	req.SetPathValue("id", "inst-1")
	rec := httptest.NewRecorder()
	h(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403, body=%s", rec.Code, rec.Body.String())
	}
}

func TestHandleIssueServiceTokenUnknownInstanceNotFound(t *testing.T) {
	launcherSvc := fakeLauncherService{instances: nil}
	authSvc := fakeAuthSvc{}
	h := handleIssueServiceToken(launcherSvc, authSvc)

	body, _ := json.Marshal(serviceTokenRequest{LaunchSecret: "whatever"})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/instances/ghost/service-token", bytes.NewReader(body))
	req.SetPathValue("id", "ghost")
	rec := httptest.NewRecorder()
	h(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404, body=%s", rec.Code, rec.Body.String())
	}
}

func TestHandleIssueServiceTokenRemoteInstanceWithoutSecretForbidden(t *testing.T) {
	// Remote-Host-Agent-Instanzen (S3) bekommen heute kein LaunchSecret
	// mitgegeben (s. launcher.go-Doku) — der Aufruf muss dann 403
	// liefern, nicht versehentlich durchgehen.
	launcherSvc := fakeLauncherService{
		instances: []launcher.Instance{{ID: "inst-remote", HostID: "host-1", LaunchSecret: ""}},
	}
	authSvc := fakeAuthSvc{serviceToken: "signed-token"}
	h := handleIssueServiceToken(launcherSvc, authSvc)

	body, _ := json.Marshal(serviceTokenRequest{LaunchSecret: ""})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/instances/inst-remote/service-token", bytes.NewReader(body))
	req.SetPathValue("id", "inst-remote")
	rec := httptest.NewRecorder()
	h(rec, req)

	// Leeres launchSecret im Request-Body wird bereits als Bad Request
	// abgelehnt (s. Handler-Doku: "launchSecret required").
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body=%s", rec.Code, rec.Body.String())
	}
}

func TestHandleIssueServiceTokenMissingBodyBadRequest(t *testing.T) {
	launcherSvc := fakeLauncherService{}
	authSvc := fakeAuthSvc{}
	h := handleIssueServiceToken(launcherSvc, authSvc)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/instances/inst-1/service-token", strings.NewReader("{}"))
	req.SetPathValue("id", "inst-1")
	rec := httptest.NewRecorder()
	h(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body=%s", rec.Code, rec.Body.String())
	}
}
