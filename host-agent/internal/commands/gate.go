package commands

import (
	"log/slog"

	"github.com/infantilo/openmediaplatform/jobwire"
)

// Gate prüft, ob ein auf dem Kommando-Subject empfangenes Kommando ausgeführt werden darf (Audit 2026-10-23 B2):
// nur signierte, frische, nicht wiederholte Kommandos. Den Schlüssel erhält ein Host mit der Registrierung. Ein Host ohne
// Schlüssel (aus der Zeit vor der Signatur) braucht eine ausdrückliche Freigabe, um ihn über NATS anzunehmen — sonst
// gewönne, wer ihm als Erster einen schickt.
type Gate struct {
	Verifier *jobwire.Verifier
	// Persist speichert den Schlüssel dauerhaft (State-Datei); ein Fehler lässt die Provisionierung scheitern.
	Persist func(key string) error
	// RequireKey: ohne Schlüssel kein Kommando ausführen. Der Agent setzt das, solange OMP_HOST_AGENT_REQUIRE_KEY nicht
	// ausdrücklich „false“ ist.
	RequireKey bool
	// AllowNATSProvision: „provision-key“ über NATS annehmen (OMP_HOST_AGENT_ALLOW_NATS_PROVISION=1, einmalige Übernahme).
	AllowNATSProvision bool
	// EncryptedTransport: die NATS-Verbindung nutzt TLS. Ohne sie wird „rotate-key“ abgelehnt, weil der neue Schlüssel
	// mitlesbar wäre.
	EncryptedTransport bool
}

// Admit liefert (Antwort, true), wenn das Kommando NICHT ausgeführt werden soll (abgelehnt oder bereits erledigt, z. B.
// provision-key); sonst (leer, false) → Executor.Handle.
func (g *Gate) Admit(subject string, data []byte, header func(string) string, req Request) (Response, bool) {
	if req.Action == jobwire.ActionProvisionKey {
		if g.Verifier.Active() {
			slog.Warn("provision-key refused: this agent already has a command key")
			return Response{OK: false, Error: "already provisioned"}, true
		}
		if !g.AllowNATSProvision {
			slog.Warn("provision-key refused: set OMP_HOST_AGENT_ALLOW_NATS_PROVISION=1 once, or register this host again")
			return Response{OK: false, Error: "provisioning over NATS is disabled on this host (OMP_HOST_AGENT_ALLOW_NATS_PROVISION=1 or register the host again)"}, true
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
		// Ohne Schlüssel ist die Prüfung oben wirkungslos: dann gibt es nichts zu wechseln (sonst Erstvergabe durch die Hintertür).
		if !g.Verifier.Active() {
			return Response{OK: false, Error: "no command key to rotate"}, true
		}
		if !g.EncryptedTransport {
			slog.Warn("rotate-key refused: the NATS connection is not encrypted (OMP_NATS_TLS_ENABLED)")
			return Response{OK: false, Error: "key rotation refused: NATS connection of this host is not encrypted (OMP_NATS_TLS_ENABLED)"}, true
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
		slog.Info("command key rotated")
		return Response{OK: true}, true
	}
	return Response{}, false
}
