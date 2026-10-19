package review

import (
	"context"
	"crypto/sha1"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/asset"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

// Service enthält die Ablauflogik (Claim, QC, Conform, Freigabe). HTTP-Handler sind dünn darüber.
type Service struct {
	St     *Store
	Assets *asset.Store
	Tools  *Tools
	Cfg    func() Config
	// DataDir: Ablage der Review-Proxies (<DataDir>/proxies/<asset>/…).
	DataDir string
	Audit   module.DomainAudit
	Log     *slog.Logger
	Now     func() time.Time
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func (s *Service) log() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.Default()
}

func (s *Service) audit(actor, assetID, action string, d map[string]any) {
	if s.Audit != nil {
		s.Audit.Log(actor, "review", assetID, action, d)
	}
}

var mediaExt = map[string]bool{".mxf": true, ".mov": true, ".mp4": true, ".m4v": true, ".mkv": true, ".ts": true, ".mts": true, ".m2ts": true, ".mpg": true, ".mpeg": true, ".avi": true, ".wav": true, ".mp3": true, ".m4a": true, ".flac": true, ".webm": true, ".mj2": true, ".gxf": true}

// LocalPath liefert den lokalen Dateipfad einer Representation; Objektspeicher-Ablagen sind (noch) nicht lokal lesbar.
func LocalPath(r asset.Representation) (string, error) {
	switch r.Storage.Provider {
	case "filesystem", "file", "local":
	default:
		return "", fmt.Errorf("Ablage %q ist nicht lokal lesbar — die Datei muss zuerst bereitgestellt (materialisiert) werden", r.Storage.Provider)
	}
	p := strings.TrimPrefix(r.Storage.URI, "file://")
	if !filepath.IsAbs(p) {
		return "", fmt.Errorf("kein absoluter Dateipfad: %q", p)
	}
	st, err := os.Stat(p)
	if err != nil {
		return "", fmt.Errorf("Datei nicht lesbar: %w", err)
	}
	if !st.Mode().IsRegular() {
		return "", fmt.Errorf("keine reguläre Datei: %s", p)
	}
	return p, nil
}

// Fingerprint kennzeichnet die Version der Quelldatei (Größe + Änderungszeit). Proxys und QC-Berichte gehören immer zu genau
// einem Fingerprint; ändert sich die Datei, gelten sie nicht mehr.
func Fingerprint(path string) (string, error) {
	st, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	h := sha1.Sum([]byte(fmt.Sprintf("%d|%d", st.Size(), st.ModTime().UnixNano())))
	return hex.EncodeToString(h[:8]), nil
}

// pickRepresentation wählt die zu prüfende Datei einer Asset-Version.
func pickRepresentation(reps []asset.Representation) (asset.Representation, bool) {
	skip := map[string]bool{"thumbnail": true, "proxy": true, "caption": true, "subtitle": true, "image": true, "review_proxy": true}
	for _, r := range reps {
		if skip[strings.ToLower(r.Type)] {
			continue
		}
		p := strings.TrimPrefix(r.Storage.URI, "file://")
		if mediaExt[strings.ToLower(filepath.Ext(p))] {
			return r, true
		}
	}
	return asset.Representation{}, false
}

// Register legt für ein Asset den Eintrag der Arbeitsliste an (idempotent) und löst die QC aus.
func (s *Service) Register(ctx context.Context, assetID, actor string) (Item, bool, error) {
	a, err := s.Assets.GetAsset(assetID)
	if err != nil {
		return Item{}, false, err
	}
	if a.CurrentVersionID == "" {
		return Item{}, false, fmt.Errorf("%w: Asset hat noch keine Version", ErrValidation)
	}
	reps, err := s.Assets.ListRepresentations(a.CurrentVersionID)
	if err != nil {
		return Item{}, false, err
	}
	rep, ok := pickRepresentation(reps)
	if !ok {
		return Item{}, false, fmt.Errorf("%w: keine prüfbare Mediendatei in der aktuellen Version", ErrValidation)
	}
	it := Item{AssetID: assetID, SourceVersionID: a.CurrentVersionID, SourceRepID: rep.ID, FileName: filepath.Base(strings.TrimPrefix(rep.Storage.URI, "file://")),
		Format: rep.Container, ApprovalMode: s.Cfg().ApprovalMode}
	if rep.SizeBytes != nil {
		it.SizeBytes = *rep.SizeBytes
	}
	if j, ok := a.Metadata.System["ingestJob"].(string); ok {
		it.IngestJob = j
	}
	if p, err := LocalPath(rep); err == nil {
		it.SourceRev, _ = Fingerprint(p)
		if st, e := os.Stat(p); e == nil {
			it.SizeBytes = st.Size()
		}
		if s.Tools != nil {
			pctx, cancel := context.WithTimeout(ctx, 60*time.Second)
			if tl, _, e := s.Tools.ProbeTimeline(pctx, p); e == nil {
				it.Timeline = tl
			}
			cancel()
		}
	}
	created, err := s.St.EnsureItem(ctx, it, actor)
	if err != nil {
		return Item{}, false, err
	}
	if created {
		s.audit(actor, assetID, "registered", map[string]any{"file": it.FileName})
		if s.Cfg().AutoQC {
			if _, _, err := s.RequestQC(ctx, assetID, actor, "", false); err != nil {
				s.log().Warn("review: QC konnte nicht eingeplant werden", "asset", assetID, "error", err)
			}
		}
	}
	got, err := s.St.GetItem(ctx, assetID)
	return got, created, err
}

// ScanNew registriert neu eingegangene Assets (Aufruf periodisch durch den Worker).
func (s *Service) ScanNew(ctx context.Context) (int, error) {
	rows, err := s.St.db.QueryContext(ctx, `SELECT a.id FROM assets a WHERE a.status NOT IN ('deleted','expired') AND a.current_version_id IS NOT NULL
		AND NOT EXISTS (SELECT 1 FROM review_items i WHERE i.asset_id = a.id)
		AND NOT EXISTS (SELECT 1 FROM review_skipped k WHERE k.asset_id = a.id AND k.version_id = a.current_version_id)
		AND EXISTS (SELECT 1 FROM representations r WHERE r.asset_version_id = a.current_version_id AND r.storage_provider IN ('filesystem','file','local'))
		ORDER BY a.created_at LIMIT 50`)
	if err != nil {
		return 0, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	n := 0
	for _, id := range ids {
		if _, created, err := s.Register(ctx, id, "system"); err == nil {
			if created {
				n++
			}
		} else if !errors.Is(err, ErrValidation) {
			s.log().Warn("review: Registrierung fehlgeschlagen", "asset", id, "error", err)
		} else {
			// Asset ohne prüfbare Datei: nicht jede Minute neu versuchen
			_ = s.markIgnored(ctx, id)
		}
	}
	return n, nil
}

// markIgnored: Assets ohne prüfbare Mediendatei werden je Version nur einmal geprüft.
func (s *Service) markIgnored(ctx context.Context, id string) error {
	_, err := s.St.db.ExecContext(ctx, `INSERT INTO review_skipped (asset_id, version_id, reason) SELECT id, current_version_id, 'keine prüfbare Mediendatei' FROM assets WHERE id=$1
		ON CONFLICT (asset_id) DO UPDATE SET version_id = EXCLUDED.version_id, at = now()`, id)
	return err
}

// ImportFile registriert eine Datei aus dem konfigurierten Importverzeichnis als Asset und stellt sie in die Arbeitsliste.
func (s *Service) ImportFile(ctx context.Context, rel, title, actor string) (Item, error) {
	cfg := s.Cfg()
	if cfg.ImportDir == "" {
		return Item{}, fmt.Errorf("%w: Import ist nicht eingerichtet (review.config importDir)", ErrValidation)
	}
	root, err := filepath.EvalSymlinks(cfg.ImportDir)
	if err != nil {
		return Item{}, fmt.Errorf("%w: Importverzeichnis nicht lesbar: %v", ErrValidation, err)
	}
	full, err := filepath.EvalSymlinks(filepath.Join(root, filepath.Clean("/"+rel)))
	if err != nil {
		return Item{}, fmt.Errorf("%w: Datei nicht gefunden", ErrValidation)
	}
	if full != root && !strings.HasPrefix(full, root+string(os.PathSeparator)) {
		return Item{}, fmt.Errorf("%w: Datei liegt außerhalb des Importverzeichnisses", ErrValidation)
	}
	st, err := os.Stat(full)
	if err != nil || !st.Mode().IsRegular() || !mediaExt[strings.ToLower(filepath.Ext(full))] {
		return Item{}, fmt.Errorf("%w: keine unterstützte Mediendatei", ErrValidation)
	}
	if title == "" {
		title = strings.TrimSuffix(filepath.Base(full), filepath.Ext(full))
	}
	a, err := s.Assets.CreateAsset("video", title, "", actor, "")
	if err != nil {
		return Item{}, err
	}
	v, err := s.Assets.CreateVersion(a.ID, "", "Import ins Review", actor)
	if err != nil {
		return Item{}, err
	}
	size := st.Size()
	if _, err := s.Assets.CreateRepresentation(asset.Representation{AssetVersionID: v.ID, Type: "source", Storage: asset.StorageLocation{Provider: "filesystem", URI: full},
		Container: strings.TrimPrefix(strings.ToLower(filepath.Ext(full)), "."), SizeBytes: &size}); err != nil {
		return Item{}, err
	}
	if _, err := s.Assets.PublishVersion(v.ID); err != nil {
		return Item{}, err
	}
	if cur, err := s.Assets.GetAsset(a.ID); err == nil {
		_, _ = s.Assets.UpdateAssetStatus(a.ID, cur.RowVersion, asset.StatusRegistered, actor)
	}
	it, _, err := s.Register(ctx, a.ID, actor)
	s.audit(actor, a.ID, "import", map[string]any{"file": filepath.Base(full)})
	return it, err
}

// sourcePath: lokaler Pfad der Quelle eines Eintrags.
func (s *Service) sourcePath(it Item) (string, error) {
	rep, err := s.Assets.GetRepresentation(it.SourceRepID)
	if err != nil {
		return "", err
	}
	return LocalPath(rep)
}

// ---- QC ----------------------------------------------------------------------------------------------------------

// RequestQC plant eine (Wiederholungs-)Analyse. force=false: ein aktiver Auftrag wird weitergenutzt.
func (s *Service) RequestQC(ctx context.Context, assetID, actor, profileID string, force bool) (Job, bool, error) {
	cfg := s.Cfg()
	if _, ok := cfg.Profile(profileID); !ok {
		return Job{}, false, fmt.Errorf("%w: unbekanntes QC-Profil %q", ErrValidation, profileID)
	}
	if profileID == "" {
		profileID = cfg.DefaultQCProfile
	}
	it, err := s.St.GetItem(ctx, assetID)
	if err != nil {
		return Job{}, false, err
	}
	if path, e := s.sourcePath(it); e == nil {
		if fp, e := Fingerprint(path); e == nil && fp != it.SourceRev {
			_, _ = s.St.withItem(ctx, assetID, -1, func(tx *sql.Tx, i *Item) (string, map[string]any, error) {
				i.SourceRev = fp
				return "source_changed", map[string]any{"sourceRev": fp}, nil
			}, actor)
			it.SourceRev = fp
		}
	}
	j, created, err := s.St.EnqueueJob(ctx, assetID, it.SourceRev, profileID, actor)
	if err != nil {
		return Job{}, false, err
	}
	if created {
		// Zustand: nur vor/neben der Prüfung zurück auf „wartet auf QC“; ein laufender Review bleibt unberührt
		if it.State == StateAwaitingReview || it.State == StateQCFailedToRun || it.State == StateAwaitingQC {
			_, _ = s.St.withItem(ctx, assetID, -1, func(tx *sql.Tx, i *Item) (string, map[string]any, error) {
				if i.State == StateAwaitingQC {
					return "qc_requested", map[string]any{"job": j.ID, "profile": profileID}, nil
				}
				i.State = StateAwaitingQC
				return "qc_requested", map[string]any{"job": j.ID, "profile": profileID}, nil
			}, actor)
		} else {
			_ = addHistory(ctx, s.St.db, assetID, actor, "qc_requested", it.State, it.State, map[string]any{"job": j.ID, "profile": profileID})
		}
		s.audit(actor, assetID, "qc_requested", map[string]any{"job": j.ID})
	}
	return j, created, nil
}

// RunNextQC bearbeitet einen wartenden Auftrag. ran=false, wenn keiner wartete.
func (s *Service) RunNextQC(ctx context.Context) (ran bool, err error) {
	job, err := s.St.ClaimJob(ctx)
	if err != nil || job == nil {
		return false, err
	}
	s.runJob(ctx, *job)
	return true, nil
}

func (s *Service) runJob(ctx context.Context, job Job) {
	log := s.log().With("asset", job.AssetID, "job", job.ID)
	it, err := s.St.GetItem(ctx, job.AssetID)
	if err != nil {
		_ = s.St.FailJob(ctx, job.ID, "Eintrag nicht gefunden")
		return
	}
	// Zustand: waiting → running
	_, _ = s.St.withItem(ctx, job.AssetID, -1, func(tx *sql.Tx, i *Item) (string, map[string]any, error) {
		if i.State == StateAwaitingQC {
			i.State = StateQCRunning
			return "qc_started", map[string]any{"job": job.ID, "attempt": job.Attempts}, nil
		}
		return "qc_started", map[string]any{"job": job.ID, "attempt": job.Attempts}, nil
	}, "system")

	cfg := s.Cfg()
	prof, ok := cfg.Profile(job.ProfileID)
	if !ok {
		s.failJob(ctx, job, "QC-Profil "+job.ProfileID+" existiert nicht mehr")
		return
	}
	path, err := s.sourcePath(it)
	if err != nil {
		s.failJob(ctx, job, err.Error())
		return
	}
	beat := make(chan struct{})
	go func() {
		t := time.NewTicker(15 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-beat:
				return
			case <-ctx.Done():
				return
			case <-t.C:
				_, _ = s.St.db.ExecContext(context.Background(), `UPDATE qc_jobs SET heartbeat_at=now() WHERE id=$1 AND state='running'`, job.ID)
			}
		}
	}()
	out, err := s.Tools.RunQC(ctx, path, prof, func(phase string, pct int) { s.St.JobProgress(ctx, job.ID, phase, pct) })
	close(beat)
	if err != nil {
		if errors.Is(err, context.Canceled) {
			log.Info("QC abgebrochen (Shutdown) — Auftrag wird später fortgesetzt")
			return
		}
		s.failJob(ctx, job, err.Error())
		return
	}
	rep, err := s.St.SaveReport(ctx, job, out)
	if err != nil {
		s.failJob(ctx, job, "Bericht nicht speicherbar: "+err.Error())
		return
	}
	// Quelle während der Analyse geändert? Dann ist der Bericht veraltet → neu planen.
	changed := false
	if fp, e := Fingerprint(path); e == nil && fp != job.SourceRev {
		changed = true
	}
	_, err = s.St.withItem(ctx, job.AssetID, -1, func(tx *sql.Tx, i *Item) (string, map[string]any, error) {
		i.QCStatus, i.QCReportID = out.Overall, rep.ID
		i.QCFail, i.QCWarn = out.Counts[CheckFail], out.Counts[CheckWarning]
		if out.Timeline != nil && !changed {
			i.Timeline = mergeTimeline(i.Timeline, out.Timeline)
		}
		if i.State == StateQCRunning || i.State == StateAwaitingQC {
			i.State = StateAwaitingReview
		}
		return "qc_done", map[string]any{"report": rep.ID, "overall": out.Overall, "ruleset": rep.Ruleset}, nil
	}, "system")
	if err != nil {
		log.Warn("QC-Ergebnis nicht am Eintrag vermerkt", "error", err)
	}
	s.audit("system", job.AssetID, "qc_done", map[string]any{"overall": out.Overall, "report": rep.ID})
	if changed {
		_, _, _ = s.RequestQC(ctx, job.AssetID, "system", job.ProfileID, false)
	}
}

// mergeTimeline: der Start-Timecode/Rate aus der Analyse ersetzt die vorläufige Zeitachse der Registrierung.
func mergeTimeline(old, nw *Timeline) *Timeline { return nw }

func (s *Service) failJob(ctx context.Context, job Job, msg string) {
	_ = s.St.FailJob(ctx, job.ID, msg)
	_, _ = s.St.withItem(ctx, job.AssetID, -1, func(tx *sql.Tx, i *Item) (string, map[string]any, error) {
		if i.State == StateQCRunning || i.State == StateAwaitingQC {
			i.State = StateQCFailedToRun
		}
		return "qc_execution_failed", map[string]any{"job": job.ID, "error": msg}, nil
	}, "system")
	s.audit("system", job.AssetID, "qc_execution_failed", map[string]any{"error": msg})
	s.log().Warn("QC nicht ausführbar", "asset", job.AssetID, "error", msg)
}

// ---- Claim / Release ---------------------------------------------------------------------------------------------

func (s *Service) claimableStates() []string {
	cfg := s.Cfg()
	st := []string{StateAwaitingReview, StateRejected}
	if cfg.AllowReviewWhileQCRunning {
		st = append(st, StateAwaitingQC, StateQCRunning)
	}
	if cfg.AllowReviewAfterQCExecFail {
		st = append(st, StateQCFailedToRun)
	}
	return st
}

// Claim: Asset zur Bearbeitung übernehmen. Atomar über die Zeilensperre: zwei gleichzeitige Claims → genau einer gewinnt, der
// andere bekommt ErrClaimed. Ein erneuter Claim durch denselben Nutzer ist idempotent.
func (s *Service) Claim(ctx context.Context, assetID, actor string) (Item, error) {
	return s.ClaimAs(ctx, assetID, actor, nil, true)
}

// ClaimAs wie Claim, aber mit Zuweisungsprüfung (Kapitel 44): eine einer Person zugewiesene Datei übernimmt nur diese Person, eine einer
// Gruppe zugewiesene nur deren Mitglieder; `override` (Recht „Zuweisen“) darf immer. Nicht zugewiesene Dateien kann jede(r) mit dem Recht übernehmen.
func (s *Service) ClaimAs(ctx context.Context, assetID, actor string, groups []string, override bool) (Item, error) {
	if actor == "" {
		return Item{}, ErrForbidden
	}
	allowed := s.claimableStates()
	it, err := s.St.withItem(ctx, assetID, -1, func(tx *sql.Tx, i *Item) (string, map[string]any, error) {
		if i.Assignee == actor && (i.State == StateInReview || i.State == StateConforming) {
			return "", nil, errNoop // schon meins
		}
		if i.Assignee != "" {
			return "", nil, fmt.Errorf("%w (%s)", ErrClaimed, i.Assignee)
		}
		if !contains(allowed, i.State) {
			return "", nil, fmt.Errorf("%w: Zustand %s", ErrState, i.State)
		}
		if !override && !mayClaim(*i, actor, groups) {
			return "", nil, fmt.Errorf("%w: Die Datei ist %s zugewiesen", ErrForbidden, assignedLabel(*i))
		}
		now := s.now()
		i.Assignee, i.ClaimedAt, i.State = actor, &now, StateInReview
		if i.AssignedTo == "" {
			i.AssignedTo = actor // wer übernimmt, ist ab jetzt auch der Zugewiesene
		}
		if err := ensureDraft(context.Background(), tx, i, actor); err != nil {
			return "", nil, err
		}
		return "claimed", nil, nil
	}, actor)
	if err == nil {
		s.syncAssetStatus(assetID, asset.StatusReady, asset.StatusInReview, actor)
		s.audit(actor, assetID, "claimed", nil)
	}
	return it, err
}

// Release gibt die Bearbeitung zurück (der Entwurf bleibt erhalten). Nur der Bearbeiter selbst oder ein Admin/Verantwortlicher.
func (s *Service) Release(ctx context.Context, assetID, actor string, privileged bool, expectedRev int64) (Item, error) {
	return s.St.withItem(ctx, assetID, expectedRev, func(tx *sql.Tx, i *Item) (string, map[string]any, error) {
		if i.Assignee == "" {
			return "", nil, fmt.Errorf("%w: nicht übernommen", ErrState)
		}
		if i.Assignee != actor && !privileged {
			return "", nil, ErrForbidden
		}
		prev := i.Assignee
		if i.State != StateInReview && i.State != StateConforming {
			return "", nil, fmt.Errorf("%w: Zustand %s", ErrState, i.State)
		}
		i.Assignee, i.ClaimedAt, i.State = "", nil, StateAwaitingReview
		if i.AssignedGroup != "" && i.AssignedTo == prev {
			i.AssignedTo = "" // Gruppenaufgabe: zurück in den Pool der Gruppe
		}
		return "released", map[string]any{"previous": prev}, nil
	}, actor)
}

// Reassign überträgt die Bearbeitung an eine andere Person (Verantwortliche).
func (s *Service) Reassign(ctx context.Context, assetID, actor, to string, expectedRev int64) (Item, error) {
	if strings.TrimSpace(to) == "" {
		return Item{}, fmt.Errorf("%w: Zielperson fehlt", ErrValidation)
	}
	return s.St.withItem(ctx, assetID, expectedRev, func(tx *sql.Tx, i *Item) (string, map[string]any, error) {
		if i.State != StateInReview && i.State != StateConforming {
			return "", nil, fmt.Errorf("%w: Zustand %s", ErrState, i.State)
		}
		prev := i.Assignee
		now := s.now()
		i.Assignee, i.ClaimedAt, i.AssignedTo = to, &now, to
		return "reassigned", map[string]any{"from": prev, "to": to}, nil
	}, actor)
}

// AssignTask weist die Prüfaufgabe einer Person und/oder Gruppe zu (leer = Zuweisung aufheben) und setzt optional eine Frist.
// Die Übernahme (Bearbeiter) bleibt unberührt: eine bereits übernommene Datei behält ihren Bearbeiter.
func (s *Service) AssignTask(ctx context.Context, assetID, actor, user, group string, due *time.Time, expectedRev int64) (Item, error) {
	user, group = strings.TrimSpace(user), strings.TrimSpace(group)
	if len(user) > 100 || len(group) > 100 {
		return Item{}, fmt.Errorf("%w: Name zu lang", ErrValidation)
	}
	return s.St.withItem(ctx, assetID, expectedRev, func(tx *sql.Tx, i *Item) (string, map[string]any, error) {
		if i.State == StateApproved || i.State == StateArchived {
			return "", nil, fmt.Errorf("%w: Zustand %s", ErrState, i.State)
		}
		prev := map[string]any{"user": i.AssignedTo, "group": i.AssignedGroup}
		now := s.now()
		i.AssignedTo, i.AssignedGroup, i.DueAt = user, group, due
		i.AssignedBy, i.AssignedAt = actor, &now
		if user == "" && group == "" {
			i.AssignedBy, i.AssignedAt = "", nil
		}
		return "assigned", map[string]any{"from": prev, "user": user, "group": group, "dueAt": due}, nil
	}, actor)
}

func assignedLabel(i Item) string {
	switch {
	case i.AssignedTo != "" && i.AssignedGroup != "":
		return i.AssignedTo + " / Gruppe " + i.AssignedGroup
	case i.AssignedTo != "":
		return i.AssignedTo
	}
	return "Gruppe " + i.AssignedGroup
}

// mayClaim: darf `actor` die Datei übernehmen, ohne das Zuweisungsrecht zu haben?
func mayClaim(i Item, actor string, groups []string) bool {
	if i.AssignedTo == "" && i.AssignedGroup == "" {
		return true
	}
	if i.AssignedTo != "" && i.AssignedTo == actor {
		return true
	}
	if i.AssignedGroup != "" && i.AssignedTo == "" {
		for _, g := range groups {
			if g == i.AssignedGroup {
				return true
			}
		}
	}
	return false
}

func (s *Service) syncAssetStatus(assetID, from, to, actor string) {
	a, err := s.Assets.GetAsset(assetID)
	if err != nil || a.Status != from {
		return
	}
	if _, err := s.Assets.UpdateAssetStatus(assetID, a.RowVersion, to, actor); err != nil {
		s.log().Debug("review: Asset-Status nicht nachgeführt", "asset", assetID, "from", from, "to", to, "error", err)
	}
}

// ---- Conform -----------------------------------------------------------------------------------------------------

// ensureDraft stellt sicher, dass es einen Entwurf gibt: Kopie der jüngsten Revision (neue Revisionsnummer) oder leer.
func ensureDraft(ctx context.Context, tx *sql.Tx, it *Item, actor string) error {
	var exists bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM conform_revisions WHERE asset_id=$1 AND state='draft')`, it.AssetID).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return nil
	}
	var maxRev int
	var prevID sql.NullString
	var ui, uo sql.NullInt64
	var meta []byte
	err := tx.QueryRowContext(ctx, `SELECT id, revision, usable_in, usable_out, asset_metadata FROM conform_revisions WHERE asset_id=$1 ORDER BY revision DESC LIMIT 1`, it.AssetID).
		Scan(&prevID, &maxRev, &ui, &uo, &meta)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if len(meta) == 0 {
		meta = []byte("{}")
	}
	id := newID()
	if _, err := tx.ExecContext(ctx, `INSERT INTO conform_revisions (id, asset_id, revision, state, source_rev, usable_in, usable_out, asset_metadata, created_by, updated_by) VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$8)`,
		id, it.AssetID, maxRev+1, it.SourceRev, nullInt(ui), nullInt(uo), meta, actor); err != nil {
		return err
	}
	if prevID.Valid {
		if _, err := tx.ExecContext(ctx, `INSERT INTO conform_segments (id, conform_id, ord, label, in_frame, out_frame, description, metadata, created_by)
			SELECT md5(random()::text || id || $2::text), $2, ord, label, in_frame, out_frame, description, metadata, created_by FROM conform_segments WHERE conform_id=$1`, prevID.String, id); err != nil {
			return err
		}
	}
	return nil
}

func nullInt(n sql.NullInt64) any {
	if n.Valid {
		return n.Int64
	}
	return nil
}

// SegmentInput / SaveConformInput: Eingabe des Editors.
type SegmentInput struct {
	ID          string         `json:"id"`
	Label       string         `json:"label"`
	In          int64          `json:"in"`
	Out         int64          `json:"out"`
	Description string         `json:"description"`
	Metadata    map[string]any `json:"metadata"`
}

type SaveConformInput struct {
	ExpectedRevision int64          `json:"expectedRevision"`
	UsableIn         *int64         `json:"usableIn"`
	UsableOut        *int64         `json:"usableOut"`
	Segments         []SegmentInput `json:"segments"`
	AssetMetadata    map[string]any `json:"assetMetadata"`
	Note             string         `json:"note"`
	// AckSourceChange bestätigt, dass die Bereiche trotz geänderter Quelldatei übernommen werden sollen.
	AckSourceChange bool `json:"ackSourceChange"`
}

// ValidateConform prüft Bereiche und Metadaten gegen Zeitachse und Richtlinie. complete=true zusätzlich Pflichtfelder (Einreichen).
func (s *Service) ValidateConform(tl *Timeline, in SaveConformInput, complete bool) []string {
	cfg := s.Cfg()
	var p []string
	if tl == nil {
		return []string{"Zeitachse der Datei unbekannt (Analyse noch nicht erfolgt oder keine Videospur)"}
	}
	if (in.UsableIn == nil) != (in.UsableOut == nil) {
		p = append(p, "Nutzbarer Bereich: In und Out müssen beide gesetzt sein")
	} else if in.UsableIn != nil {
		if err := tl.ValidateRange(*in.UsableIn, *in.UsableOut, cfg.MinSegmentFrames); err != nil {
			p = append(p, "Nutzbarer Bereich: "+err.Error())
		}
	}
	ids := map[string]bool{}
	for i, sg := range in.Segments {
		name := fmt.Sprintf("Segment %d", i+1)
		if sg.ID != "" {
			if ids[sg.ID] {
				p = append(p, name+": doppelte ID")
			}
			ids[sg.ID] = true
		}
		if err := tl.ValidateRange(sg.In, sg.Out, cfg.MinSegmentFrames); err != nil {
			p = append(p, name+": "+err.Error())
			continue
		}
		if in.UsableIn != nil && in.UsableOut != nil && (sg.In < *in.UsableIn || sg.Out > *in.UsableOut) {
			p = append(p, name+": liegt außerhalb des nutzbaren Bereichs")
		}
		for _, e := range cfg.ValidateMetadata(sg.Metadata, true, complete) {
			p = append(p, name+": "+e)
		}
	}
	// Überlappung/Lücken nach Richtlinie (zeitlich sortiert geprüft)
	sorted := append([]SegmentInput(nil), in.Segments...)
	sort.SliceStable(sorted, func(a, b int) bool { return sorted[a].In < sorted[b].In })
	for i := 1; i < len(sorted); i++ {
		prev, cur := sorted[i-1], sorted[i]
		if cur.In < prev.Out && !cfg.AllowOverlap {
			p = append(p, fmt.Sprintf("Segmente überlappen: [%d,%d) und [%d,%d)", prev.In, prev.Out, cur.In, cur.Out))
		}
		if cur.In > prev.Out && !cfg.AllowGaps {
			p = append(p, fmt.Sprintf("Lücke zwischen Segmenten: [%d,%d)", prev.Out, cur.In))
		}
	}
	p = append(p, cfg.ValidateMetadata(in.AssetMetadata, false, complete)...)
	if complete && len(in.Segments) == 0 {
		p = append(p, "Mindestens ein Segment ist erforderlich")
	}
	return p
}

// SaveConform speichert den Entwurf (ersetzt Bereiche/Segmente/Metadaten). Nur der Bearbeiter; optimistisch über die Revision.
func (s *Service) SaveConform(ctx context.Context, assetID, actor string, in SaveConformInput) (Item, *Conform, error) {
	var out *Conform
	it, err := s.St.withItem(ctx, assetID, in.ExpectedRevision, func(tx *sql.Tx, i *Item) (string, map[string]any, error) {
		if i.Assignee != actor {
			return "", nil, ErrForbidden
		}
		if i.State != StateInReview && i.State != StateConforming {
			return "", nil, fmt.Errorf("%w: Zustand %s", ErrState, i.State)
		}
		if probs := s.ValidateConform(i.Timeline, in, false); len(probs) > 0 {
			return "", nil, &ValidationError{Problems: probs}
		}
		if err := ensureDraft(ctx, tx, i, actor); err != nil {
			return "", nil, err
		}
		var cid, srcRev string
		if err := tx.QueryRowContext(ctx, `SELECT id, source_rev FROM conform_revisions WHERE asset_id=$1 AND state='draft' FOR UPDATE`, assetID).Scan(&cid, &srcRev); err != nil {
			return "", nil, err
		}
		if srcRev != i.SourceRev && !in.AckSourceChange {
			return "", nil, fmt.Errorf("%w: Die Quelldatei hat sich seit dem Entwurf geändert (ackSourceChange bestätigen)", ErrConflict)
		}
		existing := map[string]struct {
			by string
			at any
		}{}
		rows, err := tx.QueryContext(ctx, `SELECT id, created_by, created_at FROM conform_segments WHERE conform_id=$1`, cid)
		if err != nil {
			return "", nil, err
		}
		for rows.Next() {
			var id, by string
			var at time.Time
			if err := rows.Scan(&id, &by, &at); err != nil {
				rows.Close()
				return "", nil, err
			}
			existing[id] = struct {
				by string
				at any
			}{by, at}
		}
		rows.Close()
		if _, err := tx.ExecContext(ctx, `DELETE FROM conform_segments WHERE conform_id=$1`, cid); err != nil {
			return "", nil, err
		}
		for n, sg := range in.Segments {
			id, by, at := sg.ID, actor, any(s.now())
			if e, ok := existing[id]; ok && id != "" {
				by, at = e.by, e.at
			} else if id == "" {
				id = newID()
			}
			label := strings.TrimSpace(sg.Label)
			if label == "" {
				label = fmt.Sprintf("Segment %d", n+1)
			}
			md := sg.Metadata
			if md == nil {
				md = map[string]any{}
			}
			mraw, _ := jsonMarshal(md)
			if _, err := tx.ExecContext(ctx, `INSERT INTO conform_segments (id, conform_id, ord, label, in_frame, out_frame, description, metadata, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
				id, cid, n, label, sg.In, sg.Out, sg.Description, mraw, by, at, s.now()); err != nil {
				return "", nil, err
			}
		}
		am := in.AssetMetadata
		if am == nil {
			am = map[string]any{}
		}
		araw, _ := jsonMarshal(am)
		if _, err := tx.ExecContext(ctx, `UPDATE conform_revisions SET usable_in=$2, usable_out=$3, asset_metadata=$4, note=$5, updated_by=$6, updated_at=now(), source_rev=$7 WHERE id=$1`,
			cid, in.UsableIn, in.UsableOut, araw, in.Note, actor, i.SourceRev); err != nil {
			return "", nil, err
		}
		i.State = StateConforming
		return "conform_saved", map[string]any{"segments": len(in.Segments)}, nil
	}, actor)
	if err != nil {
		return it, nil, err
	}
	out, err = s.St.WorkingConform(ctx, assetID)
	return it, out, err
}

