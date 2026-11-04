package files

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/jobwire"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/asset"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/locations"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

// Funktionsrechte (Kap. 44-Muster).
const (
	FeatView   = "files.view"
	FeatDelete = "files.delete"
	FeatForce  = "files.force"
	FeatUpload = "files.upload"
	FeatAdmin  = "files.admin"
)

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, err error) {
	writeJSON(w, code, map[string]any{"error": err.Error()})
}

func readBody(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil && err != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "ungültiges JSON"})
		return false
	}
	return true
}

func actorOf(r *http.Request) string {
	if u := module.Actor(r); u != "" {
		return u
	}
	return "local"
}

func rootErr(w http.ResponseWriter, err error) {
	code := http.StatusInternalServerError
	switch {
	case errors.Is(err, ErrNotFound):
		code = http.StatusNotFound
	case errors.Is(err, jobwire.ErrFileOp):
		code = http.StatusBadRequest
	}
	writeErr(w, code, err)
}

// Features implementiert module.FeatureProvider.
func (*Module) Features() []module.FeatureDef {
	g := map[string]string{"de": "Dateien", "en": "Files"}
	return []module.FeatureDef{
		{ID: FeatView, Group: g, Label: map[string]string{"de": "Dateien ansehen", "en": "View files"}, Description: map[string]string{"de": "Datei-Explorer, Papierkorb und Dateizustand der Assets sehen.", "en": "See the file explorer, trash and file state of assets."}},
		{ID: FeatDelete, Group: g, Label: map[string]string{"de": "Dateien löschen und wiederherstellen", "en": "Delete and restore files"}, Description: map[string]string{"de": "Dateien in den Papierkorb legen (mit Verwendungsprüfung) und daraus wiederherstellen; Dateien als Asset anlegen oder zuordnen.", "en": "Move files to the trash (with usage check), restore them; create assets from files or attach files."}},
		{ID: FeatForce, Group: g, Label: map[string]string{"de": "Gesperrte Dateien löschen (Erzwingen)", "en": "Force-delete locked files"}, Description: map[string]string{"de": "Dateien im Sperrfenster oder in einer Planung trotzdem löschen (Begründung, Audit, Alarm). Laufende Sendungen und Aufnahmen bleiben gesperrt.", "en": "Delete files in the lock window or in a plan anyway (reason, audit, alert). Running broadcasts and recordings stay locked."}},
		{ID: FeatUpload, Group: g, Label: map[string]string{"de": "Dateien hochladen", "en": "Upload files"}, Description: map[string]string{"de": "Dateien aus dem Browser in einen Ort des Orchestrator-Rechners hochladen.", "en": "Upload files from the browser to a location on the orchestrator machine."}},
		{ID: FeatAdmin, Group: g, Label: map[string]string{"de": "Orte und Dateieinstellungen verwalten", "en": "Manage locations and file settings"}, Description: map[string]string{"de": "Explorer-Orte, Papierkorb-Dauer, Notfallgrenzen, Sperrfenster; Papierkorb endgültig leeren; Dateiprüfung neu starten.", "en": "Explorer locations, trash retention, emergency limits, lock windows; empty the trash for good; restart the file check."}},
	}
}

// UI implementiert module.UIProvider.
func (*Module) UI() []module.UITab {
	return []module.UITab{{
		ID: "files", Placement: "main", After: "assets",
		Label:   map[string]string{"de": "Dateien", "en": "Files"},
		Element: "omp-files-view", Bundle: "/dist/modules/files.js",
	}, {
		// Einstellungen gehören in die Administration (Nutzerwunsch 2026-11-04).
		ID: "files-settings", Placement: "admin:platform", After: "jobs",
		Label: map[string]string{"de": "Dateien", "en": "Files"},
		Group: map[string]string{"de": "Plattform", "en": "Platform"}, Cluster: "operations",
		Element: "omp-files-settings", Bundle: "/dist/modules/files.js",
	}}
}

