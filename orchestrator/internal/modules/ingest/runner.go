package ingest

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/asset"
)

// Ablauf eines Auftrags (Kapitel 42). Jeder Schritt ist **idempotent** und liest den Zustand aus der Datenbank: nach einem Neustart des
// Orchestrators setzt der Ablauf genau dort fort (laufende Aufnahmen werden übernommen, nicht neu gestartet).
//
//	scheduled ─(Vorwärmzeit)→ starting ─(Start erreicht, Quelle verbunden)→ recording ─(Ende)→ finalizing → [processing] → completed
//	                           └→ waiting (Quelle/Host noch nicht bereit; Verspätungsrichtlinie)        └→ failed (Datei bleibt erhalten)
//
// Hybrid-Modell: Rekorder-Instanzen werden **je Auftrag** gestartet — aber `leadTime` vor dem Start (vorgewärmt, verbunden) und nach
// der Finalisierung wieder beendet. Reservierungen halten die Kapazität über das ganze Fenster; Fehler an einer Stufe geben alles
// bereits Erworbene wieder frei (Teardown + Reservierungsfreigabe in Mutate bei Terminalzustand).

// Kennzahlen (seit Prozessstart).
type Metrics struct {
	Started        atomic.Int64
	Completed      atomic.Int64
	Failed         atomic.Int64
	Retries        atomic.Int64
	DeviationSumMs atomic.Int64
	DeviationMaxMs atomic.Int64
	LateStarts     atomic.Int64 // Abweichung über dem Zielwert
	OrphansReaped  atomic.Int64
	AdmitRejected  atomic.Int64
	TickNanosMax   atomic.Int64
}

var metrics Metrics

// Step: ein Durchlauf über alle laufenden/anstehenden Aufträge, **synchron** (Tests, Einzelschritt).
func (s *Service) Step(ctx context.Context) {
	jobs, err := s.St.ListJobs(ctx, JobFilter{States: []string{StScheduled, StWaiting, StStarting, StRecording, StFinalizing, StProcessing, StBlocked}, Limit: 500})
	if err != nil {
		s.log().Warn("Aufträge nicht lesbar", "error", err)
		return
	}
	for _, j := range jobs {
		s.advance(ctx, j.ID)
	}
}

// Tick: wie Step, aber je Auftrag nebenläufig (ein langsamer Rekorderstart blockiert die anderen nicht).
func (s *Service) Tick(ctx context.Context) {
	start := time.Now()
	jobs, err := s.St.ListJobs(ctx, JobFilter{States: []string{StScheduled, StWaiting, StStarting, StRecording, StFinalizing, StProcessing, StBlocked}, Limit: 500})
	if err != nil {
		s.log().Warn("Aufträge nicht lesbar", "error", err)
		return
	}
	for _, j := range jobs {
		s.mu.Lock()
		if s.inflight == nil {
			s.inflight = map[string]bool{}
		}
		busy := s.inflight[j.ID]
		if !busy {
			s.inflight[j.ID] = true
		}
		s.mu.Unlock()
		if busy {
			continue
		}
		go func(id string) {
			defer func() {
				s.mu.Lock()
				delete(s.inflight, id)
				s.mu.Unlock()
			}()
			s.advance(ctx, id)
		}(j.ID)
	}
	if d := time.Since(start).Nanoseconds(); d > metrics.TickNanosMax.Load() {
		metrics.TickNanosMax.Store(d)
	}
}

func (s *Service) advance(ctx context.Context, id string) {
	j, err := s.St.GetJob(ctx, id)
	if err != nil {
		return
	}
	now := s.now()
	lead := time.Duration(s.Cfg().LeadTimeS) * time.Second
	switch j.State {
	case StBlocked:
		if !j.PlannedEnd.After(now) {
			s.fail(ctx, j, "schedule", "Aufnahmefenster verstrichen, ohne dass der Auftrag zugelassen wurde")
		}
	case StScheduled:
		if !j.PlannedEnd.After(now) {
			s.fail(ctx, j, "schedule", "Aufnahmefenster verpasst (Orchestrator war nicht aktiv oder Auftrag nicht gestartet)")
			return
		}
		if now.Before(j.PlannedStart.Add(-lead)) {
			return
		}
		j, err = s.St.Mutate(ctx, id, -1, "Vorbereitung beginnt", func(x *Job) (map[string]any, error) {
			if x.State != StScheduled {
				return nil, errNoop
			}
			x.State = StStarting
			x.Attempt++
			p := s.Cfg().Profiles[x.ProfileID]
			x.FileRel = s.fileRel(*x, x.Attempt, p.Ext)
			x.FilePath = filepath.Join(s.Cfg().MediaDir, filepath.FromSlash(x.FileRel))
			x.Error = ""
			return map[string]any{"file": x.FileRel, "host": x.HostID}, nil
		})
		if err != nil {
			return
		}
		s.prepareAndMaybeStart(ctx, j)
	case StStarting, StWaiting:
		s.prepareAndMaybeStart(ctx, j)
	case StRecording:
		s.watchRecording(ctx, j)
	case StFinalizing:
		s.finalize(ctx, j)
	case StProcessing:
		s.process(ctx, j)
	}
}

