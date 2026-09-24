package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/asset"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/objectstore"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/storagebackends"
)

// StorageBackendService verwaltet die super-admin-konfigurierten S3/
// MinIO-Backends UND löst sie zu einem nutzbaren Presigned-URL-Client
// auf (Nutzerauftrag 2026-09-24, löst das bisherige, einzelne fest per
// OMP_MINIO_*-Umgebungsvariablen konfigurierte ObjectStoreService ab,
// Kapitel 21 B5 Nachtrag 280). Ein Interface statt zweier getrennter
// (Verwaltung + Nutzung) — beide Zuständigkeiten hängen am selben
// *storagebackends.Store, eine künstliche Trennung brächte hier keinen
// Vorteil.
type StorageBackendService interface {
	Create(ctx context.Context, in storagebackends.Input, createdBy string) (storagebackends.Backend, error)
	Get(id string) (storagebackends.Backend, error)
	List() ([]storagebackends.Backend, error)
	UpdateMeta(ctx context.Context, id string, in storagebackends.Input) (storagebackends.Backend, error)
	UpdateStatus(id, status string) (storagebackends.Backend, error)
	Delete(id string) error
	CountRepresentations(id string) (int, error)
	TestConnection(ctx context.Context, in storagebackends.Input) error
	Resolve(ctx context.Context, id string) (*objectstore.Client, error)
}

// handleCreateUploadURL liefert POST
// /api/v1/asset-versions/{id}/upload-url: {"fileName": "...",
// "storageBackendId": "..."} — eine zeitlich begrenzte Presigned-PUT-URL
// gegen das gewählte Backend, direkt vom Client (Browser o. ä.) genutzt,
// ohne eigene S3-Zugangsdaten und ohne die Datei durch den Orchestrator
// zu schleusen (s. objectstore-Paketdoku). Die zurückgegebene `storage`-
// Angabe (+ `storageBackendId`) ist danach 1:1 der Wert für den
// anschließenden `POST .../representations`-Aufruf (B4) — dieser
// Endpunkt legt selbst NOCH KEINE Representation an, das bleibt ein
// zweiter, expliziter Schritt (der Aufrufer kennt die tatsächlichen
// technischen Details wie Auflösung/Codec erst NACH dem Upload).
func handleCreateUploadURL(assetSvc AssetService, backends StorageBackendService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if backends == nil {
			http.Error(w, "no storage backends configured (OMP_STORAGE_SECRET_KEY unset, or none added yet — see Administration > Storage)", http.StatusServiceUnavailable)
			return
		}
		var body struct {
			FileName         string `json:"fileName"`
			StorageBackendID string `json:"storageBackendId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.FileName == "" || body.StorageBackendID == "" {
			http.Error(w, "fileName and storageBackendId required", http.StatusBadRequest)
			return
		}
		versionID := r.PathValue("id")
		version, err := assetSvc.GetVersion(versionID)
		if err != nil {
			writeAssetError(w, err)
			return
		}
		client, err := backends.Resolve(r.Context(), body.StorageBackendID)
		if err != nil {
			writeStorageBackendError(w, err)
			return
		}
		key := objectstore.Key(version.AssetID, versionID, body.FileName, shortRandomID())
		uploadURL, err := client.PresignedUploadURL(r.Context(), key)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"uploadUrl":        uploadURL.String(),
			"expiresIn":        int(objectstore.DefaultPresignExpiry.Seconds()),
			"storage":          asset.StorageLocation{Provider: "s3", URI: client.URIFor(key)},
			"storageBackendId": body.StorageBackendID,
		})
	}
}

// handleCreateDownloadURL liefert GET /api/v1/representations/{id}/download-url
// — Presigned-GET-URL für eine bestehende Representation, deren
// StorageBackendID gesetzt ist (andere Fälle, z. B. ein reiner
// Dateipfad-Verweis ohne echten Objektspeicher-Upload, liefern bewusst
// 400: dieser Endpunkt kennt nur den Objektspeicher-Fall).
func handleCreateDownloadURL(assetSvc AssetService, backends StorageBackendService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if backends == nil {
			http.Error(w, "no storage backends configured (OMP_STORAGE_SECRET_KEY unset, or none added yet — see Administration > Storage)", http.StatusServiceUnavailable)
			return
		}
		rep, err := assetSvc.GetRepresentation(r.PathValue("id"))
		if err != nil {
			writeAssetError(w, err)
			return
		}
		if rep.StorageBackendID == "" {
			http.Error(w, "this representation has no storage backend (a manual/legacy entry, not an object-store upload)", http.StatusBadRequest)
			return
		}
		client, err := backends.Resolve(r.Context(), rep.StorageBackendID)
		if err != nil {
			writeStorageBackendError(w, err)
			return
		}
		key, err := objectstore.KeyFromURI(client.Bucket(), rep.Storage.URI)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		downloadURL, err := client.PresignedDownloadURL(r.Context(), key)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"downloadUrl": downloadURL.String(),
			"expiresIn":   int(objectstore.DefaultPresignExpiry.Seconds()),
		})
	}
}

func writeStorageBackendError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, storagebackends.ErrNotFound):
		http.Error(w, "storage backend not found — it may have been removed", http.StatusNotFound)
	case errors.Is(err, storagebackends.ErrUnreachable):
		http.Error(w, "storage backend is currently unreachable: "+err.Error(), http.StatusBadGateway)
	default:
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// shortRandomID — reine Kollisionsvermeidung im Objekt-Schlüssel bei
// gleichem Dateinamen, keine sicherheitsrelevante Bedeutung (anders als
// invite.rs' Tokens in Nachtrag 278) — daher ohne zusätzliche
// Abhängigkeit über `time.Now().UnixNano()` statt eines echten
// UUID-Generators.
func shortRandomID() string {
	return strings.TrimPrefix(fmt.Sprintf("%x", time.Now().UnixNano()), "-")
}
