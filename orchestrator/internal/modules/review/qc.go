package review

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

// QCOutput ist das Ergebnis einer Analyse (noch nicht gespeichert).
type QCOutput struct {
	Overall  string
	Findings []Finding
	Streams  json.RawMessage
	Timeline *Timeline
	Tools    map[string]string
	Profile  QCProfile
	Counts   map[string]int
}

type qcCtx struct {
	t        *Tools
	prof     QCProfile
	at       time.Time
	findings []Finding
}

func (q *qcCtx) add(f Finding) {
	if f.Tool == "" {
		f.Tool = "ffprobe"
	}
	if f.ToolVer == "" {
		f.ToolVer = q.t.Version(f.Tool)
	}
	f.AnalyzedAt = q.at
	f.Ruleset = q.prof.Ruleset()
	q.findings = append(q.findings, f)
}

func ptr[T any](v T) *T { return &v }

// notEvaluated: Prüfung konnte nicht ausgewertet werden. incomplete=true zählt für den Gesamtstatus (die Analyse ist
// dann unvollständig), false heißt „by design nicht gefordert / nicht verfügbar“.
func (q *qcCtx) notEvaluated(id, cat, why string, incomplete bool, tool string) {
	q.add(Finding{CheckID: id, Category: cat, Status: CheckNotEvaluated, Severity: SevInfo, Message: why, Tool: tool,
		Measured: map[string]any{"incomplete": incomplete}})
}

func gs(m map[string]any, k string) string {
	switch v := m[k].(type) {
	case string:
		return v
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	}
	return ""
}

func gn(m map[string]any, k string) float64 {
	switch v := m[k].(type) {
	case float64:
		return v
	case string:
		f, err := strconv.ParseFloat(v, 64)
		if err != nil {
			return math.NaN()
		}
		return f
	}
	return math.NaN()
}

func tagsOf(m map[string]any) map[string]any {
	t, _ := m["tags"].(map[string]any)
	return t
}

func parseFPS(s string) (Rate, bool) {
	r, err := ParseRate(s)
	return r, err == nil
}

