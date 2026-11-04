package files

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/jobwire"
)

func (m *Module) rootDF(root Root) (jobwire.DFResult, error) {
	raw, err := m.hostOp(root.HostID, jobwire.FileOp{Op: jobwire.FileOpDF, Root: root.Path})
	if err != nil {
		return jobwire.DFResult{}, err
	}
	var df jobwire.DFResult
	return df, json.Unmarshal(raw, &df)
}

func (m *Module) purgeOp(root Root, op jobwire.FileOp) (jobwire.PurgeResult, error) {
	op.Op, op.Root = jobwire.FileOpPurge, root.Path
	raw, err := m.hostOp(root.HostID, op)
	if err != nil {
		return jobwire.PurgeResult{}, err
	}
	var pr jobwire.PurgeResult
	return pr, json.Unmarshal(raw, &pr)
}

// Sweep pflegt die Papierkörbe: abgelaufene Einträge endgültig löschen; bei knappem Speicher früher leeren (E3).
func (m *Module) Sweep(ctx context.Context, cfg Config) {
	roots, err := ListRoots(ctx, m.db())
	if err != nil {
		slog.Warn("files: Orte nicht lesbar", "error", err)
		return
	}
	for _, r := range roots {
		if r.ReadOnly || ctx.Err() != nil {
			continue
		}
		ret := cfg.TrashRetention(r)
		if pr, err := m.purgeOp(r, jobwire.FileOp{OlderThanMs: time.Now().Add(-ret).UnixMilli()}); err != nil {
			slog.Debug("files: Papierkorb-Pflege nicht möglich", "root", r.Name, "error", err)
			continue
		} else if pr.Removed > 0 {
			m.audit("system", "file-root", r.ID, "file.trash.expired", map[string]any{"removed": pr.Removed, "freedBytes": pr.FreedBytes, "root": r.Name})
		}
		df, err := m.rootDF(r)
		if err != nil || df.Total <= 0 {
			continue
		}
		want := cfg.EmergencyFree(r, df.Total)
		if want <= 0 || df.Free >= want {
			continue
		}
		keep := time.Now().Add(-time.Duration(cfg.GraceMinutes) * time.Minute).UnixMilli()
		pr, err := m.purgeOp(r, jobwire.FileOp{FreeBytes: want, KeepNewerThanMs: keep})
		if err != nil {
			continue
		}
		msg := fmt.Sprintf("Speicher von „%s“ knapp (%s frei, Grenze %s)", r.Name, humanBytes(df.Free), humanBytes(want))
		if pr.Removed > 0 {
			msg += fmt.Sprintf(" — Papierkorb vorzeitig geleert: %d Einträge, %s freigegeben, jetzt %s frei", pr.Removed, humanBytes(pr.FreedBytes), humanBytes(pr.FreeNow))
		} else {
			msg += " — der Papierkorb enthält nichts Löschbares; bitte Platz schaffen"
		}
		m.alert("file-trash-emergency", "warning", r.ID, r.Name, msg)
		m.audit("system", "file-root", r.ID, "file.trash.emergency", map[string]any{"removed": pr.Removed, "freedBytes": pr.FreedBytes, "freeBefore": df.Free, "want": want, "root": r.Name})
		m.event("omp.files.trash-emergency", map[string]any{"root": r.Name, "freeBytes": pr.FreeNow, "removed": pr.Removed})
	}
}

func humanBytes(n int64) string {
	f := float64(n)
	for _, u := range []string{"B", "KB", "MB", "GB", "TB"} {
		if f < 1024 || u == "TB" {
			return fmt.Sprintf("%.1f %s", f, u)
		}
		f /= 1024
	}
	return ""
}

// ---- Löschen: Vorschau und Ausführung -----------------------------------------------------------------------------

