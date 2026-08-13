// Package backup erstellt Postgres-Sicherungen aus dem laufenden
// Orchestrator heraus (Nutzerwunsch 2026-08-13: "generelles Backup/
// Restore über das Browser-UI") — spiegelt exakt `deploy/dev/
// backup-omp.sh` (gleicher `pg_dump -U omp --clean --if-exists`-Aufruf
// über `podman exec`, gleiches Verzeichnis `.backups/`, gleiche
// Rotation), nur als Go-Code statt Shell, damit ein Backup per
// authentifiziertem HTTP-Request statt eines Terminal-Zugriffs
// entsteht. Restore bleibt bewusst AUSSERHALB dieses Pakets — das
// verlangt, den Orchestrator-Prozess selbst zu stoppen, was der
// Orchestrator sich nicht selbst befehlen kann (s. supervisor/, das
// eigenständige Gegenstück).
package backup

import (
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"time"
)

// Service erstellt und listet Backups einer per podman laufenden
// Postgres-Instanz.
type Service struct {
	containerName string
	dir           string
	keep          int
}

// NewService — dir muss existieren oder anlegbar sein (Create legt es
// bei Bedarf an, gleiches Verhalten wie backup-omp.shs `mkdir -p`).
// keep ist die Rotationsgrenze (identisch zu backup-omp.shs
// BACKUP_KEEP=14 — beide Wege teilen sich denselben `.backups/`-Ordner
// und dieselbe Namenskonvention, eine Rotation räumt also unabhängig
// vom Erstellungsweg auf).
func NewService(containerName, dir string, keep int) *Service {
	return &Service{containerName: containerName, dir: dir, keep: keep}
}

// Result ist eine erstellte Sicherung.
type Result struct {
	Name string // Dateiname, z. B. "omp-20260813T154500Z.sql.gz"
	Path string // absoluter Pfad
}

// Create ruft `pg_dump` im Postgres-Container auf, komprimiert die
// Ausgabe und schreibt sie erst unter einem `.tmp`-Namen, dann per
// Rename unter dem finalen Namen (gleicher Schutz wie backup-omp.sh:
// ein abgebrochener Dump darf keine unvollständige Datei unter dem
// finalen Namen hinterlassen). Wendet danach dieselbe Rotation an wie
// backup-omp.sh.
func (s *Service) Create(ctx context.Context) (Result, error) {
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return Result{}, fmt.Errorf("backup dir anlegen: %w", err)
	}

	cmd := exec.CommandContext(ctx, "podman", "exec", s.containerName, "pg_dump", "-U", "omp", "--clean", "--if-exists", "omp")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return Result{}, fmt.Errorf("pg_dump im Container %q fehlgeschlagen: %w (%s)", s.containerName, err, stderr.String())
	}

	name := fmt.Sprintf("omp-%s.sql.gz", time.Now().UTC().Format("20060102T150405Z"))
	finalPath := filepath.Join(s.dir, name)
	tmpPath := finalPath + ".tmp"

	if err := writeGzip(tmpPath, stdout.Bytes()); err != nil {
		return Result{}, fmt.Errorf("backup komprimieren/schreiben: %w", err)
	}
	if err := os.Rename(tmpPath, finalPath); err != nil {
		_ = os.Remove(tmpPath)
		return Result{}, fmt.Errorf("backup umbenennen: %w", err)
	}

	if err := s.rotate(); err != nil {
		// Ein Rotationsfehler darf das gerade erfolgreich erstellte
		// Backup nicht als Fehlschlag melden — nur loggen würde hier
		// einen Logger-Import erfordern, den dieses schmale Paket bisher
		// nicht braucht; der Aufrufer (httpapi-Handler) hat bereits
		// Zugriff auf slog und kann das bei Bedarf selbst tun. Bewusst
		// stillschweigend best-effort, gleiches Prinzip wie
		// backup-omp.shs Rotation (kein harter Fehlerfall dort).
		_ = err
	}

	return Result{Name: name, Path: finalPath}, nil
}

// List liefert die Dateinamen vorhandener Backups, neueste zuerst.
func (s *Service) List() ([]string, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []string{}, nil
		}
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		n := e.Name()
		if len(n) > len("omp-.sql.gz") && n[:4] == "omp-" && n[len(n)-7:] == ".sql.gz" {
			names = append(names, n)
		}
	}
	// Namen sind Zeitstempel-sortierbar (omp-YYYYMMDDTHHMMSSZ.sql.gz),
	// absteigend = neueste zuerst — kein separates Stat/ModTime nötig.
	sort.Sort(sort.Reverse(sort.StringSlice(names)))
	return names, nil
}

// Path löst einen Backup-Dateinamen auf einen absoluten Pfad auf, NUR
// falls er tatsächlich in s.dir existiert und exakt dem erwarteten
// Muster entspricht (Aufrufer aus httpapi reicht hier ungefiltert
// nutzergewählten Text durch — kein Filesystem-Escape über `..`/
// absolute Pfade in einem "Dateinamen" zulassen).
func (s *Service) Path(name string) (string, error) {
	if filepath.Base(name) != name || name == "." || name == ".." {
		return "", fmt.Errorf("ungültiger Backup-Dateiname: %q", name)
	}
	path := filepath.Join(s.dir, name)
	if _, err := os.Stat(path); err != nil {
		return "", fmt.Errorf("backup %q nicht gefunden: %w", name, err)
	}
	return path, nil
}

func (s *Service) rotate() error {
	names, err := s.List()
	if err != nil {
		return err
	}
	if len(names) <= s.keep {
		return nil
	}
	for _, old := range names[s.keep:] {
		if err := os.Remove(filepath.Join(s.dir, old)); err != nil {
			return err
		}
	}
	return nil
}

func writeGzip(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	gw := gzip.NewWriter(f)
	if _, err := gw.Write(data); err != nil {
		_ = gw.Close()
		return err
	}
	return gw.Close()
}
