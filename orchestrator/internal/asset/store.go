package asset

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/outbox"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/tracing"
)

// ErrNotFound wird geliefert, wenn keine Zeile mit der gegebenen ID
// existiert (gleiche Konvention wie process.ErrNotFound/workflows.ErrNotFound).
var ErrNotFound = errors.New("asset: not found")

// ErrConcurrentModification — s. process.ErrConcurrentModification
// (identisches CAS-Muster auf row_version).
var ErrConcurrentModification = errors.New("asset: concurrent modification")

// ErrValidation kennzeichnet fehlerhafte AUFRUFER-Eingaben (fehlende
// Pflichtfelder) — per errors.Is von einem internen/DB-Fehler
// unterscheidbar, Grundlage für die HTTP-API (Phase 5 Teil 3): so
// eingeordnete Fehler werden dort als 400 statt 500 gemeldet, gleiche
// Konvention wie process.ErrValidation.
var ErrValidation = errors.New("asset: validation failed")

// ErrVersionImmutable: Representation-Änderung (Anlegen/Löschen) an
// einer nicht mehr im Draft befindlichen AssetVersion. B3 wörtlich:
// "Eine veröffentlichte Version darf nicht still verändert werden" —
// neue/andere Representations brauchen eine neue Version.
var ErrVersionImmutable = errors.New("asset: version is not a draft, representations are immutable")

// Store persistiert die Asset-Domäne in Postgres
// (db/migrations/0019_assets.sql). outbox ist optional (nil-sicher,
// gleiches Muster wie process.EventPublisher) — gesetzt, veröffentlicht
// jede Lifecycle-relevante Methode ihr Domain-Event ATOMAR in derselben
// Transaktion wie den State-Change (B9, Kapitel 21 Phase 4 Teil 1,
// UMSETZUNG.md §6b/21.4 Punkt 4 — Outbox+JetStream, vom Nutzer
// entschieden). Ohne outbox (z. B. in älteren Tests) verhalten sich
// alle Methoden exakt wie vor dieser Änderung.
type Store struct {
	db     *sql.DB
	outbox *outbox.Store
}

// StoreOption konfiguriert einen neuen Store.
type StoreOption func(*Store)

// WithOutbox aktiviert das Veröffentlichen von Domain-Events (B9) für
// diesen Store.
func WithOutbox(ob *outbox.Store) StoreOption {
	return func(s *Store) { s.outbox = ob }
}

