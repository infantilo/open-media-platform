package review

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/subtitlegen"
)

// Untertitel (SRT) aus der Datei erzeugen — mit Sprechererkennung. Die Rechenarbeit macht ein Auto-Untertitel-Node
// (Methode file.transcribe, s. internal/subtitlegen); hier stehen Auftrag, Fortschritt und die Ablage des Ergebnisses:
//   - `<DataDir>/subtitles/<Asset>/<Name>.srt` (Download, gehört zum Asset),
//   - Kopie in `SubtitleDir` (Standard data/subtitles) — daraus spielt das Kind-Event SUBTITLE der Playout-Automation die Spur ab,
//   - eine Darstellung vom Typ „subtitle“ an der Asset-Version (soweit die Version noch Entwurf ist).

// SubtitleParams: Wahl des Bedieners.
type SubtitleParams struct {
	Track    int      `json:"track"`
	Language string   `json:"language"`
	Speakers int      `json:"speakers"` // 1 = ohne Namen, 0 = automatisch, ≥ 2 = feste Anzahl
	Names    []string `json:"names,omitempty"`
	Word     string   `json:"word,omitempty"`
	Style    string   `json:"style,omitempty"` // colon | bracket | dash
}

// SubtitleJob ist ein Auftrag mit Zustand: running | done | failed | canceled.
type SubtitleJob struct {
	ID            string         `json:"id"`
	AssetID       string         `json:"assetId"`
	Name          string         `json:"name"`
	State         string         `json:"state"`
	Progress      int            `json:"progress"`
	Message       string         `json:"message,omitempty"`
	Phase         string         `json:"phase,omitempty"`
	Params        SubtitleParams `json:"params"`
	NodeLabel     string         `json:"nodeLabel,omitempty"`
	SpeakersFound int            `json:"speakersFound"`
	Cues          int            `json:"cues"`
	DurationS     float64        `json:"durationS"`
	Downloadable  bool           `json:"downloadable"`
	// PlayoutTrack: Name der Spur für das Kind-Event SUBTITLE (leer, wenn keine Kopie angelegt werden konnte).
	PlayoutTrack string     `json:"playoutTrack,omitempty"`
	RepID        string     `json:"representationId,omitempty"`
	CreatedBy    string     `json:"createdBy"`
	CreatedAt    time.Time  `json:"createdAt"`
	FinishedAt   *time.Time `json:"finishedAt,omitempty"`

	path        string
	playoutPath string
	nodeBase    string
	nodeID      string
}

const subCols = `id, asset_id, name, state, progress, message, params, node_id, node_base, node_label, speakers_found, cues, duration_s, path, playout_path, rep_id, created_by, created_at, finished_at`

func scanSubtitle(r interface{ Scan(...any) error }) (SubtitleJob, error) {
	var j SubtitleJob
	var params []byte
	var fin sql.NullTime
	err := r.Scan(&j.ID, &j.AssetID, &j.Name, &j.State, &j.Progress, &j.Message, &params, &j.nodeID, &j.nodeBase, &j.NodeLabel, &j.SpeakersFound, &j.Cues, &j.DurationS, &j.path, &j.playoutPath, &j.RepID, &j.CreatedBy, &j.CreatedAt, &fin)
	if err != nil {
		return j, err
	}
	_ = json.Unmarshal(params, &j.Params)
	if fin.Valid {
		t := fin.Time
		j.FinishedAt = &t
	}
	j.Downloadable = j.State == "done" && j.path != ""
	if j.playoutPath != "" {
		j.PlayoutTrack = strings.TrimSuffix(filepath.Base(j.playoutPath), ".srt")
	}
	return j, nil
}

