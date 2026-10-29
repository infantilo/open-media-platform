package review

import (
	"bytes"
	"context"
	"fmt"
	"image/jpeg"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// burnInFixture: Frame-Nummer als 8 weiße/schwarze Kästchen (Bit k = Kästchen k) in die Quelle gebrannt — damit lässt sich
// prüfen, WELCHES Bild ein Proxy-Frame / Browser-Seek tatsächlich zeigt.
func burnInFixture(t *testing.T, dir, name string, frames int, fieldFlags bool) string {
	t.Helper()
	var vf []string
	for k := 0; k < 8; k++ {
		vf = append(vf, fmt.Sprintf("drawbox=x=%d:y=16:w=32:h=32:color=white:t=fill:enable='gte(mod(floor(n/%d),2),1)'", 16+40*k, 1<<k))
	}
	out := filepath.Join(dir, name)
	args := []string{"-v", "error", "-y",
		"-f", "lavfi", "-i", fmt.Sprintf("color=c=black:s=640x360:r=25:d=%d,format=yuv422p,%s", frames/25+1, strings.Join(vf, ",")),
		"-f", "lavfi", "-i", fmt.Sprintf("sine=frequency=440:sample_rate=48000:d=%d", frames/25+1),
		"-map", "0:v", "-map", "1:a", "-t", fmt.Sprintf("%g", float64(frames)/25), "-c:v", "mpeg2video", "-pix_fmt", "yuv422p", "-b:v", "30M", "-g", "12", "-bf", "0",
		"-c:a", "pcm_s24le", "-timecode", "01:00:00:00", "-shortest"}
	if fieldFlags {
		args = append(args, "-flags", "+ildct+ilme", "-top", "1")
	}
	args = append(args, "-f", "mxf", out)
	if b, err := exec.Command("ffmpeg", args...).CombinedOutput(); err != nil {
		t.Fatalf("burn-in fixture: %v\n%s", err, b)
	}
	return out
}

func decodeBurnIn(t *testing.T, img []byte) int {
	t.Helper()
	im, err := jpeg.Decode(bytes.NewReader(img))
	if err != nil {
		t.Fatalf("jpeg: %v", err)
	}
	b := im.Bounds()
	// Proxy ist auf 540 Zeilen skaliert (Faktor 1,5) → relativ zur Breite messen
	scale := float64(b.Dx()) / 640.0
	n := 0
	for k := 0; k < 8; k++ {
		x := int((16 + 40*float64(k) + 16) * scale)
		y := int((16 + 16) * scale)
		r, g, bl, _ := im.At(x, y).RGBA()
		if (r+g+bl)/3 > 0x8000 {
			n |= 1 << k
		}
	}
	return n
}

func TestProxyMapsFramesOneToOneAndIsVerified(t *testing.T) {
	needFFmpeg(t)
	for _, interlaced := range []bool{false, true} {
		t.Run(fmt.Sprintf("interlacedFlags=%v", interlaced), func(t *testing.T) {
			e := newEnv(t, func(c *Config) { c.QCProfiles["broadcast-default"] = noLoudness(c.QCProfiles["broadcast-default"]) })
			ctx := context.Background()
			src := burnInFixture(t, e.dir, "burn.mxf", 100, interlaced)
			e.file = filepath.Base(src)
			it := e.importReady(t)
			if it.Timeline == nil || it.Timeline.DurationFrames != 100 || it.Timeline.Timecode(0) != "01:00:00:00" {
				t.Fatalf("timeline = %+v", it.Timeline)
			}
			if _, err := e.svc.RequestProxy(ctx, it.AssetID, false); err != nil {
				t.Fatal(err)
			}
			if ran, err := e.svc.RunNextProxy(ctx); !ran || err != nil {
				t.Fatalf("proxy run: %v %v", ran, err)
			}
			path, p, err := e.svc.ProxyFile(ctx, it.AssetID)
			if err != nil || !p.Verified || p.Frames != 100 || p.Rate.Num != 25 {
				t.Fatalf("proxy: %v %+v", err, p)
			}
			if st, _ := os.Stat(path); st == nil || st.Size() == 0 {
				t.Fatal("proxy file missing")
			}
			// Original unverändert
			if fp, _ := Fingerprint(src); fp != it.SourceRev {
				t.Fatal("source must stay untouched")
			}
			// Einzelbild n zeigt exakt Quellbild n (Anfang, Mitte, Ende, Gop-Grenzen)
			for _, n := range []int64{0, 1, 11, 12, 13, 37, 50, 98, 99} {
				img, err := e.svc.Frame(ctx, it.AssetID, n)
				if err != nil {
					t.Fatalf("frame %d: %v", n, err)
				}
				if got := decodeBurnIn(t, img); int64(got) != n {
					t.Errorf("proxy frame %d shows source frame %d", n, got)
				}
			}
			if _, err := e.svc.Frame(ctx, it.AssetID, 100); err == nil {
				t.Error("frame past the end must be rejected")
			}
			// zweiter Aufruf: derselbe Proxy, keine neue Arbeit
			if ran, _ := e.svc.RunNextProxy(ctx); ran {
				t.Error("no second proxy build expected")
			}
		})
	}
}

func TestProxyBecomesStaleWhenSourceChanges(t *testing.T) {
	needFFmpeg(t)
	e := newEnv(t, func(c *Config) { c.QCProfiles["broadcast-default"] = noLoudness(c.QCProfiles["broadcast-default"]) })
	ctx := context.Background()
	it := e.importReady(t)
	_, _ = e.svc.RequestProxy(ctx, it.AssetID, false)
	_, _ = e.svc.RunNextProxy(ctx)
	if _, _, err := e.svc.ProxyFile(ctx, it.AssetID); err != nil {
		t.Fatal(err)
	}
	// Quelle ändert sich → alter Proxy darf nicht mehr ausgeliefert werden
	p := filepath.Join(e.dir, e.file)
	b, _ := os.ReadFile(p)
	_ = os.WriteFile(p, append(b, 0), 0o644)
	if _, _, err := e.svc.RequestQC(ctx, it.AssetID, "x", "", false); err != nil {
		t.Fatal(err)
	}
	if _, _, err := e.svc.ProxyFile(ctx, it.AssetID); err == nil {
		t.Fatal("proxy of an older source revision must not be served")
	}
	e.drain(t)
}

// Referenzprofil der Plattform (aus einer realen Anlieferdatei, siehe docs/ENTWURF-FILE-QC.md §3): MXF OP1a, MPEG-2 4:2:2
// 1920×1080 25 fps interlaced (TFF), 50 Mbit/s, 8 getrennte Mono-Tonspuren PCM 24 Bit/48 kHz, Start-Timecode 00:00:00:00.
// Synthetisch nachgebaut (kurz) — beweist den Pfad Probe → QC → Proxy für genau dieses Profil.
func TestReferenceProfile1080i8Tracks(t *testing.T) {
	needFFmpeg(t)
	e := newEnv(t, func(c *Config) {
		c.QCProfiles["broadcast-default"] = noLoudness(c.QCProfiles["broadcast-default"])
		p := c.QCProfiles["broadcast-default"]
		p.Expect.Width, p.Expect.Height, p.Expect.FrameRate, p.Expect.FieldOrder, p.Expect.Container = 1920, 1080, "25/1", "tt", "mxf"
		p.Expect.AudioTracks, p.Expect.SampleRate, p.Expect.MinBitDepth = 8, 48000, 24
		p.Expect.VideoCodecs = []string{"mpeg2video"}
		c.QCProfiles["broadcast-default"] = p
	})
	ctx := context.Background()
	out := filepath.Join(e.dir, "ref1080i.mxf")
	args := []string{"-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=25,format=yuv422p"}
	for i := 0; i < 8; i++ {
		args = append(args, "-f", "lavfi", "-i", fmt.Sprintf("sine=frequency=%d:sample_rate=48000,volume=-23dB", 300+100*i))
	}
	args = append(args, "-map", "0:v")
	for i := 1; i <= 8; i++ {
		args = append(args, "-map", fmt.Sprint(i, ":a"))
	}
	args = append(args, "-t", "2", "-c:v", "mpeg2video", "-pix_fmt", "yuv422p", "-b:v", "50M", "-minrate", "50M", "-maxrate", "50M", "-bufsize", "17825792", "-g", "12", "-bf", "0",
		"-flags", "+ildct+ilme", "-top", "1", "-c:a", "pcm_s24le", "-timecode", "00:00:00:00", "-f", "mxf", out)
	if b, err := exec.Command("ffmpeg", args...).CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, b)
	}
	e.file = filepath.Base(out)
	it := e.importReady(t)
	if it.Timeline == nil || it.Timeline.DurationFrames != 50 || it.Timeline.Timecode(0) != "00:00:00:00" || it.Timeline.Rate.Num != 25 {
		t.Fatalf("timeline = %+v", it.Timeline)
	}
	rep, err := e.svc.St.GetReport(ctx, it.QCReportID, true)
	if err != nil {
		t.Fatal(err)
	}
	var audioFormats, layoutNotes int
	status := map[string]string{}
	for _, f := range rep.Findings {
		switch f.CheckID {
		case "audio.format":
			audioFormats++
		case "audio.layout":
			layoutNotes++ // „Layout unbekannt“ ist ein Hinweis, kein Fehler
			if f.Status != CheckPass {
				t.Errorf("unknown channel layout must not be a problem: %+v", f)
			}
		case "delivery.resolution", "delivery.framerate", "delivery.scan", "delivery.container", "delivery.audio_tracks", "delivery.samplerate", "delivery.bitdepth", "delivery.codec":
			status[f.CheckID] = f.Status
		}
	}
	if audioFormats != 8 || layoutNotes != 8 {
		t.Fatalf("8 mono tracks expected: formats=%d layout notes=%d", audioFormats, layoutNotes)
	}
	for id, st := range status {
		if st != CheckPass {
			t.Errorf("%s = %s, reference profile must satisfy its own delivery profile", id, st)
		}
	}
	if len(status) != 8 {
		t.Fatalf("delivery checks present: %v", status)
	}
	if _, err := e.svc.RequestProxy(ctx, it.AssetID, false); err != nil {
		t.Fatal(err)
	}
	if ran, err := e.svc.RunNextProxy(ctx); !ran || err != nil {
		t.Fatalf("proxy: %v %v", ran, err)
	}
	path, p, err := e.svc.ProxyFile(ctx, it.AssetID)
	if err != nil || p.Frames != 50 || p.Height != 540 || p.Width != 960 {
		t.Fatalf("proxy: %v %+v", err, p)
	}
	// Ton-Proxy: je Quell-Tonspur ein Stereo-AAC-Stream (Spurwahl im Browser); das Video-Proxy selbst ist stumm
	if p.AudioTracks != 8 || p.AudioPath == "" {
		t.Fatalf("audio proxy: tracks=%d path=%q, want 8 tracks", p.AudioTracks, p.AudioPath)
	}
	b, _ := exec.Command("ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=channels,codec_name", "-of", "csv=p=0", p.AudioPath).Output()
	if got := strings.Count(string(b), "aac,2"); got != 8 {
		t.Fatalf("audio proxy streams = %q, want 8 stereo AAC streams", b)
	}
	if v, _ := exec.Command("ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_name", "-of", "csv=p=0", path).Output(); strings.TrimSpace(string(v)) != "" {
		t.Fatalf("video proxy must carry no audio, got %q", v)
	}
}

