package httpapi

// Cluster-Rolling-Update (Kap. 84, docs/ENTWURF-SYSTEM-UPDATE.md §11): Admin-API (Start/Fortsetzen/Abbrechen/Stand)
// und die internen Mitglieds-Routen, über die der Koordinator die übrigen Orchestratoren ansteuert.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/clusterupdate"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/updates"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/version"
)

// ClusterRolloutDriver steuert Rollouts (implementiert von *clusterupdate.Driver).
type ClusterRolloutDriver interface {
	Start(ctx context.Context, p clusterupdate.StartParams) (*clusterupdate.Rollout, []string, error)
	Resume() error
	Cancel() error
	Latest() (*clusterupdate.Rollout, error)
}

// WithClusterRollout aktiviert /api/v1/admin/cluster-rollout* und die internen Mitglieds-Routen.
// token ist das aus dem gemeinsamen Geheimnis abgeleitete Mitglieds-Token (clusterupdate.DeriveToken).
func WithClusterRollout(d ClusterRolloutDriver, token string) HandlerOption {
	return func(o *handlerOptions) { o.clusterRollout, o.clusterRolloutToken = d, token }
}

// processStarted: Startzeit dieses Prozesses; der Koordinator erkennt daran, dass ein Mitglied neu gestartet ist.
var processStarted = time.Now().UTC()

type restarter interface {
	TriggerRestart(ctx context.Context) error
}

// ---- interne Mitglieds-Routen --------------------------------------------------

func memberAuth(token string, w http.ResponseWriter, r *http.Request) bool {
	if !clusterupdate.TokenValid(token, r.Header.Get(clusterupdate.TokenHeader)) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return false
	}
	return true
}

// handleMemberInfo: GET /api/v1/internal/cluster-update/info
func handleMemberInfo(token string, clusterSvc ClusterService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !memberAuth(token, w, r) {
			return
		}
		writeJSON(w, http.StatusOK, clusterupdate.InfoResponse{Version: version.Version, StartedAt: processStarted, Status: clusterSvc.Status()})
	}
}

// handleMemberFetch: POST …/fetch — lädt das Paket vom Koordinator und prüft es mit dem EIGENEN Vertrauensanker.
func handleMemberFetch(token string, svc UpdateService, nv NodeVersionRegistrar) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !memberAuth(token, w, r) {
			return
		}
		if updatesDisabled(w, svc) {
			return
		}
		var req clusterupdate.FetchRequest
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil || req.PackageID == "" || req.URL == "" {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		// Nur der feste Download-Pfad des Koordinators, nichts anderes.
		u, err := url.Parse(req.URL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Path != "/api/v1/host-updates/"+req.PackageID {
			http.Error(w, "unzulaessige Download-URL", http.StatusBadRequest)
			return
		}
		if e, err := svc.Get(req.PackageID); err == nil {
			if _, err := svc.Verify(e.ID); err == nil {
				writeJSON(w, http.StatusOK, map[string]string{"status": "bereits vorhanden", "id": e.ID})
				return
			}
		}
		hreq, _ := http.NewRequestWithContext(r.Context(), http.MethodGet, req.URL, nil)
		res, err := (&http.Client{Timeout: 10 * time.Minute}).Do(hreq)
		if err != nil {
			http.Error(w, "Download: "+err.Error(), http.StatusBadGateway)
			return
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusOK {
			http.Error(w, fmt.Sprintf("Download: %d", res.StatusCode), http.StatusBadGateway)
			return
		}
		e, err := svc.Import(res.Body)
		if err != nil {
			http.Error(w, "Paket abgelehnt: "+err.Error(), http.StatusUnprocessableEntity)
			return
		}
		if e.ID != req.PackageID {
			http.Error(w, "Paket-ID weicht ab: "+e.ID, http.StatusUnprocessableEntity)
			return
		}
		if nv != nil {
			if _, err := nv.RegisterPackage(e.File, e.Manifest, "Update "+e.Version); err != nil {
				slog.Warn("cluster-update: Node-Binaries nicht uebernommen", "update", e.ID, "error", err)
			}
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "geladen", "id": e.ID})
	}
}