// DeleteRequest: rel-Pfade in einer Wurzel.
type DeleteRequest struct {
	RootID     string   `json:"root"`
	Paths      []string `json:"paths"`
	WithFamily bool     `json:"withFamily"`
	Confirm    bool     `json:"confirm"` // weiche Hinweise bestätigt
	Force      bool     `json:"force"`   // harte Sperre umgehen (Recht files.force, Begründung Pflicht)
	Reason     string   `json:"reason"`
}

// DeleteItem ist eine Zeile der Vorschau/des Ergebnisses.
type DeleteItem struct {
	RootID   string `json:"rootId"`
	RootName string `json:"rootName"`
	Rel      string `json:"rel"`
	Abs      string `json:"abs"`
	Role     string `json:"role,omitempty"`
	Derived  bool   `json:"derived,omitempty"` // zur Familie hinzugenommen
	Usage    *Usage `json:"usage,omitempty"`
	Note     string `json:"note,omitempty"`
	Status   string `json:"status"` // ok | blocked | locked | confirm | skipped | error | deleted
	Error    string `json:"error,omitempty"`
	TrashID  string `json:"trashId,omitempty"`
	host     string
	root     Root
}

// DeletePlan ist die Vorschau: Einträge samt Familie und Verwendung.
type DeletePlan struct {
	Items []DeleteItem `json:"items"`
	// Blocked: mindestens ein Eintrag ist absolut gesperrt; NeedsForce: harte Sperre; NeedsConfirm: weiche Hinweise.
	Blocked      bool `json:"blocked"`
	NeedsForce   bool `json:"needsForce"`
	NeedsConfirm bool `json:"needsConfirm"`
}

// PlanDelete ermittelt die zu löschenden Dateien (optional mit Familie) und prüft deren Verwendung.
func (m *Module) PlanDelete(ctx context.Context, req DeleteRequest) (DeletePlan, error) {
	db := m.db()
	roots, err := ListRoots(ctx, db)
	if err != nil {
		return DeletePlan{}, err
	}
	byID := map[string]Root{}
	for _, r := range roots {
		byID[r.ID] = r
	}
	root, ok := byID[req.RootID]
	if !ok {
		return DeletePlan{}, ErrNotFound
	}
	if len(req.Paths) == 0 || len(req.Paths) > 500 {
		return DeletePlan{}, fmt.Errorf("1–500 Pfade angeben")
	}
	var items []DeleteItem
	seen := map[string]bool{}
	add := func(r Root, rel string, derived bool, role string) {
		abs := r.Abs(rel)
		if seen[r.ID+"|"+rel] {
			return
		}
		seen[r.ID+"|"+rel] = true
		items = append(items, DeleteItem{RootID: r.ID, RootName: r.Name, Rel: rel, Abs: abs, Derived: derived, Role: role, root: r, host: r.HostID})
	}
	for _, p := range req.Paths {
		rel, err := jobwire.CleanRel(p, false)
		if err != nil {
			return DeletePlan{}, err
		}
		add(root, rel, false, "")
	}
	if req.WithFamily {
		abss := make([]string, len(items))
		for i, it := range items {
			abss[i] = it.Abs
		}
		reps, err := repsByURI(ctx, db, abss)
		if err != nil {
			return DeletePlan{}, err
		}
		var assetIDs []string
		for _, rs := range reps {
			for _, ri := range rs {
				assetIDs = append(assetIDs, ri.ID)
			}
		}
		for _, it := range items {
			if a := proxyAssetID(it.Abs); a != "" {
				assetIDs = append(assetIDs, a)
			}
		}
		fam, err := m.FamilyOf(ctx, assetIDs)
		if err != nil {
			return DeletePlan{}, err
		}
		for _, a := range assetIDs {
			for _, f := range fam[a] {
				for _, mt := range MatchRoots(roots, f.Path) {
					if mt.Root.ID == root.ID || mt.Root.HostID == root.HostID {
						add(mt.Root, mt.Rel, true, f.Role)
						break
					}
				}
			}
			for _, f := range m.proxyMembers(roots, a) {
				add(f.root, f.rel, true, "proxy")
			}
		}
	}
	abss := make([]string, len(items))
	for i, it := range items {
		abss[i] = it.Abs
	}
	var plan DeletePlan
	uses := map[string]*Usage{}
	// Sperrfenster je Wurzel: UsageFor einmal je Wurzel mit deren Überschreibung.
	byRoot := map[string][]string{}
	for _, it := range items {
		byRoot[it.RootID] = append(byRoot[it.RootID], it.Abs)
	}
	for rid, paths := range byRoot {
		r := byID[rid]
		u, err := m.UsageFor(ctx, paths, &r)
		if err != nil {
			return DeletePlan{}, err
		}
		for p, uu := range u {
			uses[rid+"|"+p] = uu
		}
	}
	for i := range items {
		it := &items[i]
		it.Usage = uses[it.RootID+"|"+it.Abs]
		it.Status = "ok"
		switch {
		case it.root.ReadOnly:
			it.Status, it.Error = "blocked", "Ort ist schreibgeschützt"
			plan.Blocked = true
		case it.Usage != nil && len(it.Usage.Absolute) > 0:
			it.Status, it.Error = "blocked", it.Usage.Absolute[0].Text
			plan.Blocked = true
		case it.Usage != nil && len(it.Usage.Hard) > 0:
			it.Status, it.Error = "locked", it.Usage.Hard[0].Text
			plan.NeedsForce = true
		case it.Usage != nil && len(it.Usage.Soft) > 0:
			it.Status, it.Error = "confirm", it.Usage.Soft[0].Text
			plan.NeedsConfirm = true
		}
	}
	sort.SliceStable(items, func(i, j int) bool { return !items[i].Derived && items[j].Derived })
	plan.Items = items
	return plan, nil
}