// toneStepFixture: 1 s Stille, danach 1-kHz-Ton (Stereo, links lauter) — der Toneinsatz bei genau 1,000 s prüft die Zeitabbildung
// des Ton-Proxys und der Block-Auslieferung.
func toneStepFixture(t *testing.T, dir string, frames int) string {
	t.Helper()
	out := filepath.Join(dir, "tone.mxf")
	secs := float64(frames) / 25
	args := []string{"-v", "error", "-y",
		"-f", "lavfi", "-i", fmt.Sprintf("color=c=black:s=640x360:r=25:d=%g,format=yuv422p", secs),
		"-f", "lavfi", "-i", fmt.Sprintf("aevalsrc='if(gte(t,1),0.5*sin(2*PI*1000*t),0)|if(gte(t,1),0.25*sin(2*PI*1000*t),0)':s=48000:d=%g", secs),
		"-f", "lavfi", "-i", fmt.Sprintf("sine=frequency=300:sample_rate=48000:d=%g", secs),
		"-map", "0:v", "-map", "1:a", "-map", "2:a", "-t", fmt.Sprintf("%g", secs), "-c:v", "mpeg2video", "-pix_fmt", "yuv422p", "-b:v", "30M", "-g", "12", "-bf", "0",
		"-c:a", "pcm_s24le", "-timecode", "01:00:00:00", "-f", "mxf", out}
	if b, err := exec.Command("ffmpeg", args...).CombinedOutput(); err != nil {
		t.Fatalf("tone fixture: %v\n%s", err, b)
	}
	return out
}