// RunQC analysiert eine Datei. Rückgabe-Fehler (*ExecError / ctx) = Analyse nicht ausführbar; Mängel der Medien sind
// Befunde im Ergebnis. progress darf nil sein.
func (t *Tools) RunQC(ctx context.Context, file string, prof QCProfile, progress func(phase string, pct int)) (*QCOutput, error) {
	if progress == nil {
		progress = func(string, int) {}
	}
	if err := t.Discover(ctx); err != nil {
		return nil, err
	}
	if prof.TimeoutSec > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(prof.TimeoutSec)*time.Second)
		defer cancel()
	}
	q := &qcCtx{t: t, prof: prof, at: time.Now().UTC()}
	out := &QCOutput{Profile: prof, Tools: map[string]string{"ffmpeg": t.Version("ffmpeg"), "ffprobe": t.Version("ffprobe")}}

	// ---- 1. Probe ----
	progress("probe", 2)
	stdout, code, err := t.R.Run(ctx, t.FFprobe, []string{"-v", "error", "-count_packets", "-show_format", "-show_streams", "-show_error", "-of", "json", file}, nil)
	if err != nil {
		return nil, qcExec("probe", err)
	}
	var probe struct {
		Streams []map[string]any `json:"streams"`
		Format  map[string]any   `json:"format"`
		Error   map[string]any   `json:"error"`
	}
	jerr := json.Unmarshal(stdout, &probe)
	if code != 0 || jerr != nil || probe.Error != nil || len(probe.Streams) == 0 {
		msg := "ffprobe konnte die Datei nicht lesen"
		if probe.Error != nil {
			msg = gs(probe.Error, "string")
		}
		q.add(Finding{CheckID: "container.readable", Category: CatContainer, Status: CheckFail, Severity: SevCritical,
			Message: "Datei nicht lesbar oder ohne Streams: " + msg, Measured: map[string]any{"ffprobeExit": code}})
		q.notEvaluated("analysis.content", CatContent, "Inhaltsprüfungen übersprungen, weil die Datei nicht lesbar ist", false, "ffmpeg")
		return q.finish(out), nil
	}
	out.Streams, _ = json.Marshal(map[string]any{"format": probe.Format, "streams": probe.Streams})

	var video map[string]any
	var audios, others []map[string]any
	nVideo := 0
	for _, s := range probe.Streams {
		switch gs(s, "codec_type") {
		case "video":
			if gs(s, "disposition") == "" {
				// attached_pic (Cover-Bild) zählt nicht als Video
				if d, ok := s["disposition"].(map[string]any); ok && gn(d, "attached_pic") == 1 {
					continue
				}
			}
			nVideo++
			if video == nil {
				video = s
			}
		case "audio":
			audios = append(audios, s)
		default:
			others = append(others, s)
		}
	}
	q.add(Finding{CheckID: "container.readable", Category: CatContainer, Status: CheckPass, Severity: SevInfo,
		Message:  "Datei lesbar, Streams: " + strconv.Itoa(len(probe.Streams)),
		Measured: map[string]any{"streams": len(probe.Streams), "probeScore": gn(probe.Format, "probe_score")}})
	fmtName := gs(probe.Format, "format_name")
	q.add(Finding{CheckID: "container.format", Category: CatContainer, Status: CheckPass, Severity: SevInfo,
		Message:  fmt.Sprintf("Container %s", gs(probe.Format, "format_long_name")),
		Measured: map[string]any{"formatName": fmtName, "duration": gn(probe.Format, "duration"), "sizeBytes": gn(probe.Format, "size"), "bitRate": gn(probe.Format, "bit_rate")}})
	ftags := tagsOf(probe.Format)
	if strings.Contains(fmtName, "mxf") {
		q.add(Finding{CheckID: "container.mxf", Category: CatContainer, Status: CheckPass, Severity: SevInfo,
			Message:  "MXF gelesen (nur ffprobe-Parser; keine Strukturvalidierung nach SMPTE ST 377 — dafür fehlt hier ein Spezialwerkzeug)",
			Measured: map[string]any{"operationalPattern": gs(ftags, "operational_pattern_ul"), "company": gs(ftags, "company_name"), "product": gs(ftags, "product_name"), "version": gs(ftags, "product_version")}})
	}
	if e := prof.Expect.Container; e != "" {
		st, sev, msg := CheckPass, SevInfo, "Container entspricht dem Profil"
		if !strings.Contains(fmtName, e) {
			st, sev, msg = CheckFail, SevMajor, fmt.Sprintf("Container %q, erwartet %q", fmtName, e)
		}
		q.add(Finding{CheckID: "delivery.container", Category: CatDelivery, Status: st, Severity: sev, Message: msg, Measured: map[string]any{"formatName": fmtName}, Threshold: map[string]any{"expected": e}})
	}

	// ---- Zeitachse ----
	var tl *Timeline
	vStart := 0.0
	if video != nil {
		vStart = gn(video, "start_time")
		if math.IsNaN(vStart) {
			vStart = 0
		}
		var tcs string
		var tcErr error
		tl, tcs, tcErr = timelineFromProbe(video, probe.Format)
		if tl != nil {
			switch {
			case tcs == "":
				q.add(Finding{CheckID: "container.timecode", Category: CatContainer, Status: CheckWarning, Severity: SevMinor,
					Message: "Kein Start-Timecode in der Datei; 00:00:00:00 angenommen"})
			case tcErr != nil:
				q.add(Finding{CheckID: "container.timecode", Category: CatContainer, Status: CheckWarning, Severity: SevMinor,
					Message: "Start-Timecode nicht auswertbar: " + tcs, Measured: map[string]any{"startTimecode": tcs}})
			default:
				q.add(Finding{CheckID: "container.timecode", Category: CatContainer, Status: CheckPass, Severity: SevInfo,
					Message: "Start-Timecode " + tcs, Measured: map[string]any{"startTimecode": tcs, "dropFrame": tl.DropFrame}})
			}
			if tl.VFR {
				q.add(Finding{CheckID: "video.vfr", Category: CatVideo, Status: CheckWarning, Severity: SevMajor,
					Message:  "Variable Bildrate: Frame-Positionen beziehen sich auf den CFR-Review-Proxy und sind nur näherungsweise",
					Measured: map[string]any{"rFrameRate": gs(video, "r_frame_rate"), "avgFrameRate": gs(video, "avg_frame_rate")}})
			}
			dur := gn(video, "duration")
			if math.IsNaN(dur) {
				dur = gn(probe.Format, "duration")
			}
			expect := int64(math.Round(dur * tl.Rate.Float()))
			frames := tl.DurationFrames
			st, sev, msg := CheckPass, SevInfo, fmt.Sprintf("%d Bilder (%s)", frames, gs(video, "r_frame_rate"))
			if math.Abs(float64(frames-expect)) > 1 {
				st, sev, msg = CheckWarning, SevMinor, fmt.Sprintf("Bildanzahl %d weicht von Dauer×Bildrate (%d) ab", frames, expect)
			}
			q.add(Finding{CheckID: "video.frame_count", Category: CatVideo, Status: st, Severity: sev, Message: msg,
				Measured: map[string]any{"frames": frames, "expected": expect}})
		}
		w, h := gn(video, "width"), gn(video, "height")
		pix := gs(video, "pix_fmt")
		depth := bitDepth(pix, gn(video, "bits_per_raw_sample"))
		fo := gs(video, "field_order")
		q.add(Finding{CheckID: "video.format", Category: CatVideo, Status: CheckPass, Severity: SevInfo,
			Message: fmt.Sprintf("%s %.0f×%.0f %s %s", gs(video, "codec_name"), w, h, gs(video, "r_frame_rate"), scanLabel(fo)),
			Measured: map[string]any{"codec": gs(video, "codec_name"), "profile": gs(video, "profile"), "width": w, "height": h, "frameRate": gs(video, "r_frame_rate"),
				"fieldOrder": fo, "pixFmt": pix, "bitDepth": depth, "chroma": chromaOf(pix), "colorSpace": gs(video, "color_space"),
				"colorTransfer": gs(video, "color_transfer"), "colorPrimaries": gs(video, "color_primaries"), "colorRange": gs(video, "color_range")}})
		q.deliveryVideo(video, w, h, fo)
		out.Timeline = tl
	} else {
		q.notEvaluated("video.format", CatVideo, "Kein Videostream vorhanden", false, "ffprobe")
	}
	if nVideo > 1 {
		q.add(Finding{CheckID: "video.multiple", Category: CatVideo, Status: CheckWarning, Severity: SevMinor, Message: fmt.Sprintf("%d Videostreams; analysiert wird nur der erste", nVideo)})
	}
	q.audioFormat(audios, others)

	// ---- A/V-Synchronität (aus Probe) ----
	q.syncChecks(video, audios, vStart)

	// ---- 2. Integrität (Decode) ----
	progress("integrity", 10)
	var decodeLines []string
	_, icode, err := t.R.Run(ctx, t.FFmpeg, []string{"-nostdin", "-v", "error", "-i", file, "-map", "0:v?", "-map", "0:a?", "-f", "null", "-"}, func(l string) {
		if len(decodeLines) < 200 {
			decodeLines = append(decodeLines, l)
		}
	})
	if err != nil {
		return nil, qcExec("integrity", err)
	}
	q.integrity(decodeLines, icode, video, tl)

	// ---- 3. Video-Analyse ----
	if video != nil && tl != nil {
		progress("video", 30)
		if err := q.videoPass(ctx, file, video, tl, vStart); err != nil {
			return nil, err
		}
	}
	// ---- 4. Audio-Analyse je Spur ----
	for i, a := range audios {
		if i >= prof.MaxAudioStreams {
			q.notEvaluated("audio.analysis", CatAudio, fmt.Sprintf("Nur die ersten %d Tonspuren analysiert (%d vorhanden)", prof.MaxAudioStreams, len(audios)), false, "ffmpeg")
			break
		}
		progress(fmt.Sprintf("audio %d/%d", i+1, len(audios)), 55+int(40*float64(i)/float64(len(audios))))
		if err := q.audioPass(ctx, file, i, a, tl, vStart); err != nil {
			return nil, err
		}
	}
	// ---- Untertitel / Zusatzdaten ----
	q.captions(others)
	progress("done", 100)
	return q.finish(out), nil
}

