package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/instancemigrate"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/workflows"
)

// newID erzeugt eine zufällige Hex-ID — gleiche kleine, paketlokale
// Dopplung wie workflows.newID/snapshots.newID (keine gemeinsame Util-
// Datei nur für diese eine Zeile), hier für die je-Claim-eindeutige
// "role" in handlePostInstance (s. dortige Doku).
func newID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

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
// ErrCatalogVersionAmbiguous (HTTP 409, s. writeLauncherError). Ein
// optionales {"label": "..."} (Nutzerwunsch 2026-07-28) ersetzt das
// automatisch generierte "<Typ> (<Kurz-ID>)"-Label — landet u. a. als
// NMOS-Sender-Label und macht die Quelle dadurch in Kreuzschienen-
// Dropdowns (Bild-/Audiomischer) sinnvoll benennbar.
//
// Live gefundener Bug (2026-08-07): ein per Katalog manuell gestarteter
// Control-Plane-Node (workflows.IsControlPlaneNodeType, z. B.
// `omp-playout-automation`) bekam bislang GAR KEINE Rollenbindung —
// diese entsteht bisher nur in workflows.Service.runStart, workflow-
// gescopt auf `wf.ID`. Ohne Workflow-Kontext blieb sein Service-Token
// (POST /api/v1/instances/<id>/service-token, dasselbe Secret-Verfahren)
// zwar ausstellbar, aber auf jedem Ziel-Node wirkungslos: sowohl
// authz.Store.Check (nur workflow_id = "") als auch CheckWorkflow
// (verlangt eine Workflow-Rolle des Ziel-Nodes, s. dortige Doku "z. B.
// eine manuell über den Katalog gestartete Instanz") schlagen fehl ->
// `requireVerbOnNode` liefert 403 auf jeden proxierten params-/methods-
// Aufruf, z. B. omp-playout-automations `append()` gegen einen ebenso
// manuell gestarteten Player. Fix: dieselbe Bindung wie beim Workflow-
// Start, aber mit leerem workflowId (= globaler/Node-gescopter Scope,
// "unverändertes Vor-Kapitel-12-Teil-4-Verhalten", s. authz.Store.Create-
// Doku) statt eines Workflow-Scopes, den es hier gar nicht gibt — best
// effort wie beim Workflow-Pfad, ein Fehler hier bricht den Start nicht ab.
// Nutzerfund 2026-08-20 ("deklink node crasht immer noch beim start"):
// ein per Node-Katalog/Instanzen-Tab DIREKT gestarteter `omp-decklink`
// (kein Workflow-Kontext) durchlief NIE workflows.Service.Start()s
// claimIOPortsForStart — selbst nach dessen Fix (D13-Portweitergabe,
// s. workflows/ioports.go) startete diese Instanz weiterhin mit dem
// eingebauten Default (device-number=0, ingest) und lief auf jedem Host
// ohne echte Karte an genau diesem Index in denselben Crash-Loop. Fix:
// derselbe Claim-Mechanismus, jetzt auch am direkten Start-Pfad — ein
// optionales `{"requiredIoPort":{"cardType":"decklink","direction":
// "in"|"out"}}` im Body claimt VOR dem Start atomar einen passenden
// freien Port (bevorzugt auf `hostId`, falls gesetzt — "kein stiller
// Fallback auf einen anderen Host", dieselbe Linie wie
// workflows.Service.claimIOPortsForStart), übersetzt ihn über
// `workflows.IoPortExtraEnv` in die vom Node gelesenen Umgebungs-
// variablen und trägt bei Erfolg die tatsächliche Instanz-ID auf dem
// Claim nach (rein für die Anzeige in `GET /api/v1/hosts`, best effort).
// `ioPortStore` darf nil sein (kein I/O-Port-Inventar konfiguriert) —
// dann wird eine Anfrage MIT requiredIoPort ehrlich abgelehnt statt
// still zu ignorieren (gleiche Regel wie am Workflow-Pfad).
func handlePostInstance(svc LauncherService, authzStore AuthzChecker, ioPortStore IOPortInventoryStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Type           string                     `json:"type"`
			Version        string                     `json:"version"`
			HostID         string                     `json:"hostId"`
			Label          string                     `json:"label"`
			RequiredIOPort *workflows.IOPortRequirement `json:"requiredIoPort,omitempty"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}

		// Direkter Katalog-Start hat keinen Workflow-Kontext, also
		// normalerweise kein extraEnv (Kapitel 15, s. launcher.Launcher.
		// Start-Doku) — Nodes laufen mit ihren Katalog-/Programm-Defaults,
		// AUSSER die Anfrage deklariert requiredIoPort (s. Funktionsdoku).
		hostID := body.HostID
		var extraEnv map[string]string
		var claimedHostID, claimedPortID string
		var claimRole string
		if body.RequiredIOPort != nil {
			if body.RequiredIOPort.CardType == "" {
				http.Error(w, "requiredIoPort.cardType must not be empty", http.StatusBadRequest)
				return
			}
			if body.RequiredIOPort.Direction != "in" && body.RequiredIOPort.Direction != "out" {
				http.Error(w, `requiredIoPort.direction must be "in" or "out"`, http.StatusBadRequest)
				return
			}
			if ioPortStore == nil {
				http.Error(w, "instance needs an I/O port but no I/O port inventory is configured on this orchestrator", http.StatusBadRequest)
				return
			}
			// Eindeutiger (workflowId="", role)-Schlüssel je Claim-Versuch
			// (s. Funktionsdoku) — Store.Release/UpdateInstanceID schlagen
			// beide auf (workflow_id, role) nach; ein wiederverwendeter
			// fester role-Wert über mehrere gleichzeitige Direkt-Starts
			// hinweg würde deren Claims live gefunden nicht mehr
			// unterscheidbar machen.
			id, err := newID()
			if err != nil {
				http.Error(w, "failed to generate claim id", http.StatusInternalServerError)
				return
			}
			claimRole = "direct:" + body.Type + ":" + id
			var ok bool
			claimedHostID, claimedPortID, ok, err = ioPortStore.Claim(body.RequiredIOPort.CardType, body.RequiredIOPort.Direction, hostID, "", claimRole, "")
			if err != nil {
				http.Error(w, "claim io port: "+err.Error(), http.StatusInternalServerError)
				return
			}
			if !ok {
				if hostID != "" {
					http.Error(w, fmt.Sprintf("needs a free %s/%s port on host %q, none available (no silent fallback to another host)", body.RequiredIOPort.CardType, body.RequiredIOPort.Direction, hostID), http.StatusBadRequest)
				} else {
					http.Error(w, fmt.Sprintf("needs a free %s/%s port, none available on any host", body.RequiredIOPort.CardType, body.RequiredIOPort.Direction), http.StatusBadRequest)
				}
				return
			}
			hostID = claimedHostID
			extraEnv = workflows.IoPortExtraEnv(body.RequiredIOPort, claimedPortID)
		}

		inst, err := svc.StartLabeled(body.Type, body.Version, hostID, body.Label, extraEnv)
		if err != nil {
			if claimRole != "" {
				if relErr := ioPortStore.ReleasePort(claimedHostID, claimedPortID); relErr != nil {
					slog.Warn("launcher: rollback: release io port claim after failed start failed", "type", body.Type, "error", relErr)
				}
			}
			writeLauncherError(w, err)
			return
		}

		if claimRole != "" {
			if err := ioPortStore.UpdateInstanceID("", claimRole, inst.ID); err != nil {
				slog.Warn("launcher: update io port claim instance id failed", "instance", inst.ID, "error", err)
			}
		}

		if workflows.IsControlPlaneNodeType(body.Type) {
			if _, err := authzStore.Create(inst.ID, "", authz.AnyNode, authz.VerbOperate); err != nil {
				slog.Warn("launcher: failed to provision service-token role binding for manually started instance",
					"instance", inst.ID, "type", body.Type, "error", err)
			}
		}

		writeJSON(w, http.StatusOK, inst)
	}
}

// handleDeleteInstance liefert DELETE /api/v1/instances/<id>. Gibt einen
// per handlePostInstance geclaimten I/O-Port wieder frei (Nutzerfund
// 2026-08-20, s. dortige Doku) — best effort wie UpdateInstanceID, ein
// Fehler hier verhindert nicht den eigentlichen Stop; `ReleasePort`
// selbst ist ein No-Op, wenn diese Instanz nie einen Port geclaimt hatte
// (kein passender Claim-Datensatz gefunden).
func handleDeleteInstance(svc LauncherService, ioPortStore IOPortInventoryStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if err := svc.Stop(id); err != nil {
			writeLauncherError(w, err)
			return
		}
		if ioPortStore != nil {
			if err := ioPortStore.ReleaseClaimedByInstance(id); err != nil {
				slog.Warn("launcher: release io port claim on instance stop failed", "instance", id, "error", err)
			}
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// handleMigrateInstance liefert POST /api/v1/instances/<id>/migrate
// (Kapitel 13 Teil 3) — s. instancemigrate.Service.MigrateInstance-Doku.
// Body: {"targetHostId": "..."} ("" oder fehlend = lokal, gleiche
// Konvention wie überall sonst). Asynchron wie Restart/Migrate bei
// Workflow-Rollen: liefert sofort zurück, der eigentliche Umzug läuft
// im Hintergrund weiter (per SSE/Poll auf /api/v1/instances bzw.
// /api/v1/graph beobachtbar).
func handleMigrateInstance(svc InstanceMigrator) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			TargetHostID string `json:"targetHostId"`
		}
		if r.ContentLength != 0 {
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, "invalid JSON body", http.StatusBadRequest)
				return
			}
		}
		if err := svc.MigrateInstance(r.Context(), r.PathValue("id"), body.TargetHostID); err != nil {
			writeInstanceMigrateError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

func writeInstanceMigrateError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, instancemigrate.ErrUnknownInstance):
		http.Error(w, err.Error(), http.StatusNotFound)
	case errors.Is(err, instancemigrate.ErrSameHost), errors.Is(err, instancemigrate.ErrNotRegistered):
		http.Error(w, err.Error(), http.StatusConflict)
	default:
		http.Error(w, err.Error(), http.StatusInternalServerError)
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