func hostRuntimeID(id string) string {
	if id == "local" {
		return ""
	}
	return id
}

func (s *Service) label(j Job) string { return "ingest-" + j.ID[:min(8, len(j.ID))] }

// prepareAndMaybeStart: Rekorder bereitstellen, Quelle prüfen/verbinden, zum Startzeitpunkt aufnehmen.
func (s *Service) prepareAndMaybeStart(ctx context.Context, j Job) {
	now := s.now()
	cfg := s.Cfg()
	if j.InstanceID == "" {
		sess, err := s.Runtime.Prepare(ctx, j.ID, hostRuntimeID(j.HostID), s.label(j), cfg.MediaDir, 1+len(j.Audio.inputs()))
		if err != nil {
			s.prepareFailed(ctx, j, "Rekorder nicht startbar: "+err.Error())
			return
		}
		var e error
		if j, e = s.St.Mutate(ctx, j.ID, -1, "Rekorder bereit", func(x *Job) (map[string]any, error) {
			x.InstanceID = sess.InstanceID
			return map[string]any{"instance": sess.InstanceID}, nil
		}); e != nil {
			return
		}
	} else if _, ok := s.Runtime.Adopt(ctx, j.InstanceID); !ok {
		// Instanz weg (Absturz/Neustart): neu bereitstellen
		_, _ = s.St.Mutate(ctx, j.ID, -1, "Rekorder-Instanz nicht mehr vorhanden — wird neu gestartet", func(x *Job) (map[string]any, error) {
			x.InstanceID = ""
			return nil, nil
		})
		return
	}
	sess := Session{InstanceID: j.InstanceID, HostID: j.HostID}
	if err := s.Runtime.ResolveSource(ctx, j.Source); err != nil {
		s.sourceMissing(ctx, j, err)
		return
	}
	for _, extra := range j.Audio.inputs() {
		if err := s.Runtime.ResolveSource(ctx, extra); err != nil {
			s.sourceMissing(ctx, j, fmt.Errorf("weitere Quelle %s: %w", extra.Label, err))
			return
		}
	}
	if err := s.Runtime.Connect(ctx, sess, j.Source, j.Audio); err != nil {
		s.sourceMissing(ctx, j, err)
		return
	}
	if j.State == StWaiting {
		var e error
		if j, e = s.St.Mutate(ctx, j.ID, -1, "Quelle verfügbar", func(x *Job) (map[string]any, error) {
			x.State = StStarting
			x.Error = ""
			return nil, nil
		}); e != nil {
			return
		}
	}
	if now.Before(j.PlannedStart) {
		return // vorgewärmt und verbunden, wartet auf die Startzeit
	}
	if !now.Before(j.PlannedEnd) {
		s.fail(ctx, j, "start", "Aufnahmefenster verstrichen, bevor die Aufnahme beginnen konnte")
		return
	}
	p := cfg.Profiles[j.ProfileID]
	if err := s.Runtime.StartRecording(ctx, sess, j.FileRel, p.McaPlan, j.Audio); err != nil {
		s.recordingFailed(ctx, j, "Aufnahme nicht startbar: "+err.Error())
		return
	}
	dev := now.Sub(j.PlannedStart).Milliseconds()
	_, err := s.St.Mutate(ctx, j.ID, -1, "Aufnahme läuft", func(x *Job) (map[string]any, error) {
		if x.State != StStarting {
			return nil, errNoop
		}
		x.State = StRecording
		t := now
		if x.ActualStart == nil {
			x.ActualStart = &t
			x.DeviationMs = &dev
		}
		x.Error = ""
		return map[string]any{"startDeviationMs": dev, "file": x.FileRel}, nil
	})
	if err == nil {
		_ = s.St.ActivateReservations(ctx, j.ID)
		metrics.Started.Add(1)
		if dev > 0 {
			metrics.DeviationSumMs.Add(dev)
		}
		if dev > metrics.DeviationMaxMs.Load() {
			metrics.DeviationMaxMs.Store(dev)
		}
		if dev > int64(cfg.MaxStartDeviationS)*1000 {
			metrics.LateStarts.Add(1)
		}
	}
}

