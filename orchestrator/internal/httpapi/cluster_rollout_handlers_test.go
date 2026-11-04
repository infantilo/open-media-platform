package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/cluster"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/clusterupdate"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/updates"
	"github.com/infantilo/openmediaplatform/update"
)

type restartSup struct {
	fakeUpdateSupervisor
	restarts int
}

func (r *restartSup) TriggerRestart(context.Context) error { r.restarts++; return nil }

func rollingPkg(t *testing.T, e updateEnv, ver string, rolling bool) []byte {
	t.Helper()
	src := filepath.Join(e.dir, "rbin-"+ver)
	_ = os.WriteFile(src, []byte("BINARY "+ver), 0o755)
	out := filepath.Join(e.dir, "rpkg-"+ver+".tar.gz")
	err := update.Build(out, update.Manifest{Version: ver, Arch: "linux/amd64", RollingSafe: rolling}, e.priv,
		[]update.BuildFile{{ID: "orchestrator", Source: src, Path: "bin/omp-orchestrator", Target: "bin/omp-orchestrator"}})
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(out)
	return b
}

func memberCall(h http.HandlerFunc, token string, body any) *httptest.ResponseRecorder {
	b, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/x", bytes.NewReader(b))
	if token != "" {
		req.Header.Set(clusterupdate.TokenHeader, token)
	}
	rec := httptest.NewRecorder()
	h(rec, req)
	return rec
}

func TestMemberRoutesRejectMissingAndForeignToken(t *testing.T) {
	tok := clusterupdate.DeriveToken([]byte("secret"))
	foreign := clusterupdate.DeriveToken([]byte("anderes"))
	e := newUpdateEnv(t, false)
	cs := fakeClusterService{status: cluster.Status{Term: 3}}
	hs := map[string]http.HandlerFunc{
		"info":  handleMemberInfo(tok, cs),
		"fetch": handleMemberFetch(tok, e.svc, nil),
		"apply": handleMemberApply(tok, e.svc, &restartSup{}, nil, nil, cs, nil),
	}
	for name, h := range hs {
		for _, got := range []string{"", foreign} {
			if rec := memberCall(h, got, map[string]any{}); rec.Code != http.StatusUnauthorized {
				t.Errorf("%s mit Token %q: %d, want 401", name, got, rec.Code)
			}
		}
	}
	// Ohne abgeleitetes Geheimnis (leeres Soll-Token) geht gar nichts, auch nicht mit leerem Header.
	if rec := memberCall(handleMemberInfo("", cs), "", nil); rec.Code != http.StatusUnauthorized {
		t.Errorf("leeres Soll-Token: %d", rec.Code)
	}
}

func TestMemberApplyFencesOldTermAndEnforcesRollingSafe(t *testing.T) {
	tok := clusterupdate.DeriveToken([]byte("secret"))
	e := newUpdateEnv(t, false)
	safe := decodeEntry(t, e.upload(t, rollingPkg(t, e, "2026.11.1", true)))
	unsafe := decodeEntry(t, e.upload(t, rollingPkg(t, e, "2026.11.2", false)))
	sup := &restartSup{}
	cs := fakeClusterService{status: cluster.Status{Term: 5}}
	h := handleMemberApply(tok, e.svc, sup, nil, nil, cs, nil)

	if rec := memberCall(h, tok, clusterupdate.ApplyRequest{Kind: clusterupdate.KindUpdate, PackageID: safe.ID, Version: safe.Version, Term: 4}); rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "abgeloest") {
		t.Fatalf("alter Term: %d %s", rec.Code, rec.Body.String())
	}
	if sup.file != "" {
		t.Fatal("Supervisor trotz altem Term ausgeloest")
	}
	if rec := memberCall(h, tok, clusterupdate.ApplyRequest{Kind: clusterupdate.KindUpdate, PackageID: unsafe.ID, Version: unsafe.Version, Term: 5}); rec.Code != http.StatusConflict {
		t.Fatalf("nicht rollingSafe: %d %s", rec.Code, rec.Body.String())
	}
	if rec := memberCall(h, tok, clusterupdate.ApplyRequest{Kind: clusterupdate.KindUpdate, PackageID: safe.ID, Version: "falsch", Term: 5}); rec.Code != http.StatusBadRequest {
		t.Fatalf("falsche Version: %d", rec.Code)
	}
	if rec := memberCall(h, tok, clusterupdate.ApplyRequest{Kind: clusterupdate.KindUpdate, PackageID: safe.ID, Version: safe.Version, Term: 5}); rec.Code != http.StatusAccepted || !strings.HasSuffix(sup.file, safe.ID+".tar.gz") {
		t.Fatalf("Update: %d %s file=%q", rec.Code, rec.Body.String(), sup.file)
	}
	if rec := memberCall(h, tok, clusterupdate.ApplyRequest{Kind: clusterupdate.KindRestart, Term: 5}); rec.Code != http.StatusAccepted || sup.restarts != 1 {
		t.Fatalf("Neustart: %d restarts=%d", rec.Code, sup.restarts)
	}
	if rec := memberCall(h, tok, clusterupdate.ApplyRequest{Kind: clusterupdate.KindRestart, Term: 1}); rec.Code != http.StatusConflict || sup.restarts != 1 {
		t.Fatalf("Neustart alter Term: %d restarts=%d", rec.Code, sup.restarts)
	}
}