// handleMemberApply: POST …/apply — löst Update bzw. Neustart über den lokalen Supervisor aus. Fencing: eine
// Anforderung mit kleinerer Raft-Amtszeit als die eigene stammt von einem abgelösten Leader und wird abgewiesen.
func handleMemberApply(token string, svc UpdateService, sup UpdateSupervisor, nv NodeVersionRegistrar, launcherSvc LauncherService, clusterSvc ClusterService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !memberAuth(token, w, r) {
			return
		}
		var req clusterupdate.ApplyRequest
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		if own := clusterSvc.Status().Term; req.Term < own {
			http.Error(w, fmt.Sprintf("abgeloester Koordinator (Term %d < %d)", req.Term, own), http.StatusConflict)
			return
		}
		if sup == nil {
			http.Error(w, "Supervisor nicht konfiguriert", http.StatusNotImplemented)
			return
		}
		switch req.Kind {
		case clusterupdate.KindRestart:
			rs, ok := sup.(restarter)
			if !ok {
				http.Error(w, "Supervisor unterstuetzt keinen Neustart", http.StatusNotImplemented)
				return
			}
			if err := rs.TriggerRestart(r.Context()); err != nil {
				http.Error(w, err.Error(), http.StatusServiceUnavailable)
				return
			}
			logDomainAudit(domainAudit, "cluster-rollout", "system_update", "restart", "member_restart_started", map[string]any{"term": req.Term})
		case clusterupdate.KindUpdate:
			if updatesDisabled(w, svc) {
				return
			}
			e, err := svc.Verify(req.PackageID)
			if err != nil {
				http.Error(w, "Paket nicht anwendbar: "+err.Error(), http.StatusBadRequest)
				return
			}
			if req.Version != e.Version {
				http.Error(w, fmt.Sprintf("Version %q erwartet, Paket hat %q", req.Version, e.Version), http.StatusBadRequest)
				return
			}
			if !e.Manifest.RollingSafe {
				http.Error(w, "Paket ist nicht rollingSafe", http.StatusConflict)
				return
			}
			if msg := compatibilityProblem(e.Manifest, false); msg != "" {
				http.Error(w, msg, http.StatusConflict)
				return
			}
			if nv != nil && launcherSvc != nil {
				paths, _ := catalogBinaries(launcherSvc.Catalog())
				nv.RegisterInstalled(paths)
			}
			if err := sup.TriggerUpdate(r.Context(), e.File); err != nil {
				http.Error(w, "Supervisor nicht erreichbar oder beschaeftigt: "+err.Error(), http.StatusServiceUnavailable)
				return
			}
			logDomainAudit(domainAudit, "cluster-rollout", "system_update", e.ID, "member_apply_started", map[string]any{"from": version.Version, "to": e.Version, "term": req.Term})
		default:
			http.Error(w, "unbekannte Art", http.StatusBadRequest)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "eingeleitet"})
	}
}

// handleMemberAnnounce: POST …/announce — nur auf dem Leader: trägt die HTTP-Adresse eines Mitglieds ins FSM ein.
// In einem per OMP_CLUSTER_PEERS gegründeten Cluster kündigt sich sonst nur der Leader selbst an.
func handleMemberAnnounce(token string, clusterSvc ClusterService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !memberAuth(token, w, r) {
			return
		}
		var req clusterupdate.AnnounceRequest
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil || req.NodeID == "" || req.HTTPAddr == "" {
			http.Error(w, "invalid body", http.StatusBadRequest)
			return
		}
		if u, err := url.Parse(req.HTTPAddr); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			http.Error(w, "ungueltige HTTP-Adresse", http.StatusBadRequest)
			return
		}
		if !clusterSvc.IsLeader() {
			http.Error(w, "nicht Leader", http.StatusConflict)
			return
		}
		member := false
		for _, p := range clusterSvc.Status().Peers {
			if p.ID == req.NodeID {
				member = true
			}
		}
		if !member {
			http.Error(w, "kein Cluster-Mitglied", http.StatusForbidden)
			return
		}
		setter, ok := clusterSvc.(interface {
			SetPeerHTTPAddr(nodeID, httpAddr string) error
		})
		if !ok {
			http.Error(w, "nicht unterstuetzt", http.StatusNotImplemented)
			return
		}
		if err := setter.SetPeerHTTPAddr(req.NodeID, req.HTTPAddr); err != nil {
			http.Error(w, err.Error(), clusterErrorStatus(err))
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}

// ---- Admin-API -----------------------------------------------------------------

func rolloutDisabled(w http.ResponseWriter, d ClusterRolloutDriver) bool {
	if d == nil {
		http.Error(w, "Cluster-Rollout nicht aktiviert", http.StatusNotImplemented)
		return true
	}
	return false
}

