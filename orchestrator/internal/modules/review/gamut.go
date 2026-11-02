package review

import (
	"context"
	"fmt"
	"math"
)

// Gamut-Prüfung nach EBU R 103 v3.0 (Mai 2020, Annex 1) für die Datei-QC — Kapitel 78.4.
//
// Dieselbe Rechenvorschrift wie nodes/omp-scope/src/gamut.rs (Live-Messung); beide werden mit denselben
// Testvektoren geprüft. Normtext, soweit umgesetzt:
//   - R, G, B und Y sollen den bevorzugten Bereich nicht verlassen, 8 Bit: 5 … 246 (10 Bit: 20 … 984 = 4×);
//   - „Out-of-Gamut“ erst, wenn der Fehler 1 % des Bildes überschreitet;
//   - vor der Messung filtern: horizontal 1/16·(1,2,3,4,3,2,1), vertikal 1/4·(1,2,1).
//
// Grenzen (im Befund und in der Doku benannt): gemessen wird auf einem herunterskalierten Bild
// (gamutW×gamutH) und nur an Stichproben (SampleFPS), nicht an jedem Bild in voller Auflösung; Matrix nach
// Stream-Tag (sonst geraten nach Zeilenzahl, im Befund vermerkt); Mindestdauer und Warn-/Fehlerschwelle sind OMP-Profilwerte, keine Vorgabe der Norm.

const (
	gamutW, gamutH = 320, 180
	gamutMin       = 5.0
	gamutMax       = 246.0
	// gamutWindowS: Länge eines ffmpeg-Laufs. Die Rohbilder kommen über stdout (Obergrenze maxStdout); ein Fenster
	// bleibt mit Reserve darunter: 120 s · 2 Bilder/s · 86,4 kB ≈ 21 MB.
	gamutWindowS = 120.0
)

// GamutMatrix: Koeffizienten der YCbCr→R′G′B′-Umrechnung. Die falsche Matrix verschiebt Farbtöne und erzeugt
// scheinbare Gamut-Fehler (Fund beim Testen: ffmpeg kodiert ungetaggtes SD/Test-Material mit BT.601).
type GamutMatrix struct {
	Name               string
	CrR, CbG, CrG, CbB float32
}

var (
	MatrixBT601  = GamutMatrix{"BT.601", 1.402, 0.344136, 0.714136, 1.772}
	MatrixBT709  = GamutMatrix{"BT.709", 1.5748, 0.1873, 0.4681, 1.8556}
	MatrixBT2020 = GamutMatrix{"BT.2020", 1.4746, 0.16455, 0.57135, 1.8814}
)

// MatrixFor wählt die Matrix nach dem ffprobe-Wert color_space; fehlt er oder ist er unbekannt, gilt die übliche
// Konvention: ab 720 Zeilen BT.709, darunter BT.601. assumed=true, wenn geraten wurde.
func MatrixFor(colorSpace string, height int) (m GamutMatrix, assumed bool) {
	switch colorSpace {
	case "bt709":
		return MatrixBT709, false
	case "smpte170m", "bt470bg", "bt470m":
		return MatrixBT601, false
	case "bt2020nc", "bt2020c":
		return MatrixBT2020, false
	}
	if height >= 720 {
		return MatrixBT709, true
	}
	return MatrixBT601, true
}

// GamutResult: Anteile in Prozent der Bildfläche.
type GamutResult struct {
	Area, R, G, B, Y, High, Low float64
}

func gamutFilter(p []float32, w, h int) []float32 {
	k := [7]float32{1, 2, 3, 4, 3, 2, 1}
	tmp := make([]float32, w*h)
	for row := 0; row < h; row++ {
		for x := 0; x < w; x++ {
			var acc float32
			for i, c := range k {
				xi := x + i - 3
				if xi < 0 {
					xi = 0
				}
				if xi > w-1 {
					xi = w - 1
				}
				acc += c * p[row*w+xi]
			}
			tmp[row*w+x] = acc / 16
		}
	}
	out := make([]float32, w*h)
	for row := 0; row < h; row++ {
		up, down := row-1, row+1
		if up < 0 {
			up = 0
		}
		if down > h-1 {
			down = h - 1
		}
		for x := 0; x < w; x++ {
			out[row*w+x] = (tmp[up*w+x] + 2*tmp[row*w+x] + tmp[down*w+x]) / 4
		}
	}
	return out
}

