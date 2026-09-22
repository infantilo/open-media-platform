package process

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/tracing"
)

// ErrNotFound wird geliefert, wenn keine Zeile mit der gegebenen ID
// existiert (gleiche Konvention wie workflows.ErrNotFound).
var ErrNotFound = errors.New("process: not found")

// ErrConcurrentModification wird von jedem CAS-Update (row_version-
// geprüftes UPDATE) geliefert, wenn der übergebene expectedRowVersion
// nicht mehr dem aktuellen DB-Stand entspricht — A3: "optimistic
// concurrency". Aufrufer liest die aktuelle Zeile neu (Get…) und
// entscheidet dann, ob ein erneuter Versuch sinnvoll ist.
var ErrConcurrentModification = errors.New("process: concurrent modification")

// ErrValidation kennzeichnet fehlerhafte AUFRUFER-Eingaben (ungültige
// Definition.Validate()-Graphen, fehlende Pflichtfelder) — im
// Unterschied zu einem internen/DB-Fehler per errors.Is unterscheidbar,
// Grundlage für die HTTP-API (Phase 5 Teil 2): so eingeordnete Fehler
// werden dort als 400 statt 500 gemeldet, gleiche Konvention wie
// workflows.ErrValidation.
var ErrValidation = errors.New("process: validation failed")

// Store persistiert die Prozess-Engine-Domäne in Postgres
// (db/migrations/0018_process.sql).
type Store struct {
	db *sql.DB
}

// NewStore erstellt einen Store auf der gegebenen, bereits migrierten
// Datenbankverbindung.
func NewStore(database *sql.DB) *Store {
	return &Store{db: database}
}

func newID() (string, error) {
	// Reuse statt Neuerfindung: dieselbe 16-Byte-hex-ID-Konvention wie
	// überall sonst (workflows.newID, launcher.newInstanceID) — tracing
	// stellt sie bereits exportiert bereit (tracing.NewID), kein Grund
	// für eine fünfte Kopie derselben fünf Zeilen.
	id := tracing.NewID()
	if id == "" {
		return "", fmt.Errorf("process: id generation failed")
	}
	return id, nil
}

// ---- ProcessDefinition -----------------------------------------------

// CreateDefinition legt eine neue ProcessDefinition an.
func (s *Store) CreateDefinition(name, description, category, createdBy string) (ProcessDefinition, error) {
	if name == "" {
		return ProcessDefinition{}, fmt.Errorf("%w: name is required", ErrValidation)
	}
	id, err := newID()
	if err != nil {
		return ProcessDefinition{}, err
	}
	now := time.Now().UTC()
	pd := ProcessDefinition{
		ID: id, Name: name, Description: description, Category: category,
		CreatedBy: createdBy, CreatedAt: now, UpdatedAt: now,
	}
	_, err = s.db.Exec(`
		INSERT INTO process_definitions (id, name, description, category, created_by, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
	`, pd.ID, pd.Name, pd.Description, pd.Category, pd.CreatedBy, pd.CreatedAt, pd.UpdatedAt)
	if err != nil {
		return ProcessDefinition{}, err
	}
	return pd, nil
}

func scanDefinition(row interface{ Scan(...any) error }) (ProcessDefinition, error) {
	var pd ProcessDefinition
	err := row.Scan(&pd.ID, &pd.Name, &pd.Description, &pd.Category, &pd.CreatedBy, &pd.CreatedAt, &pd.UpdatedAt)
	return pd, err
}

// GetDefinition liest eine einzelne ProcessDefinition.
func (s *Store) GetDefinition(id string) (ProcessDefinition, error) {
	row := s.db.QueryRow(`SELECT id, name, description, category, created_by, created_at, updated_at FROM process_definitions WHERE id = $1`, id)
	pd, err := scanDefinition(row)
	if errors.Is(err, sql.ErrNoRows) {
		return ProcessDefinition{}, ErrNotFound
	}
	return pd, err
}

