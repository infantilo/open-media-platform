// Package materialize beantwortet für den Playout-Automator zwei Fragen (UMSETZUNG.md Kapitel 27 / P8;
// Spec §67–73, §181–185): „Ist das Medium eines Events dort verfügbar, wo der Player es liest?“ (Preflight)
// und „Wenn nicht: es dorthin bringen“ (Materialisierung) — ohne ein zweites Dateitransfer-System neben
// OMP: Quelle ist die Asset-Representation (S3/MinIO-Backend oder Dateipfad), die Ausführung ein Schritt
// der OMP-Prozess-Engine (`materialize`, siehe executor.go).
//
// **E4 (Entscheidung):** Der Asset-Lifecycle (registered … ready … published) beschreibt den INHALT und
// bleibt unangetastet. Die Verfügbarkeit ist ein abgeleiteter Zustand je (Representation × Ziel-Medienverzeichnis):
//
//	READY        Datei liegt lesbar im Medienverzeichnis des Players
//	TRANSFERRING Materialisierung läuft
//	REMOTE_ONLY  nur im Speicher (S3/Pfad) erreichbar, noch nicht lokal — materialisierbar
//	FAILED       letzte Materialisierung fehlgeschlagen
//	MISSING      keine Representation / Quelle nicht lesbar
//
// Materialisiert wird in das Medienverzeichnis auf dem ORCHESTRATOR-Rechner; Ziele auf Remote-Hosts werden
// geprüft (Host-Agent `check-path`), aber nicht beschrieben (der Agent hat keinen Dateitransfer).
package materialize

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/asset"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/objectstore"
)

// Zustände (Spec §70).
const (
	StateReady        = "READY"
	StateTransferring = "TRANSFERRING"
	StateRemoteOnly   = "REMOTE_ONLY"
	StateFailed       = "FAILED"
	StateMissing      = "MISSING"
)

var (
	ErrNoRepresentation = errors.New("materialize: keine passende Representation")
	ErrBadRef           = errors.New("materialize: ungültige Asset-Referenz")
)

// Ref verweist auf ein Medium: Asset (+ Version/Representation) — nie ein roher Dateipfad (Spec §68).
type Ref struct {
	AssetID          string `json:"assetId"`
	VersionID        string `json:"versionId,omitempty"`
	RepresentationID string `json:"representationId,omitempty"`
	// RepresentationType: gewünschter Typ (z. B. "playout"); leer = beste verfügbare.
	RepresentationType string `json:"representationType,omitempty"`
}

// Target ist das Ziel: Medienverzeichnis des Players auf einem Host ("" = Orchestrator-Rechner).
type Target struct {
	HostID   string `json:"hostId,omitempty"`
	MediaDir string `json:"mediaDir"`
}

// Spec ist eine vollständig aufgelöste Materialisierung (Eingabe des Prozess-Schritts).
type Spec struct {
	Ref              Ref    `json:"ref"`
	RepresentationID string `json:"representationId"`
	FileName         string `json:"fileName"`
	Target           Target `json:"target"`
}

// Key identifiziert den Job (gleiche Quelle + gleiches Ziel = derselbe Job).
func (s Spec) Key() string {
	return s.RepresentationID + "|" + s.Target.HostID + "|" + filepath.Join(s.Target.MediaDir, s.FileName)
}

// Assets ist der Lesezugriff auf das Asset-System (*asset.Store).
type Assets interface {
	GetAsset(id string) (asset.Asset, error)
	GetRepresentation(id string) (asset.Representation, error)
	ListRepresentations(assetVersionID string) ([]asset.Representation, error)
}

// ObjectBackends löst Storage-Backends auf (*storagebackends.Store).
type ObjectBackends interface {
	Resolve(ctx context.Context, id string) (*objectstore.Client, error)
}

// HostPaths prüft Pfade auf Remote-Hosts (Launcher → Host-Agent).
type HostPaths interface {
	CheckFileOnHost(hostID, path string) (exists bool, err error)
}

