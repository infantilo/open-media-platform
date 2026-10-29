package review

import (
	"encoding/json"
	"time"
)

// Zustände eines Eingangs-Assets im Review-Ablauf (Kapitel 43). Sie sind ein **Unterstatus** neben dem Asset-Lebenszyklus
// (`asset.Status*`), nicht dessen Ersatz: der Playout-Preflight (Kapitel 27 P8) liest weiter den Asset-Status.
const (
	StateAwaitingQC       = "awaiting_qc"        // registriert, QC noch nicht gestartet
	StateQCRunning        = "qc_running"         // QC läuft
	StateQCFailedToRun    = "qc_failed_to_run"   // QC konnte nicht ausgeführt werden (≠ „QC hat Fehler gefunden“)
	StateAwaitingReview   = "awaiting_review"    // QC fertig, wartet auf Bearbeiter
	StateInReview         = "in_review"          // von einem Bearbeiter übernommen
	StateConforming       = "conforming"         // Conform-Entwurf wird bearbeitet
	StateReadyForApproval = "ready_for_approval" // eingereicht
	StateApproved         = "approved"
	StateRejected         = "rejected" // abgelehnt / Nacharbeit
	StateArchived         = "archived"
)

// Conform-Revisionen: draft (veränderlich, genau einer je Asset) → submitted → approved | rejected (unveränderlich).
const (
	ConformDraft     = "draft"
	ConformSubmitted = "submitted"
	ConformApproved  = "approved"
	ConformRejected  = "rejected"
	ConformWithdrawn = "withdrawn"
)

// QC-Auftrag.
const (
	JobQueued    = "queued"
	JobRunning   = "running"
	JobDone      = "done"
	JobExecFail  = "execution_failed"
	JobCancelled = "cancelled"
)

// Prüfergebnis eines einzelnen Checks.
const (
	CheckPass         = "pass"
	CheckWarning      = "warning"
	CheckFail         = "fail"
	CheckNotEvaluated = "not_evaluated"
)

// Gesamtstatus eines Berichts. „incomplete“ heißt: Analyse lief, aber nicht alle Prüfungen waren auswertbar.
const (
	OverallPass       = "pass"
	OverallWarning    = "warning"
	OverallFail       = "fail"
	OverallIncomplete = "incomplete"
)

const (
	SevInfo     = "info"
	SevMinor    = "minor"
	SevMajor    = "major"
	SevCritical = "critical"
)

// Kategorien (Filter im Bericht).
const (
	CatContainer = "container"
	CatVideo     = "video"
	CatAudio     = "audio"
	CatSync      = "sync"
	CatContent   = "content"
	CatDelivery  = "delivery"
)

// Item ist ein Asset in der Arbeitsliste.
type Item struct {
	AssetID         string `json:"assetId"`
	SourceVersionID string `json:"sourceVersionId"`
	SourceRepID     string `json:"sourceRepresentationId"`
	FileName        string `json:"fileName"`
	Title           string `json:"title,omitempty"`
	SourceRev       string `json:"sourceRev"`
	State           string `json:"state"`
	Assignee        string `json:"assignee,omitempty"`
	// Zuweisung (Kapitel 44): wer die Datei prüfen soll (Person und/oder Gruppe), bis wann, von wem eingetragen.
	AssignedTo      string          `json:"assignedTo,omitempty"`
	AssignedGroup   string          `json:"assignedGroup,omitempty"`
	DueAt           *time.Time      `json:"dueAt,omitempty"`
	AssignedBy      string          `json:"assignedBy,omitempty"`
	AssignedAt      *time.Time      `json:"assignedAt,omitempty"`
	ClaimedAt       *time.Time      `json:"claimedAt,omitempty"`
	Revision        int64           `json:"revision"`
	QCStatus        string          `json:"qcStatus,omitempty"`
	QCFail          int             `json:"qcFailCount"`
	QCWarn          int             `json:"qcWarnCount"`
	QCReportID      string          `json:"qcReportId,omitempty"`
	Timeline        *Timeline       `json:"timeline,omitempty"`
	ApprovalMode    string          `json:"approvalMode"`
	IngestJob       string          `json:"ingestJob,omitempty"`
	SizeBytes       int64           `json:"sizeBytes,omitempty"`
	Format          string          `json:"format,omitempty"`
	ConformRevision int             `json:"conformRevision"`
	CreatedAt       time.Time       `json:"createdAt"`
	UpdatedAt       time.Time       `json:"updatedAt"`
	Extra           json.RawMessage `json:"extra,omitempty"`
}

// Finding ist ein einzelnes Prüfergebnis (Feldliste nach der Aufgabenstellung).
type Finding struct {
	ID         int64          `json:"id,omitempty"`
	CheckID    string         `json:"checkId"`
	Category   string         `json:"category"`
	Status     string         `json:"status"`
	Severity   string         `json:"severity"`
	Message    string         `json:"message"`
	Measured   map[string]any `json:"measured,omitempty"`
	Threshold  map[string]any `json:"threshold,omitempty"`
	StartFrame *int64         `json:"startFrame,omitempty"` // Frame-Index [in …
	EndFrame   *int64         `json:"endFrame,omitempty"`   // … out)
	Stream     *int           `json:"stream,omitempty"`     // Audio-/Videostream-Index, falls zutreffend
	Tool       string         `json:"tool"`
	ToolVer    string         `json:"toolVersion"`
	AnalyzedAt time.Time      `json:"analyzedAt"`
	Ruleset    string         `json:"ruleset"` // "<profil>@<version>"
}

