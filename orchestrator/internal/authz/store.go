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
	rows, err := s.db.Query(`SELECT id, subject, workflow_id, node_id, verb FROM role_bindings ORDER BY subject, workflow_id, node_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var bindings []Binding
	for rows.Next() {
		var b Binding
		if err := rows.Scan(&b.ID, &b.Subject, &b.WorkflowID, &b.NodeID, &b.Verb); err != nil {
			return nil, err
		}
		bindings = append(bindings, b)
	}
	return bindings, rows.Err()
}

// Create legt eine neue Rollenbindung an. workflowID leer = globale/
// Node-gescopte Bindung (unverändertes Vor-Kapitel-12-Teil-4-Verhalten);
// gesetzt = Workflow-Scope, nodeID ist dann ein Rollenname statt einer
// Instanz-ID (s. Binding-Doku in authz.go).
func (s *Store) Create(subject, workflowID, nodeID string, verb Verb) (Binding, error) {
	id, err := newID()
	if err != nil {
		return Binding{}, err
	}
	_, err = s.db.Exec(
		`INSERT INTO role_bindings (id, subject, workflow_id, node_id, verb) VALUES ($1, $2, $3, $4, $5)`,
		id, subject, workflowID, nodeID, verb)
	if err != nil {
		return Binding{}, err
	}
	return Binding{ID: id, Subject: subject, WorkflowID: workflowID, NodeID: nodeID, Verb: verb}, nil
}

// Delete entfernt eine Rollenbindung. Kein Fehler, wenn id nicht
// existiert (idempotent, gleiches Verhalten wie launcher.Stop bei
// unbekannter Instanz-ID).
func (s *Store) Delete(id string) error {
	_, err := s.db.Exec(`DELETE FROM role_bindings WHERE id = $1`, id)
	return err
}

// Check prüft, ob subject mindestens minVerb auf nodeID hat (direkte
// Bindung oder eine "*"-Bindung) — die pro-Request genutzte Prüfung der
// Middleware (internal/httpapi), als eigene, gescopte Query statt über
// Load() plus Go-seitigem Filtern, weil sie auf jedem proxierten
// API-Aufruf läuft. Bewusst nur workflow_id = "" (globale/Node-gescopte
// Bindungen, s. Binding-Doku) — Workflow-gescopte Bindungen prüft
// CheckWorkflow, damit ein zufällig gleichlautender Rollenname nie mit
// einer Instanz-/Node-ID kollidiert.
func (s *Store) Check(subject, nodeID string, minVerb Verb) (bool, error) {
	rows, err := s.db.Query(
		`SELECT verb FROM role_bindings WHERE subject = $1 AND workflow_id = '' AND (node_id = $2 OR node_id = $3)`,
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
		if v.covers(minVerb) {
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
		`SELECT verb FROM role_bindings WHERE subject = $1 AND workflow_id = $2 AND (node_id = $3 OR node_id = $4)`,
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
		if v.covers(minVerb) {
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