// Resolve wählt Version und Representation einer Referenz und liefert die Spec fürs Ziel.
func Resolve(a Assets, ref Ref, target Target) (Spec, asset.Representation, error) {
	if ref.AssetID == "" && ref.RepresentationID == "" {
		return Spec{}, asset.Representation{}, fmt.Errorf("%w: assetId oder representationId erforderlich", ErrBadRef)
	}
	var rep asset.Representation
	if ref.RepresentationID != "" {
		r, err := a.GetRepresentation(ref.RepresentationID)
		if err != nil {
			return Spec{}, rep, err
		}
		rep = r
	} else {
		ast, err := a.GetAsset(ref.AssetID)
		if err != nil {
			return Spec{}, rep, err
		}
		version := ref.VersionID
		if version == "" {
			version = ast.CurrentVersionID
		}
		if version == "" {
			return Spec{}, rep, fmt.Errorf("%w: Asset „%s“ hat keine aktuelle Version", ErrNoRepresentation, ast.Title)
		}
		reps, err := a.ListRepresentations(version)
		if err != nil {
			return Spec{}, rep, err
		}
		r, ok := PickRepresentation(reps, ref.RepresentationType)
		if !ok {
			return Spec{}, rep, fmt.Errorf("%w: Asset „%s“ Version %s", ErrNoRepresentation, ast.Title, version)
		}
		rep = r
	}
	name := FileNameOf(rep.Storage.URI)
	if name == "" {
		return Spec{}, rep, fmt.Errorf("%w: Representation %s hat keinen Dateinamen in der URI", ErrNoRepresentation, rep.ID)
	}
	return Spec{Ref: ref, RepresentationID: rep.ID, FileName: name, Target: target}, rep, nil
}

// preferred: Reihenfolge der bevorzugten Representation-Typen für Playout.
var preferred = []string{"playout", "original", "mxf", "video", "proxy"}

// PickRepresentation wählt: gewünschter Typ, sonst nach Vorzugsliste, sonst die erste mit URI.
func PickRepresentation(reps []asset.Representation, wantType string) (asset.Representation, bool) {
	usable := make([]asset.Representation, 0, len(reps))
	for _, r := range reps {
		if r.Storage.URI != "" {
			usable = append(usable, r)
		}
	}
	if wantType != "" {
		for _, r := range usable {
			if r.Type == wantType {
				return r, true
			}
		}
		return asset.Representation{}, false
	}
	for _, t := range preferred {
		for _, r := range usable {
			if r.Type == t {
				return r, true
			}
		}
	}
	if len(usable) > 0 {
		return usable[0], true
	}
	return asset.Representation{}, false
}

// FileNameOf liefert den Dateinamen aus einer URI/einem Pfad (ohne Query), "" bei Unsinn.
func FileNameOf(uri string) string {
	u := uri
	if i := strings.IndexAny(u, "?#"); i >= 0 {
		u = u[:i]
	}
	name := path.Base(strings.TrimRight(u, "/"))
	if name == "." || name == "/" || name == "" || strings.ContainsAny(name, "\\\x00") || strings.HasPrefix(name, "..") {
		return ""
	}
	return name
}

// ---- Jobs ----

// Job ist eine laufende/abgeschlossene Materialisierung.
type Job struct {
	Key       string    `json:"key"`
	Spec      Spec      `json:"spec"`
	State     string    `json:"state"` // running | done | failed
	Bytes     int64     `json:"bytes"`
	Total     int64     `json:"total"`
	Error     string    `json:"error,omitempty"`
	StartedAt time.Time `json:"startedAt"`
	EndedAt   time.Time `json:"endedAt,omitempty"`
	// Attempt: Versuchsnummer des Prozess-Schritts, der den Job gestartet hat (0 = direkter Aufruf).
	Attempt int `json:"attempt,omitempty"`
}

// Manager führt Kopier-Jobs aus (höchstens einer je Key) und merkt sich den Durchsatz.
type Manager struct {
	Assets  Assets
	Objects ObjectBackends
	Client  *http.Client
	Now     func() time.Time

	mu         sync.Mutex
	jobs       map[string]*Job
	throughput float64 // Bytes/s (geglättet), 0 = noch unbekannt
}

