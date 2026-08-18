// omp-supervisor — der einzige Prozess, der den Orchestrator selbst
// stoppen/starten darf (Nutzerwunsch 2026-08-13: "generelles Backup/
// Restore über das Browser-UI", Nutzerentscheidung: "kleiner
// Supervisor-Prozess davor" statt "Restore bleibt CLI"). Grund: ein
// Postgres-Restore verlangt einen gestoppten Orchestrator (der Dump
// enthält DROP-Anweisungen, ein noch laufender Prozess liefe mitten im
// Restore gegen bereits gelöschte Tabellen — s. deploy/dev/
// restore-omp.shs Kopfkommentar) — der Orchestrator kann sich diesen
// Boden aber nicht selbst unter den Füßen wegziehen, während er gerade
// den HTTP-Request beantwortet, der genau das auslösen soll. Der
// Supervisor überlebt deshalb bewusst UNABHÄNGIG vom Orchestrator-
// Lebenszyklus (eigenes PID-File .run/supervisor.pid, eigene Start-/
// Stop-Skripte, nicht Teil von start-omp.sh/stop-omp.sh).
//
// Führt keine eigene Restore-/Stop-/Start-Logik neu ein — ruft
// stattdessen die bereits vorhandenen, einzeln verifizierten Skripte
// deploy/dev/{stop,start}-omp.sh als Subprozesse auf (PID-Datei-
// Handling, Port-Checks, UI-Bundle-Bau, healthz-Warten — all das
// bereits vorhanden und getestet, ein Neuschreiben in Go wäre reines
// Duplikations-/Regressionsrisiko ohne Nutzen). Der eigentliche
// Restore-Befehl selbst spiegelt restore-omp.shs `gunzip -c | podman
// exec -i <primary> psql ...` exakt — seit D15 (ARCHITECTURE.md §19.3,
// Postgres-HA via Patroni) wird der Ziel-Container/-Port bei jedem Lauf
// neu über Patronis REST-API ermittelt (s. resolvePrimary unten), kein
// fester "omp-postgres"-Name mehr.
//
// Vertrauensgrenze: lauscht NUR auf 127.0.0.1 (nie 0.0.0.0) — jeder
// Prozess, der diesen Port lokal erreicht, kann einen Restore auslösen.
// Auf dieser Dev-Maschine (CLAUDE.md: "normaler Linux-Rechner", ein
// Nutzer) verleiht das keinem Angreifer neue Fähigkeiten, die er nicht
// ohnehin schon hätte (direkter `podman exec`-Zugriff wäre genauso
// verheerend) — kein zusätzliches Shared-Secret in dieser Fassung,
// bewusste Entscheidung, kein Versehen. Sollte der Supervisor je über
// Loopback hinaus erreichbar werden müssen, braucht das zuerst ein
// eigenes Auth-Konzept, nicht nur eine nachträgliche Kopfzeile.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

func envOr(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}

// statusData ist der reine Datenanteil von status — als eigener Typ
// gehalten, damit snapshot() eine Kopie zurückgeben kann, OHNE dabei
// (per `go vet`s "copies lock value"-Warnung zu Recht beanstandet) den
// sync.Mutex mitzukopieren.
type statusData struct {
	Busy    bool      `json:"busy"`
	File    string    `json:"file,omitempty"`
	Phase   string    `json:"phase,omitempty"` // "stopping"/"restoring"/"starting"/""
	Started time.Time `json:"startedAt,omitempty"`
	Ended   time.Time `json:"endedAt,omitempty"`
	Ok      *bool     `json:"ok,omitempty"`
	Error   string    `json:"error,omitempty"`
}

// status ist der Zustand des letzten (oder laufenden) Restores — per
// GET /status abrufbar, rein informativ (kein Verhalten hängt daran).
type status struct {
	mu   sync.Mutex
	data statusData
}

func (s *status) snapshot() statusData {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data
}

func (s *status) begin(file string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.Busy {
		return false
	}
	s.data = statusData{Busy: true, File: file, Phase: "stopping", Started: time.Now().UTC()}
	return true
}

func (s *status) setPhase(phase string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.Phase = phase
}

func (s *status) finish(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ok := err == nil
	s.data.Busy = false
	s.data.Phase = ""
	s.data.Ended = time.Now().UTC()
	s.data.Ok = &ok
	if err != nil {
		s.data.Error = err.Error()
	} else {
		s.data.Error = ""
	}
}

type server struct {
	backupDir   string
	stopScript  string
	startScript string
	status      *status
}

func (s *server) routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /status", s.handleStatus)
	mux.HandleFunc("POST /restore", s.handleRestore)
	return mux
}

func (s *server) handleStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.status.snapshot())
}

type restoreRequest struct {
	File string `json:"file"`
}