// Mount implementiert module.Module.
func (m *Module) Mount(r module.Routes, d module.Deps) error {
	r.Handle("GET /api/v1/files/roots", module.Feature(FeatView), m.hRoots)
	r.Handle("POST /api/v1/files/roots", module.Feature(FeatAdmin), m.hCreateRoot)
	r.Handle("PUT /api/v1/files/roots/{id}", module.Feature(FeatAdmin), m.hUpdateRoot)
	r.Handle("DELETE /api/v1/files/roots/{id}", module.Feature(FeatAdmin), m.hDeleteRoot)
	r.Handle("GET /api/v1/files/config", module.Feature(FeatView), m.hGetConfig)
	r.Handle("PUT /api/v1/files/config", module.Feature(FeatAdmin), m.hPutConfig)
	r.Handle("GET /api/v1/files/list", module.Feature(FeatView), m.hList)
	r.Handle("GET /api/v1/files/orphans", module.Feature(FeatView), m.hOrphans)
	r.Handle("GET /api/v1/files/trash", module.Feature(FeatView), m.hTrash)
	r.Handle("POST /api/v1/files/trash/restore", module.Feature(FeatDelete), m.hRestore)
	r.Handle("POST /api/v1/files/trash/purge", module.Feature(FeatAdmin), m.hPurge)
	r.Handle("POST /api/v1/files/delete/preview", module.Feature(FeatDelete), m.hDeletePreview)
	r.Handle("POST /api/v1/files/delete", module.Feature(FeatDelete), m.hDelete)
	r.Handle("POST /api/v1/files/upload", module.Feature(FeatUpload), m.hUpload)
	r.Handle("GET /api/v1/files/asset-states", module.Authenticated(), m.hAssetStates)
	r.Handle("GET /api/v1/files/assets/{id}", module.Authenticated(), m.hAssetFiles)
	r.Handle("POST /api/v1/files/check", module.Feature(FeatView), m.hCheck)
	r.Handle("POST /api/v1/files/assets", module.Feature(FeatDelete), m.hCreateAssets)
	r.Handle("POST /api/v1/files/assets/{id}/attach", module.Feature(FeatDelete), m.hAttach)
	return nil
}

func (m *Module) rootByID(ctx context.Context, id string) (Root, error) {
	return GetRoot(ctx, m.db(), id)
}

// ---- Orte ------------------------------------------------------------------------------------------------------

type rootView struct {
	Root
	Free       *int64    `json:"free,omitempty"`
	Total      *int64    `json:"total,omitempty"`
	Reachable  bool      `json:"reachable"`
	Error      string    `json:"error,omitempty"`
	TrashItems int       `json:"trashItems"`
	Mount      MountInfo `json:"mount"`
}

func (m *Module) hRoots(w http.ResponseWriter, r *http.Request) {
	roots, err := ListRoots(r.Context(), m.db())
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	out := make([]rootView, len(roots))
	var wg sync.WaitGroup
	for i := range roots {
		out[i].Root = roots[i]
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			df, err := m.rootDF(roots[i])
			if err != nil {
				out[i].Error = err.Error()
				return
			}
			out[i].Reachable, out[i].Free, out[i].Total = true, &df.Free, &df.Total
			if raw, err := m.rootOp(roots[i], jobwire.FileOp{Op: jobwire.FileOpTrashList}); err == nil {
				var tl []jobwire.TrashEntry
				if json.Unmarshal(raw, &tl) == nil {
					out[i].TrashItems = len(tl)
				}
			}
		}(i)
	}
	wg.Wait()
	for i := range out {
		out[i].Mount = m.mountInfo(out[i].ID)
	}
	writeJSON(w, 200, out)
}

type rootBody struct {
	Root
	LocationID string `json:"locationId"`
	Note       string `json:"note"`
}

func (m *Module) hCreateRoot(w http.ResponseWriter, r *http.Request) {
	var b rootBody
	if !readBody(w, r, &b) {
		return
	}
	id := b.LocationID
	if id == "" {
		if b.Shared && len(b.Hosts) > 0 {
			b.HostID = b.Hosts[0] // der Ort liegt in der Liste der Speicherorte beim ersten (bevorzugten) Host
		}
		l, err := locations.NewStore(m.db()).Create(locations.Input{Name: b.Name, HostID: b.HostID, Path: b.Path, Note: b.Note}, actorOf(r))
		if err != nil {
			code := 400
			if errors.Is(err, locations.ErrDuplicate) {
				code = 409
			}
			writeErr(w, code, err)
			return
		}
		id = l.ID
	}
	b.Root.ID = id
	if err := SaveRootSettings(r.Context(), m.db(), b.Root); err != nil {
		writeErr(w, 400, err)
		return
	}
	m.audit(actorOf(r), "file-root", id, "file.root.create", map[string]any{"name": b.Name, "host": b.HostID, "path": b.Path, "role": b.Role})
	root, err := m.rootByID(r.Context(), id)
	if err != nil {
		rootErr(w, err)
		return
	}
	out := map[string]any{"id": root.ID, "name": root.Name, "hostId": root.HostID, "path": root.Path, "role": root.Role, "readOnly": root.ReadOnly}
	if _, err := m.rootDF(root); err != nil { // sofort prüfen: Host erreichbar, Pfad vorhanden, vom Host freigegeben?
		out["warning"] = err.Error()
	}
	writeJSON(w, 201, out)
}

