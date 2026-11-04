package catalogdist

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/update"
)

type memRepo struct {
	mu   sync.Mutex
	rows map[string]*Row
	priv ed25519.PrivateKey
	pub  string
}

func newMem() *memRepo {
	p, pub, _ := update.GenerateDistKey()
	return &memRepo{rows: map[string]*Row{}, priv: p, pub: pub}
}
func k(t, v, h string) string                               { return t + "|" + v + "|" + h }
func (m *memRepo) Key() (ed25519.PrivateKey, string, error) { return m.priv, m.pub, nil }
func (m *memRepo) Upsert(t, v, h, d string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rows[k(t, v, h)] = &Row{Type: t, Version: v, HostID: h, Desired: d, State: StatePending, UpdatedAt: time.Now()}
	return nil
}
func (m *memRepo) Set(t, v, h, st, detail, img string, failed bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r := m.rows[k(t, v, h)]
	if r == nil {
		return errors.New("no row")
	}
	r.State, r.Detail, r.UpdatedAt = st, detail, time.Now()
	if img != "" {
		r.ImageID = img
	}
	if st == StateOK {
		r.Attempts = 0
	} else if failed {
		r.Attempts++
	}
	return nil
}
func (m *memRepo) Delete(t, v, h string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.rows, k(t, v, h))
	return nil
}
func (m *memRepo) List() ([]Row, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Row
	for _, r := range m.rows {
		out = append(out, *r)
	}
	return out, nil
}
func (m *memRepo) row(t, v, h string) Row {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r := m.rows[k(t, v, h)]; r != nil {
		return *r
	}
	return Row{}
}

// tokens: Issue wird aus den parallelen Host-Läufen von Reconcile aufgerufen — die Zuordnung braucht eine Sperre (Datenwettlauf in CI mit -race).
type tokens struct {
	mu sync.Mutex
	m  map[string]string
}

func (t *tokens) Issue(id string) string {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.m[id] = "tok-" + id
	return "tok-" + id
}

func (t *tokens) Check(id, tok string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.m[id] == tok && tok != ""
}

// fakeHost simuliert Host-Agents.
type fakeHost struct {
	mu        sync.Mutex
	online    map[string]bool
	installed map[string]map[string]bool // host → typ@version
	failNext  map[string]string
	calls     []string
	pubs      map[string]string
	svc       *Service
}

func (f *fakeHost) request(subject string, data []byte, _ time.Duration) ([]byte, error) {
	host := strings.TrimSuffix(strings.TrimPrefix(subject, "omp.host."), ".cmd")
	var req map[string]any
	json.Unmarshal(data, &req)
	f.mu.Lock()
	defer f.mu.Unlock()
	act, _ := req["action"].(string)
	f.calls = append(f.calls, host+":"+act)
	reply := func(v any) ([]byte, error) { return json.Marshal(v) }
	if f.installed[host] == nil {
		f.installed[host] = map[string]bool{}
	}
	switch act {
	case "catalog-trust":
		f.pubs[host], _ = req["distKey"].(string)
		return reply(map[string]any{"ok": true})
	case "catalog-install":
		if msg := f.failNext[host]; msg != "" {
			delete(f.failNext, host)
			return reply(map[string]any{"ok": false, "error": msg})
		}
		path, _ := req["bundlePath"].(string)
		id := strings.TrimPrefix(strings.SplitN(path, "?", 2)[0], "/api/v1/host-catalog/")
		tok := strings.SplitN(path, "token=", 2)[1]
		if !f.svc.CheckToken(id, tok) {
			return reply(map[string]any{"ok": false, "error": "download: HTTP 403"})
		}
		file, ok := f.svc.BundleFile(id)
		if !ok {
			return reply(map[string]any{"ok": false, "error": "bundle fehlt"})
		}
		keys, _ := update.ParsePublicKeys([]byte(f.pubs[host]))
		m, _, err := update.OpenBundle(file, keys, filepath.Join(os.TempDir(), "x-"+id))
		os.Remove(filepath.Join(os.TempDir(), "x-"+id))
		if err != nil {
			return reply(map[string]any{"ok": false, "error": err.Error()})
		}
		f.installed[host][m.Type+"@"+m.Version] = true
		return reply(map[string]any{"ok": true, "detail": "installiert"})
	case "catalog-remove":
		delete(f.installed[host], req["type"].(string)+"@"+req["version"].(string))
		return reply(map[string]any{"ok": true})
	case "catalog-list":
		var l []map[string]string
		for tv := range f.installed[host] {
			p := strings.SplitN(tv, "@", 2)
			l = append(l, map[string]string{"type": p[0], "version": p[1]})
		}
		b, _ := json.Marshal(l)
		return reply(map[string]any{"ok": true, "detail": string(b)})
	}
	return nil, errors.New("unbekannt")
}

