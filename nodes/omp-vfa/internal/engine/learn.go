package engine

import (
	"math"
	"sort"
)

// Candidate ist ein Gesicht, das während des Sprechens an einer Stelle einer
// Kamera gesehen wurde. SeenPct = Anteil der Abtastungen, in denen es dort war.
type Candidate struct {
	CameraID    string  `json:"cameraId"`
	CenterX     float64 `json:"centerX"`
	CenterY     float64 `json:"centerY"`
	SizePercent float64 `json:"sizePercent"`
	SeenPct     int     `json:"seenPct"`
}

type bucket struct {
	n          int
	sx, sy, ss float64
}

// Learner sammelt Gesichter, während eine Person spricht („Person spricht
// jetzt“ in der Einrichtung). Gesichter werden je Kamera nach Position in
// Zehntel-Streifen zusammengefasst.
type Learner struct {
	micDb   float64
	samples int
	cams    map[string]map[int]*bucket
}

func NewLearner(speakDb float64) *Learner {
	return &Learner{micDb: speakDb, cams: map[string]map[int]*bucket{}}
}

// Add nimmt eine Abtastung auf; zählt nur, wenn der Mikrofonpegel über der
// Sprechschwelle liegt.
func (l *Learner) Add(micDb float64, faces map[string][]Face) {
	if micDb <= l.micDb {
		return
	}
	l.samples++
	for cam, fs := range faces {
		for _, f := range fs {
			k := int(math.Floor(f.CenterX * 10))
			m := l.cams[cam]
			if m == nil {
				m = map[int]*bucket{}
				l.cams[cam] = m
			}
			b := m[k]
			if b == nil {
				b = &bucket{}
				m[k] = b
			}
			b.n++
			b.sx += f.CenterX
			b.sy += f.CenterY
			b.ss += f.SizePercent
		}
	}
}

func (l *Learner) Samples() int { return l.samples }

// Candidates liefert Vorschläge, die in mindestens minPct % der Sprech-
// Abtastungen zu sehen waren, nach Häufigkeit sortiert.
func (l *Learner) Candidates(minPct int) []Candidate {
	var out []Candidate
	if l.samples == 0 {
		return out
	}
	for cam, m := range l.cams {
		for _, b := range m {
			pct := b.n * 100 / l.samples
			if pct < minPct {
				continue
			}
			n := float64(b.n)
			out = append(out, Candidate{cam, round(b.sx / n), round(b.sy / n), math.Round(b.ss/n*10) / 10, pct})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].SeenPct != out[j].SeenPct {
			return out[i].SeenPct > out[j].SeenPct
		}
		if out[i].CameraID != out[j].CameraID {
			return out[i].CameraID < out[j].CameraID
		}
		return out[i].CenterX < out[j].CenterX
	})
	return out
}

func round(v float64) float64 { return math.Round(v*1000) / 1000 }
