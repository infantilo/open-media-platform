package objectstore

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"strconv"
	"testing"
	"time"
)

// testClient liefert einen echten Client gegen die durch
// OMP_MINIO_ENDPOINT (+ optional OMP_MINIO_ACCESS_KEY/_SECRET_KEY/
// _BUCKET/_USE_SSL) konfigurierte MinIO-Instanz (`make minio-up`,
// Kapitel 21 B5) — kein Mock: Presigned URLs sind gerade der Teil, den
// eine echte S3-kompatible Signatur-Implementierung ausmacht, ein Mock
// hätte genau diesen Teil ungetestet gelassen. t.Skip, wenn die
// Umgebungsvariable fehlt (gleiches Muster wie internal/dbtest.Open —
// kein impliziter Fallback auf einen möglicherweise falschen Default).
func testClient(t *testing.T) *Client {
	t.Helper()
	endpoint := os.Getenv("OMP_MINIO_ENDPOINT")
	if endpoint == "" {
		t.Skip("OMP_MINIO_ENDPOINT nicht gesetzt — objectstore-Test übersprungen (make minio-up, dann OMP_MINIO_ENDPOINT=127.0.0.1:9000 setzen)")
	}
	useSSL, _ := strconv.ParseBool(os.Getenv("OMP_MINIO_USE_SSL"))
	accessKey := os.Getenv("OMP_MINIO_ACCESS_KEY")
	if accessKey == "" {
		accessKey = "omp-minio-dev"
	}
	secretKey := os.Getenv("OMP_MINIO_SECRET_KEY")
	if secretKey == "" {
		secretKey = "omp-minio-dev-pass"
	}
	bucket := os.Getenv("OMP_MINIO_BUCKET")
	if bucket == "" {
		bucket = "omp-assets-test"
	}
	client, err := NewClient(context.Background(), Config{
		Endpoint: endpoint, AccessKey: accessKey, SecretKey: secretKey, Bucket: bucket, UseSSL: useSSL,
	})
	if err != nil {
		t.Fatalf("NewClient() error = %v", err)
	}
	return client
}

// TestPresignedUploadThenDownloadRoundTrip ist der eigentliche Sinn
// dieses Pakets: eine echte Presigned-PUT-URL, mit der ein Client OHNE
// eigene S3-Zugangsdaten hochladen darf, danach eine echte
// Presigned-GET-URL, die exakt dieselben Bytes zurückliefert — beides
// gegen die reale MinIO-Instanz, kein simulierter Erfolg.
func TestPresignedUploadThenDownloadRoundTrip(t *testing.T) {
	client := testClient(t)
	ctx := context.Background()
	key := Key("test-asset", "test-version", "roundtrip.txt", "fixedsuffix")
	t.Cleanup(func() { _ = client.RemoveObject(ctx, key) })

	uploadURL, err := client.PresignedUploadURL(ctx, key)
	if err != nil {
		t.Fatalf("PresignedUploadURL() error = %v", err)
	}

	payload := []byte("hello from TestPresignedUploadThenDownloadRoundTrip")
	req, err := http.NewRequest(http.MethodPut, uploadURL.String(), bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("build PUT request: %v", err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("PUT upload: %v", err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("PUT upload status = %d, want 200", res.StatusCode)
	}

	downloadURL, err := client.PresignedDownloadURL(ctx, key)
	if err != nil {
		t.Fatalf("PresignedDownloadURL() error = %v", err)
	}
	res, err = http.Get(downloadURL.String())
	if err != nil {
		t.Fatalf("GET download: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("GET download status = %d, want 200", res.StatusCode)
	}
	got, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("read download body: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Errorf("downloaded content = %q, want %q", got, payload)
	}
}

func TestRemoveObjectMakesSubsequentDownloadFail(t *testing.T) {
	client := testClient(t)
	ctx := context.Background()
	key := Key("test-asset", "test-version", "to-delete.txt", "fixedsuffix2")

	uploadURL, err := client.PresignedUploadURL(ctx, key)
	if err != nil {
		t.Fatalf("PresignedUploadURL() error = %v", err)
	}
	req, _ := http.NewRequest(http.MethodPut, uploadURL.String(), bytes.NewReader([]byte("x")))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("PUT upload: %v", err)
	}
	res.Body.Close()

	if err := client.RemoveObject(ctx, key); err != nil {
		t.Fatalf("RemoveObject() error = %v", err)
	}

	downloadURL, err := client.PresignedDownloadURL(ctx, key)
	if err != nil {
		t.Fatalf("PresignedDownloadURL() error = %v", err)
	}
	res, err = http.Get(downloadURL.String())
	if err != nil {
		t.Fatalf("GET download: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusOK {
		t.Error("GET download after RemoveObject() = 200, want a not-found status (object should be gone)")
	}
}

func TestURIForAndKeyFromURIRoundTrip(t *testing.T) {
	client := testClient(t)
	key := Key("asset-1", "version-1", "master.mov", "abc123")

	uri := client.URIFor(key)
	gotKey, err := KeyFromURI(client.Bucket(), uri)
	if err != nil {
		t.Fatalf("KeyFromURI() error = %v", err)
	}
	if gotKey != key {
		t.Errorf("KeyFromURI(URIFor(%q)) = %q, want %q", key, gotKey, key)
	}
}

func TestKeyFromURIRejectsWrongBucket(t *testing.T) {
	if _, err := KeyFromURI("real-bucket", "s3://different-bucket/some/key"); err == nil {
		t.Error("KeyFromURI() with mismatched bucket: want error, got nil")
	}
}

// TestPresignedUploadURLExpiryIsSet — kein Endlos-gültiger Link.
func TestPresignedUploadURLExpiryIsSet(t *testing.T) {
	if DefaultPresignExpiry <= 0 || DefaultPresignExpiry > time.Hour {
		t.Errorf("DefaultPresignExpiry = %v, want a short, positive duration (not unbounded)", DefaultPresignExpiry)
	}
}