func setup(t *testing.T) (*Service, *memRepo, *fakeHost) {
	repo := newMem()
	f := &fakeHost{online: map[string]bool{"h1": true, "h2": true}, installed: map[string]map[string]bool{}, failNext: map[string]string{}, pubs: map[string]string{}}
	s := &Service{
		Repo: repo, Tokens: &tokens{m: map[string]string{}}, Dir: t.TempDir(),
		Hosts:   func() ([]HostRef, error) { return []HostRef{{ID: "h1"}, {ID: "h2"}}, nil },
		Online:  func(h string) bool { f.mu.Lock(); defer f.mu.Unlock(); return f.online[h] },
		Request: f.request,
		Entry: func(typ, version string) (json.RawMessage, string, string, bool) {
			if typ != "svc" || version != "1" {
				return nil, "", "", false
			}
			return json.RawMessage(`{"type":"svc","runner":"podman","image":"localhost/svc:1"}`), "localhost/svc:1", "Svc", true
		},
		SaveImage: func(_, dst string) error { return os.WriteFile(dst, []byte("IMAGE"), 0o600) },
		ImageID:   func(string) (string, error) { return "sha256:id1", nil },
	}
	f.svc = s
	return s, repo, f
}

func TestDistributeInstallsOnSelectedHostsAndSignsWithClusterKey(t *testing.T) {
	s, repo, f := setup(t)
	if err := s.Distribute("svc", "1", []string{"h1"}); err != nil {
		t.Fatal(err)
	}
	s.Reconcile(context.Background())
	if r := repo.row("svc", "1", "h1"); r.State != StateOK || r.ImageID != "sha256:id1" {
		t.Fatalf("h1: %+v", r)
	}
	if !f.installed["h1"]["svc@1"] || f.installed["h2"]["svc@1"] {
		t.Fatalf("falsche Hosts: %+v", f.installed)
	}
	if f.pubs["h1"] != repo.pub {
		t.Fatal("Host hat nicht den öffentlichen Verteilschlüssel bekommen")
	}
	if !s.InstalledOn("svc", "1", "h1") || s.InstalledOn("svc", "1", "h2") {
		t.Fatal("InstalledOn falsch")
	}
	if err := s.CheckStart("svc", "1", "h2"); err == nil || !strings.Contains(err.Error(), "nicht installiert") {
		t.Fatalf("CheckStart h2: %v", err)
	}
	if err := s.CheckStart("svc", "1", "h1"); err != nil {
		t.Fatal(err)
	}
}

func TestOfflineHostCatchesUpLater(t *testing.T) {
	s, repo, f := setup(t)
	f.online["h2"] = false
	s.Distribute("svc", "1", []string{"h1", "h2"})
	s.Reconcile(context.Background())
	if r := repo.row("svc", "1", "h2"); r.State != StateOffline {
		t.Fatalf("h2 sollte offline sein: %+v", r)
	}
	if r := repo.row("svc", "1", "h1"); r.State != StateOK {
		t.Fatalf("h1: %+v", r)
	}
	f.online["h2"] = true
	s.Reconcile(context.Background())
	if r := repo.row("svc", "1", "h2"); r.State != StateOK {
		t.Fatalf("h2 muss nachziehen: %+v", r)
	}
}