// sourceMissing: Verspätungsrichtlinie (fail | delay | wait), sichtbar im Auftrag.
func (s *Service) sourceMissing(ctx context.Context, j Job, cause error) {
	now := s.now()
	if now.Before(j.PlannedStart) {
		// noch vor dem Start: nur vermerken, kein Fehler (Vorwärmphase)
		return
	}
	late := j.Late
	if late.Mode == "" {
		late = s.Cfg().DefaultLate
	}
	switch {
	case !now.Before(j.PlannedEnd):
		s.fail(ctx, j, "source", "Quelle war im ganzen Aufnahmefenster nicht verfügbar: "+cause.Error())
	case late.Mode == "fail":
		s.fail(ctx, j, "source", "Quelle zum Start nicht verfügbar (Richtlinie: fehlschlagen): "+cause.Error())
	case late.Mode == "delay" && late.MaxDelayS > 0 && now.After(j.PlannedStart.Add(time.Duration(late.MaxDelayS)*time.Second)):
		s.fail(ctx, j, "source", fmt.Sprintf("Quelle auch nach %d s Verzögerung nicht verfügbar: %v", late.MaxDelayS, cause))
	default:
		msg := "wartet auf Quelle: " + cause.Error()
		if j.State == StWaiting && j.Error == msg {
			return
		}
		_, _ = s.St.Mutate(ctx, j.ID, -1, msg, func(x *Job) (map[string]any, error) {
			if x.State != StStarting && x.State != StWaiting && x.State != StScheduled {
				return nil, errNoop
			}
			x.State = StWaiting
			x.Error = msg
			return map[string]any{"mode": late.Mode}, nil
		})
	}
}

func (s *Service) prepareFailed(ctx context.Context, j Job, msg string) {
	now := s.now()
	if !now.Before(j.PlannedEnd) {
		s.fail(ctx, j, "prepare", msg)
		return
	}
	if j.Error == msg && j.State == StWaiting {
		return
	}
	_, _ = s.St.Mutate(ctx, j.ID, -1, msg, func(x *Job) (map[string]any, error) {
		if x.State == StStarting || x.State == StScheduled {
			x.State = StWaiting
		}
		x.Error = msg
		return nil, nil
	})
}

func (s *Service) watchRecording(ctx context.Context, j Job) {
	now := s.now()
	sess := Session{InstanceID: j.InstanceID, HostID: j.HostID}
	if !now.Before(j.PlannedEnd) {
		if err := s.Runtime.StopRecording(ctx, sess); err != nil {
			s.log().Warn("Stopp meldete Fehler — Datei wird trotzdem gesichert", "job", j.ID, "error", err)
		}
		t := now
		_, _ = s.St.Mutate(ctx, j.ID, -1, "Aufnahme beendet", func(x *Job) (map[string]any, error) {
			if x.State != StRecording {
				return nil, errNoop
			}
			x.State = StFinalizing
			x.ActualEnd = &t
			return nil, nil
		})
		return
	}
	st, _, err := s.Runtime.Status(ctx, sess)
	if err != nil || st != "recording" {
		cause := "Rekorder nicht erreichbar"
		if err != nil {
			cause = err.Error()
		} else {
			cause = "Rekorder meldet Status " + st
		}
		s.recordingFailed(ctx, j, "Aufnahme abgebrochen: "+cause)
	}
}

