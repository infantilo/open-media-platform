package authz

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
)

// Store persistiert Rollenbindungen in Postgres (role_bindings-Tabelle,
// db/migrations/0002_auth.sql).
type Store struct {
	db *sql.DB
}

// NewStore erstellt einen Store gegen die gegebene DB-Verbindung.
func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

// Load liefert alle Rollenbindungen — genutzt von internal/consoles, das
// selbst pro Nutzer filtert (gleiches Zugriffsmuster wie zuvor gegen die
// komplette role-bindings.json), sowie von einer künftigen Admin-Auflistung.
func (s *Store) Load() ([]Binding, error) {
	rows, err := s.db.Query(`SELECT id, subject, subject_type, workflow_id, node_id, verb FROM role_bindings ORDER BY subject, workflow_id, node_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var bindings []Binding
	for rows.Next() {
		var b Binding
		if err := rows.Scan(&b.ID, &b.Subject, &b.SubjectType, &b.WorkflowID, &b.NodeID, &b.Verb); err != nil {
			return nil, err
		}
		bindings = append(bindings, b)
	}
	return bindings, rows.Err()
}

// Create legt eine neue Rollenbindung mit Subject-Typ "user" an (alle
// bisherigen Aufrufer — Nutzernamen, aber auch Service-Token-Subjects
// wie Instanz-IDs, s. Binding.SubjectType-Doku) — workflowID leer =
// globale/Node-gescopte Bindung (unverändertes Vor-Kapitel-12-Teil-4-
// Verhalten); gesetzt = Workflow-Scope, nodeID ist dann ein Rollenname
// statt einer Instanz-ID (s. Binding-Doku in authz.go).
func (s *Store) Create(subject, workflowID, nodeID string, verb Verb) (Binding, error) {
	return s.create(SubjectTypeUser, subject, workflowID, nodeID, verb)
}

// CreateGroupBinding legt eine Bindung an, deren Subject eine
// groups.id ist (Nutzerauftrag 2026-09-24: gruppenbasierte Rechte-
// verwaltung) — eigene Methode statt eines weiteren Create()-Parameters,
// damit die drei bestehenden, gruppenunabhängigen Aufrufer (launcher_
// handlers.go/auth_handlers.go/workflows/service.go) unverändert
// bleiben.
func (s *Store) CreateGroupBinding(groupID, workflowID, nodeID string, verb Verb) (Binding, error) {
	return s.create(SubjectTypeGroup, groupID, workflowID, nodeID, verb)
}

func (s *Store) create(subjectType, subject, workflowID, nodeID string, verb Verb) (Binding, error) {
	id, err := newID()
	if err != nil {
		return Binding{}, err
	}
	_, err = s.db.Exec(
		`INSERT INTO role_bindings (id, subject, subject_type, workflow_id, node_id, verb) VALUES ($1, $2, $3, $4, $5, $6)`,
		id, subject, subjectType, workflowID, nodeID, verb)
	if err != nil {
		return Binding{}, err
	}
	return Binding{ID: id, Subject: subject, SubjectType: subjectType, WorkflowID: workflowID, NodeID: nodeID, Verb: verb}, nil
}

// Delete entfernt eine Rollenbindung. Kein Fehler, wenn id nicht
// existiert (idempotent, gleiches Verhalten wie launcher.Stop bei
// unbekannter Instanz-ID).
func (s *Store) Delete(id string) error {
	_, err := s.db.Exec(`DELETE FROM role_bindings WHERE id = $1`, id)
	return err
}

// LoadByWorkflow liefert alle Workflow-gescopten Bindungen für workflowID
// (Nutzerwunsch 2026-07-28) — genutzt von workflows.Service.Export, wenn
// Bindungen mitexportiert werden sollen (opt-in, s. dortige Doku).
func (s *Store) LoadByWorkflow(workflowID string) ([]Binding, error) {
	rows, err := s.db.Query(
		`SELECT id, subject, subject_type, workflow_id, node_id, verb FROM role_bindings WHERE workflow_id = $1 ORDER BY subject, node_id`,
		workflowID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var bindings []Binding
	for rows.Next() {
		var b Binding
		if err := rows.Scan(&b.ID, &b.Subject, &b.SubjectType, &b.WorkflowID, &b.NodeID, &b.Verb); err != nil {
			return nil, err
		}
		bindings = append(bindings, b)
	}
	return bindings, rows.Err()
}

// DeleteByWorkflow entfernt alle Workflow-gescopten Bindungen für
// workflowID (Nutzerwunsch 2026-07-28: ein endgültig gelöschter Workflow
// darf keine verwaisten Bindungen zurücklassen, die auf eine nicht mehr
// existierende workflow_id zeigen) — aufgerufen von
// workflows.Service.Delete, bevor/nachdem der Workflow selbst gelöscht
// wird. Kein Fehler, wenn keine Bindungen existieren (idempotent, s.
// Delete oben).
func (s *Store) DeleteByWorkflow(workflowID string) error {
	_, err := s.db.Exec(`DELETE FROM role_bindings WHERE workflow_id = $1`, workflowID)
	return err
}

// DeleteInstanceBinding entfernt die Service-Token-Bindung einer einzelnen
// Instanz — Gegenstück zu Create(instanceID, workflowID, AnyNode, VerbOperate)
// in workflows.Service.runStart/runRestartRole (ARCHITECTURE.md §24.1).
// Anders als DeleteByWorkflow (räumt nur beim endgültigen Löschen des ganzen
// Workflows auf) wird das hier bei JEDEM Stop/Neustart einer Control-Plane-
// Rolle aufgerufen (Nutzerfund 2026-09-24: 25 verwaiste Bindungen sammelten
// sich über wiederholte Start/Stop-Zyklen an, weil eine gestoppte/ersetzte
// Instanz ihre Bindung sonst nur beim Löschen des kompletten Workflows
// verlor). Exakter Vier-Spalten-Match statt eines bloßen subject-Filters,
// damit ein (extrem unwahrscheinlich) gleichlautender Nutzername nie eine
// echte Bindung trifft — subject ist sonst polymorph (Nutzername/Gruppen-ID/
// Instanz-ID, s. Binding-Doku), hier grenzen workflowID+nodeID+verb den
// Treffer auf exakt das Muster ein, das Create() für diesen Zweck anlegt.
func (s *Store) DeleteInstanceBinding(instanceID, workflowID string) error {
	_, err := s.db.Exec(
		`DELETE FROM role_bindings WHERE subject = $1 AND subject_type = 'user' AND workflow_id = $2 AND node_id = $3 AND verb = $4`,
		instanceID, workflowID, AnyNode, VerbOperate)
	return err
}

// Check prüft, ob subject mindestens minVerb auf nodeID hat — entweder
// über eine direkte Nutzer-Bindung (subject_type='user') ODER über eine
// Gruppen-Bindung (subject_type='group'), deren Gruppe subject als
// Mitglied führt (group_members, Nutzerauftrag 2026-09-24:
// gruppenbasierte Rechteverwaltung) — die pro-Request genutzte Prüfung
// der Middleware (internal/httpapi), als eigene, gescopte Query statt
// über Load() plus Go-seitigem Filtern, weil sie auf jedem proxierten
// API-Aufruf läuft. Bewusst nur workflow_id = "" (globale/Node-gescopte
// Bindungen, s. Binding-Doku) — Workflow-gescopte Bindungen prüft
// CheckWorkflow, damit ein zufällig gleichlautender Rollenname nie mit
// einer Instanz-/Node-ID kollidiert.
func (s *Store) Check(subject, nodeID string, minVerb Verb) (bool, error) {
	rows, err := s.db.Query(
		`SELECT verb FROM role_bindings
		 WHERE workflow_id = '' AND (node_id = $2 OR node_id = $3)
		   AND ((subject_type = 'user' AND subject = $1)
		     OR (subject_type = 'group' AND subject IN (SELECT group_id FROM group_members WHERE username = $1)))`,
		subject, nodeID, AnyNode)
	if err != nil {
		return false, err
	}
	defer rows.Close()

	for rows.Next() {
		var v Verb
		if err := rows.Scan(&v); err != nil {
			return false, err
		}
		if v.Covers(minVerb) {
			return true, nil
		}
	}
	return false, rows.Err()
}

// CheckWorkflow prüft, ob subject mindestens minVerb auf role innerhalb
// von workflowID hat (Kapitel 12 Teil 4) — direkte Rollenbindung oder
// eine "*"-Bindung für den ganzen Workflow. Eigene Methode statt eines
// weiteren Check()-Parameters: die beiden Wirkungsbereiche (global/Node
// vs. Workflow/Rolle) haben unterschiedliche Identitäts-Räume für
// "nodeID" (Instanz-ID vs. Rollenname) und dürfen sich nie kreuzen.
func (s *Store) CheckWorkflow(subject, workflowID, role string, minVerb Verb) (bool, error) {
	rows, err := s.db.Query(
		`SELECT verb FROM role_bindings
		 WHERE workflow_id = $2 AND (node_id = $3 OR node_id = $4)
		   AND ((subject_type = 'user' AND subject = $1)
		     OR (subject_type = 'group' AND subject IN (SELECT group_id FROM group_members WHERE username = $1)))`,
		subject, workflowID, role, AnyNode)
	if err != nil {
		return false, err
	}
	defer rows.Close()

	for rows.Next() {
		var v Verb
		if err := rows.Scan(&v); err != nil {
			return false, err
		}
		if v.Covers(minVerb) {
			return true, nil
		}
	}
	return false, rows.Err()
}

func newID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}
