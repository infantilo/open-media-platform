package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/update"
)

// harness baut ein Installationsverzeichnis mit Fake-Skripten und einem
// Fake-Orchestrator (httptest), dessen Version die Datei
// running-version liefert — die schreibt start-omp.sh aus dem Inhalt von
// bin/omp-orchestrator (wie ein echter Start das laufende Binary
// widerspiegelt).
type harness struct {
	t    *testing.T
	root string
	priv ed25519.PrivateKey
	srv  *server
	upd  *updater
	http *httptest.Server
	log  string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	h := &harness{t: t, root: root, priv: priv}
	for _, d := range []string{"bin", "ui/dist", "deploy/dev", ".updates", ".run", "orchestrator", "nodes/bin"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	h.write("bin/omp-orchestrator", "2026.9.0\n", 0o755)
	h.write("bin/omp-supervisor", "OLD-SUPERVISOR", 0o755)
	h.write("ui/dist/shell.js", "old-ui", 0o644)
	h.write("nodes/bin/omp-source", "old-node", 0o755)
	h.write("deploy/catalog.json", `[{"type":"omp-source","runner":"process","command":["../nodes/bin/omp-source"]}]`, 0o644)
	h.write(".run/update-trusted.pub", base64.StdEncoding.EncodeToString(pub)+"\n", 0o644)
	h.log = filepath.Join(root, "calls.log")
	// stop: protokolliert; start: schreibt die "laufende" Version aus dem Binary.
	h.write("deploy/dev/stop-omp.sh", "#!/bin/sh\necho stop >> "+h.log+"\nrm -f "+root+"/running-version\n", 0o755)
	h.write("deploy/dev/start-omp.sh", "#!/bin/sh\necho \"start skip=$OMP_SKIP_BUILD\" >> "+h.log+"\nhead -n1 "+root+"/bin/omp-orchestrator > "+root+"/running-version\n", 0o755)
	h.write("running-version", "2026.9.0\n", 0o644)

	h.http = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, err := os.ReadFile(filepath.Join(root, "running-version"))
		if err != nil {
			http.Error(w, "down", http.StatusServiceUnavailable)
			return
		}
		switch r.URL.Path {
		case "/healthz":
			_, _ = w.Write([]byte("ok"))
		case "/api/v1/version":
			_, _ = w.Write([]byte(`{"version":"` + strings.TrimSpace(string(data)) + `"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(h.http.Close)

	h.srv = &server{
		stopScript:  filepath.Join(root, "deploy/dev/stop-omp.sh"),
		startScript: filepath.Join(root, "deploy/dev/start-omp.sh"),
		status:      &status{},
	}
	h.upd = newUpdater(h.srv, root)
	h.upd.orchURL = h.http.URL
	h.upd.verifyTimeout = 2 * time.Second
	h.upd.execSelf = func(string) error { return nil }
	h.srv.upd = h.upd
	return h
}

func (h *harness) write(rel, content string, mode os.FileMode) {
	h.t.Helper()
	p := filepath.Join(h.root, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		h.t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), mode); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) read(rel string) string {
	b, _ := os.ReadFile(filepath.Join(h.root, rel))
	return string(b)
}

// pkg baut ein signiertes Paket in .updates/ und liefert dessen Pfad.
func (h *harness) pkg(version, orchContent string, extra ...update.BuildFile) string {
	h.t.Helper()
	tmp := h.t.TempDir()
	mk := func(name, c string) string {
		p := filepath.Join(tmp, name)
		_ = os.WriteFile(p, []byte(c), 0o644)
		return p
	}
	files := []update.BuildFile{
		{ID: "orchestrator", Source: mk("o", orchContent), Path: "bin/omp-orchestrator", Target: "bin/omp-orchestrator"},
		{ID: "ui", Source: mk("u", "new-ui"), Path: "ui/dist/shell.js", Target: "ui/dist/shell.js"},
	}
	files = append(files, extra...)
	out := filepath.Join(h.root, ".updates", "pkg-"+version+".tar.gz")
	err := update.Build(out, update.Manifest{Version: version, Arch: runtime.GOOS + "/" + runtime.GOARCH}, h.priv, files)
	if err != nil {
		h.t.Fatal(err)
	}
	return out
}

func (h *harness) apply(pkgPath string) statusData {
	h.t.Helper()
	pkg, err := h.upd.readPackage(pkgPath)
	if err != nil {
		h.t.Fatalf("readPackage: %v", err)
	}
	plan, err := h.upd.plan(pkg.Manifest)
	if err != nil {
		h.t.Fatalf("plan: %v", err)
	}
	if !h.srv.status.beginKind("update", filepath.Base(pkgPath), pkg.Manifest.Version, "staging") {
		h.t.Fatal("busy")
	}
	h.upd.run(pkgPath, pkg, plan)
	return h.srv.status.snapshot()
}

func TestUpdateSuccess(t *testing.T) {
	h := newHarness(t)
	node := filepath.Join(t.TempDir(), "n")
	_ = os.WriteFile(node, []byte("new-node"), 0o644)
	p := h.pkg("2026.10.0", "2026.10.0\n", update.BuildFile{ID: "node/omp-source", Source: node, Path: "nodes/omp-source", Target: "node:omp-source"})

	st := h.apply(p)
	if st.Ok == nil || !*st.Ok {
		t.Fatalf("update failed: %+v", st)
	}
	if h.read("bin/omp-orchestrator") != "2026.10.0\n" || h.read("ui/dist/shell.js") != "new-ui" {
		t.Error("files not swapped")
	}
	if h.read("nodes/bin/omp-source") != "new-node" {
		t.Errorf("node binary via catalog not swapped: %q", h.read("nodes/bin/omp-source"))
	}
	if info, _ := os.Stat(filepath.Join(h.root, "bin/omp-orchestrator")); info.Mode().Perm() != 0o755 {
		t.Errorf("binary mode = %v", info.Mode())
	}
	log := h.read("calls.log")
	if !strings.Contains(log, "stop") || !strings.Contains(log, "start skip=1") {
		t.Errorf("scripts: %q (stop + start with OMP_SKIP_BUILD=1 expected)", log)
	}
	hist := h.read(".updates/history.json")
	if !strings.Contains(hist, `"version": "2026.10.0"`) || !strings.Contains(hist, `"ok": true`) {
		t.Errorf("history: %s", hist)
	}
	if leftovers, _ := filepath.Glob(filepath.Join(h.root, "bin", "*.update-new")); len(leftovers) != 0 {
		t.Errorf("staging leftovers: %v", leftovers)
	}
}

func TestUpdateRollsBackWhenNewVersionDoesNotComeUp(t *testing.T) {
	h := newHarness(t)
	// Manifest sagt 2026.10.0, das Binary meldet aber "BROKEN" → Verifikation scheitert.
	p := h.pkg("2026.10.0", "BROKEN\n")

	st := h.apply(p)
	if st.Ok == nil || *st.Ok {
		t.Fatalf("expected failure, got %+v", st)
	}
	if !strings.Contains(st.Error, "vorheriger Stand wiederhergestellt und läuft") {
		t.Errorf("error = %q", st.Error)
	}
	if h.read("bin/omp-orchestrator") != "2026.9.0\n" || h.read("ui/dist/shell.js") != "old-ui" {
		t.Error("files not restored")
	}
	if strings.TrimSpace(h.read("running-version")) != "2026.9.0" {
		t.Errorf("old version not running again: %q", h.read("running-version"))
	}
	if !strings.Contains(h.read(".updates/history.json"), `"rolledBack": true`) {
		t.Error("history must mark the rollback")
	}
}

func TestUpdateRejectsTamperedAndUntrustedBeforeAnyChange(t *testing.T) {
	h := newHarness(t)
	p := h.pkg("2026.10.0", "2026.10.0\n")

	// fremder Schlüssel
	other, _, _ := ed25519.GenerateKey(rand.Reader)
	h.write(".run/update-trusted.pub", base64.StdEncoding.EncodeToString(other)+"\n", 0o644)
	if _, err := h.upd.readPackage(p); err == nil {
		t.Error("package signed by an untrusted key must be rejected")
	}

	// kein Schlüssel + unsigniert
	h.write(".run/update-trusted.pub", "", 0o644)
	if _, err := h.upd.readPackage(p); err == nil {
		t.Error("no trusted keys must reject everything")
	}
	if h.read("bin/omp-orchestrator") != "2026.9.0\n" || h.read("calls.log") != "" {
		t.Error("rejection must not touch anything")
	}
}

func TestUpdateNodeMissingInCatalogRejected(t *testing.T) {
	h := newHarness(t)
	node := filepath.Join(t.TempDir(), "n")
	_ = os.WriteFile(node, []byte("x"), 0o644)
	p := h.pkg("2026.10.0", "2026.10.0\n", update.BuildFile{ID: "n", Source: node, Path: "nodes/omp-unknown", Target: "node:omp-unknown"})
	pkg, err := h.upd.readPackage(p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.upd.plan(pkg.Manifest); err == nil {
		t.Error("node not in catalog must be rejected at planning time")
	}
}

func TestUpdateSelfReplacementExecsNewSupervisor(t *testing.T) {
	h := newHarness(t)
	sup := filepath.Join(t.TempDir(), "s")
	_ = os.WriteFile(sup, []byte("NEW-SUPERVISOR"), 0o644)
	p := h.pkg("2026.10.0", "2026.10.0\n", update.BuildFile{ID: "supervisor", Source: sup, Path: "bin/omp-supervisor", Target: "bin/omp-supervisor"})
	var execed string
	h.upd.execSelf = func(path string) error { execed = path; return nil }

	st := h.apply(p)
	if st.Ok == nil || !*st.Ok {
		t.Fatalf("update failed: %+v", st)
	}
	if want := filepath.Join(h.root, "bin/omp-supervisor"); execed != want {
		t.Errorf("exec path = %q, want %q", execed, want)
	}
	if h.read("bin/omp-supervisor") != "NEW-SUPERVISOR" {
		t.Error("supervisor binary not replaced")
	}
	// Ergebnis überlebt den Neustart des Supervisors.
	h2 := &server{status: &status{}}
	h2.upd = newUpdater(h2, h.root)
	h2.upd.loadLastStatus()
	if snap := h2.status.snapshot(); snap.Ok == nil || !*snap.Ok || snap.Version != "2026.10.0" {
		t.Errorf("persisted status = %+v", snap)
	}
}

func TestUpdateBusyExcludesRestore(t *testing.T) {
	h := newHarness(t)
	if !h.srv.status.beginKind("update", "x", "1", "staging") {
		t.Fatal("first begin must succeed")
	}
	if h.srv.status.begin("backup.sql.gz") {
		t.Error("restore must not start while an update runs")
	}
}

func TestResolvePackageOnlyFromUpdateDir(t *testing.T) {
	h := newHarness(t)
	ok := filepath.Join(h.root, ".updates", "a.tar.gz")
	_ = os.WriteFile(ok, []byte("x"), 0o644)
	if _, err := h.upd.resolvePackage(ok); err != nil {
		t.Errorf("valid path rejected: %v", err)
	}
	for _, bad := range []string{"", "/etc/passwd", filepath.Join(h.root, "a.tar.gz"), filepath.Join(h.root, ".updates", "..", "a.tar.gz"), filepath.Join(h.root, ".updates", "a.txt")} {
		if _, err := h.upd.resolvePackage(bad); err == nil {
			t.Errorf("resolvePackage(%q) must fail", bad)
		}
	}
	link := filepath.Join(h.root, ".updates", "l.tar.gz")
	_ = os.Symlink("/etc/passwd", link)
	if _, err := h.upd.resolvePackage(link); err == nil {
		t.Error("symlink must be rejected")
	}
}