// MeasureGamut misst ein I420-Bild mit der gegebenen Matrix (8 Bit, Video-Range, dicht gepackt). ok=false bei unpassenden Größen.
func MeasureGamut(y, u, v []byte, w, h int, mx GamutMatrix) (GamutResult, bool) {
	if w < 2 || h < 2 || len(y) != w*h || len(u) != (w/2)*(h/2) || len(v) != len(u) {
		return GamutResult{}, false
	}
	cw := w / 2
	r, g, b, l := make([]float32, w*h), make([]float32, w*h), make([]float32, w*h), make([]float32, w*h)
	for row := 0; row < h; row++ {
		for x := 0; x < w; x++ {
			i := row*w + x
			ci := (row/2)*cw + x/2
			yy := (float32(y[i]) - 16) / 219
			cb := (float32(u[ci]) - 128) / 224
			cr := (float32(v[ci]) - 128) / 224
			r[i] = 16 + 219*(yy+mx.CrR*cr)
			g[i] = 16 + 219*(yy-mx.CbG*cb-mx.CrG*cr)
			b[i] = 16 + 219*(yy+mx.CbB*cb)
			l[i] = float32(y[i])
		}
	}
	r, g, b, l = gamutFilter(r, w, h), gamutFilter(g, w, h), gamutFilter(b, w, h), gamutFilter(l, w, h)
	var any, rc, gc, bc, yc, hi, lo int
	for i := 0; i < w*h; i++ {
		comps := [4]float32{r[i], g[i], b[i], l[i]}
		var out [4]bool
		bad, high, low := false, false, false
		for k, c := range comps {
			out[k] = c < gamutMin || c > gamutMax
			bad = bad || out[k]
			high = high || c > gamutMax
			low = low || c < gamutMin
		}
		if out[0] {
			rc++
		}
		if out[1] {
			gc++
		}
		if out[2] {
			bc++
		}
		if out[3] {
			yc++
		}
		if bad {
			any++
		}
		if high {
			hi++
		}
		if low {
			lo++
		}
	}
	n := float64(w * h)
	pc := func(c int) float64 { return float64(c) / n * 100 }
	return GamutResult{Area: pc(any), R: pc(rc), G: pc(gc), B: pc(bc), Y: pc(yc), High: pc(hi), Low: pc(lo)}, true
}

// gamutPass tastet die Datei mit prof.Gamut.SampleFPS ab, misst jede Stichprobe nach R 103 und meldet
// zusammenhängende Abschnitte, in denen der Fehler die Flächengrenze überschreitet.
func (q *qcCtx) gamutPass(ctx context.Context, file string, video map[string]any, tl *Timeline, vStart float64) error {
	g := q.prof.Gamut
	if !g.Enabled {
		return nil
	}
	const id = "video.gamut"
	dur := gn(video, "duration")
	if math.IsNaN(dur) || dur <= 0 {
		dur = float64(tl.DurationFrames) / tl.Rate.Float()
	}
	fps := g.SampleFPS
	if fps <= 0 || fps > 10 {
		fps = 2
	}
	limit := g.AreaLimitPercent
	if limit <= 0 {
		limit = 1 // R 103 v3.0
	}
	mx, assumed := MatrixFor(gs(video, "color_space"), int(gn(video, "height")))
	frameBytes := gamutW*gamutH + 2*(gamutW/2)*(gamutH/2)
	step := 1 / fps

	var iv []Interval
	var open *float64
	maxArea, bad, total := 0.0, 0, 0
	for start := 0.0; start < dur; start += gamutWindowS {
		out, code, err := q.t.Exec().Run(ctx, q.t.FFmpeg, []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-ss", fmt.Sprintf("%.3f", start),
			"-t", fmt.Sprintf("%.3f", gamutWindowS), "-i", file, "-map", "0:v:0", "-an", "-vf",
			fmt.Sprintf("fps=%g,scale=%d:%d:flags=area:out_range=tv,format=yuv420p", fps, gamutW, gamutH), "-f", "rawvideo", "-"}, nil)
		if err != nil {
			return qcExec("video.gamut", err)
		}
		if code != 0 {
			q.notEvaluated(id, CatVideo, fmt.Sprintf("Gamut-Analyse endete mit Exit-Code %d", code), true, "ffmpeg")
			return nil
		}
		for i := 0; (i+1)*frameBytes <= len(out); i++ {
			f := out[i*frameBytes : (i+1)*frameBytes]
			ySize, cSize := gamutW*gamutH, (gamutW/2)*(gamutH/2)
			m, ok := MeasureGamut(f[:ySize], f[ySize:ySize+cSize], f[ySize+cSize:], gamutW, gamutH, mx)
			if !ok {
				continue
			}
			t := vStart + start + float64(i)*step
			total++
			if m.Area > maxArea {
				maxArea = m.Area
			}
			if m.Area > limit {
				bad++
				if open == nil {
					s := t
					open = &s
				}
			} else if open != nil {
				iv = append(iv, Interval{Start: *open, End: t})
				open = nil
			}
		}
	}
	if open != nil {
		iv = append(iv, Interval{Start: *open, End: vStart + dur, Open: true})
	}
	if total == 0 {
		q.notEvaluated(id, CatVideo, "Gamut-Analyse lieferte keine Bilder", true, "ffmpeg")
		return nil
	}
	n := len(q.findings)
	q.intervalFindings(id, CatVideo, "Gamut-Fehler (EBU R 103)", iv, tl, vStart, dur, g.WarnAboveS, g.FailAboveS, math.Max(g.MinDurationS, step), 0, 0, nil, "R 103 v3.0")
	for i := n; i < len(q.findings); i++ {
		q.findings[i].Tool = "omp-r103"
		q.findings[i].ToolVer = "R 103 v3.0"
		if q.findings[i].Measured == nil {
			q.findings[i].Measured = map[string]any{}
		}
		q.findings[i].Measured["samples"] = total
		q.findings[i].Measured["samplesOver"] = bad
		q.findings[i].Measured["maxAreaPercent"] = round3(maxArea)
		q.findings[i].Measured["sampleFps"] = fps
		q.findings[i].Measured["matrix"] = mx.Name
		q.findings[i].Measured["matrixAssumed"] = assumed
		q.findings[i].Threshold["areaLimitPercent"] = limit
		q.findings[i].Threshold["preferredRange8bit"] = "5-246"
	}
	return nil
}
