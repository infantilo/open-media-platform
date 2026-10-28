// Package analyze wertet ein Support-Paket oder eine eingefrorene Momentaufnahme (ZIP) aus (UMSETZUNG.md Kap. 73): Befunde, Störungszeitleiste,
// auffällige Messreihen, gruppierte Logs. Dieselbe Auswertung speist den Betrachter im Support-Tab (JSON), den Textbericht (Markdown) und die
// KI-Auswertung (der Markdown-Bericht ist als Eingabe für ein Sprachmodell gedacht).
package analyze

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"sort"
	"strings"
	"time"
)

const (
	maxEntries   = 400
	maxFileBytes = 64 << 20
	maxTotal     = 256 << 20
	maxPoints    = 120
	maxTimeline  = 300
	maxLogGroups = 40
)

// Kind unterscheidet die beiden Paketarten.
type Kind string

const (
	KindBundle Kind = "bundle"
	KindFreeze Kind = "freeze"
)

// Finding ist ein Befund der Auswertung.
type Finding struct {
	Level   string    `json:"level"` // err | warn | info
	Source  string    `json:"source"`
	Title   string    `json:"title"`
	Detail  string    `json:"detail,omitempty"`
	Fix     string    `json:"fix,omitempty"`
	At      time.Time `json:"at,omitempty"`
	Subject string    `json:"subject,omitempty"`
}

// Event ist ein Eintrag der Störungszeitleiste.
type Event struct {
	At       time.Time `json:"at"`
	Source   string    `json:"source"`
	Kind     string    `json:"kind"`
	Severity string    `json:"severity"`
	Subject  string    `json:"subject,omitempty"`
	Text     string    `json:"text,omitempty"`
}

// Point ist ein Messpunkt (Unix-Millisekunden).
type Point struct {
	T int64   `json:"t"`
	V float64 `json:"v"`
}

// Series ist eine heruntergerechnete Messreihe mit Kennwerten.
type Series struct {
	Group  string  `json:"group"` // host | process | node
	ID     string  `json:"id"`
	Label  string  `json:"label"`
	Metric string  `json:"metric"`
	Unit   string  `json:"unit,omitempty"`
	Points []Point `json:"points"`
	Min    float64 `json:"min"`
	Max    float64 `json:"max"`
	Avg    float64 `json:"avg"`
	First  float64 `json:"first"`
	Last   float64 `json:"last"`
	Flag   string  `json:"flag,omitempty"` // leer | high | growing | dropped
}

// Outage ist ein Zeitraum, in dem ein Node keine Medien bereit hatte.
type Outage struct {
	ID      string    `json:"id"`
	Label   string    `json:"label"`
	From    time.Time `json:"from"`
	To      time.Time `json:"to"`
	Seconds float64   `json:"seconds"`
	Open    bool      `json:"open,omitempty"` // bis zum Ende des Fensters nicht zurückgekehrt
}

// LogGroup fasst gleichartige Meldungen zusammen.
type LogGroup struct {
	Level   string    `json:"level"`
	Source  string    `json:"source"`
	Message string    `json:"message"`
	Code    string    `json:"code,omitempty"`
	Count   int       `json:"count"`
	First   time.Time `json:"first"`
	Last    time.Time `json:"last"`
}

// Report ist das Ergebnis der Auswertung.
type Report struct {
	Kind      Kind              `json:"kind"`
	Title     string            `json:"title"`
	From      time.Time         `json:"from,omitempty"`
	To        time.Time         `json:"to,omitempty"`
	Trigger   string            `json:"trigger,omitempty"`
	Reason    string            `json:"reason,omitempty"`
	Note      string            `json:"note,omitempty"`
	Files     []string          `json:"files"`
	Missing   map[string]string `json:"missing,omitempty"`
	Verdict   string            `json:"verdict"` // ok | warn | err
	Summary   string            `json:"summary"`
	Findings  []Finding         `json:"findings"`
	Outages   []Outage          `json:"outages,omitempty"`
	Timeline  []Event           `json:"timeline,omitempty"`
	Series    []Series          `json:"series,omitempty"`
	LogGroups []LogGroup        `json:"logGroups,omitempty"`
	Pipelines []string          `json:"pipelines,omitempty"`
	Version   string            `json:"version,omitempty"`
}