// Submit reicht den Entwurf ein (vollständig validiert). Je nach approvalMode: Freigabe nötig oder sofort fertig.
func (s *Service) Submit(ctx context.Context, assetID, actor string, expectedRev int64) (Item, error) {
	cfg := s.Cfg()
	var approvedNow *Conform
	it, err := s.St.withItem(ctx, assetID, expectedRev, func(tx *sql.Tx, i *Item) (string, map[string]any, error) {
		if i.Assignee != actor {
			return "", nil, ErrForbidden
		}
		if i.State != StateInReview && i.State != StateConforming {
			return "", nil, fmt.Errorf("%w: Zustand %s", ErrState, i.State)
		}
		c, err := loadDraftTx(ctx, tx, assetID)
		if err != nil {
			return "", nil, err
		}
		in := SaveConformInput{UsableIn: c.UsableIn, UsableOut: c.UsableOut, AssetMetadata: c.AssetMetadata}
		for _, sg := range c.Segments {
			in.Segments = append(in.Segments, SegmentInput{ID: sg.ID, Label: sg.Label, In: sg.In, Out: sg.Out, Description: sg.Description, Metadata: sg.Metadata})
		}
		if probs := s.ValidateConform(i.Timeline, in, true); len(probs) > 0 {
			return "", nil, &ValidationError{Problems: probs}
		}
		if c.SourceRev != i.SourceRev {
			return "", nil, fmt.Errorf("%w: Die Quelldatei hat sich geändert — Entwurf bitte prüfen und erneut speichern", ErrConflict)
		}
		i.ApprovalMode = cfg.ApprovalMode
		if _, err := tx.ExecContext(ctx, `UPDATE conform_revisions SET state='submitted', updated_by=$2, updated_at=now() WHERE id=$1`, c.ID, actor); err != nil {
			return "", nil, err
		}
		c.State = ConformSubmitted
		if cfg.ApprovalMode == "none" {
			if _, err := tx.ExecContext(ctx, `UPDATE conform_revisions SET state='approved', decided_by=$2, decision_note='Keine Freigabe erforderlich (approvalMode none)' WHERE id=$1`, c.ID, actor); err != nil {
				return "", nil, err
			}
			i.State, i.Assignee, i.ClaimedAt = StateApproved, "", nil
			c.State = ConformApproved
			approvedNow = c
			return "submitted_auto_approved", map[string]any{"revision": c.Revision}, nil
		}
		i.State = StateReadyForApproval
		return "submitted", map[string]any{"revision": c.Revision}, nil
	}, actor)
	if err == nil {
		s.audit(actor, assetID, "submitted", nil)
		if approvedNow != nil {
			s.applyApproved(ctx, assetID, approvedNow, actor)
		}
	}
	return it, err
}

