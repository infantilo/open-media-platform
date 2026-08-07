// Package safego kapselt `go`-Aufrufe für Hintergrund-Goroutinen, deren
// Panic sonst den GANZEN Orchestrator-Prozess mitreißt — es gibt keinen
// Supervisor über dem Orchestrator selbst, ein einziger unbewachter
// Absturz beendet damit jeden laufenden Workflow gleichzeitig (UX-Audit
// 2026-08-07, docs/decisions.md Nachtrag 123 Teil 2: 0 Treffer für
// `recover()` im gesamten Orchestrator zum Zeitpunkt des Funds). `Go`
// begrenzt den Schaden eines künftigen Bugs in EINER Goroutine auf genau
// diese, statt den Prozess mitzunehmen — behebt keinen bestehenden Bug,
// sondern dessen Blast-Radius.
package safego

import (
	"log/slog"
	"runtime/debug"
)

// Go startet fn in einer neuen Goroutine. Eine Panic darin wird
// abgefangen, strukturiert geloggt (inkl. Stacktrace) und NICHT erneut
// geworfen — der Prozess läuft weiter, nur die eine Goroutine endet
// vorzeitig. name identifiziert die Goroutine im Log (z. B.
// "workflows.runStart"), damit ein künftiger Fund einer bestimmten
// Aufrufstelle zuordenbar ist.
func Go(name string, fn func()) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("safego: recovered panic in background goroutine",
					"goroutine", name, "panic", r, "stack", string(debug.Stack()))
			}
		}()
		fn()
	}()
}
