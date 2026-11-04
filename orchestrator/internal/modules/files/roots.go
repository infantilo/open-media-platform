package files

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
)

// Rollen einer Wurzel (E8).
const (
	RoleMedia     = "media"
	RoleImport    = "import"
	RoleProxy     = "proxy"
	RoleSubtitle  = "subtitle"
	RoleRecording = "recording"
	RoleOutput    = "output"
	RoleOther     = "other"
)

var validRoles = map[string]bool{RoleMedia: true, RoleImport: true, RoleProxy: true, RoleSubtitle: true, RoleRecording: true, RoleOutput: true, RoleOther: true}

// Root ist ein Explorer-Ort: ein benannter Speicherort (storage_locations) plus Dateiverwaltungs-Einstellungen.
type Root struct {
	ID               string   `json:"id"`
	Name             string   `json:"name"`
	HostID           string   `json:"hostId"`
	Path             string   `json:"path"`
	Role             string   `json:"role"`
	ReadOnly         bool     `json:"readOnly"`
	TrashDays        *int     `json:"trashDays,omitempty"`
	EmergencyFreeGB  *float64 `json:"emergencyFreeGb,omitempty"`
	EmergencyFreePct *float64 `json:"emergencyFreePct,omitempty"`
	LockBeforeH      *float64 `json:"lockBeforeH,omitempty"`
	LockAfterH       *float64 `json:"lockAfterH,omitempty"`
}

const rootCols = `l.id, l.name, l.host_id, l.path, f.role, f.read_only, f.trash_days, f.emergency_free_gb, f.emergency_free_pct, f.lock_before_h, f.lock_after_h`

func scanRoot(row interface{ Scan(...any) error }) (Root, error) {
	var r Root
	var td sql.NullInt64
	var gb, pct, lb, la sql.NullFloat64
	if err := row.Scan(&r.ID, &r.Name, &r.HostID, &r.Path, &r.Role, &r.ReadOnly, &td, &gb, &pct, &lb, &la); err != nil {
		return Root{}, err
	}
	if td.Valid {
		v := int(td.Int64)
		r.TrashDays = &v
	}
	f := func(n sql.NullFloat64) *float64 {
		if !n.Valid {
			return nil
		}
		v := n.Float64
		return &v
	}
	r.EmergencyFreeGB, r.EmergencyFreePct, r.LockBeforeH, r.LockAfterH = f(gb), f(pct), f(lb), f(la)
	return r, nil
}

// ErrNotFound: Wurzel unbekannt.
var ErrNotFound = errors.New("files: Wurzel nicht gefunden")

// ListRoots liefert alle Wurzeln (aktive Speicherorte mit Explorer-Einstellungen), nach Name.
func ListRoots(ctx context.Context, db *sql.DB) ([]Root, error) {
	rows, err := db.QueryContext(ctx, `SELECT `+rootCols+` FROM file_roots f JOIN storage_locations l ON l.id = f.location_id WHERE l.status = 'active' ORDER BY l.name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Root{}
	for rows.Next() {
		r, err := scanRoot(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// GetRoot liest eine Wurzel.
func GetRoot(ctx context.Context, db *sql.DB, id string) (Root, error) {
	r, err := scanRoot(db.QueryRowContext(ctx, `SELECT `+rootCols+` FROM file_roots f JOIN storage_locations l ON l.id = f.location_id WHERE l.id = $1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Root{}, ErrNotFound
	}
	return r, err
}

// SaveRootSettings legt die Explorer-Einstellungen zu einem vorhandenen Speicherort an oder ändert sie.
func SaveRootSettings(ctx context.Context, db *sql.DB, r Root) error {
	if r.Role == "" {
		r.Role = RoleMedia
	}
	if !validRoles[r.Role] {
		return fmt.Errorf("Rolle %q unbekannt", r.Role)
	}
	if r.TrashDays != nil && (*r.TrashDays < 0 || *r.TrashDays > 3650) {
		return fmt.Errorf("trashDays 0–3650")
	}
	for _, p := range []*float64{r.EmergencyFreeGB, r.EmergencyFreePct, r.LockBeforeH, r.LockAfterH} {
		if p != nil && *p < 0 {
			return fmt.Errorf("Werte dürfen nicht negativ sein")
		}
	}
	_, err := db.ExecContext(ctx, `
		INSERT INTO file_roots (location_id, role, read_only, trash_days, emergency_free_gb, emergency_free_pct, lock_before_h, lock_after_h)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		ON CONFLICT (location_id) DO UPDATE SET role=$2, read_only=$3, trash_days=$4, emergency_free_gb=$5, emergency_free_pct=$6, lock_before_h=$7, lock_after_h=$8`,
		r.ID, r.Role, r.ReadOnly, r.TrashDays, r.EmergencyFreeGB, r.EmergencyFreePct, r.LockBeforeH, r.LockAfterH)
	return err
}

// RemoveRoot nimmt eine Wurzel aus dem Explorer (der Speicherort selbst bleibt bestehen).
func RemoveRoot(ctx context.Context, db *sql.DB, id string) error {
	_, err := db.ExecContext(ctx, `DELETE FROM file_roots WHERE location_id = $1`, id)
	return err
}

// Under: abs liegt unter der Wurzel; liefert den wurzelrelativen Pfad (mit „/“).
func (r Root) Under(abs string) (string, bool) {
	root := filepath.Clean(r.Path)
	abs = filepath.Clean(abs)
	if abs == root {
		return "", true
	}
	if strings.HasPrefix(abs, root+string(filepath.Separator)) {
		return filepath.ToSlash(abs[len(root)+1:]), true
	}
	return "", false
}

// Abs: absoluter Pfad auf dem Host der Wurzel.
func (r Root) Abs(rel string) string { return filepath.Join(r.Path, filepath.FromSlash(rel)) }

// MatchRoots liefert alle Wurzeln, unter denen abs liegt (längster Wurzelpfad zuerst), mit dem relativen Pfad.
func MatchRoots(roots []Root, abs string) []RootMatch {
	var out []RootMatch
	for _, r := range roots {
		if rel, ok := r.Under(abs); ok && rel != "" {
			out = append(out, RootMatch{Root: r, Rel: rel})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return len(out[i].Root.Path) > len(out[j].Root.Path) })
	return out
}

// RootMatch ordnet einen Pfad einer Wurzel zu.
type RootMatch struct {
	Root Root
	Rel  string
}
