package files

// Dateien zwischen Orten, Ordnern und Hosts kopieren und verschieben (Kapitel 86, Übertragen).
//
// Planen: PlanTransfer prüft vorab (Quelle da? Ziel schreibbar? Platz? Konflikte? Sperren?) und zeigt, was geschehen würde — ohne etwas
// zu ändern. Ausführen: ExecTransfer legt die Übertragung an und arbeitet sie im Hintergrund ab (höchstens zwei zugleich); der Fortschritt
// steht in der Tabelle file_transfers und über GET /api/v1/files/transfers.
//
// Datenweg: blockweise über kurze jobwire-Operationen (read-chunk am Quellort, write-chunk am Zielort), gesteuert vom Orchestrator —
// so geht es über jede Host-Kombination, ohne dass die Hosts einander erreichen müssen. Jeder Block wird mit SHA-256 gegengeprüft, die
// Zieldatei entsteht erst mit `commit` (atomar, nach fsync und Größenprüfung). Verschieben innerhalb eines Ortes ist ein Umbenennen;
// zwischen Orten wird kopiert, geprüft, und die Quelle danach in den Papierkorb gelegt (wiederherstellbar, nie hart gelöscht).

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"path"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/infantilo/openmediaplatform/jobwire"
)

// Funktionsrecht zum Kopieren und Verschieben (Verschieben verlangt zusätzlich files.delete, weil die Quelle verschwindet).
const FeatTransfer = "files.transfer"

// Betriebsarten und Zustände.
const (
	ModeCopy = "copy"
	ModeMove = "move"

	ConflictSkip      = "skip"
	ConflictOverwrite = "overwrite"
	ConflictRename    = "rename"

	TrQueued      = "queued"
	TrRunning     = "running"
	TrDone        = "done"
	TrFailed      = "failed"
	TrCancelled   = "cancelled"
	TrInterrupted = "interrupted"
)

const (
	maxTransferFiles   = 5000
	maxParallelTransfs = 2
	chunkRetries       = 3
	spaceMargin        = 256 << 20 // so viel bleibt am Ziel mindestens frei
)

// TransferRequest ist die Anfrage für Vorschau und Start.
type TransferRequest struct {
	Mode      string   `json:"mode"`
	SrcRootID string   `json:"srcRoot"`
	Paths     []string `json:"paths"`
	DstRootID string   `json:"dstRoot"`
	DstDir    string   `json:"dstDir"`   // Ordner im Zielort, leer = Wurzel
	Conflict  string   `json:"conflict"` // skip | overwrite | rename (Standard rename)
	Confirm   bool     `json:"confirm"`  // weiche Hinweise bestätigt
	Force     bool     `json:"force"`    // harte Sperre umgehen (Recht files.force, Begründung Pflicht)
	Reason    string   `json:"reason"`
}

// TransferItem ist eine Zeile der Vorschau/des Ergebnisses: eine Datei (oder ein leerer Ordner).
type TransferItem struct {
	Rel    string `json:"rel"`
	DstRel string `json:"dstRel"`
	IsDir  bool   `json:"isDir,omitempty"`
	Size   int64  `json:"size"`
	MTime  int64  `json:"mtimeMs,omitempty"`
	Top    string `json:"top"`    // die gewählte Quelle, zu der die Zeile gehört
	Status string `json:"status"` // ok | conflict | blocked | locked | confirm | skipped | done | error
	Error  string `json:"error,omitempty"`
	Usage  *Usage `json:"usage,omitempty"`
}

// TransferPlan ist die Vorschau.
type TransferPlan struct {
	Mode         string         `json:"mode"`
	Items        []TransferItem `json:"items"`
	Files        int            `json:"files"`
	TotalBytes   int64          `json:"totalBytes"`
	Conflicts    int            `json:"conflicts"`
	Blocked      bool           `json:"blocked"`
	NeedsForce   bool           `json:"needsForce"`
	NeedsConfirm bool           `json:"needsConfirm"`
	DstFree      int64          `json:"dstFree"`
	NoSpace      bool           `json:"noSpace"`
	// Rename: Verschieben ist hier ein reines Umbenennen innerhalb eines Ortes (sofort, ohne Kopieren).
	Rename bool `json:"rename"`
	src    Root
	dst    Root
}

