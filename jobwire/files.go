package jobwire

// Dateioperationen auf einem Host (Kapitel 86): Host-Agent und Orchestrator (für den eigenen Rechner) führen dieselbe
// Implementierung aus. Alle Pfade sind WURZEL-RELATIV; nichts verlässt die Wurzel (kein „..“, keine absoluten Pfade,
// Symlinks werden aufgelöst und gegen die Wurzel geprüft). „Löschen“ verschiebt in `<Wurzel>/.trash/<Unix-ms>/<rel>`
// (gleiche Platte, `rename`), endgültig entfernt nur `purge`.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// ActionFiles ist die Host-Agent-Aktion; die Einzelaktion steht in FileOp.Op.
const ActionFiles = "files"

// TrashDirName ist der Papierkorb-Ordner in jeder Wurzel (für Listen und Familienzuordnung ausgeblendet).
const TrashDirName = ".trash"

// Operationen.
const (
	FileOpStat      = "stat"       // Rels → []FileStat
	FileOpList      = "list"       // Rel (Ordner), Cursor, Limit → FileListResult
	FileOpTrash     = "trash"      // Rels → []TrashResult (in den Papierkorb)
	FileOpTrashList = "trash-list" // → []TrashEntry
	FileOpRestore   = "restore"    // IDs → []TrashResult
	FileOpPurge     = "purge"      // IDs oder OlderThanMs oder FreeBytes → PurgeResult
	FileOpDF        = "df"         // → DFResult
)

// FileOp ist eine Anfrage.
type FileOp struct {
	Op   string `json:"op"`
	Root string `json:"root"`
	// Stat/Trash: mehrere; List: Rel = Ordner.
	Rels   []string `json:"rels,omitempty"`
	Rel    string   `json:"rel,omitempty"`
	Cursor string   `json:"cursor,omitempty"`
	Limit  int      `json:"limit,omitempty"`
	// Restore/Purge.
	IDs []string `json:"ids,omitempty"`
	// Purge: alles im Papierkorb, das vor diesem Zeitpunkt (Unix-ms) hineinkam.
	OlderThanMs int64 `json:"olderThanMs,omitempty"`
	// Purge (Notfall): älteste zuerst löschen, bis so viele Bytes FREI sind (nur Papierkorb).
	FreeBytes int64 `json:"freeBytes,omitempty"`
	// Purge (Notfall): Einträge jünger als dies (Unix-ms) bleiben unangetastet (Schutzfrist).
	KeepNewerThanMs int64 `json:"keepNewerThanMs,omitempty"`
}

// FileStat ist das Ergebnis je Pfad. Err gesetzt = nicht prüfbar (z. B. Zugriff verweigert) — NICHT „fehlt“.
type FileStat struct {
	Rel    string `json:"rel"`
	Exists bool   `json:"exists"`
	IsDir  bool   `json:"isDir,omitempty"`
	Size   int64  `json:"size,omitempty"`
	MTime  int64  `json:"mtimeMs,omitempty"`
	Err    string `json:"err,omitempty"`
}

// FileEntry ist ein Verzeichniseintrag.
type FileEntry struct {
	Name  string `json:"name"`
	IsDir bool   `json:"isDir,omitempty"`
	Size  int64  `json:"size,omitempty"`
	MTime int64  `json:"mtimeMs,omitempty"`
	Link  bool   `json:"link,omitempty"`
}

// FileListResult: Next leer = Ende. Cursor ist der zuletzt gelieferte Name (Einträge sind nach Name sortiert).
type FileListResult struct {
	Entries []FileEntry `json:"entries"`
	Next    string      `json:"next,omitempty"`
}

// TrashEntry ist ein Papierkorb-Eintrag; ID = "<Unix-ms>/<rel>".
type TrashEntry struct {
	ID        string `json:"id"`
	Rel       string `json:"rel"`
	DeletedMs int64  `json:"deletedMs"`
	Size      int64  `json:"size"`
	IsDir     bool   `json:"isDir,omitempty"`
}

