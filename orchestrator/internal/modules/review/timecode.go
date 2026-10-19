package review

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// Zeitmodell des Review-Moduls (UMSETZUNG.md Kapitel 43):
//
//   - Positionen sind **ganzzahlige Frame-Indizes** (0 = erstes Bild der Datei), nie Gleitkommasekunden.
//   - Die Bildrate ist ein exakter Bruch (30000/1001 statt 29.97).
//   - Bereiche sind **[in, out)**: In inklusiv, Out exklusiv. Ein Segment mit in=0, out=Dauer deckt die ganze Datei.
//   - Timecode ist reine Darstellung: Frame-Index + `StartFrames` (Start-Timecode der Datei) → Anzeige.
//
// Die TypeScript-Spiegelung (ui/modules/review/timecode.ts) nutzt dieselben Testvektoren
// (testdata/timecode_vectors.json).

// Rate ist eine exakte Bildrate Num/Den.
type Rate struct {
	Num int64 `json:"num"`
	Den int64 `json:"den"`
}

var ErrBadRate = errors.New("review: ungültige Bildrate")

// ParseRate liest "25", "25/1" oder "30000/1001".
func ParseRate(s string) (Rate, error) {
	s = strings.TrimSpace(s)
	num, den := s, "1"
	if i := strings.IndexByte(s, '/'); i >= 0 {
		num, den = s[:i], s[i+1:]
	}
	n, err1 := strconv.ParseInt(num, 10, 64)
	d, err2 := strconv.ParseInt(den, 10, 64)
	if err1 != nil || err2 != nil || n <= 0 || d <= 0 {
		return Rate{}, fmt.Errorf("%w: %q", ErrBadRate, s)
	}
	g := gcd(n, d)
	return Rate{Num: n / g, Den: d / g}, nil
}

func gcd(a, b int64) int64 {
	for b != 0 {
		a, b = b, a%b
	}
	return a
}

func (r Rate) Valid() bool { return r.Num > 0 && r.Den > 0 }

// Float nur für Anzeige/Grobwerte — nie für Positionsrechnung.
func (r Rate) Float() float64 { return float64(r.Num) / float64(r.Den) }

// Nominal ist die ganzzahlige Timecode-Rate (24, 25, 30, 50, 60 …).
func (r Rate) Nominal() int64 { return (r.Num + r.Den/2) / r.Den }

// DropCapable: nur 30000/1001 und 60000/1001 kennen Drop-Frame-Timecode.
func (r Rate) DropCapable() bool {
	return r.Den == 1001 && (r.Num == 30000 || r.Num == 60000)
}

func (r Rate) dropFrames() int64 { return 2 * r.Nominal() / 30 }

// FrameStartNs ist die früheste ganze Nanosekunde, in der Bild n sichtbar ist (aufgerundet, damit
// FrameAtNs(FrameStartNs(n)) == n gilt).
func (r Rate) FrameStartNs(n int64) int64 {
	return (n*r.Den*1_000_000_000 + r.Num - 1) / r.Num
}

// FrameAtNs ist der Index des Bildes, das zur Zeit ns angezeigt wird (floor).
func (r Rate) FrameAtNs(ns int64) int64 {
	if ns < 0 {
		return 0
	}
	return ns * r.Num / (r.Den * 1_000_000_000)
}

// FormatTimecode formatiert den Frame-Zähler `frame` (bereits inkl. Start-Offset) als HH:MM:SS:FF
// (Drop-Frame mit ';' vor den Bildern).
func FormatTimecode(frame int64, r Rate, drop bool) string {
	if frame < 0 {
		frame = 0
	}
	fps := r.Nominal()
	sep := ":"
	if drop && r.DropCapable() {
		sep = ";"
		d := r.dropFrames()
		perMin := fps*60 - d // Bilder je "gekürzter" Minute
		per10 := perMin*10 + d
		tens := frame / per10
		rem := frame % per10
		frame += 9 * d * tens
		if rem >= d {
			frame += d * ((rem - d) / perMin)
		}
	}
	ff := frame % fps
	s := frame / fps
	return fmt.Sprintf("%02d:%02d:%02d%s%02d", s/3600%100, s/60%60, s%60, sep, ff)
}

