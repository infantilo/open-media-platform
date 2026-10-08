package module

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
)

type rec struct {
	mu     sync.Mutex
	routes []string
}

func (r *rec) Handle(p string, a Auth, _ http.HandlerFunc) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.routes = append(r.routes, p+"|"+kindName(a))
}

func kindName(a Auth) string {
	switch a.Kind {
	case AuthAnonymous:
		return "anon"
	case AuthAuthenticated:
		return "auth"
	case AuthVerbGlobal:
		return "verb"
	default:
		return "node-verb"
	}
}

type fake struct {
	name   string
	mount  func(Routes, Deps) error
	migs   []Migration
	start  func(context.Context, Deps) error
	ui     []UITab
	metric string
}

func (f *fake) Name() string { return f.name }
func (f *fake) Mount(r Routes, d Deps) error {
	if f.mount != nil {
		return f.mount(r, d)
	}
	r.Handle("GET /api/v1/"+f.name+"/ping", Authenticated(), nil)
	return nil
}

type migFake struct{ fake }

func (f *migFake) Migrations() []Migration { return f.migs }

type startFake struct{ fake }

func (f *startFake) Start(ctx context.Context, d Deps) error { return f.start(ctx, d) }

type uiFake struct{ fake }

func (f *uiFake) UI() []UITab { return f.ui }

type metricFake struct{ fake }

func (f *metricFake) WriteMetrics(w io.Writer) {
	_, _ = w.Write([]byte(f.metric))
}

func TestRegisterValidatesNames(t *testing.T) {
	r := NewRegistry()
	if err := r.Register(&fake{name: "cloud"}); err != nil {
		t.Fatal(err)
	}
	if err := r.Register(&fake{name: "cloud"}); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("%v", err)
	}
	for _, bad := range []string{"", "Cloud", "a b", "a/b", "ü"} {
		if err := r.Register(&fake{name: bad}); !errors.Is(err, ErrBadName) {
			t.Errorf("%q: %v", bad, err)
		}
	}
}

func TestMountOrderDisabledAndFailureIsolation(t *testing.T) {
	r := NewRegistry("off")
	_ = r.Register(&fake{name: "a"})
	_ = r.Register(&fake{name: "off"})
	_ = r.Register(&fake{name: "bad", mount: func(Routes, Deps) error { return errors.New("kaputt") }})
	_ = r.Register(&fake{name: "boom", mount: func(Routes, Deps) error { panic("oh") }})
	_ = r.Register(&fake{name: "z"})
	rc := &rec{}
	r.Mount(rc, Deps{})
	if got := strings.Join(rc.routes, ","); got != "GET /api/v1/a/ping|auth,GET /api/v1/z/ping|auth" {
		t.Fatalf("routes: %s", got)
	}
	st := map[string]Info{}
	for _, i := range r.Info() {
		st[i.Name] = i
	}
	if st["a"].State != StateMounted || st["z"].State != StateMounted || st["off"].State != StateDisabled {
		t.Fatalf("%+v", st)
	}
	if st["bad"].State != StateFailed || st["bad"].Error != "kaputt" {
		t.Fatalf("%+v", st["bad"])
	}
	if st["boom"].State != StateFailed || !strings.Contains(st["boom"].Error, "panic") {
		t.Fatalf("a panicking module must not take the core down: %+v", st["boom"])
	}
}

func TestInfoShowsUIOnlyForMountedModules(t *testing.T) {
	r := NewRegistry("hidden")
	_ = r.Register(&uiFake{fake{name: "shown", ui: []UITab{{ID: "t", Placement: "main", LabelKey: "k", Element: "x-y", Bundle: "/b.js"}}}})
	_ = r.Register(&uiFake{fake{name: "hidden", ui: []UITab{{ID: "t2"}}}})
	r.Mount(&rec{}, Deps{})
	for _, i := range r.Info() {
		switch i.Name {
		case "shown":
			if len(i.UI) != 1 || i.UI[0].Element != "x-y" {
				t.Fatalf("%+v", i)
			}
		case "hidden":
			if len(i.UI) != 0 {
				t.Fatal("a disabled module must not contribute UI")
			}
		}
	}
}

func TestMetricsFromMountedModulesOnly(t *testing.T) {
	r := NewRegistry("off")
	_ = r.Register(&metricFake{fake{name: "on", metric: "a 1\n"}})
	_ = r.Register(&metricFake{fake{name: "off", metric: "b 2\n"}})
	r.Mount(&rec{}, Deps{})
	var b bytes.Buffer
	r.Metrics(&b)
	if b.String() != "a 1\n" {
		t.Fatalf("%q", b.String())
	}
}

