// Package objectstore ist die reale S3/MinIO-Anbindung für die
// Asset-Domäne (Kapitel 21 B5, Nachtrag 280 — Nutzerentscheidung
// 2026-09-23, UMSETZUNG.md 21.5: echte MinIO/S3-Anbindung statt der
// schlankeren Referenz-Abstraktion, die `asset.StorageLocation`
// bislang war). Wrappt den offiziellen `minio-go/v7`-Client (S3-
// kompatibel, funktioniert unverändert gegen echtes AWS S3, nicht nur
// MinIO).
//
// **Bewusst NUR Presigned URLs, kein Byte-Proxy durch den
// Orchestrator:** Media-Dateien (Master/Proxy/Thumbnail) können groß
// sein — sie durch den Orchestrator-Prozess zu schleusen würde dessen
// Speicher/Bandbreite unnötig belasten (Correctness/Reliability vor
// Convenience, s. Aufgabenstellungs-Priorität). Der Browser/Client lädt
// direkt gegen MinIO/S3 hoch bzw. herunter, der Orchestrator erzeugt
// nur die zeitlich begrenzte, signierte URL.
//
// Optional wie mTLS/Caddy (`make minio-up`): fehlt die Konfiguration
// (`OMP_MINIO_ENDPOINT` leer), bleibt das Feature inaktiv — kein
// impliziter Zwang, MinIO zu betreiben, um den Rest von OMP zu nutzen.
package objectstore

import (
	"context"
	"fmt"
	"net/url"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// Config konfiguriert den Client — leeres Endpoint heißt "Feature
// deaktiviert", s. main.go.
type Config struct {
	Endpoint  string
	AccessKey string
	SecretKey string
	Bucket    string
	UseSSL    bool
}

// Client erzeugt Presigned URLs für Objekte in einem festen Bucket.
type Client struct {
	raw    *minio.Client
	bucket string
}

// NewClient verbindet und legt den Bucket an, falls er noch nicht
// existiert (Dev-Komfort — ein echtes Produktions-Deployment kann den
// Bucket auch vorab per Infrastruktur-Tooling anlegen, `MakeBucket`
// ist idempotent gegenüber einem bereits bestehenden Bucket).
func NewClient(ctx context.Context, cfg Config) (*Client, error) {
	raw, err := minio.New(cfg.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure: cfg.UseSSL,
	})
	if err != nil {
		return nil, fmt.Errorf("objectstore: connect: %w", err)
	}
	exists, err := raw.BucketExists(ctx, cfg.Bucket)
	if err != nil {
		return nil, fmt.Errorf("objectstore: bucket check: %w", err)
	}
	if !exists {
		if err := raw.MakeBucket(ctx, cfg.Bucket, minio.MakeBucketOptions{}); err != nil {
			return nil, fmt.Errorf("objectstore: create bucket %q: %w", cfg.Bucket, err)
		}
	}
	return &Client{raw: raw, bucket: cfg.Bucket}, nil
}

// DefaultPresignExpiry — lang genug für einen manuellen Datei-Upload
// über eine gemächliche Verbindung, kurz genug, um eine im Browser-
// Verlauf/Server-Log liegende URL nicht dauerhaft gültig zu lassen.
const DefaultPresignExpiry = 15 * time.Minute

// Key baut den Objekt-Schlüssel für eine neu hochzuladende Datei —
// namensraumt nach Asset/Version, ein Zufallsanteil vermeidt Kollisionen
// bei gleichem Dateinamen (z. B. zwei "master.mov"-Uploads verschiedener
// Versionen).
func Key(assetID, assetVersionID, fileName, randomSuffix string) string {
	return fmt.Sprintf("assets/%s/versions/%s/%s-%s", assetID, assetVersionID, randomSuffix, fileName)
}

// PresignedUploadURL liefert eine Presigned-PUT-URL, mit der ein Client
// (ohne eigene S3-Zugangsdaten) EINMALIG direkt gegen den Bucket
// hochladen darf.
func (c *Client) PresignedUploadURL(ctx context.Context, key string) (*url.URL, error) {
	u, err := c.raw.PresignedPutObject(ctx, c.bucket, key, DefaultPresignExpiry)
	if err != nil {
		return nil, fmt.Errorf("objectstore: presigned upload url: %w", err)
	}
	return u, nil
}

// PresignedDownloadURL liefert eine Presigned-GET-URL für ein
// bestehendes Objekt.
func (c *Client) PresignedDownloadURL(ctx context.Context, key string) (*url.URL, error) {
	u, err := c.raw.PresignedGetObject(ctx, c.bucket, key, DefaultPresignExpiry, url.Values{})
	if err != nil {
		return nil, fmt.Errorf("objectstore: presigned download url: %w", err)
	}
	return u, nil
}

// RemoveObject löscht ein Objekt — best-effort vom Aufrufer genutzt,
// wenn eine Representation gelöscht wird (s. httpapi.handleDeleteRepresentation),
// damit verwaiste Uploads nicht unbegrenzt Speicherplatz belegen.
func (c *Client) RemoveObject(ctx context.Context, key string) error {
	if err := c.raw.RemoveObject(ctx, c.bucket, key, minio.RemoveObjectOptions{}); err != nil {
		return fmt.Errorf("objectstore: remove object %q: %w", key, err)
	}
	return nil
}

// URIFor baut die `asset.StorageLocation.URI` für einen gerade
// erzeugten Objekt-Schlüssel — `s3://<bucket>/<key>`, providerneutrales
// Schema (funktioniert identisch für MinIO und echtes AWS S3, s.
// Moduldoku).
func (c *Client) URIFor(key string) string {
	return fmt.Sprintf("s3://%s/%s", c.bucket, key)
}

// KeyFromURI liest den Objekt-Schlüssel aus einer `s3://<bucket>/<key>`-
// URI zurück — Kehrfunktion zu URIFor, für den Download-URL-Endpunkt
// (die Representation kennt nur die URI, nicht mehr den rohen Key).
func KeyFromURI(bucket, uri string) (string, error) {
	prefix := "s3://" + bucket + "/"
	if len(uri) <= len(prefix) || uri[:len(prefix)] != prefix {
		return "", fmt.Errorf("objectstore: uri %q does not start with %q", uri, prefix)
	}
	return uri[len(prefix):], nil
}

// Bucket meldet den konfigurierten Bucket-Namen (für KeyFromURI-Aufrufe
// außerhalb dieses Pakets).
func (c *Client) Bucket() string {
	return c.bucket
}