func (m *Module) hUpdateRoot(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := m.rootByID(r.Context(), id); err != nil {
		rootErr(w, err)
		return
	}
	var b Root
	if !readBody(w, r, &b) {
		return
	}
	b.ID = id
	if err := SaveRootSettings(r.Context(), m.db(), b); err != nil {
		writeErr(w, 400, err)
		return
	}
	m.audit(actorOf(r), "file-root", id, "file.root.update", map[string]any{"role": b.Role, "readOnly": b.ReadOnly})
	root, _ := m.rootByID(r.Context(), id)
	writeJSON(w, 200, root)
}

func (m *Module) hDeleteRoot(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if err := RemoveRoot(r.Context(), m.db(), id); err != nil {
		writeErr(w, 500, err)
		return
	}
	m.audit(actorOf(r), "file-root", id, "file.root.remove", nil)
	w.WriteHeader(http.StatusNoContent)
}

func (m *Module) hGetConfig(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, m.Config()) }

func (m *Module) hPutConfig(w http.ResponseWriter, r *http.Request) {
	c := DefaultConfig()
	if cur := m.Config(); true {
		c = cur
	}
	if !readBody(w, r, &c) {
		return
	}
	if err := c.Validate(); err != nil {
		writeErr(w, 400, err)
		return
	}
	raw, _ := json.Marshal(c)
	if err := m.deps().Settings.Put(settingsKey, raw); err != nil {
		writeErr(w, 500, err)
		return
	}
	m.invalidate()
	m.audit(actorOf(r), "file-config", "files", "file.config.update", map[string]any{"config": c})
	writeJSON(w, 200, c)
}

// ---- Explorer --------------------------------------------------------------------------------------------------

type listEntry struct {
	jobwire.FileEntry
	Abs      string     `json:"abs,omitempty"`
	Role     string     `json:"role,omitempty"`
	Assets   []AssetRef `json:"assets,omitempty"`
	Orphan   bool       `json:"orphan,omitempty"`
	Locks    int        `json:"locks,omitempty"`    // harte/absolute Sperren
	Warnings int        `json:"warnings,omitempty"` // weiche Hinweise
	State    string     `json:"state,omitempty"`    // Dateizustand der Representation
}