func TestStartRunsMountedStartersThroughLeaderGate(t *testing.T) {
	r := NewRegistry()
	started := make(chan string, 4)
	_ = r.Register(&startFake{fake{name: "job", start: func(ctx context.Context, _ Deps) error { started <- "job"; <-ctx.Done(); return nil }}})
	_ = r.Register(&startFake{fake{name: "failmount", mount: func(Routes, Deps) error { return errors.New("x") }, start: func(context.Context, Deps) error { started <- "failmount"; return nil }}})
	r.Mount(&rec{}, Deps{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	gated := 0
	var mu sync.Mutex
	r.Start(ctx, Deps{}, func(ctx context.Context, fn func(context.Context)) { mu.Lock(); gated++; mu.Unlock(); fn(ctx) })
	select {
	case n := <-started:
		if n != "job" {
			t.Fatalf("unexpected %s", n)
		}
	case <-time.After(time.Second):
		t.Fatal("job did not start")
	}
	select {
	case n := <-started:
		t.Fatalf("a module that failed to mount must not be started: %s", n)
	case <-time.After(100 * time.Millisecond):
	}
	mu.Lock()
	defer mu.Unlock()
	if gated != 1 {
		t.Fatalf("every Starter must go through the leader gate, gated=%d", gated)
	}
}

func TestStartErrorMarksModuleFailed(t *testing.T) {
	r := NewRegistry()
	_ = r.Register(&startFake{fake{name: "job", start: func(context.Context, Deps) error { return errors.New("kaputt") }}})
	r.Mount(&rec{}, Deps{})
	done := make(chan struct{})
	r.Start(context.Background(), Deps{}, func(ctx context.Context, fn func(context.Context)) { fn(ctx); close(done) })
	<-done
	if r.Info()[0].State != StateFailed {
		t.Fatalf("%+v", r.Info()[0])
	}
}

func TestAuthConstructors(t *testing.T) {
	if Anonymous().Kind != AuthAnonymous || Authenticated().Kind != AuthAuthenticated {
		t.Fatal("kinds")
	}
	if a := Verb(authz.VerbAdmin); a.Kind != AuthVerbGlobal || a.Verb != authz.VerbAdmin {
		t.Fatal("verb")
	}
	if a := VerbOnNode(authz.VerbOperate); a.Kind != AuthVerbOnNode || a.Verb != authz.VerbOperate {
		t.Fatal("node verb")
	}
}

func TestMigrationsApplyOnceInOrderAndSkipDisabled(t *testing.T) {
	db := dbtest.Open(t)
	_, _ = db.Exec(`DROP TABLE IF EXISTS modtest_a, modtest_b; DELETE FROM module_migrations WHERE module LIKE 'modtest-%'`)
	t.Cleanup(func() {
		_, _ = db.Exec(`DROP TABLE IF EXISTS modtest_a, modtest_b; DELETE FROM module_migrations WHERE module LIKE 'modtest-%'`)
	})
	r := NewRegistry("modtest-off")
	_ = r.Register(&migFake{fake{name: "modtest-a", migs: []Migration{
		{Version: 2, Name: "add col", SQL: `ALTER TABLE modtest_a ADD COLUMN x INT`}, // absichtlich unsortiert angegeben
		{Version: 1, Name: "create", SQL: `CREATE TABLE modtest_a (id INT)`},
	}}})
	_ = r.Register(&migFake{fake{name: "modtest-off", migs: []Migration{{Version: 1, SQL: `CREATE TABLE modtest_b (id INT)`}}}})
	for i := 0; i < 2; i++ { // zweiter Lauf ändert nichts
		if err := r.Migrate(context.Background(), db); err != nil {
			t.Fatal(err)
		}
	}
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM module_migrations WHERE module='modtest-a'`).Scan(&n); err != nil || n != 2 {
		t.Fatalf("%d %v", n, err)
	}
	if _, err := db.Exec(`INSERT INTO modtest_a (id, x) VALUES (1, 2)`); err != nil {
		t.Fatalf("schema from both steps expected: %v", err)
	}
	if err := db.QueryRow(`SELECT count(*) FROM module_migrations WHERE module='modtest-off'`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("a disabled module must not be migrated: %d", n)
	}
}

func TestMigrationGapAndFailureMarkModuleFailedAndSkipMount(t *testing.T) {
	db := dbtest.Open(t)
	t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM module_migrations WHERE module LIKE 'modtest-%'`) })
	r := NewRegistry()
	_ = r.Register(&migFake{fake{name: "modtest-gap", migs: []Migration{{Version: 1, SQL: `SELECT 1`}, {Version: 3, SQL: `SELECT 1`}}}})
	_ = r.Register(&migFake{fake{name: "modtest-sql", migs: []Migration{{Version: 1, SQL: `THIS IS NOT SQL`}}}})
	_ = r.Register(&migFake{fake{name: "modtest-good", migs: []Migration{{Version: 1, SQL: `SELECT 1`}}}})
	err := r.Migrate(context.Background(), db)
	if err == nil || !strings.Contains(err.Error(), "modtest-gap") || !strings.Contains(err.Error(), "modtest-sql") {
		t.Fatalf("both failures must be reported: %v", err)
	}
	rc := &rec{}
	r.Mount(rc, Deps{})
	if len(rc.routes) != 1 || !strings.Contains(rc.routes[0], "modtest-good") {
		t.Fatalf("only the healthy module may be mounted: %v", rc.routes)
	}
	var n int
	_ = db.QueryRow(`SELECT count(*) FROM module_migrations WHERE module='modtest-sql'`).Scan(&n)
	if n != 0 {
		t.Fatal("a failed step must not be recorded")
	}
}