func loadDraftTx(ctx context.Context, tx *sql.Tx, assetID string) (*Conform, error) {
	c, err := scanConform(tx.QueryRowContext(ctx, `SELECT `+conformCols+` FROM conform_revisions WHERE asset_id=$1 AND state='draft'`, assetID))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("%w: kein Entwurf vorhanden", ErrState)
	}
	if err != nil {
		return nil, err
	}
	c.Segments, err = loadSegments(ctx, tx, c.ID)
	return &c, err
}

// Decide: Freigabe oder Ablehnung der eingereichten Revision.
func (s *Service) Decide(ctx context.Context, assetID, actor string, approve bool, note string, expectedRev int64) (Item, error) {
	cfg := s.Cfg()
	var decided *Conform
	it, err := s.St.withItem(ctx, assetID, expectedRev, func(tx *sql.Tx, i *Item) (string, map[string]any, error) {
		if i.State != StateReadyForApproval {
			return "", nil, fmt.Errorf("%w: Zustand %s", ErrState, i.State)
		}
		c, err := scanConform(tx.QueryRowContext(ctx, `SELECT `+conformCols+` FROM conform_revisions WHERE asset_id=$1 AND state='submitted' FOR UPDATE`, assetID))
		if err != nil {
			return "", nil, fmt.Errorf("%w: keine eingereichte Revision", ErrState)
		}
		if i.ApprovalMode == "dual" && c.UpdatedBy == actor && !cfg.AllowSelfApproval {
			return "", nil, fmt.Errorf("%w: Vier-Augen-Prinzip — der Einreicher darf nicht selbst entscheiden", ErrForbidden)
		}
		if !approve && strings.TrimSpace(note) == "" {
			return "", nil, &ValidationError{Problems: []string{"Bei Ablehnung ist eine Begründung erforderlich"}}
		}
		ns := ConformRejected
		if approve {
			ns = ConformApproved
		}
		if _, err := tx.ExecContext(ctx, `UPDATE conform_revisions SET state=$2, decided_by=$3, decision_note=$4 WHERE id=$1`, c.ID, ns, actor, note); err != nil {
			return "", nil, err
		}
		c.State = ns
		decided = &c
		if approve {
			i.State, i.Assignee, i.ClaimedAt = StateApproved, "", nil
			return "approved", map[string]any{"revision": c.Revision, "note": note}, nil
		}
		i.State, i.Assignee, i.ClaimedAt = StateRejected, "", nil
		return "rejected", map[string]any{"revision": c.Revision, "note": note}, nil
	}, actor)
	if err == nil && decided != nil {
		s.audit(actor, assetID, map[bool]string{true: "approved", false: "rejected"}[approve], map[string]any{"note": note})
		if approve {
			segs, _ := s.St.GetConform(ctx, assetID, decided.Revision)
			if segs != nil {
				s.applyApproved(ctx, assetID, segs, actor)
			}
		} else {
			s.syncAssetStatus(assetID, asset.StatusInReview, asset.StatusReady, actor)
		}
	}
	return it, err
}