func TestFailureBackoffAndRetry(t *testing.T) {
	s, repo, f := setup(t)
	f.failNext["h1"] = "dieser Host erlaubt hostNetwork nicht"
	s.Distribute("svc", "1", []string{"h1"})
	s.Reconcile(context.Background())
	r := repo.row("svc", "1", "h1")
	if r.State != StateFailed || !strings.Contains(r.Detail, "hostNetwork") || r.Attempts != 1 {
		t.Fatalf("%+v", r)
	}
	n := len(f.calls)
	s.Reconcile(context.Background())
	if len(f.calls) != n {
		t.Fatal("während des Backoffs darf nicht erneut versucht werden")
	}
	if err := s.Retry("svc", "1", "h1"); err != nil {
		t.Fatal(err)
	}
	s.Reconcile(context.Background())
	if r := repo.row("svc", "1", "h1"); r.State != StateOK {
		t.Fatalf("nach Retry: %+v", r)
	}
}

func TestWithdrawRemovesAndForgets(t *testing.T) {
	s, repo, f := setup(t)
	s.Distribute("svc", "1", []string{"h1", "h2"})
	s.Reconcile(context.Background())
	if err := s.Withdraw("svc", "1", nil); err != nil {
		t.Fatal(err)
	}
	s.Reconcile(context.Background())
	if len(f.installed["h1"])+len(f.installed["h2"]) != 0 {
		t.Fatalf("Hosts nicht aufgeräumt: %+v", f.installed)
	}
	if rows, _ := repo.List(); len(rows) != 0 {
		t.Fatalf("Zeilen übrig: %+v", rows)
	}
}

func TestDriftIsRepaired(t *testing.T) {
	s, repo, f := setup(t)
	s.Distribute("svc", "1", []string{"h1"})
	s.Reconcile(context.Background())
	delete(f.installed["h1"], "svc@1") // Host neu aufgesetzt
	s.mu.Lock()
	s.lastList = map[string]time.Time{}
	s.mu.Unlock()
	s.Reconcile(context.Background())
	if r := repo.row("svc", "1", "h1"); r.State != StateOK || !f.installed["h1"]["svc@1"] {
		t.Fatalf("Drift nicht repariert: %+v", r)
	}
}

func TestRejectsUnknownTypeAndBadNames(t *testing.T) {
	s, _, _ := setup(t)
	if err := s.Distribute("nope", "1", []string{"h1"}); !errors.Is(err, ErrUnknownType) {
		t.Fatalf("%v", err)
	}
	if err := s.Distribute("../x", "1", []string{"h1"}); err == nil {
		t.Fatal("unzulässiger Name")
	}
	if err := s.Distribute("svc", "1", nil); err == nil {
		t.Fatal("ohne Host muss abgelehnt werden")
	}
}

func TestBundleDownloadGuards(t *testing.T) {
	s, _, _ := setup(t)
	s.init()
	if _, ok := s.BundleFile("../etc/passwd"); ok {
		t.Fatal("Pfad-Traversal")
	}
	if _, ok := s.BundleFile("gibtsnicht"); ok {
		t.Fatal("unbekannt")
	}
	if s.CheckToken("x", "") {
		t.Fatal("leeres Token")
	}
}

func TestBundleBuiltOncePerVersion(t *testing.T) {
	s, _, _ := setup(t)
	var saves atomic.Int32
	s.SaveImage = func(_, dst string) error { saves.Add(1); return os.WriteFile(dst, []byte("IMAGE"), 0o600) }
	s.Distribute("svc", "1", []string{"h1", "h2"})
	s.Reconcile(context.Background())
	if n := saves.Load(); n != 1 {
		t.Fatalf("Image wurde %d× gespeichert, erwartet 1", n)
	}
}
