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

// registerModules meldet die Module des Orchestrators an (UMSETZUNG.md Kapitel 36). Cloud ist umgezogen (36.6);
// Audio-Ausgabe (36.7) und Playout (36.8) folgen.
func registerModules(reg *module.Registry) {
	for _, m := range []module.Module{cloudmod.New()} {
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

// moduleInstances legt den Launcher hinter die Instanz-Sicht der Modul-Schnittstelle.
type moduleInstances struct{ l *launcher.Launcher }

func (m moduleInstances) CountOnHost(hostID string) int {
	n := 0
	for _, in := range m.l.List() {
		if in.HostID == hostID {
			n++
		}
	}
	return n
}

func (m moduleInstances) LocalLoad() (cpu, mem float64, ok bool) {
	lh := m.l.LocalHost()
	if lh == nil {
		return 0, 0, false
	}
	return lh.CPUPercent, lh.MemPercent, true
}