// enrich ordnet Dateien Assets/Rollen zu (E8) und ergänzt Sperr-/Hinweiszähler.
func (m *Module) enrich(ctx context.Context, root Root, dir string, ents []jobwire.FileEntry) []listEntry {
	out := make([]listEntry, len(ents))
	var files []string
	for i, e := range ents {
		out[i].FileEntry = e
		if !e.IsDir {
			out[i].Abs = root.Abs(filepath.ToSlash(filepath.Join(dir, e.Name)))
			files = append(files, out[i].Abs)
		}
	}
	if len(files) == 0 {
		return out
	}
	db := m.db()
	reps, _ := repsByURI(ctx, db, files)
	subs := map[string]string{} // Pfad → Asset
	if rows, err := db.QueryContext(ctx, `SELECT asset_id, path FROM review_subtitles WHERE path = ANY($1) UNION SELECT asset_id, playout_path FROM review_subtitles WHERE playout_path = ANY($1)`, files); err == nil {
		for rows.Next() {
			var a, p string
			if rows.Scan(&a, &p) == nil {
				subs[p] = a
			}
		}
		rows.Close()
	}
	rec := map[string]string{}
	if rows, err := db.QueryContext(ctx, `SELECT file_path, name FROM ingest_jobs WHERE file_path = ANY($1)`, files); err == nil {
		for rows.Next() {
			var p, n string
			if rows.Scan(&p, &n) == nil {
				rec[p] = n
			}
		}
		rows.Close()
	}
	titles := map[string]string{}
	var need []string
	for i := range out {
		if a := proxyAssetID(out[i].Abs); a != "" && root.Role == RoleProxy {
			need = append(need, a)
		}
	}
	for _, a := range subs {
		need = append(need, a)
	}
	if len(need) > 0 {
		if rows, err := db.QueryContext(ctx, `SELECT id, title, type, status FROM assets WHERE id = ANY($1)`, need); err == nil {
			for rows.Next() {
				var id, t, ty, st string
				if rows.Scan(&id, &t, &ty, &st) == nil {
					titles[id] = t + "\x00" + ty + "\x00" + st
				}
			}
			rows.Close()
		}
	}
	states := map[string]string{}
	if rows, err := db.QueryContext(ctx, `SELECT r.uri, h.state FROM representation_health h JOIN representations r ON r.id = h.representation_id WHERE r.uri = ANY($1)`, files); err == nil {
		for rows.Next() {
			var p, s string
			if rows.Scan(&p, &s) == nil {
				states[p] = s
			}
		}
		rows.Close()
	}
	usage, _ := m.UsageFor(ctx, files, &root)
	for i := range out {
		e := &out[i]
		if e.IsDir {
			continue
		}
		for _, ri := range reps[e.Abs] {
			e.Assets = append(e.Assets, ri.AssetRef)
			if e.Role == "" {
				e.Role = ri.RepType
			}
		}
		if a, ok := subs[e.Abs]; ok {
			e.Role = RoleSubtitle
			if t := strings.Split(titles[a], "\x00"); len(t) == 3 {
				e.Assets = append(e.Assets, AssetRef{ID: a, Title: t[0], Type: t[1], Status: t[2]})
			}
		}
		if a := proxyAssetID(e.Abs); a != "" && root.Role == RoleProxy {
			e.Role = "proxy"
			if t := strings.Split(titles[a], "\x00"); len(t) == 3 {
				e.Assets = append(e.Assets, AssetRef{ID: a, Title: t[0], Type: t[1], Status: t[2]})
			}
		}
		if n, ok := rec[e.Abs]; ok && e.Role == "" {
			e.Role = RoleRecording
			_ = n
		}
		e.State = states[e.Abs]
		e.Orphan = len(e.Assets) == 0 && e.Role == "" && !strings.HasPrefix(e.Name, ".")
		if u := usage[e.Abs]; u != nil {
			e.Locks, e.Warnings = len(u.Absolute)+len(u.Hard), len(u.Soft)
		}
	}
	return out
}

func (m *Module) hList(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	root, err := m.rootByID(r.Context(), q.Get("root"))
	if err != nil {
		rootErr(w, err)
		return
	}
	rel, err := jobwire.CleanRel(q.Get("path"), true)
	if err != nil {
		rootErr(w, err)
		return
	}
	limit, _ := strconv.Atoi(q.Get("limit"))
	raw, err := m.rootOp(root, jobwire.FileOp{Op: jobwire.FileOpList, Rel: rel, Cursor: q.Get("cursor"), Limit: limit})
	if err != nil {
		writeErr(w, 502, err)
		return
	}
	var lr jobwire.FileListResult
	if err := json.Unmarshal(raw, &lr); err != nil {
		writeErr(w, 502, err)
		return
	}
	writeJSON(w, 200, map[string]any{"root": root, "path": rel, "entries": m.enrich(r.Context(), root, rel, lr.Entries), "next": lr.Next})
}

// hOrphans durchsucht eine Wurzel (bis 3000 Dateien) und liefert nur Dateien ohne Zuordnung.
func (m *Module) hOrphans(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	root, err := m.rootByID(r.Context(), q.Get("root"))
	if err != nil {
		rootErr(w, err)
		return
	}
	start, err := jobwire.CleanRel(q.Get("path"), true)
	if err != nil {
		rootErr(w, err)
		return
	}
	var found []listEntry
	scanned := 0
	truncated := false
	queue := []string{start}
	for len(queue) > 0 && !truncated {
		dir := queue[0]
		queue = queue[1:]
		cursor := ""
		for {
			raw, err := m.rootOp(root, jobwire.FileOp{Op: jobwire.FileOpList, Rel: dir, Cursor: cursor, Limit: 500})
			if err != nil {
				break
			}
			var lr jobwire.FileListResult
			if json.Unmarshal(raw, &lr) != nil {
				break
			}
			var files []jobwire.FileEntry
			for _, e := range lr.Entries {
				if e.IsDir {
					queue = append(queue, filepath.ToSlash(filepath.Join(dir, e.Name)))
				} else {
					files = append(files, e)
				}
			}
			scanned += len(files)
			for _, le := range m.enrich(r.Context(), root, dir, files) {
				if le.Orphan {
					le.Name = filepath.ToSlash(filepath.Join(dir, le.Name))
					found = append(found, le)
				}
			}
			if scanned >= 3000 {
				truncated = true
				break
			}
			if lr.Next == "" {
				break
			}
			cursor = lr.Next
		}
	}
	writeJSON(w, 200, map[string]any{"root": root, "orphans": found, "scanned": scanned, "truncated": truncated})
}