// Transfer ist eine laufende oder beendete Übertragung (für die Oberfläche).
type Transfer struct {
	ID           string         `json:"id"`
	Mode         string         `json:"mode"`
	SrcRootID    string         `json:"srcRoot"`
	SrcRootName  string         `json:"srcRootName,omitempty"`
	DstRootID    string         `json:"dstRoot"`
	DstRootName  string         `json:"dstRootName,omitempty"`
	Paths        []string       `json:"paths"`
	DstDir       string         `json:"dstDir"`
	Conflict     string         `json:"conflict"`
	Status       string         `json:"status"`
	TotalBytes   int64          `json:"totalBytes"`
	DoneBytes    int64          `json:"doneBytes"`
	FilesTotal   int            `json:"filesTotal"`
	FilesDone    int            `json:"filesDone"`
	FilesSkipped int            `json:"filesSkipped"`
	Error        string         `json:"error,omitempty"`
	Items        []TransferItem `json:"items,omitempty"`
	CreatedBy    string         `json:"createdBy"`
	CreatedAt    time.Time      `json:"createdAt"`
	StartedAt    *time.Time     `json:"startedAt,omitempty"`
	FinishedAt   *time.Time     `json:"finishedAt,omitempty"`
	Current      string         `json:"current,omitempty"`
	BytesPerSec  float64        `json:"bytesPerSec,omitempty"`
}

// ---- Planen --------------------------------------------------------------------------------------------------------

func rootsByID(roots []Root) map[string]Root {
	m := map[string]Root{}
	for _, r := range roots {
		m[r.ID] = r
	}
	return m
}

func sameRoot(a, b Root) bool {
	return a.ID == b.ID || (a.HostID == b.HostID && a.Path == b.Path && !a.Shared && !b.Shared)
}

func (m *Module) statRels(root Root, rels []string) (map[string]jobwire.FileStat, error) {
	out := map[string]jobwire.FileStat{}
	for i := 0; i < len(rels); i += 200 {
		end := i + 200
		if end > len(rels) {
			end = len(rels)
		}
		raw, err := m.rootOp(root, jobwire.FileOp{Op: jobwire.FileOpStat, Rels: rels[i:end]})
		if err != nil {
			return nil, err
		}
		var res []jobwire.FileStat
		if err := json.Unmarshal(raw, &res); err != nil {
			return nil, err
		}
		for _, s := range res {
			out[s.Rel] = s
		}
	}
	return out, nil
}

// expandDir listet einen Ordner rekursiv (Dateien und leere Ordner), höchstens max Einträge.
func (m *Module) expandDir(root Root, rel string, max int) ([]jobwire.FileEntry, error) {
	var out []jobwire.FileEntry
	var walk func(dir string) error
	walk = func(dir string) error {
		cursor := ""
		empty := true
		for {
			raw, err := m.rootOp(root, jobwire.FileOp{Op: jobwire.FileOpList, Rel: dir, Cursor: cursor, Limit: 500})
			if err != nil {
				return err
			}
			var res jobwire.FileListResult
			if err := json.Unmarshal(raw, &res); err != nil {
				return err
			}
			for _, e := range res.Entries {
				empty = false
				child := e.Name
				if dir != "" {
					child = dir + "/" + e.Name
				}
				if e.IsDir {
					if err := walk(child); err != nil {
						return err
					}
					continue
				}
				e.Name = child
				out = append(out, e)
				if len(out) > max {
					return fmt.Errorf("mehr als %d Dateien — bitte in kleineren Teilen übertragen", max)
				}
			}
			if res.Next == "" {
				break
			}
			cursor = res.Next
		}
		if empty && dir != rel {
			out = append(out, jobwire.FileEntry{Name: dir, IsDir: true})
		}
		return nil
	}
	if err := walk(rel); err != nil {
		return nil, err
	}
	return out, nil
}