// handleRestore nimmt den Auftrag entgegen, antwortet SOFORT (bevor der
// Orchestrator gestoppt wird) und führt den eigentlichen Stop→Restore→
// Start-Ablauf in einer Hintergrund-Goroutine aus — der Aufrufer
// (orchestrator/internal/httpapi) ruft diesen Endpunkt synchron auf,
// bekommt aber eine schnelle Antwort, WEIT bevor stop-omp.sh den
// Orchestrator-Prozess tatsächlich beendet (s. sleepBeforeStop unten).
// Ohne diese Verzögerung könnte die eigentliche HTTP-Antwort des
// Orchestrators an den Browser mit dem Prozess selbst wegsterben, bevor
// sie den Client erreicht.
const sleepBeforeStop = 400 * time.Millisecond

func (s *server) handleRestore(w http.ResponseWriter, r *http.Request) {
	var req restoreRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	backupPath, err := resolveBackupPath(s.backupDir, req.File)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if !s.status.begin(req.File) {
		http.Error(w, "ein Restore läuft bereits", http.StatusConflict)
		return
	}

	writeJSON(w, http.StatusAccepted, map[string]string{"status": "restore eingeleitet"})
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}

	go s.runRestore(backupPath)
}

func (s *server) runRestore(backupPath string) {
	err := s.doRestore(backupPath)
	s.status.finish(err)
	if err != nil {
		slog.Error("supervisor: restore failed", "backup", backupPath, "error", err)
	} else {
		slog.Info("supervisor: restore succeeded", "backup", backupPath)
	}
}

func (s *server) doRestore(backupPath string) error {
	time.Sleep(sleepBeforeStop)

	slog.Info("supervisor: stopping orchestrator", "script", s.stopScript)
	if out, err := exec.Command(s.stopScript).CombinedOutput(); err != nil {
		return fmt.Errorf("stop-omp.sh: %w (%s)", err, string(out))
	}

	s.status.setPhase("restoring")
	slog.Info("supervisor: restoring postgres", "backup", backupPath)
	if err := restorePostgres(backupPath); err != nil {
		// Bewusst NICHT versuchen, den Orchestrator trotzdem wieder zu
		// starten — ein fehlgeschlagener Restore kann die Datenbank in
		// einem unbekannten Zwischenzustand (teilweise angewendete
		// Anweisungen vor dem Fehler, `-v ON_ERROR_STOP=1` bricht ab,
		// räumt aber nichts vorher Angewendetes zurück) hinterlassen —
		// ein Orchestrator-Start dagegen würde diesen Zustand sofort
		// aktiv beschreiben (Migrationen, Health-Writes). Der Fehler
		// bleibt über GET /status sichtbar, der Bediener startet nach
		// Prüfung/eigenem Eingriff manuell neu (`make start`).
		return fmt.Errorf("restore: %w — Orchestrator bewusst NICHT automatisch neu gestartet, Datenbankzustand erst prüfen", err)
	}

	s.status.setPhase("starting")
	slog.Info("supervisor: starting orchestrator", "script", s.startScript)
	if out, err := exec.Command(s.startScript).CombinedOutput(); err != nil {
		return fmt.Errorf("start-omp.sh: %w (%s)", err, string(out))
	}
	return nil
}

// patroniNode/parsePatroniNodes/resolvePrimary spiegeln
// orchestrator/internal/backup.{PatroniNode,ParsePatroniNodes,
// resolvePrimary} bewusst wortgleich (Duplikation statt Import — ein
// eigenständiges Go-Modul, gleiches Muster wie die defaultNatsURL-
// Duplikation zwischen orchestrator/host-agent, D14) — Postgres-HA via
// Patroni (ARCHITECTURE.md §19.3, UMSETZUNG.md D15) hat keinen festen
// "omp-postgres"-Container mehr, welcher der drei Knoten gerade Primary
// ist wechselt bei jedem Failover.
type patroniNode struct {
	container string
	restURL   string
}

func parsePatroniNodes(spec string) []patroniNode {
	var nodes []patroniNode
	for _, entry := range strings.Split(spec, ",") {
		entry = strings.TrimSpace(entry)
		container, restURL, ok := strings.Cut(entry, "=")
		if !ok || container == "" || restURL == "" {
			continue
		}
		nodes = append(nodes, patroniNode{container: container, restURL: restURL})
	}
	return nodes
}

type patroniClusterMember struct {
	Name string `json:"name"`
	Role string `json:"role"`
	Port int    `json:"port"`
}

type patroniClusterResponse struct {
	Members []patroniClusterMember `json:"members"`
}

