package ingest

import (
	"fmt"
	"math"
	"sort"
	"time"
)

// Ressourcenplanung und Zulassung (Kapitel 42). Reiner Rechenkern ohne I/O: bekommt Hosts (Kapazität), bereits gebuchte
// Zeitfenster und eine Anfrage und liefert eine Entscheidung mit **typisierten** Gründen. Keine einzelne „Auslastung in
// Prozent“: jede Ressourcenart hat ihre eigene Grenze und wird einzeln über das Zeitfenster geprüft.

// Ressourcenarten.
const (
	ResCPU       = "cpu_cores"      // Rechenkerne
	ResMem       = "mem_mb"         // Arbeitsspeicher
	ResGPU       = "gpu_units"      // GPU-/Beschleunigerlast (Einheiten)
	ResDiskMBps  = "disk_mbps"      // Schreibdurchsatz
	ResDiskGB    = "disk_gb"        // Speicherplatz (kumulativ: bis die Datei entfernt wird)
	ResNetMbps   = "net_mbps"       // Netz
	ResRecorders = "recorder_slots" // gleichzeitige Rekorder
	ResConverter = "converter_slots"
	ResMXLShm    = "mxl_shm_mb" // MXL-Shared-Memory/Flow-Puffer
)

// ResourceKinds in Anzeigereihenfolge.
var ResourceKinds = []string{ResRecorders, ResConverter, ResCPU, ResMem, ResGPU, ResDiskMBps, ResDiskGB, ResNetMbps, ResMXLShm}

// Gründe (Verdict.Kind).
const (
	VOK              = "ok"
	VSourceConflict  = "source_conflict"       // Quelle hat ihr Verbindungslimit erreicht
	VHardShortage    = "hard_shortage"         // passt auf keinem Host je, auch nicht allein
	VTempOccupied    = "temporarily_occupied"  // passt später (belegt durch andere Aufträge)
	VMissingFunction = "missing_function"      // kein Host mit nötiger Funktion (Rekorder/Konverter)
	VStorage         = "storage_insufficient"  // Speicherplatz oder Schreibdurchsatz reicht nicht
	VSoftWarning     = "soft_capacity_warning" // passt, aber über der Warnschwelle
	VUncertain       = "uncertain_estimate"    // Bedarf ist nur ein Standardwert, Bediener sollte prüfen
)

// Blocking: verhindert die Zulassung.
func Blocking(kind string) bool {
	switch kind {
	case VSourceConflict, VHardShortage, VTempOccupied, VMissingFunction, VStorage:
		return true
	}
	return false
}

// Herkunft eines Bedarfswerts.
const (
	OriginMeasured   = "measured"
	OriginConfigured = "configured"
	OriginDefault    = "default"
)

type HostCap struct {
	ID        string             `json:"id"`
	Label     string             `json:"label"`
	Online    bool               `json:"online"`
	Functions []string           `json:"functions"`    // z. B. "recorder", "converter"
	Hard      map[string]float64 `json:"hard"`         // harte Obergrenzen je Ressource (fehlend = unbegrenzt)
	SoftFrac  float64            `json:"softFraction"` // Warnschwelle als Anteil der Obergrenze (0 = keine)
}

func (h HostCap) has(fn string) bool {
	for _, f := range h.Functions {
		if f == fn {
			return true
		}
	}
	return false
}

type Demand struct {
	Amount map[string]float64 `json:"amount"`
	Origin map[string]string  `json:"origin,omitempty"`
}

type Request struct {
	JobID    string
	Source   string
	Start    time.Time
	End      time.Time
	Priority int
	Demand   Demand
	HostPref string
	Needs    []string // nötige Funktionen
}

// Booked: ein bereits reserviertes Zeitfenster auf einem Host.
type Booked struct {
	JobID    string
	Host     string
	Source   string
	Start    time.Time
	End      time.Time
	Priority int
	Amount   map[string]float64
	Active   bool // läuft gerade — wird nie automatisch verdrängt
}