func qcExec(phase string, err error) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return &ExecError{Phase: phase, Msg: "Zeitlimit überschritten"}
	}
	if errors.Is(err, context.Canceled) {
		return err
	}
	return &ExecError{Phase: phase, Msg: err.Error()}
}

func (q *qcCtx) finish(out *QCOutput) *QCOutput {
	sort.SliceStable(q.findings, func(i, j int) bool { return false })
	out.Findings = q.findings
	out.Counts = map[string]int{CheckPass: 0, CheckWarning: 0, CheckFail: 0, CheckNotEvaluated: 0, "incomplete": 0}
	for _, f := range q.findings {
		out.Counts[f.Status]++
		if f.Status == CheckNotEvaluated && f.Measured["incomplete"] == true {
			out.Counts["incomplete"]++
		}
	}
	switch {
	case out.Counts[CheckFail] > 0:
		out.Overall = OverallFail
	case out.Counts["incomplete"] > 0:
		out.Overall = OverallIncomplete
	case out.Counts[CheckWarning] > 0:
		out.Overall = OverallWarning
	default:
		out.Overall = OverallPass
	}
	return out
}

func scanLabel(fo string) string {
	switch fo {
	case "progressive":
		return "progressiv"
	case "tt":
		return "interlaced (TFF)"
	case "bb":
		return "interlaced (BFF)"
	case "tb", "bt":
		return "interlaced (gemischt)"
	}
	return "Halbbild-Reihenfolge unbekannt"
}

func chromaOf(pix string) string {
	for _, c := range []string{"420", "422", "444", "411", "440"} {
		if strings.Contains(pix, c) {
			return c[:1] + ":" + c[1:2] + ":" + c[2:]
		}
	}
	return ""
}

func bitDepth(pix string, raw float64) int {
	if !math.IsNaN(raw) && raw > 0 {
		return int(raw)
	}
	switch {
	case strings.Contains(pix, "p10"), strings.Contains(pix, "10le"), strings.Contains(pix, "10be"):
		return 10
	case strings.Contains(pix, "12le"), strings.Contains(pix, "12be"):
		return 12
	case pix != "":
		return 8
	}
	return 0
}

func (q *qcCtx) deliveryVideo(v map[string]any, w, h float64, fo string) {
	e := q.prof.Expect
	if e.Width > 0 || e.Height > 0 {
		ok := (e.Width == 0 || int(w) == e.Width) && (e.Height == 0 || int(h) == e.Height)
		q.deliv("delivery.resolution", ok, fmt.Sprintf("Auflösung %.0f×%.0f, erwartet %d×%d", w, h, e.Width, e.Height), map[string]any{"width": w, "height": h}, map[string]any{"width": e.Width, "height": e.Height})
	}
	if e.FrameRate != "" {
		want, _ := ParseRate(e.FrameRate)
		got, ok := parseFPS(gs(v, "r_frame_rate"))
		q.deliv("delivery.framerate", ok && got == want, fmt.Sprintf("Bildrate %s, erwartet %s", gs(v, "r_frame_rate"), e.FrameRate), map[string]any{"frameRate": gs(v, "r_frame_rate")}, map[string]any{"frameRate": e.FrameRate})
	}
	if len(e.VideoCodecs) > 0 {
		q.deliv("delivery.codec", contains(e.VideoCodecs, gs(v, "codec_name")), fmt.Sprintf("Video-Codec %s, erlaubt: %s", gs(v, "codec_name"), strings.Join(e.VideoCodecs, ", ")), map[string]any{"codec": gs(v, "codec_name")}, map[string]any{"allowed": e.VideoCodecs})
	}
	if e.FieldOrder != "" && e.FieldOrder != "any" {
		q.deliv("delivery.scan", fo == e.FieldOrder, fmt.Sprintf("Halbbild-Reihenfolge %q, erwartet %q", fo, e.FieldOrder), map[string]any{"fieldOrder": fo}, map[string]any{"fieldOrder": e.FieldOrder})
	}
}

