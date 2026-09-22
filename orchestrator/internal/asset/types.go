// Package asset implementiert die Asset/Content-Domäne aus Kapitel 21
// (UMSETZUNG.md §6b), Phase 2 (Domain Model + Persistenz). Angesiedelt
// im Orchestrator statt in nodes/omp-media-library (vom Nutzer am
// 2026-09-22 bestätigte Entscheidung, §6b/21.2+21.4) — braucht
// Postgres/Audit/Tracing, die hier bereits leben, und muss von
// internal/process.ProcessExecution referenzierbar sein (B10, spätere
// Phase).
//
// Bewusst NUR Asset/AssetVersion/Representation/Metadata diese Runde —
// B1s volle Core-Content-Model-Liste (ContentObject/Collection/Sequence/
// Segment/Marker/Publication/Package) ist nicht Teil von Phase 2s
// eigener "Implementiere zuerst"-Liste, s. Moduldoku der Migration
// (0019_assets.sql).
package asset

import (
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/statemachine"
)

// Asset-Lifecycle-Status (B8, exakte Liste aus der Aufgabenstellung).
const (
	StatusIngesting  = "ingesting"
	StatusRegistered = "registered"
	StatusProcessing = "processing"
	StatusReady      = "ready"
	StatusInReview   = "in_review"
	StatusApproved   = "approved"
	StatusPublished  = "published"
	StatusArchived   = "archived"
	StatusExpired    = "expired"
	StatusDeleted    = "deleted"
)

// LifecycleTransitions ist der explizite Zustandsgraph eines Assets (B8:
// "nicht als verstreute if/else-Statements... explizites Lifecycle-/
// State-Machine-Konzept"). Neben dem Hauptpfad (ingesting -> … ->
// published) sind Reprocess-/Rework-Rückwege, ein genereller Expire- und
// ein genereller Delete-Übergang aus jedem nicht-gelöschten Zustand
// vorgesehen — Delete ist damit immer möglich (Administratives Löschen),
// Expire aus jedem Zustand außer dem allerersten (ein gerade erst
// eingehendes Asset kann nicht "ablaufen", bevor es überhaupt
// registriert ist).
var LifecycleTransitions = statemachine.New([][2]string{
	{StatusIngesting, StatusRegistered},
	{StatusRegistered, StatusProcessing},
	{StatusProcessing, StatusReady},
	{StatusProcessing, StatusRegistered}, // Verarbeitung fehlgeschlagen, erneuter Versuch
	{StatusReady, StatusInReview},
	{StatusReady, StatusProcessing}, // Reprocess (z. B. neue Proxy-Generierung)
	{StatusInReview, StatusApproved},
	{StatusInReview, StatusReady}, // abgelehnt, zurück zur Überarbeitung
	{StatusApproved, StatusPublished},
	{StatusApproved, StatusArchived},
	{StatusPublished, StatusArchived},
	{StatusReady, StatusArchived},
	{StatusArchived, StatusReady}, // Unarchivieren

	{StatusRegistered, StatusExpired},
	{StatusProcessing, StatusExpired},
	{StatusReady, StatusExpired},
	{StatusInReview, StatusExpired},
	{StatusApproved, StatusExpired},
	{StatusPublished, StatusExpired},
	{StatusArchived, StatusExpired},

	{StatusIngesting, StatusDeleted},
	{StatusRegistered, StatusDeleted},
	{StatusProcessing, StatusDeleted},
	{StatusReady, StatusDeleted},
	{StatusInReview, StatusDeleted},
	{StatusApproved, StatusDeleted},
	{StatusPublished, StatusDeleted},
	{StatusArchived, StatusDeleted},
	{StatusExpired, StatusDeleted},
})

// AssetVersion-Status (B3: "immutable published versions").
const (
	VersionStatusDraft     = "draft"
	VersionStatusPublished = "published"
	VersionStatusArchived  = "archived"
)

// VersionTransitions.
var VersionTransitions = statemachine.New([][2]string{
	{VersionStatusDraft, VersionStatusPublished},
	{VersionStatusDraft, VersionStatusArchived},
	{VersionStatusPublished, VersionStatusArchived},
})