type tr struct{ en bool }

func (t tr) s(de, en string) string {
	if t.en {
		return en
	}
	return de
}

// Analyze liest das ZIP und wertet es aus. lang "en" liefert englische Texte, sonst Deutsch.
func Analyze(data []byte, lang string) (*Report, error) {
	t := tr{en: strings.HasPrefix(lang, "en")}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, errors.New(t.s("keine gültige ZIP-Datei", "not a valid ZIP file"))
	}
	if len(zr.File) > maxEntries {
		return nil, errors.New(t.s("zu viele Dateien im Paket", "too many files in the package"))
	}
	files := map[string][]byte{}
	var total int64
	r := &Report{Missing: map[string]string{}, Findings: []Finding{}, Files: []string{}}
	for _, f := range zr.File {
		if f.FileInfo().IsDir() || strings.Contains(f.Name, "..") {
			continue
		}
		if f.UncompressedSize64 > maxFileBytes {
			r.Missing[f.Name] = t.s("zu groß, übersprungen", "too large, skipped")
			continue
		}
		total += int64(f.UncompressedSize64)
		if total > maxTotal {
			return nil, errors.New(t.s("Paket entpackt zu groß", "package too large when unpacked"))
		}
		rc, err := f.Open()
		if err != nil {
			continue
		}
		b, err := io.ReadAll(io.LimitReader(rc, maxFileBytes+1))
		rc.Close()
		if err != nil || len(b) > maxFileBytes {
			continue
		}
		files[f.Name] = b
		r.Files = append(r.Files, f.Name)
	}
	sort.Strings(r.Files)

	switch {
	case files["meta.json"] != nil:
		r.Kind = KindFreeze
	case files["manifest.json"] != nil || files["selftest.json"] != nil:
		r.Kind = KindBundle
	default:
		return nil, errors.New(t.s("das ist weder ein Support-Paket noch eine Momentaufnahme (meta.json / manifest.json fehlt)", "neither a support package nor a snapshot (meta.json / manifest.json missing)"))
	}

	w := &work{t: t, r: r, files: files}
	w.meta()
	w.selftest()
	w.timeline()
	w.series()
	w.logs()
	w.pipelines()
	w.finish()
	if len(r.Missing) == 0 {
		r.Missing = nil
	}
	return r, nil
}

type work struct {
	t     tr
	r     *Report
	files map[string][]byte
}

func (w *work) add(f Finding) { w.r.Findings = append(w.r.Findings, f) }

func (w *work) meta() {
	r := w.r
	if b := w.files["meta.json"]; b != nil {
		var m struct {
			CreatedAt time.Time         `json:"createdAt"`
			From      time.Time         `json:"from"`
			To        time.Time         `json:"to"`
			Trigger   string            `json:"trigger"`
			Reason    string            `json:"reason"`
			Note      string            `json:"note"`
			Failed    map[string]string `json:"failed"`
		}
		if json.Unmarshal(b, &m) == nil {
			r.From, r.To, r.Trigger, r.Reason, r.Note = m.From, m.To, m.Trigger, m.Reason, m.Note
			for k, v := range m.Failed {
				r.Missing[k] = v
			}
		}
		r.Title = w.t.s("Eingefrorene Momentaufnahme", "Frozen snapshot")
		if r.Trigger == "auto" {
			w.add(Finding{Level: "warn", Source: "meta", At: r.To, Title: w.t.s("Automatisch ausgelöst", "Triggered automatically"), Detail: r.Reason,
				Fix: w.t.s("Die Zeitleiste kurz vor dem Auslösezeitpunkt zeigt die Ursache.", "The timeline shortly before the trigger shows the cause.")})
		}
	}
	if b := w.files["manifest.json"]; b != nil {
		var m struct {
			CreatedAt time.Time         `json:"createdAt"`
			Window    string            `json:"window"`
			Failed    map[string]string `json:"failed"`
		}
		if json.Unmarshal(b, &m) == nil {
			r.To = m.CreatedAt
			for k, v := range m.Failed {
				r.Missing[k] = v
			}
			if d, ok := parseWindow(m.Window); ok {
				r.From = m.CreatedAt.Add(-d)
			}
		}
		r.Title = w.t.s("Support-Paket", "Support package")
	}
	if b := w.files["api/version.json"]; b != nil {
		var v map[string]any
		if json.Unmarshal(b, &v) == nil {
			for _, k := range []string{"version", "Version"} {
				if s, ok := v[k].(string); ok {
					r.Version = s
				}
			}
		}
	}
	for k, v := range r.Missing {
		w.add(Finding{Level: "warn", Source: "meta", Title: w.t.s("Teil des Pakets fehlt: ", "Part of the package is missing: ") + k, Detail: v,
			Fix: w.t.s("Die Auswertung ist an dieser Stelle lückenhaft.", "The analysis has a gap here.")})
	}
}