func (q *qcCtx) deliv(id string, ok bool, msg string, measured, threshold map[string]any) {
	st, sev := CheckPass, SevInfo
	if !ok {
		st, sev = CheckFail, SevMajor
	}
	q.add(Finding{CheckID: id, Category: CatDelivery, Status: st, Severity: sev, Message: msg, Measured: measured, Threshold: threshold})
}

func (q *qcCtx) audioFormat(audios, others []map[string]any) {
	e := q.prof.Expect
	if len(audios) == 0 {
		q.add(Finding{CheckID: "audio.present", Category: CatAudio, Status: CheckWarning, Severity: SevMajor, Message: "Kein Audiostream vorhanden"})
	}
	for i, a := range audios {
		idx := i
		layout := gs(a, "channel_layout")
		bits := int(gn(a, "bits_per_raw_sample"))
		if bits == 0 {
			bits = int(gn(a, "bits_per_sample"))
		}
		q.add(Finding{CheckID: "audio.format", Category: CatAudio, Status: CheckPass, Severity: SevInfo, Stream: &idx,
			Message:  fmt.Sprintf("Spur %d: %s %s Hz, %.0f Kanal/Kanäle, %d Bit", i+1, gs(a, "codec_name"), gs(a, "sample_rate"), gn(a, "channels"), bits),
			Measured: map[string]any{"codec": gs(a, "codec_name"), "sampleRate": gn(a, "sample_rate"), "channels": gn(a, "channels"), "bitDepth": bits, "channelLayout": layout}})
		if layout == "" || layout == "unknown" {
			q.add(Finding{CheckID: "audio.layout", Category: CatAudio, Status: CheckPass, Severity: SevInfo, Stream: &idx,
				Message: fmt.Sprintf("Spur %d: Kanalbelegung nicht im Container angegeben (bei MXF: Zuordnung nur über MCA-Labels bestimmbar)", i+1), Measured: map[string]any{"channelLayout": layout}})
		}
		if e.SampleRate > 0 {
			q.deliv("delivery.samplerate", int(gn(a, "sample_rate")) == e.SampleRate, fmt.Sprintf("Spur %d: %s Hz, erwartet %d", i+1, gs(a, "sample_rate"), e.SampleRate), map[string]any{"sampleRate": gn(a, "sample_rate")}, map[string]any{"sampleRate": e.SampleRate})
		}
		if e.MinBitDepth > 0 {
			q.deliv("delivery.bitdepth", bits >= e.MinBitDepth, fmt.Sprintf("Spur %d: %d Bit, mindestens %d erwartet", i+1, bits, e.MinBitDepth), map[string]any{"bitDepth": bits}, map[string]any{"minBitDepth": e.MinBitDepth})
		}
	}
	if e.AudioTracks > 0 {
		q.deliv("delivery.audio_tracks", len(audios) >= e.AudioTracks, fmt.Sprintf("%d Tonspur(en), mindestens %d erwartet", len(audios), e.AudioTracks), map[string]any{"tracks": len(audios)}, map[string]any{"minTracks": e.AudioTracks})
	}
	_ = others
}

func (q *qcCtx) syncChecks(video map[string]any, audios []map[string]any, vStart float64) {
	if video == nil || len(audios) == 0 {
		return
	}
	vDur := gn(video, "duration")
	maxOff, maxDur := q.prof.Sync.MaxStartOffsetMs, q.prof.Sync.MaxDurationMismatchMs
	for i, a := range audios {
		idx := i
		aStart := gn(a, "start_time")
		if !math.IsNaN(aStart) {
			off := (aStart - vStart) * 1000
			st, sev, msg := CheckPass, SevInfo, fmt.Sprintf("Spur %d: Startversatz zum Video %.1f ms", i+1, off)
			switch {
			case math.Abs(off) > 5*maxOff:
				st, sev = CheckFail, SevMajor
			case math.Abs(off) > maxOff:
				st, sev = CheckWarning, SevMinor
			}
			q.add(Finding{CheckID: "sync.start_offset", Category: CatSync, Status: st, Severity: sev, Message: msg, Stream: &idx,
				Measured: map[string]any{"offsetMs": off}, Threshold: map[string]any{"maxMs": maxOff}})
		}
		aDur := gn(a, "duration")
		if !math.IsNaN(aDur) && !math.IsNaN(vDur) {
			d := (aDur - vDur) * 1000
			st, sev, msg := CheckPass, SevInfo, fmt.Sprintf("Spur %d: Dauerdifferenz zum Video %.1f ms", i+1, d)
			switch {
			case math.Abs(d) > 5*maxDur:
				st, sev = CheckFail, SevMajor
			case math.Abs(d) > maxDur:
				st, sev = CheckWarning, SevMinor
			}
			q.add(Finding{CheckID: "sync.duration_mismatch", Category: CatSync, Status: st, Severity: sev, Message: msg, Stream: &idx,
				Measured: map[string]any{"differenceMs": d}, Threshold: map[string]any{"maxMs": maxDur}})
		}
	}
}

var truncWords = []string{"truncat", "end of file", "premature", "unexpected end", "incomplete"}
var discWords = []string{"non-monotonic", "discontinuity", "timestamp", "pts has no value", "dts"}