func TestMemberFetchDownloadsVerifiesAndRejectsForeignURLs(t *testing.T) {
	tok := clusterupdate.DeriveToken([]byte("secret"))
	coord := newUpdateEnv(t, false)
	entry := decodeEntry(t, coord.upload(t, rollingPkg(t, coord, "2026.11.1", true)))
	entry, _ = coord.svc.Get(entry.ID)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/host-updates/"+entry.ID && r.URL.Query().Get("token") == "t" {
			http.ServeFile(w, r, entry.File)
			return
		}
		http.Error(w, "forbidden", http.StatusForbidden)
	}))
	defer srv.Close()

	member := newUpdateEnv(t, false)
	member.svc = coordTrust(t, member, coord)
	h := handleMemberFetch(tok, member.svc, nil)

	if rec := memberCall(h, tok, clusterupdate.FetchRequest{PackageID: entry.ID, URL: srv.URL + "/etc/passwd"}); rec.Code != http.StatusBadRequest {
		t.Fatalf("fremder Pfad: %d", rec.Code)
	}
	if rec := memberCall(h, tok, clusterupdate.FetchRequest{PackageID: entry.ID, URL: "file:///etc/passwd"}); rec.Code != http.StatusBadRequest {
		t.Fatalf("file-URL: %d", rec.Code)
	}
	if rec := memberCall(h, tok, clusterupdate.FetchRequest{PackageID: entry.ID, URL: srv.URL + "/api/v1/host-updates/" + entry.ID + "?token=falsch"}); rec.Code != http.StatusBadGateway {
		t.Fatalf("falsches Download-Token: %d", rec.Code)
	}
	if rec := memberCall(h, tok, clusterupdate.FetchRequest{PackageID: entry.ID, URL: srv.URL + "/api/v1/host-updates/" + entry.ID + "?token=t"}); rec.Code != http.StatusOK {
		t.Fatalf("Download: %d %s", rec.Code, rec.Body.String())
	}
	if _, err := member.svc.Get(entry.ID); err != nil {
		t.Fatalf("Paket nicht im Mitglied: %v", err)
	}
	// Zweiter Aufruf: schon vorhanden, kein erneuter Download nötig.
	srv.Close()
	if rec := memberCall(h, tok, clusterupdate.FetchRequest{PackageID: entry.ID, URL: srv.URL + "/api/v1/host-updates/" + entry.ID + "?token=t"}); rec.Code != http.StatusOK {
		t.Fatalf("vorhanden: %d", rec.Code)
	}
}

func TestMemberFetchRejectsPackageSignedByUntrustedKey(t *testing.T) {
	tok := clusterupdate.DeriveToken([]byte("secret"))
	coord := newUpdateEnv(t, true) // nimmt auch Fremdes
	other := newUpdateEnv(t, false)
	entry := decodeEntry(t, coord.upload(t, rollingPkg(t, other, "2026.11.1", true))) // mit other.priv signiert
	entry, _ = coord.svc.Get(entry.ID)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.ServeFile(w, r, entry.File) }))
	defer srv.Close()
	member := newUpdateEnv(t, false) // vertraut nur seinem Schlüssel
	h := handleMemberFetch(tok, member.svc, nil)
	rec := memberCall(h, tok, clusterupdate.FetchRequest{PackageID: entry.ID, URL: srv.URL + "/api/v1/host-updates/" + entry.ID})
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("Fremdsignatur: %d %s", rec.Code, rec.Body.String())
	}
}

// coordTrust: ein Update-Dienst im Verzeichnis des Mitglieds, der denselben Schlüssel wie der Koordinator vertraut.
func coordTrust(t *testing.T, member, coord updateEnv) *updates.Service {
	t.Helper()
	return updates.New(filepath.Join(member.dir, "updates"), filepath.Join(coord.dir, "trusted.pub"), false, "", 0)
}

type announceCluster struct {
	fakeClusterService
	set map[string]string
}

func (a *announceCluster) SetPeerHTTPAddr(id, addr string) error { a.set[id] = addr; return nil }

func TestMemberAnnounceChecksTokenLeaderMembershipAndURL(t *testing.T) {
	tok := clusterupdate.DeriveToken([]byte("secret"))
	mk := func(leader bool) *announceCluster {
		return &announceCluster{fakeClusterService: fakeClusterService{isLeader: leader, status: cluster.Status{Peers: []cluster.Peer{{ID: "n1"}, {ID: "n2"}}}}, set: map[string]string{}}
	}
	c := mk(true)
	h := handleMemberAnnounce(tok, c)
	if rec := memberCall(h, "", clusterupdate.AnnounceRequest{NodeID: "n2", HTTPAddr: "http://h:1"}); rec.Code != http.StatusUnauthorized {
		t.Fatalf("ohne Token: %d", rec.Code)
	}
	if rec := memberCall(h, tok, clusterupdate.AnnounceRequest{NodeID: "fremd", HTTPAddr: "http://h:1"}); rec.Code != http.StatusForbidden {
		t.Fatalf("Nicht-Mitglied: %d", rec.Code)
	}
	if rec := memberCall(h, tok, clusterupdate.AnnounceRequest{NodeID: "n2", HTTPAddr: "file:///x"}); rec.Code != http.StatusBadRequest {
		t.Fatalf("URL: %d", rec.Code)
	}
	if rec := memberCall(h, tok, clusterupdate.AnnounceRequest{NodeID: "n2", HTTPAddr: "http://h:1"}); rec.Code != http.StatusOK || c.set["n2"] != "http://h:1" {
		t.Fatalf("ok: %d %v", rec.Code, c.set)
	}
	f := mk(false)
	if rec := memberCall(handleMemberAnnounce(tok, f), tok, clusterupdate.AnnounceRequest{NodeID: "n2", HTTPAddr: "http://h:1"}); rec.Code != http.StatusConflict || len(f.set) != 0 {
		t.Fatalf("Follower: %d", rec.Code)
	}
}
