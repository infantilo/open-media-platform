package review

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Vergleich Original ↔ Aufnahme (Kapitel 74.5): Wurde das, was gesendet wurde, auch so aufgezeichnet?
// Geprüft werden Dauer, Bildrate, Auflösung, Codec, Audio und die Bildqualität (SSIM auf einer Stichprobe).

// CompareOptions steuert den Vergleich. Nullwerte bedeuten Standard.
type CompareOptions struct {
	// DurationTolMs: erlaubte Abweichung der Dauer (Standard: ein Bild bei 25 fps = 40 ms, nie weniger als ein Bild).
	DurationTolMs float64 `json:"durationTolMs,omitempty"`
	// SSIMMin: Mindestwert der Bildqualität (Standard 0,98).
	SSIMMin float64 `json:"ssimMin,omitempty"`
	// OffsetSec: Beginn des Originals innerhalb der Aufnahme (Vorlauf der Aufnahme), Standard 0.
	OffsetSec float64 `json:"offsetSec,omitempty"`
	// SampleSec: Länge der Qualitätsstichprobe (Standard 10 s), SampleStartSec: Beginn im Original (Standard 0).
	SampleSec      float64 `json:"sampleSec,omitempty"`
	SampleStartSec float64 `json:"sampleStartSec,omitempty"`
	// SkipQuality: Bildqualität nicht messen.
	SkipQuality bool `json:"skipQuality,omitempty"`
}

func (o CompareOptions) withDefaults() CompareOptions {
	if o.SSIMMin <= 0 {
		o.SSIMMin = 0.98
	}
	if o.SampleSec <= 0 {
		o.SampleSec = 10
	}
	return o
}

// MediaFacts sind die verglichenen Eigenschaften einer Datei.
type MediaFacts struct {
	DurationSec  float64 `json:"durationSec"`
	VideoCodec   string  `json:"videoCodec,omitempty"`
	Width        int     `json:"width,omitempty"`
	Height       int     `json:"height,omitempty"`
	FrameRate    string  `json:"frameRate,omitempty"` // Bruch, z. B. 25/1
	AudioCodec   string  `json:"audioCodec,omitempty"`
	AudioStreams int     `json:"audioStreams"`
	Channels     int     `json:"channels,omitempty"` // Summe aller Audiokanäle
	SampleRate   int     `json:"sampleRate,omitempty"`
}

type CompareCheck struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Status   string `json:"status"` // pass | fail | warn | skipped
	Original string `json:"original,omitempty"`
	Recorded string `json:"recorded,omitempty"`
	Message  string `json:"message"`
}

type CompareReport struct {
	Overall  string         `json:"overall"` // pass | fail | warning
	Original MediaFacts     `json:"original"`
	Recorded MediaFacts     `json:"recorded"`
	Checks   []CompareCheck `json:"checks"`
	SSIM     *float64       `json:"ssim,omitempty"`
}

