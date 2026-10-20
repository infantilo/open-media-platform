package engine

import (
	"math"
	"time"
)

// Cut ist die Entscheidung „diese Kamera jetzt auf Sendung“.
type Cut struct {
	CameraID string `json:"cameraId"`
	PersonID string `json:"personId,omitempty"`
	Reason   string `json:"reason"` // speaker | wide
}

// Engine hält nur Zeitzustand (Sprecher-Haltezeit, letzter Schnitt).
type Engine struct {
	cfg       Config
	current   string // Kamera, die zuletzt geschaltet wurde
	lastCut   time.Time
	candidate string // Person, die gerade spricht
	candSince time.Time
	lastVoice time.Time
	started   bool
}

func New(cfg Config) *Engine { return &Engine{cfg: cfg} }

func (e *Engine) SetConfig(cfg Config) { e.cfg = cfg }

// Current liefert die zuletzt geschaltete Kamera (leer = noch keine).
func (e *Engine) Current() string { return e.current }

// Speaker liefert die Person mit dem höchsten Pegel über der Schwelle.
func (e *Engine) Speaker(levels map[string]float64) (Person, bool) {
	var best Person
	bestDb := e.cfg.SpeakDb
	found := false
	for _, p := range e.cfg.People {
		db, ok := levels[p.Mic]
		if ok && p.Mic != "" && db > bestDb {
			best, bestDb, found = p, db, true
		}
	}
	return best, found
}

// Tick wertet Pegel (dBFS je Mikrofonkanal) und Gesichter (je Kamera) aus.
// Liefert nur dann einen Schnitt, wenn sich etwas ändern soll.
func (e *Engine) Tick(now time.Time, levels map[string]float64, faces map[string][]Face) *Cut {
	if !e.started {
		e.started = true
		e.lastVoice = now
	}
	sp, ok := e.Speaker(levels)
	if ok {
		e.lastVoice = now
		if e.candidate != sp.ID {
			e.candidate, e.candSince = sp.ID, now
		}
		if now.Sub(e.candSince) < time.Duration(e.cfg.SpeakHoldMs)*time.Millisecond {
			return nil
		}
		cam := e.pick(sp, faces)
		if cam == "" || cam == e.current {
			return nil
		}
		if e.current != "" && now.Sub(e.lastCut) < time.Duration(e.cfg.MinShotMs)*time.Millisecond {
			return nil
		}
		return e.cut(now, cam, sp.ID, "speaker")
	}
	e.candidate = ""
	if e.cfg.WideCamera != "" && e.cfg.WideAfterSec > 0 && e.current != e.cfg.WideCamera &&
		now.Sub(e.lastVoice) >= time.Duration(e.cfg.WideAfterSec)*time.Second &&
		now.Sub(e.lastCut) >= time.Duration(e.cfg.MinShotMs)*time.Millisecond {
		return e.cut(now, e.cfg.WideCamera, "", "wide")
	}
	return nil
}

func (e *Engine) cut(now time.Time, cam, person, reason string) *Cut {
	e.current, e.lastCut = cam, now
	return &Cut{CameraID: cam, PersonID: person, Reason: reason}
}

// pick wählt die Kamera für eine sprechende Person: bevorzugt die erste
// bestätigte Einstellung, in der die Person gerade wirklich an ihrem Platz
// zu sehen ist. Sieht sie keine Kamera, bleibt das Bild stehen, sofern ihre
// aktuelle Kamera noch passt; sonst zählt die erste Einstellung.
func (e *Engine) pick(p Person, faces map[string][]Face) string {
	for _, s := range p.Shots {
		if e.visible(s, faces[s.CameraID]) {
			return s.CameraID
		}
	}
	for _, s := range p.Shots {
		if s.CameraID == e.current {
			return ""
		}
	}
	if len(p.Shots) > 0 {
		return p.Shots[0].CameraID
	}
	return ""
}

func (e *Engine) visible(s Shot, faces []Face) bool {
	for _, f := range faces {
		if math.Abs(f.CenterX-s.CenterX) <= e.cfg.FaceTolerance {
			return true
		}
	}
	return false
}
