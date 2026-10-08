package cloud

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

// LoadSample ist die durchschnittliche Auslastung der Hosts, auf denen Last platziert wird.
type LoadSample struct {
	CPUPercent float64
	MemPercent float64
	Hosts      int
}

// Suggestion ist ein zur Bestätigung vorgeschlagener zusätzlicher Host (Modus `suggest`).
type Suggestion struct {
	ID        string    `json:"id"`
	Pool      string    `json:"pool"`
	CreatedAt time.Time `json:"createdAt"`
	Reason    string    `json:"reason"`
	// Code/Params: maschinenlesbare Begründung für die Übersetzung in der Oberfläche (Reason bleibt englisch).
	Code       string         `json:"code,omitempty"`
	Params     map[string]any `json:"params,omitempty"`
	HourlyCost float64        `json:"hourlyCost,omitempty"`
	Currency   string         `json:"currency,omitempty"`
}

type poolAuto struct {
	target     int // zusätzliche Hosts durch Autoscaling (über Minimum/Reservierung)
	upSince    time.Time
	downSince  time.Time
	lastScale  time.Time
	budgetNote time.Time
}

const budgetNoteEvery = 10 * time.Minute

// Why begründet eine Budget-Entscheidung maschinenlesbar (die Oberfläche übersetzt `Code` + `Params`) und als
// englischer Text (Log, Audit, API-Fehler).
type Why struct {
	Code   string
	Params map[string]any
	Text   string
}

func loadParams(l LoadSample, after time.Duration) map[string]any {
	p := map[string]any{"cpu": int(l.CPUPercent + 0.5), "mem": int(l.MemPercent + 0.5), "hosts": l.Hosts}
	if after > 0 {
		p["minutes"] = int(after.Minutes() + 0.5)
	}
	return p
}

// withWhy bettet eine Budget-Begründung in die Parameter einer anderen Aktion ein.
func withWhy(w Why) map[string]any {
	p := map[string]any{"why": w.Code}
	for k, v := range w.Params {
		p[k] = v
	}
	return p
}

func (c *PoolController) policy(pool string) Policy {
	if c.Policies == nil {
		return DefaultPolicy(pool)
	}
	p, err := c.Policies.Get(pool)
	if err != nil {
		slog.Warn("cloud: loading policy failed, autoscaling off for this tick", "pool", pool, "error", err)
		return DefaultPolicy(pool)
	}
	return p
}

func (c *PoolController) state(pool string) *poolAuto {
	if c.auto == nil {
		c.auto = map[string]*poolAuto{}
	}
	st := c.auto[pool]
	if st == nil {
		st = &poolAuto{}
		c.auto[pool] = st
	}
	return st
}

// applyAutoscale bewertet die Last gegen die Regeln des Pools und erhöht/senkt das Autoscaling-Ziel; das Soll des
// Pools wird um dieses Ziel (zusätzlich zu Minimum/Reservierung, höchstens Pool-Max) erweitert.
func (c *PoolController) applyAutoscale(ctx context.Context, pool string, now time.Time, want map[string]int) {
	pol := c.policy(pool)
	var acts []Action
	// Budgetprüfung vor dem Sperren (sie liest Preise/Hosts und darf nicht unter c.mu laufen); sie bremst nur
	// ZUSÄTZLICHE Hosts: ohne Spielraum wird das Ziel nicht erhöht (kein Vorhalten eines nie startenden Ziels).
	budgetFree, budgetWhy := true, Why{}
	if pol.Mode != ModeOff {
		budgetFree, budgetWhy = c.budgetOK(ctx, pool, now)
	}
	c.mu.Lock()
	st := c.state(pool)
	if pol.Mode == ModeOff || c.Load == nil {
		st.target, st.upSince, st.downSince = 0, time.Time{}, time.Time{}
		c.dropSuggestions(pool)
		c.mu.Unlock()
		return
	}
	if load, ok := c.Load(); ok {
		high := load.CPUPercent >= pol.UpCPUPercent || load.MemPercent >= pol.UpMemPercent
		low := load.CPUPercent < pol.DownCPUPercent && load.MemPercent < pol.UpMemPercent
		if high {
			if st.upSince.IsZero() {
				st.upSince = now
			}
			st.downSince = time.Time{}
		} else {
			st.upSince = time.Time{}
		}
		if low {
			if st.downSince.IsZero() {
				st.downSince = now
			}
		} else {
			st.downSince = time.Time{}
		}
		cool := st.lastScale.IsZero() || now.Sub(st.lastScale) >= pol.Cooldown()
		reason := fmt.Sprintf("load cpu %.0f%% mem %.0f%% on %d host(s)", load.CPUPercent, load.MemPercent, load.Hosts)
		switch {
		case high && cool && now.Sub(st.upSince) >= pol.UpAfter() && st.target < pol.MaxAutoHosts && !budgetFree:
			if st.budgetNote.IsZero() || now.Sub(st.budgetNote) >= budgetNoteEvery {
				st.budgetNote = now
				acts = append(acts, Action{At: now, Pool: pool, Kind: "budget", Code: "scaleUpSkipped", Params: withWhy(budgetWhy), Reason: "autoscale-up skipped: " + budgetWhy.Text})
			}
		case high && cool && now.Sub(st.upSince) >= pol.UpAfter() && st.target < pol.MaxAutoHosts:
			if pol.Mode == ModeAuto {
				st.target++
				st.lastScale = now
				acts = append(acts, Action{At: now, Pool: pool, Kind: "autoscale-up", Code: "scaleUpLoad", Params: loadParams(load, pol.UpAfter()), Reason: reason + fmt.Sprintf(" ≥ threshold for %s", pol.UpAfter())})
			} else if !c.hasSuggestion(pool) {
				c.sugSeq++
				c.suggestions = append(c.suggestions, Suggestion{ID: fmt.Sprintf("sug-%d", c.sugSeq), Pool: pool, CreatedAt: now, Reason: reason, Code: "suggestLoad", Params: loadParams(load, 0)})
				acts = append(acts, Action{At: now, Pool: pool, Kind: "suggest", Code: "suggestLoad", Params: loadParams(load, 0), Reason: reason})
			}
		case low && cool && now.Sub(st.downSince) >= pol.DownAfter() && st.target > 0:
			st.target--
			st.lastScale = now
			acts = append(acts, Action{At: now, Pool: pool, Kind: "autoscale-down", Code: "scaleDownLoad", Params: loadParams(load, pol.DownAfter()), Reason: reason + fmt.Sprintf(" below threshold for %s", pol.DownAfter())})
		}
	}
	if pol.Mode != ModeSuggest {
		c.dropSuggestions(pool)
	}
	if st.target > pol.MaxAutoHosts {
		st.target = pol.MaxAutoHosts
	}
	if pl, ok := c.Manager.pools[pool]; ok {
		w := want[pool] + st.target
		if pl.Max > 0 && w > pl.Max {
			w = pl.Max
		}
		want[pool] = w
	}
	c.mu.Unlock()
	for _, a := range acts {
		c.record(a)
	}
}