type Rules struct {
	// ReservePct: Anteil der Obergrenze je Ressource, der für Aufträge ab ReserveFromPriority freigehalten wird.
	ReservePct          map[string]float64
	ReserveFromPriority int
	// SourceLimit: gleichzeitige Aufnahmen je Quelle (0 = Standard 4).
	SourceLimit    int
	SourceOverride map[string]int
	// AllowPreempt: nur ein Vorschlag, welche künftigen Aufträge niedrigerer Priorität weichen könnten — nie automatisch.
	AllowPreempt bool
	Horizon      time.Duration // wie weit nach einem freien Zeitfenster gesucht wird (Standard 7 Tage)
}

type Verdict struct {
	Kind        string     `json:"kind"`
	Blocking    bool       `json:"blocking"`
	Resource    string     `json:"resource,omitempty"`
	Host        string     `json:"host,omitempty"`
	From        *time.Time `json:"from,omitempty"`
	To          *time.Time `json:"to,omitempty"`
	Jobs        []string   `json:"jobs,omitempty"`
	Needed      float64    `json:"needed,omitempty"`
	Available   float64    `json:"available,omitempty"`
	Message     string     `json:"message"`
	Action      string     `json:"action,omitempty"` // empfohlene Gegenmaßnahme
	Preemptable []string   `json:"preemptable,omitempty"`
}

type Alternative struct {
	Host  string    `json:"host"`
	Start time.Time `json:"start"`
}

type Decision struct {
	Admit         bool          `json:"admit"`
	Host          string        `json:"host,omitempty"`
	Verdicts      []Verdict     `json:"verdicts"`
	EarliestStart *time.Time    `json:"earliestStart,omitempty"`
	Alternatives  []Alternative `json:"alternatives,omitempty"`
}

func (r Rules) horizon() time.Duration {
	if r.Horizon <= 0 {
		return 7 * 24 * time.Hour
	}
	return r.Horizon
}

func (r Rules) sourceLimit(src string) int {
	if n, ok := r.SourceOverride[src]; ok {
		return n
	}
	if r.SourceLimit > 0 {
		return r.SourceLimit
	}
	return 4
}

// effHard: Obergrenze, die diese Anfrage sehen darf (niedrige Priorität sieht die Reserve nicht).
func effHard(h HostCap, res string, prio int, rules Rules) (float64, bool) {
	hard, ok := h.Hard[res]
	if !ok {
		return math.Inf(1), false
	}
	if p := rules.ReservePct[res]; p > 0 && prio < rules.ReserveFromPriority {
		return hard * (1 - p), true
	}
	return hard, true
}

type usageEvent struct {
	t     time.Time
	delta map[string]float64
	enter bool
	jobID string
}

// usageOver berechnet für [s,e) die Abschnitte, in denen sich die Nutzung ändert, und die Nutzung je Abschnitt.
type segment struct {
	from, to time.Time
	use      map[string]float64
	jobs     []string
}

func segmentsOn(host string, booked []Booked, s, e time.Time) []segment {
	var rel []Booked
	for _, b := range booked {
		if b.Host == host && b.Start.Before(e) && b.End.After(s) {
			rel = append(rel, b)
		}
	}
	cuts := map[int64]time.Time{s.UnixNano(): s, e.UnixNano(): e}
	for _, b := range rel {
		for _, t := range []time.Time{b.Start, b.End} {
			if t.After(s) && t.Before(e) {
				cuts[t.UnixNano()] = t
			}
		}
	}
	ts := make([]time.Time, 0, len(cuts))
	for _, t := range cuts {
		ts = append(ts, t)
	}
	sort.Slice(ts, func(i, j int) bool { return ts[i].Before(ts[j]) })
	var segs []segment
	for i := 0; i+1 < len(ts); i++ {
		a, b := ts[i], ts[i+1]
		seg := segment{from: a, to: b, use: map[string]float64{}}
		for _, x := range rel {
			if x.Start.Before(b) && x.End.After(a) {
				for r, v := range x.Amount {
					if r != ResDiskGB { // Speicherplatz ist kumulativ und wird separat geprüft
						seg.use[r] += v
					}
				}
				seg.jobs = append(seg.jobs, x.JobID)
			}
		}
		segs = append(segs, seg)
	}
	return segs
}