// ParseFacts liest `ffprobe -show_format -show_streams -of json`.
func ParseFacts(raw []byte) (MediaFacts, error) {
	var p struct {
		Format  struct{ Duration string } `json:"format"`
		Streams []struct {
			CodecType  string `json:"codec_type"`
			CodecName  string `json:"codec_name"`
			Width      int    `json:"width"`
			Height     int    `json:"height"`
			RFrameRate string `json:"r_frame_rate"`
			AvgRate    string `json:"avg_frame_rate"`
			Channels   int    `json:"channels"`
			SampleRate string `json:"sample_rate"`
			Duration   string `json:"duration"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return MediaFacts{}, fmt.Errorf("ffprobe-Ausgabe nicht lesbar: %w", err)
	}
	var f MediaFacts
	f.DurationSec, _ = strconv.ParseFloat(p.Format.Duration, 64)
	for _, s := range p.Streams {
		switch s.CodecType {
		case "video":
			if f.VideoCodec == "" {
				f.VideoCodec, f.Width, f.Height = s.CodecName, s.Width, s.Height
				f.FrameRate = s.AvgRate
				if f.FrameRate == "" || f.FrameRate == "0/0" {
					f.FrameRate = s.RFrameRate
				}
			}
		case "audio":
			f.AudioStreams++
			f.Channels += s.Channels
			if f.AudioCodec == "" {
				f.AudioCodec = s.CodecName
				f.SampleRate, _ = strconv.Atoi(s.SampleRate)
			}
		}
	}
	if f.VideoCodec == "" && f.AudioStreams == 0 {
		return f, fmt.Errorf("weder Video- noch Audiostream gefunden")
	}
	return f, nil
}

func rate(s string) float64 {
	a, b, ok := strings.Cut(s, "/")
	if !ok {
		v, _ := strconv.ParseFloat(s, 64)
		return v
	}
	n, _ := strconv.ParseFloat(a, 64)
	d, _ := strconv.ParseFloat(b, 64)
	if d == 0 {
		return 0
	}
	return n / d
}

// CompareFacts ist der reine Vergleich der Eigenschaften (ohne Qualitätsmessung).
func CompareFacts(o, r MediaFacts, opt CompareOptions) []CompareCheck {
	opt = opt.withDefaults()
	var out []CompareCheck
	add := func(c CompareCheck) { out = append(out, c) }
	// Dauer
	tol := opt.DurationTolMs
	if fr := rate(o.FrameRate); tol <= 0 {
		tol = 40
		if fr > 0 {
			tol = 1000 / fr
		}
	}
	diff := (r.DurationSec - opt.OffsetSec - o.DurationSec) * 1000
	c := CompareCheck{ID: "duration", Label: "Dauer", Original: fmt.Sprintf("%.3f s", o.DurationSec), Recorded: fmt.Sprintf("%.3f s", r.DurationSec)}
	if math.Abs(diff) <= tol+0.5 {
		c.Status, c.Message = "pass", fmt.Sprintf("Abweichung %.0f ms (erlaubt ±%.0f ms)", diff, tol)
	} else {
		c.Status, c.Message = "fail", fmt.Sprintf("Abweichung %.0f ms, erlaubt sind ±%.0f ms (Aufnahme-Vorlauf %.2f s abgezogen)", diff, tol, opt.OffsetSec)
	}
	add(c)
	// Bildrate: exakt gleicher Bruch (Wert), 25/1 == 50/2.
	c = CompareCheck{ID: "framerate", Label: "Bildrate", Original: o.FrameRate, Recorded: r.FrameRate}
	switch {
	case o.FrameRate == "" || r.FrameRate == "":
		c.Status, c.Message = "skipped", "kein Videostream"
	case math.Abs(rate(o.FrameRate)-rate(r.FrameRate)) < 1e-6:
		c.Status, c.Message = "pass", "gleich"
	default:
		c.Status, c.Message = "fail", fmt.Sprintf("%.4f ≠ %.4f Bilder/s", rate(o.FrameRate), rate(r.FrameRate))
	}
	add(c)
	// Auflösung: Hinweis, kein Fehler (Aufnahmeprofile dürfen anders skalieren).
	c = CompareCheck{ID: "resolution", Label: "Auflösung", Original: fmt.Sprintf("%dx%d", o.Width, o.Height), Recorded: fmt.Sprintf("%dx%d", r.Width, r.Height)}
	if o.Width == r.Width && o.Height == r.Height {
		c.Status, c.Message = "pass", "gleich"
	} else {
		c.Status, c.Message = "warn", "Auflösung weicht ab (Aufnahmeprofil?)"
	}
	add(c)
	c = CompareCheck{ID: "codec", Label: "Videocodec", Original: o.VideoCodec, Recorded: r.VideoCodec, Status: "pass", Message: "gleich"}
	if o.VideoCodec != r.VideoCodec {
		c.Status, c.Message = "warn", "Codec weicht ab (Information)"
	}
	add(c)
	// Audio
	c = CompareCheck{ID: "audio", Label: "Audio", Original: fmt.Sprintf("%d Spuren, %d Kanäle, %d Hz", o.AudioStreams, o.Channels, o.SampleRate), Recorded: fmt.Sprintf("%d Spuren, %d Kanäle, %d Hz", r.AudioStreams, r.Channels, r.SampleRate)}
	switch {
	case o.AudioStreams == 0 && r.AudioStreams == 0:
		c.Status, c.Message = "skipped", "kein Audio"
	case r.AudioStreams == 0:
		c.Status, c.Message = "fail", "Aufnahme ohne Ton"
	case o.Channels != r.Channels || o.SampleRate != r.SampleRate:
		c.Status, c.Message = "warn", "Kanalzahl oder Abtastrate weicht ab"
	default:
		c.Status, c.Message = "pass", "gleich"
	}
	add(c)
	return out
}

var ssimAll = regexp.MustCompile(`SSIM.*All:([0-9.]+)`)

// ParseSSIM liest den Gesamtwert aus der Schlusszeile des ffmpeg-ssim-Filters.
func ParseSSIM(stderr string) (float64, bool) {
	m := ssimAll.FindAllStringSubmatch(stderr, -1)
	if len(m) == 0 {
		return 0, false
	}
	v, err := strconv.ParseFloat(m[len(m)-1][1], 64)
	return v, err == nil
}

func (t *Tools) probeFacts(ctx context.Context, file string) (MediaFacts, error) {
	out, code, err := t.Exec().Run(ctx, t.FFprobe, []string{"-v", "error", "-show_format", "-show_streams", "-of", "json", file}, nil)
	if err != nil {
		return MediaFacts{}, err
	}
	if code != 0 {
		return MediaFacts{}, fmt.Errorf("ffprobe konnte %q nicht lesen (Exit %d)", file, code)
	}
	return ParseFacts(out)
}

// MeasureSSIM misst die Bildähnlichkeit auf einer kurzen Stichprobe: beide Seiten werden klein (320x180) und auf gleiche
// Bildrate gebracht, ein Faden, niedrige Priorität — die Last bleibt klein.
func (t *Tools) MeasureSSIM(ctx context.Context, orig, rec string, opt CompareOptions) (float64, error) {
	opt = opt.withDefaults()
	norm := "scale=320:180:flags=bilinear,setsar=1,fps=25,format=yuv420p"
	args := []string{"-hide_banner", "-nostats", "-threads", "1",
		"-ss", fmt.Sprintf("%.3f", opt.SampleStartSec), "-t", fmt.Sprintf("%.3f", opt.SampleSec), "-i", orig,
		"-ss", fmt.Sprintf("%.3f", opt.SampleStartSec+opt.OffsetSec), "-t", fmt.Sprintf("%.3f", opt.SampleSec), "-i", rec,
		"-filter_threads", "1", "-lavfi", "[0:v]" + norm + "[a];[1:v]" + norm + "[b];[a][b]ssim", "-an", "-f", "null", "-"}
	var all strings.Builder
	_, code, err := t.Exec().Run(ctx, t.FFmpeg, args, func(l string) { all.WriteString(l + "\n") })
	if err != nil {
		return 0, err
	}
	v, ok := ParseSSIM(all.String())
	if !ok {
		return 0, fmt.Errorf("SSIM nicht ermittelbar (ffmpeg Exit %d)", code)
	}
	return v, nil
}

// Compare vergleicht zwei Dateien vollständig.
func (t *Tools) Compare(ctx context.Context, orig, rec string, opt CompareOptions) (CompareReport, error) {
	opt = opt.withDefaults()
	if err := t.Discover(ctx); err != nil {
		return CompareReport{}, err
	}
	of, err := t.probeFacts(ctx, orig)
	if err != nil {
		return CompareReport{}, fmt.Errorf("Original: %w", err)
	}
	rf, err := t.probeFacts(ctx, rec)
	if err != nil {
		return CompareReport{}, fmt.Errorf("Aufnahme: %w", err)
	}
	rep := CompareReport{Original: of, Recorded: rf, Checks: CompareFacts(of, rf, opt)}
	q := CompareCheck{ID: "quality", Label: "Bildqualität (SSIM)"}
	switch {
	case opt.SkipQuality:
		q.Status, q.Message = "skipped", "nicht gemessen"
	case of.VideoCodec == "" || rf.VideoCodec == "":
		q.Status, q.Message = "skipped", "kein Videostream"
	default:
		v, err := t.MeasureSSIM(ctx, orig, rec, opt)
		if err != nil {
			q.Status, q.Message = "fail", "Messung fehlgeschlagen: "+err.Error()
		} else {
			rep.SSIM = &v
			q.Original, q.Recorded = "1.0000", fmt.Sprintf("%.4f", v)
			if v >= opt.SSIMMin {
				q.Status, q.Message = "pass", fmt.Sprintf("SSIM %.4f ≥ %.2f (Stichprobe %.0f s ab %.1f s)", v, opt.SSIMMin, opt.SampleSec, opt.SampleStartSec)
			} else {
				q.Status, q.Message = "fail", fmt.Sprintf("SSIM %.4f < %.2f — Aufnahme weicht sichtbar vom Original ab (oder Versatz %.2f s stimmt nicht)", v, opt.SSIMMin, opt.OffsetSec)
			}
		}
	}
	rep.Checks = append(rep.Checks, q)
	rep.Overall = "pass"
	for _, c := range rep.Checks {
		if c.Status == "fail" {
			rep.Overall = "fail"
			break
		}
		if c.Status == "warn" {
			rep.Overall = "warning"
		}
	}
	return rep, nil
}
