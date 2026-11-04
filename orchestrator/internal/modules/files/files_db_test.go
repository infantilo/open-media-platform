package files

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/jobwire"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/asset"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

type localHosts struct{}

func (localHosts) FileOp(hostID string, op jobwire.FileOp) ([]byte, error) {
	if hostID != "" {
		return nil, fmt.Errorf("Host %s offline", hostID)
	}
	return jobwire.RunFileOp(op)
}

type memSettings struct {
	mu sync.Mutex
	m  map[string][]byte
}

func (s *memSettings) Get(k string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if v, ok := s.m[k]; ok {
		return v, nil
	}
	return nil, module.ErrNotFound
}
func (s *memSettings) Put(k string, v []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[k] = v
	return nil
}

type alertRec struct{ kind, sev, subject, msg string }

type env struct {
	m      *Module
	assets *asset.Store
	root   Root
	dir    string
	alerts *[]alertRec
	mu     *sync.Mutex
}

func newEnv(t *testing.T) *env {
	t.Helper()
	db := dbtest.Open(t)
	m := New()
	reg := module.NewRegistry()
	if err := reg.Register(m); err != nil {
		t.Fatal(err)
	}
	if err := reg.Migrate(context.Background(), db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	for _, tbl := range []string{"representation_health", "representations", "asset_versions", "assets", "file_roots", "storage_locations", "playout_state", "playout_channels"} {
		_, _ = db.Exec("DELETE FROM " + tbl)
	}
	dir := t.TempDir()
	e := &env{m: m, assets: asset.NewStore(db), dir: dir, alerts: &[]alertRec{}, mu: &sync.Mutex{}}
	m.Hosts = localHosts{}
	m.Assets = e.assets
	m.Alerter = func(kind, sev, subject, name, msg string) {
		e.mu.Lock()
		*e.alerts = append(*e.alerts, alertRec{kind, sev, subject, msg})
		e.mu.Unlock()
	}
	m.d = module.Deps{DB: db, Settings: &memSettings{m: map[string][]byte{}}}
	lid, err := ensureLocation(context.Background(), db, "Medien", dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := SaveRootSettings(context.Background(), db, Root{ID: lid, Role: RoleMedia}); err != nil {
		t.Fatal(err)
	}
	e.root, err = GetRoot(context.Background(), db, lid)
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func (e *env) alertKinds() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	var k []string
	for _, a := range *e.alerts {
		k = append(k, a.kind+":"+a.sev)
	}
	return k
}

// mkAsset legt Datei + Asset (veröffentlichte Version, Representation) an.
func (e *env) mkAsset(t *testing.T, name string) (assetID, repID, abs string) {
	t.Helper()
	abs = filepath.Join(e.dir, name)
	if err := os.WriteFile(abs, []byte("12345"), 0o644); err != nil {
		t.Fatal(err)
	}
	a, err := e.assets.CreateAsset("video", name, "", "t", "")
	if err != nil {
		t.Fatal(err)
	}
	v, err := e.assets.CreateVersion(a.ID, "", "t", "t")
	if err != nil {
		t.Fatal(err)
	}
	r, err := e.assets.CreateRepresentation(asset.Representation{AssetVersionID: v.ID, Type: "source", Storage: asset.StorageLocation{Provider: "filesystem", URI: abs}})
	if err != nil {
		t.Fatal(err)
	}
	return a.ID, r.ID, abs
}

func (e *env) state(t *testing.T, repID string) (string, int) {
	t.Helper()
	var s string
	var n int
	if err := e.m.db().QueryRow(`SELECT state, miss_count FROM representation_health WHERE representation_id = $1`, repID).Scan(&s, &n); err != nil {
		t.Fatal(err)
	}
	return s, n
}

func TestHealthTwoCheckRuleAndNotifications(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	aid, rid, abs := e.mkAsset(t, "a.mxf")
	if err := e.m.CheckAsset(ctx, aid, "t"); err != nil {
		t.Fatal(err)
	}
	if s, _ := e.state(t, rid); s != StatePresent {
		t.Fatalf("erwartet present, war %s", s)
	}
	if err := os.Remove(abs); err != nil {
		t.Fatal(err)
	}
	_ = e.m.CheckAsset(ctx, aid, "t")
	if s, n := e.state(t, rid); s != StatePresent || n != 1 {
		t.Fatalf("erste Fehlprüfung muss present bleiben: %s %d", s, n)
	}
	if len(e.alertKinds()) != 0 {
		t.Fatalf("zu früher Alarm: %v", e.alertKinds())
	}
	_ = e.m.CheckAsset(ctx, aid, "t")
	if s, n := e.state(t, rid); s != StateMissing || n != 2 {
		t.Fatalf("zweite Fehlprüfung muss missing sein: %s %d", s, n)
	}
	if k := e.alertKinds(); len(k) != 1 || k[0] != "file-missing:warning" {
		t.Fatalf("Alarm: %v", k)
	}
	_ = e.m.CheckAsset(ctx, aid, "t") // kein zweiter Alarm
	if len(e.alertKinds()) != 1 {
		t.Fatalf("doppelter Alarm: %v", e.alertKinds())
	}
	st, err := e.m.AssetStates(ctx)
	if err != nil || len(st) != 1 || st[0].State != "missing" || st[0].Missing != 1 {
		t.Fatalf("AssetStates: %v %+v", err, st)
	}
	if err := os.WriteFile(abs, []byte("1"), 0o644); err != nil {
		t.Fatal(err)
	}
	_ = e.m.CheckAsset(ctx, aid, "t")
	if s, _ := e.state(t, rid); s != StatePresent {
		t.Fatalf("zurück: %s", s)
	}
	if k := e.alertKinds(); len(k) != 2 || k[1] != "file-recovered:info" {
		t.Fatalf("Erholungsalarm: %v", k)
	}
}

func TestUnreachableIsNotMissing(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	db := e.m.db()
	// Ort auf einem Host, der nicht antwortet.
	if _, err := db.Exec(`INSERT INTO storage_locations (id, name, host_id, path, created_by) VALUES ('h1','NAS','hostX','/nas/media','t')`); err != nil {
		t.Fatal(err)
	}
	if err := SaveRootSettings(ctx, db, Root{ID: "h1", Role: RoleMedia}); err != nil {
		t.Fatal(err)
	}
	a, _ := e.assets.CreateAsset("video", "remote", "", "t", "")
	v, _ := e.assets.CreateVersion(a.ID, "", "t", "t")
	r, err := e.assets.CreateRepresentation(asset.Representation{AssetVersionID: v.ID, Type: "source", Storage: asset.StorageLocation{Provider: "filesystem", URI: "/nas/media/x.mxf"}})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		_ = e.m.CheckAsset(ctx, a.ID, "t")
	}
	if s, _ := e.state(t, r.ID); s != StateUnreachable {
		t.Fatalf("erwartet unreachable, war %s", s)
	}
	// Kein „Datei fehlt“-Alarm bei unerreichbarem Host; stattdessen meldet der Ort selbst (einmalig, Warnung).
	for _, k := range e.alertKinds() {
		if strings.HasPrefix(k, "file-missing") {
			t.Fatalf("Datei-fehlt-Alarm bei unerreichbarem Host: %v", e.alertKinds())
		}
	}
	if k := e.alertKinds(); len(k) != 1 || k[0] != "file-root-unreachable:warning" {
		t.Fatalf("Ortsalarm: %v", k)
	}
	// Datei ohne Ort in einem Ordner, den es nicht gibt → fehlt (Orchestrator-Rechner).
	a2, _ := e.assets.CreateAsset("video", "ohne ort", "", "t", "")
	v2, _ := e.assets.CreateVersion(a2.ID, "", "t", "t")
	r2, _ := e.assets.CreateRepresentation(asset.Representation{AssetVersionID: v2.ID, Type: "source", Storage: asset.StorageLocation{Provider: "filesystem", URI: filepath.Join(e.dir, "weg", "y.mxf")}})
	_ = e.m.CheckAsset(ctx, a2.ID, "t")
	if s, _ := e.state(t, r2.ID); s != StateMissing {
		t.Fatalf("erwartet missing, war %s", s)
	}
}

func (e *env) plan(t *testing.T, state string) {
	t.Helper()
	db := e.m.db()
	if _, err := db.Exec(`INSERT INTO playout_channels (id, name, created_by) VALUES ('c1','Kanal 1','t') ON CONFLICT DO NOTHING`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO playout_state (channel_id, version, state) VALUES ('c1', 1, $1) ON CONFLICT (channel_id) DO UPDATE SET state = $1, version = playout_state.version + 1, updated_at = now()`, state); err != nil {
		t.Fatal(err)
	}
}

func TestDeleteLocksTrashAndForce(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	_, repID, abs := e.mkAsset(t, "film.mxf")
	rel := "film.mxf"
	now := time.Now().UnixMilli()

	// 1. Datei läuft gerade: absolut gesperrt, auch mit Erzwingen.
	st, _ := json.Marshal(map[string]any{"items": []any{map[string]any{"id": "1", "meta": map[string]any{"label": "Film", "media": map[string]any{"kind": "file", "path": abs}, "duration_ms": 600000}}},
		"current_index": 0, "on_air": true, "onair_utc_ms": now - 1000})
	e.plan(t, string(st))
	_, err := e.m.ExecDelete(ctx, DeleteRequest{RootID: e.root.ID, Paths: []string{rel}, Force: true, Reason: "egal, muss weg"}, "admin", true)
	if err == nil || !strings.Contains(err.Error(), "blockiert") {
		t.Fatalf("on air muss blockieren: %v", err)
	}
	if _, err := os.Stat(abs); err != nil {
		t.Fatal("Datei trotz Sperre entfernt")
	}

	// 2. Später verplant (Beginn in 2 h, Sperrfenster 24 h): hart — ohne Erzwingen abgelehnt, ohne Recht abgelehnt, ohne Begründung abgelehnt.
	st, _ = json.Marshal(map[string]any{"items": []any{map[string]any{"id": "1", "meta": map[string]any{"label": "Film", "media": map[string]any{"kind": "file", "path": "film.mxf"}, "duration_ms": 600000, "start_at_utc_ms": now + 2*3600*1000}}},
		"current_index": 0, "on_air": false})
	e.plan(t, string(st))
	pv, err := e.m.PlanDelete(ctx, DeleteRequest{RootID: e.root.ID, Paths: []string{rel}})
	if err != nil || !pv.NeedsForce || pv.Blocked || pv.Items[0].Status != "locked" {
		t.Fatalf("Vorschau: %v %+v", err, pv)
	}
	for name, c := range map[string]struct {
		req DeleteRequest
		can bool
	}{
		"ohne Erzwingen":  {DeleteRequest{RootID: e.root.ID, Paths: []string{rel}, Confirm: true}, true},
		"ohne Recht":      {DeleteRequest{RootID: e.root.ID, Paths: []string{rel}, Force: true, Reason: "wichtiger Grund"}, false},
		"ohne Begründung": {DeleteRequest{RootID: e.root.ID, Paths: []string{rel}, Force: true}, true},
	} {
		if _, err := e.m.ExecDelete(ctx, c.req, "u", c.can); err == nil {
			t.Fatalf("%s: Löschen hätte scheitern müssen", name)
		}
		if _, err := os.Stat(abs); err != nil {
			t.Fatalf("%s: Datei entfernt", name)
		}
	}
	// 3. Erzwingen mit Recht + Begründung: Papierkorb, Alarm, Dateizustand missing.
	if _, err := e.m.ExecDelete(ctx, DeleteRequest{RootID: e.root.ID, Paths: []string{rel}, Force: true, Reason: "Rechteklärung fehlt"}, "admin", true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(abs); err == nil {
		t.Fatal("Datei noch da")
	}
	if k := e.alertKinds(); len(k) == 0 || k[len(k)-1] != "file-force-delete:warning" {
		t.Fatalf("Alarm Erzwingen: %v", k)
	}
	if s, n := e.state(t, repID); n == 0 && s == "" {
		t.Fatalf("Zustand: %s %d", s, n)
	}
	// 4. Papierkorb: wiederherstellen.
	raw, err := e.m.hostOp("", jobwire.FileOp{Op: jobwire.FileOpTrashList, Root: e.root.Path})
	var tl []jobwire.TrashEntry
	if err != nil || json.Unmarshal(raw, &tl) != nil || len(tl) != 1 {
		t.Fatalf("Papierkorb: %v %s", err, raw)
	}
	if _, err := e.m.hostOp("", jobwire.FileOp{Op: jobwire.FileOpRestore, Root: e.root.Path, IDs: []string{tl[0].ID}}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(abs); err != nil {
		t.Fatal("nicht wiederhergestellt")
	}
}

func TestDeleteSoftConfirmFamilyAndReadOnly(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	aid, _, abs := e.mkAsset(t, "doku.mxf")
	// Zweite Representation (abgeleitet) im selben Ort.
	proxy := filepath.Join(e.dir, "doku.proxy.mp4")
	if err := os.WriteFile(proxy, []byte("p"), 0o644); err != nil {
		t.Fatal(err)
	}
	var vid string
	if err := e.m.db().QueryRow(`SELECT id FROM asset_versions WHERE asset_id = $1`, aid).Scan(&vid); err != nil {
		t.Fatal(err)
	}
	if _, err := e.assets.CreateRepresentation(asset.Representation{AssetVersionID: vid, Type: "proxy", Storage: asset.StorageLocation{Provider: "filesystem", URI: proxy}}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.assets.PublishVersion(vid); err != nil {
		t.Fatal(err)
	}
	// Veröffentlichte Version → weicher Hinweis, ohne Bestätigung abgelehnt.
	if _, err := e.m.ExecDelete(ctx, DeleteRequest{RootID: e.root.ID, Paths: []string{"doku.mxf"}}, "u", false); err == nil || !strings.Contains(err.Error(), "bestätigen") {
		t.Fatalf("weiche Warnung: %v", err)
	}
	pv, err := e.m.PlanDelete(ctx, DeleteRequest{RootID: e.root.ID, Paths: []string{"doku.mxf"}, WithFamily: true})
	if err != nil || len(pv.Items) != 2 || !pv.NeedsConfirm || !pv.Items[1].Derived {
		t.Fatalf("Familie: %v %+v", err, pv)
	}
	if _, err := e.m.ExecDelete(ctx, DeleteRequest{RootID: e.root.ID, Paths: []string{"doku.mxf"}, WithFamily: true, Confirm: true}, "u", false); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{abs, proxy} {
		if _, err := os.Stat(p); err == nil {
			t.Fatalf("%s noch da", p)
		}
	}
	// Schreibgeschützter Ort.
	ro := true
	if err := SaveRootSettings(ctx, e.m.db(), Root{ID: e.root.ID, Role: RoleMedia, ReadOnly: ro}); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(e.dir, "x.txt"), []byte("1"), 0o644)
	if _, err := e.m.ExecDelete(ctx, DeleteRequest{RootID: e.root.ID, Paths: []string{"x.txt"}}, "u", true); err == nil {
		t.Fatal("schreibgeschützter Ort löschbar")
	}
}

func TestSweepRetention(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	for _, n := range []string{"alt.txt", "neu.txt"} {
		_ = os.WriteFile(filepath.Join(e.dir, n), []byte("1"), 0o644)
	}
	if _, err := e.m.hostOp("", jobwire.FileOp{Op: jobwire.FileOpTrash, Root: e.root.Path, Rels: []string{"alt.txt"}}); err != nil {
		t.Fatal(err)
	}
	// Alterung simulieren: Papierkorb-Ordner auf 10 Tage zurückdatieren.
	entries, _ := os.ReadDir(filepath.Join(e.dir, ".trash"))
	old := fmt.Sprint(time.Now().Add(-10 * 24 * time.Hour).UnixMilli())
	if err := os.Rename(filepath.Join(e.dir, ".trash", entries[0].Name()), filepath.Join(e.dir, ".trash", old)); err != nil {
		t.Fatal(err)
	}
	if _, err := e.m.hostOp("", jobwire.FileOp{Op: jobwire.FileOpTrash, Root: e.root.Path, Rels: []string{"neu.txt"}}); err != nil {
		t.Fatal(err)
	}
	e.m.Sweep(ctx, DefaultConfig()) // 7 Tage Aufbewahrung
	raw, _ := e.m.hostOp("", jobwire.FileOp{Op: jobwire.FileOpTrashList, Root: e.root.Path})
	var tl []jobwire.TrashEntry
	_ = json.Unmarshal(raw, &tl)
	if len(tl) != 1 || tl[0].Rel != "neu.txt" {
		t.Fatalf("Aufbewahrung: %+v", tl)
	}
	// Notfall: Grenze unerreichbar hoch → Papierkorb außerhalb der Schutzfrist wird geleert; hier greift die Schutzfrist (Eintrag ist jung).
	cfg := DefaultConfig()
	cfg.EmergencyFreeGB = 1 << 30
	e.m.Sweep(ctx, cfg)
	raw, _ = e.m.hostOp("", jobwire.FileOp{Op: jobwire.FileOpTrashList, Root: e.root.Path})
	_ = json.Unmarshal(raw, &tl)
	if len(tl) != 1 {
		t.Fatalf("Schutzfrist: %+v", tl)
	}
	if k := e.alertKinds(); len(k) == 0 || k[len(k)-1] != "file-trash-emergency:warning" {
		t.Fatalf("Notfallalarm: %v", k)
	}
	cfg.GraceMinutes = 0
	e.m.Sweep(ctx, cfg)
	raw, _ = e.m.hostOp("", jobwire.FileOp{Op: jobwire.FileOpTrashList, Root: e.root.Path})
	tl = nil
	_ = json.Unmarshal(raw, &tl)
	if len(tl) != 0 {
		t.Fatalf("Notfall-Leerung: %+v", tl)
	}
}

func TestSharedRootRoundTrip(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	if err := SaveRootSettings(ctx, e.m.db(), Root{ID: e.root.ID, Role: RoleMedia, Shared: true, Hosts: []string{"", "hostB", "", "hostC"}}); err != nil {
		t.Fatal(err)
	}
	r, err := GetRoot(ctx, e.m.db(), e.root.ID)
	if err != nil || !r.Shared || fmt.Sprint(r.Hosts) != "[ hostB hostC]" {
		t.Fatalf("Rundlauf: %v %+v", err, r)
	}
	if err := SaveRootSettings(ctx, e.m.db(), Root{ID: e.root.ID, Role: RoleMedia, Shared: true}); err == nil {
		t.Fatal("gemeinsamer Speicher ohne Host akzeptiert")
	}
	// Ausfall des ersten Hosts: der Orchestrator-Rechner (hier der lokale Fake) bedient weiter, Hosts werden der Reihe nach versucht.
	if err := SaveRootSettings(ctx, e.m.db(), Root{ID: e.root.ID, Role: RoleMedia, Shared: true, Hosts: []string{"down", ""}}); err != nil {
		t.Fatal(err)
	}
	r, _ = GetRoot(ctx, e.m.db(), e.root.ID)
	_ = os.WriteFile(filepath.Join(e.dir, "x.txt"), []byte("1"), 0o644)
	raw, err := e.m.rootOp(r, jobwire.FileOp{Op: jobwire.FileOpStat, Rels: []string{"x.txt"}})
	if err != nil || !strings.Contains(string(raw), `"exists":true`) {
		t.Fatalf("Ausweichen: %v %s", err, raw)
	}
	if mi := e.m.mountInfo(r.ID); mi.State != MountOK || mi.ActiveHost != "" {
		t.Fatalf("Zustand: %+v", mi)
	}
}