// NewManager erstellt einen Manager.
func NewManager(a Assets, o ObjectBackends) *Manager {
	return &Manager{Assets: a, Objects: o, Client: &http.Client{Timeout: 0}, jobs: map[string]*Job{}}
}

func (m *Manager) now() time.Time {
	if m.Now != nil {
		return m.Now()
	}
	return time.Now()
}

// DefaultThroughput (Bytes/s), solange noch kein Job gemessen wurde — bewusst vorsichtig (Netzwerk-Share).
const DefaultThroughput = 30 << 20

// Throughput liefert den geglätteten Durchsatz in Bytes/s.
func (m *Manager) Throughput() float64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.throughput <= 0 {
		return DefaultThroughput
	}
	return m.throughput
}

// Estimate schätzt die Dauer für `size` Bytes (Spec §71); unbekannte Größe = 0.
func (m *Manager) Estimate(size int64) time.Duration {
	if size <= 0 {
		return 0
	}
	return time.Duration(float64(size) / m.Throughput() * float64(time.Second))
}

// Get liefert den Job zum Key (Kopie).
func (m *Manager) Get(key string) (Job, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	j, ok := m.jobs[key]
	if !ok {
		return Job{}, false
	}
	return *j, true
}

// Ensure startet den Job, falls nicht schon einer läuft/erfolgreich war, und liefert seinen Stand.
// Ein fehlgeschlagener Job wird neu gestartet (ausdrückliche Wiederholung durch den Aufrufer).
func (m *Manager) Ensure(spec Spec) Job { return m.EnsureAttempt(spec, 0) }

// EnsureAttempt wie Ensure, aber für den Prozess-Schritt: ein fehlgeschlagener Job derselben oder einer
// neueren Versuchsnummer wird NICHT neu gestartet (der Fehler wird gemeldet; erst ein Retry der Engine mit
// höherer Versuchsnummer startet ihn neu).
func (m *Manager) EnsureAttempt(spec Spec, attempt int) Job {
	key := spec.Key()
	m.mu.Lock()
	if j, ok := m.jobs[key]; ok && (j.State == "running" || j.State == "done" || (attempt > 0 && j.State == "failed" && j.Attempt >= attempt)) {
		cp := *j
		m.mu.Unlock()
		return cp
	}
	j := &Job{Key: key, Spec: spec, State: "running", StartedAt: m.now(), Attempt: attempt}
	m.jobs[key] = j
	cp := *j
	m.mu.Unlock()
	go m.run(j)
	return cp
}

func (m *Manager) finish(j *Job, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	j.EndedAt = m.now()
	if err != nil {
		j.State, j.Error = "failed", err.Error()
		return
	}
	j.State = "done"
	if secs := j.EndedAt.Sub(j.StartedAt).Seconds(); secs > 0.2 && j.Bytes > 1<<20 {
		rate := float64(j.Bytes) / secs
		if m.throughput <= 0 {
			m.throughput = rate
		} else {
			m.throughput = 0.7*m.throughput + 0.3*rate // geglättet
		}
	}
}

type countingWriter struct {
	m *Manager
	j *Job
	w io.Writer
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.m.mu.Lock()
	c.j.Bytes += int64(n)
	c.m.mu.Unlock()
	return n, err
}

func (m *Manager) run(j *Job) {
	m.finish(j, m.copy(context.Background(), j))
}