// PlanTransfer prüft eine Übertragung und liefert die Vorschau. Ändert nichts.
func (m *Module) PlanTransfer(ctx context.Context, req TransferRequest) (TransferPlan, error) {
	if req.Mode != ModeCopy && req.Mode != ModeMove {
		return TransferPlan{}, fmt.Errorf("Betriebsart copy oder move angeben")
	}
	if len(req.Paths) == 0 || len(req.Paths) > 500 {
		return TransferPlan{}, fmt.Errorf("1–500 Quellen angeben")
	}
	roots, err := ListRoots(ctx, m.db())
	if err != nil {
		return TransferPlan{}, err
	}
	byID := rootsByID(roots)
	src, ok := byID[req.SrcRootID]
	if !ok {
		return TransferPlan{}, fmt.Errorf("Quellort: %w", ErrNotFound)
	}
	dst, ok := byID[req.DstRootID]
	if !ok {
		return TransferPlan{}, fmt.Errorf("Zielort: %w", ErrNotFound)
	}
	dstDir, err := jobwire.CleanRel(req.DstDir, true)
	if err != nil {
		return TransferPlan{}, err
	}
	plan := TransferPlan{Mode: req.Mode, src: src, dst: dst}
	plan.Rename = req.Mode == ModeMove && sameRoot(src, dst)
	if dst.ReadOnly {
		plan.Blocked = true
		plan.Items = append(plan.Items, TransferItem{Status: "blocked", Error: "Zielort ist schreibgeschützt"})
		return plan, nil
	}
	if req.Mode == ModeMove && src.ReadOnly {
		plan.Blocked = true
		plan.Items = append(plan.Items, TransferItem{Status: "blocked", Error: "Quellort ist schreibgeschützt — Verschieben würde die Quelle entfernen"})
		return plan, nil
	}

	tops := make([]string, 0, len(req.Paths))
	for _, p := range req.Paths {
		rel, err := jobwire.CleanRel(p, false)
		if err != nil {
			return TransferPlan{}, err
		}
		tops = append(tops, rel)
	}
	stats, err := m.statRels(src, tops)
	if err != nil {
		return TransferPlan{}, err
	}
	var items []TransferItem
	for _, top := range tops {
		st := stats[top]
		if !st.Exists {
			items = append(items, TransferItem{Rel: top, Top: top, Status: "blocked", Error: "Quelle existiert nicht"})
			plan.Blocked = true
			continue
		}
		if st.Err != "" {
			items = append(items, TransferItem{Rel: top, Top: top, Status: "blocked", Error: "nicht prüfbar: " + st.Err})
			plan.Blocked = true
			continue
		}
		destTop := path.Join(dstDir, path.Base(top))
		if !st.IsDir {
			items = append(items, TransferItem{Rel: top, DstRel: destTop, Size: st.Size, MTime: st.MTime, Top: top})
			continue
		}
		// Ordner: in sich selbst kopieren/verschieben ist nicht erlaubt (Ziel liegt in der Quelle).
		if sameRoot(src, dst) && (destTop == top || strings.HasPrefix(destTop+"/", top+"/")) {
			items = append(items, TransferItem{Rel: top, DstRel: destTop, IsDir: true, Top: top, Status: "blocked", Error: "ein Ordner lässt sich nicht in sich selbst übertragen"})
			plan.Blocked = true
			continue
		}
		entries, err := m.expandDir(src, top, maxTransferFiles)
		if err != nil {
			return TransferPlan{}, err
		}
		if len(entries) == 0 {
			items = append(items, TransferItem{Rel: top, DstRel: destTop, IsDir: true, Top: top})
		}
		for _, e := range entries {
			sub := strings.TrimPrefix(e.Name, top)
			items = append(items, TransferItem{Rel: e.Name, DstRel: destTop + sub, IsDir: e.IsDir, Size: e.Size, MTime: e.MTime, Top: top})
		}
		if len(items) > maxTransferFiles {
			return TransferPlan{}, fmt.Errorf("mehr als %d Dateien — bitte in kleineren Teilen übertragen", maxTransferFiles)
		}
	}

	// Konflikte am Ziel
	var dstRels []string
	for _, it := range items {
		if it.DstRel != "" && it.Status == "" {
			dstRels = append(dstRels, it.DstRel)
		}
	}
	dstStats, err := m.statRels(dst, dstRels)
	if err != nil {
		return TransferPlan{}, fmt.Errorf("Zielort: %w", err)
	}
	for i := range items {
		it := &items[i]
		if it.Status != "" || it.DstRel == "" {
			continue
		}
		if plan.Rename && it.Rel == it.DstRel {
			it.Status, it.Error = "blocked", "Quelle und Ziel sind dieselbe Stelle"
			plan.Blocked = true
			continue
		}
		if ds := dstStats[it.DstRel]; ds.Exists && !it.IsDir {
			it.Status = "conflict"
			plan.Conflicts++
		} else {
			it.Status = "ok"
		}
	}

	// Sperren und Verweise (Quelle)
	if req.Mode == ModeMove || true {
		var abss []string
		for _, it := range items {
			if !it.IsDir && it.Status != "blocked" {
				abss = append(abss, src.Abs(it.Rel))
			}
		}
		if len(abss) > 0 {
			uses, err := m.UsageFor(ctx, abss, &src)
			if err != nil {
				return TransferPlan{}, err
			}
			for i := range items {
				it := &items[i]
				u := uses[src.Abs(it.Rel)]
				if u == nil || it.IsDir || it.Status == "blocked" {
					continue
				}
				it.Usage = u
				if req.Mode == ModeMove {
					switch {
					case len(u.Absolute) > 0:
						it.Status, it.Error = "blocked", u.Absolute[0].Text
						plan.Blocked = true
					case len(u.Assets) > 0:
						it.Status, it.Error = "blocked", fmt.Sprintf("gehört zu Asset „%s“ — Verschieben würde den Verweis des Assets brechen; bitte kopieren", u.Assets[0].Title)
						plan.Blocked = true
					case len(u.Hard) > 0:
						it.Status, it.Error = "locked", u.Hard[0].Text
						plan.NeedsForce = true
					case len(u.Soft) > 0:
						it.Status, it.Error = "confirm", u.Soft[0].Text
						plan.NeedsConfirm = true
					}
					continue
				}
				// Kopieren liest nur: gesperrt ist es, solange die Datei noch geschrieben wird (Aufnahme, ffmpeg-Auftrag).
				for _, r := range u.Absolute {
					if r.Kind == "recording" || r.Kind == "job" {
						it.Status, it.Error = "blocked", r.Text+" — Kopieren erst nach dem Ende"
						plan.Blocked = true
						break
					}
				}
			}
		}
	}

	// Platz am Ziel (bei einem Umbenennen innerhalb eines Ortes wird nichts kopiert)
	for _, it := range items {
		if !it.IsDir && it.Status != "blocked" {
			plan.Files++
			plan.TotalBytes += it.Size
		}
	}
	if !plan.Rename && plan.TotalBytes > 0 {
		if raw, err := m.rootOp(dst, jobwire.FileOp{Op: jobwire.FileOpDF}); err == nil {
			var df jobwire.DFResult
			if json.Unmarshal(raw, &df) == nil {
				plan.DstFree = df.Free
				if df.Free > 0 && plan.TotalBytes+spaceMargin > df.Free {
					plan.NoSpace, plan.Blocked = true, true
				}
			}
		}
	}
	plan.Items = items
	return plan, nil
}