func (c *PoolController) hasSuggestion(pool string) bool {
	for _, s := range c.suggestions {
		if s.Pool == pool {
			return true
		}
	}
	return false
}

func (c *PoolController) dropSuggestions(pool string) {
	kept := c.suggestions[:0]
	for _, s := range c.suggestions {
		if s.Pool != pool {
			kept = append(kept, s)
		}
	}
	c.suggestions = kept
}

// Suggestions liefert die offenen Vorschläge.
func (c *PoolController) Suggestions() []Suggestion {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]Suggestion{}, c.suggestions...)
}

// Dismiss verwirft einen Vorschlag.
func (c *PoolController) Dismiss(id string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for i, s := range c.suggestions {
		if s.ID == id {
			c.suggestions = append(c.suggestions[:i], c.suggestions[i+1:]...)
			return true
		}
	}
	return false
}

// Accept übernimmt einen Vorschlag: der Pool bekommt einen zusätzlichen Host (Budgetdeckel und Obergrenze gelten).
func (c *PoolController) Accept(ctx context.Context, id, by string) error {
	now := c.now()
	c.mu.Lock()
	idx := -1
	for i, s := range c.suggestions {
		if s.ID == id {
			idx = i
		}
	}
	if idx < 0 {
		c.mu.Unlock()
		return ErrSuggestionNotFound
	}
	sg := c.suggestions[idx]
	c.mu.Unlock()
	pol := c.policy(sg.Pool)
	if ok, why := c.budgetOK(ctx, sg.Pool, now); !ok {
		return fmt.Errorf("%w: %s", ErrBudget, why.Text)
	}
	c.mu.Lock()
	st := c.state(sg.Pool)
	if st.target >= pol.MaxAutoHosts {
		c.mu.Unlock()
		return fmt.Errorf("cloud: pool %q already at maxAutoHosts (%d)", sg.Pool, pol.MaxAutoHosts)
	}
	st.target++
	st.lastScale = now
	c.suggestions = append(c.suggestions[:idx], c.suggestions[idx+1:]...)
	c.mu.Unlock()
	c.record(Action{At: now, Pool: sg.Pool, Kind: "autoscale-up", Code: "suggestionAccepted", Params: map[string]any{"id": id, "by": by}, Reason: "suggestion " + id + " accepted by " + by})
	return nil
}

// ---- Budget ----

// PeriodCost sind angefallene und hochgerechnete Kosten einer Abrechnungsperiode gegen den Deckel.
type PeriodCost struct {
	Spent     float64   `json:"spent"`
	Projected float64   `json:"projected"`
	Cap       float64   `json:"cap"`
	From      time.Time `json:"from"`
	To        time.Time `json:"to"`
}

// PoolCosts fasst die geschätzten Kosten eines Pools zusammen (Schätzung, keine Abrechnung).
type PoolCosts struct {
	Pool     string     `json:"pool"`
	Currency string     `json:"currency"`
	Day      PeriodCost `json:"day"`
	Month    PeriodCost `json:"month"`
	Unpriced []string   `json:"unpricedHosts,omitempty"`
	Estimate bool       `json:"estimated"`
}