// ParseTimecode liest HH:MM:SS:FF bzw. HH:MM:SS;FF und liefert den Frame-Zähler. ';' (oder '.') vor den Bildern
// kennzeichnet Drop-Frame.
func ParseTimecode(s string, r Rate) (frame int64, drop bool, err error) {
	s = strings.TrimSpace(s)
	if len(s) != 11 || s[2] != ':' || s[5] != ':' || (s[8] != ':' && s[8] != ';' && s[8] != '.') {
		return 0, false, fmt.Errorf("review: ungültiger Timecode %q (erwartet HH:MM:SS:FF)", s)
	}
	drop = s[8] != ':'
	var hh, mm, ss, ff int64
	for i, p := range []*int64{&hh, &mm, &ss, &ff} {
		a := []int{0, 3, 6, 9}[i]
		v, e := strconv.ParseInt(s[a:a+2], 10, 64)
		if e != nil || v < 0 {
			return 0, false, fmt.Errorf("review: ungültiger Timecode %q", s)
		}
		*p = v
	}
	fps := r.Nominal()
	if mm > 59 || ss > 59 || ff >= fps {
		return 0, false, fmt.Errorf("review: Timecode %q außerhalb des Bereichs für %d fps", s, fps)
	}
	if drop && !r.DropCapable() {
		return 0, false, fmt.Errorf("review: Drop-Frame-Timecode gibt es bei dieser Bildrate nicht")
	}
	total := (hh*3600+mm*60+ss)*fps + ff
	if drop {
		d := r.dropFrames()
		if ss == 0 && ff < d && mm%10 != 0 {
			return 0, false, fmt.Errorf("review: Drop-Frame-Timecode %q existiert nicht (Bilder %d–%d fehlen)", s, 0, d-1)
		}
		totalMin := hh*60 + mm
		total -= d * (totalMin - totalMin/10)
	}
	return total, drop, nil
}

// Timeline beschreibt die Zeitachse einer Datei.
type Timeline struct {
	Rate           Rate  `json:"rate"`
	DurationFrames int64 `json:"durationFrames"`
	// StartFrames: Start-Timecode der Datei als Frame-Zähler (0 = 00:00:00:00).
	StartFrames int64 `json:"startFrames"`
	DropFrame   bool  `json:"dropFrame"`
	// VFR: variable Bildrate erkannt — Frame-Indizes beziehen sich dann auf den CFR-Review-Proxy (nur näherungsweise).
	VFR bool `json:"vfr,omitempty"`
}

// Timecode des Bildes n der Datei.
func (t Timeline) Timecode(n int64) string {
	return FormatTimecode(t.StartFrames+n, t.Rate, t.DropFrame)
}

// FrameForTimecode: Frame-Index (relativ zum Dateianfang) für einen Timecode; Fehler außerhalb [0, Dauer].
func (t Timeline) FrameForTimecode(tc string) (int64, error) {
	c, _, err := ParseTimecode(tc, t.Rate)
	if err != nil {
		return 0, err
	}
	n := c - t.StartFrames
	if n < 0 || n > t.DurationFrames {
		return 0, fmt.Errorf("review: Timecode %s liegt außerhalb der Datei", tc)
	}
	return n, nil
}

// ValidateRange prüft [in, out) gegen die Datei: 0 ≤ in < out ≤ Dauer, mindestens minFrames lang.
func (t Timeline) ValidateRange(in, out, minFrames int64) error {
	if minFrames < 1 {
		minFrames = 1
	}
	switch {
	case in < 0:
		return fmt.Errorf("In-Punkt %d liegt vor dem Dateianfang", in)
	case out > t.DurationFrames:
		return fmt.Errorf("Out-Punkt %d liegt hinter dem Dateiende (%d Bilder)", out, t.DurationFrames)
	case out-in < minFrames:
		return fmt.Errorf("Bereich [%d, %d) ist kürzer als %d Bild(er)", in, out, minFrames)
	}
	return nil
}
