package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/updates"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/version"
	"github.com/infantilo/openmediaplatform/update"
)

// System-Update per Browser-Upload (docs/ENTWURF-SYSTEM-UPDATE.md). Der
// Orchestrator nimmt Pakete entgegen, prüft sie (Struktur, SHA-256,
// Ed25519-Signatur) und übergibt das Anwenden an den Supervisor, der ihn
// dafür stoppen/ersetzen/starten muss. Alle Routen VerbAdmin — ein
// Update-Paket ist ausführbarer Code.

// UpdateService verwaltet hochgeladene Pakete (implementiert von
// *updates.Service).
type UpdateService interface {
	Import(r io.Reader) (updates.Entry, error)
	List() ([]updates.Entry, error)
	Get(id string) (updates.Entry, error)
	Verify(id string) (updates.Entry, error)
	Delete(id string) error
	History() ([]updates.HistoryEntry, error)
	TrustedKeyIDs() []string
	AllowUnsigned() bool
}

// UpdateSupervisor löst das Anwenden beim Supervisor aus und liest dessen
// Status (implementiert von *supervisorclient.Client).
type UpdateSupervisor interface {
	TriggerUpdate(ctx context.Context, file string) error
	Status(ctx context.Context) (json.RawMessage, error)
}

// WithUpdates aktiviert /api/v1/admin/updates*. bk wird für das Backup vor
// dem Anwenden benutzt. Ohne diese Option bleiben die Routen mit 501
// beantwortet.
func WithUpdates(svc UpdateService, sup UpdateSupervisor, bk BackupService) HandlerOption {
	return func(o *handlerOptions) { o.updates, o.updateSup, o.updateBackup = svc, sup, bk }
}

func handleVersion(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, version.Current())
}

func updatesDisabled(w http.ResponseWriter, svc UpdateService) bool {
	if svc == nil {
		http.Error(w, "System-Update ist nicht aktiviert", http.StatusNotImplemented)
		return true
	}
	return false
}

