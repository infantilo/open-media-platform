package files

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/jobwire"
)

// Dateizustände (abgeleitet, nicht Teil des Asset-Lebenszyklus).
const (
	StatePresent     = "present"
	StateMissing     = "missing"
	StateUnreachable = "unreachable"
	StateUnknown     = "unknown"
)

type repRow struct {
	RepID, AssetID, AssetTitle, AssetType, Provider, URI, BackendID string
}

// observation ist das Ergebnis einer einzelnen Prüfung.
type observation struct {
	State   string
	Size    int64
	MTimeMs int64
	HostID  string
	RootID  string
	Rel     string
	Detail  string
}

func (m *Module) hostOp(hostID string, op jobwire.FileOp) ([]byte, error) {
	if m.Hosts == nil {
		return nil, fmt.Errorf("keine Host-Anbindung")
	}
	return m.Hosts.FileOp(hostID, op)
}

type cand struct {
	root          *Root // nil = Ordner ohne eingerichteten Ort (wird auf dem Orchestrator-Rechner geprüft)
	rootPath, rel string
	adhoc         bool
}

func (c cand) host() string {
	if c.root != nil {
		return c.root.HostID
	}
	return ""
}

func (c cand) rootID() string {
	if c.root != nil {
		return c.root.ID
	}
	return ""
}

func (c cand) key() string {
	if c.root != nil {
		return "r:" + c.root.ID
	}
	return "d:" + c.rootPath
}

type statRes struct {
	st  jobwire.FileStat
	err string
}

// ObserveReps prüft die Dateien der Representations (Stapel). Pfade ohne Wurzel werden auf dem Orchestrator-Rechner im Ordner der
// Datei geprüft; ist ein Host/Ordner nicht erreichbar, gilt das als „nicht erreichbar“ (nie als „fehlt“), außer der Ordner fehlt auf dem
// Orchestrator selbst.
func (m *Module) ObserveReps(ctx context.Context, roots []Root, reps []repRow) map[string]observation {
	out := map[string]observation{}
	cands := map[string][]cand{}
	groups := map[string][]string{} // key → rels
	groupCand := map[string]cand{}
	for _, r := range reps {
		switch r.Provider {
		case "filesystem":
		case "s3", "minio":
			out[r.RepID] = m.observeObject(ctx, r)
			continue
		default:
			out[r.RepID] = observation{State: StateUnknown, Detail: "Speicher „" + r.Provider + "“ wird nicht geprüft"}
			continue
		}
		abs := strings.TrimPrefix(r.URI, "file://")
		if !filepath.IsAbs(abs) {
			out[r.RepID] = observation{State: StateUnknown, Detail: "relativer Pfad — keinem Ort zuordenbar"}
			continue
		}
		var cs []cand
		for _, mt := range MatchRoots(roots, abs) {
			root := mt.Root
			cs = append(cs, cand{root: &root, rootPath: root.Path, rel: mt.Rel})
		}
		if len(cs) == 0 {
			cs = append(cs, cand{rootPath: filepath.Dir(abs), rel: filepath.Base(abs), adhoc: true})
		}
		cands[r.RepID] = cs
		for _, c := range cs {
			groups[c.key()] = append(groups[c.key()], c.rel)
			groupCand[c.key()] = c
		}
	}
	results := map[string]map[string]statRes{} // key → rel → Ergebnis
	groupErr := map[string]string{}
	for key, rels := range groups {
		c := groupCand[key]
		results[key] = map[string]statRes{}
		for i := 0; i < len(rels); i += 1000 {
			end := min(i+1000, len(rels))
			op := jobwire.FileOp{Op: jobwire.FileOpStat, Root: c.rootPath, Rels: rels[i:end]}
			var raw []byte
			var err error
			if c.root != nil {
				raw, err = m.rootOp(*c.root, op)
			} else {
				raw, err = m.hostOp("", op)
			}
			if err != nil {
				groupErr[key] = err.Error()
				break
			}
			var sts []jobwire.FileStat
			if json.Unmarshal(raw, &sts) != nil {
				groupErr[key] = "unlesbare Antwort"
				break
			}
			for _, s := range sts {
				results[key][s.Rel] = statRes{st: s}
			}
		}
	}
	for _, r := range reps {
		cs, ok := cands[r.RepID]
		if !ok {
			continue
		}
		obs := observation{State: StateMissing}
		var unreachable []string
		found := false
		for _, c := range cs {
			if e := groupErr[c.key()]; e != "" {
				if c.adhoc && strings.Contains(e, "Wurzel nicht erreichbar") {
					continue // Ordner fehlt auf dem Orchestrator: Datei fehlt
				}
				unreachable = append(unreachable, c.label()+": "+e)
				continue
			}
			s := results[c.key()][c.rel]
			switch {
			case s.st.Exists:
				obs = observation{State: StatePresent, Size: s.st.Size, MTimeMs: s.st.MTime, HostID: c.host(), RootID: c.rootID(), Rel: c.rel}
				found = true
			case s.st.Err != "":
				unreachable = append(unreachable, c.label()+": "+s.st.Err)
			}
			if found {
				break
			}
		}
		if !found {
			c := cs[0]
			obs.HostID, obs.RootID, obs.Rel = c.host(), c.rootID(), c.rel
			if len(unreachable) > 0 {
				obs.State, obs.Detail = StateUnreachable, strings.Join(unreachable, "; ")
			} else if c.adhoc {
				obs.Detail = "nicht gefunden (kein Speicherort für diesen Pfad angelegt — geprüft auf dem Orchestrator-Rechner)"
			} else {
				obs.Detail = "nicht gefunden in Ort „" + c.root.Name + "“"
			}
		}
		out[r.RepID] = obs
	}
	return out
}