// firstViolation: erster Abschnitt, in dem die Anfrage zusammen mit den Buchungen eine Obergrenze reißt.
func firstViolation(h HostCap, req Request, booked []Booked, rules Rules, s, e time.Time) (res string, seg segment, hard float64, found bool) {
	for _, sg := range segmentsOn(h.ID, booked, s, e) {
		for _, r := range ResourceKinds {
			if r == ResDiskGB {
				continue
			}
			need := req.Demand.Amount[r]
			if need <= 0 {
				continue
			}
			lim, limited := effHard(h, r, req.Priority, rules)
			if !limited {
				continue
			}
			if sg.use[r]+need > lim+1e-9 {
				return r, sg, lim, true
			}
		}
	}
	return "", segment{}, 0, false
}

func diskUsed(host string, booked []Booked, now time.Time) float64 {
	var sum float64
	for _, b := range booked {
		if b.Host == host && b.End.After(now) {
			sum += b.Amount[ResDiskGB]
		}
	}
	return sum
}

func sourceOverlaps(req Request, booked []Booked) []string {
	var jobs []string
	for _, b := range booked {
		if b.Source == req.Source && b.JobID != req.JobID && b.Start.Before(req.End) && b.End.After(req.Start) {
			jobs = append(jobs, b.JobID)
		}
	}
	return jobs
}

func tp(t time.Time) *time.Time { return &t }

// earliestOn sucht auf einem Host den frühesten Start ≥ req.Start, ab dem die Anfrage über ihre ganze Dauer passt.
func earliestOn(h HostCap, req Request, booked []Booked, rules Rules, now time.Time) (time.Time, bool) {
	dur := req.End.Sub(req.Start)
	cands := []time.Time{req.Start}
	for _, b := range booked {
		if b.Host == h.ID && b.End.After(req.Start) && b.End.Before(req.Start.Add(rules.horizon())) {
			cands = append(cands, b.End)
		}
	}
	sort.Slice(cands, func(i, j int) bool { return cands[i].Before(cands[j]) })
	for _, c := range cands {
		if _, _, _, v := firstViolation(h, req, booked, rules, c, c.Add(dur)); !v {
			return c, true
		}
	}
	return time.Time{}, false
}