// copy: Quelle öffnen, nach <ziel>.part schreiben, Größe/Prüfsumme prüfen, atomar umbenennen.
func (m *Manager) copy(ctx context.Context, j *Job) error {
	spec := j.Spec
	if spec.Target.HostID != "" {
		return errors.New("Materialisierung auf Remote-Hosts wird nicht unterstützt (der Host-Agent hat keinen Dateitransfer) — Medium auf dem Host bereitstellen oder ein lokales Ziel verwenden")
	}
	if spec.Target.MediaDir == "" {
		return errors.New("kein Ziel-Medienverzeichnis")
	}
	rep, err := m.Assets.GetRepresentation(spec.RepresentationID)
	if err != nil {
		return fmt.Errorf("Representation: %w", err)
	}
	dst := filepath.Join(spec.Target.MediaDir, spec.FileName)
	if filepath.Dir(dst) != filepath.Clean(spec.Target.MediaDir) {
		return errors.New("Dateiname verlässt das Medienverzeichnis")
	}
	// Schon vorhanden und passend: nichts zu tun (Idempotenz nach Neustart).
	if st, err := os.Stat(dst); err == nil && st.Mode().IsRegular() && (rep.SizeBytes == nil || st.Size() == *rep.SizeBytes) {
		j.Total, j.Bytes = st.Size(), st.Size()
		return nil
	}
	src, total, err := m.open(ctx, rep)
	if err != nil {
		return err
	}
	defer src.Close()
	m.mu.Lock()
	j.Total = total
	m.mu.Unlock()
	if err := os.MkdirAll(spec.Target.MediaDir, 0o755); err != nil {
		return fmt.Errorf("Zielverzeichnis: %w", err)
	}
	tmp := dst + ".part"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("Zieldatei: %w", err)
	}
	h := sha256.New()
	_, cerr := io.Copy(io.MultiWriter(&countingWriter{m: m, j: j, w: f}, h), src)
	if serr := f.Close(); cerr == nil {
		cerr = serr
	}
	if cerr != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("Kopieren: %w", cerr)
	}
	if rep.SizeBytes != nil && j.Bytes != *rep.SizeBytes {
		_ = os.Remove(tmp)
		return fmt.Errorf("Größe stimmt nicht (%d statt %d Bytes)", j.Bytes, *rep.SizeBytes)
	}
	if want := strings.ToLower(strings.TrimPrefix(rep.Checksum, "sha256:")); len(want) == 64 && want != hex.EncodeToString(h.Sum(nil)) {
		_ = os.Remove(tmp)
		return errors.New("Prüfsumme (SHA-256) stimmt nicht")
	}
	return os.Rename(tmp, dst)
}

// open öffnet die Quelle: S3/MinIO über das Backend (Presigned GET) oder ein lokaler Dateipfad.
func (m *Manager) open(ctx context.Context, rep asset.Representation) (io.ReadCloser, int64, error) {
	if rep.StorageBackendID != "" {
		if m.Objects == nil {
			return nil, 0, errors.New("kein Storage-Backend-Dienst verfügbar")
		}
		client, err := m.Objects.Resolve(ctx, rep.StorageBackendID)
		if err != nil {
			return nil, 0, fmt.Errorf("Storage-Backend: %w", err)
		}
		key, err := objectstore.KeyFromURI(client.Bucket(), rep.Storage.URI)
		if err != nil {
			return nil, 0, err
		}
		u, err := client.PresignedDownloadURL(ctx, key)
		if err != nil {
			return nil, 0, fmt.Errorf("Download-URL: %w", err)
		}
		return m.httpGet(ctx, u.String())
	}
	uri := rep.Storage.URI
	switch {
	case strings.HasPrefix(uri, "http://") || strings.HasPrefix(uri, "https://"):
		return m.httpGet(ctx, uri)
	case strings.HasPrefix(uri, "file://"):
		uri = strings.TrimPrefix(uri, "file://")
	}
	if !filepath.IsAbs(uri) {
		return nil, 0, fmt.Errorf("Quelle %q ist kein absoluter Pfad/keine URL", uri)
	}
	f, err := os.Open(uri)
	if err != nil {
		return nil, 0, fmt.Errorf("Quelle: %w", err)
	}
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		_ = f.Close()
		return nil, 0, errors.New("Quelle ist keine Datei")
	}
	return f, st.Size(), nil
}

