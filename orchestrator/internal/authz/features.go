package authz

import (
	"errors"
	"strings"
	"time"
)

// Funktionsrechte (Kapitel 44): benannte Rechte, die Module deklarieren (`module.FeatureProvider`), z. B.
// `ingest.schedule.create` oder `review.qc.run`. Sie werden an Nutzer oder Gruppen vergeben und sind unabhängig von den
// Verben der Rollenbindungen: Wer global `configure` hat, darf alles; ein Operator darf genau das, was ihm vergeben wurde.
// Ein Eintrag `modul.*` deckt alle Rechte des Moduls ab, `*` alle.

var (
	ErrFeatureValidation = errors.New("authz: invalid feature grant")
	ErrFeatureNotFound   = errors.New("authz: feature grant not found")
)

// FeatureGrant ist eine Vergabe eines Funktionsrechts.
type FeatureGrant struct {
	ID          string    `json:"id"`
	SubjectType string    `json:"subjectType"`
	Subject     string    `json:"subject"`
	Feature     string    `json:"feature"`
	CreatedBy   string    `json:"createdBy,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
}

// FeatureMatches: deckt das vergebene Muster (`grant`) das verlangte Recht (`want`) ab?
func FeatureMatches(grant, want string) bool {
	if grant == want || grant == "*" {
		return true
	}
	if p, ok := strings.CutSuffix(grant, ".*"); ok {
		return strings.HasPrefix(want, p+".")
	}
	return false
}

func validFeatureName(f string) bool {
	if f == "*" {
		return true
	}
	if f == "" || len(f) > 100 {
		return false
	}
	for _, r := range f {
		ok := r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '*' || r == '-'
		if !ok {
			return false
		}
	}
	return !strings.HasPrefix(f, ".") && !strings.HasSuffix(f, ".") && (!strings.Contains(f, "*") || strings.HasSuffix(f, ".*"))
}

// ListFeatureGrants liefert alle Vergaben.
func (s *Store) ListFeatureGrants() ([]FeatureGrant, error) {
	rows, err := s.db.Query(`SELECT id, subject_type, subject, feature, created_by, created_at FROM feature_grants ORDER BY subject_type, subject, feature`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []FeatureGrant{}
	for rows.Next() {
		var g FeatureGrant
		if err := rows.Scan(&g.ID, &g.SubjectType, &g.Subject, &g.Feature, &g.CreatedBy, &g.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// CreateFeatureGrant vergibt ein Recht; eine doppelte Vergabe liefert die vorhandene zurück (idempotent).
func (s *Store) CreateFeatureGrant(subjectType, subject, feature, createdBy string) (FeatureGrant, error) {
	if subjectType == "" {
		subjectType = SubjectTypeUser
	}
	if (subjectType != SubjectTypeUser && subjectType != SubjectTypeGroup) || strings.TrimSpace(subject) == "" || !validFeatureName(feature) {
		return FeatureGrant{}, ErrFeatureValidation
	}
	id, err := newID()
	if err != nil {
		return FeatureGrant{}, err
	}
	g := FeatureGrant{ID: id, SubjectType: subjectType, Subject: subject, Feature: feature, CreatedBy: createdBy}
	err = s.db.QueryRow(
		`INSERT INTO feature_grants (id, subject_type, subject, feature, created_by) VALUES ($1,$2,$3,$4,$5)
		 ON CONFLICT (subject_type, subject, feature) DO UPDATE SET feature = EXCLUDED.feature
		 RETURNING id, created_by, created_at`, id, subjectType, subject, feature, createdBy).Scan(&g.ID, &g.CreatedBy, &g.CreatedAt)
	return g, err
}

// DeleteFeatureGrant nimmt eine Vergabe zurück.
func (s *Store) DeleteFeatureGrant(id string) error {
	res, err := s.db.Exec(`DELETE FROM feature_grants WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrFeatureNotFound
	}
	return nil
}

// DeleteFeatureGrantsBySubject räumt die Vergaben eines gelöschten Nutzers (oder einer gelöschten Gruppe) auf.
func (s *Store) DeleteFeatureGrantsBySubject(subjectType, subject string) error {
	_, err := s.db.Exec(`DELETE FROM feature_grants WHERE subject_type = $1 AND subject = $2`, subjectType, subject)
	return err
}

// grantedFeatures: alle Muster, die der Nutzer direkt oder über Gruppen besitzt.
func (s *Store) grantedFeatures(username string) ([]string, error) {
	rows, err := s.db.Query(
		`SELECT feature FROM feature_grants
		 WHERE (subject_type = 'user' AND subject = $1)
		    OR (subject_type = 'group' AND subject IN (SELECT group_id FROM group_members WHERE username = $1))`, username)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var f string
		if err := rows.Scan(&f); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// HasFeature: darf der Nutzer die Funktion `feature`? Ja bei globalem `configure` oder passender Vergabe.
func (s *Store) HasFeature(username, feature string) (bool, error) {
	if ok, err := s.Check(username, AnyNode, VerbConfigure); err != nil || ok {
		return ok, err
	}
	granted, err := s.grantedFeatures(username)
	if err != nil {
		return false, err
	}
	for _, g := range granted {
		if FeatureMatches(g, feature) {
			return true, nil
		}
	}
	return false, nil
}

// FeaturePatterns liefert die Vergabemuster des Nutzers; `all=true`, wenn er global `configure` hat (alles erlaubt).
func (s *Store) FeaturePatterns(username string) (patterns []string, all bool, err error) {
	if ok, err := s.Check(username, AnyNode, VerbConfigure); err != nil || ok {
		return nil, ok, err
	}
	patterns, err = s.grantedFeatures(username)
	return patterns, false, err
}

// GroupsOf liefert die Gruppen-IDs des Nutzers.
func (s *Store) GroupsOf(username string) ([]string, error) {
	rows, err := s.db.Query(`SELECT group_id FROM group_members WHERE username = $1 ORDER BY group_id`, username)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var g string
		if err := rows.Scan(&g); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}