// ListDefinitions liefert alle ProcessDefinitions, neueste zuerst.
func (s *Store) ListDefinitions() ([]ProcessDefinition, error) {
	rows, err := s.db.Query(`SELECT id, name, description, category, created_by, created_at, updated_at FROM process_definitions ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []ProcessDefinition{}
	for rows.Next() {
		pd, err := scanDefinition(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, pd)
	}
	return out, rows.Err()
}

// UpdateDefinitionMeta ändert Name/Beschreibung/Kategorie — bewusst
// getrennt von Versionen (die unveränderlich sind, s. CreateVersion):
// Metadaten der Definition selbst dürfen sich jederzeit ändern, ohne
// eine neue Version zu erzwingen.
func (s *Store) UpdateDefinitionMeta(id, name, description, category string) (ProcessDefinition, error) {
	if name == "" {
		return ProcessDefinition{}, fmt.Errorf("%w: name is required", ErrValidation)
	}
	res, err := s.db.Exec(`
		UPDATE process_definitions SET name = $2, description = $3, category = $4, updated_at = now()
		WHERE id = $1
	`, id, name, description, category)
	if err != nil {
		return ProcessDefinition{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ProcessDefinition{}, ErrNotFound
	}
	return s.GetDefinition(id)
}

// ---- ProcessVersion -----------------------------------------------

func scanVersion(row interface{ Scan(...any) error }) (ProcessVersion, error) {
	var v ProcessVersion
	var defRaw []byte
	var publishedAt sql.NullTime
	err := row.Scan(&v.ID, &v.ProcessDefinitionID, &v.VersionNumber, &v.Status, &defRaw, &v.CreatedBy, &v.CreatedAt, &publishedAt)
	if err != nil {
		return ProcessVersion{}, err
	}
	if err := json.Unmarshal(defRaw, &v.Definition); err != nil {
		return ProcessVersion{}, fmt.Errorf("process: decode definition: %w", err)
	}
	if publishedAt.Valid {
		t := publishedAt.Time
		v.PublishedAt = &t
	}
	return v, nil
}

const versionSelectColumns = `id, process_definition_id, version_number, status, definition, created_by, created_at, published_at`

// CreateVersion legt eine neue, validierte ProcessVersion im Status
// "draft" an — version_number ist die nächste freie Nummer für die
// gegebene Definition, atomar bestimmt über eine `SELECT … FOR UPDATE`
// auf die process_definitions-Zeile (kein eigener Zähler nötig, dieselbe
// Zeile existiert für jede Definition ohnehin genau einmal und dient
// hier nur als Lock-Anker — analog zum Muster in launcher, wo eine
// bereits vorhandene Zeile für Serialisierung mitgenutzt wird, statt
// eine neue Sequenz-Tabelle einzuführen).
func (s *Store) CreateVersion(processDefinitionID string, definition Definition, createdBy string) (ProcessVersion, error) {
	if err := definition.Validate(); err != nil {
		return ProcessVersion{}, err
	}
	ctx := context.Background()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ProcessVersion{}, err
	}
	defer func() { _ = tx.Rollback() }()

	var exists string
	if err := tx.QueryRowContext(ctx, `SELECT id FROM process_definitions WHERE id = $1 FOR UPDATE`, processDefinitionID).Scan(&exists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ProcessVersion{}, ErrNotFound
		}
		return ProcessVersion{}, err
	}

	var nextVersion int
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(version_number), 0) + 1 FROM process_versions WHERE process_definition_id = $1`, processDefinitionID).Scan(&nextVersion); err != nil {
		return ProcessVersion{}, err
	}

	id, err := newID()
	if err != nil {
		return ProcessVersion{}, err
	}
	defRaw, err := json.Marshal(definition)
	if err != nil {
		return ProcessVersion{}, err
	}
	v := ProcessVersion{
		ID: id, ProcessDefinitionID: processDefinitionID, VersionNumber: nextVersion,
		Status: VersionStatusDraft, Definition: definition, CreatedBy: createdBy, CreatedAt: time.Now().UTC(),
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO process_versions (id, process_definition_id, version_number, status, definition, created_by, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
	`, v.ID, v.ProcessDefinitionID, v.VersionNumber, v.Status, defRaw, v.CreatedBy, v.CreatedAt); err != nil {
		return ProcessVersion{}, err
	}

	if err := tx.Commit(); err != nil {
		return ProcessVersion{}, err
	}
	return v, nil
}

// GetVersion liest eine einzelne ProcessVersion per ID.
func (s *Store) GetVersion(id string) (ProcessVersion, error) {
	row := s.db.QueryRow(`SELECT `+versionSelectColumns+` FROM process_versions WHERE id = $1`, id)
	v, err := scanVersion(row)
	if errors.Is(err, sql.ErrNoRows) {
		return ProcessVersion{}, ErrNotFound
	}
	return v, err
}

// ListVersions liefert alle Versionen einer Definition, neueste zuerst.
func (s *Store) ListVersions(processDefinitionID string) ([]ProcessVersion, error) {
	rows, err := s.db.Query(`SELECT `+versionSelectColumns+` FROM process_versions WHERE process_definition_id = $1 ORDER BY version_number DESC`, processDefinitionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []ProcessVersion{}
	for rows.Next() {
		v, err := scanVersion(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// transitionVersionStatus ist der gemeinsame Kern von PublishVersion/
// DeprecateVersion/ArchiveVersion — validiert den Übergang über
// VersionTransitions (statt jede Methode den Zustandsgraphen erneut
// hartzukodieren) und schreibt ihn nur, wenn die aktuelle DB-Zeile
// wirklich noch im erwarteten Ausgangszustand ist (WHERE status = ...
// statt eines blinden UPDATE — verhindert einen doppelten Publish-Klick
// zweier Nutzer, die beide vom selben veralteten "draft"-Stand
// ausgingen).
func (s *Store) transitionVersionStatus(id, to string, setPublishedAt bool) (ProcessVersion, error) {
	current, err := s.GetVersion(id)
	if err != nil {
		return ProcessVersion{}, err
	}
	if err := VersionTransitions.Validate(current.Status, to); err != nil {
		return ProcessVersion{}, err
	}

	var res sql.Result
	if setPublishedAt {
		res, err = s.db.Exec(`UPDATE process_versions SET status = $3, published_at = now() WHERE id = $1 AND status = $2`, id, current.Status, to)
	} else {
		res, err = s.db.Exec(`UPDATE process_versions SET status = $3 WHERE id = $1 AND status = $2`, id, current.Status, to)
	}
	if err != nil {
		return ProcessVersion{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ProcessVersion{}, ErrConcurrentModification
	}
	return s.GetVersion(id)
}

// PublishVersion macht eine Draft-Version unveränderlich nutzbar (A7).
func (s *Store) PublishVersion(id string) (ProcessVersion, error) {
	return s.transitionVersionStatus(id, VersionStatusPublished, true)
}

// DeprecateVersion markiert eine veröffentlichte Version als überholt —
// bestehende ProcessExecutions dürfen laut A7 unverändert mit ihr
// weiterlaufen, nur neue Starts sollten sie meiden (Runtime-Aufgabe,
// Phase 3).
func (s *Store) DeprecateVersion(id string) (ProcessVersion, error) {
	return s.transitionVersionStatus(id, VersionStatusDeprecated, false)
}

// ArchiveVersion.
func (s *Store) ArchiveVersion(id string) (ProcessVersion, error) {
	return s.transitionVersionStatus(id, VersionStatusArchived, false)
}

// ---- ProcessExecution -----------------------------------------------

func scanExecution(row interface{ Scan(...any) error }) (ProcessExecution, error) {
	var e ProcessExecution
	var causationID, parentID, traceID sql.NullString
	var completedAt sql.NullTime
	err := row.Scan(&e.ID, &e.ProcessDefinitionID, &e.ProcessVersionID, &e.Status,
		&e.CorrelationID, &causationID, &parentID, &traceID,
		&e.Input, &e.Output, &e.Error, &e.CreatedBy, &e.RowVersion,
		&e.StartedAt, &e.UpdatedAt, &completedAt)
	if err != nil {
		return ProcessExecution{}, err
	}
	e.CausationID = causationID.String
	e.ParentExecutionID = parentID.String
	e.TraceID = traceID.String
	if completedAt.Valid {
		t := completedAt.Time
		e.CompletedAt = &t
	}
	return e, nil
}

const executionSelectColumns = `id, process_definition_id, process_version_id, status, correlation_id, causation_id, parent_execution_id, trace_id, input, output, error, created_by, row_version, started_at, updated_at, completed_at`

// CreateExecutionParams bündelt die Eingaben für CreateExecution — ein
// Struct statt einer langen Positionsparameterliste, weil mehrere
// Felder optional sind (CorrelationID leer = eigene ID als Korrelation,
// s. u.) und eine reine Parameterliste an dieser Stelle fehleranfällig
// wäre (mehrere gleichartige string-Felder in Folge).
type CreateExecutionParams struct {
	ProcessDefinitionID string
	ProcessVersionID    string
	CorrelationID       string // leer = wird auf die neue Execution-ID gesetzt
	CausationID         string
	ParentExecutionID   string
	TraceID             string
	CreatedBy           string
	Input               json.RawMessage
}

// CreateExecution legt eine neue ProcessExecution im Status "pending" an.
func (s *Store) CreateExecution(p CreateExecutionParams) (ProcessExecution, error) {
	if p.ProcessDefinitionID == "" || p.ProcessVersionID == "" {
		return ProcessExecution{}, fmt.Errorf("%w: processDefinitionId and processVersionId are required", ErrValidation)
	}
	id, err := newID()
	if err != nil {
		return ProcessExecution{}, err
	}
	correlationID := p.CorrelationID
	if correlationID == "" {
		correlationID = id
	}
	if p.Input == nil {
		p.Input = json.RawMessage(`{}`)
	}
	now := time.Now().UTC()
	e := ProcessExecution{
		ID: id, ProcessDefinitionID: p.ProcessDefinitionID, ProcessVersionID: p.ProcessVersionID,
		Status: StatusPending, CorrelationID: correlationID, CausationID: p.CausationID,
		ParentExecutionID: p.ParentExecutionID, TraceID: p.TraceID, Input: p.Input,
		Output: json.RawMessage(`{}`), CreatedBy: p.CreatedBy, RowVersion: 1,
		StartedAt: now, UpdatedAt: now,
	}
	_, err = s.db.Exec(`
		INSERT INTO process_executions (id, process_definition_id, process_version_id, status, correlation_id, causation_id, parent_execution_id, trace_id, input, output, error, created_by, row_version, started_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), $9, $10, '', $11, 1, $12, $12)
	`, e.ID, e.ProcessDefinitionID, e.ProcessVersionID, e.Status, e.CorrelationID, e.CausationID, e.ParentExecutionID, e.TraceID, []byte(e.Input), []byte(e.Output), e.CreatedBy, e.StartedAt)
	if err != nil {
		return ProcessExecution{}, err
	}
	return e, nil
}

// GetExecution liest eine einzelne ProcessExecution.
func (s *Store) GetExecution(id string) (ProcessExecution, error) {
	row := s.db.QueryRow(`SELECT `+executionSelectColumns+` FROM process_executions WHERE id = $1`, id)
	e, err := scanExecution(row)
	if errors.Is(err, sql.ErrNoRows) {
		return ProcessExecution{}, ErrNotFound
	}
	return e, err
}

// ExecutionFilter grenzt ListExecutions ein — jedes nicht-leere Feld ist
// ein zusätzliches UND-Kriterium. Leerer Filter = alle Executions.
type ExecutionFilter struct {
	ProcessDefinitionID string
	Status              string
	CorrelationID       string
	ParentExecutionID   string
}

// ListExecutions liefert Executions nach Filter, neueste zuerst.
func (s *Store) ListExecutions(f ExecutionFilter) ([]ProcessExecution, error) {
	query := `SELECT ` + executionSelectColumns + ` FROM process_executions WHERE 1=1`
	var args []any
	add := func(col, val string) {
		if val == "" {
			return
		}
		args = append(args, val)
		query += fmt.Sprintf(" AND %s = $%d", col, len(args))
	}
	add("process_definition_id", f.ProcessDefinitionID)
	add("status", f.Status)
	add("correlation_id", f.CorrelationID)
	add("parent_execution_id", f.ParentExecutionID)
	query += " ORDER BY started_at DESC"

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []ProcessExecution{}
	for rows.Next() {
		e, err := scanExecution(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// UpdateExecutionStatus validiert den Übergang (ExecutionTransitions),
// schreibt ihn per CAS auf row_version (A3) und setzt completed_at, wenn
// der Zielzustand ein abgeschlossener Lauf ist (isRunEndStatus — bewusst
// NICHT dasselbe wie graphisch terminal, s. dortige Doku: "failed" hat
// z. B. noch einen Compensating-Folgeübergang, ist aber trotzdem JETZT
// abgeschlossen).
func (s *Store) UpdateExecutionStatus(id string, expectedRowVersion int, newStatus, errMsg string) (ProcessExecution, error) {
	current, err := s.GetExecution(id)
	if err != nil {
		return ProcessExecution{}, err
	}
	if err := ExecutionTransitions.Validate(current.Status, newStatus); err != nil {
		return ProcessExecution{}, err
	}

	var res sql.Result
	if isRunEndStatus(newStatus) {
		res, err = s.db.Exec(`
			UPDATE process_executions SET status = $3, error = $4, row_version = row_version + 1, updated_at = now(), completed_at = now()
			WHERE id = $1 AND row_version = $2
		`, id, expectedRowVersion, newStatus, errMsg)
	} else {
		res, err = s.db.Exec(`
			UPDATE process_executions SET status = $3, error = $4, row_version = row_version + 1, updated_at = now()
			WHERE id = $1 AND row_version = $2
		`, id, expectedRowVersion, newStatus, errMsg)
	}
	if err != nil {
		return ProcessExecution{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ProcessExecution{}, ErrConcurrentModification
	}
	return s.GetExecution(id)
}

// SetExecutionOutput schreibt das Ergebnis einer Execution (CAS wie
// UpdateExecutionStatus) — getrennt davon, weil Output typischerweise
// erst beim letzten Schritt feststeht, während Status sich schon vorher
// mehrfach ändert.
func (s *Store) SetExecutionOutput(id string, expectedRowVersion int, output json.RawMessage) (ProcessExecution, error) {
	if output == nil {
		output = json.RawMessage(`{}`)
	}
	res, err := s.db.Exec(`
		UPDATE process_executions SET output = $3, row_version = row_version + 1, updated_at = now()
		WHERE id = $1 AND row_version = $2
	`, id, expectedRowVersion, []byte(output))
	if err != nil {
		return ProcessExecution{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ProcessExecution{}, ErrConcurrentModification
	}
	return s.GetExecution(id)
}

// ---- ProcessStepExecution -----------------------------------------------

func scanStepExecution(row interface{ Scan(...any) error }) (ProcessStepExecution, error) {
	var e ProcessStepExecution
	var completedAt sql.NullTime
	err := row.Scan(&e.ID, &e.ProcessExecutionID, &e.StepID, &e.StepType, &e.Status, &e.Attempt,
		&e.Input, &e.Output, &e.Error, &e.RowVersion, &e.StartedAt, &e.UpdatedAt, &completedAt)
	if err != nil {
		return ProcessStepExecution{}, err
	}
	if completedAt.Valid {
		t := completedAt.Time
		e.CompletedAt = &t
	}
	return e, nil
}

const stepExecutionSelectColumns = `id, process_execution_id, step_id, step_type, status, attempt, input, output, error, row_version, started_at, updated_at, completed_at`

// CreateStepExecution legt eine neue ProcessStepExecution im Status
// "pending", Attempt 1 an.
func (s *Store) CreateStepExecution(processExecutionID, stepID string, stepType StepType, input json.RawMessage) (ProcessStepExecution, error) {
	if processExecutionID == "" || stepID == "" {
		return ProcessStepExecution{}, fmt.Errorf("%w: processExecutionId and stepId are required", ErrValidation)
	}
	id, err := newID()
	if err != nil {
		return ProcessStepExecution{}, err
	}
	if input == nil {
		input = json.RawMessage(`{}`)
	}
	now := time.Now().UTC()
	e := ProcessStepExecution{
		ID: id, ProcessExecutionID: processExecutionID, StepID: stepID, StepType: stepType,
		Status: StatusPending, Attempt: 1, Input: input, Output: json.RawMessage(`{}`),
		RowVersion: 1, StartedAt: now, UpdatedAt: now,
	}
	_, err = s.db.Exec(`
		INSERT INTO process_step_executions (id, process_execution_id, step_id, step_type, status, attempt, input, output, error, row_version, started_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, 1, $6, $7, '', 1, $8, $8)
	`, e.ID, e.ProcessExecutionID, e.StepID, string(e.StepType), e.Status, []byte(e.Input), []byte(e.Output), e.StartedAt)
	if err != nil {
		return ProcessStepExecution{}, err
	}
	return e, nil
}

// GetStepExecution liest eine einzelne ProcessStepExecution.
func (s *Store) GetStepExecution(id string) (ProcessStepExecution, error) {
	row := s.db.QueryRow(`SELECT `+stepExecutionSelectColumns+` FROM process_step_executions WHERE id = $1`, id)
	e, err := scanStepExecution(row)
	if errors.Is(err, sql.ErrNoRows) {
		return ProcessStepExecution{}, ErrNotFound
	}
	return e, err
}

// GetOrCreateStepExecution legt eine StepExecution im Status "pending"
// an oder liefert die bereits existierende Zeile zurück, falls schon
// eine für (processExecutionID, stepID) existiert — atomar per `INSERT
// … ON CONFLICT … DO UPDATE … RETURNING` (No-op-Update-Trick, damit
// RETURNING auch im Konfliktfall die vorhandene Zeile liefert), gestützt
// auf die Unique-Constraint aus 0020_process_step_executions_unique.sql.
// Einziger Aufrufer ist die Runtime (engine.go) — ersetzt dort ein
// racy Check-dann-Insert, das zwei gleichzeitige Engine-Polls (z. B.
// während RecoverAll nach einem Neustart) sonst zu doppelten Zeilen
// führen lassen könnte.
func (s *Store) GetOrCreateStepExecution(processExecutionID, stepID string, stepType StepType, input json.RawMessage) (ProcessStepExecution, error) {
	if processExecutionID == "" || stepID == "" {
		return ProcessStepExecution{}, fmt.Errorf("%w: processExecutionId and stepId are required", ErrValidation)
	}
	id, err := newID()
	if err != nil {
		return ProcessStepExecution{}, err
	}
	if input == nil {
		input = json.RawMessage(`{}`)
	}
	now := time.Now().UTC()
	row := s.db.QueryRow(`
		INSERT INTO process_step_executions (id, process_execution_id, step_id, step_type, status, attempt, input, output, error, row_version, started_at, updated_at)
		VALUES ($1, $2, $3, $4, 'pending', 1, $5, '{}', '', 1, $6, $6)
		ON CONFLICT (process_execution_id, step_id) DO UPDATE SET step_id = EXCLUDED.step_id
		RETURNING `+stepExecutionSelectColumns+`
	`, id, processExecutionID, stepID, string(stepType), []byte(input), now)
	return scanStepExecution(row)
}

// ListStepExecutions liefert alle Schrittläufe einer Execution in
// Startreihenfolge — die Ausführungshistorie (A9: "GET .../history").
func (s *Store) ListStepExecutions(processExecutionID string) ([]ProcessStepExecution, error) {
	rows, err := s.db.Query(`SELECT `+stepExecutionSelectColumns+` FROM process_step_executions WHERE process_execution_id = $1 ORDER BY started_at ASC`, processExecutionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []ProcessStepExecution{}
	for rows.Next() {
		e, err := scanStepExecution(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// UpdateStepExecutionStatus — wie UpdateExecutionStatus, für die
// Schritt-Ebene (StepExecutionTransitions statt ExecutionTransitions).
func (s *Store) UpdateStepExecutionStatus(id string, expectedRowVersion int, newStatus, errMsg string) (ProcessStepExecution, error) {
	current, err := s.GetStepExecution(id)
	if err != nil {
		return ProcessStepExecution{}, err
	}
	if err := StepExecutionTransitions.Validate(current.Status, newStatus); err != nil {
		return ProcessStepExecution{}, err
	}

	var res sql.Result
	if isRunEndStatus(newStatus) {
		res, err = s.db.Exec(`
			UPDATE process_step_executions SET status = $3, error = $4, row_version = row_version + 1, updated_at = now(), completed_at = now()
			WHERE id = $1 AND row_version = $2
		`, id, expectedRowVersion, newStatus, errMsg)
	} else {
		res, err = s.db.Exec(`
			UPDATE process_step_executions SET status = $3, error = $4, row_version = row_version + 1, updated_at = now()
			WHERE id = $1 AND row_version = $2
		`, id, expectedRowVersion, newStatus, errMsg)
	}
	if err != nil {
		return ProcessStepExecution{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ProcessStepExecution{}, ErrConcurrentModification
	}
	return s.GetStepExecution(id)
}

// SetStepExecutionOutput — wie SetExecutionOutput, für die Schritt-Ebene.
func (s *Store) SetStepExecutionOutput(id string, expectedRowVersion int, output json.RawMessage) (ProcessStepExecution, error) {
	if output == nil {
		output = json.RawMessage(`{}`)
	}
	res, err := s.db.Exec(`
		UPDATE process_step_executions SET output = $3, row_version = row_version + 1, updated_at = now()
		WHERE id = $1 AND row_version = $2
	`, id, expectedRowVersion, []byte(output))
	if err != nil {
		return ProcessStepExecution{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ProcessStepExecution{}, ErrConcurrentModification
	}
	return s.GetStepExecution(id)
}

// RetryStepExecution führt den in StepExecutionTransitions vorgesehenen
// failed/timed_out->pending-Übergang aus UND zählt Attempt hoch, atomar
// in einem UPDATE (A4: "Ein Step darf bei einem Retry keine
// unkontrollierten Duplikate erzeugen" — dieselbe Zeile, kein neuer
// Datensatz je Versuch, s. Moduldoku bei ProcessStepExecution).
//
// Für EXTERNES/manuelles Wiederholen eines bereits terminal
// gescheiterten Schritts (künftige Phase-5-API). Die Runtime selbst
// (engine.go) nutzt für ihre EIGENE automatische Backoff-Schleife
// bewusst NICHT diese Methode, sondern RecordAttemptAndContinue (s. u.)
// — s. dortige Begründung (Crash-während-Backoff-Korrektheit).
func (s *Store) RetryStepExecution(id string, expectedRowVersion int) (ProcessStepExecution, error) {
	current, err := s.GetStepExecution(id)
	if err != nil {
		return ProcessStepExecution{}, err
	}
	if err := StepExecutionTransitions.Validate(current.Status, StatusPending); err != nil {
		return ProcessStepExecution{}, err
	}
	res, err := s.db.Exec(`
		UPDATE process_step_executions SET status = $3, attempt = attempt + 1, error = '', row_version = row_version + 1, updated_at = now(), completed_at = NULL
		WHERE id = $1 AND row_version = $2
	`, id, expectedRowVersion, StatusPending)
	if err != nil {
		return ProcessStepExecution{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ProcessStepExecution{}, ErrConcurrentModification
	}
	return s.GetStepExecution(id)
}

// RecordAttemptAndContinue erhöht Attempt und speichert eine
// Zwischenfehlermeldung, OHNE den Status zu ändern (bleibt "running") —
// für die runtime-eigene automatische Retry-Schleife (engine.go)
// zwischen zwei Versuchen DESSELBEN Backoff-Zyklus. Bewusst NICHT über
// "failed"/"timed_out": ein Prozess-Crash mitten in der Backoff-Pause
// (B16: "Prozess killen, neu starten, Workflow läuft korrekt weiter")
// darf den Schritt beim Wiederanlauf nicht fälschlich als endgültig
// gescheitert erscheinen lassen — `computeFrontier`/`finalize` (s.
// engine.go) behandeln "running" weiterhin als aktiv/in Bearbeitung,
// nicht als abgeschlossen. Nur bei tatsächlich erschöpften Versuchen
// schreibt die Runtime am Ende wirklich "failed"/"timed_out"
// (UpdateStepExecutionStatus). WHERE status='running' ist eine
// zusätzliche Absicherung (kein Aufruf gegen eine Zeile, die
// zwischenzeitlich z. B. abgebrochen wurde).
func (s *Store) RecordAttemptAndContinue(id string, expectedRowVersion int, lastError string) (ProcessStepExecution, error) {
	res, err := s.db.Exec(`
		UPDATE process_step_executions SET attempt = attempt + 1, error = $3, row_version = row_version + 1, updated_at = now()
		WHERE id = $1 AND row_version = $2 AND status = $4
	`, id, expectedRowVersion, lastError, StatusRunning)
	if err != nil {
		return ProcessStepExecution{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ProcessStepExecution{}, ErrConcurrentModification
	}
	return s.GetStepExecution(id)
}

// ---- HumanTask -----------------------------------------------

func scanHumanTask(row interface{ Scan(...any) error }) (HumanTask, error) {
	var t HumanTask
	var stepExecutionID sql.NullString
	var deadline, completedAt sql.NullTime
	err := row.Scan(&t.ID, &t.ProcessExecutionID, &stepExecutionID, &t.Title, &t.Description,
		&t.Assignee, &t.Role, &t.Priority, &t.Status, &t.Decision, &t.Comment, &t.RowVersion,
		&deadline, &t.CreatedAt, &completedAt)
	if err != nil {
		return HumanTask{}, err
	}
	t.StepExecutionID = stepExecutionID.String
	if deadline.Valid {
		d := deadline.Time
		t.Deadline = &d
	}
	if completedAt.Valid {
		c := completedAt.Time
		t.CompletedAt = &c
	}
	return t, nil
}

const humanTaskSelectColumns = `id, process_execution_id, step_execution_id, title, description, assignee, role, priority, status, decision, comment, row_version, deadline, created_at, completed_at`

// CreateHumanTaskParams bündelt die Eingaben für CreateHumanTask
// (gleicher Grund wie CreateExecutionParams: mehrere optionale
// gleichartige string-Felder).
type CreateHumanTaskParams struct {
	ProcessExecutionID string
	StepExecutionID    string
	Title              string
	Description        string
	Assignee           string
	Role               string
	Priority           string
	Deadline           *time.Time
}

// CreateHumanTask legt einen neuen HumanTask im Status "pending" an.
func (s *Store) CreateHumanTask(p CreateHumanTaskParams) (HumanTask, error) {
	if p.ProcessExecutionID == "" || p.Title == "" {
		return HumanTask{}, fmt.Errorf("%w: processExecutionId and title are required", ErrValidation)
	}
	id, err := newID()
	if err != nil {
		return HumanTask{}, err
	}
	priority := p.Priority
	if priority == "" {
		priority = "normal"
	}
	t := HumanTask{
		ID: id, ProcessExecutionID: p.ProcessExecutionID, StepExecutionID: p.StepExecutionID,
		Title: p.Title, Description: p.Description, Assignee: p.Assignee, Role: p.Role,
		Priority: priority, Status: HumanTaskStatusPending, RowVersion: 1,
		Deadline: p.Deadline, CreatedAt: time.Now().UTC(),
	}
	_, err = s.db.Exec(`
		INSERT INTO human_tasks (id, process_execution_id, step_execution_id, title, description, assignee, role, priority, status, decision, comment, row_version, deadline, created_at)
		VALUES ($1, $2, NULLIF($3, ''), $4, $5, $6, $7, $8, $9, '', '', 1, $10, $11)
	`, t.ID, t.ProcessExecutionID, t.StepExecutionID, t.Title, t.Description, t.Assignee, t.Role, t.Priority, t.Status, t.Deadline, t.CreatedAt)
	if err != nil {
		return HumanTask{}, err
	}
	return t, nil
}

// GetHumanTask liest einen einzelnen HumanTask.
func (s *Store) GetHumanTask(id string) (HumanTask, error) {
	row := s.db.QueryRow(`SELECT `+humanTaskSelectColumns+` FROM human_tasks WHERE id = $1`, id)
	t, err := scanHumanTask(row)
	if errors.Is(err, sql.ErrNoRows) {
		return HumanTask{}, ErrNotFound
	}
	return t, err
}

// ListHumanTasksByExecution liefert alle Tasks einer Execution (A9:
// "GET .../tasks").
func (s *Store) ListHumanTasksByExecution(processExecutionID string) ([]HumanTask, error) {
	return s.queryHumanTasks(`process_execution_id = $1`, processExecutionID, `created_at ASC`)
}

// GetHumanTaskByStepExecution liefert den (höchstens einen) HumanTask
// zu einer StepExecution — Grundlage für die idempotente Poll-Logik der
// Runtime (Kapitel 21 Phase 3 Teil 1, engine.go): bevor ein
// HumanTask/Approval-Schritt einen neuen Task anlegt, prüft er erst, ob
// bereits einer existiert (z. B. nach einem Neustart mitten im Warten),
// statt bei jedem Poll blind einen weiteren anzulegen. ErrNotFound, wenn
// (noch) keiner existiert.
func (s *Store) GetHumanTaskByStepExecution(stepExecutionID string) (HumanTask, error) {
	row := s.db.QueryRow(`SELECT `+humanTaskSelectColumns+` FROM human_tasks WHERE step_execution_id = $1`, stepExecutionID)
	t, err := scanHumanTask(row)
	if errors.Is(err, sql.ErrNoRows) {
		return HumanTask{}, ErrNotFound
	}
	return t, err
}

// ListHumanTasksByAssignee liefert alle Tasks eines Assignees, offene
// zuerst (A9: "GET /human-tasks" mit ?assignee=…-Filter, künftig).
func (s *Store) ListHumanTasksByAssignee(assignee string) ([]HumanTask, error) {
	return s.queryHumanTasks(`assignee = $1`, assignee, `created_at ASC`)
}

func (s *Store) queryHumanTasks(where, arg, orderBy string) ([]HumanTask, error) {
	rows, err := s.db.Query(`SELECT `+humanTaskSelectColumns+` FROM human_tasks WHERE `+where+` ORDER BY `+orderBy, arg)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []HumanTask{}
	for rows.Next() {
		t, err := scanHumanTask(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// AssignHumanTask setzt Assignee, ohne den Status zu ändern (A6:
// "assign" ist unabhängig von "claim" — ein zugewiesener, aber noch
// nicht vom Assignee bestätigter Task bleibt "pending").
func (s *Store) AssignHumanTask(id, assignee string) (HumanTask, error) {
	res, err := s.db.Exec(`UPDATE human_tasks SET assignee = $2, row_version = row_version + 1 WHERE id = $1`, id, assignee)
	if err != nil {
		return HumanTask{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return HumanTask{}, ErrNotFound
	}
	return s.GetHumanTask(id)
}

// UpdateHumanTaskStatus validiert den Übergang (HumanTaskTransitions),
// schreibt ihn per CAS und setzt completed_at, sobald der Zielzustand
// terminal ist (approve/reject/request-changes/cancel/timeout — nicht
// "claimed"/"delegated"/"escalated", die haben laut HumanTaskTransitions
// weiterhin ausgehende Übergänge). decision/comment werden bei jedem
// Aufruf mitgeschrieben (leer = unverändert löschen ist hier kein
// Sonderfall — der Aufrufer übergibt bewusst, was gelten soll, gleiches
// einfache Muster wie restoreGenericParams in internal/workflows).
func (s *Store) UpdateHumanTaskStatus(id string, expectedRowVersion int, newStatus, decision, comment string) (HumanTask, error) {
	current, err := s.GetHumanTask(id)
	if err != nil {
		return HumanTask{}, err
	}
	if err := HumanTaskTransitions.Validate(current.Status, newStatus); err != nil {
		return HumanTask{}, err
	}

	var res sql.Result
	if HumanTaskTransitions.IsTerminal(newStatus) {
		res, err = s.db.Exec(`
			UPDATE human_tasks SET status = $3, decision = $4, comment = $5, row_version = row_version + 1, completed_at = now()
			WHERE id = $1 AND row_version = $2
		`, id, expectedRowVersion, newStatus, decision, comment)
	} else {
		res, err = s.db.Exec(`
			UPDATE human_tasks SET status = $3, decision = $4, comment = $5, row_version = row_version + 1
			WHERE id = $1 AND row_version = $2
		`, id, expectedRowVersion, newStatus, decision, comment)
	}
	if err != nil {
		return HumanTask{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return HumanTask{}, ErrConcurrentModification
	}
	return s.GetHumanTask(id)
}
