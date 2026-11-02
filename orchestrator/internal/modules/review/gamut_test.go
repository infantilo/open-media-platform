package review

import (
	"context"
	"math"
	"testing"
)

// Dieselben Vektoren wie nodes/omp-scope/src/gamut.rs: beide Implementierungen müssen übereinstimmen.
func flatI420(w, h int, y, cb, cr byte) ([]byte, []byte, []byte) {
	fill := func(n int, v byte) []byte {
		b := make([]byte, n)
		for i := range b {
			b[i] = v
		}
		return b
	}
	return fill(w*h, y), fill(w*h/4, cb), fill(w*h/4, cr)
}

func TestMatrixFor(t *testing.T) {
	for _, c := range []struct {
		cs      string
		h       int
		want    string
		assumed bool
	}{
		{"bt709", 360, "BT.709", false}, {"smpte170m", 1080, "BT.601", false}, {"bt2020nc", 2160, "BT.2020", false},
		{"", 1080, "BT.709", true}, {"unknown", 576, "BT.601", true}, {"", 360, "BT.601", true},
	} {
		m, a := MatrixFor(c.cs, c.h)
		if m.Name != c.want || a != c.assumed {
			t.Errorf("MatrixFor(%q,%d) = %s,%v want %s,%v", c.cs, c.h, m.Name, a, c.want, c.assumed)
		}
	}
}

func TestMeasureGamutVectorsMatchScope(t *testing.T) {
	const w, h = 64, 36
	cases := []struct {
		name         string
		y, cb, cr    byte
		wantArea     float64
		wantYPercent float64
		wantRHigh    bool
	}{
		{"nominal grey", 126, 128, 128, 0, 0, false},
		{"nominal black", 16, 128, 128, 0, 0, false},
		{"nominal white", 235, 128, 128, 0, 0, false},
		{"superwhite", 250, 128, 128, 100, 100, false},
		{"subblack", 3, 128, 128, 100, 100, false},
		{"saturated red, legal luma", 100, 128, 240, 100, 0, true},
	}
	for _, c := range cases {
		y, u, v := flatI420(w, h, c.y, c.cb, c.cr)
		m, ok := MeasureGamut(y, u, v, w, h, MatrixBT709)
		if !ok {
			t.Fatalf("%s: not measured", c.name)
		}
		if math.Abs(m.Area-c.wantArea) > 1e-9 || math.Abs(m.Y-c.wantYPercent) > 1e-9 {
			t.Errorf("%s: area %.3f y %.3f, want %.0f / %.0f", c.name, m.Area, m.Y, c.wantArea, c.wantYPercent)
		}
		if c.wantRHigh && m.R < 99 {
			t.Errorf("%s: R share %.2f, want ~100", c.name, m.R)
		}
	}
	// kleiner Fleck unter 1 %: kein Überschreiten der Grenze
	y, u, v := flatI420(w, h, 126, 128, 128)
	for _, p := range [][2]int{{10, 10}, {10, 11}, {11, 10}, {11, 11}} {
		y[p[0]*w+p[1]] = 255
	}
	if m, _ := MeasureGamut(y, u, v, w, h, MatrixBT709); m.Area >= 1 {
		t.Errorf("small spot: area %.3f, want < 1", m.Area)
	}
	// einzelnes Pixel auf weißem Grund wird vom R-103-Filter unterdrückt
	y, u, v = flatI420(w, h, 235, 128, 128)
	y[18*w+32] = 255
	if m, _ := MeasureGamut(y, u, v, w, h, MatrixBT709); m.Area != 0 {
		t.Errorf("single spike: area %.3f, want 0", m.Area)
	}
	if _, ok := MeasureGamut(make([]byte, 10), make([]byte, 3), make([]byte, 3), w, h, MatrixBT709); ok {
		t.Error("wrong sizes accepted")
	}
}

// Echte Datei: ein Abschnitt (2–4 s) mit Y = 250 (über 246) muss als Gamut-Fehler gemeldet werden, der Rest nicht.
func TestRunQCReportsGamutErrorInterval(t *testing.T) {
	tools := needFFmpeg(t)
	file := makeFixture(t, "gamut.mxf", "lutyuv=y=250:enable='between(t,2,4)'", "anull")
	prof := DefaultQCProfile()
	prof.Loudness.Enabled = false
	o, err := tools.RunQC(context.Background(), file, prof, nil)
	if err != nil {
		t.Fatal(err)
	}
	gf := findings(o, "video.gamut")
	if len(gf) != 1 || gf[0].Status != CheckWarning {
		t.Fatalf("gamut findings = %+v", gf)
	}
	f := gf[0]
	if f.StartFrame == nil || *f.StartFrame < 49 || *f.StartFrame > 52 {
		t.Errorf("start frame = %v, want ~50 (2,0 s)", f.StartFrame)
	}
	if d, _ := f.Measured["durationS"].(float64); d < 1.5 || d > 2.6 {
		t.Errorf("duration = %v, want ~2 s", f.Measured["durationS"])
	}
	if f.Tool != "omp-r103" || f.ToolVer != "R 103 v3.0" {
		t.Errorf("provenance: %q %q", f.Tool, f.ToolVer)
	}
}

func TestRunQCGamutPassesLegalFileAndCanBeDisabled(t *testing.T) {
	tools := needFFmpeg(t)
	file := makeFixture(t, "legal.mxf", "lutyuv=y='clip(val\\,40\\,200)'", "anull")
	prof := DefaultQCProfile()
	prof.Loudness.Enabled = false
	o, err := tools.RunQC(context.Background(), file, prof, nil)
	if err != nil {
		t.Fatal(err)
	}
	gf := findings(o, "video.gamut")
	if len(gf) != 1 || gf[0].Status != CheckPass {
		t.Fatalf("legal file: %+v", gf)
	}
	prof.Gamut.Enabled = false
	o, _ = tools.RunQC(context.Background(), file, prof, nil)
	if len(findings(o, "video.gamut")) != 0 {
		t.Error("disabled check must not report")
	}
}
