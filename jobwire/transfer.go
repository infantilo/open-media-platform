package jobwire

// Dateien zwischen Orten übertragen (Kapitel 86, Übertragen): Die Datenbewegung läuft in KURZEN Operationen, die jede für sich
// in die Fristen und die NATS-Nutzlastgrenze passen — der Orchestrator steuert die Schleife (Lesen eines Blocks am Quellort,
// Schreiben am Zielort) und kann dadurch Fortschritt zeigen, abbrechen und Quelle und Ziel auf verschiedenen Hosts haben.
// Geschrieben wird in `<Ziel>.omp-part`; erst `commit` macht daraus die Zieldatei (atomar, nach fsync und Größenprüfung). Ein
// Ingest-Hotfolder sieht so nie eine halbe Datei unter ihrem endgültigen Namen.

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// Operationen.
const (
	FileOpReadChunk  = "read-chunk"  // Rel, Offset, Limit → ChunkResult
	FileOpWriteChunk = "write-chunk" // Rel (Ziel), Offset, Data → WriteResult
	FileOpCommit     = "commit"      // Rel (Ziel), Size, MTimeMs, Overwrite → CommitResult
	FileOpAbort      = "abort"       // Rel (Ziel) → löscht die halbe Datei
	FileOpMove       = "move"        // Rel → DstRel innerhalb der Wurzel (Umbenennen), Overwrite
	FileOpMkdir      = "mkdir"       // Rel → legt den Ordner an
)

// TempSuffix hängt an der Datei, solange sie geschrieben wird.
const TempSuffix = ".omp-part"

// MaxChunk ist die größte Blockgröße je Operation. Base64 macht daraus ~4/3; die NATS-Nutzlast ist standardmäßig 1 MiB.
const MaxChunk = 384 * 1024

func isTransferWrite(op string) bool {
	switch op {
	case FileOpWriteChunk, FileOpCommit, FileOpAbort, FileOpMove, FileOpMkdir:
		return true
	}
	return false
}

// ChunkResult ist ein gelesener Block.
type ChunkResult struct {
	Data []byte `json:"data"`
	Size int64  `json:"size"` // Gesamtgröße der Datei
	EOF  bool   `json:"eof"`
	SHA  string `json:"sha"` // SHA-256 des Blocks
}

// WriteResult ist die Quittung eines geschriebenen Blocks.
type WriteResult struct {
	Written int64  `json:"written"` // Größe der halben Datei nach diesem Block
	SHA     string `json:"sha"`     // SHA-256 der empfangenen Bytes
}

// CommitResult meldet die fertige Datei.
type CommitResult struct {
	Size int64 `json:"size"`
}

// MoveResult meldet das Umbenennen.
type MoveResult struct {
	Rel string `json:"rel"`
}