// ---- Ausführen -----------------------------------------------------------------------------------------------------

type transferRun struct {
	t      *Transfer
	cancel context.CancelFunc
	done   atomic.Int64
	cur    atomic.Value // string
	mu     sync.Mutex
}

type transferMgr struct {
	mu   sync.Mutex
	runs map[string]*transferRun
	sem  chan struct{}
}

func (m *Module) tmgr() *transferMgr {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.transfers == nil {
		m.transfers = &transferMgr{runs: map[string]*transferRun{}, sem: make(chan struct{}, maxParallelTransfs)}
	}
	return m.transfers
}

// ExecTransfer prüft die Anfrage erneut und startet die Übertragung im Hintergrund.
func (m *Module) ExecTransfer(ctx context.Context, req TransferRequest, actor string, canForce bool) (Transfer, TransferPlan, error) {
	plan, err := m.PlanTransfer(ctx, req)
	if err != nil {
		return Transfer{}, plan, err
	}
	if plan.Blocked {
		return Transfer{}, plan, fmt.Errorf("blockiert: %s", firstTransferWith(plan.Items, "blocked"))
	}
	if plan.NeedsForce {
		if !req.Force {
			return Transfer{}, plan, fmt.Errorf("gesperrt: %s — nur mit „Erzwingen“", firstTransferWith(plan.Items, "locked"))
		}
		if !canForce {
			return Transfer{}, plan, fmt.Errorf("Erzwingen verlangt das Recht „Gesperrte Dateien löschen“")
		}
		if len(strings.TrimSpace(req.Reason)) < 5 {
			return Transfer{}, plan, fmt.Errorf("Erzwingen verlangt eine Begründung (mindestens 5 Zeichen)")
		}
	}
	if plan.NeedsConfirm && !req.Confirm && !req.Force {
		return Transfer{}, plan, fmt.Errorf("Hinweise sind zu bestätigen: %s", firstTransferWith(plan.Items, "confirm"))
	}
	if plan.Conflicts > 0 && req.Conflict == "" {
		req.Conflict = ConflictRename
	}
	if req.Conflict != "" && req.Conflict != ConflictSkip && req.Conflict != ConflictOverwrite && req.Conflict != ConflictRename {
		return Transfer{}, plan, fmt.Errorf("Konfliktregel skip, overwrite oder rename angeben")
	}
	if req.Conflict == "" {
		req.Conflict = ConflictRename
	}
	if plan.Files == 0 && len(plan.Items) == 0 {
		return Transfer{}, plan, fmt.Errorf("nichts zu übertragen")
	}
	now := time.Now().UTC()
	t := &Transfer{
		ID: newID(), Mode: req.Mode, SrcRootID: req.SrcRootID, SrcRootName: plan.src.Name, DstRootID: req.DstRootID, DstRootName: plan.dst.Name,
		Paths: req.Paths, DstDir: req.DstDir, Conflict: req.Conflict, Status: TrQueued, TotalBytes: plan.TotalBytes, FilesTotal: plan.Files,
		CreatedBy: actor, CreatedAt: now,
	}
	pj, _ := json.Marshal(req.Paths)
	if _, err := m.db().ExecContext(ctx, `INSERT INTO file_transfers (id, mode, src_root_id, dst_root_id, src_paths, dst_dir, conflict, status, total_bytes, files_total, created_by, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, t.ID, t.Mode, t.SrcRootID, t.DstRootID, string(pj), t.DstDir, t.Conflict, t.Status, t.TotalBytes, t.FilesTotal, actor, now); err != nil {
		return Transfer{}, plan, err
	}
	rctx, cancel := context.WithCancel(context.Background())
	run := &transferRun{t: t, cancel: cancel}
	g := m.tmgr()
	g.mu.Lock()
	g.runs[t.ID] = run
	g.mu.Unlock()
	m.audit(actor, "file-transfer", t.ID, "file.transfer.start", map[string]any{"mode": t.Mode, "from": plan.src.Name, "to": plan.dst.Name, "paths": req.Paths, "dstDir": req.DstDir, "files": plan.Files, "bytes": plan.TotalBytes, "forced": plan.NeedsForce, "reason": req.Reason})
	go m.runTransfer(rctx, run, plan, req)
	return *t, plan, nil
}

func firstTransferWith(items []TransferItem, status string) string {
	for _, it := range items {
		if it.Status == status {
			return it.Rel + ": " + it.Error
		}
	}
	return ""
}

func (m *Module) saveTransfer(run *transferRun, final bool) {
	t := run.t
	run.mu.Lock()
	snapshot := *t
	run.mu.Unlock()
	items := snapshot.Items
	if len(items) > 300 {
		items = items[:300]
	}
	ij, _ := json.Marshal(items)
	cur, _ := run.cur.Load().(string)
	_ = cur
	_, err := m.db().Exec(`UPDATE file_transfers SET status=$2, done_bytes=$3, files_done=$4, files_skipped=$5, error=$6, items_json=$7, started_at=$8, finished_at=$9 WHERE id=$1`,
		snapshot.ID, snapshot.Status, run.done.Load(), snapshot.FilesDone, snapshot.FilesSkipped, snapshot.Error, string(ij), snapshot.StartedAt, snapshot.FinishedAt)
	if err != nil && final {
		slog.Warn("files: Übertragung nicht gespeichert", "id", snapshot.ID, "error", err)
	}
}

func (m *Module) setTmp(t *Transfer, rootID, rel string) {
	_, _ = m.db().Exec(`UPDATE file_transfers SET tmp_root_id=$2, tmp_rel=$3 WHERE id=$1`, t.ID, rootID, rel)
}

func (m *Module) runTransfer(ctx context.Context, run *transferRun, plan TransferPlan, req TransferRequest) {
	g := m.tmgr()
	t := run.t
	defer func() {
		if p := recover(); p != nil {
			slog.Error("files: Übertragung abgestürzt", "id", t.ID, "panic", p)
			run.mu.Lock()
			t.Status, t.Error = TrFailed, fmt.Sprintf("interner Fehler: %v", p)
			run.mu.Unlock()
			m.saveTransfer(run, true)
		}
		g.mu.Lock()
		delete(g.runs, t.ID)
		g.mu.Unlock()
	}()
	// Warteschlange: höchstens zwei Übertragungen zugleich
	select {
	case g.sem <- struct{}{}:
		defer func() { <-g.sem }()
	case <-ctx.Done():
		run.mu.Lock()
		t.Status = TrCancelled
		now := time.Now().UTC()
		t.FinishedAt = &now
		run.mu.Unlock()
		m.saveTransfer(run, true)
		return
	}
	start := time.Now().UTC()
	run.mu.Lock()
	t.Status, t.StartedAt = TrRunning, &start
	t.Items = plan.Items
	run.mu.Unlock()
	m.saveTransfer(run, false)

	stop := make(chan struct{})
	go func() { // Fortschritt regelmäßig sichern
		tk := time.NewTicker(1500 * time.Millisecond)
		defer tk.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tk.C:
				m.saveTransfer(run, false)
			}
		}
	}()
	err := m.doTransfer(ctx, run, plan, req)
	close(stop)

	run.mu.Lock()
	fin := time.Now().UTC()
	t.FinishedAt = &fin
	switch {
	case errors.Is(ctx.Err(), context.Canceled):
		t.Status, t.Error = TrCancelled, "abgebrochen"
	case err != nil:
		t.Status, t.Error = TrFailed, err.Error()
	default:
		t.Status = TrDone
		for _, it := range t.Items {
			if it.Status == "error" {
				t.Status, t.Error = TrFailed, "einzelne Dateien sind fehlgeschlagen"
				break
			}
		}
	}
	status := t.Status
	run.mu.Unlock()
	m.saveTransfer(run, true)
	m.audit(t.CreatedBy, "file-transfer", t.ID, "file.transfer."+status, map[string]any{"mode": t.Mode, "files": t.FilesDone, "skipped": t.FilesSkipped, "bytes": run.done.Load(), "error": t.Error})
	m.event("omp.files.transfer."+status, map[string]any{"id": t.ID, "mode": t.Mode})
	if status == TrFailed {
		m.alert("file-transfer-failed", "warning", t.ID, t.SrcRootName+" → "+t.DstRootName, "Dateiübertragung fehlgeschlagen: "+t.Error)
	}
}

func (m *Module) doTransfer(ctx context.Context, run *transferRun, plan TransferPlan, req TransferRequest) error {
	t := run.t
	src, dst := plan.src, plan.dst
	// belegte Zielnamen dieser Übertragung (für „umbenennen“)
	taken := map[string]bool{}
	for _, it := range plan.Items {
		if it.DstRel != "" {
			taken[it.DstRel] = true
		}
	}
	exists := func(rel string) bool {
		if taken[rel] {
			return true
		}
		st, err := m.statRels(dst, []string{rel})
		return err == nil && st[rel].Exists
	}
	okTops := map[string]int{} // je gewählter Quelle: Anzahl fehlgeschlagener Dateien
	for i := range plan.Items {
		if ctx.Err() != nil {
			return nil
		}
		it := &plan.Items[i]
		run.cur.Store(it.Rel)
		overwrite := false
		if it.Status == "conflict" {
			switch req.Conflict {
			case ConflictSkip:
				m.mark(run, i, "skipped", "übersprungen: Ziel existiert")
				run.mu.Lock()
				t.FilesSkipped++
				run.mu.Unlock()
				okTops[it.Top]++ // Quelle bleibt, weil nicht alles übertragen wurde
				continue
			case ConflictOverwrite:
				overwrite = true
			default:
				delete(taken, it.DstRel)
				it.DstRel = jobwire.UniqueRel(it.DstRel, exists)
				taken[it.DstRel] = true
			}
		}
		if it.IsDir {
			if _, err := m.rootOp(dst, jobwire.FileOp{Op: jobwire.FileOpMkdir, Rel: it.DstRel}); err != nil {
				m.mark(run, i, "error", err.Error())
				okTops[it.Top]++
			} else {
				m.mark(run, i, "done", "")
			}
			continue
		}
		var err error
		if plan.Rename {
			_, err = m.rootOp(src, jobwire.FileOp{Op: jobwire.FileOpMove, Rel: it.Rel, DstRel: it.DstRel, Overwrite: overwrite})
			if err == nil {
				run.done.Add(it.Size)
			}
		} else {
			err = m.copyFile(ctx, run, src, dst, it, overwrite)
		}
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			m.mark(run, i, "error", err.Error())
			okTops[it.Top]++
			continue
		}
		m.mark(run, i, "done", "")
		run.mu.Lock()
		t.FilesDone++
		run.mu.Unlock()
	}
	// Verschieben zwischen Orten: die Quelle danach in den Papierkorb — nur, was vollständig und geprüft angekommen ist
	if req.Mode == ModeMove && !plan.Rename && ctx.Err() == nil {
		var gone []string
		seen := map[string]bool{}
		for _, it := range plan.Items {
			if seen[it.Top] || okTops[it.Top] > 0 {
				continue
			}
			seen[it.Top] = true
			gone = append(gone, it.Top)
		}
		if len(gone) > 0 {
			if raw, err := m.rootOp(src, jobwire.FileOp{Op: jobwire.FileOpTrash, Rels: gone}); err != nil {
				return fmt.Errorf("Quelle nicht in den Papierkorb gelegt (die Kopie am Ziel ist vollständig): %w", err)
			} else {
				var res []jobwire.TrashResult
				_ = json.Unmarshal(raw, &res)
				for _, r := range res {
					if !r.OK {
						return fmt.Errorf("Quelle %s nicht in den Papierkorb gelegt (die Kopie am Ziel ist vollständig): %s", r.Rel, r.Error)
					}
				}
			}
		}
	}
	return nil
}

func (m *Module) mark(run *transferRun, i int, status, msg string) {
	run.mu.Lock()
	defer run.mu.Unlock()
	if i < len(run.t.Items) {
		run.t.Items[i].Status = status
		run.t.Items[i].Error = msg
	}
}

type chunkMsg struct {
	res jobwire.ChunkResult
	err error
}

// retry wiederholt eine kurze Operation bei vorübergehenden Fehlern (Netz, Mount); ungültige Anfragen nie.
func retry(ctx context.Context, fn func() error) error {
	var err error
	for i := 0; i < chunkRetries; i++ {
		if err = fn(); err == nil {
			return nil
		}
		if ctx.Err() != nil || jobwireInvalid(err) {
			return err
		}
		select {
		case <-ctx.Done():
			return err
		case <-time.After(time.Duration(i+1) * 700 * time.Millisecond):
		}
	}
	return err
}

// copyFile überträgt eine Datei blockweise: Lesen und Schreiben laufen überlappend (ein Block Vorlauf).
func (m *Module) copyFile(ctx context.Context, run *transferRun, src, dst Root, it *TransferItem, overwrite bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	m.setTmp(run.t, dst.ID, it.DstRel)
	defer m.setTmp(run.t, "", "")
	aborted := func() {
		bg, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = bg
		_, _ = m.rootOp(dst, jobwire.FileOp{Op: jobwire.FileOpAbort, Rel: it.DstRel})
	}
	ch := make(chan chunkMsg, 2)
	rctx, stopRead := context.WithCancel(ctx)
	defer stopRead()
	go func() { // Leser
		defer close(ch)
		var off int64
		for {
			var res jobwire.ChunkResult
			err := retry(rctx, func() error {
				raw, err := m.rootOp(src, jobwire.FileOp{Op: jobwire.FileOpReadChunk, Rel: it.Rel, Offset: off, Limit: jobwire.MaxChunk})
				if err != nil {
					return err
				}
				return json.Unmarshal(raw, &res)
			})
			select {
			case ch <- chunkMsg{res: res, err: err}:
			case <-rctx.Done():
				return
			}
			if err != nil || res.EOF {
				return
			}
			off += int64(len(res.Data))
		}
	}()
	var written int64
	var total int64 = -1
	got := false
	for msg := range ch {
		if msg.err != nil {
			aborted()
			return fmt.Errorf("Lesen am Quellort: %w", msg.err)
		}
		if ctx.Err() != nil {
			aborted()
			return ctx.Err()
		}
		got = true
		total = msg.res.Size
		var w jobwire.WriteResult
		err := retry(ctx, func() error {
			raw, err := m.rootOp(dst, jobwire.FileOp{Op: jobwire.FileOpWriteChunk, Rel: it.DstRel, Offset: written, Data: msg.res.Data})
			if err != nil {
				// ein wiederholter Block nach verlorener Antwort: Versatz stimmt nicht mehr — dann ist er schon geschrieben
				return err
			}
			return json.Unmarshal(raw, &w)
		})
		if err != nil {
			aborted()
			return fmt.Errorf("Schreiben am Zielort: %w", err)
		}
		if w.SHA != msg.res.SHA {
			aborted()
			return fmt.Errorf("Prüfsumme eines Blocks stimmt nicht (Übertragungsfehler bei Versatz %d)", written)
		}
		written += int64(len(msg.res.Data))
		if w.Written != written {
			aborted()
			return fmt.Errorf("Zielort meldet %d Byte, erwartet %d", w.Written, written)
		}
		run.done.Add(int64(len(msg.res.Data)))
	}
	if !got {
		aborted()
		return fmt.Errorf("keine Daten gelesen")
	}
	if ctx.Err() != nil {
		aborted()
		return ctx.Err()
	}
	if total >= 0 && written != total {
		aborted()
		return fmt.Errorf("gelesen %d Byte, Datei hat %d", written, total)
	}
	// Hat sich die Quelle währenddessen geändert? Dann ist die Kopie nicht verlässlich.
	if st, err := m.statRels(src, []string{it.Rel}); err == nil {
		if s := st[it.Rel]; !s.Exists || s.Size != written || (it.MTime != 0 && s.MTime != it.MTime) {
			aborted()
			return fmt.Errorf("die Quelle wurde während der Übertragung verändert")
		}
	}
	if _, err := m.rootOp(dst, jobwire.FileOp{Op: jobwire.FileOpCommit, Rel: it.DstRel, Size: written, MTimeMs: it.MTime, Overwrite: overwrite}); err != nil {
		aborted()
		return fmt.Errorf("Fertigstellen am Zielort: %w", err)
	}
	return nil
}

// ---- Abfragen ------------------------------------------------------------------------------------------------------

// ListTransfers liefert laufende und die letzten beendeten Übertragungen, neueste zuerst.
func (m *Module) ListTransfers(ctx context.Context, limit int) ([]Transfer, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := m.db().QueryContext(ctx, `SELECT id, mode, src_root_id, dst_root_id, src_paths, dst_dir, conflict, status, total_bytes, done_bytes, files_total, files_done, files_skipped,
		error, items_json, created_by, created_at, started_at, finished_at FROM file_transfers ORDER BY created_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	names := map[string]string{}
	if roots, err := ListRoots(ctx, m.db()); err == nil {
		for _, r := range roots {
			names[r.ID] = r.Name
		}
	}
	g := m.tmgr()
	out := []Transfer{}
	for rows.Next() {
		var t Transfer
		var paths, items string
		var started, finished sql.NullTime
		if err := rows.Scan(&t.ID, &t.Mode, &t.SrcRootID, &t.DstRootID, &paths, &t.DstDir, &t.Conflict, &t.Status, &t.TotalBytes, &t.DoneBytes, &t.FilesTotal, &t.FilesDone, &t.FilesSkipped,
			&t.Error, &items, &t.CreatedBy, &t.CreatedAt, &started, &finished); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(paths), &t.Paths)
		_ = json.Unmarshal([]byte(items), &t.Items)
		t.SrcRootName, t.DstRootName = names[t.SrcRootID], names[t.DstRootID]
		if started.Valid {
			v := started.Time
			t.StartedAt = &v
		}
		if finished.Valid {
			v := finished.Time
			t.FinishedAt = &v
		}
		g.mu.Lock()
		if run, ok := g.runs[t.ID]; ok {
			t.DoneBytes = run.done.Load()
			t.Current, _ = run.cur.Load().(string)
			run.mu.Lock()
			t.FilesDone, t.FilesSkipped, t.Status = run.t.FilesDone, run.t.FilesSkipped, run.t.Status
			run.mu.Unlock()
		}
		g.mu.Unlock()
		if t.Status == TrRunning && t.StartedAt != nil {
			if secs := time.Since(*t.StartedAt).Seconds(); secs > 1 {
				t.BytesPerSec = float64(t.DoneBytes) / secs
			}
		}
		out = append(out, t)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, rows.Err()
}

// CancelTransfer bricht eine laufende oder wartende Übertragung ab; halbe Dateien am Ziel werden entfernt.
func (m *Module) CancelTransfer(id, actor string) error {
	g := m.tmgr()
	g.mu.Lock()
	run, ok := g.runs[id]
	g.mu.Unlock()
	if !ok {
		return ErrNotFound
	}
	run.cancel()
	m.audit(actor, "file-transfer", id, "file.transfer.cancel", nil)
	return nil
}

// recoverTransfers: nach einem Neustart sind laufende Übertragungen unterbrochen; halbe Dateien am Ziel werden entfernt.
func (m *Module) recoverTransfers(ctx context.Context) {
	db := m.db()
	if db == nil {
		return
	}
	rows, err := db.QueryContext(ctx, `SELECT id, tmp_root_id, tmp_rel FROM file_transfers WHERE status IN ('queued','running')`)
	if err != nil {
		return
	}
	type rec struct{ id, root, rel string }
	var recs []rec
	for rows.Next() {
		var r rec
		if rows.Scan(&r.id, &r.root, &r.rel) == nil {
			recs = append(recs, r)
		}
	}
	rows.Close()
	for _, r := range recs {
		if r.root != "" && r.rel != "" {
			if root, err := GetRoot(ctx, db, r.root); err == nil {
				_, _ = m.rootOp(root, jobwire.FileOp{Op: jobwire.FileOpAbort, Rel: r.rel})
			}
		}
		_, _ = db.ExecContext(ctx, `UPDATE file_transfers SET status = 'interrupted', error = 'durch Neustart unterbrochen', finished_at = now(), tmp_root_id = '', tmp_rel = '' WHERE id = $1`, r.id)
	}
}
