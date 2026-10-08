package cloud

import (
	"context"
	"fmt"
	"math"
	"sort"
	"sync"
	"time"
)

// PriceBook ist die Preisliste (je Instanztyp) mit der Abrechnungsregel des Anbieters.
// Alle Zahlen daraus sind SCHÄTZUNGEN (ARCHITECTURE.md §27.3): Datentransfer, Speicher und
// Rabatte sind nicht enthalten, abgerechnet wird, was der Anbieter später meldet.
type PriceBook struct {
	Types map[string]InstanceType
	// MinBilled: Mindestabrechnung je Start (bei sekundengenauer Abrechnung typisch 60 s).
	MinBilled time.Duration
}

// NewPriceBook baut eine Preisliste aus einer Anbieter-Preisliste.
func NewPriceBook(types []InstanceType, minBilled time.Duration) PriceBook {
	pb := PriceBook{Types: map[string]InstanceType{}, MinBilled: minBilled}
	for _, t := range types {
		pb.Types[t.Name] = t
	}
	return pb
}

func round6(v float64) float64 { return math.Round(v*1e6) / 1e6 }

// RunCost: geschätzte Kosten einer Instanz, die von `from` bis `to` läuft (Mindestabrechnung beachtet).
func (pb PriceBook) RunCost(typ string, from, to time.Time) (float64, string, error) {
	t, ok := pb.Types[typ]
	if !ok {
		return 0, "", fmt.Errorf("cloud: no price for instance type %q", typ)
	}
	d := to.Sub(from)
	if d < 0 {
		d = 0
	}
	if d > 0 && d < pb.MinBilled {
		d = pb.MinBilled
	}
	return round6(t.PricePerHour * d.Seconds() / 3600), t.Currency, nil
}

// HostSpend: bisher angefallene geschätzte Kosten eines geführten Hosts bis `now` (läuft er noch)
// bzw. bis zu seinem Ende. Die Abrechnung beginnt mit dem Start der Instanz (RequestedAt).
func (pb PriceBook) HostSpend(h Host, now time.Time) (float64, error) {
	end := now
	if !h.EndedAt.IsZero() {
		end = h.EndedAt
	}
	c, _, err := pb.RunCost(h.InstanceType, h.RequestedAt, end)
	return c, err
}

// Spend summiert die geschätzten Kosten aller Hosts im Zeitraum [from, to) (auf den Zeitraum
// zugeschnitten). Hosts mit unbekanntem Typ werden in `unpriced` gemeldet statt still als 0 zu zählen.
func (pb PriceBook) Spend(hosts []Host, from, to, now time.Time) (total float64, currency string, unpriced []string) {
	for _, h := range hosts {
		t, ok := pb.Types[h.InstanceType]
		if !ok {
			unpriced = append(unpriced, h.ID)
			continue
		}
		currency = t.Currency
		start, end := h.RequestedAt, now
		if !h.EndedAt.IsZero() {
			end = h.EndedAt
		}
		if start.Before(from) {
			start = from
		}
		if end.After(to) {
			end = to
		}
		if !end.After(start) {
			continue
		}
		c, _, _ := pb.RunCost(h.InstanceType, start, end)
		total += c
	}
	return round6(total), currency, unpriced
}

// Projection: bereits angefallene Kosten im Zeitraum [periodStart, periodEnd) plus die Hochrechnung der
// jetzt laufenden Hosts bis periodEnd — die Zahl, gegen die der Budgetdeckel prüft (§27.5).
func (pb PriceBook) Projection(hosts []Host, periodStart, periodEnd, now time.Time) (spent, projected float64, currency string, unpriced []string) {
	spent, currency, unpriced = pb.Spend(hosts, periodStart, now, now)
	projected = spent
	if !periodEnd.After(now) {
		return spent, projected, currency, unpriced
	}
	for _, h := range hosts {
		if !h.EndedAt.IsZero() || h.State == HostTerminated || h.State == HostFailed {
			continue
		}
		t, ok := pb.Types[h.InstanceType]
		if !ok {
			continue
		}
		projected += t.PricePerHour * periodEnd.Sub(now).Hours()
	}
	return spent, round6(projected), currency, unpriced
}

// Demand: Bedarf an `Count` Hosts eines Typs, die von `From` bis `To` BEREIT sein sollen.
type Demand struct {
	Pool         string    `json:"pool,omitempty"`
	InstanceType string    `json:"instanceType"`
	Count        int       `json:"count"`
	From         time.Time `json:"from"`
	To           time.Time `json:"to"`
}

// HostRun ist ein geschätzter Host-Lauf (inkl. Boot-Vorlauf und Abbau).
type HostRun struct {
	InstanceType string    `json:"instanceType"`
	Start        time.Time `json:"start"` // Anforderung beim Anbieter
	End          time.Time `json:"end"`   // Ende der Abrechnung
	Hours        float64   `json:"hours"`
	Cost         float64   `json:"cost"`
}

// Estimate ist das Ergebnis der Kostenvorberechnung. `Estimated` ist immer true: das ist keine Abrechnung.
type Estimate struct {
	Runs        []HostRun `json:"runs"`
	Total       float64   `json:"total"`
	Currency    string    `json:"currency"`
	Estimated   bool      `json:"estimated"`
	Assumptions []string  `json:"assumptions"`
}