type famFile struct {
	root Root
	rel  string
}

// proxyMembers: Review-Proxys eines Assets in Wurzeln mit der Rolle proxy (<Wurzel>/proxies/<Asset>/…).
func (m *Module) proxyMembers(roots []Root, assetID string) []famFile {
	var out []famFile
	if assetID == "" || strings.ContainsAny(assetID, "/\\.") {
		return nil
	}
	for _, r := range roots {
		if r.Role != RoleProxy {
			continue
		}
		raw, err := m.hostOp(r.HostID, jobwire.FileOp{Op: jobwire.FileOpList, Root: r.Path, Rel: "proxies/" + assetID, Limit: 200})
		if err != nil {
			continue
		}
		var lr jobwire.FileListResult
		if json.Unmarshal(raw, &lr) != nil {
			continue
		}
		for _, e := range lr.Entries {
			if !e.IsDir {
				out = append(out, famFile{root: r, rel: "proxies/" + assetID + "/" + e.Name})
			}
		}
	}
	return out
}

// ExecDelete führt die Löschung aus (nach PlanDelete): absolute Sperren nie, harte nur mit Force, weiche nur mit Confirm.
// canForce: der Aufrufer hat das Recht files.force.
func (m *Module) ExecDelete(ctx context.Context, req DeleteRequest, actor string, canForce bool) (DeletePlan, error) {
	plan, err := m.PlanDelete(ctx, req)
	if err != nil {
		return plan, err
	}
	if plan.Blocked {
		return plan, fmt.Errorf("blockiert: %s", firstWith(plan.Items, "blocked"))
	}
	if plan.NeedsForce {
		if !req.Force {
			return plan, fmt.Errorf("gesperrt: %s — nur mit „Erzwingen“", firstWith(plan.Items, "locked"))
		}
		if !canForce {
			return plan, fmt.Errorf("Erzwingen verlangt das Recht „Gesperrte Dateien löschen“")
		}
		if len(strings.TrimSpace(req.Reason)) < 5 {
			return plan, fmt.Errorf("Erzwingen verlangt eine Begründung (mindestens 5 Zeichen)")
		}
	}
	if plan.NeedsConfirm && !req.Confirm && !req.Force {
		return plan, fmt.Errorf("Hinweise sind zu bestätigen: %s", firstWith(plan.Items, "confirm"))
	}
	cfg := m.Config()
	byRoot := map[string][]int{}
	for i := range plan.Items {
		byRoot[plan.Items[i].RootID] = append(byRoot[plan.Items[i].RootID], i)
	}
	for rid, idxs := range byRoot {
		root := plan.Items[idxs[0]].root
		rels := make([]string, len(idxs))
		for k, i := range idxs {
			rels[k] = plan.Items[i].Rel
		}
		raw, err := m.hostOp(root.HostID, jobwire.FileOp{Op: jobwire.FileOpTrash, Root: root.Path, Rels: rels})
		if err != nil {
			for _, i := range idxs {
				plan.Items[i].Status, plan.Items[i].Error = "error", err.Error()
			}
			continue
		}
		var res []jobwire.TrashResult
		_ = json.Unmarshal(raw, &res)
		var purge []string
		for k, i := range idxs {
			it := &plan.Items[i]
			if k >= len(res) || !res[k].OK {
				it.Status = "error"
				if k < len(res) {
					it.Error = res[k].Error
				}
				continue
			}
			it.Status, it.TrashID = "deleted", res[k].ID
			if cfg.TrashRetention(root) == 0 {
				purge = append(purge, res[k].ID)
			}
			m.afterDelete(ctx, it, actor, req)
		}
		if len(purge) > 0 {
			if _, err := m.purgeOp(root, jobwire.FileOp{IDs: purge}); err != nil {
				slog.Warn("files: sofortiges Endlöschen fehlgeschlagen", "root", rid, "error", err)
			}
		}
	}
	return plan, nil
}