// NewStore erstellt einen Store auf der gegebenen, bereits migrierten
// Datenbankverbindung.
func NewStore(database *sql.DB, opts ...StoreOption) *Store {
	s := &Store{db: database}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// eventSubject baut den Outbox-Subject für ein Asset-Domain-Event —
// "omp.asset.<id>.<event>", dieselbe Konvention wie
// process.publishExecutionEvent ("omp.process.<id>.<status>"), damit
// beide Domänen über denselben Subject-Namensraum konsistent
// durchsuchbar/abonnierbar bleiben.
func eventSubject(assetID, event string) string {
	return "omp.asset." + assetID + "." + event
}

// enqueueEvent veröffentlicht ein Asset-Domain-Event innerhalb der
// gegebenen Transaktion — no-op (kein Fehler), wenn kein outbox.Store
// konfiguriert ist (s. Store-Doku).
func (s *Store) enqueueEvent(tx *sql.Tx, assetID, event string, payload any) error {
	if s.outbox == nil {
		return nil
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("asset: marshal event payload: %w", err)
	}
	_, err = s.outbox.Enqueue(tx, eventSubject(assetID, event), raw, "")
	return err
}

func newID() (string, error) {
	id := tracing.NewID()
	if id == "" {
		return "", fmt.Errorf("asset: id generation failed")
	}
	return id, nil
}

// ---- Asset -----------------------------------------------

func marshalMetadata(m Metadata) ([]byte, error) {
	return json.Marshal(m)
}

func unmarshalMetadata(raw []byte) (Metadata, error) {
	var m Metadata
	if len(raw) == 0 {
		return m, nil
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return Metadata{}, err
	}
	return m, nil
}

func scanAsset(row interface{ Scan(...any) error }) (Asset, error) {
	var a Asset
	var currentVersionID sql.NullString
	var metadataRaw []byte
	err := row.Scan(&a.ID, &a.Type, &a.Title, &a.Description, &a.Status, &currentVersionID,
		&metadataRaw, &a.CreatedBy, &a.UpdatedBy, &a.RowVersion, &a.CreatedAt, &a.UpdatedAt)
	if err != nil {
		return Asset{}, err
	}
	a.CurrentVersionID = currentVersionID.String
	metadata, err := unmarshalMetadata(metadataRaw)
	if err != nil {
		return Asset{}, fmt.Errorf("asset: decode metadata: %w", err)
	}
	a.Metadata = metadata
	return a, nil
}

const assetSelectColumns = `id, type, title, description, status, current_version_id, metadata, created_by, updated_by, row_version, created_at, updated_at`

// CreateAsset legt ein neues Asset im Status "ingesting" an (B8: Start
// des Lifecycles), ohne current_version_id (die erste AssetVersion muss
// erst angelegt und veröffentlicht werden, s. PublishVersion).
func (s *Store) CreateAsset(assetType, title, description, createdBy string) (Asset, error) {
	if assetType == "" || title == "" {
		return Asset{}, fmt.Errorf("%w: type and title are required", ErrValidation)
	}
	id, err := newID()
	if err != nil {
		return Asset{}, err
	}
	metadataRaw, err := marshalMetadata(Metadata{})
	if err != nil {
		return Asset{}, err
	}
	now := time.Now().UTC()
	a := Asset{
		ID: id, Type: assetType, Title: title, Description: description,
		Status: StatusIngesting, CreatedBy: createdBy, UpdatedBy: createdBy,
		RowVersion: 1, CreatedAt: now, UpdatedAt: now,
	}

	ctx := context.Background()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Asset{}, err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO assets (id, type, title, description, status, current_version_id, metadata, created_by, updated_by, row_version, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, 1, $9, $9)
	`, a.ID, a.Type, a.Title, a.Description, a.Status, metadataRaw, a.CreatedBy, a.UpdatedBy, a.CreatedAt); err != nil {
		return Asset{}, err
	}
	if err := s.enqueueEvent(tx, a.ID, "created", a); err != nil {
		return Asset{}, err
	}
	if err := tx.Commit(); err != nil {
		return Asset{}, err
	}
	return a, nil
}

// GetAsset liest ein einzelnes Asset.
func (s *Store) GetAsset(id string) (Asset, error) {
	row := s.db.QueryRow(`SELECT `+assetSelectColumns+` FROM assets WHERE id = $1`, id)
	a, err := scanAsset(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Asset{}, ErrNotFound
	}
	return a, err
}

// AssetFilter grenzt ListAssets ein — jedes nicht-leere Feld ist ein
// zusätzliches UND-Kriterium (gleiches Muster wie process.ExecutionFilter).
type AssetFilter struct {
	Type   string
	Status string
}

// ListAssets liefert Assets nach Filter, neueste zuerst.
func (s *Store) ListAssets(f AssetFilter) ([]Asset, error) {
	query := `SELECT ` + assetSelectColumns + ` FROM assets WHERE 1=1`
	var args []any
	add := func(col, val string) {
		if val == "" {
			return
		}
		args = append(args, val)
		query += fmt.Sprintf(" AND %s = $%d", col, len(args))
	}
	add("type", f.Type)
	add("status", f.Status)
	query += " ORDER BY created_at DESC"

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Asset{}
	for rows.Next() {
		a, err := scanAsset(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// UpdateAssetStatus validiert den Übergang (LifecycleTransitions) und
// schreibt ihn per CAS auf row_version (A3-Äquivalent für Assets) —
// veröffentlicht dabei atomar das zugehörige Domain-Event
// ("omp.asset.<id>.<newStatus>", B9), wenn ein outbox.Store konfiguriert
// ist.
func (s *Store) UpdateAssetStatus(id string, expectedRowVersion int, newStatus, updatedBy string) (Asset, error) {
	current, err := s.GetAsset(id)
	if err != nil {
		return Asset{}, err
	}
	if err := LifecycleTransitions.Validate(current.Status, newStatus); err != nil {
		return Asset{}, err
	}

	ctx := context.Background()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Asset{}, err
	}
	defer func() { _ = tx.Rollback() }()

	res, err := tx.ExecContext(ctx, `
		UPDATE assets SET status = $3, updated_by = $4, row_version = row_version + 1, updated_at = now()
		WHERE id = $1 AND row_version = $2
	`, id, expectedRowVersion, newStatus, updatedBy)
	if err != nil {
		return Asset{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Asset{}, ErrConcurrentModification
	}
	if err := s.enqueueEvent(tx, id, newStatus, map[string]string{"assetId": id, "status": newStatus, "updatedBy": updatedBy}); err != nil {
		return Asset{}, err
	}
	if err := tx.Commit(); err != nil {
		return Asset{}, err
	}
	return s.GetAsset(id)
}

// UpdateAssetMetadata ersetzt den kompletten Metadata-Block (CAS wie
// UpdateAssetStatus) — kein partielles Merge je Kategorie in dieser
// Phase (kein Aufrufer bräuchte es heute, B7/Schema-Validierung ist
// ohnehin zurückgestellt, s. Moduldoku). Veröffentlicht atomar
// "omp.asset.<id>.metadata_updated" (B9: "AssetMetadataUpdated").
func (s *Store) UpdateAssetMetadata(id string, expectedRowVersion int, metadata Metadata, updatedBy string) (Asset, error) {
	raw, err := marshalMetadata(metadata)
	if err != nil {
		return Asset{}, err
	}

	ctx := context.Background()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Asset{}, err
	}
	defer func() { _ = tx.Rollback() }()

	res, err := tx.ExecContext(ctx, `
		UPDATE assets SET metadata = $3, updated_by = $4, row_version = row_version + 1, updated_at = now()
		WHERE id = $1 AND row_version = $2
	`, id, expectedRowVersion, raw, updatedBy)
	if err != nil {
		return Asset{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Asset{}, ErrConcurrentModification
	}
	if err := s.enqueueEvent(tx, id, "metadata_updated", map[string]string{"assetId": id, "updatedBy": updatedBy}); err != nil {
		return Asset{}, err
	}
	if err := tx.Commit(); err != nil {
		return Asset{}, err
	}
	return s.GetAsset(id)
}

// ---- AssetVersion -----------------------------------------------

func scanVersion(row interface{ Scan(...any) error }) (AssetVersion, error) {
	var v AssetVersion
	var parentVersionID sql.NullString
	err := row.Scan(&v.ID, &v.AssetID, &v.VersionNumber, &parentVersionID, &v.Status, &v.ChangeReason, &v.CreatedBy, &v.CreatedAt)
	if err != nil {
		return AssetVersion{}, err
	}
	v.ParentVersionID = parentVersionID.String
	return v, nil
}

const versionSelectColumns = `id, asset_id, version_number, parent_version_id, status, change_reason, created_by, created_at`

// CreateVersion legt eine neue, draft-Version für ein Asset an —
// version_number ist die nächste freie Nummer, atomar bestimmt über
// eine `SELECT … FOR UPDATE` auf die assets-Zeile (gleiches Muster wie
// process.Store.CreateVersion).
func (s *Store) CreateVersion(assetID, parentVersionID, changeReason, createdBy string) (AssetVersion, error) {
	ctx := context.Background()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return AssetVersion{}, err
	}
	defer func() { _ = tx.Rollback() }()

	var exists string
	if err := tx.QueryRowContext(ctx, `SELECT id FROM assets WHERE id = $1 FOR UPDATE`, assetID).Scan(&exists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return AssetVersion{}, ErrNotFound
		}
		return AssetVersion{}, err
	}

	var nextVersion int
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(version_number), 0) + 1 FROM asset_versions WHERE asset_id = $1`, assetID).Scan(&nextVersion); err != nil {
		return AssetVersion{}, err
	}

	id, err := newID()
	if err != nil {
		return AssetVersion{}, err
	}
	v := AssetVersion{
		ID: id, AssetID: assetID, VersionNumber: nextVersion, ParentVersionID: parentVersionID,
		Status: VersionStatusDraft, ChangeReason: changeReason, CreatedBy: createdBy, CreatedAt: time.Now().UTC(),
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO asset_versions (id, asset_id, version_number, parent_version_id, status, change_reason, created_by, created_at)
		VALUES ($1, $2, $3, NULLIF($4, ''), $5, $6, $7, $8)
	`, v.ID, v.AssetID, v.VersionNumber, v.ParentVersionID, v.Status, v.ChangeReason, v.CreatedBy, v.CreatedAt); err != nil {
		return AssetVersion{}, err
	}
	if err := s.enqueueEvent(tx, assetID, "version_created", v); err != nil {
		return AssetVersion{}, err
	}

	if err := tx.Commit(); err != nil {
		return AssetVersion{}, err
	}
	return v, nil
}

// GetVersion liest eine einzelne AssetVersion.
func (s *Store) GetVersion(id string) (AssetVersion, error) {
	row := s.db.QueryRow(`SELECT `+versionSelectColumns+` FROM asset_versions WHERE id = $1`, id)
	v, err := scanVersion(row)
	if errors.Is(err, sql.ErrNoRows) {
		return AssetVersion{}, ErrNotFound
	}
	return v, err
}

// ListVersions liefert alle Versionen eines Assets, neueste zuerst.
func (s *Store) ListVersions(assetID string) ([]AssetVersion, error) {
	rows, err := s.db.Query(`SELECT `+versionSelectColumns+` FROM asset_versions WHERE asset_id = $1 ORDER BY version_number DESC`, assetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []AssetVersion{}
	for rows.Next() {
		v, err := scanVersion(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// PublishVersion macht eine Draft-Version unveränderlich (B3) und setzt
// sie zugleich als current_version_id des zugehörigen Assets — beides
// atomar in einer Transaktion (ein Leser darf nie eine "published"-
// Version sehen, die noch nicht die aktuelle Version ihres Assets ist,
// oder umgekehrt).
func (s *Store) PublishVersion(id string) (AssetVersion, error) {
	current, err := s.GetVersion(id)
	if err != nil {
		return AssetVersion{}, err
	}
	if err := VersionTransitions.Validate(current.Status, VersionStatusPublished); err != nil {
		return AssetVersion{}, err
	}

	ctx := context.Background()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return AssetVersion{}, err
	}
	defer func() { _ = tx.Rollback() }()

	res, err := tx.ExecContext(ctx, `UPDATE asset_versions SET status = $3 WHERE id = $1 AND status = $2`, id, current.Status, VersionStatusPublished)
	if err != nil {
		return AssetVersion{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return AssetVersion{}, ErrConcurrentModification
	}
	if _, err := tx.ExecContext(ctx, `UPDATE assets SET current_version_id = $2, row_version = row_version + 1, updated_at = now() WHERE id = $1`, current.AssetID, id); err != nil {
		return AssetVersion{}, err
	}
	if err := s.enqueueEvent(tx, current.AssetID, "version_published", map[string]any{"assetId": current.AssetID, "assetVersionId": id, "versionNumber": current.VersionNumber}); err != nil {
		return AssetVersion{}, err
	}
	if err := tx.Commit(); err != nil {
		return AssetVersion{}, err
	}
	return s.GetVersion(id)
}

// ArchiveVersion.
func (s *Store) ArchiveVersion(id string) (AssetVersion, error) {
	current, err := s.GetVersion(id)
	if err != nil {
		return AssetVersion{}, err
	}
	if err := VersionTransitions.Validate(current.Status, VersionStatusArchived); err != nil {
		return AssetVersion{}, err
	}
	res, err := s.db.Exec(`UPDATE asset_versions SET status = $3 WHERE id = $1 AND status = $2`, id, current.Status, VersionStatusArchived)
	if err != nil {
		return AssetVersion{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return AssetVersion{}, ErrConcurrentModification
	}
	return s.GetVersion(id)
}

// ---- Representation -----------------------------------------------

func scanRepresentation(row interface{ Scan(...any) error }) (Representation, error) {
	var r Representation
	var width, height, sampleRate, channels sql.NullInt64
	var frameRate sql.NullFloat64
	var bitrate, sizeBytes sql.NullInt64
	err := row.Scan(&r.ID, &r.AssetVersionID, &r.Type, &r.Storage.Provider, &r.Storage.URI,
		&r.Format, &r.Codec, &r.Container, &width, &height, &frameRate, &sampleRate, &channels,
		&bitrate, &sizeBytes, &r.Checksum, &r.CreatedAt)
	if err != nil {
		return Representation{}, err
	}
	if width.Valid {
		v := int(width.Int64)
		r.Width = &v
	}
	if height.Valid {
		v := int(height.Int64)
		r.Height = &v
	}
	if frameRate.Valid {
		v := frameRate.Float64
		r.FrameRate = &v
	}
	if sampleRate.Valid {
		v := int(sampleRate.Int64)
		r.SampleRate = &v
	}
	if channels.Valid {
		v := int(channels.Int64)
		r.Channels = &v
	}
	if bitrate.Valid {
		v := bitrate.Int64
		r.Bitrate = &v
	}
	if sizeBytes.Valid {
		v := sizeBytes.Int64
		r.SizeBytes = &v
	}
	return r, nil
}

const representationSelectColumns = `id, asset_version_id, type, storage_provider, uri, format, codec, container, width, height, frame_rate, sample_rate, channels, bitrate, size_bytes, checksum, created_at`

// CreateRepresentation legt eine neue Representation unter einer
// AssetVersion an. AssetVersionID/Type/Storage sind Pflichtfelder, alle
// technischen Felder optional (B4: "Nur tatsächlich relevante Felder
// verwenden" — nicht jede Representation hat z. B. eine Framerate).
func (s *Store) CreateRepresentation(r Representation) (Representation, error) {
	if r.AssetVersionID == "" || r.Type == "" || r.Storage.Provider == "" || r.Storage.URI == "" {
		return Representation{}, fmt.Errorf("%w: assetVersionId, type and storage (provider+uri) are required", ErrValidation)
	}
	id, err := newID()
	if err != nil {
		return Representation{}, err
	}
	r.ID = id
	r.CreatedAt = time.Now().UTC()

	ctx := context.Background()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Representation{}, err
	}
	defer func() { _ = tx.Rollback() }()
	if err := lockDraftVersion(ctx, tx, r.AssetVersionID); err != nil {
		return Representation{}, err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO representations (id, asset_version_id, type, storage_provider, uri, format, codec, container, width, height, frame_rate, sample_rate, channels, bitrate, size_bytes, checksum, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
	`, r.ID, r.AssetVersionID, r.Type, r.Storage.Provider, r.Storage.URI, r.Format, r.Codec, r.Container,
		r.Width, r.Height, r.FrameRate, r.SampleRate, r.Channels, r.Bitrate, r.SizeBytes, r.Checksum, r.CreatedAt)
	if err != nil {
		return Representation{}, err
	}
	if err := tx.Commit(); err != nil {
		return Representation{}, err
	}
	return r, nil
}