// ---- Papierkorb ------------------------------------------------------------------------------------------------

func (m *Module) hTrash(w http.ResponseWriter, r *http.Request) {
	root, err := m.rootByID(r.Context(), r.URL.Query().Get("root"))
	if err != nil {
		rootErr(w, err)
		return
	}
	raw, err := m.rootOp(root, jobwire.FileOp{Op: jobwire.FileOpTrashList})
	if err != nil {
		writeErr(w, 502, err)
		return
	}
	var tl []jobwire.TrashEntry
	_ = json.Unmarshal(raw, &tl)
	ret := m.Config().TrashRetention(root)
	type te struct {
		jobwire.TrashEntry
		ExpiresMs int64 `json:"expiresMs"`
	}
	out := make([]te, len(tl))
	for i, e := range tl {
		out[i] = te{TrashEntry: e, ExpiresMs: e.DeletedMs + ret.Milliseconds()}
	}
	writeJSON(w, 200, map[string]any{"root": root, "entries": out, "retentionDays": int(ret / (24 * time.Hour))})
}

func (m *Module) hRestore(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Root string   `json:"root"`
		IDs  []string `json:"ids"`
	}
	if !readBody(w, r, &b) {
		return
	}
	root, err := m.rootByID(r.Context(), b.Root)
	if err != nil {
		rootErr(w, err)
		return
	}
	if root.ReadOnly || len(b.IDs) == 0 {
		writeErr(w, 400, fmt.Errorf("Ort schreibgeschützt oder keine Einträge gewählt"))
		return
	}
	raw, err := m.rootOp(root, jobwire.FileOp{Op: jobwire.FileOpRestore, IDs: b.IDs})
	if err != nil {
		writeErr(w, 502, err)
		return
	}
	var res []jobwire.TrashResult
	_ = json.Unmarshal(raw, &res)
	var uris []string
	for _, x := range res {
		if x.OK {
			m.audit(actorOf(r), "file", root.Abs(x.Rel), "file.restore", map[string]any{"root": root.Name})
			uris = append(uris, root.Abs(x.Rel))
		}
	}
	// Dateizustand sofort neu bewerten: die Dateien sind zurück (kein Warten auf den Hintergrundlauf).
	if len(uris) > 0 {
		if rows, err := m.db().QueryContext(r.Context(), repSelect+` WHERE r.uri = ANY($1)`, uris); err == nil {
			if reps, err := scanReps(rows); err == nil && len(reps) > 0 {
				_ = m.CheckReps(r.Context(), reps, actorOf(r))
			}
		}
	}
	writeJSON(w, 200, res)
}

func (m *Module) hPurge(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Root string   `json:"root"`
		IDs  []string `json:"ids"`
		All  bool     `json:"all"`
	}
	if !readBody(w, r, &b) {
		return
	}
	root, err := m.rootByID(r.Context(), b.Root)
	if err != nil {
		rootErr(w, err)
		return
	}
	op := jobwire.FileOp{IDs: b.IDs}
	if b.All {
		op = jobwire.FileOp{OlderThanMs: time.Now().Add(time.Minute).UnixMilli()}
	}
	pr, err := m.purgeOp(root, op)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	m.audit(actorOf(r), "file-root", root.ID, "file.trash.purge", map[string]any{"root": root.Name, "removed": pr.Removed, "freedBytes": pr.FreedBytes, "all": b.All})
	writeJSON(w, 200, pr)
}

// ---- Löschen ---------------------------------------------------------------------------------------------------

func (m *Module) hDeletePreview(w http.ResponseWriter, r *http.Request) {
	var b DeleteRequest
	if !readBody(w, r, &b) {
		return
	}
	plan, err := m.PlanDelete(r.Context(), b)
	if err != nil {
		rootErr(w, err)
		return
	}
	writeJSON(w, 200, plan)
}

