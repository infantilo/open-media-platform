package review

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func needFFmpeg(t *testing.T) *Tools {
	t.Helper()
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg nicht installiert")
	}
	return NewTools("", "")
}

// makeFixture erzeugt eine kleine MPEG-2/PCM-MXF-Datei (wie das reale Anlieferprofil: 4:2:2, interlaced-Flag, mehrere
// Mono-Spuren) mit bekannten Mängeln: Schwarz 2,0–3,5 s, Standbild ab 6 s, Spur 2 stumm von 1–4 s.
func makeFixture(t *testing.T, name string, vf string, aTrack2 string, extra ...string) string {
	t.Helper()
	dir := t.TempDir()
	out := filepath.Join(dir, name)
	args := []string{"-v", "error", "-y",
		"-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=8,format=yuv422p," + vf,
		"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=8,volume=-20dB",
		"-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=8,volume=-20dB," + aTrack2,
		"-map", "0:v", "-map", "1:a", "-map", "2:a",
		"-c:v", "mpeg2video", "-pix_fmt", "yuv422p", "-b:v", "20M", "-flags", "+ildct+ilme", "-top", "1",
		"-c:a", "pcm_s24le", "-t", "8", "-timecode", "10:00:00:00"}
	args = append(args, extra...)
	args = append(args, "-f", "mxf", out)
	if b, err := exec.Command("ffmpeg", args...).CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v\n%s", err, b)
	}
	return out
}

func findings(o *QCOutput, id string) []Finding {
	var r []Finding
	for _, f := range o.Findings {
		if f.CheckID == id {
			r = append(r, f)
		}
	}
	return r
}

func TestRunQCFindsKnownDefects(t *testing.T) {
	tools := needFFmpeg(t)
	file := makeFixture(t, "defects.mxf",
		"drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(t,2,3.5)',loop=loop=60:size=1:start=150",
		"volume=enable='between(t,1,4)':volume=0")
	prof := DefaultQCProfile()
	o, err := tools.RunQC(context.Background(), file, prof, nil)
	if err != nil {
		t.Fatal(err)
	}
	if o.Overall != OverallFail && o.Overall != OverallWarning {
		t.Fatalf("overall = %s", o.Overall)
	}
	if o.Timeline == nil || o.Timeline.DurationFrames != 200 || o.Timeline.Rate.Num != 25 || o.Timeline.Timecode(0) != "10:00:00:00" {
		t.Fatalf("timeline = %+v", o.Timeline)
	}
	// Schwarz 2,0–3,5 s → Frames 50..87 (≥1 s Warnung)
	bl := findings(o, "video.black")
	if len(bl) != 1 || bl[0].Status != CheckWarning || bl[0].StartFrame == nil || *bl[0].StartFrame != 50 {
		t.Fatalf("black = %+v", bl)
	}
	// Spur 2 stumm 1–4 s → Fehler ab 10 s? nein: 3 s ≥ Warnschwelle 2 s → Warnung
	var silent *Finding
	for i, f := range findings(o, "audio.silence") {
		if f.Stream != nil && *f.Stream == 1 && f.Status != CheckPass {
			silent = &findings(o, "audio.silence")[i]
		}
	}
	if silent == nil || silent.Status != CheckWarning || *silent.StartFrame != 25 {
		t.Fatalf("silence = %+v", silent)
	}
	// Standbild bis Dateiende (Open) → mindestens eine Freeze-Meldung ab Frame 150
	var freezeFrom150 bool
	for _, f := range findings(o, "video.freeze") {
		if f.StartFrame != nil && *f.StartFrame >= 148 && *f.StartFrame <= 152 {
			freezeFrom150 = true
		}
	}
	if !freezeFrom150 {
		t.Fatalf("freeze not found: %+v", findings(o, "video.freeze"))
	}
	// Bericht enthält Werkzeug, Version, Zeitstempel, Regelsatz in jedem Befund
	for _, f := range o.Findings {
		if f.Tool == "" || f.ToolVer == "" || f.AnalyzedAt.IsZero() || f.Ruleset != "broadcast-default@1" {
			t.Fatalf("provenance missing: %+v", f)
		}
	}
	// ein sauberer Teil: Container/Timecode
	if tc := findings(o, "container.timecode"); len(tc) != 1 || tc[0].Status != CheckPass {
		t.Fatalf("timecode = %+v", tc)
	}
	if m := findings(o, "container.mxf"); len(m) != 1 {
		t.Fatal("mxf finding missing")
	}
}