// applyApproved schreibt die freigegebenen redaktionellen Metadaten in das Asset (einzige Quelle der Wahrheit danach) und führt
// den Asset-Status nach.
func (s *Service) applyApproved(ctx context.Context, assetID string, c *Conform, actor string) {
	for attempt := 0; attempt < 2; attempt++ {
		a, err := s.Assets.GetAsset(assetID)
		if err != nil {
			return
		}
		md := a.Metadata
		md.Editorial = map[string]any{}
		for k, v := range c.AssetMetadata {
			md.Editorial[k] = v
		}
		md.Editorial["conformRevision"] = c.Revision
		if _, err := s.Assets.UpdateAssetMetadata(assetID, a.RowVersion, md, actor); err == nil {
			break
		} else if !errors.Is(err, asset.ErrConcurrentModification) {
			s.log().Warn("review: Metadaten nicht ins Asset übernommen", "asset", assetID, "error", err)
			break
		}
	}
	s.syncAssetStatus(assetID, asset.StatusInReview, asset.StatusApproved, actor)
}

// Withdraw: Einreicher zieht die eingereichte Revision zurück; es entsteht wieder ein Entwurf.
func (s *Service) Withdraw(ctx context.Context, assetID, actor string, expectedRev int64) (Item, error) {
	return s.St.withItem(ctx, assetID, expectedRev, func(tx *sql.Tx, i *Item) (string, map[string]any, error) {
		if i.State != StateReadyForApproval {
			return "", nil, fmt.Errorf("%w: Zustand %s", ErrState, i.State)
		}
		if i.Assignee != actor {
			return "", nil, ErrForbidden
		}
		if _, err := tx.ExecContext(ctx, `UPDATE conform_revisions SET state='withdrawn' WHERE asset_id=$1 AND state='submitted'`, assetID); err != nil {
			return "", nil, err
		}
		if err := ensureDraft(ctx, tx, i, actor); err != nil {
			return "", nil, err
		}
		i.State = StateInReview
		return "withdrawn", nil, nil
	}, actor)
}

