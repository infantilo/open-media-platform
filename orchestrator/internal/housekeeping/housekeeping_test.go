package housekeeping

import (
	"database/sql"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
)

type fakeAcks struct{ n int64 }

func (f *fakeAcks) PurgeStale() (int64, error) { return f.n, nil }

func mustExec(t *testing.T, db *sql.DB, q string, args ...any) {
	t.Helper()
	if _, err := db.Exec(q, args...); err != nil {
		t.Fatalf("%s: %v", q, err)
	}
}

func count(t *testing.T, db *sql.DB, q string) int {
	t.Helper()
	var n int
	if err := db.QueryRow(q).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestPurgeOnce(t *testing.T) {
	db := dbtest.Open(t)
	clean := func() {
		for _, q := range []string{`DELETE FROM outbox_events`, `DELETE FROM host_bootstrap_tokens`, `DELETE FROM process_executions WHERE id LIKE 'hk-%'`, `DELETE FROM process_versions WHERE id = 'hk-v'`, `DELETE FROM process_definitions WHERE id = 'hk-d'`} {
			_, _ = db.Exec(q)
		}
	}
	clean()
	t.Cleanup(clean)

	// Outbox: alt+versendet (weg), frisch+versendet (bleibt), alt+UNversendet (bleibt immer)
	mustExec(t, db, `INSERT INTO outbox_events (id, subject, payload, created_at, dispatched_at) VALUES
		('o1', 's', '{}', now() - interval '40 days', now() - interval '30 days'),
		('o2', 's', '{}', now() - interval '2 days', now() - interval '1 day'),
		('o3', 's', '{}', now() - interval '60 days', NULL)`)
	// Host-Tokens: alt verbraucht (weg), alt abgelaufen+unbenutzt (weg), noch gültig (bleibt), frisch verbraucht (bleibt)
	mustExec(t, db, `INSERT INTO host_bootstrap_tokens (id, token_hash, created_by, created_at, expires_at, used_at) VALUES
		('t1', 'h1', 'a', now() - interval '30 days', now() - interval '29 days', now() - interval '29 days'),
		('t2', 'h2', 'a', now() - interval '30 days', now() - interval '29 days', NULL),
		('t3', 'h3', 'a', now() - interval '1 day', now() + interval '1 day', NULL),
		('t4', 'h4', 'a', now() - interval '1 day', now() + interval '1 day', now() - interval '1 hour')`)
	// Prozess: alte abgeschlossene Ausführung ohne Kind (weg, samt Schritt), alte Elternausführung MIT Kind (bleibt im 1. Lauf),
	// frische abgeschlossene (bleibt), alte unabgeschlossene (bleibt)
	mustExec(t, db, `INSERT INTO process_definitions (id, name, created_by) VALUES ('hk-d', 'x', 'u')`)
	mustExec(t, db, `INSERT INTO process_versions (id, process_definition_id, version_number, definition, created_by) VALUES ('hk-v', 'hk-d', 1, '{}', 'u')`)
	ins := `INSERT INTO process_executions (id, process_definition_id, process_version_id, correlation_id, created_by, parent_execution_id, started_at, completed_at) VALUES `
	mustExec(t, db, ins+`
		('hk-old', 'hk-d', 'hk-v', 'c', 'u', NULL, now() - interval '300 days', now() - interval '299 days'),
		('hk-parent', 'hk-d', 'hk-v', 'c', 'u', NULL, now() - interval '300 days', now() - interval '299 days'),
		('hk-child', 'hk-d', 'hk-v', 'c', 'u', 'hk-parent', now() - interval '299 days', now() - interval '298 days'),
		('hk-fresh', 'hk-d', 'hk-v', 'c', 'u', NULL, now() - interval '1 day', now() - interval '1 day'),
		('hk-open', 'hk-d', 'hk-v', 'c', 'u', NULL, now() - interval '300 days', NULL)`)
	mustExec(t, db, `INSERT INTO process_step_executions (id, process_execution_id, step_id, step_type) VALUES ('hk-s', 'hk-old', 'a', 'x')`)

	h := New(db, Config{OutboxDays: 14, HostTokenDays: 7, ProcessExecutionDays: 180}, &fakeAcks{n: 3})
	res, err := h.PurgeOnce()
	if err != nil {
		t.Fatal(err)
	}
	if res.Outbox != 1 || res.HostTokens != 2 || res.AlarmAcks != 3 {
		t.Errorf("Ergebnis = %+v", res)
	}
	// 1. Lauf: hk-old und hk-child (Blatt) weg; hk-parent hatte ein Kind → bleibt
	if res.ProcessExecutions != 2 {
		t.Errorf("Prozess-Ausführungen gelöscht %d, want 2 (hk-old, hk-child)", res.ProcessExecutions)
	}
	if count(t, db, `SELECT count(*) FROM process_step_executions WHERE id = 'hk-s'`) != 0 {
		t.Error("Schritt der gelöschten Ausführung muss per CASCADE mitgehen")
	}
	if n := count(t, db, `SELECT count(*) FROM outbox_events`); n != 2 {
		t.Errorf("Outbox übrig %d, want 2 (frisch versendet + unversendet)", n)
	}
	if n := count(t, db, `SELECT count(*) FROM host_bootstrap_tokens`); n != 2 {
		t.Errorf("Host-Tokens übrig %d, want 2", n)
	}
	// 2. Lauf räumt die Kette ab (Eltern ohne Kinder)
	if res2, _ := h.PurgeOnce(); res2.ProcessExecutions != 1 {
		t.Errorf("2. Lauf gelöscht %d, want 1 (hk-parent)", res2.ProcessExecutions)
	}
	if n := count(t, db, `SELECT count(*) FROM process_executions WHERE id LIKE 'hk-%'`); n != 2 {
		t.Errorf("übrig %d, want 2 (hk-fresh, hk-open)", n)
	}
	// Deaktiviert (<= 0) löscht nichts
	if res3, _ := New(db, Config{}, nil).PurgeOnce(); res3 != (Result{}) {
		t.Errorf("ohne Konfiguration darf nichts gelöscht werden: %+v", res3)
	}
}