func (m *Module) hDelete(w http.ResponseWriter, r *http.Request) {
	var b DeleteRequest
	if !readBody(w, r, &b) {
		return
	}
	can := m.deps().Access == nil || m.deps().Access.Can(r, FeatForce)
	plan, err := m.ExecDelete(r.Context(), b, actorOf(r), can)
	if err != nil {
		code := 409
		if errors.Is(err, ErrNotFound) || errors.Is(err, jobwire.ErrFileOp) {
			code = 400
		}
		writeJSON(w, code, map[string]any{"error": err.Error(), "plan": plan})
		return
	}
	writeJSON(w, 200, plan)
}

// ---- Upload (Orchestrator-Rechner) -----------------------------------------------------------------------------

func (m *Module) hUpload(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	root, err := m.rootByID(r.Context(), q.Get("root"))
	if err != nil {
		rootErr(w, err)
		return
	}
	if !servedLocally(root) {
		writeErr(w, 400, fmt.Errorf("Upload ist nur in Orte möglich, die der Orchestrator-Rechner selbst bedient (Ort liegt auf Host %s)", root.HostID))
		return
	}
	if root.ReadOnly {
		writeErr(w, 400, fmt.Errorf("Ort ist schreibgeschützt"))
		return
	}
	rel, err := jobwire.CleanRel(q.Get("path"), false)
	if err != nil {
		rootErr(w, err)
		return
	}
	real, err := filepath.EvalSymlinks(root.Path)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	dst := filepath.Join(real, filepath.FromSlash(rel))
	if parent := jobwire.ResolveExisting(filepath.Dir(dst)); parent != real && !strings.HasPrefix(parent, real+string(filepath.Separator)) {
		writeErr(w, 400, fmt.Errorf("Pfad verlässt den Ort"))
		return
	}
	if _, err := os.Lstat(dst); err == nil && q.Get("overwrite") != "1" {
		writeErr(w, 409, fmt.Errorf("Datei existiert bereits"))
		return
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		writeErr(w, 500, err)
		return
	}
	tmp := dst + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	n, cerr := io.Copy(f, r.Body)
	if e := f.Close(); cerr == nil {
		cerr = e
	}
	if cerr != nil {
		_ = os.Remove(tmp)
		writeErr(w, 500, cerr)
		return
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		writeErr(w, 500, err)
		return
	}
	m.audit(actorOf(r), "file", dst, "file.upload", map[string]any{"root": root.Name, "bytes": n})
	writeJSON(w, 201, map[string]any{"path": dst, "rel": rel, "bytes": n})
}

// ---- Dateizustand der Assets -----------------------------------------------------------------------------------

func (m *Module) hAssetStates(w http.ResponseWriter, r *http.Request) {
	st, err := m.AssetStates(r.Context())
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	filter := r.URL.Query().Get("state")
	counts := map[string]int{}
	out := make([]AssetFileState, 0, len(st))
	for _, s := range st {
		counts[s.State]++
		if filter == "" || filter == s.State {
			out = append(out, s)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].AssetID < out[j].AssetID })
	writeJSON(w, 200, map[string]any{"assets": out, "counts": counts})
}

type repState struct {
	RepID    string `json:"representationId"`
	Type     string `json:"type"`
	Provider string `json:"provider"`
	URI      string `json:"uri"`
	Version  string `json:"versionId"`
	State    string `json:"state"`
	Size     *int64 `json:"size,omitempty"`
	Detail   string `json:"detail,omitempty"`
	Checked  string `json:"checkedAt,omitempty"`
	Since    string `json:"since,omitempty"`
}