func (c cand) label() string {
	if c.root != nil {
		return "Ort „" + c.root.Name + "“"
	}
	return hostLabel("")
}

func hostLabel(h string) string {
	if h == "" {
		return "Orchestrator-Rechner"
	}
	return "Host " + h
}

func (m *Module) observeObject(ctx context.Context, r repRow) observation {
	if m.ObjectHead == nil {
		return observation{State: StateUnknown, Detail: "Objektspeicher wird nicht geprüft"}
	}
	c, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	ok, size, err := m.ObjectHead(c, r.BackendID, r.URI)
	switch {
	case err != nil:
		return observation{State: StateUnreachable, Detail: err.Error()}
	case ok:
		return observation{State: StatePresent, Size: size}
	}
	return observation{State: StateMissing, Detail: "Objekt nicht gefunden"}
}

const repSelect = `SELECT r.id, a.id, a.title, a.type, r.storage_provider, r.uri, COALESCE(r.storage_backend_id, '')
	FROM representations r JOIN asset_versions v ON v.id = r.asset_version_id JOIN assets a ON a.id = v.asset_id`

func scanReps(rows *sql.Rows) ([]repRow, error) {
	defer rows.Close()
	var out []repRow
	for rows.Next() {
		var r repRow
		if err := rows.Scan(&r.RepID, &r.AssetID, &r.AssetTitle, &r.AssetType, &r.Provider, &r.URI, &r.BackendID); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// CheckDue prüft einen Stapel Representations, deren letzte Prüfung länger als CheckEveryMin zurückliegt (oder nie war).
func (m *Module) CheckDue(ctx context.Context, cfg Config) error {
	db := m.db()
	rows, err := db.QueryContext(ctx, repSelect+`
		LEFT JOIN representation_health h ON h.representation_id = r.id
		WHERE a.status <> 'deleted' AND (h.checked_at IS NULL OR h.checked_at < now() - make_interval(mins => $1))
		ORDER BY h.checked_at NULLS FIRST LIMIT $2`, cfg.CheckEveryMin, cfg.CheckBatch)
	if err != nil {
		return err
	}
	reps, err := scanReps(rows)
	if err != nil || len(reps) == 0 {
		return err
	}
	return m.CheckReps(ctx, reps, "")
}

// CheckAsset prüft sofort alle Dateien eines Assets (beim Öffnen/„Jetzt prüfen“).
func (m *Module) CheckAsset(ctx context.Context, assetID, actor string) error {
	rows, err := m.db().QueryContext(ctx, repSelect+` WHERE a.id = $1`, assetID)
	if err != nil {
		return err
	}
	reps, err := scanReps(rows)
	if err != nil || len(reps) == 0 {
		return err
	}
	return m.CheckReps(ctx, reps, actor)
}

// CheckReps prüft und schreibt die Zustände; meldet bestätigte Zustandswechsel (E7).
func (m *Module) CheckReps(ctx context.Context, reps []repRow, actor string) error {
	db := m.db()
	roots, err := ListRoots(ctx, db)
	if err != nil {
		return err
	}
	obs := m.ObserveReps(ctx, roots, reps)
	for _, r := range reps {
		o, ok := obs[r.RepID]
		if !ok {
			continue
		}
		if err := m.record(ctx, r, o); err != nil {
			return err
		}
	}
	return nil
}

// record schreibt eine Beobachtung (Zweiprüfung für „fehlt“) und löst Benachrichtigungen aus.
func (m *Module) record(ctx context.Context, r repRow, o observation) error {
	db := m.db()
	var prevState, notified string
	var miss int
	var since time.Time
	err := db.QueryRowContext(ctx, `SELECT state, miss_count, since, notified_state FROM representation_health WHERE representation_id = $1`, r.RepID).Scan(&prevState, &miss, &since, &notified)
	had := err == nil
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	eff := o.State
	if o.State == StateMissing {
		miss++
		if had && prevState == StatePresent && miss < 2 {
			eff = StatePresent // erst die zweite Prüfung bestätigt „fehlt“ (Netzlaufwerk kurz weg?)
			o.Detail = "Datei beim letzten Lauf nicht gefunden — wird erneut geprüft"
		}
	} else {
		miss = 0
	}
	now := time.Now()
	if !had || eff != prevState {
		since = now
	}
	var size, mtime any
	if o.State == StatePresent {
		size, mtime = o.Size, o.MTimeMs
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO representation_health (representation_id, asset_id, state, miss_count, size_bytes, mtime_ms, host_id, root_id, rel, detail, checked_at, since)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11)
		ON CONFLICT (representation_id) DO UPDATE SET asset_id=$2, state=$3, miss_count=$4, size_bytes=$5, mtime_ms=$6, host_id=$7, root_id=$8, rel=$9, detail=$10, checked_at=now(), since=$11`,
		r.RepID, r.AssetID, eff, miss, size, mtime, o.HostID, o.RootID, o.Rel, o.Detail, since); err != nil {
		return err
	}
	switch {
	case eff == StateMissing && miss >= 2 && notified != StateMissing:
		m.notifyMissing(ctx, r, o)
		_, _ = db.ExecContext(ctx, `UPDATE representation_health SET notified_state = 'missing' WHERE representation_id = $1`, r.RepID)
	case eff == StatePresent && notified == StateMissing:
		m.alert("file-recovered", "info", r.AssetID, r.AssetTitle, fmt.Sprintf("Datei von „%s“ ist wieder vorhanden: %s", r.AssetTitle, r.URI))
		m.event("omp.files.recovered", map[string]any{"assetId": r.AssetID, "representationId": r.RepID, "uri": r.URI})
		m.audit("system", "asset", r.AssetID, "file.recovered", map[string]any{"uri": r.URI})
		_, _ = db.ExecContext(ctx, `UPDATE representation_health SET notified_state = '' WHERE representation_id = $1`, r.RepID)
	}
	return nil
}

// notifyMissing meldet „Datei fehlt“ über alle Wege; kritisch, wenn die Datei gesperrt/verplant ist (Nähe zur Sendung).
func (m *Module) notifyMissing(ctx context.Context, r repRow, o observation) {
	sev := "warning"
	extra := ""
	if u, err := m.UsageFor(ctx, []string{strings.TrimPrefix(r.URI, "file://")}, nil); err == nil {
		for _, uu := range u {
			if len(uu.Absolute) > 0 || len(uu.Hard) > 0 {
				sev = "critical"
				all := append(append([]Reason{}, uu.Absolute...), uu.Hard...)
				extra = " — Achtung: " + all[0].Text
			}
		}
	}
	msg := fmt.Sprintf("Datei von „%s“ fehlt: %s%s", r.AssetTitle, r.URI, extra)
	m.alert("file-missing", sev, r.AssetID, r.AssetTitle, msg)
	m.event("omp.files.missing", map[string]any{"assetId": r.AssetID, "representationId": r.RepID, "uri": r.URI, "severity": sev})
	m.audit("system", "asset", r.AssetID, "file.missing", map[string]any{"uri": r.URI, "severity": sev, "detail": o.Detail})
}

// AssetFileState: Zusammenfassung je Asset für den Filter.
type AssetFileState struct {
	AssetID string `json:"assetId"`
	State   string `json:"state"` // ok | missing | partial | unreachable | unchecked | none
	Total   int    `json:"total"`
	Missing int    `json:"missing"`
}

// AssetStates liefert den Dateizustand aller (nicht gelöschten) Assets: none = keine Representation, unchecked = nie geprüft,
// missing = alle fehlen, partial = einige fehlen, unreachable = nichts fehlt, aber etwas ist nicht erreichbar, ok = alles da.
func (m *Module) AssetStates(ctx context.Context) ([]AssetFileState, error) {
	rows, err := m.db().QueryContext(ctx, `
		SELECT a.id, count(r.id), count(h.representation_id),
		       count(*) FILTER (WHERE h.state = 'missing'), count(*) FILTER (WHERE h.state = 'unreachable'), count(*) FILTER (WHERE h.state = 'present')
		FROM assets a LEFT JOIN asset_versions v ON v.asset_id = a.id LEFT JOIN representations r ON r.asset_version_id = v.id
		LEFT JOIN representation_health h ON h.representation_id = r.id
		WHERE a.status <> 'deleted' GROUP BY a.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AssetFileState{}
	for rows.Next() {
		var s AssetFileState
		var checked, unreach, present int
		if err := rows.Scan(&s.AssetID, &s.Total, &checked, &s.Missing, &unreach, &present); err != nil {
			return nil, err
		}
		s.State = classify(s.Total, checked, s.Missing, unreach, present)
		out = append(out, s)
	}
	return out, rows.Err()
}

func classify(total, checked, missing, unreach, present int) string {
	switch {
	case total == 0:
		return "none"
	case missing > 0 && present == 0 && unreach == 0 && missing == total:
		return "missing"
	case missing > 0:
		return "partial"
	case unreach > 0:
		return "unreachable"
	case checked < total:
		return "unchecked"
	}
	return "ok"
}
