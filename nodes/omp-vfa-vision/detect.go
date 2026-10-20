package main

import (
	"bytes"
	_ "embed"
	"fmt"
	"image"
	"image/jpeg"
	"math"

	pigo "github.com/esimov/pigo/core"
)

//go:embed cascade/facefinder
var facefinderCascade []byte

// Face ist ein erkanntes Gesicht in normierten Koordinaten (0..1 bzw. Prozent
// der Bildbreite). Es werden bewusst nur Position und Größe bestimmt, nie
// Identitäten — die Zuordnung Person↔Kamera macht omp-vfa.
type Face struct {
	CenterX     float64 `json:"center_x"`
	CenterY     float64 `json:"center_y"`
	SizePercent float64 `json:"size_percent"`
}

// maxWidth begrenzt die Rechenbreite: Gesichter für die Kamerawahl sind groß,
// ein 320-px-Bild genügt und hält die CPU-Last pro Kamera im niedrigen Prozentbereich.
const maxWidth = 320

// Detector kapselt den Pico-Klassifikator. Nach dem Laden nur lesend benutzt,
// daher von mehreren Kamera-Goroutinen gleichzeitig verwendbar.
type Detector struct {
	cls  *pigo.Pigo
	minQ float32
}

func NewDetector(minQ float32) (*Detector, error) {
	cls, err := pigo.NewPigo().Unpack(facefinderCascade)
	if err != nil {
		return nil, fmt.Errorf("cascade laden: %w", err)
	}
	return &Detector{cls: cls, minQ: minQ}, nil
}

// DetectJPEG dekodiert ein Vorschaubild und liefert die Gesichter.
func (d *Detector) DetectJPEG(data []byte) ([]Face, error) {
	img, err := jpeg.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("jpeg: %w", err)
	}
	return d.Detect(img), nil
}

func (d *Detector) Detect(img image.Image) []Face {
	pix, w, h := luma(img)
	if w == 0 || h == 0 {
		return nil
	}
	minSize := h / 8
	if minSize < 20 {
		minSize = 20
	}
	cp := pigo.CascadeParams{
		MinSize:     minSize,
		MaxSize:     h,
		ShiftFactor: 0.12,
		ScaleFactor: 1.15,
		ImageParams: pigo.ImageParams{Pixels: pix, Rows: h, Cols: w, Dim: w},
	}
	dets := d.cls.ClusterDetections(d.cls.RunCascade(cp, 0), 0.2)
	faces := make([]Face, 0, len(dets))
	for _, det := range dets {
		if det.Q < d.minQ {
			continue
		}
		faces = append(faces, Face{
			CenterX:     round(float64(det.Col)/float64(w), 3),
			CenterY:     round(float64(det.Row)/float64(h), 3),
			SizePercent: round(float64(det.Scale)/float64(w)*100, 1),
		})
	}
	return faces
}

// luma liefert die Helligkeitsebene, auf maxWidth heruntergetaktet. Bei
// JPEG (YCbCr) ist das die Y-Ebene direkt — keine Farbumrechnung nötig.
func luma(img image.Image) ([]uint8, int, int) {
	b := img.Bounds()
	step := 1
	for b.Dx()/step > maxWidth {
		step++
	}
	w, h := b.Dx()/step, b.Dy()/step
	out := make([]uint8, w*h)
	if yc, ok := img.(*image.YCbCr); ok {
		for y := 0; y < h; y++ {
			row := yc.Y[yc.YOffset(b.Min.X, b.Min.Y+y*step):]
			for x := 0; x < w; x++ {
				out[y*w+x] = row[x*step]
			}
		}
		return out, w, h
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			r, g, bl, _ := img.At(b.Min.X+x*step, b.Min.Y+y*step).RGBA()
			out[y*w+x] = uint8((299*r + 587*g + 114*bl) / 1000 >> 8)
		}
	}
	return out, w, h
}

func round(v float64, digits int) float64 {
	p := math.Pow(10, float64(digits))
	return math.Round(v*p) / p
}
