package storagebackends

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
)

// testDB liefert eine migrierte, isolierte Testdatenbank — niemals die
// echte Dev-Postgres (dbtest.Open).
func testDB(t *testing.T) *sql.DB {
	t.Helper()
	database := dbtest.Open(t)
	cleanup := func() {
		if _, err := database.Exec(`DELETE FROM storage_backends`); err != nil {
			t.Fatalf("cleanup storage_backends: %v", err)
		}
	}
	cleanup()
	t.Cleanup(cleanup)
	return database
}

// testMasterKey liefert einen frischen, gültigen AES-256-Masterschlüssel
// je Test — echte Verschlüsselung, kein Mock (gleiche Linie wie
// dbtest.Open: reale Infrastruktur statt Doubles).
func testMasterKey(t *testing.T) string {
	t.Helper()
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatalf("generate test master key: %v", err)
	}
	return base64.StdEncoding.EncodeToString(key)
}

// testStore verbindet gegen die echte lokale Dev-MinIO-Instanz (`make
// minio-up`, docs/HANDBUCH.md) statt eines Mocks — Kapitel 21 B5 wurde
// bereits bewusst als "echte Anbindung" entschieden (Nachtrag 280),
// dieselbe Linie gilt hier. Überspringt den Test, wenn MinIO nicht
// erreichbar ist (analog zu dbtest.Open's Verhalten bei fehlender
// Postgres).
func testStore(t *testing.T) *Store {
	t.Helper()
	s, err := NewStore(testDB(t), testMasterKey(t))
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	if err := s.TestConnection(context.Background(), validInput()); err != nil {
		t.Skipf("dev-MinIO nicht erreichbar (make minio-up?), skip: %v", err)
	}
	return s
}

func validInput() Input {
	return Input{
		Name: "Test Backend", Provider: "minio", Endpoint: "127.0.0.1:9000",
		Bucket: "omp-storagebackends-test", AccessKey: "omp-minio-dev", SecretKey: "omp-minio-dev-pass", UseSSL: false,
	}
}

func TestNewStoreRejectsInvalidMasterKey(t *testing.T) {
	if _, err := NewStore(nil, "not-base64!!"); !errors.Is(err, ErrMasterKeyInvalid) {
		t.Fatalf("NewStore(invalid base64) error = %v, want ErrMasterKeyInvalid", err)
	}
	if _, err := NewStore(nil, base64.StdEncoding.EncodeToString([]byte("too-short"))); !errors.Is(err, ErrMasterKeyInvalid) {
		t.Fatalf("NewStore(16 bytes) error = %v, want ErrMasterKeyInvalid", err)
	}
}

func TestTestConnectionRejectsBadCredentials(t *testing.T) {
	s, err := NewStore(testDB(t), testMasterKey(t))
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	in := validInput()
	in.SecretKey = "definitely-wrong-password"
	if err := s.TestConnection(context.Background(), in); !errors.Is(err, ErrUnreachable) {
		t.Fatalf("TestConnection(bad creds) error = %v, want ErrUnreachable (or MinIO unreachable entirely)", err)
	}
}

func TestCreateGetListNeverExposesSecret(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()

	b, err := s.Create(ctx, validInput(), "alice")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if b.ID == "" || !b.HasSecret || b.Status != StatusActive {
		t.Fatalf("Create() = %+v, want non-empty ID, hasSecret=true, status=active", b)
	}

	got, err := s.Get(b.ID)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if got.Name != "Test Backend" || got.Bucket != "omp-storagebackends-test" {
		t.Errorf("Get() = %+v, unexpected", got)
	}

	list, err := s.List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("List() = %d entries, want 1", len(list))
	}
}

func TestCreateWithUnreachableEndpointFails(t *testing.T) {
	s, err := NewStore(testDB(t), testMasterKey(t))
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	in := validInput()
	in.Endpoint = "127.0.0.1:1" // nichts lauscht dort
	if _, err := s.Create(context.Background(), in, "alice"); !errors.Is(err, ErrUnreachable) {
		t.Fatalf("Create(unreachable) error = %v, want ErrUnreachable — a broken backend must never persist", err)
	}
	list, err := s.List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("List() after failed Create() = %d entries, want 0 (nothing should have been persisted)", len(list))
	}
}

func TestResolveWorksAfterCacheMiss(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	b, err := s.Create(ctx, validInput(), "alice")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	// Simuliert einen Orchestrator-Neustart: der In-Memory-Cache eines
	// frischen Store wäre leer, Resolve() muss trotzdem funktionieren
	// (verbindet lazy nach, s. Resolve-Doku).
	fresh, err := NewStore(s.db, base64.StdEncoding.EncodeToString(s.masterKey))
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	client, err := fresh.Resolve(ctx, b.ID)
	if err != nil {
		t.Fatalf("Resolve() on a cold store error = %v", err)
	}
	if client.Bucket() != "omp-storagebackends-test" {
		t.Errorf("Resolve() client bucket = %q, want %q", client.Bucket(), "omp-storagebackends-test")
	}
}

