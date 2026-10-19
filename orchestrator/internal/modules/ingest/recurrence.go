package ingest

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// Zeitplan-Auswertung (Kapitel 42): Startzeit als **lokale Wanduhrzeit in einer IANA-Zeitzone**, Dauer in echten Sekunden.
// Daraus werden Vorkommen (Occurrence) als UTC-Instants berechnet — deterministisch auch an Zeitumstellungen:
//
//   - Übergang Sommerzeit (Lücke, z. B. 02:30 existiert nicht): die Aufnahme startet zum ersten existierenden Zeitpunkt
//     danach (Wanduhr + Lückenlänge); Occurrence.Shifted = true.
//   - Übergang Winterzeit (Wiederholung, 02:30 gibt es zweimal): die **erste** (frühere) Instanz zählt; Occurrence.Ambiguous = true.
//   - Das Ende ist Start + Dauer in echter Zeit (eine 2-h-Aufnahme über die Umstellung dauert 2 echte Stunden).

// Recurrence beschreibt eine Wiederholung. Freq "" oder "once" = einmalig.
type Recurrence struct {
	Freq     string   `json:"freq,omitempty"`     // once | daily | weekly | monthly
	Interval int      `json:"interval,omitempty"` // jede n-te Einheit (Standard 1)
	ByDay    []string `json:"byDay,omitempty"`    // weekly: MO,TU,WE,TH,FR,SA,SU (Standard: Wochentag des Starts)
	Until    string   `json:"until,omitempty"`    // letzter lokaler Tag, inklusiv, JJJJ-MM-TT
	Count    int      `json:"count,omitempty"`    // höchstens so viele Vorkommen insgesamt
}

// Spec ist die Zeitangabe eines Zeitplans.
type Spec struct {
	TZ         string     `json:"tz"`
	StartLocal string     `json:"startLocal"` // 2006-01-02T15:04 (Wanduhr in TZ)
	DurationS  int64      `json:"durationS"`
	Rec        Recurrence `json:"recurrence"`
}

// Occurrence ist ein berechnetes Vorkommen.
type Occurrence struct {
	Start     time.Time `json:"start"` // UTC
	End       time.Time `json:"end"`   // UTC
	LocalDate string    `json:"localDate"`
	Index     int       `json:"index"` // laufende Nummer ab 0 (zählt auch Vorkommen vor `from`)
	Shifted   bool      `json:"shifted,omitempty"`
	Ambiguous bool      `json:"ambiguous,omitempty"`
}

const localLayout = "2006-01-02T15:04"

var weekdays = map[string]time.Weekday{"SU": time.Sunday, "MO": time.Monday, "TU": time.Tuesday, "WE": time.Wednesday, "TH": time.Thursday, "FR": time.Friday, "SA": time.Saturday}

// Validate prüft die Angaben (ohne Auswertung).
func (s Spec) Validate() error {
	if _, err := time.LoadLocation(s.TZ); err != nil || s.TZ == "" {
		return fmt.Errorf("Zeitzone %q unbekannt (IANA-Name, z. B. Europe/Berlin)", s.TZ)
	}
	if _, err := time.Parse(localLayout, s.StartLocal); err != nil {
		return fmt.Errorf("Startzeit %q ungültig (erwartet JJJJ-MM-TTThh:mm)", s.StartLocal)
	}
	if s.DurationS < 1 || s.DurationS > 7*24*3600 {
		return fmt.Errorf("Dauer muss zwischen 1 s und 7 Tagen liegen")
	}
	switch s.Rec.Freq {
	case "", "once", "daily", "weekly", "monthly":
	default:
		return fmt.Errorf("Wiederholung %q unbekannt (once, daily, weekly, monthly)", s.Rec.Freq)
	}
	if s.Rec.Interval < 0 || s.Rec.Interval > 366 {
		return fmt.Errorf("Intervall außerhalb 1–366")
	}
	if s.Rec.Until != "" {
		if _, err := time.Parse("2006-01-02", s.Rec.Until); err != nil {
			return fmt.Errorf("Enddatum %q ungültig", s.Rec.Until)
		}
	}
	for _, d := range s.Rec.ByDay {
		if _, ok := weekdays[strings.ToUpper(d)]; !ok {
			return fmt.Errorf("Wochentag %q unbekannt", d)
		}
	}
	if s.Rec.Freq == "" || s.Rec.Freq == "once" {
		return nil
	}
	if s.Rec.Until == "" && s.Rec.Count == 0 {
		// unbegrenzt ist erlaubt; die Auswertung begrenzt über das Zeitfenster
		return nil
	}
	return nil
}