// SHAOf liefert den SHA-256 als Hex.
func SHAOf(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func regularFile(abs string) (os.FileInfo, error) {
	st, err := os.Lstat(abs)
	if err != nil {
		return nil, fmt.Errorf("Datei nicht lesbar: %w", err)
	}
	if !st.Mode().IsRegular() {
		return nil, fmt.Errorf("%w: keine normale Datei", ErrFileOp)
	}
	return st, nil
}

func opReadChunk(root string, op FileOp) (ChunkResult, error) {
	rel, err := CleanRel(op.Rel, false)
	if err != nil {
		return ChunkResult{}, err
	}
	abs, err := resolveIn(root, rel)
	if err != nil {
		return ChunkResult{}, err
	}
	st, err := regularFile(abs)
	if err != nil {
		return ChunkResult{}, err
	}
	limit := op.Limit
	if limit <= 0 || limit > MaxChunk {
		limit = MaxChunk
	}
	if op.Offset < 0 || op.Offset > st.Size() {
		return ChunkResult{}, fmt.Errorf("%w: Versatz außerhalb der Datei", ErrFileOp)
	}
	f, err := os.Open(abs)
	if err != nil {
		return ChunkResult{}, err
	}
	defer f.Close()
	buf := make([]byte, limit)
	n, err := f.ReadAt(buf, op.Offset)
	if err != nil && err != io.EOF {
		return ChunkResult{}, err
	}
	buf = buf[:n]
	return ChunkResult{Data: buf, Size: st.Size(), EOF: op.Offset+int64(n) >= st.Size(), SHA: SHAOf(buf)}, nil
}

func tempPath(root, rel string) (final, tmp string, err error) {
	rel, err = CleanRel(rel, false)
	if err != nil {
		return "", "", err
	}
	final, err = resolveIn(root, rel)
	if err != nil {
		return "", "", err
	}
	return final, final + TempSuffix, nil
}

func opWriteChunk(root string, op FileOp) (WriteResult, error) {
	if len(op.Data) > MaxChunk {
		return WriteResult{}, fmt.Errorf("%w: Block zu groß", ErrFileOp)
	}
	_, tmp, err := tempPath(root, op.Rel)
	if err != nil {
		return WriteResult{}, err
	}
	if op.Offset == 0 {
		if err := os.MkdirAll(filepath.Dir(tmp), 0o755); err != nil {
			return WriteResult{}, err
		}
	}
	flags := os.O_WRONLY | os.O_CREATE
	if op.Offset == 0 {
		flags |= os.O_TRUNC
	}
	f, err := os.OpenFile(tmp, flags, 0o644)
	if err != nil {
		return WriteResult{}, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return WriteResult{}, err
	}
	if st.Size() != op.Offset {
		return WriteResult{}, fmt.Errorf("%w: Versatz %d passt nicht zur halben Datei (%d Byte)", ErrFileOp, op.Offset, st.Size())
	}
	if _, err := f.WriteAt(op.Data, op.Offset); err != nil {
		return WriteResult{}, err
	}
	return WriteResult{Written: op.Offset + int64(len(op.Data)), SHA: SHAOf(op.Data)}, nil
}

// trashExisting legt eine vorhandene Zieldatei in den Papierkorb (Überschreiben verliert nichts unwiederbringlich).
func trashExisting(root, rel string) error {
	res, err := opTrash(root, FileOp{Rels: []string{rel}})
	if err != nil {
		return err
	}
	if len(res) == 1 && !res[0].OK {
		return fmt.Errorf("vorhandene Datei nicht in den Papierkorb gelegt: %s", res[0].Error)
	}
	return nil
}

func opCommit(root string, op FileOp) (CommitResult, error) {
	final, tmp, err := tempPath(root, op.Rel)
	if err != nil {
		return CommitResult{}, err
	}
	st, err := os.Stat(tmp)
	if err != nil {
		return CommitResult{}, fmt.Errorf("halbe Datei fehlt: %w", err)
	}
	if op.Size >= 0 && st.Size() != op.Size {
		return CommitResult{}, fmt.Errorf("%w: Größe %d, erwartet %d", ErrFileOp, st.Size(), op.Size)
	}
	f, err := os.OpenFile(tmp, os.O_RDWR, 0)
	if err != nil {
		return CommitResult{}, err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return CommitResult{}, err
	}
	f.Close()
	if _, err := os.Lstat(final); err == nil {
		if !op.Overwrite {
			return CommitResult{}, fmt.Errorf("%w: Ziel existiert bereits", ErrFileOp)
		}
		rel, _ := CleanRel(op.Rel, false)
		if err := trashExisting(root, rel); err != nil {
			return CommitResult{}, err
		}
	}
	if op.MTimeMs > 0 {
		t := time.UnixMilli(op.MTimeMs)
		_ = os.Chtimes(tmp, t, t)
	}
	if err := os.Rename(tmp, final); err != nil {
		return CommitResult{}, err
	}
	return CommitResult{Size: st.Size()}, nil
}

func opAbort(root string, op FileOp) (struct{}, error) {
	_, tmp, err := tempPath(root, op.Rel)
	if err != nil {
		return struct{}{}, err
	}
	if err := os.Remove(tmp); err != nil && !os.IsNotExist(err) {
		return struct{}{}, err
	}
	return struct{}{}, nil
}

func opMkdir(root string, op FileOp) (struct{}, error) {
	rel, err := CleanRel(op.Rel, false)
	if err != nil {
		return struct{}{}, err
	}
	abs, err := resolveIn(root, rel)
	if err != nil {
		return struct{}{}, err
	}
	return struct{}{}, os.MkdirAll(abs, 0o755)
}

func opMove(root string, op FileOp) (MoveResult, error) {
	src, err := CleanRel(op.Rel, false)
	if err != nil {
		return MoveResult{}, err
	}
	dst, err := CleanRel(op.DstRel, false)
	if err != nil {
		return MoveResult{}, err
	}
	if src == dst {
		return MoveResult{}, fmt.Errorf("%w: Quelle und Ziel sind gleich", ErrFileOp)
	}
	if len(dst) > len(src) && dst[:len(src)+1] == src+"/" {
		return MoveResult{}, fmt.Errorf("%w: ein Ordner lässt sich nicht in sich selbst verschieben", ErrFileOp)
	}
	sabs, err := resolveIn(root, src)
	if err != nil {
		return MoveResult{}, err
	}
	dabs, err := resolveIn(root, dst)
	if err != nil {
		return MoveResult{}, err
	}
	if _, err := os.Lstat(sabs); err != nil {
		return MoveResult{}, fmt.Errorf("Quelle existiert nicht: %w", err)
	}
	if _, err := os.Lstat(dabs); err == nil {
		if !op.Overwrite {
			return MoveResult{}, fmt.Errorf("%w: Ziel existiert bereits", ErrFileOp)
		}
		if err := trashExisting(root, dst); err != nil {
			return MoveResult{}, err
		}
	}
	if err := os.MkdirAll(filepath.Dir(dabs), 0o755); err != nil {
		return MoveResult{}, err
	}
	if err := os.Rename(sabs, dabs); err != nil {
		return MoveResult{}, fmt.Errorf("Verschieben nicht möglich (liegen beide Pfade auf demselben Dateisystem?): %w", err)
	}
	return MoveResult{Rel: dst}, nil
}

// UniqueRel liefert einen freien Namen neben rel („name (2).ext“), wenn rel schon existiert; exists meldet die Belegung.
func UniqueRel(rel string, exists func(string) bool) string {
	if !exists(rel) {
		return rel
	}
	ext := filepath.Ext(rel)
	base := rel[:len(rel)-len(ext)]
	for i := 2; i < 1000; i++ {
		c := base + " (" + strconv.Itoa(i) + ")" + ext
		if !exists(c) {
			return c
		}
	}
	return rel
}