func (m *Manager) httpGet(ctx context.Context, url string) (io.ReadCloser, int64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, 0, err
	}
	resp, err := m.Client.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("Download: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		_ = resp.Body.Close()
		return nil, 0, fmt.Errorf("Download: HTTP %d", resp.StatusCode)
	}
	return resp.Body, resp.ContentLength, nil
}

// ---- Verfügbarkeit ----

// Result ist das Preflight-Ergebnis für EINE Referenz.
type Result struct {
	State            string `json:"state"`
	Detail           string `json:"detail,omitempty"`
	RepresentationID string `json:"representationId,omitempty"`
	FileName         string `json:"fileName,omitempty"`
	SizeBytes        int64  `json:"sizeBytes,omitempty"`
	// EstimateSeconds: geschätzte Dauer der Materialisierung (nur REMOTE_ONLY/TRANSFERRING).
	EstimateSeconds float64 `json:"estimateSeconds,omitempty"`
	// Progress: 0..1 bei TRANSFERRING.
	Progress float64 `json:"progress,omitempty"`
	// Materializable: lässt sich von hier aus lokal bereitstellen.
	Materializable bool `json:"materializable"`
}

// Check ermittelt die Verfügbarkeit einer Referenz am Ziel (Spec §67). hosts darf nil sein.
func (m *Manager) Check(ref Ref, target Target, hosts HostPaths) Result {
	spec, rep, err := Resolve(m.Assets, ref, target)
	if err != nil {
		return Result{State: StateMissing, Detail: err.Error()}
	}
	res := Result{RepresentationID: spec.RepresentationID, FileName: spec.FileName}
	if rep.SizeBytes != nil {
		res.SizeBytes = *rep.SizeBytes
	}
	if job, ok := m.Get(spec.Key()); ok && job.State == "running" {
		res.State, res.Materializable = StateTransferring, true
		if job.Total > 0 {
			res.Progress = float64(job.Bytes) / float64(job.Total)
			res.EstimateSeconds = float64(job.Total-job.Bytes) / m.Throughput()
		}
		return res
	}
	// Lokal vorhanden?
	local := filepath.Join(target.MediaDir, spec.FileName)
	if target.HostID == "" {
		if st, err := os.Stat(local); err == nil && st.Mode().IsRegular() && (rep.SizeBytes == nil || st.Size() == *rep.SizeBytes) {
			res.State = StateReady
			return res
		}
	} else if hosts != nil {
		if ok, err := hosts.CheckFileOnHost(target.HostID, local); err == nil && ok {
			res.State = StateReady
			return res
		}
	}
	if job, ok := m.Get(spec.Key()); ok && job.State == "failed" && m.now().Sub(job.EndedAt) < 10*time.Minute {
		res.State, res.Detail, res.Materializable = StateFailed, job.Error, target.HostID == ""
		return res
	}
	// Nur im Speicher: Quelle erreichbar?
	if err := m.sourceReachable(rep); err != nil {
		res.State, res.Detail = StateMissing, "Quelle nicht erreichbar: "+err.Error()
		return res
	}
	res.State = StateRemoteOnly
	res.Materializable = target.HostID == ""
	res.EstimateSeconds = m.Estimate(res.SizeBytes).Seconds()
	if target.HostID != "" {
		res.Detail = "liegt nicht im Medienverzeichnis des Remote-Hosts; Materialisierung auf Remote-Hosts wird nicht unterstützt"
	}
	return res
}

func (m *Manager) sourceReachable(rep asset.Representation) error {
	if rep.StorageBackendID != "" {
		if m.Objects == nil {
			return errors.New("kein Storage-Backend-Dienst")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, err := m.Objects.Resolve(ctx, rep.StorageBackendID)
		return err
	}
	uri := rep.Storage.URI
	if strings.HasPrefix(uri, "http://") || strings.HasPrefix(uri, "https://") {
		return nil // nicht vorab geprüft (kein Schreib-/Lesezugriff nur zum Testen)
	}
	uri = strings.TrimPrefix(uri, "file://")
	st, err := os.Stat(uri)
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() {
		return errors.New("keine Datei")
	}
	return nil
}