func (s *Store) getSubtitle(ctx context.Context, id string) (SubtitleJob, error) {
	j, err := scanSubtitle(s.db.QueryRowContext(ctx, `SELECT `+subCols+` FROM review_subtitles WHERE id=$1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return j, ErrNotFound
	}
	return j, err
}

func (s *Store) listSubtitles(ctx context.Context, assetID string) ([]SubtitleJob, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+subCols+` FROM review_subtitles WHERE asset_id=$1 ORDER BY created_at DESC`, assetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SubtitleJob{}
	for rows.Next() {
		j, err := scanSubtitle(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

func (s *Store) runningSubtitles(ctx context.Context) ([]SubtitleJob, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+subCols+` FROM review_subtitles WHERE state='running' ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SubtitleJob
	for rows.Next() {
		j, err := scanSubtitle(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

// ValidateSubtitleParams prüft die Wahl und füllt Standardwerte.
func ValidateSubtitleParams(p SubtitleParams) (SubtitleParams, error) {
	if p.Track < 0 || p.Track > 63 {
		return p, fmt.Errorf("%w: Tonspur 0 bis 63", ErrValidation)
	}
	if p.Speakers < 0 || p.Speakers > 12 {
		return p, fmt.Errorf("%w: Sprecheranzahl 0 (automatisch) bis 12", ErrValidation)
	}
	p.Language = strings.TrimSpace(p.Language)
	if p.Language == "" {
		p.Language = "de"
	}
	if len(p.Language) > 12 {
		return p, fmt.Errorf("%w: Sprache als Kürzel („de“, „en“, „auto“)", ErrValidation)
	}
	switch p.Style {
	case "":
		p.Style = "colon"
	case "colon", "bracket", "dash":
	default:
		return p, fmt.Errorf("%w: Schreibweise der Sprecher: colon, bracket oder dash", ErrValidation)
	}
	var names []string
	for _, n := range p.Names {
		if n = strings.TrimSpace(n); n != "" {
			if len([]rune(n)) > 40 {
				return p, fmt.Errorf("%w: Sprechername höchstens 40 Zeichen", ErrValidation)
			}
			names = append(names, n)
		}
	}
	p.Names = names
	if p.Speakers == 1 {
		p.Names = nil // ohne Namen
	}
	p.Word = strings.TrimSpace(p.Word)
	if len([]rune(p.Word)) > 20 {
		return p, fmt.Errorf("%w: Wort vor der Nummer höchstens 20 Zeichen", ErrValidation)
	}
	return p, nil
}

// StartSubtitles reicht einen Untertitel-Auftrag für das Asset ein.
func (s *Service) StartSubtitles(ctx context.Context, assetID, actor, name string, p SubtitleParams) (SubtitleJob, error) {
	if s.SubNodes == nil {
		return SubtitleJob{}, fmt.Errorf("%w: Untertitel-Erzeugung ist hier nicht eingerichtet", ErrValidation)
	}
	p, err := ValidateSubtitleParams(p)
	if err != nil {
		return SubtitleJob{}, err
	}
	it, err := s.St.GetItem(ctx, assetID)
	if err != nil {
		return SubtitleJob{}, err
	}
	src, err := s.sourcePath(it)
	if err != nil {
		return SubtitleJob{}, fmt.Errorf("%w: Quelldatei nicht lesbar: %v", ErrValidation, err)
	}
	cl := &subtitlegen.Client{}
	target, err := cl.Pick(ctx, s.SubNodes(), p.Speakers)
	if err != nil {
		return SubtitleJob{}, fmt.Errorf("%w: %v", ErrValidation, err)
	}
	if name = subtitlegen.Slug(name); name == "" {
		name = subtitlegen.Slug(strings.TrimSuffix(it.FileName, filepath.Ext(it.FileName)))
		if name == "" {
			name = "untertitel"
		}
		if p.Language != "auto" {
			name += "-" + subtitlegen.Slug(p.Language)
		}
	}
	id := newID()
	req := subtitlegen.Request{ID: id, File: src, Track: p.Track, Language: p.Language, Speakers: p.Speakers, Names: p.Names, Word: p.Word, Style: p.Style, Name: name}
	if err := cl.Submit(ctx, target, req); err != nil {
		return SubtitleJob{}, fmt.Errorf("%w: %v", ErrValidation, err)
	}
	raw, _ := json.Marshal(p)
	if _, err := s.St.db.ExecContext(ctx, `INSERT INTO review_subtitles (id, asset_id, source_rev, name, state, params, node_id, node_base, node_label, created_by) VALUES ($1,$2,$3,$4,'running',$5,$6,$7,$8,$9)`,
		id, assetID, it.SourceRev, name, raw, target.NodeID, target.BaseURL, target.Label, actor); err != nil {
		cl.Cancel(ctx, target, id, false)
		return SubtitleJob{}, err
	}
	s.audit(actor, assetID, "subtitles_started", map[string]any{"job": id, "language": p.Language, "speakers": p.Speakers, "track": p.Track})
	return s.St.getSubtitle(ctx, id)
}

// PollSubtitles gleicht laufende Aufträge mit dem Node ab (Fortschritt, Ergebnis ablegen, Fehler). Aufrufe sind nebenläufig sicher.
func (s *Service) PollSubtitles(ctx context.Context) {
	jobs, err := s.St.runningSubtitles(ctx)
	if err != nil || len(jobs) == 0 {
		return
	}
	cl := &subtitlegen.Client{}
	for _, j := range jobs {
		if ctx.Err() != nil {
			return
		}
		t := subtitlegen.Target{NodeID: j.nodeID, BaseURL: j.nodeBase, Label: j.NodeLabel}
		st, err := cl.Status(ctx, t, j.ID)
		switch {
		case errors.Is(err, subtitlegen.ErrJobLost):
			s.failSubtitle(ctx, j, err.Error())
			continue
		case err != nil:
			// Node kurz nicht erreichbar: Auftrag bleibt „läuft“; nach 5 Minuten ohne Lebenszeichen gilt er als verloren
			if time.Since(j.CreatedAt) > 5*time.Minute && time.Since(s.lastSubtitleSeen(ctx, j.ID)) > 5*time.Minute {
				s.failSubtitle(ctx, j, err.Error())
			}
			continue
		}
		switch st.State {
		case "done":
			srt, err := cl.Result(ctx, t, j.ID)
			if err != nil {
				s.failSubtitle(ctx, j, err.Error())
				continue
			}
			if err := s.storeSubtitle(ctx, j, st, srt); err != nil {
				s.failSubtitle(ctx, j, "Ergebnis nicht ablegbar: "+err.Error())
				continue
			}
			cl.Cancel(ctx, t, j.ID, true) // aus der Liste des Nodes nehmen
		case "failed":
			s.failSubtitle(ctx, j, st.Message)
		case "canceled":
			_, _ = s.St.db.ExecContext(ctx, `UPDATE review_subtitles SET state='canceled', message='Abgebrochen', finished_at=now(), updated_at=now() WHERE id=$1`, j.ID)
		default:
			_, _ = s.St.db.ExecContext(ctx, `UPDATE review_subtitles SET progress=$2, message=$3, speakers_found=$4, duration_s=$5, updated_at=now() WHERE id=$1`, j.ID, st.Progress, st.State, st.SpeakersFound, st.DurationS)
		}
	}
}

func (s *Service) lastSubtitleSeen(ctx context.Context, id string) time.Time {
	var t time.Time
	if s.St.db.QueryRowContext(ctx, `SELECT updated_at FROM review_subtitles WHERE id=$1`, id).Scan(&t) != nil {
		return time.Time{}
	}
	return t
}

func (s *Service) failSubtitle(ctx context.Context, j SubtitleJob, msg string) {
	if msg == "" {
		msg = "fehlgeschlagen"
	}
	_, _ = s.St.db.ExecContext(ctx, `UPDATE review_subtitles SET state='failed', message=$2, finished_at=now(), updated_at=now() WHERE id=$1`, j.ID, msg)
	s.audit("system", j.AssetID, "subtitles_failed", map[string]any{"job": j.ID, "error": msg})
}

// storeSubtitle legt das Ergebnis ab (Datei, Kopie fürs Playout, neue Asset-Version, s. subtitlegen.Place).
func (s *Service) storeSubtitle(ctx context.Context, j SubtitleJob, st subtitlegen.Job, srt string) error {
	it, err := s.St.GetItem(ctx, j.AssetID)
	if err != nil {
		return err
	}
	pl, err := subtitlegen.Place(s.Assets, it.AssetID, j.Name, srt, filepath.Join(s.DataDir, "subtitles", j.AssetID), strings.TrimSpace(s.Cfg().SubtitleDir))
	if err != nil {
		return err
	}
	_, err = s.St.db.ExecContext(ctx, `UPDATE review_subtitles SET state='done', progress=100, name=$2, message=$3, speakers_found=$4, cues=$5, duration_s=$6, path=$7, playout_path=$8, rep_id=$9, finished_at=now(), updated_at=now() WHERE id=$1`,
		j.ID, pl.Name, pl.Warning, st.SpeakersFound, st.Cues, st.DurationS, pl.Path, pl.PlayoutPath, pl.RepID)
	if err == nil {
		s.audit("system", j.AssetID, "subtitles_ready", map[string]any{"job": j.ID, "name": pl.Name, "cues": st.Cues, "speakers": st.SpeakersFound})
	}
	return err
}

// CancelSubtitle bricht einen laufenden Auftrag ab.
func (s *Service) CancelSubtitle(ctx context.Context, id, actor string) error {
	j, err := s.St.getSubtitle(ctx, id)
	if err != nil {
		return err
	}
	if j.State != "running" {
		return fmt.Errorf("%w: der Auftrag läuft nicht mehr", ErrState)
	}
	(&subtitlegen.Client{}).Cancel(ctx, subtitlegen.Target{BaseURL: j.nodeBase, Label: j.NodeLabel}, id, false)
	_, err = s.St.db.ExecContext(ctx, `UPDATE review_subtitles SET state='canceled', message='Abgebrochen', finished_at=now(), updated_at=now() WHERE id=$1 AND state='running'`, id)
	s.audit(actor, j.AssetID, "subtitles_canceled", map[string]any{"job": id})
	return err
}

// DeleteSubtitle entfernt einen beendeten Auftrag und die Playout-Kopie. Die Datei im Asset-Ordner und die Darstellung bleiben als Teil des
// Versionsverlaufs bestehen (veröffentlichte Versionen sind unveränderlich) — nur ein fehlgeschlagener Auftrag hat nichts davon.
func (s *Service) DeleteSubtitle(ctx context.Context, id, actor string) error {
	j, err := s.St.getSubtitle(ctx, id)
	if err != nil {
		return err
	}
	if j.State == "running" {
		return fmt.Errorf("%w: erst abbrechen", ErrState)
	}
	if j.playoutPath != "" {
		_ = os.Remove(j.playoutPath)
	}
	if j.RepID == "" && j.path != "" {
		_ = os.Remove(j.path) // keine Darstellung verweist darauf
	}
	_, err = s.St.db.ExecContext(ctx, `DELETE FROM review_subtitles WHERE id=$1`, id)
	s.audit(actor, j.AssetID, "subtitles_deleted", map[string]any{"job": id, "name": j.Name})
	return err
}

// SubtitleFile liefert Pfad und Dateiname der fertigen SRT.
func (s *Service) SubtitleFile(ctx context.Context, id string) (string, string, error) {
	j, err := s.St.getSubtitle(ctx, id)
	if err != nil {
		return "", "", err
	}
	if !j.Downloadable {
		return "", "", ErrNotFound
	}
	if _, err := os.Stat(j.path); err != nil {
		return "", "", ErrNotFound
	}
	return j.path, j.Name + ".srt", nil
}
