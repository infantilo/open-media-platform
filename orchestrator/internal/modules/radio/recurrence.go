package radio

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/modules/ingest"
)

// Recurrence beschreibt, wann aus einer Vorlage Sendungen entstehen: wöchentlich an bestimmten Wochentagen zur Wanduhrzeit in einer
// IANA-Zeitzone (Sommerzeit-fest, Berechnung wie im Modul „ingest“). Die Sendungen werden `HorizonDays` im Voraus als Entwurf
// angelegt, damit Moderierende sie früh vorbereiten können.
type Recurrence struct {
	Enabled     bool     `json:"enabled"`
	TZ          string   `json:"tz"`
	Time        string   `json:"time"`        // HH:MM Wanduhr
	DurationMin int      `json:"durationMin"` // Dauer in Minuten
	ByDay       []string `json:"byDay"`       // MO,TU,WE,TH,FR,SA,SU
	HorizonDays int      `json:"horizonDays"` // wie weit im Voraus (1–90, Standard 14)
	// Until: letzter lokaler Tag, inklusiv (JJJJ-MM-TT), leer = unbegrenzt.
	Until string `json:"until,omitempty"`
}

// ParseRecurrence liest und prüft die Wiederkehr.
func ParseRecurrence(raw json.RawMessage) (Recurrence, error) {
	var r Recurrence
	if len(raw) == 0 || string(raw) == "null" {
		return r, nil
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return r, fmt.Errorf("Wiederkehr: ungültiges JSON")
	}
	if r.HorizonDays == 0 {
		r.HorizonDays = 14
	}
	if !r.Enabled {
		return r, nil
	}
	if _, err := time.LoadLocation(r.TZ); err != nil || r.TZ == "" {
		return r, fmt.Errorf("Wiederkehr: Zeitzone %q unbekannt (IANA-Name, z. B. Europe/Berlin)", r.TZ)
	}
	if _, err := time.Parse("15:04", r.Time); err != nil {
		return r, fmt.Errorf("Wiederkehr: Zeit %q ungültig (HH:MM)", r.Time)
	}
	if r.DurationMin < 1 || r.DurationMin > 24*60 {
		return r, fmt.Errorf("Wiederkehr: Dauer 1–1440 Minuten")
	}
	if len(r.ByDay) == 0 {
		return r, fmt.Errorf("Wiederkehr: mindestens ein Wochentag")
	}
	for i, d := range r.ByDay {
		d = strings.ToUpper(strings.TrimSpace(d))
		switch d {
		case "MO", "TU", "WE", "TH", "FR", "SA", "SU":
			r.ByDay[i] = d
		default:
			return r, fmt.Errorf("Wiederkehr: Wochentag %q unbekannt", d)
		}
	}
	if r.HorizonDays < 1 || r.HorizonDays > 90 {
		return r, fmt.Errorf("Wiederkehr: Vorlauf 1–90 Tage")
	}
	if r.Until != "" {
		if _, err := time.Parse("2006-01-02", r.Until); err != nil {
			return r, fmt.Errorf("Wiederkehr: Enddatum JJJJ-MM-TT")
		}
	}
	return r, nil
}

// Occurrence ist ein berechneter Sendetermin.
type Occurrence struct {
	Start, End time.Time
}

// Occurrences liefert die Termine mit Beginn in [from, to).
func (r Recurrence) Occurrences(from, to time.Time) ([]Occurrence, error) {
	if !r.Enabled {
		return nil, nil
	}
	loc, err := time.LoadLocation(r.TZ)
	if err != nil {
		return nil, err
	}
	// Anker: der Tag vor `from` (lokal), damit auch Termine am ersten Tag erzeugt werden
	anchor := from.In(loc).AddDate(0, 0, -1).Format("2006-01-02")
	spec := ingest.Spec{TZ: r.TZ, StartLocal: anchor + "T" + r.Time, DurationS: int64(r.DurationMin) * 60,
		Rec: ingest.Recurrence{Freq: "weekly", ByDay: r.ByDay, Until: r.Until}}
	occ, err := ingest.Occurrences(spec, from, to)
	if err != nil {
		return nil, err
	}
	out := make([]Occurrence, 0, len(occ))
	for _, o := range occ {
		out = append(out, Occurrence{Start: o.Start, End: o.End})
	}
	return out, nil
}