func (q *qcCtx) integrity(lines []string, code int, video map[string]any, tl *Timeline) {
	if len(lines) == 0 && code == 0 {
		q.add(Finding{CheckID: "media.decode_errors", Category: CatContainer, Status: CheckPass, Severity: SevInfo, Message: "Vollständig dekodiert, keine Fehler gemeldet", Tool: "ffmpeg"})
		q.add(Finding{CheckID: "container.truncation", Category: CatContainer, Status: CheckPass, Severity: SevInfo, Message: "Keine Hinweise auf abgeschnittene Datei", Tool: "ffmpeg"})
		q.add(Finding{CheckID: "sync.discontinuity", Category: CatSync, Status: CheckPass, Severity: SevInfo, Message: "Keine Zeitstempelsprünge gemeldet", Tool: "ffmpeg"})
		return
	}
	var trunc, disc, other []string
	for _, l := range lines {
		ll := strings.ToLower(l)
		switch {
		case hasAny(ll, truncWords):
			trunc = append(trunc, l)
		case hasAny(ll, discWords):
			disc = append(disc, l)
		default:
			other = append(other, l)
		}
	}
	first := func(s []string) []string {
		if len(s) > 5 {
			return s[:5]
		}
		return s
	}
	if len(other) > 0 || (code != 0 && len(trunc) == 0 && len(disc) == 0) {
		q.add(Finding{CheckID: "media.decode_errors", Category: CatContainer, Status: CheckFail, Severity: SevMajor, Tool: "ffmpeg",
			Message: fmt.Sprintf("%d Dekodierfehler/-meldungen", len(other)), Measured: map[string]any{"count": len(other), "exitCode": code, "first": first(other)}})
	} else {
		q.add(Finding{CheckID: "media.decode_errors", Category: CatContainer, Status: CheckPass, Severity: SevInfo, Message: "Keine Dekodierfehler", Tool: "ffmpeg"})
	}
	if len(trunc) > 0 {
		q.add(Finding{CheckID: "container.truncation", Category: CatContainer, Status: CheckFail, Severity: SevCritical, Tool: "ffmpeg",
			Message: "Hinweise auf abgeschnittene/unvollständige Datei", Measured: map[string]any{"count": len(trunc), "first": first(trunc)}})
	} else {
		q.add(Finding{CheckID: "container.truncation", Category: CatContainer, Status: CheckPass, Severity: SevInfo, Message: "Keine Hinweise auf abgeschnittene Datei", Tool: "ffmpeg"})
	}
	if len(disc) > 0 {
		q.add(Finding{CheckID: "sync.discontinuity", Category: CatSync, Status: CheckWarning, Severity: SevMajor, Tool: "ffmpeg",
			Message: fmt.Sprintf("%d Meldung(en) zu Zeitstempelsprüngen", len(disc)), Measured: map[string]any{"count": len(disc), "first": first(disc)}})
	} else {
		q.add(Finding{CheckID: "sync.discontinuity", Category: CatSync, Status: CheckPass, Severity: SevInfo, Message: "Keine Zeitstempelsprünge gemeldet", Tool: "ffmpeg"})
	}
}

func hasAny(s string, words []string) bool {
	for _, w := range words {
		if strings.Contains(s, w) {
			return true
		}
	}
	return false
}

func (q *qcCtx) frameAt(tl *Timeline, sec, base float64) int64 {
	n := tl.Rate.FrameAtNs(int64(math.Round((sec - base) * 1e9)))
	if n < 0 {
		n = 0
	}
	if n > tl.DurationFrames {
		n = tl.DurationFrames
	}
	return n
}

func (q *qcCtx) videoPass(ctx context.Context, file string, video map[string]any, tl *Timeline, vStart float64) error {
	p := q.prof
	var filters []string
	have := func(f string) bool { return q.t.Has(f) }
	if have("blackdetect") {
		filters = append(filters, fmt.Sprintf("blackdetect=d=%g:pix_th=%g:pic_th=%g", p.Black.MinDurationS, p.Black.PixTh, p.Black.PicTh))
	}
	if have("freezedetect") {
		filters = append(filters, fmt.Sprintf("freezedetect=n=%gdB:d=%g", p.Freeze.NoiseDb, p.Freeze.MinDurationS))
	}
	if have("idet") {
		filters = append(filters, "idet")
	}
	for _, c := range []struct{ filter, id string }{{"blackdetect", "video.black"}, {"freezedetect", "video.freeze"}, {"idet", "video.scan"}} {
		if !have(c.filter) {
			q.notEvaluated(c.id, CatVideo, fmt.Sprintf("ffmpeg-Filter %q ist in dieser ffmpeg-Version nicht verfügbar", c.filter), true, "ffmpeg")
		}
	}
	if len(filters) == 0 {
		return nil
	}
	ip := &IntervalParser{}
	var lines []string
	_, code, err := q.t.R.Run(ctx, q.t.FFmpeg, []string{"-nostdin", "-v", "info", "-i", file, "-map", "0:v:0", "-vf", strings.Join(filters, ","), "-an", "-f", "null", "-"}, func(l string) {
		ip.Line(l)
		if strings.Contains(l, "idet") {
			lines = append(lines, l)
		}
	})
	if err != nil {
		return qcExec("video", err)
	}
	dur := gn(video, "duration")
	if math.IsNaN(dur) {
		dur = float64(tl.DurationFrames) / tl.Rate.Float()
	}
	ip.Finish(vStart + dur)
	if code != 0 {
		for _, c := range []string{"video.black", "video.freeze", "video.scan"} {
			q.notEvaluated(c, CatVideo, fmt.Sprintf("Videoanalyse endete mit Exit-Code %d", code), true, "ffmpeg")
		}
		return nil
	}
	if have("blackdetect") {
		q.intervalFindings("video.black", CatVideo, "Schwarzbild", ip.Black, tl, vStart, dur, p.Black.WarnAboveS, p.Black.FailAboveS, p.Black.MinDurationS, p.Black.IgnoreHeadS, p.Black.IgnoreTailS, nil, "blackdetect")
	}
	if have("freezedetect") {
		q.intervalFindings("video.freeze", CatVideo, "Standbild", ip.Freeze, tl, vStart, dur, p.Freeze.WarnAboveS, p.Freeze.FailAboveS, p.Freeze.MinDurationS, 0, 0, nil, "freezedetect")
	}
	if have("idet") {
		q.scanFinding(lines, gs(video, "field_order"))
	}
	return nil
}