// Metadata kategorisiert Schlüssel/Wert-Paare (B6: "Unterscheide
// mindestens: system/technical/descriptive/editorial/custom/AI
// metadata"). Jede Kategorie ist absichtlich ein freies
// map[string]any statt fester Felder — ein MetadataSchema/-Field/-Value-
// Modell mit Validierung (B7) ist bewusst NICHT Teil dieser Runde (kein
// Aufrufer bräuchte es heute, s. Moduldoku) — dieses flexible Modell
// deckt B6 vollständig ab, ohne ungenutzte Schema-Infrastruktur
// vorwegzunehmen.
type Metadata struct {
	System      map[string]any `json:"system,omitempty"`
	Technical   map[string]any `json:"technical,omitempty"`
	Descriptive map[string]any `json:"descriptive,omitempty"`
	Editorial   map[string]any `json:"editorial,omitempty"`
	Custom      map[string]any `json:"custom,omitempty"`
	AI          map[string]any `json:"ai,omitempty"`
}

// Asset (B2) — Felder exakt wie in der Aufgabenstellung aufgezählt
// (id/type/title/description/status/created_at/updated_at/created_by/
// updated_by/current_version/metadata/lifecycle), lifecycle == status
// hier (eine Spalte, kein separates Feld — Lifecycle IST der Status,
// s. LifecycleTransitions für die zugehörige Zustandsmaschine).
type Asset struct {
	ID               string    `json:"id"`
	Type             string    `json:"type"`
	Title            string    `json:"title"`
	Description      string    `json:"description,omitempty"`
	Status           string    `json:"status"`
	CurrentVersionID string    `json:"currentVersionId,omitempty"`
	Metadata         Metadata  `json:"metadata"`
	CreatedBy        string    `json:"createdBy"`
	UpdatedBy        string    `json:"updatedBy"`
	RowVersion       int       `json:"rowVersion"`
	CreatedAt        time.Time `json:"createdAt"`
	UpdatedAt        time.Time `json:"updatedAt"`
}

// AssetVersion (B3).
type AssetVersion struct {
	ID              string    `json:"id"`
	AssetID         string    `json:"assetId"`
	VersionNumber   int       `json:"versionNumber"`
	ParentVersionID string    `json:"parentVersionId,omitempty"`
	Status          string    `json:"status"`
	ChangeReason    string    `json:"changeReason,omitempty"`
	CreatedBy       string    `json:"createdBy"`
	CreatedAt       time.Time `json:"createdAt"`
}

// StorageLocation ist die minimale Storage-Abstraktion für diese Phase
// (B5: "Das Asset-Modell darf nicht direkt an einen einzelnen
// Storage-Anbieter gekoppelt sein"). Provider ist ein freier Bezeichner
// ("filesystem"/"s3"/"minio"/…, keine Go-Enum — dieselbe
// Erweiterbarkeits-Linie wie Asset.Type). Ein echtes StorageProvider-
// Interface (Read/Write/Delete) folgt erst, wenn eine erste konkrete
// Implementierung es braucht (Phase 4, Asset↔MXL/NMOS-Integration) —
// vorher wäre es eine Abstraktion ohne zweiten Aufrufer.
type StorageLocation struct {
	Provider string `json:"provider"`
	URI      string `json:"uri"`
}

// Representation (B4) — Feldliste exakt wie in der Aufgabenstellung,
// nullbare technische Felder (nicht jede Representation hat z. B. eine
// Framerate — ein Audio-Stem hat keine).
type Representation struct {
	ID             string          `json:"id"`
	AssetVersionID string          `json:"assetVersionId"`
	Type           string          `json:"type"`
	Storage        StorageLocation `json:"storage"`
	Format         string          `json:"format,omitempty"`
	Codec          string          `json:"codec,omitempty"`
	Container      string          `json:"container,omitempty"`
	Width          *int            `json:"width,omitempty"`
	Height         *int            `json:"height,omitempty"`
	FrameRate      *float64        `json:"frameRate,omitempty"`
	SampleRate     *int            `json:"sampleRate,omitempty"`
	Channels       *int            `json:"channels,omitempty"`
	Bitrate        *int64          `json:"bitrate,omitempty"`
	SizeBytes      *int64          `json:"sizeBytes,omitempty"`
	Checksum       string          `json:"checksum,omitempty"`
	CreatedAt      time.Time       `json:"createdAt"`
}
