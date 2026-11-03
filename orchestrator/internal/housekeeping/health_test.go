package housekeeping

import (
	"context"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
)

func hasFinding(fs []Finding, id string) bool {
	for _, f := range fs {
		if f.ID == id {
			return true
		}
	}
	return false
}

func TestEvaluate(t *testing.T) {
	now := time.Now()
	old := now.Add(-10 * 24 * time.Hour)
	h := Health{Autovacuum: true, Connections: 10, MaxConns: 100, Tables: []TableHealth{
		{Name: "logs", DeadTuples: 50000, DeadRatio: 0.5, LastAutovac: &old},
		{Name: "tiny", DeadTuples: 50, DeadRatio: 0.9},
	}}
	fs := evaluate(h, now)
	if !hasFinding(fs, "db.bloat.logs") || !hasFinding(fs, "db.vacuum_stale.logs") {
		t.Fatalf("Bloat/veraltet fehlt: %+v", fs)
	}
	if hasFinding(fs, "db.bloat.tiny") {
		t.Fatal("kleine Tabelle darf nicht gemeldet werden")
	}
	if got := evaluate(Health{Autovacuum: false}, now); !hasFinding(got, "db.autovacuum_off") {
		t.Fatal("Autovacuum aus nicht gemeldet")
	}
	if got := evaluate(Health{Autovacuum: true, Connections: 90, MaxConns: 100}, now); !hasFinding(got, "db.connections") {
		t.Fatal("Verbindungslast nicht gemeldet")
	}
	if got := evaluate(Health{Autovacuum: true, Connections: 5, MaxConns: 100}, now); len(got) != 0 {
		t.Fatalf("gesund, aber Befunde: %+v", got)
	}
}

func TestCheckHealthLive(t *testing.T) {
	db := dbtest.Open(t)
	h, err := CheckHealth(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	if h.DatabaseBytes <= 0 || len(h.Tables) == 0 || !h.Autovacuum {
		t.Fatalf("unplausibel: %+v", h)
	}
}

func TestPurgeSupportAccess(t *testing.T) {
	db := dbtest.Open(t)
	_, _ = db.Exec(`DELETE FROM support_access WHERE id LIKE 'hk-%'`)
	t.Cleanup(func() { _, _ = db.Exec(`DELETE FROM support_access WHERE id LIKE 'hk-%'`) })
	mustExec(t, db, `INSERT INTO support_access (id, token_hash, created_by, expires_at) VALUES
		('hk-old','hk-h1','t', now() - interval '30 days'), ('hk-new','hk-h2','t', now() + interval '1 day')`)
	res, err := New(db, Config{HostTokenDays: 7}, nil).PurgeOnce()
	if err != nil {
		t.Fatal(err)
	}
	if res.SupportAccess < 1 || count(t, db, `SELECT count(*) FROM support_access WHERE id='hk-new'`) != 1 {
		t.Fatalf("falsch: %+v", res)
	}
}

func TestVolumeFindings(t *testing.T) {
	if got := volumeFindings(&Volume{FreeBytes: 3, TotalBytes: 100}); len(got) != 1 || got[0].Severity != "error" {
		t.Fatalf("%+v", got)
	}
	if got := volumeFindings(&Volume{FreeBytes: 10, TotalBytes: 100}); len(got) != 1 || got[0].Severity != "warn" {
		t.Fatalf("%+v", got)
	}
	if got := volumeFindings(&Volume{FreeBytes: 50, TotalBytes: 100}); len(got) != 0 {
		t.Fatalf("%+v", got)
	}
	h := Health{}
	AddVolume(&h, t.TempDir())
	if h.Volume == nil || h.Volume.TotalBytes <= 0 {
		t.Fatal("Statfs liefert nichts")
	}
}