func (w *work) selftest() {
	b := w.files["selftest.json"]
	if b == nil {
		return
	}
	var rep struct {
		Checks []struct {
			ID, Group, Level, Title, Detail, Fix, Code string
		} `json:"checks"`
	}
	if json.Unmarshal(b, &rep) != nil {
		return
	}
	for _, c := range rep.Checks {
		if c.Level != "warn" && c.Level != "err" {
			continue
		}
		d := c.Detail
		if c.Code != "" {
			d = strings.TrimSpace(c.Code + " " + d)
		}
		w.add(Finding{Level: c.Level, Source: "selftest", Title: c.Title, Detail: d, Fix: c.Fix, Subject: c.Group})
	}
}

func (w *work) timeline() {
	var items []struct {
		At       time.Time       `json:"at"`
		Source   string          `json:"source"`
		Kind     string          `json:"kind"`
		Severity string          `json:"severity"`
		Subject  string          `json:"subject"`
		Data     json.RawMessage `json:"data"`
	}
	b := w.files["timeline.json"]
	if b == nil {
		b = w.files["api/timeline.json"]
	}
	if b == nil || !decodeList(b, &items) {
		return
	}
	var ev []Event
	for _, it := range items {
		sev := normSev(it.Severity)
		e := Event{At: it.At, Source: it.Source, Kind: it.Kind, Severity: sev, Subject: it.Subject, Text: shortData(it.Data)}
		ev = append(ev, e)
	}
	sort.Slice(ev, func(i, j int) bool { return ev[i].At.Before(ev[j].At) })
	// Wichtiges zuerst behalten: Fehler und Warnungen vollständig, Rest auffüllen.
	if len(ev) > maxTimeline {
		var keep []Event
		rest := maxTimeline
		for _, e := range ev {
			if e.Severity != "info" {
				rest--
			}
		}
		for _, e := range ev {
			if e.Severity == "info" {
				if rest <= 0 {
					continue
				}
				rest--
			}
			keep = append(keep, e)
		}
		ev = keep
	}
	w.r.Timeline = ev
	errs := 0
	for _, e := range ev {
		if e.Severity == "err" {
			errs++
		}
	}
	if errs > 0 {
		w.add(Finding{Level: "err", Source: "timeline", Title: w.t.s(fmt.Sprintf("%d Fehler-Ereignisse in der Zeitleiste", errs), fmt.Sprintf("%d error events on the timeline", errs)),
			Fix: w.t.s("Zeitleiste von oben lesen: das erste Ereignis ist meist die Ursache, die späteren sind Folgen.", "Read the timeline from the top: the first event is usually the cause, later ones are consequences.")})
	}
}

func normSev(s string) string {
	switch strings.ToLower(s) {
	case "error", "err", "critical", "fatal":
		return "err"
	case "warn", "warning":
		return "warn"
	}
	return "info"
}

