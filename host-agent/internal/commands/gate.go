package commands

import (
	"log/slog"

	"github.com/infantilo/openmediaplatform/jobwire"
)

// Gate prüft, ob ein auf dem Kommando-Subject empfangenes Kommando ausgeführt werden darf (Audit 2026-10-23 B2):
// mit Schlüssel nur signierte, frische, nicht wiederholte Kommandos; ohne Schlüssel (Host aus der Zeit vor der Signatur)
// wie bisher, bis der Orchestrator den Schlüssel liefert („provision-key“, einmalig).
type Gate struct {
	Verifier *jobwire.Verifier
	// Persist speichert den Schlüssel dauerhaft (State-Datei); ein Fehler lässt die Provisionierung scheitern.
	Persist func(key string) error
	// RequireKey: ohne Schlüssel nur provision-key annehmen (OMP_HOST_AGENT_REQUIRE_KEY=1) — für Hosts, die nie unsigniert laufen sollen.
	RequireKey bool
}

// Admit liefert (Antwort, true), wenn das Kommando NICHT ausgeführt werden soll (abgelehnt oder bereits erledigt, z. B.
// provision-key); sonst (leer, false) → Executor.Handle.
func (g *Gate) Admit(subject string, data []byte, header func(string) string, req Request) (Response, bool) {
	if req.Action == jobwire.ActionProvisionKey {
		if g.Verifier.Active() {
			slog.Warn("provision-key refused: this agent already has a command key")
			return Response{OK: false, Error: "already provisioned"}, true
		}
		if len(req.CommandKey) < 32 {
			return Response{OK: false, Error: "invalid command key"}, true
		}
		if g.Persist != nil {
			if err := g.Persist(req.CommandKey); err != nil {
				return Response{OK: false, Error: "persist command key: " + err.Error()}, true
			}
		}
		g.Verifier.SetKey(req.CommandKey)
		slog.Info("command key provisioned — commands must be signed from now on")
		return Response{OK: true}, true
	}
	if g.RequireKey && !g.Verifier.Active() {
		return Response{OK: false, Error: "unauthorized: no command key provisioned yet"}, true
	}
	if err := g.Verifier.Verify(subject, data, header); err != nil {
		slog.Warn("command rejected", "action", req.Action, "error", err)
		return Response{OK: false, Error: "unauthorized: " + err.Error()}, true
	}
	if req.Action == jobwire.ActionRotateKey { // erst nach erfolgreicher Prüfung mit dem bisherigen Schlüssel
		if len(req.CommandKey) < 32 {
			return Response{OK: false, Error: "invalid command key"}, true
		}
		if g.Persist != nil {
			if err := g.Persist(req.CommandKey); err != nil {
				return Response{OK: false, Error: "persist command key: " + err.Error()}, true
			}
		}
		g.Verifier.SetKey(req.CommandKey)
		slog.Info("command key rotated")
		return Response{OK: true}, true
	}
	return Response{}, false
}