// TrashResult: Ergebnis je Pfad bzw. Eintrag.
type TrashResult struct {
	Rel   string `json:"rel"`
	ID    string `json:"id,omitempty"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

// PurgeResult fasst eine Leerung zusammen.
type PurgeResult struct {
	Removed    int   `json:"removed"`
	FreedBytes int64 `json:"freedBytes"`
	FreeNow    int64 `json:"freeNow"`
}

// DFResult: Platz der Platte, auf der die Wurzel liegt.
type DFResult struct {
	Free  int64 `json:"free"`
	Total int64 `json:"total"`
}

// ErrFileOp: ungültige Anfrage (Pfad, Wurzel, Operation).
var ErrFileOp = errors.New("Dateioperation ungültig")

// CleanRel prüft einen wurzelrelativen Pfad: nicht leer (außer allowEmpty), nicht absolut, kein „..“, kein NUL, nicht im Papierkorb.
func CleanRel(rel string, allowEmpty bool) (string, error) {
	if strings.ContainsRune(rel, 0) {
		return "", fmt.Errorf("%w: Steuerzeichen im Pfad", ErrFileOp)
	}
	rel = filepath.ToSlash(rel)
	if strings.HasPrefix(rel, "/") {
		return "", fmt.Errorf("%w: absoluter Pfad nicht erlaubt", ErrFileOp)
	}
	for _, seg := range strings.Split(rel, "/") {
		if seg == ".." {
			return "", fmt.Errorf("%w: „..“ im Pfad nicht erlaubt", ErrFileOp)
		}
	}
	c := filepath.ToSlash(filepath.Clean(rel))
	if c == "." {
		c = ""
	}
	if c == "" && !allowEmpty {
		return "", fmt.Errorf("%w: Pfad fehlt", ErrFileOp)
	}
	if c == TrashDirName || strings.HasPrefix(c, TrashDirName+"/") {
		return "", fmt.Errorf("%w: der Papierkorb ist kein Ziel", ErrFileOp)
	}
	return c, nil
}

// checkRoot: absolute, saubere Wurzel, die ein Verzeichnis ist; „/“ und Ein-Segment-Wurzeln wie „/etc“ werden für
// ändernde Operationen abgelehnt (Versehensschutz).
func checkRoot(root string, mutating bool) (string, error) {
	if root == "" || !filepath.IsAbs(root) || strings.ContainsRune(root, 0) {
		return "", fmt.Errorf("%w: Wurzel muss ein absoluter Pfad sein", ErrFileOp)
	}
	root = filepath.Clean(root)
	if mutating && strings.Count(strings.Trim(root, "/"), "/") < 1 {
		return "", fmt.Errorf("%w: Wurzel %q ist zu allgemein für ändernde Operationen", ErrFileOp, root)
	}
	real, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", fmt.Errorf("Wurzel nicht erreichbar: %w", err)
	}
	st, err := os.Stat(real)
	if err != nil || !st.IsDir() {
		return "", fmt.Errorf("%w: Wurzel ist kein Verzeichnis", ErrFileOp)
	}
	return real, nil
}

// resolveIn liefert den absoluten Pfad von rel unter der (bereits aufgelösten) Wurzel. Der ELTERN-Ordner wird aufgelöst und
// muss unter der Wurzel liegen; die letzte Komponente bleibt unaufgelöst (ein Symlink wird als Link behandelt, nie verfolgt).
func resolveIn(root, rel string) (string, error) {
	if rel == "" {
		return root, nil
	}
	full := filepath.Join(root, filepath.FromSlash(rel))
	parent := ResolveExisting(filepath.Dir(full))
	if parent != root && !strings.HasPrefix(parent, root+string(filepath.Separator)) {
		return "", fmt.Errorf("%w: Pfad verlässt die Wurzel", ErrFileOp)
	}
	return filepath.Join(parent, filepath.Base(full)), nil
}

func unixMs(t time.Time) int64 { return t.UnixNano() / 1e6 }

// RunFileOp führt eine Operation aus und liefert das Ergebnis als JSON.
func RunFileOp(op FileOp) ([]byte, error) {
	mutating := op.Op == FileOpTrash || op.Op == FileOpRestore || op.Op == FileOpPurge
	root, err := checkRoot(op.Root, mutating)
	if err != nil {
		return nil, err
	}
	var out any
	switch op.Op {
	case FileOpStat:
		out, err = opStat(root, op)
	case FileOpList:
		out, err = opList(root, op)
	case FileOpTrash:
		out, err = opTrash(root, op)
	case FileOpTrashList:
		out, err = opTrashList(root)
	case FileOpRestore:
		out, err = opRestore(root, op)
	case FileOpPurge:
		out, err = opPurge(root, op)
	case FileOpDF:
		out, err = opDF(root)
	default:
		return nil, fmt.Errorf("%w: unbekannte Operation %q", ErrFileOp, op.Op)
	}
	if err != nil {
		return nil, err
	}
	return json.Marshal(out)
}

func opStat(root string, op FileOp) ([]FileStat, error) {
	if len(op.Rels) > 5000 {
		return nil, fmt.Errorf("%w: höchstens 5000 Pfade je Aufruf", ErrFileOp)
	}
	out := make([]FileStat, 0, len(op.Rels))
	for _, r := range op.Rels {
		st := FileStat{Rel: r}
		rel, err := CleanRel(r, false)
		if err != nil {
			st.Err = err.Error()
			out = append(out, st)
			continue
		}
		p, err := resolveIn(root, rel)
		if err != nil {
			st.Err = err.Error()
			out = append(out, st)
			continue
		}
		// Ein Symlink gilt als vorhanden, wenn sein Ziel vorhanden ist (Medien liegen oft per Link im Medienordner).
		fi, err := os.Stat(p)
		switch {
		case err == nil:
			st.Exists, st.IsDir, st.Size, st.MTime = true, fi.IsDir(), fi.Size(), unixMs(fi.ModTime())
		case errors.Is(err, fs.ErrNotExist):
			// nicht vorhanden
		default:
			st.Err = err.Error() // z. B. Zugriff verweigert, Netzlaufwerk hängt: unbekannt, nicht „fehlt“
		}
		out = append(out, st)
	}
	return out, nil
}

func opList(root string, op FileOp) (FileListResult, error) {
	rel, err := CleanRel(op.Rel, true)
	if err != nil {
		return FileListResult{}, err
	}
	dir, err := resolveIn(root, rel)
	if err != nil {
		return FileListResult{}, err
	}
	if real := ResolveExisting(dir); real != root && !strings.HasPrefix(real, root+string(filepath.Separator)) {
		return FileListResult{}, fmt.Errorf("%w: Ordner liegt (über einen Link) außerhalb der Wurzel", ErrFileOp)
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return FileListResult{}, err
	}
	limit := op.Limit
	if limit <= 0 || limit > 2000 {
		limit = 500
	}
	names := make([]os.DirEntry, 0, len(ents))
	for _, e := range ents {
		if rel == "" && e.Name() == TrashDirName {
			continue
		}
		names = append(names, e)
	}
	sort.Slice(names, func(i, j int) bool { return names[i].Name() < names[j].Name() })
	res := FileListResult{Entries: []FileEntry{}}
	for _, e := range names {
		if op.Cursor != "" && e.Name() <= op.Cursor {
			continue
		}
		if len(res.Entries) >= limit {
			res.Next = res.Entries[len(res.Entries)-1].Name
			break
		}
		fe := FileEntry{Name: e.Name(), IsDir: e.IsDir()}
		if e.Type()&fs.ModeSymlink != 0 {
			fe.Link = true
			if st, err := os.Stat(filepath.Join(dir, e.Name())); err == nil {
				fe.IsDir = st.IsDir()
			}
		}
		if info, err := e.Info(); err == nil {
			if !fe.IsDir {
				fe.Size = info.Size()
			}
			fe.MTime = unixMs(info.ModTime())
		}
		res.Entries = append(res.Entries, fe)
	}
	return res, nil
}

func opTrash(root string, op FileOp) ([]TrashResult, error) {
	stamp := strconv.FormatInt(unixMs(time.Now()), 10)
	out := make([]TrashResult, 0, len(op.Rels))
	for _, r := range op.Rels {
		tr := TrashResult{Rel: r}
		rel, err := CleanRel(r, false)
		if err != nil {
			tr.Error = err.Error()
			out = append(out, tr)
			continue
		}
		src, err := resolveIn(root, rel)
		if err != nil {
			tr.Error = err.Error()
			out = append(out, tr)
			continue
		}
		if _, err := os.Lstat(src); err != nil {
			tr.Error = "Datei existiert nicht"
			out = append(out, tr)
			continue
		}
		dst := filepath.Join(root, TrashDirName, stamp, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			tr.Error = err.Error()
			out = append(out, tr)
			continue
		}
		if err := os.Rename(src, dst); err != nil {
			tr.Error = err.Error() // z. B. EXDEV bei eingehängtem Unterordner: nie kopieren+löschen
			out = append(out, tr)
			continue
		}
		tr.OK, tr.ID = true, stamp+"/"+rel
		out = append(out, tr)
	}
	return out, nil
}

func trashPath(root, id string) (rel string, abs string, ms int64, err error) {
	i := strings.IndexByte(id, '/')
	if i <= 0 {
		return "", "", 0, fmt.Errorf("%w: ungültige Papierkorb-Kennung", ErrFileOp)
	}
	ms, perr := strconv.ParseInt(id[:i], 10, 64)
	if perr != nil || ms <= 0 {
		return "", "", 0, fmt.Errorf("%w: ungültige Papierkorb-Kennung", ErrFileOp)
	}
	rel, err = CleanRel(id[i+1:], false)
	if err != nil {
		return "", "", 0, err
	}
	return rel, filepath.Join(root, TrashDirName, id[:i], filepath.FromSlash(rel)), ms, nil
}

func opTrashList(root string) ([]TrashEntry, error) {
	base := filepath.Join(root, TrashDirName)
	stamps, err := os.ReadDir(base)
	if errors.Is(err, fs.ErrNotExist) {
		return []TrashEntry{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := []TrashEntry{}
	for _, s := range stamps {
		ms, perr := strconv.ParseInt(s.Name(), 10, 64)
		if perr != nil || !s.IsDir() {
			continue
		}
		sdir := filepath.Join(base, s.Name())
		// Eintrag = oberste Datei/der oberste Ordner, den die Löschung verschoben hat: der erste Pfad, der kein reiner Zwischenordner ist.
		// Wir listen Blätter (Dateien und leere Ordner); verschobene Ordner erscheinen als ihre Dateien.
		_ = filepath.WalkDir(sdir, func(p string, d fs.DirEntry, werr error) error {
			if werr != nil || p == sdir {
				return nil
			}
			if d.IsDir() {
				if es, e := os.ReadDir(p); e == nil && len(es) == 0 {
					rel, _ := filepath.Rel(sdir, p)
					out = append(out, TrashEntry{ID: s.Name() + "/" + filepath.ToSlash(rel), Rel: filepath.ToSlash(rel), DeletedMs: ms, IsDir: true})
				}
				return nil
			}
			rel, _ := filepath.Rel(sdir, p)
			var size int64
			if info, e := d.Info(); e == nil {
				size = info.Size()
			}
			out = append(out, TrashEntry{ID: s.Name() + "/" + filepath.ToSlash(rel), Rel: filepath.ToSlash(rel), DeletedMs: ms, Size: size})
			return nil
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].DeletedMs != out[j].DeletedMs {
			return out[i].DeletedMs > out[j].DeletedMs
		}
		return out[i].Rel < out[j].Rel
	})
	return out, nil
}

func opRestore(root string, op FileOp) ([]TrashResult, error) {
	out := make([]TrashResult, 0, len(op.IDs))
	for _, id := range op.IDs {
		tr := TrashResult{ID: id}
		rel, src, _, err := trashPath(root, id)
		if err != nil {
			tr.Error = err.Error()
			out = append(out, tr)
			continue
		}
		tr.Rel = rel
		dst, err := resolveIn(root, rel)
		if err != nil {
			tr.Error = err.Error()
			out = append(out, tr)
			continue
		}
		if _, err := os.Lstat(dst); err == nil {
			tr.Error = "am Ursprungsort existiert bereits eine Datei"
			out = append(out, tr)
			continue
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			tr.Error = err.Error()
			out = append(out, tr)
			continue
		}
		if err := os.Rename(src, dst); err != nil {
			tr.Error = err.Error()
			out = append(out, tr)
			continue
		}
		pruneEmptyDirs(filepath.Dir(src), filepath.Join(root, TrashDirName))
		tr.OK = true
		out = append(out, tr)
	}
	return out, nil
}

// pruneEmptyDirs entfernt leere Ordner von dir aufwärts bis (ausschließlich) stop.
func pruneEmptyDirs(dir, stop string) {
	for dir != stop && strings.HasPrefix(dir, stop+string(filepath.Separator)) {
		if err := os.Remove(dir); err != nil {
			return
		}
		dir = filepath.Dir(dir)
	}
}

func fileSize(p string) int64 {
	var n int64
	_ = filepath.WalkDir(p, func(_ string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if info, e := d.Info(); e == nil {
				n += info.Size()
			}
		}
		return nil
	})
	return n
}

func opPurge(root string, op FileOp) (PurgeResult, error) {
	var res PurgeResult
	remove := func(e TrashEntry) {
		_, abs, _, err := trashPath(root, e.ID)
		if err != nil {
			return
		}
		size := fileSize(abs)
		if err := os.RemoveAll(abs); err != nil {
			return
		}
		res.Removed++
		res.FreedBytes += size
		pruneEmptyDirs(filepath.Dir(abs), filepath.Join(root, TrashDirName))
	}
	switch {
	case len(op.IDs) > 0:
		for _, id := range op.IDs {
			if _, _, _, err := trashPath(root, id); err != nil {
				return res, err
			}
			remove(TrashEntry{ID: id})
		}
	case op.OlderThanMs > 0:
		all, err := opTrashList(root)
		if err != nil {
			return res, err
		}
		for _, e := range all {
			if e.DeletedMs < op.OlderThanMs {
				remove(e)
			}
		}
	case op.FreeBytes > 0:
		all, err := opTrashList(root)
		if err != nil {
			return res, err
		}
		sort.Slice(all, func(i, j int) bool { return all[i].DeletedMs < all[j].DeletedMs }) // älteste zuerst
		for _, e := range all {
			if df, err := opDF(root); err == nil && df.Free >= op.FreeBytes {
				break
			}
			if op.KeepNewerThanMs > 0 && e.DeletedMs >= op.KeepNewerThanMs {
				continue
			}
			remove(e)
		}
	default:
		return res, fmt.Errorf("%w: purge braucht IDs, OlderThanMs oder FreeBytes", ErrFileOp)
	}
	if df, err := opDF(root); err == nil {
		res.FreeNow = df.Free
	}
	return res, nil
}

func opDF(root string) (DFResult, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(root, &st); err != nil {
		return DFResult{}, err
	}
	bs := int64(st.Bsize)
	return DFResult{Free: int64(st.Bavail) * bs, Total: int64(st.Blocks) * bs}, nil
}