// handleListUpdates: GET /api/v1/admin/updates — Pakete, Historie,
// Vertrauensanker, laufender Zustand.
func handleListUpdates(svc UpdateService, sup UpdateSupervisor, launcherSvc LauncherService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if updatesDisabled(w, svc) {
			return
		}
		packages, err := svc.List()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		history, err := svc.History()
		if err != nil {
			history = []updates.HistoryEntry{}
		}
		outdated := 0
		for _, inst := range instancesWithOutdated(launcherSvc) {
			if inst.Outdated {
				outdated++
			}
		}
		resp := map[string]any{
			"current":           version.Current(),
			"packages":          packages,
			"history":           history,
			"trustedKeys":       svc.TrustedKeyIDs(),
			"allowUnsigned":     svc.AllowUnsigned(),
			"outdatedInstances": outdated,
		}
		if sup != nil {
			ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
			defer cancel()
			if st, err := sup.Status(ctx); err == nil {
				resp["supervisor"] = st
			} else {
				resp["supervisorError"] = err.Error()
			}
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

// handleUploadUpdate: POST /api/v1/admin/updates/upload — rohe Bytes
// (application/gzip), gestreamt auf Platte.
func handleUploadUpdate(svc UpdateService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if updatesDisabled(w, svc) {
			return
		}
		e, err := svc.Import(r.Body)
		if err != nil {
			status := http.StatusBadRequest
			if errors.Is(err, updates.ErrTooLarge) {
				status = http.StatusRequestEntityTooLarge
			}
			http.Error(w, fmt.Sprintf("Update-Paket abgelehnt: %s", err), status)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "system_update", e.ID, "uploaded",
			map[string]any{"version": e.Version, "sha256": e.SHA256, "signed": e.Signed, "keyId": e.KeyID})
		writeJSON(w, http.StatusCreated, e)
	}
}

// handleDeleteUpdate: DELETE /api/v1/admin/updates/{id}.
func handleDeleteUpdate(svc UpdateService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if updatesDisabled(w, svc) {
			return
		}
		id := r.PathValue("id")
		if err := svc.Delete(id); err != nil {
			if errors.Is(err, updates.ErrNotFound) {
				http.Error(w, err.Error(), http.StatusNotFound)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "system_update", id, "deleted", nil)
		w.WriteHeader(http.StatusNoContent)
	}
}

// handleApplyUpdate: POST /api/v1/admin/updates/{id}/apply
// {"confirm":true,"version":"<Version zur Bestätigung>","backup":true,"force":false}
func handleApplyUpdate(svc UpdateService, sup UpdateSupervisor, bk BackupService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if updatesDisabled(w, svc) {
			return
		}
		if sup == nil {
			http.Error(w, "Supervisor nicht konfiguriert", http.StatusNotImplemented)
			return
		}
		var body struct {
			Confirm bool   `json:"confirm"`
			Version string `json:"version"`
			Backup  *bool  `json:"backup"`
			Force   bool   `json:"force"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		if !body.Confirm {
			http.Error(w, "Bestätigung erforderlich (confirm: true)", http.StatusBadRequest)
			return
		}
		id := r.PathValue("id")
		// Erneut vollständig prüfen — das Archiv könnte seit dem Upload
		// verändert worden sein.
		e, err := svc.Verify(id)
		if err != nil {
			status := http.StatusBadRequest
			if errors.Is(err, updates.ErrNotFound) {
				status = http.StatusNotFound
			}
			http.Error(w, fmt.Sprintf("Paket nicht anwendbar: %s", err), status)
			return
		}
		if body.Version != e.Version {
			http.Error(w, fmt.Sprintf("Bestätigung falsch: Version %q eintippen", e.Version), http.StatusBadRequest)
			return
		}
		if msg := compatibilityProblem(e.Manifest, body.Force); msg != "" {
			http.Error(w, msg, http.StatusConflict)
			return
		}

		// Backup vor dem Anwenden: Standard an, Pflicht wenn das Update
		// die Datenbank verändert (Migrationen).
		wantBackup := body.Backup == nil || *body.Backup
		if len(e.Manifest.Migrations) > 0 {
			wantBackup = true
		}
		backupName := ""
		if wantBackup {
			if bk == nil {
				http.Error(w, "Backup-Dienst nicht verfügbar", http.StatusServiceUnavailable)
				return
			}
			res, err := bk.Create(r.Context())
			if err != nil {
				http.Error(w, fmt.Sprintf("Backup vor dem Update fehlgeschlagen — Update abgebrochen: %s", err), http.StatusInternalServerError)
				return
			}
			backupName = res.Name
		}

		if err := sup.TriggerUpdate(r.Context(), e.File); err != nil {
			http.Error(w, fmt.Sprintf("Supervisor nicht erreichbar oder beschäftigt: %s", err), http.StatusServiceUnavailable)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "system_update", e.ID, "apply_started",
			map[string]any{"from": version.Version, "to": e.Version, "backup": backupName, "force": body.Force})
		writeJSON(w, http.StatusAccepted, map[string]any{
			"status": "update eingeleitet — der Server ist für einige Sekunden nicht erreichbar",
			"backup": backupName,
		})
	}
}

// compatibilityProblem prüft Mindestversion und Downgrade. Ein Build ohne
// Stempel ("dev") kennt seine Version nicht und wird nicht blockiert.
func compatibilityProblem(m update.Manifest, force bool) string {
	cur := version.Version
	if cur == "dev" || cur == "" {
		return ""
	}
	if m.MinFromVersion != "" && update.CompareVersions(cur, m.MinFromVersion) < 0 {
		return fmt.Sprintf("Dieses Update setzt mindestens Version %s voraus (installiert: %s) — erst ein Zwischenupdate einspielen", m.MinFromVersion, cur)
	}
	if !force && update.CompareVersions(m.Version, cur) <= 0 {
		return fmt.Sprintf("Version %s ist nicht neuer als die installierte %s — zum Erzwingen „force“ setzen", m.Version, cur)
	}
	return ""
}

// ---- Markierung veralteter Instanzen ------------------------------------

// instancesWithOutdated liefert die Instanzen mit gesetztem Outdated-Feld:
// eine lokale Instanz gilt als veraltet, wenn ihr Binary (laut Katalog)
// NEUER ist als der Prozessstart — das Update hat es ersetzt, der
// Prozess läuft noch mit dem alten Stand (Linux hält die alte Inode).
func instancesWithOutdated(svc LauncherService) []launcher.Instance {
	list := svc.List()
	catalog := map[string][]string{}
	for _, c := range svc.Catalog() {
		if len(c.Command) > 0 {
			catalog[c.Type] = c.Command
		}
	}
	for i := range list {
		if list[i].HostID != "" || list[i].PID <= 0 || list[i].Crashed {
			continue
		}
		cmd, ok := catalog[list[i].Type]
		if !ok {
			continue
		}
		bin, err := os.Stat(cmd[0])
		if err != nil {
			continue
		}
		start, ok := processStartTime(list[i].PID)
		if !ok {
			continue
		}
		list[i].Outdated = bin.ModTime().After(start)
	}
	return list
}

// processStartTime liest den Startzeitpunkt eines Prozesses aus /proc
// (Linux): Feld 22 von /proc/<pid>/stat (Ticks seit Boot, 100 Hz) plus
// btime aus /proc/stat.
func processStartTime(pid int) (time.Time, bool) {
	stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return time.Time{}, false
	}
	s := string(stat)
	i := strings.LastIndex(s, ")")
	if i < 0 {
		return time.Time{}, false
	}
	fields := strings.Fields(s[i+1:])
	// Nach ")" beginnt Feld 3 — Feld 22 ist Index 19.
	if len(fields) < 20 {
		return time.Time{}, false
	}
	ticks, err := strconv.ParseInt(fields[19], 10, 64)
	if err != nil {
		return time.Time{}, false
	}
	procStat, err := os.ReadFile("/proc/stat")
	if err != nil {
		return time.Time{}, false
	}
	for _, line := range strings.Split(string(procStat), "\n") {
		if rest, ok := strings.CutPrefix(line, "btime "); ok {
			btime, err := strconv.ParseInt(strings.TrimSpace(rest), 10, 64)
			if err != nil {
				return time.Time{}, false
			}
			return time.Unix(btime, 0).Add(time.Duration(ticks) * 10 * time.Millisecond), true
		}
	}
	return time.Time{}, false
}