func firstWith(items []DeleteItem, status string) string {
	for _, it := range items {
		if it.Status == status {
			return it.Rel + ": " + it.Error
		}
	}
	return ""
}

// afterDelete: Audit, Dateizustand der betroffenen Representations, Alarm bei Erzwingen.
func (m *Module) afterDelete(ctx context.Context, it *DeleteItem, actor string, req DeleteRequest) {
	forced := it.Usage != nil && len(it.Usage.Hard) > 0
	details := map[string]any{"root": it.RootName, "host": it.host, "path": it.Abs, "role": it.Role, "trashId": it.TrashID, "forced": forced, "derived": it.Derived}
	if forced {
		details["reason"] = req.Reason
		details["locks"] = it.Usage.Hard
	}
	m.audit(actor, "file", it.Abs, "file.delete", details)
	m.event("omp.files.deleted", map[string]any{"path": it.Abs, "root": it.RootName, "forced": forced})
	// Absichtliche Löschung: Dateizustand sofort „fehlt“ (bestätigt, ohne Alarm).
	if _, err := m.db().ExecContext(ctx, `
		INSERT INTO representation_health (representation_id, asset_id, state, miss_count, detail, notified_state)
		SELECT r.id, v.asset_id, 'missing', 2, $2, 'missing' FROM representations r JOIN asset_versions v ON v.id = r.asset_version_id WHERE r.uri = $1
		ON CONFLICT (representation_id) DO UPDATE SET state = 'missing', miss_count = 2, notified_state = 'missing', since = now(), checked_at = now(), detail = $2`,
		it.Abs, "gelöscht (Papierkorb) von "+actor); err != nil {
		slog.Debug("files: Dateizustand nicht aktualisiert", "error", err)
	}
	if forced {
		m.alert("file-force-delete", "warning", it.Abs, filepath.Base(it.Abs), fmt.Sprintf("%s hat eine gesperrte Datei erzwungen gelöscht: %s — Begründung: %s", actor, it.Abs, req.Reason))
	}
}
