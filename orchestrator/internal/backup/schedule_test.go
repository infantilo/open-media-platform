package backup

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestBackupNameTime(t *testing.T) {
	got, ok := BackupNameTime("omp-20261025T021500Z.sql.gz")
	if !ok || !got.Equal(time.Date(2026, 10, 25, 2, 15, 0, 0, time.UTC)) {
		t.Fatalf("%v %v", got, ok)
	}
	for _, bad := range []string{"", "omp-x.sql.gz", "foo-20261025T021500Z.sql.gz"[:10]} {
		if _, ok := BackupNameTime(bad); ok {
			t.Errorf("%q", bad)
		}
	}
}

func runFor(d time.Duration, interval time.Duration, newest func() (time.Time, bool), create func(context.Context) (string, error)) {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	RunSchedule(ctx, interval, 10*time.Millisecond, 30*time.Millisecond, newest, create)
}

func TestScheduleCreatesWhenNoneOrOldAndSkipsWhenFresh(t *testing.T) {
	var n atomic.Int32
	create := func(context.Context) (string, error) { n.Add(1); return "x", nil }
	runFor(100*time.Millisecond, time.Hour, func() (time.Time, bool) { return time.Time{}, false }, create)
	if n.Load() == 0 {
		t.Fatal("ohne Sicherung muss eine entstehen")
	}
	n.Store(0)
	runFor(100*time.Millisecond, time.Hour, func() (time.Time, bool) { return time.Now().Add(-2 * time.Hour), true }, create)
	if n.Load() == 0 {
		t.Fatal("alte Sicherung ⇒ neue")
	}
	n.Store(0)
	runFor(100*time.Millisecond, time.Hour, func() (time.Time, bool) { return time.Now().Add(-5 * time.Minute), true }, create)
	if n.Load() != 0 {
		t.Fatal("frische Sicherung ⇒ nichts tun")
	}
	n.Store(0)
	runFor(100*time.Millisecond, 0, func() (time.Time, bool) { return time.Time{}, false }, create)
	if n.Load() != 0 {
		t.Fatal("Intervall 0 = aus")
	}
}

func TestScheduleBacksOffAfterFailure(t *testing.T) {
	var n atomic.Int32
	create := func(context.Context) (string, error) { n.Add(1); return "", errors.New("pg_dump fehlt") }
	runFor(200*time.Millisecond, time.Hour, func() (time.Time, bool) { return time.Time{}, false }, create)
	if c := n.Load(); c < 2 || c > 8 {
		t.Fatalf("wiederholt nach Pause, nicht im Takt der Prüfung: %d Versuche", c)
	}
}
