package asset

import (
	"database/sql"
	"errors"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
)

// testDB liefert eine migrierte, isolierte Testdatenbank — niemals die
// echte Dev-Postgres (dbtest.Open, docs/decisions.md Nachtrag 128).
// assets cascadiert nach asset_versions (ON DELETE CASCADE) und
// asset_versions nach representations — ein DELETE reicht.
func testDB(t *testing.T) *sql.DB {
	t.Helper()
	database := dbtest.Open(t)
	cleanup := func() {
		if _, err := database.Exec(`DELETE FROM assets`); err != nil {
			t.Fatalf("cleanup assets: %v", err)
		}
	}
	cleanup()
	t.Cleanup(cleanup)
	return database
}

func TestAssetCreateGetList(t *testing.T) {
	s := NewStore(testDB(t))

	a, err := s.CreateAsset("VIDEO", "Interview Master", "desc", "alice", "")
	if err != nil {
		t.Fatalf("CreateAsset() error = %v", err)
	}
	if a.ID == "" || a.Status != StatusIngesting || a.RowVersion != 1 {
		t.Fatalf("CreateAsset() = %+v, want non-empty ID, status=ingesting, rowVersion=1", a)
	}
	if a.CurrentVersionID != "" {
		t.Errorf("CreateAsset() currentVersionId = %q, want empty (no version yet)", a.CurrentVersionID)
	}

	got, err := s.GetAsset(a.ID)
	if err != nil {
		t.Fatalf("GetAsset() error = %v", err)
	}
	if got.Type != "VIDEO" || got.Title != "Interview Master" {
		t.Errorf("GetAsset() = %+v, unexpected", got)
	}

	list, err := s.ListAssets(AssetFilter{Type: "VIDEO"})
	if err != nil {
		t.Fatalf("ListAssets() error = %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("ListAssets(type=VIDEO) = %d entries, want 1", len(list))
	}

	none, err := s.ListAssets(AssetFilter{Type: "AUDIO"})
	if err != nil {
		t.Fatalf("ListAssets() error = %v", err)
	}
	if len(none) != 0 {
		t.Fatalf("ListAssets(type=AUDIO) = %d entries, want 0", len(none))
	}
}

func TestAssetGetUnknownReturnsNotFound(t *testing.T) {
	s := NewStore(testDB(t))
	if _, err := s.GetAsset("does-not-exist"); err != ErrNotFound {
		t.Fatalf("GetAsset() error = %v, want ErrNotFound", err)
	}
}

func TestAssetLifecycleTransitionsAndOptimisticConcurrency(t *testing.T) {
	s := NewStore(testDB(t))
	a, err := s.CreateAsset("VIDEO", "Clip", "", "alice", "")
	if err != nil {
		t.Fatalf("CreateAsset() error = %v", err)
	}

	// Invalider Übergang: ingesting direkt nach published.
	if _, err := s.UpdateAssetStatus(a.ID, a.RowVersion, StatusPublished, "alice"); err == nil {
		t.Fatalf("UpdateAssetStatus(ingesting->published) error = nil, want error")
	}

	registered, err := s.UpdateAssetStatus(a.ID, a.RowVersion, StatusRegistered, "alice")
	if err != nil {
		t.Fatalf("UpdateAssetStatus(ingesting->registered) error = %v", err)
	}
	if registered.RowVersion != a.RowVersion+1 {
		t.Errorf("UpdateAssetStatus() rowVersion = %d, want %d", registered.RowVersion, a.RowVersion+1)
	}

	// CAS-Konflikt: veralteter RowVersion wird abgelehnt.
	if _, err := s.UpdateAssetStatus(a.ID, a.RowVersion, StatusProcessing, "alice"); err != ErrConcurrentModification {
		t.Fatalf("UpdateAssetStatus() with stale rowVersion error = %v, want ErrConcurrentModification", err)
	}

	processing, err := s.UpdateAssetStatus(a.ID, registered.RowVersion, StatusProcessing, "alice")
	if err != nil {
		t.Fatalf("UpdateAssetStatus(registered->processing) error = %v", err)
	}
	ready, err := s.UpdateAssetStatus(a.ID, processing.RowVersion, StatusReady, "alice")
	if err != nil {
		t.Fatalf("UpdateAssetStatus(processing->ready) error = %v", err)
	}

	// Delete ist aus jedem nicht-gelöschten Zustand erlaubt.
	deleted, err := s.UpdateAssetStatus(a.ID, ready.RowVersion, StatusDeleted, "alice")
	if err != nil {
		t.Fatalf("UpdateAssetStatus(ready->deleted) error = %v", err)
	}
	if deleted.Status != StatusDeleted {
		t.Errorf("UpdateAssetStatus() status = %s, want deleted", deleted.Status)
	}
}

func TestAssetMetadataUpdate(t *testing.T) {
	s := NewStore(testDB(t))
	a, err := s.CreateAsset("IMAGE", "Poster", "", "alice", "")
	if err != nil {
		t.Fatalf("CreateAsset() error = %v", err)
	}

	updated, err := s.UpdateAssetMetadata(a.ID, a.RowVersion, Metadata{
		Descriptive: map[string]any{"title": "Season Poster"},
		Technical:   map[string]any{"codec": "png"},
	}, "alice")
	if err != nil {
		t.Fatalf("UpdateAssetMetadata() error = %v", err)
	}
	if updated.Metadata.Descriptive["title"] != "Season Poster" {
		t.Errorf("UpdateAssetMetadata() descriptive.title = %v, want 'Season Poster'", updated.Metadata.Descriptive["title"])
	}
	if updated.Metadata.Technical["codec"] != "png" {
		t.Errorf("UpdateAssetMetadata() technical.codec = %v, want 'png'", updated.Metadata.Technical["codec"])
	}

	got, err := s.GetAsset(a.ID)
	if err != nil {
		t.Fatalf("GetAsset() error = %v", err)
	}
	if got.Metadata.Descriptive["title"] != "Season Poster" {
		t.Errorf("GetAsset() after metadata update = %+v, metadata not persisted", got.Metadata)
	}
}

func TestVersionCreateAutoIncrementsAndPublishSetsCurrentVersion(t *testing.T) {
	s := NewStore(testDB(t))
	a, err := s.CreateAsset("VIDEO", "Interview", "", "alice", "")
	if err != nil {
		t.Fatalf("CreateAsset() error = %v", err)
	}

	v1, err := s.CreateVersion(a.ID, "", "initial ingest", "alice")
	if err != nil {
		t.Fatalf("CreateVersion() error = %v", err)
	}
	if v1.VersionNumber != 1 || v1.Status != VersionStatusDraft {
		t.Errorf("CreateVersion() = %+v, want versionNumber=1 status=draft", v1)
	}

	v2, err := s.CreateVersion(a.ID, v1.ID, "re-edit", "alice")
	if err != nil {
		t.Fatalf("CreateVersion() (2nd) error = %v", err)
	}
	if v2.VersionNumber != 2 || v2.ParentVersionID != v1.ID {
		t.Errorf("CreateVersion() (2nd) = %+v, want versionNumber=2 parentVersionId=%s", v2, v1.ID)
	}

	if _, err := s.CreateVersion("does-not-exist", "", "", "alice"); err != ErrNotFound {
		t.Fatalf("CreateVersion() for unknown asset error = %v, want ErrNotFound", err)
	}

	// Vor jedem Publish: current_version_id ist noch leer.
	before, err := s.GetAsset(a.ID)
	if err != nil {
		t.Fatalf("GetAsset() error = %v", err)
	}
	if before.CurrentVersionID != "" {
		t.Fatalf("GetAsset() currentVersionId = %q before any publish, want empty", before.CurrentVersionID)
	}

	published, err := s.PublishVersion(v1.ID)
	if err != nil {
		t.Fatalf("PublishVersion() error = %v", err)
	}
	if published.Status != VersionStatusPublished {
		t.Errorf("PublishVersion() status = %s, want published", published.Status)
	}

	afterPublish, err := s.GetAsset(a.ID)
	if err != nil {
		t.Fatalf("GetAsset() error = %v", err)
	}
	if afterPublish.CurrentVersionID != v1.ID {
		t.Errorf("GetAsset() currentVersionId = %q after publishing v1, want %s", afterPublish.CurrentVersionID, v1.ID)
	}

	// Unveränderlich: ein zweites Publish derselben Version scheitert.
	if _, err := s.PublishVersion(v1.ID); err == nil {
		t.Fatalf("PublishVersion() twice error = nil, want error (published versions are immutable)")
	}

	// Publish von v2 verschiebt current_version_id weiter.
	if _, err := s.PublishVersion(v2.ID); err != nil {
		t.Fatalf("PublishVersion() (v2) error = %v", err)
	}
	afterSecondPublish, err := s.GetAsset(a.ID)
	if err != nil {
		t.Fatalf("GetAsset() error = %v", err)
	}
	if afterSecondPublish.CurrentVersionID != v2.ID {
		t.Errorf("GetAsset() currentVersionId = %q after publishing v2, want %s", afterSecondPublish.CurrentVersionID, v2.ID)
	}

	list, err := s.ListVersions(a.ID)
	if err != nil {
		t.Fatalf("ListVersions() error = %v", err)
	}
	if len(list) != 2 || list[0].VersionNumber != 2 {
		t.Fatalf("ListVersions() = %+v, want 2 entries, newest (v2) first", list)
	}
}

func TestArchiveVersion(t *testing.T) {
	s := NewStore(testDB(t))
	a, _ := s.CreateAsset("VIDEO", "Clip", "", "alice", "")
	v, err := s.CreateVersion(a.ID, "", "", "alice")
	if err != nil {
		t.Fatalf("CreateVersion() error = %v", err)
	}

	archived, err := s.ArchiveVersion(v.ID)
	if err != nil {
		t.Fatalf("ArchiveVersion() error = %v", err)
	}
	if archived.Status != VersionStatusArchived {
		t.Errorf("ArchiveVersion() status = %s, want archived", archived.Status)
	}

	if _, err := s.ArchiveVersion(v.ID); err == nil {
		t.Fatalf("ArchiveVersion() twice error = nil, want error")
	}
}

func TestRepresentationCreateListDelete(t *testing.T) {
	s := NewStore(testDB(t))
	a, _ := s.CreateAsset("VIDEO", "Clip", "", "alice", "")
	v, err := s.CreateVersion(a.ID, "", "", "alice")
	if err != nil {
		t.Fatalf("CreateVersion() error = %v", err)
	}

	width, height := 1920, 1080
	frameRate := 25.0
	bitrate := int64(8_000_000)

	rep, err := s.CreateRepresentation(Representation{
		AssetVersionID: v.ID,
		Type:           "master",
		Storage:        StorageLocation{Provider: "filesystem", URI: "/media/clip.mov"},
		Format:         "mov",
		Codec:          "prores",
		Width:          &width,
		Height:         &height,
		FrameRate:      &frameRate,
		Bitrate:        &bitrate,
	})
	if err != nil {
		t.Fatalf("CreateRepresentation() error = %v", err)
	}
	if rep.ID == "" {
		t.Fatalf("CreateRepresentation() = %+v, want non-empty ID", rep)
	}

	got, err := s.GetRepresentation(rep.ID)
	if err != nil {
		t.Fatalf("GetRepresentation() error = %v", err)
	}
	if got.Width == nil || *got.Width != 1920 || got.Height == nil || *got.Height != 1080 {
		t.Errorf("GetRepresentation() width/height = %v/%v, want 1920/1080", got.Width, got.Height)
	}
	if got.FrameRate == nil || *got.FrameRate != 25.0 {
		t.Errorf("GetRepresentation() frameRate = %v, want 25.0", got.FrameRate)
	}
	if got.SampleRate != nil {
		t.Errorf("GetRepresentation() sampleRate = %v, want nil (not set for video master)", got.SampleRate)
	}
	if got.Storage.Provider != "filesystem" || got.Storage.URI != "/media/clip.mov" {
		t.Errorf("GetRepresentation() storage = %+v, unexpected", got.Storage)
	}

	proxy, err := s.CreateRepresentation(Representation{
		AssetVersionID: v.ID,
		Type:           "proxy",
		Storage:        StorageLocation{Provider: "filesystem", URI: "/media/clip_proxy.mp4"},
	})
	if err != nil {
		t.Fatalf("CreateRepresentation() (proxy) error = %v", err)
	}

	list, err := s.ListRepresentations(v.ID)
	if err != nil {
		t.Fatalf("ListRepresentations() error = %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("ListRepresentations() = %d entries, want 2", len(list))
	}

	if err := s.DeleteRepresentation(proxy.ID); err != nil {
		t.Fatalf("DeleteRepresentation() error = %v", err)
	}
	list, err = s.ListRepresentations(v.ID)
	if err != nil {
		t.Fatalf("ListRepresentations() error = %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("ListRepresentations() after delete = %d entries, want 1", len(list))
	}

	// Idempotent: ein zweites Delete derselben ID ist kein Fehler.
	if err := s.DeleteRepresentation(proxy.ID); err != nil {
		t.Fatalf("DeleteRepresentation() (2nd, already gone) error = %v, want nil", err)
	}
}

func TestCreateRepresentationRequiresStorage(t *testing.T) {
	s := NewStore(testDB(t))
	a, _ := s.CreateAsset("VIDEO", "Clip", "", "alice", "")
	v, _ := s.CreateVersion(a.ID, "", "", "alice")

	_, err := s.CreateRepresentation(Representation{AssetVersionID: v.ID, Type: "master"})
	if !errors.Is(err, ErrValidation) {
		t.Fatalf("CreateRepresentation() without storage error = %v, want errors.Is(err, ErrValidation)", err)
	}
}

// TestCreateAssetMissingFieldsIsErrValidation (Phase 5 Teil 3): die
// HTTP-API verlässt sich auf errors.Is(err, ErrValidation), um 400
// statt 500 zu melden.
func TestCreateAssetMissingFieldsIsErrValidation(t *testing.T) {
	s := NewStore(testDB(t))
	_, err := s.CreateAsset("", "", "", "alice", "")
	if !errors.Is(err, ErrValidation) {
		t.Fatalf("CreateAsset() error = %v, want errors.Is(err, ErrValidation)", err)
	}
}

// B3: "Eine veröffentlichte Version darf nicht still verändert werden" —
// Representations sind nur an Drafts änderbar.
func TestRepresentationsImmutableOncePublished(t *testing.T) {
	s := NewStore(testDB(t))
	a, _ := s.CreateAsset("VIDEO", "Clip", "", "alice", "")
	v, _ := s.CreateVersion(a.ID, "", "", "alice")
	master, err := s.CreateRepresentation(Representation{AssetVersionID: v.ID, Type: "master", Storage: StorageLocation{Provider: "filesystem", URI: "/m.mov"}})
	if err != nil {
		t.Fatalf("CreateRepresentation() on draft error = %v", err)
	}
	if _, err := s.PublishVersion(v.ID); err != nil {
		t.Fatalf("PublishVersion() error = %v", err)
	}

	_, err = s.CreateRepresentation(Representation{AssetVersionID: v.ID, Type: "proxy", Storage: StorageLocation{Provider: "filesystem", URI: "/p.mp4"}})
	if !errors.Is(err, ErrVersionImmutable) {
		t.Fatalf("CreateRepresentation() on published error = %v, want ErrVersionImmutable", err)
	}
	if err := s.DeleteRepresentation(master.ID); !errors.Is(err, ErrVersionImmutable) {
		t.Fatalf("DeleteRepresentation() on published error = %v, want ErrVersionImmutable", err)
	}
	list, _ := s.ListRepresentations(v.ID)
	if len(list) != 1 || list[0].ID != master.ID {
		t.Fatalf("representations of published version changed: %+v", list)
	}

	if _, err := s.ArchiveVersion(v.ID); err != nil {
		t.Fatalf("ArchiveVersion() error = %v", err)
	}
	if err := s.DeleteRepresentation(master.ID); !errors.Is(err, ErrVersionImmutable) {
		t.Fatalf("DeleteRepresentation() on archived error = %v, want ErrVersionImmutable", err)
	}
}

func TestCreateRepresentationUnknownVersionIsNotFound(t *testing.T) {
	s := NewStore(testDB(t))
	_, err := s.CreateRepresentation(Representation{AssetVersionID: "nope", Type: "master", Storage: StorageLocation{Provider: "filesystem", URI: "/m.mov"}})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("CreateRepresentation() unknown version error = %v, want ErrNotFound", err)
	}
}
