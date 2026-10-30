package review

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Review-Proxy (Kapitel 43): Die Originaldatei bleibt unverändert; für die Wiedergabe im Browser entsteht eine eigene Datei
// (H.264, nur Intra-Bilder → exakter Einzelbild-Zugriff in beide Richtungen, AAC-Stereo-Mischung der Tonspuren).
//
// Zeitabbildung: Proxy-Bild n ⇔ Quellbild n (gleiche Bildrate als exakter Bruch, Halbbilder per yadif send_frame zu Vollbildern,
// Beginn bei 0). Der Proxy gilt erst als „verifiziert“, wenn Bildanzahl und Bildrate mit der Zeitachse der Quelle übereinstimmen.
// Der Start-Timecode wird nicht in den Proxy gebrannt, sondern aus der Zeitachse der Quelle berechnet.
// Grenzen: Feldgenauigkeit (Halbbilder) und ein ursprünglicher Versatz zwischen Bild und Ton werden nicht abgebildet.

// ProxyProfile benennt Auflösung/Qualität; Teil des Schlüssels (asset, source_rev, profile).
func (c Config) ProxyProfile() string {
	return fmt.Sprintf("h264-i-%dp-crf%d-v2", c.ProxyHeight, c.ProxyCRF)
}

func (s *Store) getProxy(ctx context.Context, assetID, sourceRev, profile string) (*Proxy, error) {
	var p Proxy
	err := s.db.QueryRowContext(ctx, `SELECT id, asset_id, source_rev, profile, state, progress, path, audio_tracks, audio_path, frames, rate_num, rate_den, width, height, verified, error, created_at FROM review_proxies WHERE asset_id=$1 AND source_rev=$2 AND profile=$3`,
		assetID, sourceRev, profile).Scan(&p.ID, &p.AssetID, &p.SourceRev, &p.Profile, &p.State, &p.Progress, &p.Path, &p.AudioTracks, &p.AudioPath, &p.Frames, &p.Rate.Num, &p.Rate.Den, &p.Width, &p.Height, &p.Verified, &p.Error, &p.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if p.State == "ready" {
		p.Progress = 100 // vor der Fortschrittsanzeige erzeugte Proxys tragen noch 0
	}
	return &p, err
}

// RequestProxy stellt sicher, dass ein Proxy für die aktuelle Quelle existiert oder erzeugt wird (idempotent).
func (s *Service) RequestProxy(ctx context.Context, assetID string, retryFailed bool) (*Proxy, error) {
	it, err := s.St.GetItem(ctx, assetID)
	if err != nil {
		return nil, err
	}
	profile := s.Cfg().ProxyProfile()
	if _, err := s.St.db.ExecContext(ctx, `INSERT INTO review_proxies (id, asset_id, source_rev, profile, state) VALUES ($1,$2,$3,$4,'queued') ON CONFLICT (asset_id, source_rev, profile) DO NOTHING`,
		newID(), assetID, it.SourceRev, profile); err != nil {
		return nil, err
	}
	if retryFailed {
		_, _ = s.St.db.ExecContext(ctx, `UPDATE review_proxies SET state='queued', error='', attempts=0 WHERE asset_id=$1 AND source_rev=$2 AND profile=$3 AND state='failed'`, assetID, it.SourceRev, profile)
	}
	return s.St.getProxy(ctx, assetID, it.SourceRev, profile)
}

// CurrentProxy: Proxy der aktuellen Quellversion (nil, wenn noch keiner angefordert wurde).
func (s *Service) CurrentProxy(ctx context.Context, assetID string) (*Proxy, error) {
	it, err := s.St.GetItem(ctx, assetID)
	if err != nil {
		return nil, err
	}
	return s.St.getProxy(ctx, assetID, it.SourceRev, s.Cfg().ProxyProfile())
}

// ProxyFile: Pfad der fertigen, verifizierten Proxy-Datei der aktuellen Quelle.
func (s *Service) ProxyFile(ctx context.Context, assetID string) (string, *Proxy, error) {
	p, err := s.CurrentProxy(ctx, assetID)
	if err != nil {
		return "", nil, err
	}
	if p == nil || p.State != "ready" || !p.Verified || p.Path == "" {
		return "", p, ErrNotFound
	}
	if _, err := os.Stat(p.Path); err != nil {
		return "", p, ErrNotFound
	}
	return p.Path, p, nil
}

// RunNextProxy erzeugt einen wartenden Proxy. ran=false, wenn keiner wartete.
func (s *Service) RunNextProxy(ctx context.Context) (bool, error) {
	var p Proxy
	err := s.St.db.QueryRowContext(ctx, `UPDATE review_proxies SET state='running', attempts=attempts+1, heartbeat_at=now(), error='', progress=0
		WHERE id = (SELECT id FROM review_proxies WHERE state='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
		RETURNING id, asset_id, source_rev, profile`).Scan(&p.ID, &p.AssetID, &p.SourceRev, &p.Profile)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := s.buildProxy(ctx, p); err != nil {
		if errors.Is(err, context.Canceled) {
			_, _ = s.St.db.ExecContext(context.Background(), `UPDATE review_proxies SET state='queued' WHERE id=$1`, p.ID)
			return true, nil
		}
		_, _ = s.St.db.ExecContext(ctx, `UPDATE review_proxies SET state='failed', error=$2 WHERE id=$1`, p.ID, err.Error())
		s.log().Warn("Review-Proxy fehlgeschlagen", "asset", p.AssetID, "error", err)
	}
	return true, nil
}

func (s *Service) buildProxy(ctx context.Context, p Proxy) error {
	it, err := s.St.GetItem(ctx, p.AssetID)
	if err != nil {
		return err
	}
	if it.SourceRev != p.SourceRev {
		return fmt.Errorf("Quelle hat sich geändert, Proxy veraltet")
	}
	if it.Timeline == nil {
		return fmt.Errorf("Zeitachse der Quelle unbekannt")
	}
	src, err := s.sourcePath(it)
	if err != nil {
		return err
	}
	cfg := s.Cfg()
	if err := s.Tools.Discover(ctx); err != nil {
		return err
	}
	// Streams der Quelle: Halbbild-Reihenfolge und Anzahl Tonspuren
	var video map[string]any
	nAudio := 0
	if out, code, e := s.Tools.ExecProxy().Run(ctx, s.Tools.FFprobe, []string{"-v", "error", "-show_streams", "-of", "json", src}, nil); e == nil && code == 0 {
		var pr struct {
			Streams []map[string]any `json:"streams"`
		}
		if jsonUnmarshal(out, &pr) == nil {
			for _, st := range pr.Streams {
				switch gs(st, "codec_type") {
				case "video":
					if video == nil {
						video = st
					}
				case "audio":
					nAudio++
				}
			}
		}
	}
	if video == nil {
		return fmt.Errorf("kein Videostream")
	}
	if nAudio > cfg.ProxyMaxAudio {
		nAudio = cfg.ProxyMaxAudio
	}
	dir := filepath.Join(s.DataDir, "proxies", p.AssetID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	final := filepath.Join(dir, p.ID+".mp4")
	tmp := filepath.Join(dir, p.ID+".part.mp4")
	defer os.Remove(tmp)

	rate := it.Timeline.Rate
	vf := []string{"setpts=PTS-STARTPTS"}
	switch gs(video, "field_order") {
	case "tt", "tb":
		vf = append([]string{"yadif=mode=0:parity=tff"}, vf...)
	case "bb", "bt":
		vf = append([]string{"yadif=mode=0:parity=bff"}, vf...)
	}
	vf = append(vf, fmt.Sprintf("scale=-2:%d", cfg.ProxyHeight), fmt.Sprintf("fps=%d/%d", rate.Num, rate.Den), "format=yuv420p")
	graph := "[0:v:0]" + strings.Join(vf, ",") + "[v]"
	// `-progress pipe:2` liefert Schlüssel=Wert-Zeilen (frame=…) auf stderr: daraus der Fortschrittsbalken der Oberfläche.
	args := []string{"-nostdin", "-v", "error", "-nostats", "-progress", "pipe:2", "-y", "-i", src, "-filter_complex", graph, "-map", "[v]", "-an",
		"-c:v", "libx264", "-preset", "veryfast", "-crf", strconv.Itoa(cfg.ProxyCRF), "-g", "1", "-bf", "0", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", tmp}
	// Zweite Ausgabe: Ton-Proxy mit einem Stereo-Stream je Quell-Tonspur, auf die Länge des Bildes aufgefüllt/gekürzt (Bild n ⇔
	// Ton ab n/Rate). Der Browser mischt/wählt die Spuren selbst (Spurwahl, Scrub-Ton bei Jog/Shuttle).
	audioFinal := filepath.Join(dir, p.ID+".audio.mp4")
	audioTmp := filepath.Join(dir, p.ID+".audio.part.mp4")
	defer os.Remove(audioTmp)
	if nAudio > 0 {
		dur := float64(it.Timeline.DurationFrames) * float64(rate.Den) / float64(rate.Num)
		args = append(args, "-vn")
		for i := 0; i < nAudio; i++ {
			args = append(args, "-map", fmt.Sprintf("0:a:%d", i))
		}
		args = append(args, "-af", "aresample=async=1:first_pts=0,apad", "-t", strconv.FormatFloat(dur, 'f', 6, 64),
			"-c:a", "aac", "-b:a", "96k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", "-f", "mp4", audioTmp)
	}
	var errLines []string
	var lastPct int
	var lastWrite time.Time
	_, code, err := s.Tools.ExecProxy().Run(ctx, s.Tools.FFmpeg, args, func(l string) {
		pct, isProgress := parseProgress(l, it.Timeline.DurationFrames)
		if isProgress {
			// höchstens einmal pro Sekunde in die Datenbank; das Lebenszeichen (heartbeat) läuft dabei mit
			if pct >= 0 && pct != lastPct && time.Since(lastWrite) >= time.Second {
				lastPct, lastWrite = pct, time.Now()
				_, _ = s.St.db.ExecContext(ctx, `UPDATE review_proxies SET progress=$2, heartbeat_at=now() WHERE id=$1`, p.ID, pct)
			}
			return
		}
		if len(errLines) < 10 {
			errLines = append(errLines, l)
		}
	})
	if err != nil {
		return err
	}
	if code != 0 {
		return fmt.Errorf("ffmpeg Exit %d: %s", code, strings.Join(errLines, " | "))
	}
	// Verifikation der Zeitabbildung
	frames, prate, w, h, start, verr := probeProxy(ctx, s.Tools, tmp)
	if verr != nil {
		return verr
	}
	if frames != it.Timeline.DurationFrames || prate != rate || math.Abs(start) > 0.001 {
		return fmt.Errorf("Zeitabbildung nicht verifiziert: Proxy %d Bilder @ %d/%d (Start %.3f s), Quelle %d Bilder @ %d/%d", frames, prate.Num, prate.Den, start, it.Timeline.DurationFrames, rate.Num, rate.Den)
	}
	if err := os.Rename(tmp, final); err != nil {
		return err
	}
	audioPath := ""
	if nAudio > 0 {
		if err := os.Rename(audioTmp, audioFinal); err != nil {
			return err
		}
		audioPath = audioFinal
	}
	_, err = s.St.db.ExecContext(ctx, `UPDATE review_proxies SET state='ready', progress=100, path=$2, frames=$3, rate_num=$4, rate_den=$5, width=$6, height=$7, verified=true, error='', audio_tracks=$8, audio_path=$9 WHERE id=$1`,
		p.ID, final, frames, prate.Num, prate.Den, w, h, nAudio, audioPath)
	if err == nil {
		s.audit("system", p.AssetID, "proxy_ready", map[string]any{"frames": frames})
		s.pruneProxies(ctx, p.AssetID, p.ID)
	}
	return err
}

// parseProgress deutet eine Zeile der ffmpeg-Ausgabe `-progress`: isProgress=true für jede Schlüssel=Wert-Zeile dieses
// Blocks (sie gehört nicht in die Fehlerzeilen); pct ≥ 0 nur bei `frame=`, gedeckelt auf 99 — 100 setzt erst die
// Verifikation der fertigen Datei.
func parseProgress(line string, totalFrames int64) (pct int, isProgress bool) {
	k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
	if !ok {
		return -1, false
	}
	switch k {
	case "frame":
		n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
		if err != nil || totalFrames <= 0 {
			return -1, true
		}
		p := int(n * 100 / totalFrames)
		if p < 0 {
			p = 0
		}
		if p > 99 {
			p = 99
		}
		return p, true
	case "fps", "stream_0_0_q", "stream_1_0_q", "bitrate", "total_size", "out_time_us", "out_time_ms", "out_time",
		"dup_frames", "drop_frames", "speed", "progress":
		return -1, true
	}
	return -1, false
}

func probeProxy(ctx context.Context, t *Tools, file string) (frames int64, rate Rate, w, h int, start float64, err error) {
	out, code, e := t.ExecProxy().Run(ctx, t.FFprobe, []string{"-v", "error", "-count_packets", "-select_streams", "v:0", "-show_streams", "-of", "json", file}, nil)
	if e != nil || code != 0 {
		return 0, Rate{}, 0, 0, 0, fmt.Errorf("Proxy nicht lesbar")
	}
	var pr struct {
		Streams []map[string]any `json:"streams"`
	}
	if jsonUnmarshal(out, &pr) != nil || len(pr.Streams) == 0 {
		return 0, Rate{}, 0, 0, 0, fmt.Errorf("Proxy ohne Videostream")
	}
	st := pr.Streams[0]
	rate, _ = parseFPS(gs(st, "r_frame_rate"))
	start = gn(st, "start_time")
	if math.IsNaN(start) {
		start = 0
	}
	return int64(gn(st, "nb_read_packets")), rate, int(gn(st, "width")), int(gn(st, "height")), start, nil
}

// pruneProxies löscht Proxy-Dateien/-Zeilen früherer Quellversionen (nur der jüngste bleibt).
func (s *Service) pruneProxies(ctx context.Context, assetID, keepID string) {
	rows, err := s.St.db.QueryContext(ctx, `DELETE FROM review_proxies WHERE asset_id=$1 AND id<>$2 AND state IN ('ready','failed') RETURNING path, audio_path`, assetID, keepID)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var p, ap string
		if rows.Scan(&p, &ap) == nil {
			for _, f := range []string{p, ap} {
				if f != "" {
					_ = os.Remove(f)
				}
			}
		}
	}
}

// CleanupProxies räumt liegengebliebene Teildateien (Absturz mitten im Schreiben) und verwaiste „running“-Zeilen auf.
func (s *Service) CleanupProxies(ctx context.Context) {
	_, _ = s.St.db.ExecContext(ctx, `UPDATE review_proxies SET state='queued' WHERE state='running' AND heartbeat_at < now() - interval '2 minutes' AND attempts < 3`)
	_, _ = s.St.db.ExecContext(ctx, `UPDATE review_proxies SET state='failed', error='Abgebrochen (mehrfach ohne Lebenszeichen)' WHERE state='running' AND heartbeat_at < now() - interval '2 minutes'`)
	root := filepath.Join(s.DataDir, "proxies")
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.HasSuffix(path, ".part.mp4") {
			if st, e := d.Info(); e == nil && time.Since(st.ModTime()) > time.Hour {
				_ = os.Remove(path)
			}
		}
		return nil
	})
}