// recordingFailed: Teilaufnahme sichern, dann nach Richtlinie neu versuchen (Rest der Zeit) oder fehlschlagen.
func (s *Service) recordingFailed(ctx context.Context, j Job, msg string) {
	cfg := s.Cfg()
	now := s.now()
	sess := Session{InstanceID: j.InstanceID, HostID: j.HostID}
	_ = s.Runtime.StopRecording(ctx, sess)
	s.teardownInstance(ctx, j)
	partial := ""
	if fileSize(j.FilePath) > 0 && j.ActualStart != nil {
		if id, err := s.registerAsset(ctx, j, true); err == nil {
			partial = id
		}
	}
	retry := j.Attempt < j.MaxAttempts
	minRem := time.Duration(cfg.DefaultRetry.MinRemainingS) * time.Second
	if retry && j.PlannedEnd.Sub(now) < minRem {
		retry = false
	}
	if retry {
		metrics.Retries.Add(1)
		backoff := time.Duration(cfg.DefaultRetry.BackoffS) * time.Second
		_ = backoff
		_, _ = s.St.Mutate(ctx, j.ID, -1, msg+" — neuer Versuch", func(x *Job) (map[string]any, error) {
			x.State = StStarting
			x.InstanceID = ""
			x.Attempt++
			p := cfg.Profiles[x.ProfileID]
			x.FileRel = s.fileRel(*x, x.Attempt, p.Ext)
			x.FilePath = filepath.Join(cfg.MediaDir, filepath.FromSlash(x.FileRel))
			x.ActualStart = nil
			if partial != "" {
				x.AssetID = partial // Teilaufnahme bleibt erhalten und verknüpft
			}
			x.Error = msg
			return map[string]any{"partialAsset": partial, "attempt": x.Attempt}, nil
		})
		return
	}
	s.failWith(ctx, j, "recording", msg, partial)
}

func (s *Service) fail(ctx context.Context, j Job, stage, msg string) {
	s.failWith(ctx, j, stage, msg, "")
}

func (s *Service) failWith(ctx context.Context, j Job, stage, msg, assetID string) {
	s.teardownInstance(ctx, j)
	out, err := s.St.Mutate(ctx, j.ID, -1, msg, func(x *Job) (map[string]any, error) {
		if Terminal(x.State) {
			return nil, errNoop
		}
		x.State = StFailed
		x.Error, x.FailedStage = msg, stage
		if assetID != "" {
			x.AssetID = assetID
		}
		t := s.now()
		if x.ActualEnd == nil && x.ActualStart != nil {
			x.ActualEnd = &t
		}
		return map[string]any{"stage": stage}, nil
	})
	if err == nil && out.State == StFailed {
		metrics.Failed.Add(1)
		s.audit("system", j.ID, "failed", map[string]any{"stage": stage, "error": msg})
		s.log().Warn("Aufnahmeauftrag fehlgeschlagen", "job", j.ID, "stage", stage, "error", msg)
	}
}

func (s *Service) teardownInstance(ctx context.Context, j Job) {
	if j.InstanceID == "" {
		return
	}
	if err := s.Runtime.Teardown(ctx, j.InstanceID); err != nil {
		s.log().Warn("Rekorder nicht beendet", "job", j.ID, "instance", j.InstanceID, "error", err)
	}
}

// registerAsset legt Asset + Version + Rohdatei an (idempotent über AssetID). Die Version bleibt Entwurf, bis die Nachbearbeitung
// durch ist (publishAsset). Eine fehlgeschlagene Nachbearbeitung verliert die Aufnahme nie: das Asset existiert vor ihr.
func (s *Service) registerAsset(ctx context.Context, j Job, partial bool) (string, error) {
	if j.AssetID != "" && !partial {
		return j.AssetID, nil
	}
	if s.Assets == nil {
		return "", fmt.Errorf("kein Asset-Speicher konfiguriert")
	}
	title := fmt.Sprintf("%s %s", j.Name, j.PlannedStart.UTC().Format("2006-01-02 15:04"))
	if partial {
		title += fmt.Sprintf(" (Teil %d)", j.Attempt)
	}
	a, err := s.Assets.CreateAsset("video", title, "", "ingest", "")
	if err != nil {
		return "", err
	}
	v, err := s.Assets.CreateVersion(a.ID, "", "Aufnahme", "ingest")
	if err != nil {
		return "", err
	}
	size := fileSize(j.FilePath)
	rep := asset.Representation{AssetVersionID: v.ID, Type: "recorded", Storage: asset.StorageLocation{Provider: "filesystem", URI: j.FilePath}, Container: strings.TrimPrefix(filepath.Ext(j.FilePath), ".")}
	if size > 0 {
		rep.SizeBytes = &size
	}
	if _, err := s.Assets.CreateRepresentation(rep); err != nil {
		return "", err
	}
	md := asset.Metadata{System: map[string]any{"ingestJob": j.ID, "source": j.Source.Label, "profile": j.ProfileID, "plannedStart": j.PlannedStart, "recorded": true, "partial": partial, "versionId": v.ID}, Descriptive: j.Metadata}
	if j.Audio != nil {
		md.System["audioChannels"] = j.Audio.Layout()
	}
	if cur, err := s.Assets.GetAsset(a.ID); err == nil {
		_, _ = s.Assets.UpdateAssetMetadata(a.ID, cur.RowVersion, md, "ingest")
	}
	if partial {
		_, _ = s.Assets.PublishVersion(v.ID)
		s.finishAsset(a.ID)
	}
	return a.ID, nil
}