func (q *qcCtx) intervalFindings(id, cat, label string, iv []Interval, tl *Timeline, base, total, warnAbove, failAbove, minDur, ignoreHead, ignoreTail float64, stream *int, filter string) {
	reported := 0
	for _, it := range iv {
		s, e := it.Start-base, it.End-base
		if s < ignoreHead {
			s = ignoreHead
		}
		if ignoreTail > 0 && e > total-ignoreTail {
			e = total - ignoreTail
		}
		d := e - s
		if d < minDur || d <= 0 {
			continue
		}
		reported++
		st, sev := CheckPass, SevInfo
		switch {
		case failAbove > 0 && d >= failAbove:
			st, sev = CheckFail, SevMajor
		case warnAbove > 0 && d >= warnAbove:
			st, sev = CheckWarning, SevMinor
		}
		sf, ef := q.frameAt(tl, s+base, base), q.frameAt(tl, e+base, base)
		q.add(Finding{CheckID: id, Category: cat, Status: st, Severity: sev, Stream: stream, Tool: "ffmpeg",
			Message:    fmt.Sprintf("%s %.2f s (%s – %s)%s", label, d, tl.Timecode(sf), tl.Timecode(ef), openNote(it.Open)),
			Measured:   map[string]any{"durationS": round3(d), "startS": round3(s), "endS": round3(e), "toEndOfFile": it.Open, "filter": filter},
			Threshold:  map[string]any{"warnAboveS": warnAbove, "failAboveS": failAbove, "minDurationS": minDur},
			StartFrame: &sf, EndFrame: &ef})
	}
	if reported == 0 {
		q.add(Finding{CheckID: id, Category: cat, Status: CheckPass, Severity: SevInfo, Stream: stream, Tool: "ffmpeg",
			Message: fmt.Sprintf("Kein %s ≥ %g s", label, minDur), Threshold: map[string]any{"minDurationS": minDur}})
	}
}

func openNote(open bool) string {
	if open {
		return " – bis Dateiende"
	}
	return ""
}

func round3(f float64) float64 { return math.Round(f*1000) / 1000 }

func (q *qcCtx) scanFinding(lines []string, declared string) {
	d, ok := ParseIdet(lines)
	if !ok || d.Total() == 0 {
		q.notEvaluated("video.scan", CatVideo, "Halbbild-Erkennung lieferte kein Ergebnis", true, "ffmpeg")
		return
	}
	tot := float64(d.Total())
	frac := func(n int64) float64 { return float64(n) / tot }
	detected := "mixed"
	switch {
	case frac(d.Progressive) >= 0.9:
		detected = "progressive"
	case frac(d.TFF) >= 0.9:
		detected = "tt"
	case frac(d.BFF) >= 0.9:
		detected = "bb"
	}
	st, sev, msg := CheckPass, SevInfo, fmt.Sprintf("Erkannt: %s (deklariert: %s)", detected, declared)
	switch {
	case detected == "mixed":
		st, sev, msg = CheckWarning, SevMinor, "Gemischte Halbbild-/Vollbild-Kadenz erkannt (Kadenzwechsel möglich)"
	case declared != "" && declared != "unknown" && declared != detected:
		st, sev, msg = CheckWarning, SevMinor, fmt.Sprintf("Deklariert %q, erkannt %q (bei Vollbildern in Halbbild-Container z. B. PsF möglich)", declared, detected)
	}
	q.add(Finding{CheckID: "video.scan", Category: CatVideo, Status: st, Severity: sev, Message: msg, Tool: "ffmpeg",
		Measured: map[string]any{"declared": declared, "detected": detected, "tff": d.TFF, "bff": d.BFF, "progressive": d.Progressive, "undetermined": d.Undetermined}})
}