// Frame liefert Bild n des Proxys als JPEG (Einzelbild-Zugriff für Jog/Shuttle-Rückfall und Prüfungen).
func (s *Service) Frame(ctx context.Context, assetID string, n int64) ([]byte, error) {
	file, p, err := s.ProxyFile(ctx, assetID)
	if err != nil {
		return nil, err
	}
	if n < 0 || n >= p.Frames {
		return nil, fmt.Errorf("%w: Bild %d außerhalb [0,%d)", ErrValidation, n, p.Frames)
	}
	// ffmpeg liefert nach einem genauen Seek das ERSTE Bild mit pts ≥ ts. Ein Viertelbild VOR dem Beginn von Bild n trifft also
	// Bild n, auch wenn die Dezimaldarstellung rundet (Bild n−1 liegt ein ganzes Bild früher und wird verworfen).
	ts := (float64(n) - 0.25) * float64(p.Rate.Den) / float64(p.Rate.Num)
	if ts < 0 {
		ts = 0
	}
	var buf bytes.Buffer
	_ = buf
	out, code, err := s.Tools.ExecProxy().Run(ctx, s.Tools.FFmpeg, []string{"-nostdin", "-v", "error", "-ss", strconv.FormatFloat(ts, 'f', 6, 64), "-i", file, "-frames:v", "1", "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "3", "-"}, nil)
	if err != nil {
		return nil, err
	}
	if code != 0 || len(out) == 0 {
		return nil, fmt.Errorf("Bild nicht lesbar")
	}
	return out, nil
}
