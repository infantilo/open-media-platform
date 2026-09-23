package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/asset"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/objectstore"
)

// ObjectStoreService erzeugt Presigned URLs für den konfigurierten
// S3/MinIO-Bucket (implementiert von *objectstore.Client, Kapitel 21
// B5, Nachtrag 280). Eigenes, schmales Interface statt Erweiterung von
// AssetService — Objektspeicher ist eine reine Infrastruktur-Fähigkeit,
// kennt die Asset-Domäne selbst nicht (s. objectstore-Paketdoku).
type ObjectStoreService interface {
	PresignedUploadURL(ctx context.Context, key string) (*url.URL, error)
	PresignedDownloadURL(ctx context.Context, key string) (*url.URL, error)
	URIFor(key string) string
	Bucket() string
}

// handleCreateUploadURL liefert POST
// /api/v1/asset-versions/{id}/upload-url: {"fileName": "..."} — eine
// zeitlich begrenzte Presigned-PUT-URL, gegen die der Client (Browser
// o. ä.) DIREKT hochlädt, ohne eigene S3-Zugangsdaten und ohne die
// Datei durch den Orchestrator zu schleusen (s. objectstore-Paketdoku).
// Die zurückgegebene `storage`-Angabe ist danach 1:1 der `storage`-
// Wert für den anschließenden `POST .../representations`-Aufruf (B4) —
// dieser Endpunkt legt selbst NOCH KEINE Representation an, das bleibt
// ein zweiter, expliziter Schritt (der Aufrufer kennt die tatsächlichen
// technischen Details wie Auflösung/Codec erst NACH dem Upload).
func handleCreateUploadURL(assetSvc AssetService, store ObjectStoreService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if store == nil {
			http.Error(w, "object storage not configured (OMP_MINIO_ENDPOINT unset)", http.StatusServiceUnavailable)
			return
		}
		var body struct {
			FileName string `json:"fileName"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.FileName == "" {
			http.Error(w, "fileName required", http.StatusBadRequest)
			return
		}
		versionID := r.PathValue("id")
		version, err := assetSvc.GetVersion(versionID)
		if err != nil {
			writeAssetError(w, err)
			return
		}
		key := objectstore.Key(version.AssetID, versionID, body.FileName, shortRandomID())
		uploadURL, err := store.PresignedUploadURL(r.Context(), key)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"uploadUrl": uploadURL.String(),
			"expiresIn": int(objectstore.DefaultPresignExpiry.Seconds()),
			"storage":   asset.StorageLocation{Provider: "s3", URI: store.URIFor(key)},
		})
	}
}

// handleCreateDownloadURL liefert GET /api/v1/representations/{id}/download-url
// — Presigned-GET-URL für eine bestehende Representation, deren
// Storage-Provider "s3"/"minio" ist (andere Provider, z. B. ein reiner
// Dateipfad-Verweis, liefern hier bewusst 400: dieser Endpunkt kennt
// nur den einen, echten Objektspeicher-Fall).
func handleCreateDownloadURL(assetSvc AssetService, store ObjectStoreService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if store == nil {
			http.Error(w, "object storage not configured (OMP_MINIO_ENDPOINT unset)", http.StatusServiceUnavailable)
			return
		}
		rep, err := assetSvc.GetRepresentation(r.PathValue("id"))
		if err != nil {
			writeAssetError(w, err)
			return
		}
		if rep.Storage.Provider != "s3" && rep.Storage.Provider != "minio" {
			http.Error(w, fmt.Sprintf("representation storage provider %q is not an object-store URI", rep.Storage.Provider), http.StatusBadRequest)
			return
		}
		key, err := objectstore.KeyFromURI(store.Bucket(), rep.Storage.URI)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		downloadURL, err := store.PresignedDownloadURL(r.Context(), key)
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

// shortRandomID — reine Kollisionsvermeidung im Objekt-Schlüssel bei
// gleichem Dateinamen, keine sicherheitsrelevante Bedeutung (anders als
// invite.rs' Tokens in Nachtrag 278) — daher ohne zusätzliche
// Abhängigkeit über `time.Now().UnixNano()` statt eines echten
// UUID-Generators.
func shortRandomID() string {
	return strings.TrimPrefix(fmt.Sprintf("%x", time.Now().UnixNano()), "-")
}