func resolvePrimary(ctx context.Context, nodes []patroniNode) (container string, port int, err error) {
	client := &http.Client{Timeout: 3 * time.Second}
	var errs []string
	for _, n := range nodes {
		req, reqErr := http.NewRequestWithContext(ctx, http.MethodGet, n.restURL+"/cluster", nil)
		if reqErr != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", n.container, reqErr))
			continue
		}
		resp, doErr := client.Do(req)
		if doErr != nil {
			errs = append(errs, fmt.Sprintf("%s: %v", n.container, doErr))
			continue
		}
		var cluster patroniClusterResponse
		decodeErr := json.NewDecoder(resp.Body).Decode(&cluster)
		_ = resp.Body.Close()
		if decodeErr != nil {
			errs = append(errs, fmt.Sprintf("%s: /cluster decode: %v", n.container, decodeErr))
			continue
		}
		for _, m := range cluster.Members {
			if m.Role == "leader" {
				return m.Name, m.Port, nil
			}
		}
		errs = append(errs, fmt.Sprintf("%s: /cluster ohne leader-Mitglied", n.container))
	}
	return "", 0, fmt.Errorf("kein Patroni-Primary gefunden unter %d Knoten: %s", len(nodes), strings.Join(errs, "; "))
}

// restorePostgres spiegelt restore-omp.shs `gunzip -c "$BACKUP_FILE" |
// podman exec -i <primary> psql -U omp -v ON_ERROR_STOP=1 -q omp` exakt,
// nur als Go-Prozesskette statt einer Shell-Pipe — Container+Port des
// Ziels werden seit D15 bei jedem Restore neu über Patronis REST-API
// ermittelt statt fest "omp-postgres" anzunehmen.
func restorePostgres(backupPath string) error {
	nodes := parsePatroniNodes(envOr("OMP_POSTGRES_PATRONI_NODES",
		"omp-patroni-1=http://127.0.0.1:8008,omp-patroni-2=http://127.0.0.1:8018,omp-patroni-3=http://127.0.0.1:8028"))
	container, port, err := resolvePrimary(context.Background(), nodes)
	if err != nil {
		return fmt.Errorf("primary-knoten ermitteln: %w", err)
	}

	f, err := os.Open(backupPath)
	if err != nil {
		return fmt.Errorf("backup-datei öffnen: %w", err)
	}
	defer f.Close()

	gunzip := exec.Command("gunzip", "-c")
	gunzip.Stdin = f
	gunzipOut, err := gunzip.StdoutPipe()
	if err != nil {
		return fmt.Errorf("gunzip pipe: %w", err)
	}

	psql := exec.Command("podman", "exec", "-i", container, "psql",
		"-h", "127.0.0.1", "-p", strconv.Itoa(port), "-U", "omp", "-v", "ON_ERROR_STOP=1", "-q", "omp")
	psql.Stdin = gunzipOut
	var psqlErr bytes.Buffer
	psql.Stderr = &psqlErr

	if err := gunzip.Start(); err != nil {
		return fmt.Errorf("gunzip starten: %w", err)
	}
	if err := psql.Start(); err != nil {
		return fmt.Errorf("psql starten: %w", err)
	}
	gunzipErr := gunzip.Wait()
	psqlWaitErr := psql.Wait()
	if gunzipErr != nil {
		return fmt.Errorf("gunzip: %w", gunzipErr)
	}
	if psqlWaitErr != nil {
		return fmt.Errorf("psql: %w (%s)", psqlWaitErr, psqlErr.String())
	}
	return nil
}

// resolveBackupPath — identischer Schutz wie backup.Service.Path
// (bewusste kleine Dopplung statt eines Imports über die
// Modulgrenze hinweg, gleiches Muster wie andernorts im Projekt):
// `file` kommt letztlich vom Browser über den Orchestrator durch,
// darf also niemals als Dateisystem-Escape (`../`, absoluter Pfad)
// missbraucht werden können.
func resolveBackupPath(backupDir, file string) (string, error) {
	if file == "" || filepath.Base(file) != file || file == "." || file == ".." {
		return "", fmt.Errorf("ungültiger Backup-Dateiname: %q", file)
	}
	path := filepath.Join(backupDir, file)
	if _, err := os.Stat(path); err != nil {
		return "", fmt.Errorf("backup %q nicht gefunden: %w", file, err)
	}
	return path, nil
}

func writeJSON(w http.ResponseWriter, statusCode int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_ = json.NewEncoder(w).Encode(v)
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	rootDir := envOr("OMP_ROOT_DIR", ".")
	listen := envOr("OMP_SUPERVISOR_LISTEN", "127.0.0.1:8091")

	srv := &server{
		backupDir:   envOr("OMP_BACKUP_DIR", filepath.Join(rootDir, ".backups")),
		stopScript:  filepath.Join(rootDir, "deploy", "dev", "stop-omp.sh"),
		startScript: filepath.Join(rootDir, "deploy", "dev", "start-omp.sh"),
		status:      &status{},
	}

	for _, script := range []string{srv.stopScript, srv.startScript} {
		if _, err := os.Stat(script); err != nil {
			slog.Error("supervisor: required script not found", "path", script, "error", err)
			os.Exit(1)
		}
	}

	slog.Info("supervisor: listening", "addr", listen, "root_dir", rootDir, "backup_dir", srv.backupDir)
	httpSrv := &http.Server{Addr: listen, Handler: srv.routes()}
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("supervisor: listen failed", "error", err)
		os.Exit(1)
	}
}