func shortData(d json.RawMessage) string {
	if len(d) == 0 || string(d) == "null" {
		return ""
	}
	var m map[string]any
	if json.Unmarshal(d, &m) == nil {
		if p, ok := m["path"].(string); ok {
			return clip(fmt.Sprintf("%v %s %v", m["method"], p, m["status"]), 200)
		}
		for _, k := range []string{"message", "msg", "text", "reason", "error", "label", "name"} {
			if s, ok := m[k].(string); ok && s != "" {
				return clip(s, 200)
			}
		}
	}
	var c bytes.Buffer
	if json.Compact(&c, d) == nil {
		return clip(c.String(), 200)
	}
	return clip(string(d), 200)
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n]) + "…"
	}
	return s
}

// decodeList liest ein JSON-Array oder ein Objekt, dessen erstes Array-Feld die Liste ist.
func decodeList(b []byte, out any) bool {
	if json.Unmarshal(b, out) == nil {
		return true
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(b, &m) != nil {
		return false
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if bytes.HasPrefix(bytes.TrimSpace(m[k]), []byte("[")) && json.Unmarshal(m[k], out) == nil {
			return true
		}
	}
	return false
}

func (w *work) series() {
	var all []Series
	if b := w.files["series/nodes.json"]; b != nil {
		var ns []struct {
			ID, Label string
			Samples   []struct {
				T     time.Time          `json:"t"`
				Ready *bool              `json:"ready"`
				KPIs  map[string]float64 `json:"kpis"`
			}
		}
		if json.Unmarshal(b, &ns) == nil {
			for _, n := range ns {
				label := firstNonEmpty(n.Label, n.ID)
				var open *time.Time
				var ready []Point
				kp := map[string][]Point{}
				var last time.Time
				for _, s := range n.Samples {
					last = s.T
					ms := s.T.UnixMilli()
					if s.Ready != nil {
						v := 0.0
						if *s.Ready {
							v = 1
							if open != nil {
								w.outage(n.ID, label, *open, s.T, false)
								open = nil
							}
						} else if open == nil {
							tt := s.T
							open = &tt
						}
						ready = append(ready, Point{ms, v})
					}
					for k, v := range s.KPIs {
						kp[k] = append(kp[k], Point{ms, v})
					}
				}
				if open != nil {
					w.outage(n.ID, label, *open, last, true)
				}
				if len(ready) > 0 {
					all = append(all, mk("node", n.ID, label, "ready", "", ready))
				}
				keys := sortedKeys(kp)
				for _, k := range keys {
					all = append(all, mk("node", n.ID, label, k, "", kp[k]))
				}
			}
		}
	}
	if b := w.files["series/processes.json"]; b != nil {
		var ps []struct {
			InstanceID, Label string
			Samples           []struct {
				T   time.Time `json:"t"`
				CPU *float64  `json:"cpuPercent"`
				RSS *uint64   `json:"rssBytes"`
			}
		}
		if json.Unmarshal(b, &ps) == nil {
			for _, p := range ps {
				label := firstNonEmpty(p.Label, p.InstanceID)
				var cpu, rss []Point
				for _, s := range p.Samples {
					if s.CPU != nil {
						cpu = append(cpu, Point{s.T.UnixMilli(), *s.CPU})
					}
					if s.RSS != nil {
						rss = append(rss, Point{s.T.UnixMilli(), float64(*s.RSS)})
					}
				}
				if len(cpu) > 0 {
					all = append(all, mk("process", p.InstanceID, label, "cpu", "%", cpu))
				}
				if len(rss) > 0 {
					all = append(all, mk("process", p.InstanceID, label, "rss", "B", rss))
				}
			}
		}
	}
	if b := w.files["series/hosts.json"]; b != nil {
		var hs map[string]struct {
			Samples []struct {
				Timestamp  time.Time `json:"timestamp"`
				CPUPercent float64   `json:"cpuPercent"`
				MemPercent float64   `json:"memPercent"`
			} `json:"samples"`
			Aggregates []struct {
				BucketStart time.Time `json:"bucketStart"`
				CPUAvg      float64   `json:"cpuAvg"`
				MemAvg      float64   `json:"memAvg"`
			} `json:"aggregates"`
		}
		if json.Unmarshal(b, &hs) == nil {
			names := make([]string, 0, len(hs))
			for k := range hs {
				names = append(names, k)
			}
			sort.Strings(names)
			for _, name := range names {
				h := hs[name]
				var cpu, mem []Point
				for _, s := range h.Samples {
					cpu = append(cpu, Point{s.Timestamp.UnixMilli(), s.CPUPercent})
					mem = append(mem, Point{s.Timestamp.UnixMilli(), s.MemPercent})
				}
				if len(cpu) == 0 {
					for _, a := range h.Aggregates {
						cpu = append(cpu, Point{a.BucketStart.UnixMilli(), a.CPUAvg})
						mem = append(mem, Point{a.BucketStart.UnixMilli(), a.MemAvg})
					}
				}
				if len(cpu) > 0 {
					all = append(all, mk("host", name, name, "cpu", "%", cpu), mk("host", name, name, "mem", "%", mem))
				}
			}
		}
	}
	// Auffälligkeit markieren und Befunde ableiten.
	for i := range all {
		s := &all[i]
		w.flag(s)
	}
	// Unauffällige Reihen nur behalten, soweit sie wenig Platz brauchen: auffällige zuerst, danach nach Gruppe.
	sort.SliceStable(all, func(i, j int) bool {
		fi, fj := all[i].Flag != "", all[j].Flag != ""
		if fi != fj {
			return fi
		}
		return false
	})
	w.r.Series = all
}

func (w *work) outage(id, label string, from, to time.Time, open bool) {
	sec := to.Sub(from).Seconds()
	w.r.Outages = append(w.r.Outages, Outage{ID: id, Label: label, From: from, To: to, Seconds: sec, Open: open})
	lv := "warn"
	if open || sec >= 30 {
		lv = "err"
	}
	d := w.t.s(fmt.Sprintf("%.0f s ohne Medien", sec), fmt.Sprintf("%.0f s without media", sec))
	if open {
		d = w.t.s("bis zum Ende des Zeitraums nicht zurückgekehrt", "did not come back before the end of the window")
	}
	w.add(Finding{Level: lv, Source: "series", At: from, Subject: label, Title: w.t.s(label+": Medien nicht bereit", label+": media not ready"), Detail: d,
		Fix: w.t.s("In Zeitleiste und Logs zum Zeitpunkt schauen: Neustart, Quelle weg oder Host überlastet?", "Check timeline and logs at that time: restart, source gone or host overloaded?")})
}

func mk(group, id, label, metric, unit string, pts []Point) Series {
	sort.Slice(pts, func(i, j int) bool { return pts[i].T < pts[j].T })
	s := Series{Group: group, ID: id, Label: label, Metric: metric, Unit: unit}
	s.Min, s.Max = math.Inf(1), math.Inf(-1)
	sum := 0.0
	for _, p := range pts {
		s.Min = math.Min(s.Min, p.V)
		s.Max = math.Max(s.Max, p.V)
		sum += p.V
	}
	s.Avg = sum / float64(len(pts))
	s.First, s.Last = pts[0].V, pts[len(pts)-1].V
	s.Points = downsample(pts, maxPoints)
	return s
}

// downsample behält je Eimer Minimum und Maximum, damit Spitzen nicht verschwinden.
func downsample(p []Point, n int) []Point {
	if len(p) <= n {
		return p
	}
	per := int(math.Ceil(float64(len(p)) / float64(n/2)))
	out := make([]Point, 0, n)
	for i := 0; i < len(p); i += per {
		end := min(i+per, len(p))
		lo, hi := p[i], p[i]
		for _, q := range p[i:end] {
			if q.V < lo.V {
				lo = q
			}
			if q.V > hi.V {
				hi = q
			}
		}
		if lo.T > hi.T {
			lo, hi = hi, lo
		}
		out = append(out, lo)
		if hi != lo {
			out = append(out, hi)
		}
	}
	return out
}

func (w *work) flag(s *Series) {
	span := time.Duration(0)
	if n := len(s.Points); n > 1 {
		span = time.Duration(s.Points[n-1].T-s.Points[0].T) * time.Millisecond
	}
	name := s.Label + " — " + metricName(w.t, s.Metric)
	switch {
	case s.Metric == "rss" && span >= 10*time.Minute && s.First > 0 && s.Last >= s.First*1.3 && s.Last-s.First >= 50<<20:
		s.Flag = "growing"
		w.add(Finding{Level: "warn", Source: "series", Subject: s.Label, Title: w.t.s(s.Label+": Speicher wächst", s.Label+": memory grows"),
			Detail: w.t.s(fmt.Sprintf("von %s auf %s in %.0f min", human(s.First), human(s.Last), span.Minutes()), fmt.Sprintf("from %s to %s in %.0f min", human(s.First), human(s.Last), span.Minutes())),
			Fix:    w.t.s("Mögliches Speicherleck: zu einem ruhigen Zeitpunkt neu starten; wächst es wieder, melden.", "Possible memory leak: restart at a quiet moment; if it grows again, report it.")})
	case (s.Metric == "cpu" || s.Metric == "mem") && s.Group == "host" && s.Avg >= 90:
		s.Flag = "high"
		w.add(Finding{Level: "err", Source: "series", Subject: s.Label, Title: w.t.s(name+" dauerhaft über 90 %", name+" constantly above 90%"), Detail: fmt.Sprintf("Ø %.0f %%, max %.0f %%", s.Avg, s.Max),
			Fix: w.t.s("Host entlasten (Instanzen verschieben) oder Hardware vergrößern.", "Relieve the host (move instances) or add capacity.")})
	case (s.Metric == "cpu" || s.Metric == "mem") && s.Group == "host" && s.Max >= 95:
		s.Flag = "high"
		w.add(Finding{Level: "warn", Source: "series", Subject: s.Label, Title: w.t.s(name+" mit Spitzen über 95 %", name+" peaks above 95%"), Detail: fmt.Sprintf("Ø %.0f %%, max %.0f %%", s.Avg, s.Max)})
	case s.Metric == "cpu" && s.Group == "process" && s.Avg >= 90:
		s.Flag = "high"
		w.add(Finding{Level: "warn", Source: "series", Subject: s.Label, Title: w.t.s(name+" im Mittel über 90 %", name+" averages above 90%"), Detail: fmt.Sprintf("Ø %.0f %%, max %.0f %%", s.Avg, s.Max)})
	case s.Group == "node" && s.Metric != "ready" && span >= 2*time.Minute && s.Max > 0 && s.Last == 0 && s.Avg > 0 && s.Max >= 5*s.Avg/2:
		// Kennzahl war da und ist am Ende auf null gefallen (z. B. Bildrate).
		s.Flag = "dropped"
		w.add(Finding{Level: "warn", Source: "series", Subject: s.Label, Title: w.t.s(name+" auf 0 gefallen", name+" dropped to 0"), Detail: fmt.Sprintf("max %.1f, zuletzt 0", s.Max)})
	}
}

func metricName(t tr, m string) string {
	switch m {
	case "cpu":
		return t.s("Prozessorlast", "CPU load")
	case "mem":
		return t.s("Arbeitsspeicher", "memory")
	case "rss":
		return t.s("Speicher", "memory")
	case "ready":
		return t.s("Medien bereit", "media ready")
	}
	return m
}

func human(v float64) string {
	const k = 1024.0
	switch {
	case v >= k*k*k:
		return fmt.Sprintf("%.1f GiB", v/(k*k*k))
	case v >= k*k:
		return fmt.Sprintf("%.0f MiB", v/(k*k))
	case v >= k:
		return fmt.Sprintf("%.0f KiB", v/k)
	}
	return fmt.Sprintf("%.0f B", v)
}

func (w *work) logs() {
	var ents []struct {
		OccurredAt time.Time `json:"occurredAt"`
		Level      string    `json:"level"`
		Message    string    `json:"message"`
		Source     string    `json:"source"`
		NodeID     string    `json:"nodeId"`
		Code       string    `json:"code"`
	}
	b := w.files["logs.json"]
	if b == nil {
		b = w.files["logs/errors-and-warnings.json"]
	}
	if b == nil || !decodeList(b, &ents) {
		return
	}
	groups := map[string]*LogGroup{}
	for _, e := range ents {
		lv := normSev(e.Level)
		if lv == "info" {
			continue
		}
		src := firstNonEmpty(e.Source, e.NodeID)
		key := lv + "|" + src + "|" + normMsg(e.Message)
		g := groups[key]
		if g == nil {
			g = &LogGroup{Level: lv, Source: src, Message: clip(e.Message, 300), Code: e.Code, First: e.OccurredAt, Last: e.OccurredAt}
			groups[key] = g
		}
		g.Count++
		if e.OccurredAt.Before(g.First) {
			g.First = e.OccurredAt
		}
		if e.OccurredAt.After(g.Last) {
			g.Last = e.OccurredAt
		}
	}
	list := make([]LogGroup, 0, len(groups))
	for _, g := range groups {
		list = append(list, *g)
	}
	sort.Slice(list, func(i, j int) bool {
		if (list[i].Level == "err") != (list[j].Level == "err") {
			return list[i].Level == "err"
		}
		return list[i].Count > list[j].Count
	})
	if len(list) > maxLogGroups {
		list = list[:maxLogGroups]
	}
	w.r.LogGroups = list
	for _, g := range list {
		if g.Level == "err" && g.Count >= 20 {
			w.add(Finding{Level: "warn", Source: "logs", At: g.First, Subject: g.Source, Title: w.t.s(fmt.Sprintf("Fehlermeldung %d× wiederholt", g.Count), fmt.Sprintf("Error repeated %d×", g.Count)), Detail: g.Message})
		}
	}
}

// normMsg macht Meldungen vergleichbar: Zahlen und Kennungen fallen weg.
func normMsg(s string) string {
	var b strings.Builder
	inNum := false
	for _, r := range s {
		if r >= '0' && r <= '9' {
			if !inNum {
				b.WriteByte('#')
			}
			inNum = true
			continue
		}
		inNum = false
		b.WriteRune(r)
	}
	return clip(b.String(), 160)
}

func (w *work) pipelines() {
	for _, f := range w.r.Files {
		if strings.HasPrefix(f, "pipelines/") {
			w.r.Pipelines = append(w.r.Pipelines, strings.TrimPrefix(f, "pipelines/"))
		}
	}
}

func (w *work) finish() {
	r := w.r
	rank := map[string]int{"err": 0, "warn": 1, "info": 2}
	sort.SliceStable(r.Findings, func(i, j int) bool { return rank[r.Findings[i].Level] < rank[r.Findings[j].Level] })
	errs, warns := 0, 0
	for _, f := range r.Findings {
		switch f.Level {
		case "err":
			errs++
		case "warn":
			warns++
		}
	}
	switch {
	case errs > 0:
		r.Verdict = "err"
		r.Summary = w.t.s(fmt.Sprintf("%d Fehler und %d Warnungen gefunden", errs, warns), fmt.Sprintf("%d errors and %d warnings found", errs, warns))
	case warns > 0:
		r.Verdict = "warn"
		r.Summary = w.t.s(fmt.Sprintf("%d Warnungen gefunden", warns), fmt.Sprintf("%d warnings found", warns))
	default:
		r.Verdict = "ok"
		r.Summary = w.t.s("Nichts Auffälliges gefunden", "Nothing unusual found")
	}
}

func firstNonEmpty(a ...string) string {
	for _, s := range a {
		if s != "" {
			return s
		}
	}
	return ""
}

func sortedKeys[V any](m map[string]V) []string {
	k := make([]string, 0, len(m))
	for s := range m {
		k = append(k, s)
	}
	sort.Strings(k)
	return k
}

// parseWindow liest „30 min“, „2 h“ oder eine Go-Dauer.
func parseWindow(s string) (time.Duration, bool) {
	var n int
	var unit string
	if _, err := fmt.Sscanf(s, "%d %s", &n, &unit); err == nil {
		switch unit {
		case "min":
			return time.Duration(n) * time.Minute, true
		case "h":
			return time.Duration(n) * time.Hour, true
		}
	}
	d, err := time.ParseDuration(s)
	return d, err == nil
}