func (q *qcCtx) audioPass(ctx context.Context, file string, i int, a map[string]any, tl *Timeline, vStart float64) error {
	p := q.prof
	idx := i
	var filters []string
	if q.t.Has("ebur128") && p.Loudness.Enabled {
		filters = append(filters, "ebur128=peak=true")
	}
	if q.t.Has("silencedetect") {
		filters = append(filters, fmt.Sprintf("silencedetect=n=%gdB:d=%g", p.Silence.NoiseDb, p.Silence.MinDurationS))
	}
	if q.t.Has("astats") {
		filters = append(filters, "astats=metadata=0")
	}
	if len(filters) == 0 {
		q.notEvaluated("audio.analysis", CatAudio, "Keine Audio-Analysefilter in diesem ffmpeg", true, "ffmpeg")
		return nil
	}
	ip := &IntervalParser{}
	tail := newTail(700)
	_, code, err := q.t.R.Run(ctx, q.t.FFmpeg, []string{"-nostdin", "-v", "info", "-i", file, "-map", fmt.Sprintf("0:a:%d", i), "-af", strings.Join(filters, ","), "-vn", "-f", "null", "-"}, func(l string) {
		ip.Line(l)
		tail.add(l)
	})
	if err != nil {
		return qcExec(fmt.Sprintf("audio %d", i+1), err)
	}
	if code != 0 {
		q.notEvaluated("audio.analysis", CatAudio, fmt.Sprintf("Spur %d: Analyse endete mit Exit-Code %d", i+1, code), true, "ffmpeg")
		return nil
	}
	dur := gn(a, "duration")
	if math.IsNaN(dur) {
		dur = 0
	}
	aStart := gn(a, "start_time")
	if math.IsNaN(aStart) {
		aStart = 0
	}
	ip.Finish(aStart + dur)
	lines := tail.lines()
	// Spur komplett stumm?
	wholeSilent := false
	for _, s := range ip.Silence {
		if dur > 0 && s.Dur() >= dur*0.99 {
			wholeSilent = true
		}
	}
	if q.t.Has("silencedetect") {
		if wholeSilent {
			q.add(Finding{CheckID: "audio.silence", Category: CatAudio, Status: CheckWarning, Severity: SevMinor, Stream: &idx, Tool: "ffmpeg",
				Message:  fmt.Sprintf("Spur %d vollständig stumm (ungenutzte Spur?)", i+1),
				Measured: map[string]any{"durationS": round3(dur), "wholeTrack": true}, Threshold: map[string]any{"noiseDb": p.Silence.NoiseDb}})
		} else if tl != nil {
			q.intervalFindings("audio.silence", CatAudio, fmt.Sprintf("Spur %d: Stille", i+1), ip.Silence, tl, vStart, dur, p.Silence.WarnAboveS, p.Silence.FailAboveS, p.Silence.MinDurationS, 0, 0, &idx, "silencedetect")
		}
	}
	if q.t.Has("astats") {
		if st, ok := ParseAstats(lines); ok && !math.IsNaN(st.PeakDB) {
			stt, sev, msg := CheckPass, SevInfo, fmt.Sprintf("Spur %d: Spitzenpegel %.1f dBFS", i+1, st.PeakDB)
			if st.PeakDB >= p.ClipPeakDB && !math.IsInf(st.PeakDB, -1) {
				stt, sev, msg = CheckWarning, SevMajor, fmt.Sprintf("Spur %d: Spitzenpegel %.1f dBFS — Clipping-Verdacht", i+1, st.PeakDB)
			}
			q.add(Finding{CheckID: "audio.clipping", Category: CatAudio, Status: stt, Severity: sev, Stream: &idx, Tool: "ffmpeg", Message: msg,
				Measured: map[string]any{"samplePeakDb": jsonFloat(st.PeakDB), "samples": st.Samples}, Threshold: map[string]any{"clipPeakDb": p.ClipPeakDB}})
		} else {
			q.notEvaluated("audio.clipping", CatAudio, fmt.Sprintf("Spur %d: astats lieferte keinen Pegel", i+1), true, "ffmpeg")
		}
	}
	if p.Loudness.Enabled && q.t.Has("ebur128") {
		l, ok := ParseLoudness(lines)
		switch {
		case wholeSilent:
			q.notEvaluated("audio.loudness", CatAudio, fmt.Sprintf("Spur %d stumm — keine Lautheitsmessung", i+1), false, "ffmpeg")
		case !ok || math.IsNaN(l.IntegratedLUFS) || math.IsInf(l.IntegratedLUFS, 0) || l.IntegratedLUFS <= -69.9:
			q.notEvaluated("audio.loudness", CatAudio, fmt.Sprintf("Spur %d: Lautheit nicht messbar (zu kurz oder zu leise)", i+1), false, "ffmpeg")
		default:
			diff := l.IntegratedLUFS - p.Loudness.TargetLUFS
			st, sev := CheckPass, SevInfo
			switch {
			case math.Abs(diff) > p.Loudness.FailToleranceLU:
				st, sev = CheckFail, SevMajor
			case math.Abs(diff) > p.Loudness.WarnToleranceLU:
				st, sev = CheckWarning, SevMinor
			}
			q.add(Finding{CheckID: "audio.loudness", Category: CatAudio, Status: st, Severity: sev, Stream: &idx, Tool: "ffmpeg",
				Message:   fmt.Sprintf("Spur %d: %.1f LUFS (Ziel %.1f, Abweichung %+.1f LU)", i+1, l.IntegratedLUFS, p.Loudness.TargetLUFS, diff),
				Measured:  map[string]any{"integratedLufs": round3(l.IntegratedLUFS), "lra": jsonFloat(l.LRA), "diffLu": round3(diff)},
				Threshold: map[string]any{"targetLufs": p.Loudness.TargetLUFS, "warnToleranceLu": p.Loudness.WarnToleranceLU, "failToleranceLu": p.Loudness.FailToleranceLU}})
			if p.Loudness.MaxLRA > 0 && !math.IsNaN(l.LRA) && l.LRA > p.Loudness.MaxLRA {
				q.add(Finding{CheckID: "audio.lra", Category: CatAudio, Status: CheckWarning, Severity: SevMinor, Stream: &idx, Tool: "ffmpeg",
					Message:  fmt.Sprintf("Spur %d: Lautheitsumfang %.1f LU über %.1f", i+1, l.LRA, p.Loudness.MaxLRA),
					Measured: map[string]any{"lra": round3(l.LRA)}, Threshold: map[string]any{"maxLra": p.Loudness.MaxLRA}})
			}
			if !math.IsNaN(l.TruePeakDBFS) && !math.IsInf(l.TruePeakDBFS, -1) {
				st, sev, msg := CheckPass, SevInfo, fmt.Sprintf("Spur %d: True Peak %.1f dBTP", i+1, l.TruePeakDBFS)
				if l.TruePeakDBFS > p.Loudness.MaxTruePeakDB {
					st, sev, msg = CheckFail, SevMajor, fmt.Sprintf("Spur %d: True Peak %.1f dBTP über Grenze %.1f", i+1, l.TruePeakDBFS, p.Loudness.MaxTruePeakDB)
				}
				q.add(Finding{CheckID: "audio.true_peak", Category: CatAudio, Status: st, Severity: sev, Stream: &idx, Tool: "ffmpeg", Message: msg,
					Measured: map[string]any{"truePeakDbtp": round3(l.TruePeakDBFS)}, Threshold: map[string]any{"maxDbtp": p.Loudness.MaxTruePeakDB}})
			}
		}
	}
	return nil
}