// Revise startet eine neue Revision nach Freigabe/Ablehnung (Bearbeiter wird der Aufrufer).
func (s *Service) Revise(ctx context.Context, assetID, actor string, expectedRev int64) (Item, error) {
	it, err := s.St.withItem(ctx, assetID, expectedRev, func(tx *sql.Tx, i *Item) (string, map[string]any, error) {
		if i.State != StateApproved && i.State != StateRejected {
			return "", nil, fmt.Errorf("%w: Zustand %s", ErrState, i.State)
		}
		now := s.now()
		i.Assignee, i.ClaimedAt, i.State = actor, &now, StateInReview
		if err := ensureDraft(ctx, tx, i, actor); err != nil {
			return "", nil, err
		}
		return "revision_started", nil, nil
	}, actor)
	if err == nil {
		s.syncAssetStatus(assetID, asset.StatusApproved, asset.StatusInReview, actor)
	}
	return it, err
}

// Archive / Unarchive.
func (s *Service) Archive(ctx context.Context, assetID, actor string, expectedRev int64) (Item, error) {
	return s.St.withItem(ctx, assetID, expectedRev, func(tx *sql.Tx, i *Item) (string, map[string]any, error) {
		if i.Assignee != "" {
			return "", nil, fmt.Errorf("%w: noch in Bearbeitung durch %s", ErrState, i.Assignee)
		}
		i.State = StateArchived
		return "archived", nil, nil
	}, actor)
}

func (s *Service) Unarchive(ctx context.Context, assetID, actor string, expectedRev int64) (Item, error) {
	return s.St.withItem(ctx, assetID, expectedRev, func(tx *sql.Tx, i *Item) (string, map[string]any, error) {
		if i.State != StateArchived {
			return "", nil, fmt.Errorf("%w: Zustand %s", ErrState, i.State)
		}
		i.State = StateAwaitingReview
		return "unarchived", nil, nil
	}, actor)
}

func jsonMarshal(v any) ([]byte, error) { return json.Marshal(v) }

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }
