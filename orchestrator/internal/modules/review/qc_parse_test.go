package review

import (
	"context"
	"errors"
	"math"
	"testing"
)

func TestIntervalParser(t *testing.T) {
	p := &IntervalParser{}
	for _, l := range []string{
		"[blackdetect @ 0x1] black_start:2 black_end:3.52 black_duration:1.52",
		"[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 2",
		"[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: 1.52",
		"[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 3.52",
		"[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 5.96",
		"[silencedetect @ 0x2] silence_start: 1.0",
		"[silencedetect @ 0x2] silence_end: 4.0 | silence_duration: 3.0",
		"[silencedetect @ 0x2] silence_start: 7",
	} {
		p.Line(l)
	}
	p.Finish(8)
	if len(p.Black) != 1 || p.Black[0].Dur() < 1.51 || p.Black[0].Dur() > 1.53 {
		t.Fatalf("black %+v", p.Black)
	}
	if len(p.Freeze) != 2 || p.Freeze[1].Start != 5.96 || !p.Freeze[1].Open || p.Freeze[1].End != 8 {
		t.Fatalf("freeze %+v", p.Freeze)
	}
	if len(p.Silence) != 2 || p.Silence[0].Dur() != 3 || !p.Silence[1].Open {
		t.Fatalf("silence %+v", p.Silence)
	}
}

func TestParseLoudnessUsesOnlySummary(t *testing.T) {
	lines := []string{
		"[Parsed_ebur128_0 @ 0x1] t: 0.1 TARGET:-23 LUFS    M: -50.0 S: -120.7     I: -70.0 LUFS     LRA:   0.0 LU",
		"[Parsed_ebur128_0 @ 0x1] Summary:",
		"",
		"  Integrated loudness:",
		"    I:         -23.4 LUFS",
		"    Threshold: -33.4 LUFS",
		"",
		"  Loudness range:",
		"    LRA:         5.2 LU",
		"    Threshold:  -43.4 LUFS",
		"",
		"  True peak:",
		"    Peak:       -1.5 dBFS",
	}
	l, ok := ParseLoudness(lines)
	if !ok || l.IntegratedLUFS != -23.4 || l.LRA != 5.2 || l.TruePeakDBFS != -1.5 {
		t.Fatalf("%+v %v", l, ok)
	}
	if _, ok := ParseLoudness(lines[:1]); ok {
		t.Fatal("per-frame lines without Summary must not count")
	}
	silent, _ := ParseLoudness([]string{"Summary:", "  Integrated loudness:", "    I:           0.0 LUFS", "  True peak:", "    Peak:       -inf dBFS"})
	if !math.IsInf(silent.TruePeakDBFS, -1) {
		t.Fatalf("%+v", silent)
	}
}

func TestParseIdetAndAstats(t *testing.T) {
	d, ok := ParseIdet([]string{"[Parsed_idet_2 @ 0x1] Multi frame detection: TFF:     3 BFF:     0 Progressive:   190 Undetermined:     7"})
	if !ok || d.TFF != 3 || d.Progressive != 190 || d.Total() != 200 {
		t.Fatalf("%+v", d)
	}
	a, ok := ParseAstats([]string{"[Parsed_astats_2 @ 0x1] Peak level dB: -38.0", "[Parsed_astats_2 @ 0x1] Overall", "[Parsed_astats_2 @ 0x1] Peak level dB: -12.5", "[Parsed_astats_2 @ 0x1] Number of samples: 384000"})
	if !ok || a.PeakDB != -12.5 || a.Samples != 384000 {
		t.Fatalf("%+v", a)
	}
}

type fakeRunner struct {
	fn func(name string, args []string) ([]byte, int, error)
}

func (f fakeRunner) Run(_ context.Context, name string, args []string, _ func(string)) ([]byte, int, error) {
	return f.fn(name, args)
}

// Zeitlimit/Abbruch/Startfehler → ExecError; ein Exit-Code ≠ 0 mit Fehlermeldung → Befund. Genau diese Trennung verlangt die Aufgabe.
func TestExecFailureVersusMediaFailure(t *testing.T) {
	probeFail := fakeRunner{fn: func(name string, args []string) ([]byte, int, error) {
		if len(args) > 0 && args[len(args)-1] == "-version" {
			return []byte("ffmpeg version 9.9.9\n"), 0, nil
		}
		if len(args) > 0 && args[len(args)-1] == "-filters" {
			return []byte(" ... blackdetect V->V x\n"), 0, nil
		}
		return []byte(`{"error":{"code":-1094995529,"string":"Invalid data found when processing input"}}`), 1, nil
	}}
	tools := &Tools{FFmpeg: "ffmpeg", FFprobe: "ffprobe", R: probeFail}
	o, err := tools.RunQC(context.Background(), "x.mxf", DefaultQCProfile(), nil)
	if err != nil || o.Overall != OverallFail {
		t.Fatalf("media failure must be a fail result: %v %+v", err, o)
	}

	broken := fakeRunner{fn: func(name string, args []string) ([]byte, int, error) {
		if args[len(args)-1] == "-version" {
			return []byte("ffmpeg version 9.9.9\n"), 0, nil
		}
		if args[len(args)-1] == "-filters" {
			return nil, 0, nil
		}
		return nil, -1, context.DeadlineExceeded
	}}
	tools = &Tools{FFmpeg: "ffmpeg", FFprobe: "ffprobe", R: broken}
	_, err = tools.RunQC(context.Background(), "x.mxf", DefaultQCProfile(), nil)
	var ee *ExecError
	if !errors.As(err, &ee) {
		t.Fatalf("timeout must be an ExecError, got %v", err)
	}
}