// resolveLocal rechnet Wanduhr (in loc) deterministisch in einen Instant um.
func resolveLocal(loc *time.Location, y int, mo time.Month, d, hh, mm int) (t time.Time, shifted, ambiguous bool) {
	wall := time.Date(y, mo, d, hh, mm, 0, 0, time.UTC) // Wanduhr als UTC-Zahl
	// mögliche Offsets rund um diesen Tag (vor und nach einer Umstellung)
	offs := map[int]bool{}
	for _, probe := range []time.Duration{-36 * time.Hour, -12 * time.Hour, 0, 12 * time.Hour, 36 * time.Hour} {
		_, off := wall.Add(probe).In(loc).Zone()
		offs[off] = true
	}
	var valid []time.Time
	var all []int
	for off := range offs {
		all = append(all, off)
	}
	sort.Ints(all)
	for _, off := range all {
		inst := wall.Add(-time.Duration(off) * time.Second)
		l := inst.In(loc)
		if l.Hour() == hh && l.Minute() == mm && l.Day() == d {
			valid = append(valid, inst)
		}
	}
	switch len(valid) {
	case 0:
		// Lücke: erster existierender Zeitpunkt danach = Wanduhr minus kleinster Offset (der „vor“-Offset)
		return wall.Add(-time.Duration(all[0]) * time.Second), true, false
	case 1:
		return valid[0], false, false
	default:
		sort.Slice(valid, func(i, j int) bool { return valid[i].Before(valid[j]) })
		return valid[0], false, true
	}
}

// Occurrences liefert alle Vorkommen, deren **Start** in [from, to) liegt (höchstens 5000). Die Zählung für Count beginnt
// immer am ersten Vorkommen — unabhängig von `from`.
func Occurrences(s Spec, from, to time.Time) ([]Occurrence, error) {
	if err := s.Validate(); err != nil {
		return nil, err
	}
	loc, _ := time.LoadLocation(s.TZ)
	st, _ := time.Parse(localLayout, s.StartLocal)
	hh, mm := st.Hour(), st.Minute()
	rec := s.Rec
	interval := rec.Interval
	if interval < 1 {
		interval = 1
	}
	var until time.Time
	if rec.Until != "" {
		until, _ = time.Parse("2006-01-02", rec.Until)
	}
	var out []Occurrence
	emit := func(y int, mo time.Month, d, idx int) bool {
		day := time.Date(y, mo, d, 0, 0, 0, 0, time.UTC)
		if !until.IsZero() && day.After(until) {
			return false
		}
		if rec.Count > 0 && idx >= rec.Count {
			return false
		}
		start, shifted, amb := resolveLocal(loc, y, mo, d, hh, mm)
		if !start.Before(to) {
			return false
		}
		if !start.Before(from) {
			out = append(out, Occurrence{Start: start, End: start.Add(time.Duration(s.DurationS) * time.Second), LocalDate: day.Format("2006-01-02"), Index: idx, Shifted: shifted, Ambiguous: amb})
		}
		return len(out) < 5000
	}
	y0, m0, d0 := st.Date()
	switch rec.Freq {
	case "", "once":
		emit(y0, m0, d0, 0)
	case "daily":
		cur := time.Date(y0, m0, d0, 0, 0, 0, 0, time.UTC)
		for i := 0; ; i++ {
			y, m, d := cur.Date()
			if !emit(y, m, d, i) {
				break
			}
			cur = cur.AddDate(0, 0, interval)
		}
	case "weekly":
		days := rec.ByDay
		if len(days) == 0 {
			days = []string{[]string{"SU", "MO", "TU", "WE", "TH", "FR", "SA"}[st.Weekday()]}
		}
		var wd []int
		for _, d := range days {
			wd = append(wd, int(weekdays[strings.ToUpper(d)]))
		}
		sort.Ints(wd)
		// Wochenbeginn = Montag der Startwoche
		cur := time.Date(y0, m0, d0, 0, 0, 0, 0, time.UTC)
		cur = cur.AddDate(0, 0, -((int(cur.Weekday()) + 6) % 7))
		idx := 0
		for w := 0; ; w++ {
			stop := false
			for _, d := range wd {
				day := cur.AddDate(0, 0, (d+6)%7)
				if day.Before(time.Date(y0, m0, d0, 0, 0, 0, 0, time.UTC)) {
					continue // vor dem ersten Start
				}
				y, m, dd := day.Date()
				if !emit(y, m, dd, idx) {
					stop = true
					break
				}
				idx++
			}
			if stop {
				break
			}
			cur = cur.AddDate(0, 0, 7*interval)
		}
	case "monthly":
		idx := 0
		for k := 0; k < 12*60; k++ {
			first := time.Date(y0, m0+time.Month(k*interval), 1, 0, 0, 0, 0, time.UTC)
			last := time.Date(first.Year(), first.Month()+1, 0, 0, 0, 0, 0, time.UTC).Day()
			if d0 > last {
				continue // Monat ohne diesen Tag (z. B. 31.) wird übersprungen
			}
			if !emit(first.Year(), first.Month(), d0, idx) {
				break
			}
			idx++
		}
	}
	return out, nil
}

// IdempotencyKey: je Zeitplan und Vorkommen genau ein Job — unabhängig von Neustarts und Mehrfachauslösung.
func IdempotencyKey(scheduleID string, o Occurrence) string {
	return fmt.Sprintf("%s|%s|%d", scheduleID, o.Start.UTC().Format(time.RFC3339), o.Index)
}