func (s *Service) finishAsset(assetID string) {
	if cur, err := s.Assets.GetAsset(assetID); err == nil {
		_, _ = s.Assets.UpdateAssetStatus(assetID, cur.RowVersion, asset.StatusRegistered, "ingest")
	}
}

// publishAsset: Version veröffentlichen und Asset auf „registered“ setzen — ab jetzt sieht der Eingang (Kapitel 43) es und startet die QC.
func (s *Service) publishAsset(ctx context.Context, j Job) {
	if j.AssetID == "" || s.Assets == nil {
		return
	}
	a, err := s.Assets.GetAsset(j.AssetID)
	if err != nil {
		return
	}
	vid, _ := a.Metadata.System["versionId"].(string)
	if vid == "" {
		vs, _ := s.Assets.ListVersions(a.ID)
		if len(vs) > 0 {
			vid = vs[len(vs)-1].ID
		}
	}
	if vid != "" {
		_, _ = s.Assets.PublishVersion(vid)
	}
	s.finishAsset(j.AssetID)
}

func (s *Service) finalize(ctx context.Context, j Job) {
	cfg := s.Cfg()
	size := fileSize(j.FilePath)
	if size <= 0 {
		s.fail(ctx, j, "finalize", "Aufnahmedatei fehlt oder ist leer: "+j.FilePath)
		return
	}
	id, err := s.registerAsset(ctx, j, false)
	if err != nil {
		s.fail(ctx, j, "finalize", "Asset nicht registrierbar (Datei bleibt erhalten: "+j.FilePath+"): "+err.Error())
		return
	}
	// Messwerte für künftige Planung
	if j.ActualStart != nil && j.ActualEnd != nil {
		if dur := j.ActualEnd.Sub(*j.ActualStart).Seconds(); dur > 5 {
			_ = s.St.RecordStats(ctx, j.ProfileID, float64(size)/dur, 0, 0)
		}
	}
	s.teardownInstance(ctx, j)
	aborted := j.Error == "abgebrochen"
	p := cfg.Profiles[j.ProfileID]
	next := StCompleted
	if p.Convert != nil && !aborted {
		next = StProcessing
	}
	out, err := s.St.Mutate(ctx, j.ID, -1, "Datei gesichert ("+fmt.Sprint(size)+" Bytes), Asset "+id, func(x *Job) (map[string]any, error) {
		if x.State != StFinalizing {
			return nil, errNoop
		}
		x.AssetID = id
		x.State = next
		if aborted {
			x.State = StCancelled
		}
		return map[string]any{"asset": id, "bytes": size}, nil
	})
	if err != nil {
		return
	}
	if out.State == StCompleted || out.State == StCancelled {
		s.publishAsset(ctx, out)
		if out.State == StCompleted {
			metrics.Completed.Add(1)
		}
	}
}

