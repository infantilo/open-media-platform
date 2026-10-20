package audit

import (
	"fmt"
	"testing"
	"time"
)

func TestAsyncLoggerBatchesAndPersistsAll(t *testing.T) {
	database := testDB(t)
	store := NewStore(database, nil)
	username := "test-audit-async"
	t.Cleanup(func() { _, _ = database.Exec(`DELETE FROM audit_log WHERE username = $1`, username) })

	a := NewAsyncLogger(store, 1024)
	const n = 500
	for i := 0; i < n; i++ {
		a.Log(username, "PATCH", fmt.Sprintf("/p/%d", i), "node", 200)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		var c int
		if err := database.QueryRow(`SELECT count(*) FROM audit_log WHERE username = $1`, username).Scan(&c); err != nil {
			t.Fatal(err)
		}
		if c == n {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("persisted %d of %d entries", c, n)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