// Plan entscheidet über eine Anfrage. now dient nur der Speicherplatzprüfung (kumulativ ab jetzt).
func Plan(req Request, hosts []HostCap, booked []Booked, rules Rules, now time.Time) Decision {
	d := Decision{Verdicts: []Verdict{}}
	dur := req.End.Sub(req.Start)
	if dur <= 0 {
		d.Verdicts = append(d.Verdicts, Verdict{Kind: VHardShortage, Blocking: true, Message: "Ende liegt nicht nach dem Start"})
		return d
	}
	// Quelle
	if jobs := sourceOverlaps(req, booked); len(jobs) >= rules.sourceLimit(req.Source) {
		d.Verdicts = append(d.Verdicts, Verdict{Kind: VSourceConflict, Blocking: true, Jobs: jobs, From: tp(req.Start), To: tp(req.End),
			Message: fmt.Sprintf("Quelle ist im Zeitraum bereits %d× vergeben (Limit %d)", len(jobs), rules.sourceLimit(req.Source)),
			Action:  "Anderen Zeitraum wählen, ein Aufnahme-Ziel zusammenlegen oder das Quellenlimit erhöhen"})
		return d
	}
	// Kandidaten: Wunschhost zuerst, dann nach Belegung
	cands := append([]HostCap(nil), hosts...)
	sort.SliceStable(cands, func(i, j int) bool {
		if (cands[i].ID == req.HostPref) != (cands[j].ID == req.HostPref) {
			return cands[i].ID == req.HostPref
		}
		return cands[i].ID < cands[j].ID
	})
	type hostResult struct {
		h        HostCap
		blocking []Verdict
		soft     []Verdict
		earliest *time.Time
	}
	var results []hostResult
	functional := 0
	for _, h := range cands {
		hr := hostResult{h: h}
		if !h.Online {
			continue
		}
		missing := ""
		for _, fn := range req.Needs {
			if !h.has(fn) {
				missing = fn
			}
		}
		if missing != "" {
			continue
		}
		functional++
		// statisch: passt die Anfrage allein?
		static := false
		for _, r := range ResourceKinds {
			need := req.Demand.Amount[r]
			if need <= 0 {
				continue
			}
			if lim, limited := effHard(h, r, req.Priority, rules); limited && need > lim+1e-9 {
				static = true
				hard, _ := h.Hard[r]
				hr.blocking = append(hr.blocking, Verdict{Kind: map[bool]string{true: VStorage, false: VHardShortage}[r == ResDiskMBps || r == ResDiskGB], Blocking: true, Resource: r, Host: h.ID,
					Needed: need, Available: lim,
					Message: fmt.Sprintf("%s braucht %.4g, der Host bietet höchstens %.4g%s", r, need, lim, map[bool]string{true: fmt.Sprintf(" (Reserve für höhere Priorität: Gesamt %.4g)", hard), false: ""}[lim < hard]),
					Action:  "Anderen Host/Profil wählen oder die Budgetgrenze des Hosts anheben"})
			}
		}
		if static {
			results = append(results, hr)
			continue
		}
		// Speicherplatz (kumulativ)
		if need := req.Demand.Amount[ResDiskGB]; need > 0 {
			if lim, limited := effHard(h, ResDiskGB, req.Priority, rules); limited {
				used := diskUsed(h.ID, booked, now)
				if used+need > lim+1e-9 {
					hr.blocking = append(hr.blocking, Verdict{Kind: VStorage, Blocking: true, Resource: ResDiskGB, Host: h.ID, Needed: need, Available: math.Max(0, lim-used),
						Message: fmt.Sprintf("Speicherplatz: %.1f GB nötig, nach bereits geplanten Aufnahmen nur %.1f GB frei", need, math.Max(0, lim-used)),
						Action:  "Platz schaffen, anderes Ziel wählen oder kürzere Aufnahme planen"})
					results = append(results, hr)
					continue
				}
			}
		}
		// Zeitfenster
		if res, seg, hard, bad := firstViolation(h, req, booked, rules, req.Start, req.End); bad {
			v := Verdict{Kind: VTempOccupied, Blocking: true, Resource: res, Host: h.ID, From: tp(seg.from), To: tp(seg.to), Jobs: seg.jobs,
				Needed: req.Demand.Amount[res], Available: math.Max(0, hard-seg.use[res]),
				Message: fmt.Sprintf("%s: %.4g nötig, im Zeitraum nur %.4g frei (belegt durch %d Auftrag/Aufträge)", res, req.Demand.Amount[res], math.Max(0, hard-seg.use[res]), len(seg.jobs))}
			if t, ok := earliestOn(h, req, booked, rules, now); ok {
				hr.earliest = tp(t)
				v.Action = "Frühester möglicher Start auf diesem Host: " + t.UTC().Format(time.RFC3339)
			} else {
				v.Kind = VHardShortage
				v.Action = "Auch im Planungshorizont wird nichts frei — Budget erhöhen oder Aufträge verschieben"
			}
			if rules.AllowPreempt {
				v.Preemptable = preemptable(h, req, booked, rules)
			}
			hr.blocking = append(hr.blocking, v)
			results = append(results, hr)
			continue
		}
		// Warnschwelle & Unsicherheit (nicht blockierend)
		if h.SoftFrac > 0 {
			for _, sg := range segmentsOn(h.ID, booked, req.Start, req.End) {
				for _, r := range ResourceKinds {
					if r == ResDiskGB {
						continue
					}
					if hard, ok := h.Hard[r]; ok && hard > 0 && req.Demand.Amount[r] > 0 && (sg.use[r]+req.Demand.Amount[r])/hard > h.SoftFrac+1e-9 {
						hr.soft = append(hr.soft, Verdict{Kind: VSoftWarning, Resource: r, Host: h.ID, From: tp(sg.from), To: tp(sg.to), Needed: req.Demand.Amount[r], Available: hard - sg.use[r],
							Message: fmt.Sprintf("%s: danach %.0f %% der Obergrenze belegt (Warnschwelle %.0f %%)", r, 100*(sg.use[r]+req.Demand.Amount[r])/hard, 100*h.SoftFrac)})
						break
					}
				}
			}
		}
		results = append(results, hr)
		if len(hr.blocking) == 0 {
			d.Admit, d.Host = true, h.ID
			d.Verdicts = append(d.Verdicts, hr.soft...)
			break
		}
	}
	if d.Admit {
		var unc []string
		for r, o := range req.Demand.Origin {
			if o == OriginDefault && req.Demand.Amount[r] > 0 {
				unc = append(unc, r)
			}
		}
		sort.Strings(unc)
		if len(unc) > 0 {
			d.Verdicts = append(d.Verdicts, Verdict{Kind: VUncertain, Message: fmt.Sprintf("Bedarf für %v ist nur ein Standardwert (nicht gemessen/konfiguriert)", unc),
				Action: "Profil-Bedarf messen lassen oder im Profil eintragen"})
		}
		if len(d.Verdicts) == 0 {
			d.Verdicts = append(d.Verdicts, Verdict{Kind: VOK, Message: "Zugelassen"})
		}
		return d
	}
	if functional == 0 {
		need := "?"
		if len(req.Needs) > 0 {
			need = req.Needs[0]
		}
		d.Verdicts = append(d.Verdicts, Verdict{Kind: VMissingFunction, Blocking: true, Message: fmt.Sprintf("Kein verfügbarer Host stellt die Funktion %q bereit", need),
			Action: "Host mit Rekorder/Konverter online bringen oder die Funktion im Hostbudget freischalten"})
		return d
	}
	// Alle Kandidaten blockiert: Gründe des Hosts mit frühestem Start zuerst (sonst des ersten)
	sort.SliceStable(results, func(i, j int) bool {
		a, b := results[i].earliest, results[j].earliest
		switch {
		case a != nil && b != nil:
			return a.Before(*b)
		case a != nil:
			return true
		}
		return false
	})
	for _, r := range results {
		d.Verdicts = append(d.Verdicts, r.blocking...)
		if r.earliest != nil {
			d.Alternatives = append(d.Alternatives, Alternative{Host: r.h.ID, Start: *r.earliest})
			if d.EarliestStart == nil || r.earliest.Before(*d.EarliestStart) {
				d.EarliestStart = r.earliest
			}
		}
	}
	return d
}