func jsonFloat(f float64) any {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return nil
	}
	return round3(f)
}

func (q *qcCtx) captions(others []map[string]any) {
	var n int
	for _, s := range others {
		if t := gs(s, "codec_type"); t == "subtitle" || t == "data" {
			n++
		}
	}
	switch {
	case n > 0:
		q.add(Finding{CheckID: "content.captions", Category: CatContent, Status: CheckPass, Severity: SevInfo, Message: fmt.Sprintf("%d Untertitel-/Datenstrom(e) vorhanden (Inhalt nicht geprüft)", n), Measured: map[string]any{"streams": n}})
	case q.prof.Expect.Captions:
		q.add(Finding{CheckID: "content.captions", Category: CatContent, Status: CheckFail, Severity: SevMajor, Message: "Untertitel/Zusatzdaten laut Profil erwartet, aber nicht vorhanden"})
	default:
		q.notEvaluated("content.captions", CatContent, "Nicht gefordert. ffprobe sieht keinen Untertitel-/Datenstrom (in Videodaten eingebettete CEA-608/708 sind hier nicht prüfbar)", false, "ffprobe")
	}
}

// tail hält die letzten n Zeilen (Zusammenfassungen stehen am Ende; die Pegel-Zeilen von ebur128 dazwischen sind sehr viele).
type tailBuf struct {
	buf  []string
	n    int
	next int
	full bool
}

func newTail(n int) *tailBuf { return &tailBuf{buf: make([]string, n), n: n} }

func (t *tailBuf) add(l string) {
	t.buf[t.next] = l
	t.next++
	if t.next == t.n {
		t.next, t.full = 0, true
	}
}

func (t *tailBuf) lines() []string {
	if !t.full {
		return append([]string(nil), t.buf[:t.next]...)
	}
	return append(append([]string(nil), t.buf[t.next:]...), t.buf[:t.next]...)
}

// timelineFromProbe leitet die Zeitachse aus ffprobe-Daten ab (Rate exakt als Bruch, Bildanzahl = gezählte Videopakete,
// Start-Timecode aus Container-/Stream-Tag). tcStr ist der gelesene Timecode-Text ("" = keiner), tcErr sein Parsefehler.
func timelineFromProbe(video, format map[string]any) (tl *Timeline, tcStr string, tcErr error) {
	rate, ok := parseFPS(gs(video, "r_frame_rate"))
	if !ok {
		return nil, "", nil
	}
	frames := int64(gn(video, "nb_read_packets"))
	dur := gn(video, "duration")
	if math.IsNaN(dur) {
		dur = gn(format, "duration")
	}
	if frames <= 0 && !math.IsNaN(dur) {
		frames = int64(math.Round(dur * rate.Float()))
	}
	tl = &Timeline{Rate: rate, DurationFrames: frames}
	if avg, ok := parseFPS(gs(video, "avg_frame_rate")); ok && math.Abs(avg.Float()-rate.Float())/rate.Float() > 0.005 {
		tl.VFR = true
	}
	tcStr = gs(tagsOf(format), "timecode")
	if tcStr == "" {
		tcStr = gs(tagsOf(video), "timecode")
	}
	if tcStr != "" {
		var c int64
		var drop bool
		if c, drop, tcErr = ParseTimecode(tcStr, rate); tcErr == nil {
			tl.StartFrames, tl.DropFrame = c, drop
		}
	}
	return tl, tcStr, tcErr
}

// ProbeTimeline liest nur die Zeitachse (schnell, ohne Dekodierung) — bei der Registrierung, damit der Review sofort
// Positionen kennt, auch wenn die QC noch läuft.
func (t *Tools) ProbeTimeline(ctx context.Context, file string) (*Timeline, map[string]any, error) {
	if err := t.Discover(ctx); err != nil {
		return nil, nil, err
	}
	stdout, code, err := t.R.Run(ctx, t.FFprobe, []string{"-v", "error", "-count_packets", "-select_streams", "v:0", "-show_format", "-show_streams", "-of", "json", file}, nil)
	if err != nil {
		return nil, nil, qcExec("probe", err)
	}
	var probe struct {
		Streams []map[string]any `json:"streams"`
		Format  map[string]any   `json:"format"`
	}
	if code != 0 || json.Unmarshal(stdout, &probe) != nil || len(probe.Streams) == 0 {
		return nil, nil, fmt.Errorf("Datei nicht lesbar")
	}
	tl, _, _ := timelineFromProbe(probe.Streams[0], probe.Format)
	return tl, probe.Format, nil
}
