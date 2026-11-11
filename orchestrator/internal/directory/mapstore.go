package directory

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

// Mapping verbindet eine Verzeichnisgruppe (DN oder CN) mit einer OMP-Gruppe.
type Mapping struct {
	LDAPGroup string `json:"ldapGroup"`
	GroupID   string `json:"groupId"`
}

// ErrMappingInvalid: leere Angabe oder unbekannte OMP-Gruppe.
var ErrMappingInvalid = errors.New("directory: mapping invalid")

// MapStore pflegt ldap_group_map und führt Mitgliedschaften nach.
type MapStore struct {
	db *sql.DB
	// OnChange: nach geänderten Mitgliedschaften (verwirft den Rechte-Cache).
	OnChange func()
}

func NewMapStore(db *sql.DB) *MapStore { return &MapStore{db: db} }

func (m *MapStore) List(ctx context.Context) ([]Mapping, error) {
	rows, err := m.db.QueryContext(ctx, `SELECT ldap_group, group_id FROM ldap_group_map ORDER BY ldap_group, group_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Mapping{}
	for rows.Next() {
		var x Mapping
		if err := rows.Scan(&x.LDAPGroup, &x.GroupID); err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

func (m *MapStore) Add(ctx context.Context, ldapGroup, groupID string) error {
	ldapGroup = strings.TrimSpace(ldapGroup)
	if ldapGroup == "" || groupID == "" {
		return ErrMappingInvalid
	}
	var one int
	if err := m.db.QueryRowContext(ctx, `SELECT 1 FROM groups WHERE id = $1`, groupID).Scan(&one); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrMappingInvalid
		}
		return err
	}
	_, err := m.db.ExecContext(ctx, `INSERT INTO ldap_group_map (ldap_group, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, ldapGroup, groupID)
	return err
}

// Remove entfernt die Zuordnung. Bereits nachgeführte Mitgliedschaften bleiben bis zur nächsten
// Anmeldung des Nutzers bestehen; danach wird die Gruppe nicht mehr vom Verzeichnis verwaltet.
func (m *MapStore) Remove(ctx context.Context, ldapGroup, groupID string) error {
	_, err := m.db.ExecContext(ctx, `DELETE FROM ldap_group_map WHERE ldap_group = $1 AND group_id = $2`, ldapGroup, groupID)
	return err
}

// Sync führt die Mitgliedschaften von username in allen abgebildeten OMP-Gruppen nach: Mitglied, wenn
// eine zugeordnete Verzeichnisgruppe in id.Groups steht, sonst entfernt. Gruppen ohne Zuordnung bleiben
// unberührt. Gibt zurück, ob sich etwas geändert hat.
func (m *MapStore) Sync(ctx context.Context, username string, id Identity) (bool, error) {
	maps, err := m.List(ctx)
	if err != nil {
		return false, err
	}
	want := map[string]bool{} // group_id -> soll Mitglied sein
	for _, x := range maps {
		if id.InGroup(x.LDAPGroup) {
			want[x.GroupID] = true
		} else if _, set := want[x.GroupID]; !set {
			want[x.GroupID] = false
		}
	}
	changed := false
	for gid, member := range want {
		var res sql.Result
		if member {
			res, err = m.db.ExecContext(ctx, `INSERT INTO group_members (group_id, username) VALUES ($1, $2) ON CONFLICT DO NOTHING`, gid, username)
		} else {
			res, err = m.db.ExecContext(ctx, `DELETE FROM group_members WHERE group_id = $1 AND username = $2`, gid, username)
		}
		if err != nil {
			return changed, err
		}
		if n, _ := res.RowsAffected(); n > 0 {
			changed = true
		}
	}
	if changed && m.OnChange != nil {
		m.OnChange()
	}
	return changed, nil
}