// preemptable: künftige (nicht laufende) Buchungen niedrigerer Priorität, nach deren Entfernen die Anfrage passen würde.
func preemptable(h HostCap, req Request, booked []Booked, rules Rules) []string {
	var lower []Booked
	for _, b := range booked {
		if b.Host == h.ID && !b.Active && b.Priority < req.Priority && b.Start.Before(req.End) && b.End.After(req.Start) {
			lower = append(lower, b)
		}
	}
	sort.Slice(lower, func(i, j int) bool { return lower[i].Priority < lower[j].Priority })
	var drop []string
	rest := booked
	for _, b := range lower {
		var next []Booked
		for _, x := range rest {
			if x.JobID != b.JobID {
				next = append(next, x)
			}
		}
		rest = next
		drop = append(drop, b.JobID)
		if _, _, _, bad := firstViolation(h, req, rest, rules, req.Start, req.End); !bad {
			return drop
		}
	}
	return nil
}

// PeakUsage berechnet je Ressource den Verlauf (für die Kapazitätsansicht): Abschnitte mit Nutzung und Obergrenze.
type UsagePoint struct {
	From time.Time          `json:"from"`
	To   time.Time          `json:"to"`
	Use  map[string]float64 `json:"use"`
	Jobs []string           `json:"jobs,omitempty"`
}

func UsageTimeline(h HostCap, booked []Booked, from, to time.Time) []UsagePoint {
	var out []UsagePoint
	for _, s := range segmentsOn(h.ID, booked, from, to) {
		out = append(out, UsagePoint{From: s.from, To: s.to, Use: s.use, Jobs: s.jobs})
	}
	return out
}