// hAssetFiles: alle Dateien eines Assets mit Zustand (prüft vorher frisch, wenn ?check=1), plus Untertitel/Proxys.
func (m *Module) hAssetFiles(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if r.URL.Query().Get("check") == "1" {
		if err := m.CheckAsset(r.Context(), id, actorOf(r)); err != nil {
			writeErr(w, 500, err)
			return
		}
	}
	rows, err := m.db().QueryContext(r.Context(), `
		SELECT r.id, r.type, r.storage_provider, r.uri, v.id, COALESCE(h.state, ''), h.size_bytes, COALESCE(h.detail, ''), h.checked_at, h.since
		FROM representations r JOIN asset_versions v ON v.id = r.asset_version_id LEFT JOIN representation_health h ON h.representation_id = r.id
		WHERE v.asset_id = $1 ORDER BY v.version_number DESC, r.created_at`, id)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	defer rows.Close()
	reps := []repState{}
	for rows.Next() {
		var s repState
		var size *int64
		var checked, since *time.Time
		if err := rows.Scan(&s.RepID, &s.Type, &s.Provider, &s.URI, &s.Version, &s.State, &size, &s.Detail, &checked, &since); err != nil {
			writeErr(w, 500, err)
			return
		}
		s.Size = size
		if checked != nil {
			s.Checked = checked.UTC().Format(time.RFC3339)
		}
		if since != nil {
			s.Since = since.UTC().Format(time.RFC3339)
		}
		if s.State == "" {
			s.State = "unchecked"
		}
		reps = append(reps, s)
	}
	fam, _ := m.FamilyOf(r.Context(), []string{id})
	roots, _ := ListRoots(r.Context(), m.db())
	members := []FamilyMember{}
	for _, f := range fam[id] {
		if f.RepID == "" {
			members = append(members, f)
		}
	}
	for _, f := range m.proxyMembers(roots, id) {
		members = append(members, FamilyMember{Path: f.root.Abs(f.rel), Role: "proxy", AssetID: id})
	}
	writeJSON(w, 200, map[string]any{"assetId": id, "representations": reps, "related": members})
}

