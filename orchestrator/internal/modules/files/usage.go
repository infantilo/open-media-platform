package files

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Reason ist ein Grund, der gegen das Löschen spricht (oder davor warnt).
type Reason struct {
	Kind    string `json:"kind"` // recording | qc | job | onair | playlist | published | approved | review
	Text    string `json:"text"`
	AssetID string `json:"assetId,omitempty"`
	Channel string `json:"channel,omitempty"`
}

// AssetRef nennt das Asset, zu dem eine Datei gehört.
type AssetRef struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Type    string `json:"type"`
	Status  string `json:"status"`
	RepID   string `json:"representationId"`
	RepType string `json:"representationType"`
	Version string `json:"versionId"`
}

// Usage fasst die Verwendung einer Datei zusammen (E4).
type Usage struct {
	// Absolute: nie umgehbar (läuft auf Sendung, wird geschrieben/gelesen).
	Absolute []Reason `json:"absolute"`
	// Hard: gesperrt (Sperrfenster/verplant) — nur mit „Erzwingen“.
	Hard []Reason `json:"hard"`
	// Soft: Warnung, ausdrückliche Bestätigung.
	Soft   []Reason   `json:"soft"`
	Assets []AssetRef `json:"assets"`
}

type repInfo struct {
	AssetRef
	URI            string
	VersionStatus  string
	CurrentVersion string
}

func missingTable(err error) bool {
	return err != nil && (strings.Contains(err.Error(), "does not exist") || strings.Contains(err.Error(), "undefined_table"))
}

// repsByURI liefert die Representations (Provider filesystem) mit genau diesen Pfaden samt Asset-Angaben.
func repsByURI(ctx context.Context, db *sql.DB, uris []string) (map[string][]repInfo, error) {
	out := map[string][]repInfo{}
	if len(uris) == 0 {
		return out, nil
	}
	rows, err := db.QueryContext(ctx, `
		SELECT r.id, r.type, r.uri, v.id, v.status, a.id, a.title, a.type, a.status, COALESCE(a.current_version_id, '')
		FROM representations r JOIN asset_versions v ON v.id = r.asset_version_id JOIN assets a ON a.id = v.asset_id
		WHERE r.storage_provider = 'filesystem' AND r.uri = ANY($1) AND a.status <> 'deleted'`, uris)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var ri repInfo
		if err := rows.Scan(&ri.RepID, &ri.RepType, &ri.URI, &ri.Version, &ri.VersionStatus, &ri.ID, &ri.Title, &ri.Type, &ri.Status, &ri.CurrentVersion); err != nil {
			return nil, err
		}
		ri.AssetRef.RepID, ri.AssetRef.RepType = ri.RepID, ri.RepType
		out[ri.URI] = append(out[ri.URI], ri)
	}
	return out, rows.Err()
}

func (m *Module) loadPlans(ctx context.Context) []planItem {
	db := m.db()
	if db == nil {
		return nil
	}
	rows, err := db.QueryContext(ctx, `SELECT c.name, s.state, s.updated_at FROM playout_state s JOIN playout_channels c ON c.id = s.channel_id`)
	if err != nil {
		return nil // Playout-Tabellen fehlen (Modul aus) oder nicht lesbar: keine Sperre aus Plänen
	}
	defer rows.Close()
	var out []planItem
	for rows.Next() {
		var name string
		var raw []byte
		var at time.Time
		if rows.Scan(&name, &raw, &at) == nil {
			out = append(out, extractPlans(name, raw, at.UnixMilli())...)
		}
	}
	return out
}

// activeUses: Dateien, die gerade geschrieben oder gelesen werden (absolute Sperre).
func activeUses(ctx context.Context, db *sql.DB, paths []string) (map[string][]Reason, error) {
	out := map[string][]Reason{}
	add := func(p string, r Reason) { out[p] = append(out[p], r) }
	q := func(query string, scan func(*sql.Rows)) error {
		rows, err := db.QueryContext(ctx, query, paths)
		if missingTable(err) {
			return nil
		}
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			scan(rows)
		}
		return rows.Err()
	}
	if err := q(`SELECT file_path, name FROM ingest_jobs WHERE state = 'recording' AND file_path = ANY($1)`, func(r *sql.Rows) {
		var p, n string
		if r.Scan(&p, &n) == nil {
			add(p, Reason{Kind: "recording", Text: fmt.Sprintf("wird gerade aufgenommen („%s“)", n)})
		}
	}); err != nil {
		return nil, err
	}
	if err := q(`SELECT DISTINCT r.uri, q.asset_id FROM qc_jobs q JOIN review_items i ON i.asset_id = q.asset_id JOIN representations r ON r.id = i.source_rep_id
		WHERE q.state IN ('queued','running') AND r.uri = ANY($1)`, func(r *sql.Rows) {
		var p, a string
		if r.Scan(&p, &a) == nil {
			add(p, Reason{Kind: "qc", AssetID: a, Text: "wird gerade geprüft (QC läuft oder wartet)"})
		}
	}); err != nil {
		return nil, err
	}
	if err := q(`SELECT e, j.state FROM jobrun_jobs j, jsonb_array_elements_text(COALESCE(j.data->'spec'->'inputs','[]'::jsonb) || COALESCE(j.data->'spec'->'outputs','[]'::jsonb)) e
		WHERE j.state IN ('running','queued') AND e = ANY($1)`, func(r *sql.Rows) {
		var p, st string
		if r.Scan(&p, &st) == nil {
			add(p, Reason{Kind: "job", Text: "ein ffmpeg-Job liest oder schreibt die Datei (" + st + ")"})
		}
	}); err != nil {
		return nil, err
	}
	return out, nil
}