func periods(now time.Time) (dayFrom, dayTo, monFrom, monTo time.Time) {
	dayFrom = time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	dayTo = dayFrom.AddDate(0, 0, 1)
	monFrom = time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
	monTo = monFrom.AddDate(0, 1, 0)
	return
}

func (c *PoolController) poolHosts(pool string) []Host {
	var out []Host
	for _, h := range c.Manager.Hosts() {
		if h.Pool == pool {
			out = append(out, h)
		}
	}
	return out
}

// Costs berechnet die geschätzten Kosten je Pool für heute und den Monat.
func (c *PoolController) Costs(ctx context.Context) ([]PoolCosts, error) {
	if c.Prices == nil {
		return nil, fmt.Errorf("cloud: no price list")
	}
	pb, err := c.Prices(ctx)
	if err != nil {
		return nil, err
	}
	now := c.now()
	dF, dT, mF, mT := periods(now)
	var out []PoolCosts
	for name := range c.Manager.pools {
		pol := c.policy(name)
		hosts := c.poolHosts(name)
		ds, dp, cur, un := pb.Projection(hosts, dF, dT, now)
		ms, mp, _, _ := pb.Projection(hosts, mF, mT, now)
		out = append(out, PoolCosts{Pool: name, Currency: cur, Estimate: true, Unpriced: un,
			Day:   PeriodCost{Spent: ds, Projected: dp, Cap: pol.DailyBudget, From: dF, To: dT},
			Month: PeriodCost{Spent: ms, Projected: mp, Cap: pol.MonthlyBudget, From: mF, To: mT}})
	}
	sortCosts(out)
	return out, nil
}

func sortCosts(p []PoolCosts) {
	for i := 1; i < len(p); i++ {
		for j := i; j > 0 && p[j].Pool < p[j-1].Pool; j-- {
			p[j], p[j-1] = p[j-1], p[j]
		}
	}
}

// budgetOK prüft, ob ein weiterer Host des Pools den Deckel (Tag/Monat) einhält: angefallene Kosten plus
// Hochrechnung der laufenden Hosts plus der neue Host bis Periodenende. Ohne Deckel oder ohne Preisliste: erlaubt
// (kein Deckel konfiguriert) bzw. verweigert (Preisliste fehlt, aber Deckel gesetzt — im Zweifel kein Geld ausgeben).
func (c *PoolController) budgetOK(ctx context.Context, pool string, now time.Time) (bool, Why) {
	pol := c.policy(pool)
	if pol.DailyBudget <= 0 && pol.MonthlyBudget <= 0 {
		return true, Why{}
	}
	if c.Prices == nil {
		return false, Why{Code: "noPrices", Text: "budget cap set but no price list available"}
	}
	pb, err := c.Prices(ctx)
	if err != nil {
		return false, Why{Code: "pricesUnavailable", Params: map[string]any{"error": err.Error()}, Text: "budget cap set but prices unavailable: " + err.Error()}
	}
	pl, ok := c.Manager.pools[pool]
	if !ok {
		return false, Why{Code: "unknownPool", Text: "unknown pool"}
	}
	t, ok := pb.Types[pl.InstanceType]
	if !ok {
		return false, Why{Code: "noType", Params: map[string]any{"type": pl.InstanceType}, Text: fmt.Sprintf("no price for instance type %q", pl.InstanceType)}
	}
	hosts := c.poolHosts(pool)
	dF, dT, mF, mT := periods(now)
	check := func(label string, from, to time.Time, capv float64) (bool, Why) {
		if capv <= 0 {
			return true, Why{}
		}
		_, projected, _, _ := pb.Projection(hosts, from, to, now)
		extra := t.PricePerHour * to.Sub(now).Hours()
		if projected+extra > capv {
			return false, Why{Code: label + "Exceeded", Params: map[string]any{"cap": capv, "projected": projected, "extra": extra, "currency": t.Currency},
				Text: fmt.Sprintf("%s budget cap %.2f %s would be exceeded (projected %.2f + new host %.2f)", label, capv, t.Currency, projected, extra)}
		}
		return true, Why{}
	}
	if ok, why := check("daily", dF, dT, pol.DailyBudget); !ok {
		return false, why
	}
	return check("monthly", mF, mT, pol.MonthlyBudget)
}

// noteBudget protokolliert eine Budget-Blockade höchstens alle 10 Minuten je Pool (kein Log-Spam bei jedem Tick).
func (c *PoolController) noteBudget(pool string, now time.Time, why Why) {
	c.mu.Lock()
	st := c.state(pool)
	due := st.budgetNote.IsZero() || now.Sub(st.budgetNote) >= budgetNoteEvery
	if due {
		st.budgetNote = now
	}
	c.mu.Unlock()
	if due {
		c.record(Action{At: now, Pool: pool, Kind: "budget", Code: "budget." + why.Code, Params: why.Params, Reason: why.Text})
	}
}