// hCheck: „Jetzt prüfen“ — für ein Asset sofort; ohne Asset (Recht files.admin) alle neu einreihen.
func (m *Module) hCheck(w http.ResponseWriter, r *http.Request) {
	var b struct {
		AssetID string `json:"assetId"`
	}
	if !readBody(w, r, &b) {
		return
	}
	if b.AssetID != "" {
		if err := m.CheckAsset(r.Context(), b.AssetID, actorOf(r)); err != nil {
			writeErr(w, 500, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if m.deps().Access != nil && !m.deps().Access.Can(r, FeatAdmin) {
		writeErr(w, 403, fmt.Errorf("alle Dateien neu prüfen verlangt das Recht „Orte und Dateieinstellungen verwalten“"))
		return
	}
	if _, err := m.db().ExecContext(r.Context(), `UPDATE representation_health SET checked_at = 'epoch'`); err != nil {
		writeErr(w, 500, err)
		return
	}
	m.audit(actorOf(r), "file-config", "files", "file.check.all", nil)
	w.WriteHeader(http.StatusNoContent)
}

// ---- Assets aus Dateien anlegen / zuordnen ---------------------------------------------------------------------

func (m *Module) repFor(root Root, rel string, raw []byte) (asset.Representation, error) {
	var sts []jobwire.FileStat
	if err := json.Unmarshal(raw, &sts); err != nil || len(sts) != 1 || !sts[0].Exists || sts[0].IsDir {
		return asset.Representation{}, fmt.Errorf("Datei nicht gefunden: %s", rel)
	}
	size := sts[0].Size
	return asset.Representation{Storage: asset.StorageLocation{Provider: "filesystem", URI: root.Abs(rel)}, SizeBytes: &size,
		Container: strings.TrimPrefix(strings.ToLower(filepath.Ext(rel)), ".")}, nil
}

func (m *Module) statOne(root Root, rel string) ([]byte, error) {
	return m.rootOp(root, jobwire.FileOp{Op: jobwire.FileOpStat, Rels: []string{rel}})
}

// hCreateAssets legt je Datei ein Asset an (Version, Representation „source“, veröffentlicht, Status „registriert“).
func (m *Module) hCreateAssets(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Root  string   `json:"root"`
		Paths []string `json:"paths"`
		Type  string   `json:"type"`
		Title string   `json:"title"` // nur bei genau einer Datei
	}
	if !readBody(w, r, &b) {
		return
	}
	root, err := m.rootByID(r.Context(), b.Root)
	if err != nil {
		rootErr(w, err)
		return
	}
	if m.Assets == nil || len(b.Paths) == 0 || len(b.Paths) > 200 {
		writeErr(w, 400, fmt.Errorf("1–200 Dateien angeben"))
		return
	}
	typ := b.Type
	if typ == "" {
		typ = "video"
	}
	actor := actorOf(r)
	type res struct {
		Path    string `json:"path"`
		AssetID string `json:"assetId,omitempty"`
		Error   string `json:"error,omitempty"`
	}
	out := []res{}
	for _, p := range b.Paths {
		rel, err := jobwire.CleanRel(p, false)
		if err != nil {
			out = append(out, res{Path: p, Error: err.Error()})
			continue
		}
		var exists bool
		_ = m.db().QueryRowContext(r.Context(), `SELECT EXISTS (SELECT 1 FROM representations WHERE uri = $1)`, root.Abs(rel)).Scan(&exists)
		if exists {
			out = append(out, res{Path: p, Error: "gehört bereits zu einem Asset"})
			continue
		}
		raw, err := m.statOne(root, rel)
		if err != nil {
			out = append(out, res{Path: p, Error: err.Error()})
			continue
		}
		rep, err := m.repFor(root, rel, raw)
		if err != nil {
			out = append(out, res{Path: p, Error: err.Error()})
			continue
		}
		title := strings.TrimSuffix(filepath.Base(rel), filepath.Ext(rel))
		if len(b.Paths) == 1 && strings.TrimSpace(b.Title) != "" {
			title = strings.TrimSpace(b.Title)
		}
		a, err := m.Assets.CreateAsset(typ, title, "", actor, "")
		if err == nil {
			var v asset.AssetVersion
			if v, err = m.Assets.CreateVersion(a.ID, "", "Aus Datei-Explorer", actor); err == nil {
				rep.AssetVersionID, rep.Type = v.ID, "source"
				if _, err = m.Assets.CreateRepresentation(rep); err == nil {
					_, err = m.Assets.PublishVersion(v.ID)
				}
			}
		}
		if err != nil {
			out = append(out, res{Path: p, Error: err.Error()})
			continue
		}
		if cur, e := m.Assets.GetAsset(a.ID); e == nil {
			_, _ = m.Assets.UpdateAssetStatus(a.ID, cur.RowVersion, asset.StatusRegistered, actor)
		}
		m.audit(actor, "asset", a.ID, "asset.create.from-file", map[string]any{"path": root.Abs(rel), "root": root.Name})
		out = append(out, res{Path: p, AssetID: a.ID})
	}
	writeJSON(w, 200, out)
}

// hAttach hängt eine Datei als Representation an ein vorhandenes Asset (neuer Entwurf, falls die aktuelle Version veröffentlicht ist).
func (m *Module) hAttach(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Root    string `json:"root"`
		Path    string `json:"path"`
		RepType string `json:"representationType"`
	}
	if !readBody(w, r, &b) {
		return
	}
	root, err := m.rootByID(r.Context(), b.Root)
	if err != nil {
		rootErr(w, err)
		return
	}
	rel, err := jobwire.CleanRel(b.Path, false)
	if err != nil {
		rootErr(w, err)
		return
	}
	raw, err := m.statOne(root, rel)
	if err != nil {
		writeErr(w, 502, err)
		return
	}
	rep, err := m.repFor(root, rel, raw)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	if m.Assets == nil {
		writeErr(w, 503, fmt.Errorf("Asset-Verwaltung nicht verfügbar"))
		return
	}
	actor := actorOf(r)
	id := r.PathValue("id")
	vers, err := m.Assets.ListVersions(id)
	if err != nil {
		writeErr(w, 404, err)
		return
	}
	var draft string
	var parent string
	for _, v := range vers {
		if v.Status == asset.VersionStatusDraft {
			draft = v.ID
		}
		if v.Status == asset.VersionStatusPublished && parent == "" {
			parent = v.ID
		}
	}
	if draft == "" {
		v, err := m.Assets.CreateVersion(id, parent, "Datei aus Datei-Explorer zugeordnet", actor)
		if err != nil {
			writeErr(w, 409, err)
			return
		}
		draft = v.ID
	}
	rep.AssetVersionID, rep.Type = draft, firstNonEmpty(b.RepType, "source")
	created, err := m.Assets.CreateRepresentation(rep)
	if err != nil {
		writeErr(w, 409, err)
		return
	}
	m.audit(actor, "asset", id, "asset.attach-file", map[string]any{"path": root.Abs(rel), "versionId": draft, "type": rep.Type})
	writeJSON(w, 201, map[string]any{"representation": created, "versionId": draft, "note": "Die Datei hängt an einem Entwurf; erst „Veröffentlichen“ macht die Version gültig."})
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}

// servedLocally: der Orchestrator-Rechner bedient den Ort selbst (Host leer oder bei gemeinsamem Speicher in der Hostliste).
func servedLocally(r Root) bool {
	if r.Shared {
		for _, h := range r.Hosts {
			if h == "" {
				return true
			}
		}
		return false
	}
	return r.HostID == ""
}