// UsageFor ermittelt die Verwendung für absolute Pfade. root (optional) liefert die Sperrfenster-Überschreibung der Wurzel.
func (m *Module) UsageFor(ctx context.Context, paths []string, root *Root) (map[string]*Usage, error) {
	db := m.db()
	if db == nil {
		return nil, fmt.Errorf("files: keine Datenbank")
	}
	cfg := m.Config()
	now := time.Now()
	reps, err := repsByURI(ctx, db, paths)
	if err != nil {
		return nil, err
	}
	active, err := activeUses(ctx, db, paths)
	if err != nil {
		return nil, err
	}
	plans := m.loadPlans(ctx)
	out := map[string]*Usage{}
	for _, p := range paths {
		u := &Usage{Absolute: []Reason{}, Hard: []Reason{}, Soft: []Reason{}, Assets: []AssetRef{}}
		out[p] = u
		u.Absolute = append(u.Absolute, active[p]...)
		assetIDs := map[string]string{}
		var assetType string
		for _, ri := range reps[p] {
			u.Assets = append(u.Assets, ri.AssetRef)
			assetIDs[ri.ID] = ri.Title
			if assetType == "" {
				assetType = ri.Type
			}
			switch {
			case ri.VersionStatus == "published":
				u.Soft = append(u.Soft, Reason{Kind: "published", AssetID: ri.ID, Text: fmt.Sprintf("Teil einer veröffentlichten Version von „%s“", ri.Title)})
			case ri.Status == "approved" || ri.Status == "published":
				u.Soft = append(u.Soft, Reason{Kind: "approved", AssetID: ri.ID, Text: fmt.Sprintf("Asset „%s“ ist freigegeben/veröffentlicht", ri.Title)})
			case ri.Status == "in_review":
				u.Soft = append(u.Soft, Reason{Kind: "review", AssetID: ri.ID, Text: fmt.Sprintf("Asset „%s“ ist im Eingang in Bearbeitung", ri.Title)})
			}
		}
		before, after := cfg.LockWindow(root, assetType)
		for _, pl := range plans {
			if !(pathMatches(pl.Path, p) || (pl.AssetID != "" && assetIDs[pl.AssetID] != "")) {
				continue
			}
			lv, txt := lockLevel(pl, now, before, after, cfg.PlannedIsHard)
			r := Reason{Kind: "playlist", Channel: pl.Channel, Text: txt}
			switch lv {
			case levelAbsolute:
				r.Kind = "onair"
				u.Absolute = append(u.Absolute, r)
			case levelHard:
				u.Hard = append(u.Hard, r)
			case levelSoft:
				u.Soft = append(u.Soft, r)
			}
		}
		u.Absolute, u.Hard, u.Soft = dedupReasons(u.Absolute), dedupReasons(u.Hard), dedupReasons(u.Soft)
	}
	return out, nil
}

func dedupReasons(in []Reason) []Reason {
	seen := map[string]bool{}
	out := make([]Reason, 0, len(in))
	for _, r := range in {
		if k := r.Kind + "|" + r.Text; !seen[k] {
			seen[k] = true
			out = append(out, r)
		}
	}
	return out
}

// FamilyMember ist eine zu einem Asset gehörende Datei (E8).
type FamilyMember struct {
	Path    string `json:"path"` // absolut
	Role    string `json:"role"` // Rolle: Representation-Typ, proxy, subtitle
	AssetID string `json:"assetId"`
	Title   string `json:"title,omitempty"`
	RepID   string `json:"representationId,omitempty"`
}

// FamilyOf liefert alle Dateien der genannten Assets: Representations aller Versionen, Untertitel und Review-Proxys.
func (m *Module) FamilyOf(ctx context.Context, assetIDs []string) (map[string][]FamilyMember, error) {
	db := m.db()
	out := map[string][]FamilyMember{}
	if db == nil || len(assetIDs) == 0 {
		return out, nil
	}
	rows, err := db.QueryContext(ctx, `
		SELECT a.id, a.title, r.id, r.type, r.uri FROM representations r JOIN asset_versions v ON v.id = r.asset_version_id JOIN assets a ON a.id = v.asset_id
		WHERE a.id = ANY($1) AND r.storage_provider = 'filesystem'`, assetIDs)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var f FamilyMember
		if rows.Scan(&f.AssetID, &f.Title, &f.RepID, &f.Role, &f.Path) == nil {
			out[f.AssetID] = append(out[f.AssetID], f)
		}
	}
	rows.Close()
	srows, err := db.QueryContext(ctx, `SELECT asset_id, path, playout_path FROM review_subtitles WHERE asset_id = ANY($1)`, assetIDs)
	if err == nil {
		for srows.Next() {
			var a, p1, p2 string
			if srows.Scan(&a, &p1, &p2) == nil {
				for _, p := range []string{p1, p2} {
					if p != "" {
						out[a] = append(out[a], FamilyMember{Path: p, Role: RoleSubtitle, AssetID: a})
					}
				}
			}
		}
		srows.Close()
	} else if !missingTable(err) {
		return nil, err
	}
	for a := range out {
		out[a] = dedupFamily(out[a])
	}
	return out, nil
}

func dedupFamily(in []FamilyMember) []FamilyMember {
	seen := map[string]bool{}
	out := make([]FamilyMember, 0, len(in))
	for _, f := range in {
		if !seen[f.Path] {
			seen[f.Path] = true
			out = append(out, f)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

// proxyAssetID erkennt Review-Proxys: <…>/proxies/<assetId>/<id>.mp4.
func proxyAssetID(abs string) string {
	d := filepath.Dir(abs)
	if filepath.Base(filepath.Dir(d)) == "proxies" {
		return filepath.Base(d)
	}
	return ""
}