// Estimate rechnet vorab, was ein Bedarf kostet. Je Instanztyp wird die Bedarfskurve (Anzahl gleichzeitig
// bereiter Hosts über der Zeit) abgefahren; Host Nr. j läuft in den Zeiträumen, in denen mindestens j gebraucht
// werden. `lead` (Boot-Vorlauf) wird vor jedem Lauf, `teardown` (Entladen) nach jedem Lauf abgerechnet. Lücken,
// die höchstens lead+teardown lang sind, überbrückt der Host (billiger als Beenden und Neustart).
func (pb PriceBook) Estimate(demands []Demand, lead, teardown time.Duration) (Estimate, error) {
	est := Estimate{Runs: []HostRun{}, Estimated: true, Assumptions: []string{
		fmt.Sprintf("Boot-Vorlauf %s und Abbau %s je Lauf werden mit abgerechnet", lead, teardown),
		"Datentransfer, Speicher und Rabatte sind nicht enthalten",
		"Lücken bis Vorlauf+Abbau werden vom selben Host überbrückt",
	}}
	byType := map[string][]Demand{}
	for _, d := range demands {
		if d.Count <= 0 || !d.To.After(d.From) {
			continue
		}
		if _, ok := pb.Types[d.InstanceType]; !ok {
			return Estimate{}, fmt.Errorf("cloud: no price for instance type %q", d.InstanceType)
		}
		byType[d.InstanceType] = append(byType[d.InstanceType], d)
	}
	types := make([]string, 0, len(byType))
	for t := range byType {
		types = append(types, t)
	}
	sort.Strings(types)
	for _, typ := range types {
		ds := byType[typ]
		// Ereignisse: +Count bei From, −Count bei To.
		type ev struct {
			at    time.Time
			delta int
		}
		var evs []ev
		for _, d := range ds {
			evs = append(evs, ev{d.From, d.Count}, ev{d.To, -d.Count})
		}
		sort.Slice(evs, func(i, j int) bool {
			if !evs[i].at.Equal(evs[j].at) {
				return evs[i].at.Before(evs[j].at)
			}
			return evs[i].delta < evs[j].delta // Enden vor Anfängen: nahtloser Anschluss ohne Lücke
		})
		// Bedarfsstufen: für j=1..max die Zeiträume mit needed >= j.
		type span struct{ from, to time.Time }
		levels := map[int][]span{}
		cur, open := 0, map[int]time.Time{}
		for _, e := range evs {
			prev := cur
			cur += e.delta
			for j := prev + 1; j <= cur; j++ {
				open[j] = e.at
			}
			for j := prev; j > cur && j >= 1; j-- {
				if s, ok := open[j]; ok {
					if e.at.After(s) {
						levels[j] = append(levels[j], span{s, e.at})
					}
					delete(open, j)
				}
			}
		}
		keys := make([]int, 0, len(levels))
		for j := range levels {
			keys = append(keys, j)
		}
		sort.Ints(keys)
		for _, j := range keys {
			spans := levels[j]
			sort.Slice(spans, func(a, b int) bool { return spans[a].from.Before(spans[b].from) })
			merged := []span{spans[0]}
			for _, s := range spans[1:] {
				last := &merged[len(merged)-1]
				if s.from.Sub(last.to) <= lead+teardown {
					if s.to.After(last.to) {
						last.to = s.to
					}
				} else {
					merged = append(merged, s)
				}
			}
			for _, s := range merged {
				start, end := s.from.Add(-lead), s.to.Add(teardown)
				c, cur2, err := pb.RunCost(typ, start, end)
				if err != nil {
					return Estimate{}, err
				}
				est.Currency = cur2
				est.Runs = append(est.Runs, HostRun{InstanceType: typ, Start: start, End: end, Hours: round6(end.Sub(start).Hours()), Cost: c})
				est.Total += c
			}
		}
	}
	est.Total = round6(est.Total)
	sort.Slice(est.Runs, func(i, j int) bool {
		if !est.Runs[i].Start.Equal(est.Runs[j].Start) {
			return est.Runs[i].Start.Before(est.Runs[j].Start)
		}
		return est.Runs[i].InstanceType < est.Runs[j].InstanceType
	})
	return est, nil
}

// CostService stellt Preisliste und Vorberechnung für die API bereit (Preisliste wird kurz zwischengespeichert).
type CostService struct {
	Provider  Provider
	Region    string
	MinBilled time.Duration
	// Lead/Teardown: Standardwerte für Boot-Vorlauf und Abbau, wenn die Anfrage keine nennt.
	Lead, Teardown time.Duration
	// CacheTTL: Gültigkeit der Preisliste (Standard 1 h).
	CacheTTL time.Duration
	Now      func() time.Time

	mu      sync.Mutex
	cached  []InstanceType
	cachedA time.Time
}

func (s *CostService) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// Types liefert die Preisliste des Anbieters (zwischengespeichert; bei Anbieterfehler die letzte bekannte).
func (s *CostService) Types(ctx context.Context) ([]InstanceType, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ttl := s.CacheTTL
	if ttl == 0 {
		ttl = time.Hour
	}
	if s.cached != nil && s.now().Sub(s.cachedA) < ttl {
		return append([]InstanceType(nil), s.cached...), nil
	}
	types, err := s.Provider.Catalog(ctx, s.Region)
	if err != nil {
		if s.cached != nil {
			return append([]InstanceType(nil), s.cached...), nil
		}
		return nil, err
	}
	s.cached, s.cachedA = types, s.now()
	return append([]InstanceType(nil), types...), nil
}

// Estimate rechnet einen Bedarf vorab; lead/teardown ≤ 0 nehmen die Standardwerte des Dienstes.
func (s *CostService) Estimate(ctx context.Context, demands []Demand, lead, teardown time.Duration) (Estimate, error) {
	types, err := s.Types(ctx)
	if err != nil {
		return Estimate{}, err
	}
	if lead <= 0 {
		lead = s.Lead
	}
	if teardown <= 0 {
		teardown = s.Teardown
	}
	return NewPriceBook(types, s.MinBilled).Estimate(demands, lead, teardown)
}
