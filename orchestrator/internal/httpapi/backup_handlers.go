package httpapi

import (
	"context"
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
