package audit

import "log/slog"

type logJob struct {
	username, method, path, nodeID string
	status                         int
}

// AsyncLogger entkoppelt Store.Log vom Request-Pfad: Einträge laufen über eine
// gepufferte Warteschlange und einen einzelnen Schreib-Goroutine (Reihenfolge
// bleibt erhalten). Ist die Warteschlange voll, wird der Eintrag verworfen und
// geloggt, statt Requests an einer langsamen DB zu blockieren.
type AsyncLogger struct {
	store *Store
	jobs  chan logJob
}

// NewAsyncLogger startet den Schreib-Goroutine (läuft bis Prozessende).
func NewAsyncLogger(store *Store, buffer int) *AsyncLogger {
	a := &AsyncLogger{store: store, jobs: make(chan logJob, buffer)}
	go func() {
		for j := range a.jobs {
			a.store.Log(j.username, j.method, j.path, j.nodeID, j.status)
		}
	}()
	return a
}

// Log erfüllt httpapi.AuditLogger.
func (a *AsyncLogger) Log(username, method, path, nodeID string, status int) {
	select {
	case a.jobs <- logJob{username, method, path, nodeID, status}:
	default:
		slog.Warn("audit log queue full, entry dropped", "username", username, "method", method, "path", path)
	}
}
