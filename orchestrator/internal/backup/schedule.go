package backup

import (
	"context"
	"log/slog"
	"time"
)

// BackupNameTime liest den Zeitpunkt aus einem Backup-Dateinamen (omp-YYYYMMDDTHHMMSSZ.sql.gz).
func BackupNameTime(name string) (time.Time, bool) {
	if len(name) < len("omp-20060102T150405Z.sql.gz") {
		return time.Time{}, false
	}
	t, err := time.Parse("20060102T150405Z", name[len("omp-"):len("omp-20060102T150405Z")])
	return t, err == nil
}

// RunSchedule legt regelmäßig Sicherungen an (Audit 2026-10-23 M8: bisher nur von Hand). Läuft, bis ctx endet; der Aufrufer
// startet sie nur auf dem Raft-Leader. Eine Sicherung entsteht, wenn die neueste älter als interval ist (oder keine existiert);
// geprüft wird alle check. Ein Fehlschlag wird laut protokolliert und nach `retry` erneut versucht.
func RunSchedule(ctx context.Context, interval, check, retry time.Duration, newest func() (time.Time, bool), create func(context.Context) (string, error)) {
	if interval <= 0 {
		return
	}
	next := time.Time{}
	tick := time.NewTicker(check)
	defer tick.Stop()
	for {
		now := time.Now()
		if now.After(next) {
			last, ok := newest()
			if !ok || now.Sub(last) >= interval {
				name, err := create(ctx)
				if err != nil {
					slog.Error("geplante Sicherung fehlgeschlagen", "error", err, "retry_in", retry)
					next = now.Add(retry)
				} else {
					slog.Info("geplante Sicherung angelegt", "name", name)
				}
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

// Newest liefert den Zeitpunkt der neuesten Sicherung (ok=false: keine).
func (s *Service) Newest() (time.Time, bool) {
	names, err := s.List()
	if err != nil || len(names) == 0 {
		return time.Time{}, false
	}
	return BackupNameTime(names[0])
}