func TestRunQCCleanFileIsNotFailing(t *testing.T) {
	tools := needFFmpeg(t)
	file := makeFixture(t, "clean.mxf", "null", "anull")
	prof := DefaultQCProfile()
	prof.Loudness.Enabled = false // 440/880 Hz −20 dB liegen nicht bei −23 LUFS
	o, err := tools.RunQC(context.Background(), file, prof, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range o.Findings {
		if f.Status == CheckFail {
			t.Errorf("unexpected failure: %+v", f)
		}
	}
	if o.Overall == OverallFail {
		t.Fatalf("overall = %s", o.Overall)
	}
}

func TestRunQCLoudnessAndTruePeakThresholds(t *testing.T) {
	tools := needFFmpeg(t)
	file := makeFixture(t, "loud.mxf", "null", "volume=0dB")
	prof := DefaultQCProfile()
	o, err := tools.RunQC(context.Background(), file, prof, nil)
	if err != nil {
		t.Fatal(err)
	}
	var sawLoud bool
	for _, f := range findings(o, "audio.loudness") {
		if f.Stream != nil && *f.Stream == 1 {
			sawLoud = true
			if f.Status != CheckFail { // 0 dBFS-Sinus ≈ −3 LUFS, Ziel −23
				t.Errorf("loudness status = %s (%s)", f.Status, f.Message)
			}
		}
	}
	if !sawLoud {
		t.Fatal("no loudness finding for track 2")
	}
	if tp := findings(o, "audio.true_peak"); len(tp) == 0 {
		t.Fatal("no true peak finding")
	}
}

func TestRunQCDeliveryProfileMismatch(t *testing.T) {
	tools := needFFmpeg(t)
	file := makeFixture(t, "d.mxf", "null", "anull")
	prof := DefaultQCProfile()
	prof.Loudness.Enabled = false
	prof.Expect.Width, prof.Expect.Height, prof.Expect.FrameRate = 1920, 1080, "25/1"
	prof.Expect.AudioTracks, prof.Expect.Captions = 8, true
	o, err := tools.RunQC(context.Background(), file, prof, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"delivery.resolution": CheckFail, "delivery.framerate": CheckPass, "delivery.audio_tracks": CheckFail, "content.captions": CheckFail}
	for id, st := range want {
		fs := findings(o, id)
		if len(fs) != 1 || fs[0].Status != st {
			t.Errorf("%s = %+v, want %s", id, fs, st)
		}
	}
}

func TestRunQCTruncatedFileIsReportedAsFinding(t *testing.T) {
	tools := needFFmpeg(t)
	file := makeFixture(t, "t.mxf", "null", "anull")
	raw, _ := os.ReadFile(file)
	cut := filepath.Join(t.TempDir(), "cut.mxf")
	if err := os.WriteFile(cut, raw[:len(raw)/2], 0o644); err != nil {
		t.Fatal(err)
	}
	prof := DefaultQCProfile()
	prof.Loudness.Enabled = false
	o, err := tools.RunQC(context.Background(), cut, prof, nil)
	if err != nil {
		t.Fatalf("a damaged file is a QC RESULT, not an execution error: %v", err)
	}
	if o.Overall != OverallFail {
		t.Fatalf("overall = %s, want fail", o.Overall)
	}
}

func TestRunQCGarbageFileFailsReadable(t *testing.T) {
	tools := needFFmpeg(t)
	f := filepath.Join(t.TempDir(), "x.mxf")
	_ = os.WriteFile(f, []byte(strings.Repeat("not media ", 100)), 0o644)
	o, err := tools.RunQC(context.Background(), f, DefaultQCProfile(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if o.Overall != OverallFail || len(findings(o, "container.readable")) != 1 || findings(o, "container.readable")[0].Status != CheckFail {
		t.Fatalf("%+v", o.Findings)
	}
}

// QC „nicht ausführbar“ (Werkzeug fehlt) ist ein Fehler des Aufrufs — kein Befund, kein „fail“.
func TestRunQCToolMissingIsExecutionError(t *testing.T) {
	tools := &Tools{FFmpeg: "", FFprobe: "", R: newOSRunner()}
	_, err := tools.RunQC(context.Background(), "/nonexistent", DefaultQCProfile(), nil)
	var ee *ExecError
	if err == nil || !asExec(err, &ee) {
		t.Fatalf("err = %v, want *ExecError", err)
	}
}

func asExec(err error, target **ExecError) bool {
	e, ok := err.(*ExecError)
	if ok {
		*target = e
	}
	return ok
}
