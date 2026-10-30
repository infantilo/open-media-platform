package main

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/asset"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/auth"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/cluster"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
	audiorulesmod "github.com/infantilo/openmediaplatform/orchestrator/internal/modules/audiorules"
	cloudmod "github.com/infantilo/openmediaplatform/orchestrator/internal/modules/cloud"
	extsvcmod "github.com/infantilo/openmediaplatform/orchestrator/internal/modules/extsvc"
	ingestmod "github.com/infantilo/openmediaplatform/orchestrator/internal/modules/ingest"
	jobsmod "github.com/infantilo/openmediaplatform/orchestrator/internal/modules/jobs"
	playoutmod "github.com/infantilo/openmediaplatform/orchestrator/internal/modules/playout"
	reviewmod "github.com/infantilo/openmediaplatform/orchestrator/internal/modules/review"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/process"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/registry"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/subtitlegen"
)

// registerModules meldet die Module des Orchestrators an (UMSETZUNG.md Kapitel 36). Cloud (36.6), Audio-Ausgabe (36.7),
// Playout (36.8), Eingang/Review (Kapitel 43) sind Module; `extsvc` ist das Dienst-Gateway (Kapitel 48), über das Fachdienste in eigenen
// Nodes (z. B. Intercom) Rechte, Oberfläche, Metriken und Audit in die Plattform einbringen.
func registerModules(reg *module.Registry, playoutSvc *playoutmod.Services, reviewMod *reviewmod.Module, ingestMod *ingestmod.Module, extsvcMod *extsvcmod.Module, jobsMod *jobsmod.Module) {
	for _, m := range []module.Module{cloudmod.New(), playoutmod.New(playoutSvc), audiorulesmod.New(), reviewMod, ingestMod, extsvcMod, jobsMod} {
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

// loadServiceToken liest `OMP_SERVICE_TOKEN` oder, ohne die Variable, die Datei `OMP_SERVICE_TOKEN_FILE` (Standard: neben dem JWT-Geheimnis, wird beim
// ersten Start angelegt).
func loadServiceToken(defaultDir string) (string, error) {
	if t := os.Getenv("OMP_SERVICE_TOKEN"); t != "" {
		return t, nil
	}
	path := os.Getenv("OMP_SERVICE_TOKEN_FILE")
	if path == "" {
		path = filepath.Join(defaultDir, "service-token")
	}
	b, err := auth.LoadOrCreateSecret(path)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// subtitleNodes liefert die erreichbaren Auto-Untertitel-Nodes (Instanzen des Typs omp-subtitle-asr mit Node im Verzeichnis).
func subtitleNodes(l interface{ List() []launcher.Instance }, nodes interface{ List() []registry.NodeView }) func() []subtitlegen.Target {
	return func() []subtitlegen.Target {
		types := map[string]bool{}
		for _, in := range l.List() {
			if in.Type == "omp-subtitle-asr" {
				types[in.ID] = true
			}
		}
		var out []subtitlegen.Target
		for _, n := range nodes.List() {
			if n.Online && n.APIBaseURL != "" && types[n.InstanceID] {
				out = append(out, subtitlegen.Target{NodeID: n.ID, InstanceID: n.InstanceID, Label: n.Label, BaseURL: n.APIBaseURL})
			}
		}
		return out
	}
}

// subtitleSteps verbindet den Prozess-Schritt „Untertitel“ mit dem Auto-Untertitel-Node und der Ablage (Asset-Version, Playout-Verzeichnis).
type subtitleSteps struct {
	assets  *asset.Store
	targets func() []subtitlegen.Target
	client  subtitlegen.Client
	// assetRoot: Ablage der Dateien (<assetRoot>/<Asset|process>/<Name>.srt); playDir: Verzeichnis, aus dem das Kind-Event SUBTITLE abspielt.
	assetRoot, playDir string
}

func newSubtitleSteps(assets *asset.Store, targets func() []subtitlegen.Target) *subtitleSteps {
	root := os.Getenv("OMP_REVIEW_DIR")
	if root == "" {
		root = "data/review"
	}
	play := os.Getenv("OMP_SUBTITLE_DIR")
	if play == "" {
		play = "data/subtitles"
	}
	return &subtitleSteps{assets: assets, targets: targets, assetRoot: filepath.Join(root, "subtitles"), playDir: play}
}

// stepJobID: stabile Auftrags-ID je Ausführung+Schritt (Neustart der Engine → derselbe Auftrag, kein zweiter).
func stepJobID(key string) string {
	sum := sha1.Sum([]byte(key))
	return "p" + hex.EncodeToString(sum[:])[:30]
}

// source liefert den Pfad der Mediendatei: die angegebene Datei oder die Quelle des Assets.
func (s *subtitleSteps) source(cfg process.SubtitleStepConfig) (string, error) {
	if cfg.File != "" {
		return cfg.File, nil
	}
	a, err := s.assets.GetAsset(cfg.AssetID)
	if err != nil {
		return "", fmt.Errorf("Asset %s: %w", cfg.AssetID, err)
	}
	reps, err := s.assets.ListRepresentations(a.CurrentVersionID)
	if err != nil {
		return "", err
	}
	var local []asset.Representation
	for _, r := range reps {
		if r.Type == "source" {
			local = append([]asset.Representation{r}, local...)
		} else {
			local = append(local, r)
		}
	}
	for _, r := range local {
		if r.Type == "subtitle" || r.Type == "proxy" {
			continue
		}
		if p, err := reviewmod.LocalPath(r); err == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("Asset %s hat keine lokal lesbare Quelldatei", cfg.AssetID)
}

func (s *subtitleSteps) Step(ctx context.Context, key string, cfg process.SubtitleStepConfig) (process.SubtitleStepResult, bool, error) {
	id := stepJobID(key)
	targets := s.targets()
	// Gibt es den Auftrag schon (Poll oder Neustart), dort weiterfragen.
	var lastErr error
	for _, t := range targets {
		st, err := s.client.Status(ctx, t, id)
		if errors.Is(err, subtitlegen.ErrJobLost) {
			continue
		}
		if err != nil {
			lastErr = err
			continue
		}
		switch st.State {
		case "done":
			srt, err := s.client.Result(ctx, t, id)
			if err != nil {
				return process.SubtitleStepResult{}, false, err
			}
			name := subtitlegen.Slug(cfg.Name)
			if name == "" {
				name = "untertitel-" + id[:8]
			}
			subject := cfg.AssetID
			if subject == "" {
				subject = "process"
			}
			pl, err := subtitlegen.Place(s.assets, cfg.AssetID, name, srt, filepath.Join(s.assetRoot, subject), s.playDir)
			if err != nil {
				return process.SubtitleStepResult{}, false, fmt.Errorf("Ergebnis nicht ablegbar: %w", err)
			}
			s.client.Cancel(ctx, t, id, true)
			return process.SubtitleStepResult{SRT: pl.Path, Name: pl.Name, PlayoutTrack: strings.TrimSuffix(filepath.Base(pl.PlayoutPath), ".srt"), RepresentationID: pl.RepID, Speakers: st.SpeakersFound, Cues: st.Cues, DurationS: st.DurationS, Warning: pl.Warning}, true, nil
		case "failed", "canceled":
			msg := st.Message
			if msg == "" {
				msg = st.State
			}
			return process.SubtitleStepResult{}, false, errors.New(msg)
		default:
			return process.SubtitleStepResult{}, false, nil
		}
	}
	if lastErr != nil {
		return process.SubtitleStepResult{}, false, lastErr
	}
	// neu einreichen
	src, err := s.source(cfg)
	if err != nil {
		return process.SubtitleStepResult{}, false, err
	}
	t, err := s.client.Pick(ctx, targets, cfg.Speakers)
	if err != nil {
		return process.SubtitleStepResult{}, false, err
	}
	lang := cfg.Language
	if lang == "" {
		lang = "de"
	}
	name := subtitlegen.Slug(cfg.Name)
	if name == "" {
		name = "untertitel-" + id[:8]
	}
	err = s.client.Submit(ctx, t, subtitlegen.Request{ID: id, File: src, Track: cfg.Track, Language: lang, Speakers: cfg.Speakers, Names: cfg.Names, Word: cfg.Word, Style: cfg.Style, Name: name})
	return process.SubtitleStepResult{}, false, err
}