// process: optionale Nachbearbeitung (ffmpeg). Fehler → Auftrag „failed“ (Stufe processing), die Rohaufnahme bleibt als Asset erhalten.
func (s *Service) process(ctx context.Context, j Job) {
	p := s.Cfg().Profiles[j.ProfileID]
	if p.Convert == nil {
		s.publishAsset(ctx, j)
		_, _ = s.St.Mutate(ctx, j.ID, -1, "keine Nachbearbeitung", func(x *Job) (map[string]any, error) {
			x.State = StCompleted
			return nil, nil
		})
		return
	}
	out := strings.TrimSuffix(j.FilePath, filepath.Ext(j.FilePath)) + ".conv" + p.Convert.Ext
	if s.FFmpeg == "" && s.Jobs == nil {
		s.publishAsset(ctx, j)
		s.failWith(ctx, j, "processing", "ffmpeg nicht verfügbar — Rohaufnahme bleibt erhalten", "")
		return
	}
	cctx, cancel := context.WithTimeout(ctx, 6*time.Hour)
	defer cancel()
	var runErr error
	var msg string
	if s.Jobs != nil {
		// über den Dispatcher: absolute Pfade (der Host sieht nicht unser Arbeitsverzeichnis), Host-Auswahl und Sendeschutz inklusive
		inAbs, _ := filepath.Abs(j.FilePath)
		partAbs, _ := filepath.Abs(out + ".part" + p.Convert.Ext)
		args := append([]string{"-nostdin", "-v", "error", "-y", "-i", inAbs}, p.Convert.Args...)
		args = append(args, partAbs)
		var lines []string
		_, code, err := s.Jobs.Run(cctx, "ffmpeg", args, func(l string) { lines = append(lines, l) })
		if err != nil {
			runErr, msg = err, err.Error()
		} else if code != 0 {
			runErr, msg = fmt.Errorf("exit status %d", code), strings.Join(lines, "\n")
		}
	} else {
		args := append([]string{"-nostdin", "-v", "error", "-y", "-i", j.FilePath}, p.Convert.Args...)
		args = append(args, out+".part"+p.Convert.Ext)
		b, err := exec.CommandContext(cctx, s.FFmpeg, args...).CombinedOutput()
		runErr, msg = err, string(b)
	}
	if runErr != nil {
		_ = os.Remove(out + ".part" + p.Convert.Ext)
		s.publishAsset(ctx, j) // Rohaufnahme nicht verlieren
		s.failWith(ctx, j, "processing", "Konvertierung fehlgeschlagen (Rohaufnahme erhalten): "+strings.TrimSpace(msg), "")
		return
	}
	if err := os.Rename(out+".part"+p.Convert.Ext, out); err != nil {
		s.publishAsset(ctx, j)
		s.failWith(ctx, j, "processing", "Ergebnis nicht ablegbar: "+err.Error(), "")
		return
	}
	// zweite Repräsentation (Version ist noch Entwurf)
	if a, err := s.Assets.GetAsset(j.AssetID); err == nil {
		vid, _ := a.Metadata.System["versionId"].(string)
		size := fileSize(out)
		if vid != "" {
			_, _ = s.Assets.CreateRepresentation(asset.Representation{AssetVersionID: vid, Type: "mezzanine", Storage: asset.StorageLocation{Provider: "filesystem", URI: out}, Container: strings.TrimPrefix(p.Convert.Ext, "."), SizeBytes: &size})
		}
	}
	s.publishAsset(ctx, j)
	if _, err := s.St.Mutate(ctx, j.ID, -1, "Nachbearbeitung abgeschlossen", func(x *Job) (map[string]any, error) {
		if x.State != StProcessing {
			return nil, errNoop
		}
		x.State = StCompleted
		return map[string]any{"output": out}, nil
	}); err == nil {
		metrics.Completed.Add(1)
	}
}

// Reconcile gleicht Soll (Datenbank) und Ist (Instanzen) ab — beim Start und periodisch. Verwaiste Rekorder werden beendet,
// laufende Aufnahmen bleiben unberührt (der Ablauf übernimmt sie über Adopt).
func (s *Service) Reconcile(ctx context.Context) {
	active, err := s.St.ListJobs(ctx, JobFilter{States: []string{StStarting, StRecording, StFinalizing, StProcessing, StWaiting}, Limit: 1000})
	if err != nil {
		return
	}
	used := map[string]bool{}
	for _, j := range active {
		if j.InstanceID != "" && j.State != StProcessing {
			used[j.InstanceID] = true
		}
	}
	for _, id := range s.Runtime.Instances(ctx) {
		if !used[id] {
			if err := s.Runtime.Teardown(ctx, id); err == nil {
				metrics.OrphansReaped.Add(1)
				s.log().Warn("verwaister Rekorder beendet", "instance", id)
			}
		}
	}
}

var _ = errors.Is
