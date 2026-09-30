package commands

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/host-agent/internal/catalog"
	"github.com/infantilo/openmediaplatform/update"
)

type updEnv struct {
	dir      string
	self     string
	node     string
	pkgPath  string
	pkgSHA   string
	srv      *httptest.Server
	e        *Executor
	priv     ed25519.PrivateKey
	gotToken string
}

func newUpdEnv(t *testing.T, signWith ed25519.PrivateKey) *updEnv {
	t.Helper()
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	if signWith != nil {
		priv = signWith
	}
	dir := t.TempDir()
	u := &updEnv{dir: dir, priv: priv}
	u.self = filepath.Join(dir, "omp-host-agent")
	u.node = filepath.Join(dir, "omp-source")
	_ = os.WriteFile(u.self, []byte("OLD-AGENT"), 0o755)
	_ = os.WriteFile(u.node, []byte("OLD-NODE"), 0o755)

	mk := func(n, c string) string {
		p := filepath.Join(dir, "src-"+n)
		_ = os.WriteFile(p, []byte(c), 0o644)
		return p
	}
	u.pkgPath = filepath.Join(dir, "pkg.tar.gz")
	err := update.Build(u.pkgPath, update.Manifest{Version: "2026.10.0", Arch: runtime.GOOS + "/" + runtime.GOARCH}, priv, []update.BuildFile{
		{ID: "orch", Source: mk("o", "ORCH"), Path: "bin/omp-orchestrator", Target: "bin/omp-orchestrator"},
		{ID: "agent", Source: mk("a", "NEW-AGENT"), Path: "bin/omp-host-agent", Target: "bin/omp-host-agent"},
		{ID: "node", Source: mk("n", "NEW-NODE"), Path: "nodes/omp-source", Target: "node:omp-source"},
		{ID: "unknown", Source: mk("x", "X"), Path: "nodes/omp-notinthiscatalog", Target: "node:omp-notinthiscatalog"},
	})
	if err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(u.pkgPath)
	sum := sha256.Sum256(data)
	u.pkgSHA = hex.EncodeToString(sum[:])

	u.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u.gotToken = r.URL.Query().Get("token")
		if u.gotToken != "tok" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		_, _ = w.Write(data)
	}))
	t.Cleanup(u.srv.Close)

	keyFile := filepath.Join(dir, "trusted.pub")
	_ = os.WriteFile(keyFile, []byte(base64.StdEncoding.EncodeToString(pub)+"\n"), 0o644)
	if signWith != nil {
		// Paket mit fremdem Schlüssel signiert → vertrauter Schlüssel ist ein anderer.
		_ = os.WriteFile(keyFile, []byte(base64.StdEncoding.EncodeToString(pub)+"\n"), 0o644)
	} else {
		pubOfPriv := priv.Public().(ed25519.PublicKey)
		_ = os.WriteFile(keyFile, []byte(base64.StdEncoding.EncodeToString(pubOfPriv)+"\n"), 0o644)
	}
	u.e = NewExecutor([]catalog.Entry{{Type: "omp-source", Runner: catalog.RunnerProcess, Command: []string{u.node}}}, "", "", u.srv.URL, "host-1", nil)
	u.e.SetUpdateConfig(UpdateConfig{KeyFile: keyFile, SelfPath: u.self, Dir: filepath.Join(dir, "upd")})
	return u
}

func (u *updEnv) req(path string) Request {
	return Request{Action: "update", UpdatePath: path, UpdateVersion: "2026.10.0", UpdateSHA256: u.pkgSHA}
}

func TestUpdateReplacesOwnBinaryAndCatalogNodesOnly(t *testing.T) {
	u := newUpdEnv(t, nil)
	resp := u.e.Handle(u.req("/api/v1/host-updates/x?token=tok"))
	if !resp.OK {
		t.Fatalf("update failed: %s", resp.Error)
	}
	if b, _ := os.ReadFile(u.self); string(b) != "NEW-AGENT" {
		t.Errorf("agent binary = %q", b)
	}
	if b, _ := os.ReadFile(u.node); string(b) != "NEW-NODE" {
		t.Errorf("node binary = %q", b)
	}
	if !strings.Contains(resp.Detail, "Host-Agent-Neustart nötig") {
		t.Errorf("detail = %q", resp.Detail)
	}
	// Nichts außerhalb des lokalen Katalogs/Agents wurde angelegt.
	if _, err := os.Stat(filepath.Join(u.dir, "omp-notinthiscatalog")); err == nil {
		t.Error("node not in the local catalog must not be written")
	}
	if left, _ := filepath.Glob(filepath.Join(u.dir, "*.update-new")); len(left) != 0 {
		t.Errorf("staging leftovers: %v", left)
	}
}

func TestUpdateRejectsUntrustedSignatureAndBadInputs(t *testing.T) {
	// Paket mit fremdem Schlüssel signiert; vertraut wird ein anderer.
	_, foreign, _ := ed25519.GenerateKey(rand.Reader)
	u := newUpdEnv(t, foreign)
	before, _ := os.ReadFile(u.self)
	if resp := u.e.Handle(u.req("/api/v1/host-updates/x?token=tok")); resp.OK || !strings.Contains(resp.Error, "paket ungültig") {
		t.Errorf("untrusted signature: %+v", resp)
	}
	if after, _ := os.ReadFile(u.self); string(after) != string(before) {
		t.Error("rejected package must not change anything")
	}

	u2 := newUpdEnv(t, nil)
	for name, r := range map[string]Request{
		"wrong token":    u2.req("/api/v1/host-updates/x?token=nope"),
		"foreign path":   u2.req("/etc/passwd"),
		"traversal":      u2.req("/api/v1/host-updates/../x"),
		"missing fields": {Action: "update"},
		"wrong sha":      {Action: "update", UpdatePath: "/api/v1/host-updates/x?token=tok", UpdateVersion: "2026.10.0", UpdateSHA256: strings.Repeat("0", 64)},
		"wrong version":  {Action: "update", UpdatePath: "/api/v1/host-updates/x?token=tok", UpdateVersion: "9.9", UpdateSHA256: u2.pkgSHA},
	} {
		if resp := u2.e.Handle(r); resp.OK {
			t.Errorf("%s: must be rejected", name)
		}
	}
	if b, _ := os.ReadFile(u2.self); string(b) != "OLD-AGENT" {
		t.Error("rejections must not change the agent binary")
	}
}

func TestUpdateWithoutConfigRejected(t *testing.T) {
	e := NewExecutor(nil, "", "", "http://x", "host-1", nil)
	if resp := e.Handle(Request{Action: "update", UpdatePath: "/api/v1/host-updates/a", UpdateVersion: "1", UpdateSHA256: "x"}); resp.OK {
		t.Error("update without configuration must be rejected")
	}
}

func TestBinaryNewerThanProcess(t *testing.T) {
	bin := filepath.Join(t.TempDir(), "b")
	_ = os.WriteFile(bin, []byte("x"), 0o755)
	pid := os.Getpid()
	old := time.Now().Add(-24 * 365 * time.Hour)
	_ = os.Chtimes(bin, old, old)
	if binaryNewerThanProcess(bin, pid) {
		t.Error("binary older than the process start must not count as newer")
	}
	_ = os.Chtimes(bin, time.Now().Add(time.Hour), time.Now().Add(time.Hour))
	if !binaryNewerThanProcess(bin, pid) {
		t.Error("binary with future mtime must count as newer than the process")
	}
}
