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
//
// Seit D15 (ARCHITECTURE.md §19.3, Postgres-HA via Patroni) gibt es
// keinen festen "omp-postgres"-Container mehr, aus dem sich einfach
// `pg_dump` ziehen ließe — welcher der drei Knoten gerade Primary ist
// UND auf welchem lokalen Port dessen Postgres lauscht (die drei
// Dev-Knoten teilen sich einen Host, brauchen also unterschiedliche
// Ports, s. Makefile postgres-up), wechselt bei jedem Failover.
// resolvePrimary fragt deshalb bei JEDEM Create()-Aufruf neu Patronis
// eigene REST-API (`GET {RestURL}/cluster`, liefert Name/Rolle/Host/Port
// aller Mitglieder aus einer einzigen Antwort) — kein statisch
// gepflegter Port pro Knoten nötig, keine zweite Wahrheitsquelle neben
// dem, was Patroni selbst gerade weiß.
package backup

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// PatroniNode verbindet einen podman-Container-Namen mit der
// Patroni-REST-API-Adresse desselben Knotens.
type PatroniNode struct {
	Container string
	RestURL   string
}

// ParsePatroniNodes liest das "container=resturl,container=resturl,..."
// Format aus config.Config.PatroniNodes.
func ParsePatroniNodes(spec string) []PatroniNode {
	var nodes []PatroniNode
	for _, entry := range strings.Split(spec, ",") {
		entry = strings.TrimSpace(entry)
		container, restURL, ok := strings.Cut(entry, "=")
		if !ok || container == "" || restURL == "" {
			continue
		}
		nodes = append(nodes, PatroniNode{Container: container, RestURL: restURL})
	}
	return nodes
}

// patroniClusterMember ist der für uns relevante Ausschnitt eines
// Eintrags in Patronis `GET /cluster`-Antwort — `name` entspricht per
// Konstruktion (PATRONI_NAME beim `podman run`, s. Makefile
// postgres-up) exakt dem podman-Container-Namen.
type patroniClusterMember struct {
	Name string `json:"name"`
	Role string `json:"role"`
	Port int    `json:"port"`
}

type patroniClusterResponse struct {
	Members []patroniClusterMember `json:"members"`
}

// resolvePrimary fragt die Knoten nacheinander über deren Patroni-
// REST-API (`GET {RestURL}/cluster`) nach der vollständigen
// Cluster-Topologie und liefert Container-Name + lokalen Postgres-Port
// des Mitglieds mit role "leader" — reicht bereits eine erreichbare
// REST-API, die anderen beiden Knoten müssen dafür nicht selbst
// erreichbar sein (Patroni synchronisiert die Topologie über die
// gemeinsame DCS, jeder Knoten kennt den ganzen Cluster).
func resolvePrimary(ctx context.Context, nodes []PatroniNode) (container string, port int, err error) {
	client := &http.Client{Timeout: 3 * time.Second}
	var errs []string
	for _, n := range nodes {
		req, reqErr := http.NewRequestWithContext(ctx, http.MethodGet, n.RestURL+"/cluster", nil)
		if reqErr != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", n.Container, reqErr))
			continue
		}
		resp, doErr := client.Do(req)
		if doErr != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", n.Container, doErr))
			continue
		}
		var cluster patroniClusterResponse
		decodeErr := json.NewDecoder(resp.Body).Decode(&cluster)
		_ = resp.Body.Close()
		if decodeErr != nil {
			errs = append(errs, fmt.Sprintf("%s: /cluster decode: %v", n.Container, decodeErr))
			continue
		}
		for _, m := range cluster.Members {
			if m.Role == "leader" {
				return m.Name, m.Port, nil
			}
		}
		errs = append(errs, fmt.Sprintf("%s: /cluster ohne leader-Mitglied", n.Container))
	}
	return "", 0, fmt.Errorf("kein Patroni-Primary gefunden unter %d Knoten: %s", len(nodes), strings.Join(errs, "; "))
}