// Report ist ein unveränderlicher QC-Bericht (je Lauf ein neuer; frühere bleiben erhalten).
type Report struct {
	ID        string            `json:"id"`
	JobID     string            `json:"jobId"`
	AssetID   string            `json:"assetId"`
	SourceRev string            `json:"sourceRev"`
	Overall   string            `json:"overall"`
	Counts    map[string]int    `json:"counts"`
	Streams   json.RawMessage   `json:"streams,omitempty"` // technische Stream-Metadaten (ffprobe)
	Tools     map[string]string `json:"tools"`
	Profile   json.RawMessage   `json:"profile"` // Schnappschuss des verwendeten Profils (Reproduzierbarkeit)
	Ruleset   string            `json:"ruleset"`
	Findings  []Finding         `json:"findings,omitempty"`
	CreatedAt time.Time         `json:"createdAt"`
}

// Job ist ein QC-Auftrag.
type Job struct {
	ID          string     `json:"id"`
	AssetID     string     `json:"assetId"`
	SourceRev   string     `json:"sourceRev"`
	ProfileID   string     `json:"profileId"`
	State       string     `json:"state"`
	Phase       string     `json:"phase,omitempty"`
	Progress    int        `json:"progress"`
	Attempts    int        `json:"attempts"`
	Error       string     `json:"error,omitempty"`
	ReportID    string     `json:"reportId,omitempty"`
	CreatedAt   time.Time  `json:"createdAt"`
	StartedAt   *time.Time `json:"startedAt,omitempty"`
	FinishedAt  *time.Time `json:"finishedAt,omitempty"`
	RequestedBy string     `json:"requestedBy,omitempty"`
}

// Segment gehört zu einer Conform-Revision. In inklusiv, Out exklusiv (Frames).
type Segment struct {
	ID          string         `json:"id"`
	Order       int            `json:"order"`
	Label       string         `json:"label"`
	In          int64          `json:"in"`
	Out         int64          `json:"out"`
	Description string         `json:"description,omitempty"`
	Metadata    map[string]any `json:"metadata,omitempty"`
	CreatedBy   string         `json:"createdBy,omitempty"`
	CreatedAt   time.Time      `json:"createdAt"`
	UpdatedAt   time.Time      `json:"updatedAt"`
}

// Conform ist eine Conform-Revision (nicht-destruktiv: nur Bereiche + Metadaten, die Quelldatei bleibt unverändert).
type Conform struct {
	ID            string         `json:"id"`
	AssetID       string         `json:"assetId"`
	Revision      int            `json:"revision"`
	State         string         `json:"state"`
	SourceRev     string         `json:"sourceRev"`
	UsableIn      *int64         `json:"usableIn,omitempty"` // nutzbarer Bereich [UsableIn, UsableOut)
	UsableOut     *int64         `json:"usableOut,omitempty"`
	AssetMetadata map[string]any `json:"assetMetadata,omitempty"` // redaktionelle Metadaten des Assets (Entwurf)
	Segments      []Segment      `json:"segments"`
	Note          string         `json:"note,omitempty"`
	CreatedBy     string         `json:"createdBy"`
	UpdatedBy     string         `json:"updatedBy"`
	CreatedAt     time.Time      `json:"createdAt"`
	UpdatedAt     time.Time      `json:"updatedAt"`
	DecidedBy     string         `json:"decidedBy,omitempty"`
	DecisionNote  string         `json:"decisionNote,omitempty"`
}

// HistoryEntry ist ein Audit-Eintrag des Review-Ablaufs.
type HistoryEntry struct {
	ID        int64          `json:"id"`
	AssetID   string         `json:"assetId"`
	At        time.Time      `json:"at"`
	Actor     string         `json:"actor"`
	Action    string         `json:"action"`
	FromState string         `json:"fromState,omitempty"`
	ToState   string         `json:"toState,omitempty"`
	Detail    map[string]any `json:"detail,omitempty"`
}

// Proxy ist ein Review-Proxy der Quelldatei (eigene Datei, Beziehung über asset_id + source_rev).
type Proxy struct {
	ID        string `json:"id"`
	AssetID   string `json:"assetId"`
	SourceRev string `json:"sourceRev"`
	Profile   string `json:"profile"`
	State     string `json:"state"` // queued|running|ready|failed
	Path      string `json:"-"`
	// Ton-Proxy: eine Datei mit je einem Stereo-Stream je Quell-Tonspur (Browser holt blockweise, s. audio.go).
	AudioTracks int       `json:"audioTracks"`
	AudioPath   string    `json:"-"`
	Frames      int64     `json:"frames"`
	Rate        Rate      `json:"rate"`
	Verified    bool      `json:"verified"`
	Error       string    `json:"error,omitempty"`
	Width       int       `json:"width,omitempty"`
	Height      int       `json:"height,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
}
