package main

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/cluster"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
	cloudmod "github.com/infantilo/openmediaplatform/orchestrator/internal/modules/cloud"
)

// registerModules meldet die Module des Orchestrators an (UMSETZUNG.md Kapitel 36). Cloud (UI-Teil, 36.3; Rest 36.6),
// Audio-Ausgabe (36.7) und Playout (36.8) ziehen schrittweise hierher um.
func registerModules(reg *module.Registry) {
	for _, m := range []module.Module{cloudmod.Module{}} {
		if err := reg.Register(m); err != nil {
			slog.Error("module registration failed", "module", m.Name(), "error", err)
		}
	}
}

// moduleSettings legt den generischen Einstellungsspeicher des Kerns hinter die Modul-Schnittstelle.
type moduleSettings struct{ s *launcher.NodeSettingsStore }

func (m moduleSettings) Get(key string) ([]byte, error) {
	b, err := m.s.Get(key)
	return []byte(b), err
}
func (m moduleSettings) Put(key string, data []byte) error {
	return m.s.Put(key, json.RawMessage(data))
}

// startModules startet die Hintergrundjobs der Module — nur auf dem Raft-Leader.
func startModules(ctx context.Context, reg *module.Registry, deps module.Deps, node *cluster.Node) {
	reg.Start(ctx, deps, func(ctx context.Context, fn func(context.Context)) { runWhileLeader(ctx, node, fn) })
}
