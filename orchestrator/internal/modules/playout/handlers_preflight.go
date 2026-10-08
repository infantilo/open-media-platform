package playout

import (
	"encoding/json"
	"errors"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
	"net/http"
	"path/filepath"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/materialize"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/nodeoptions"
)

// Playout-Preflight (Kapitel 27 / P8, Spec §67–73): Ist das Medium eines Events dort verfügbar, wo der Player
// es liest — und wenn nicht, bereitstellen (als OMP-Prozess). Kanal-gescoped: der Aufrufer ist die gebundene
// Automator-Instanz oder ein Operator (channelAccess).

// PreflightService wird von *materialize.Manager + Starter bedient.
type PreflightService interface {
	Check(ref materialize.Ref, target materialize.Target, hosts materialize.HostPaths) materialize.Result
	Resolve(ref materialize.Ref, target materialize.Target) (materialize.Spec, error)
	Start(spec materialize.Spec, by string) (executionID string, err error)
}

type preflightTarget struct {
	// NodeLabel: Label der Player-Instanz; daraus ergeben sich Host und wirksames Medienverzeichnis.
	NodeLabel string `json:"nodeLabel,omitempty"`
	HostID    string `json:"hostId,omitempty"`
	MediaDir  string `json:"mediaDir,omitempty"`
}

type preflightItem struct {
	Key string `json:"key"`
	materialize.Ref
}

// hostFileChecker adaptiert LauncherService.CheckPathOnHost auf materialize.HostPaths.
type hostFileChecker struct{ svc LauncherService }

func (h hostFileChecker) CheckFileOnHost(hostID, path string) (bool, error) {
	chk, ok := h.svc.(hostPathChecker)
	if !ok {
		return false, errors.New("keine Host-Prüfung verfügbar")
	}
	info, err := chk.CheckPathOnHost(hostID, path, nodeoptions.PathFile)
	return info.Readable, err
}

// resolvePreflightTarget bestimmt Host und Medienverzeichnis des Ziel-Players: ausdrücklich angegeben,
// sonst aus der Instanz (Instanz-Wert > Typ-Wert > Standard der Option OMP_MEDIA_DIR).
func resolvePreflightTarget(t preflightTarget, svc LauncherService, values NodeOptionValues) (materialize.Target, error) {
	out := materialize.Target{HostID: t.HostID, MediaDir: t.MediaDir}
	if t.NodeLabel == "" {
		if out.MediaDir == "" {
			return out, errors.New("target braucht nodeLabel oder mediaDir")
		}
		return out, nil
	}
	for _, in := range svc.List() {
		if in.Label != t.NodeLabel {
			continue
		}
		out.HostID = in.HostID
		if out.MediaDir != "" {
			return out, nil
		}
		dir := ""
		if src, ok := svc.(nodeOptionSource); ok {
			if opt, found := nodeoptions.Find(src.NodeOptions(in.Type), "OMP_MEDIA_DIR"); found {
				dir = opt.Default
				if values != nil {
					if tv, err := values.Values(nodeoptions.ScopeType, in.Type); err == nil && tv["OMP_MEDIA_DIR"] != "" {
						dir = tv["OMP_MEDIA_DIR"]
					}
					if iv, err := values.Values(nodeoptions.ScopeInstance, in.ID); err == nil && iv["OMP_MEDIA_DIR"] != "" {
						dir = iv["OMP_MEDIA_DIR"]
					}
				}
			}
		}
		if dir == "" {
			return out, errors.New("Medienverzeichnis des Ziels unbekannt (Option OMP_MEDIA_DIR)")
		}
		if out.HostID == "" && !filepath.IsAbs(dir) {
			if abs, err := filepath.Abs(dir); err == nil {
				dir = abs // relativ zum Arbeitsverzeichnis des Orchestrators, wie für lokal gestartete Nodes
			}
		}
		out.MediaDir = dir
		return out, nil
	}
	return out, errors.New("Ziel-Instanz „" + t.NodeLabel + "“ nicht gefunden")
}

// handlePlayoutPreflight: POST /api/v1/playout/channels/{id}/preflight
// {"target":{"nodeLabel":"…"},"items":[{"key":"…","assetId":"…"}]} → Verfügbarkeit je Eintrag.
func handlePlayoutPreflight(p PreflightService, svc PlayoutService, az verbChecker, roles InstanceRoleResolver, launcher LauncherService, values NodeOptionValues) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := channelAccess(svc, az, roles, w, r); !ok {
			return
		}
		var body struct {
			Target preflightTarget `json:"target"`
			Items  []preflightItem `json:"items"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(&body); err != nil || len(body.Items) == 0 || len(body.Items) > 200 {
			http.Error(w, "target und 1–200 items erforderlich", http.StatusBadRequest)
			return
		}
		target, err := resolvePreflightTarget(body.Target, launcher, values)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		type entry struct {
			Key string `json:"key"`
			materialize.Result
		}
		out := make([]entry, 0, len(body.Items))
		for _, it := range body.Items {
			out = append(out, entry{Key: it.Key, Result: p.Check(it.Ref, target, hostFileChecker{launcher})})
		}
		writeJSON(w, http.StatusOK, map[string]any{"target": target, "items": out})
	}
}

// handlePlayoutMaterialize: POST /api/v1/playout/channels/{id}/materialize — startet die Bereitstellung
// als OMP-Prozess (Execution im Prozess-Bereich sichtbar). Idempotent: läuft schon ein Job, bleibt es dabei.
func handlePlayoutMaterialize(p PreflightService, svc PlayoutService, az verbChecker, roles InstanceRoleResolver, launcher LauncherService, values NodeOptionValues, domainAudit module.DomainAudit) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ch, ok := channelAccess(svc, az, roles, w, r)
		if !ok {
			return
		}
		var body struct {
			Target preflightTarget `json:"target"`
			Item   preflightItem   `json:"item"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		target, err := resolvePreflightTarget(body.Target, launcher, values)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		res := p.Check(body.Item.Ref, target, hostFileChecker{launcher})
		switch res.State {
		case materialize.StateReady, materialize.StateTransferring:
			writeJSON(w, http.StatusOK, map[string]any{"result": res, "started": false})
			return
		case materialize.StateMissing:
			http.Error(w, "nicht bereitstellbar: "+res.Detail, http.StatusConflict)
			return
		}
		if !res.Materializable {
			http.Error(w, "nicht bereitstellbar: "+res.Detail, http.StatusConflict)
			return
		}
		spec, err := p.Resolve(body.Item.Ref, target)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		execID, err := p.Start(spec, module.Actor(r))
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		logDomainAudit(domainAudit, module.Actor(r), "playout_materialize", spec.Key(), "started",
			map[string]any{"channel": ch.ID, "file": spec.FileName, "target": target.MediaDir, "execution": execID})
		writeJSON(w, http.StatusAccepted, map[string]any{"executionId": execID, "started": true, "result": res})
	}
}
