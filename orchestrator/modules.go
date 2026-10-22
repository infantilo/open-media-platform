package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/auth"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/cluster"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
	audiorulesmod "github.com/infantilo/openmediaplatform/orchestrator/internal/modules/audiorules"
	cloudmod "github.com/infantilo/openmediaplatform/orchestrator/internal/modules/cloud"
	extsvcmod "github.com/infantilo/openmediaplatform/orchestrator/internal/modules/extsvc"
	ingestmod "github.com/infantilo/openmediaplatform/orchestrator/internal/modules/ingest"
	playoutmod "github.com/infantilo/openmediaplatform/orchestrator/internal/modules/playout"
	reviewmod "github.com/infantilo/openmediaplatform/orchestrator/internal/modules/review"
)

// registerModules meldet die Module des Orchestrators an (UMSETZUNG.md Kapitel 36). Cloud (36.6), Audio-Ausgabe (36.7),
// Playout (36.8), Eingang/Review (Kapitel 43) sind Module; `extsvc` ist das Dienst-Gateway (Kapitel 48), über das Fachdienste in eigenen
// Nodes (z. B. Intercom) Rechte, Oberfläche, Metriken und Audit in die Plattform einbringen.
func registerModules(reg *module.Registry, playoutSvc *playoutmod.Services, reviewMod *reviewmod.Module, ingestMod *ingestmod.Module, extsvcMod *extsvcmod.Module) {
	for _, m := range []module.Module{cloudmod.New(), playoutmod.New(playoutSvc), audiorulesmod.New(), reviewMod, ingestMod, extsvcMod} {
		if err := reg.Register(m); err != nil {
			slog.Error("module registration failed", "module", m.Name(), "error", err)
		}
	}
}

// moduleSettings legt den generischen Einstellungsspeicher des Kerns hinter die Modul-Schnittstelle.
type moduleSettings struct{ s *launcher.NodeSettingsStore }

func (m moduleSettings) Get(key string) ([]byte, error) {
	b, err := m.s.Get(key)
	if errors.Is(err, launcher.ErrNodeSettingsNotFound) {
		return nil, module.ErrNotFound
	}
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

// moduleAccess legt den Rechte-Speicher hinter die Zugriffs-Sicht der Modul-Schnittstelle (Kapitel 44).
type moduleAccess struct{ s *authz.Store }

func (a moduleAccess) identityOf(user string) module.Identity {
	id := module.Identity{User: user, Has: func(string) bool { return false }}
	groups, err := a.s.GroupsOf(user)
	if err != nil {
		slog.Warn("access: Gruppen nicht lesbar", "user", user, "error", err)
	}
	id.Groups = groups
	patterns, all, err := a.s.FeaturePatterns(user)
	if err != nil {
		slog.Warn("access: Funktionsrechte nicht lesbar", "user", user, "error", err)
	}
	id.Has = func(f string) bool {
		if all {
			return true
		}
		for _, p := range patterns {
			if authz.FeatureMatches(p, f) {
				return true
			}
		}
		return false
	}
	return id
}

func (a moduleAccess) Identity(r *http.Request) module.Identity {
	user, ok := module.User(r)
	if !ok || user == "" { // Bootstrap-Modus: kein Nutzer, alles erlaubt
		return module.Identity{Has: func(string) bool { return true }}
	}
	return a.identityOf(user)
}

func (a moduleAccess) Can(r *http.Request, feature string) bool {
	return a.Identity(r).Has(feature)
}

// serviceSecrets gibt das Dienst-Token nur für Nodes heraus, die der Launcher selbst gestartet hat (ein fremder Node in der
// NMOS-Registry bekommt es nie).
type serviceSecrets struct {
	l     *launcher.Launcher
	token string
}

func (s serviceSecrets) Secret(instanceID string) string {
	if instanceID == "" || s.token == "" {
		return ""
	}
	if _, ok := s.l.Get(instanceID); ok {
		return s.token
	}
	return ""
}

// loadServiceToken liest `OMP_SERVICE_TOKEN` oder, ohne die Variable, die Datei `OMP_SERVICE_TOKEN_FILE` (Standard
// `../data/service-token`, wird beim ersten Start angelegt).
func loadServiceToken() (string, error) {
	if t := os.Getenv("OMP_SERVICE_TOKEN"); t != "" {
		return t, nil
	}
	path := os.Getenv("OMP_SERVICE_TOKEN_FILE")
	if path == "" {
		path = "../data/service-token"
	}
	b, err := auth.LoadOrCreateSecret(path)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
