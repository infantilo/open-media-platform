package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/backup"
)

// BackupService — schmales Interface auf internal/backup.Service
// (Nutzerwunsch 2026-08-13: Backup über das Browser-UI), gleiches
// Muster wie die übrigen *Service-Interfaces in diesem Paket (Tests
// bauen einen Fake statt eines echten podman-Aufrufs).
type BackupService interface {
	Create(ctx context.Context) (backup.Result, error)
	List() ([]string, error)
	Path(name string) (string, error)
}

// SupervisorClient löst den eigentlichen Restore-Auftrag beim
// eigenständigen Supervisor-Prozess aus (supervisor/main.go) — der
// Orchestrator selbst kann sich nicht befehlen, sich mitten in dieser
// Antwort zu stoppen, s. dortiger Paketkommentar. TriggerRestore
// kehrt zurück, sobald der Supervisor den Auftrag ANGENOMMEN hat
// (dessen eigener Handler antwortet, bevor er den Orchestrator
// tatsächlich stoppt) — nicht erst, wenn der Restore fertig ist.
type SupervisorClient interface {
	TriggerRestore(ctx context.Context, file string) error
}

// handleCreateBackup liefert POST /api/v1/admin/backup — erstellt eine
// neue Sicherung und liefert sie direkt als Download zurück (kein
// Zwischenschritt "erst erstellen, dann separat abrufen" nötig, ein
// Backup ist klein genug für eine einzelne Antwort).
func handleCreateBackup(svc BackupService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		result, err := svc.Create(r.Context())
		if err != nil {
			http.Error(w, fmt.Sprintf("Backup fehlgeschlagen: %s", err), http.StatusInternalServerError)
			return
		}
		serveBackupFile(w, result.Path, result.Name)
	}
}

// handleListBackups liefert GET /api/v1/admin/backups — Dateinamen
// vorhandener Sicherungen (neueste zuerst), Grundlage für die Restore-
// Auswahl in der UI (welche Datei restoren?).
func handleListBackups(svc BackupService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		names, err := svc.List()
		if err != nil {
			http.Error(w, fmt.Sprintf("Sicherungen konnten nicht aufgelistet werden: %s", err), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, names)
	}
}

// handleDownloadBackup liefert GET /api/v1/admin/backups/{name} — eine
// bereits vorhandene Sicherung erneut herunterladen (z. B. um sie extern
// zu sichern, ohne eine neue erstellen zu müssen).
func handleDownloadBackup(svc BackupService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		path, err := svc.Path(name)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		serveBackupFile(w, path, name)
	}
}

// handleRestore liefert POST /api/v1/admin/restore — löst einen
// vollständigen Datenbank-Restore aus. Body: {"file": "<name>",
// "confirm": true} — gleiches Prinzip wie workflows.Service.Stop's
// confirm_stop, hier aber HART erforderlich (kein "true als impliziter
// Default"): das ist die folgenreichste Aktion der gesamten Plattform
// (ersetzt JEDEN aktuellen Datenbankinhalt), eine vergessene Bestätigung
// darf nicht still durchlaufen.
func handleRestore(backupSvc BackupService, supervisor SupervisorClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			File    string `json:"file"`
			Confirm bool   `json:"confirm"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		if !body.Confirm {
			http.Error(w, "Bestätigung erforderlich (confirm: true)", http.StatusBadRequest)
			return
		}
		if _, err := backupSvc.Path(body.File); err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		if err := supervisor.TriggerRestore(r.Context(), body.File); err != nil {
			http.Error(w, fmt.Sprintf("Supervisor nicht erreichbar oder Restore bereits im Gange: %s", err), http.StatusServiceUnavailable)
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]string{
			"status": "restore eingeleitet — der Server ist für einige Sekunden nicht erreichbar",
		})
	}
}

func serveBackupFile(w http.ResponseWriter, path, name string) {
	data, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, fmt.Sprintf("Backup-Datei konnte nicht gelesen werden: %s", err), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, name))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