// handleGetClusterRollout: GET /api/v1/admin/cluster-rollout — Stand des letzten Rollouts (aus der Datenbank, auf jedem Mitglied lesbar).
func handleGetClusterRollout(d ClusterRolloutDriver) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if rolloutDisabled(w, d) {
			return
		}
		ro, err := d.Latest()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"rollout": ro})
	}
}

// handleStartClusterRollout: POST /api/v1/admin/cluster-rollout
// {"kind":"update","packageId":"…","version":"<eingetippte Zielversion>","backup":true} bzw. {"kind":"restart","confirm":true}.
func handleStartClusterRollout(d ClusterRolloutDriver, clusterSvc ClusterService, svc UpdateService, bk BackupService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if rolloutDisabled(w, d) {
			return
		}
		if !clusterSvc.IsLeader() {
			forwardToLeader(clusterSvc, w, r)
			return
		}
		var body struct {
			Kind       clusterupdate.Kind `json:"kind"`
			PackageID  string             `json:"packageId"`
			Version    string             `json:"version"`
			Confirm    bool               `json:"confirm"`
			Backup     *bool              `json:"backup"`
			HostsFirst *bool              `json:"hostsFirst"` // Standard: an
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		p := clusterupdate.StartParams{Kind: body.Kind, By: actorFromRequest(r)}
		backupName := ""
		switch body.Kind {
		case clusterupdate.KindRestart:
			if !body.Confirm {
				http.Error(w, "Bestätigung erforderlich (confirm: true)", http.StatusBadRequest)
				return
			}
		case clusterupdate.KindUpdate:
			if updatesDisabled(w, svc) {
				return
			}
			e, err := svc.Verify(body.PackageID)
			if err != nil {
				status := http.StatusBadRequest
				if errors.Is(err, updates.ErrNotFound) {
					status = http.StatusNotFound
				}
				http.Error(w, "Paket nicht anwendbar: "+err.Error(), status)
				return
			}
			if body.Version != e.Version {
				http.Error(w, fmt.Sprintf("Bestätigung falsch: Version %q eintippen", e.Version), http.StatusBadRequest)
				return
			}
			if msg := compatibilityProblem(e.Manifest, false); msg != "" {
				http.Error(w, msg, http.StatusConflict)
				return
			}
			p.PackageID, p.TargetVersion, p.RollingSafe = e.ID, e.Version, e.Manifest.RollingSafe
			p.HostsFirst = body.HostsFirst == nil || *body.HostsFirst
			if (body.Backup == nil || *body.Backup || len(e.Manifest.Migrations) > 0) && p.RollingSafe {
				if bk == nil {
					http.Error(w, "Backup-Dienst nicht verfügbar", http.StatusServiceUnavailable)
					return
				}
				res, err := bk.Create(r.Context())
				if err != nil {
					http.Error(w, "Backup fehlgeschlagen — Rollout abgebrochen: "+err.Error(), http.StatusInternalServerError)
					return
				}
				backupName = res.Name
			}
		default:
			http.Error(w, "kind: update oder restart", http.StatusBadRequest)
			return
		}
		ro, findings, err := d.Start(r.Context(), p)
		if err != nil {
			status := http.StatusInternalServerError
			if errors.Is(err, clusterupdate.ErrActive) {
				status = http.StatusConflict
			}
			http.Error(w, err.Error(), status)
			return
		}
		if len(findings) > 0 {
			writeJSON(w, http.StatusConflict, map[string]any{"error": "Vorprüfung nicht bestanden", "findings": findings})
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "cluster_rollout", ro.ID, "started",
			map[string]any{"kind": ro.Kind, "to": ro.TargetVersion, "package": ro.PackageID, "backup": backupName})
		writeJSON(w, http.StatusAccepted, map[string]any{"rollout": ro, "backup": backupName})
	}
}

// handleClusterRolloutAction: POST …/resume | …/cancel (nur Leader; Follower leitet weiter).
func handleClusterRolloutAction(d ClusterRolloutDriver, clusterSvc ClusterService, action string, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if rolloutDisabled(w, d) {
			return
		}
		if !clusterSvc.IsLeader() {
			forwardToLeader(clusterSvc, w, r)
			return
		}
		var err error
		if action == "resume" {
			err = d.Resume()
		} else {
			err = d.Cancel()
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		ro, _ := d.Latest()
		id := ""
		if ro != nil {
			id = ro.ID
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "cluster_rollout", id, action, nil)
		writeJSON(w, http.StatusOK, map[string]any{"rollout": ro})
	}
}
