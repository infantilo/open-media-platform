package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
)

// mergeInstanceMetrics reichert list um die zuletzt vom Host-Agent
// gemeldeten CPU%/RSS-Werte entfernter Instanzen an (Kapitel 14 Teil 2,
// docs/END-GOAL-FEATURES.md §14.3b) — lokale Instanzen tragen ihren
// Sample-Stand bereits über launcher.Launcher.List() (dortiges
// sampleLocalResources()), diese Funktion ergänzt nur, was dort noch
// fehlt (HostID gesetzt, CPUPercent noch nil). Launcher kennt das
// hosts-Paket bewusst nicht (s. Launcher.Run-Doku) — das Mischen der
// beiden Telemetrie-Quellen passiert deshalb hier, wo ohnehin beide
// Services verdrahtet sind.
func mergeInstanceMetrics(list []launcher.Instance, hostMetrics HostMetricsReader) {
	for i := range list {
		if list[i].HostID == "" || list[i].CPUPercent != nil {
			continue
		}
		m, ok := hostMetrics.Get(list[i].HostID)
		if !ok {
			continue
		}
		for _, im := range m.Instances {
			if im.InstanceID != list[i].ID {
				continue
			}
			cpu, rss := im.CPUPercent, im.RSSBytes
			list[i].CPUPercent = &cpu
			list[i].RSSBytes = &rss
			break
		}
	}
}

// handleCatalog liefert GET /api/v1/catalog (UMSETZUNG.md C8).
func handleCatalog(svc LauncherService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, svc.Catalog())
	}
}

// handleListInstances liefert GET /api/v1/instances. Seit Kapitel 14
// Teil 2 mit CPU%/RSS pro Instanz: lokal von svc.List() selbst
// mitgeliefert, für entfernte (HostID gesetzt) Instanzen hier per
// mergeInstanceMetrics aus der zuletzt empfangenen Host-Agent-Telemetrie
// nachgetragen.
func handleListInstances(svc LauncherService, hostMetrics HostMetricsReader) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list := svc.List()
		mergeInstanceMetrics(list, hostMetrics)
		writeJSON(w, http.StatusOK, list)
	}
}

// handlePostInstance liefert POST /api/v1/instances: {"type":
// "<catalogType>"} startet eine neue Instanz lokal; ein zusätzliches
// {"hostId": "<hostId>"} (ARCHITECTURE.md §18.5, UMSETZUNG.md D6 Teil
// 2) startet sie stattdessen auf dem entsprechend registrierten
// Remote-Host. Fehlt hostId, unverändertes Verhalten seit C8.
func handlePostInstance(svc LauncherService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Type   string `json:"type"`
			HostID string `json:"hostId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}

		// Direkter Katalog-Start hat keinen Workflow-Kontext, also kein
		// extraEnv (Kapitel 15, s. launcher.Launcher.Start-Doku) — Nodes
		// laufen mit ihren Katalog-/Programm-Defaults.
		inst, err := svc.Start(body.Type, body.HostID, nil)
		if err != nil {
			writeLauncherError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, inst)
	}
}

// handleDeleteInstance liefert DELETE /api/v1/instances/<id>.
func handleDeleteInstance(svc LauncherService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := svc.Stop(r.PathValue("id")); err != nil {
			writeLauncherError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

func writeLauncherError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, launcher.ErrUnknownType), errors.Is(err, launcher.ErrUnknownInstance):
		http.Error(w, err.Error(), http.StatusNotFound)
	case errors.Is(err, launcher.ErrUnsupportedRunner):
		http.Error(w, err.Error(), http.StatusBadRequest)
	case errors.Is(err, launcher.ErrRemoteUnavailable):
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
	default:
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}