// Service erstellt und listet Backups des per Patroni verwalteten
// Postgres-Clusters.
type Service struct {
	nodes []PatroniNode
	dir   string
	keep  int
}

// NewService — dir muss existieren oder anlegbar sein (Create legt es
// bei Bedarf an, gleiches Verhalten wie backup-omp.shs `mkdir -p`).
// keep ist die Rotationsgrenze (identisch zu backup-omp.shs
// BACKUP_KEEP=14 — beide Wege teilen sich denselben `.backups/`-Ordner
// und dieselbe Namenskonvention, eine Rotation räumt also unabhängig
// vom Erstellungsweg auf). nodes kommt aus config.Config.PatroniNodes
// (ParsePatroniNodes).
func NewService(nodes []PatroniNode, dir string, keep int) *Service {
	return &Service{nodes: nodes, dir: dir, keep: keep}
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

	container, port, err := resolvePrimary(ctx, s.nodes)
	if err != nil {
		return Result{}, fmt.Errorf("primary-knoten ermitteln: %w", err)
	}

	cmd := exec.CommandContext(ctx, "podman", "exec", container, "pg_dump",
		"-h", "127.0.0.1", "-p", strconv.Itoa(port), "-U", "omp", "--clean", "--if-exists", "omp")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return Result{}, fmt.Errorf("pg_dump im Container %q fehlgeschlagen: %w (%s)", container, err, stderr.String())
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

// Import speichert eine vom Browser hochgeladene Sicherung (Nutzerfund
// 2026-08-27: "backup kann downgeloaded werden, aber nicht per upload
// im Browser wiederhergestellt werden — derzeit nur aus der
// Dropdownbox"). Bewusst symmetrisch zu handleDownloadBackup: dieselben
// Rohbytes, die ein Download liefert (bereits gzip-komprimiertes
// pg_dump-Ergebnis), kommen hier unverändert wieder rein — kein
// erneutes Komprimieren wie in Create(). Der Dateiname wird IMMER
// serverseitig neu vergeben (gleiches Zeitstempel-Schema wie Create()),
// nie der vom Client mitgeschickte Name — ein Client-Dateiname ist
// unvertrauenswürdige Eingabe (Path Traversal, Kollision mit einer
// bestehenden Sicherung); ein selbst generierter Name macht diese Sorge
// für den Upload-Pfad von vornherein hinfällig, statt sie erst bei
// Path() abzufangen. Wendet danach dieselbe Rotation wie Create() an —
// eine hochgeladene Sicherung zählt wie jede andere.
func (s *Service) Import(data []byte) (Result, error) {
	if len(data) == 0 {
		return Result{}, fmt.Errorf("hochgeladene Datei ist leer")
	}
	// Nur der Container-Check (ist es überhaupt gzip?), keine
	// SQL-Inhaltsprüfung — Create() validiert den pg_dump-Inhalt selbst
	// auch nicht vorab, das übernimmt `psql` erst beim tatsächlichen
	// Restore (gleicher Vertrauensstand wie der bestehende Weg).
	if gr, err := gzip.NewReader(bytes.NewReader(data)); err != nil {
		return Result{}, fmt.Errorf("keine gültige gzip-Datei: %w", err)
	} else {
		_ = gr.Close()
	}

	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return Result{}, fmt.Errorf("backup dir anlegen: %w", err)
	}

	name := fmt.Sprintf("omp-%s.sql.gz", time.Now().UTC().Format("20060102T150405Z"))
	finalPath := filepath.Join(s.dir, name)
	tmpPath := finalPath + ".tmp"

	if err := os.WriteFile(tmpPath, data, 0o600); err != nil {
		return Result{}, fmt.Errorf("hochgeladene Sicherung schreiben: %w", err)
	}
	if err := os.Rename(tmpPath, finalPath); err != nil {
		_ = os.Remove(tmpPath)
		return Result{}, fmt.Errorf("backup umbenennen: %w", err)
	}

	if err := s.rotate(); err != nil {
		_ = err // best effort, gleiche Begründung wie in Create()
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