func TestAudioProxyTracksAndBlocksAreTimeAccurate(t *testing.T) {
	needFFmpeg(t)
	e := newEnv(t, func(c *Config) { c.QCProfiles["broadcast-default"] = noLoudness(c.QCProfiles["broadcast-default"]) })
	ctx := context.Background()
	src := toneStepFixture(t, e.dir, 300) // 12 s → zwei Blöcke je Spur
	e.file = filepath.Base(src)
	it := e.importReady(t)
	if _, err := e.svc.RequestProxy(ctx, it.AssetID, false); err != nil {
		t.Fatal(err)
	}
	if ran, err := e.svc.RunNextProxy(ctx); !ran || err != nil {
		t.Fatalf("proxy run: %v %v", ran, err)
	}
	_, p, err := e.svc.ProxyFile(ctx, it.AssetID)
	if err != nil || p.AudioTracks != 2 {
		t.Fatalf("proxy: %v %+v", err, p)
	}
	samples := func(wav []byte) (l, r []int16) {
		if string(wav[:4]) != "RIFF" || string(wav[8:12]) != "WAVE" {
			t.Fatalf("kein WAV")
		}
		pcm := wav[44:]
		for i := 0; i+3 < len(pcm); i += 4 {
			l = append(l, int16(uint16(pcm[i])|uint16(pcm[i+1])<<8))
			r = append(r, int16(uint16(pcm[i+2])|uint16(pcm[i+3])<<8))
		}
		return
	}
	// Spur 0, Block 0: 10 s, Stille bis 1,000 s (±1 Bild), dann Ton; links ≈ doppelt so laut wie rechts
	wav, err := e.svc.AudioBlock(ctx, it.AssetID, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	l, r := samples(wav)
	if len(l) != 10*48000 {
		t.Fatalf("Block 0 hat %d Samples, erwartet %d", len(l), 10*48000)
	}
	first := -1
	for i, v := range l {
		if v > 3000 || v < -3000 {
			first = i
			break
		}
	}
	if d := first - 48000; d < -1920 || d > 1920 {
		t.Errorf("Toneinsatz bei Sample %d, erwartet 48000 ± 1920 (1 Bild)", first)
	}
	var sl, sr float64
	for i := 96000; i < 120000; i++ {
		sl += float64(l[i]) * float64(l[i])
		sr += float64(r[i]) * float64(r[i])
	}
	if ratio := sl / sr; ratio < 2.5 || ratio > 6 { // Leistung ≈ 4:1
		t.Errorf("Pegelverhältnis L/R (Leistung) = %.2f, erwartet ≈ 4", ratio)
	}
	// Letzter Block ist kürzer (12 s − 10 s), danach nichts mehr
	wav, err = e.svc.AudioBlock(ctx, it.AssetID, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if l, _ = samples(wav); len(l) != 2*48000 {
		t.Errorf("Block 1 hat %d Samples, erwartet %d", len(l), 2*48000)
	}
	if _, err := e.svc.AudioBlock(ctx, it.AssetID, 0, 2); err == nil {
		t.Error("Block hinter dem Ende muss abgelehnt werden")
	}
	if _, err := e.svc.AudioBlock(ctx, it.AssetID, 2, 0); err == nil {
		t.Error("unbekannte Spur muss abgelehnt werden")
	}
}

func TestPeaksShowSilenceThenToneAtTheRightFrame(t *testing.T) {
	needFFmpeg(t)
	e := newEnv(t, func(c *Config) { c.QCProfiles["broadcast-default"] = noLoudness(c.QCProfiles["broadcast-default"]) })
	ctx := context.Background()
	src := toneStepFixture(t, e.dir, 100) // 4 s, Ton ab 1,000 s = Bild 25
	e.file = filepath.Base(src)
	it := e.importReady(t)
	if _, err := e.svc.RequestProxy(ctx, it.AssetID, false); err != nil {
		t.Fatal(err)
	}
	if ran, err := e.svc.RunNextProxy(ctx); !ran || err != nil {
		t.Fatalf("proxy run: %v %v", ran, err)
	}
	pk, err := e.svc.Peaks(ctx, it.AssetID, 0)
	if err != nil || len(pk) != 100 {
		t.Fatalf("peaks: %v len=%d", err, len(pk))
	}
	first := -1
	for i, v := range pk {
		if v > 100 {
			first = i
			break
		}
	}
	if first < 24 || first > 26 {
		t.Errorf("Toneinsatz bei Bild %d, erwartet 25 (±1)", first)
	}
	// Mono-Mischung aus L 0,5 und R 0,25 = 0,375 FS (−8,5 dB): (−8,5+60)/60·255 ≈ 219
	if v := pk[60]; v < 212 || v > 226 {
		t.Errorf("Pegel Bild 60 = %d, erwartet ≈ 219", v)
	}
	if again, _ := e.svc.Peaks(ctx, it.AssetID, 0); string(again) != string(pk) {
		t.Error("zweiter Abruf (Zwischenspeicher) muss gleich sein")
	}
	if _, err := e.svc.Peaks(ctx, it.AssetID, 5); err == nil {
		t.Error("unbekannte Spur muss abgelehnt werden")
	}
}

func TestPeaksFromPCMScaleAndAlignment(t *testing.T) {
	// 2 Bilder à 8000/25 = 320 Samples; Bild 0 still, Bild 1 volle Aussteuerung
	pcm := make([]byte, 640*2)
	for i := 320; i < 640; i++ {
		pcm[2*i], pcm[2*i+1] = 0xFF, 0x7F // 32767
	}
	got := PeaksFromPCM(pcm, 8000, 3, 25, 1) // Bild 2 liegt hinter den Daten → Stille
	if got[0] != 0 || got[1] != 255 || got[2] != 0 {
		t.Errorf("peaks = %v", got)
	}
}