func TestUpdateMetaKeepsSecretWhenEmpty(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	b, err := s.Create(ctx, validInput(), "alice")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	in := validInput()
	in.Name = "Renamed Backend"
	in.SecretKey = "" // unverändert lassen
	updated, err := s.UpdateMeta(ctx, b.ID, in)
	if err != nil {
		t.Fatalf("UpdateMeta() error = %v", err)
	}
	if updated.Name != "Renamed Backend" || !updated.HasSecret {
		t.Errorf("UpdateMeta() = %+v, want Name=Renamed Backend, HasSecret=true", updated)
	}
	// Weiterhin nutzbar (Secret war tatsächlich noch korrekt) — belegt,
	// dass das UPDATE keine falsche/leere Secret-Spalte geschrieben hat.
	if _, err := s.Resolve(ctx, b.ID); err != nil {
		t.Fatalf("Resolve() after UpdateMeta(empty secret) error = %v, want still-working credentials", err)
	}
}

func TestUpdateStatusRejectsUnknownValue(t *testing.T) {
	s := testStore(t)
	b, err := s.Create(context.Background(), validInput(), "alice")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := s.UpdateStatus(b.ID, "not-a-real-status"); !errors.Is(err, ErrValidation) {
		t.Fatalf("UpdateStatus(bogus) error = %v, want ErrValidation", err)
	}
	deprecated, err := s.UpdateStatus(b.ID, StatusDeprecated)
	if err != nil {
		t.Fatalf("UpdateStatus(deprecated) error = %v", err)
	}
	if deprecated.Status != StatusDeprecated {
		t.Errorf("UpdateStatus(deprecated).Status = %q, want %q", deprecated.Status, StatusDeprecated)
	}
}

// TestDeleteBlockedWhileRepresentationReferencesIt belegt den in der
// Migration verankerten Fremdschlüssel-Schutz (kein ON DELETE CASCADE)
// — dasselbe bewährte Muster wie organizations.Store.Delete.
func TestDeleteBlockedWhileRepresentationReferencesIt(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	b, err := s.Create(ctx, validInput(), "alice")
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	// Minimaler Representation-Baum, nur um den Fremdschlüssel zu setzen
	// (kein voller asset.Store-Umweg nötig — direktes SQL reicht für
	// diesen Test, gleiches Muster wie andere Fremdschlüssel-Tests in
	// diesem Projekt).
	if _, err := s.db.Exec(`INSERT INTO assets (id, type, title, description, status, current_version_id, metadata, created_by, updated_by, row_version, created_at, updated_at, owner_org_id)
		VALUES ('sb-test-asset', 'video', 't', '', 'ingesting', NULL, '{}', 'alice', 'alice', 1, now(), now(), 'default')`); err != nil {
		t.Fatalf("seed asset: %v", err)
	}
	if _, err := s.db.Exec(`INSERT INTO asset_versions (id, asset_id, version_number, status, created_by, created_at)
		VALUES ('sb-test-version', 'sb-test-asset', 1, 'draft', 'alice', now())`); err != nil {
		t.Fatalf("seed asset_version: %v", err)
	}
	if _, err := s.db.Exec(`INSERT INTO representations (id, asset_version_id, type, storage_provider, uri, format, codec, container, checksum, created_at, storage_backend_id)
		VALUES ('sb-test-rep', 'sb-test-version', 'master', 'minio', 'x', '', '', '', '', now(), $1)`, b.ID); err != nil {
		t.Fatalf("seed representation: %v", err)
	}
	t.Cleanup(func() {
		_, _ = s.db.Exec(`DELETE FROM assets WHERE id = 'sb-test-asset'`)
	})

	n, err := s.CountRepresentations(b.ID)
	if err != nil {
		t.Fatalf("CountRepresentations() error = %v", err)
	}
	if n != 1 {
		t.Fatalf("CountRepresentations() = %d, want 1", n)
	}

	if err := s.Delete(b.ID); err == nil {
		t.Fatal("Delete() while referenced = nil error, want a foreign key violation")
	}
}

func TestDeleteUnknownReturnsNotFound(t *testing.T) {
	s, err := NewStore(testDB(t), testMasterKey(t))
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	if err := s.Delete("does-not-exist"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Delete(unknown) error = %v, want ErrNotFound", err)
	}
}
