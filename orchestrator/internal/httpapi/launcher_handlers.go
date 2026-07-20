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

// handlePostCatalogEntry liefert POST /api/v1/catalog (§17 Teil 4,
// docs/END-GOAL-FEATURES.md §17.3d/§17.4, Nutzerentscheidung
// 2026-07-20: Podman-Container-Import mit C9-Mindestprüfung). Der
// eigentliche Admission-Check (Kandidat testweise als Wegwerf-Container
// starten, tools/contract-check/checker.Run laufen lassen) passiert
// vollständig innerhalb von svc.ImportCatalogEntry — dieser Handler
// reicht den Request-Body nur durch und übersetzt das Ergebnis in
// HTTP-Statuscodes. requireVerbGlobal(authz.VerbAdmin, ...) (server.go)
// bewusst so streng wie POST /api/v1/instances: ein Import startet
// mindestens kurzzeitig einen Fremd-Container.
func handlePostCatalogEntry(svc LauncherService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var entry launcher.CatalogEntry
		if err := json.NewDecoder(r.Body).Decode(&entry); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}

		if err := svc.ImportCatalogEntry(entry); err != nil {
			writeCatalogImportError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, entry)
	}
}

// handleDeleteCatalogEntry liefert DELETE /api/v1/catalog/<type> (§17
// Teil 4/5) — entfernt einen zuvor importierten Eintrag; statische
// Einträge aus deploy/catalog.json sind darüber nie löschbar (s.
// launcher.ErrCatalogTypeNotImported). Optionaler `?version=`-Query-
// Parameter (§17 Teil 5: mehrere Versionen desselben Typs) — fehlt er,
// wird "" angenommen (unverändertes Verhalten für unversionierte
// Importe aus §17 Teil 4).
func handleDeleteCatalogEntry(svc LauncherService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := svc.RemoveCatalogEntry(r.PathValue("type"), r.URL.Query().Get("version")); err != nil {
			writeCatalogImportError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// writeCatalogImportError übersetzt die launcher-Fehler rund um Import/
// Entfernen eines Katalog-Eintrags in passende HTTP-Statuscodes —
// eigene Funktion statt writeLauncherError-Erweiterung, da diese
// Fehlerfamilie (inkl. *ErrAdmissionCheckFailed mit vollem
// Contract-Check-Report) komplett anders aussieht als die
// Start/Stop-Fehler dort.
func writeCatalogImportError(w http.ResponseWriter, err error) {
	var admissionErr *launcher.ErrAdmissionCheckFailed
	switch {
	case errors.As(err, &admissionErr):
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{
			"error":   "admission check failed",
			"results": admissionErr.Results,
		})
	case errors.Is(err, launcher.ErrCatalogInvalidEntry):
		http.Error(w, err.Error(), http.StatusBadRequest)
	case errors.Is(err, launcher.ErrCatalogTypeExists):
		http.Error(w, err.Error(), http.StatusConflict)
	case errors.Is(err, launcher.ErrCatalogTypeNotImported):
		http.Error(w, err.Error(), http.StatusNotFound)
	case errors.Is(err, launcher.ErrCatalogTypeInUse):
		http.Error(w, err.Error(), http.StatusConflict)
	case errors.Is(err, launcher.ErrCatalogImportUnavailable):
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
	default:
		http.Error(w, err.Error(), http.StatusInternalServerError)
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
// Remote-Host. Fehlt hostId, unverändertes Verhalten seit C8. Ein
// optionales {"version": "..."} (§17 Teil 5) wählt zwischen mehreren
// importierten Versionen desselben Typs — fehlt es und ist der Typ
// eindeutig (statisch oder nur einmal importiert), unverändertes
// Verhalten; ist er mehrdeutig, liefert svc.Start
// ErrCatalogVersionAmbiguous (HTTP 409, s. writeLauncherError).
func handlePostInstance(svc LauncherService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Type    string `json:"type"`
			Version string `json:"version"`
			HostID  string `json:"hostId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}

		// Direkter Katalog-Start hat keinen Workflow-Kontext, also kein
		// extraEnv (Kapitel 15, s. launcher.Launcher.Start-Doku) — Nodes
		// laufen mit ihren Katalog-/Programm-Defaults.
		inst, err := svc.Start(body.Type, body.Version, body.HostID, nil)
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
	var versionErr *launcher.ErrCatalogVersionAmbiguous
	switch {
	case errors.Is(err, launcher.ErrUnknownType), errors.Is(err, launcher.ErrUnknownInstance):
		http.Error(w, err.Error(), http.StatusNotFound)
	case errors.Is(err, launcher.ErrUnsupportedRunner):
		http.Error(w, err.Error(), http.StatusBadRequest)
	case errors.Is(err, launcher.ErrRemoteUnavailable):
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
	case errors.As(err, &versionErr):
		// §17 Teil 5: Typ existiert, aber mehrdeutig ohne Version — 409
		// (wie ErrCatalogTypeExists/ErrCatalogTypeInUse: ein Konflikt mit
		// dem aktuellen Katalog-Zustand, kein "nicht gefunden").
		writeJSON(w, http.StatusConflict, map[string]any{
			"error":    versionErr.Error(),
			"type":     versionErr.Type,
			"versions": versionErr.Versions,
		})
	default:
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}