// lockDraftVersion sperrt die AssetVersion-Zeile (FOR UPDATE) und
// liefert ErrVersionImmutable, wenn sie kein Draft mehr ist (B3). Die
// Zeilensperre schließt das Rennen mit einem parallelen PublishVersion
// (dessen `UPDATE … WHERE status = 'draft'` wartet auf diese Sperre bzw.
// umgekehrt): eine Representation landet entweder noch VOR dem Publish
// in der Version oder wird danach abgelehnt — nie still hinterher.
func lockDraftVersion(ctx context.Context, tx *sql.Tx, versionID string) error {
	var status string
	err := tx.QueryRowContext(ctx, `SELECT status FROM asset_versions WHERE id = $1 FOR UPDATE`, versionID).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if status != VersionStatusDraft {
		return fmt.Errorf("%w (status %q)", ErrVersionImmutable, status)
	}
	return nil
}

// GetRepresentation liest eine einzelne Representation.
func (s *Store) GetRepresentation(id string) (Representation, error) {
	row := s.db.QueryRow(`SELECT `+representationSelectColumns+` FROM representations WHERE id = $1`, id)
	r, err := scanRepresentation(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Representation{}, ErrNotFound
	}
	return r, err
}

// ListRepresentations liefert alle Representations einer AssetVersion.
func (s *Store) ListRepresentations(assetVersionID string) ([]Representation, error) {
	rows, err := s.db.Query(`SELECT `+representationSelectColumns+` FROM representations WHERE asset_version_id = $1 ORDER BY created_at ASC`, assetVersionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Representation{}
	for rows.Next() {
		r, err := scanRepresentation(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// DeleteRepresentation entfernt eine Representation — idempotent, kein
// Fehler, wenn sie nicht (mehr) existiert (gleiches Muster wie
// workflows.Store.Delete).
func (s *Store) DeleteRepresentation(id string) error {
	ctx := context.Background()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var versionID string
	err = tx.QueryRowContext(ctx, `SELECT asset_version_id FROM representations WHERE id = $1`, id).Scan(&versionID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil // idempotent: schon weg
	}
	if err != nil {
		return err
	}
	if err := lockDraftVersion(ctx, tx, versionID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM representations WHERE id = $1`, id); err != nil {
		return err
	}
	return tx.Commit()
}
