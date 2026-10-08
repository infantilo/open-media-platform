package cloud

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"
)

// Action ist eine vom Controller ausgeführte (oder gescheiterte) Aktion — für Audit-Log und Anzeige.
type Action struct {
	At     time.Time `json:"at"`
	Pool   string    `json:"pool"`
	Kind   string    `json:"kind"` // provision | release | error
	HostID string    `json:"hostId,omitempty"`
	Reason string    `json:"reason"`
}

// PoolController gleicht je Pool die Zahl der Hosts mit dem Soll ab: Mindestzahl des Pools und aktive
// Reservierungen (ARCHITECTURE.md §27.4/§27.5). Lastgetriebene Regeln und der Budgetdeckel kommen in 35.5
// darüber. Abgebaut wird nur, was nicht (mehr) gebraucht wird UND keine Last trägt: ein überzähliger Host mit
// Instanzen bleibt, bis er leer ist.
type PoolController struct {
	Manager      *Manager
	Reservations ReservationStore
	Now          func() time.Time
	// Lead/Teardown: Boot-Vorlauf vor Reservierungsbeginn und Nachlauf nach -ende.
	Lead, Teardown time.Duration
	// OnAction wird für jede Aktion gerufen (Audit-Log); darf nil sein.
	OnAction func(Action)

	// Autoscaling (35.5); alle drei dürfen nil sein (dann nur Reservierungen und Pool-Minimum).
	Policies PolicyStore
	// Load liefert die aktuelle Auslastung der Hosts (Durchschnitt); ok=false: unbekannt.
	Load func() (LoadSample, bool)
	// Prices liefert die Preisliste für Budgetprüfung und Kostenübersicht.
	Prices func(ctx context.Context) (PriceBook, error)

	mu          sync.Mutex
	log         []Action
	auto        map[string]*poolAuto
	suggestions []Suggestion
	sugSeq      int
}

const actionLogMax = 200

func (c *PoolController) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

func (c *PoolController) record(a Action) {
	c.mu.Lock()
	c.log = append(c.log, a)
	if len(c.log) > actionLogMax {
		c.log = c.log[len(c.log)-actionLogMax:]
	}
	c.mu.Unlock()
	if c.OnAction != nil {
		c.OnAction(a)
	}
}

// Actions liefert die letzten Aktionen (neueste zuletzt).
func (c *PoolController) Actions() []Action {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]Action(nil), c.log...)
}

// desired berechnet je Pool das Soll: Pool-Minimum, bei aktiven Reservierungen deren Maximum.
func (c *PoolController) desired(now time.Time) (map[string]int, error) {
	want := map[string]int{}
	for name, pl := range c.Manager.pools {
		want[name] = pl.Min
	}
	// Eine Reservierung gilt ab From−Lead bis To (der Abbau danach läuft über Draining).
	list, err := c.Reservations.List(now, now.Add(c.Lead+time.Second))
	if err != nil {
		return nil, err
	}
	for _, r := range list {
		if now.Before(r.From.Add(-c.Lead)) || !now.Before(r.To) {
			continue
		}
		if r.HostCount > want[r.Pool] {
			if _, known := want[r.Pool]; known {
				want[r.Pool] = r.HostCount
			}
		}
	}
	return want, nil
}

// Tick treibt den Host-Lebenszyklus und gleicht Soll und Ist ab. Fehler beim Hochfahren werden als Aktion
// `error` festgehalten und beim nächsten Tick erneut versucht (kein stilles Aufgeben).
func (c *PoolController) Tick(ctx context.Context) error {
	now := c.now()
	c.Manager.Tick(ctx)
	want, err := c.desired(now)
	if err != nil {
		return fmt.Errorf("cloud: reservations: %w", err)
	}
	for pool := range want {
		c.applyAutoscale(ctx, pool, now, want)
	}
	hosts := c.Manager.Hosts()
	pools := make([]string, 0, len(want))
	for p := range want {
		pools = append(pools, p)
	}
	sort.Strings(pools)
	for _, pool := range pools {
		var alive, surplusCandidates []Host
		for _, h := range hosts {
			if h.Pool != pool {
				continue
			}
			switch h.State {
			case HostBooting, HostWaitingAgent, HostReady:
				alive = append(alive, h)
			}
		}
		switch diff := want[pool] - len(alive); {
		case diff > 0:
			for i := 0; i < diff; i++ {
				if ok, why := c.budgetOK(ctx, pool, now); !ok {
					c.noteBudget(pool, now, why)
					break
				}
				h, err := c.Manager.Provision(ctx, pool)
				if err != nil {
					slog.Warn("cloud: provision failed", "pool", pool, "error", err)
					c.record(Action{At: now, Pool: pool, Kind: "error", Reason: "provision failed: " + err.Error()})
					break
				}
				c.record(Action{At: now, Pool: pool, Kind: "provision", HostID: h.ID, Reason: fmt.Sprintf("desired %d, alive %d", want[pool], len(alive)+i)})
			}
		case diff < 0:
			// Überzählig: zuerst Hosts, die noch gar nicht bereit sind, dann leerlaufende; Hosts mit Last bleiben.
			for _, h := range alive {
				if h.State != HostReady || (!h.IdleSince.IsZero() && now.Sub(h.IdleSince) >= c.Manager.pools[pool].IdleAfter) {
					surplusCandidates = append(surplusCandidates, h)
				}
			}
			sort.SliceStable(surplusCandidates, func(i, j int) bool {
				ri, rj := surplusCandidates[i].State == HostReady, surplusCandidates[j].State == HostReady
				if ri != rj {
					return !ri
				}
				return surplusCandidates[i].RequestedAt.After(surplusCandidates[j].RequestedAt)
			})
			excess := -diff
			for _, h := range surplusCandidates {
				if excess == 0 {
					break
				}
				if err := c.Manager.Release(ctx, h.ID); err != nil {
					c.record(Action{At: now, Pool: pool, Kind: "error", HostID: h.ID, Reason: "release failed: " + err.Error()})
					continue
				}
				c.record(Action{At: now, Pool: pool, Kind: "release", HostID: h.ID, Reason: fmt.Sprintf("desired %d, alive %d", want[pool], len(alive))})
				excess--
			}
		}
	}
	return nil
}

// Run tickt bis ctx endet; zuerst ein Abgleich mit dem Anbieter (nach Neustart/Leaderwechsel gehen bezahlte
// Hosts so nicht verloren).
func (c *PoolController) Run(ctx context.Context, every time.Duration) {
	if rep, err := c.Manager.Reconcile(ctx); err != nil {
		slog.Warn("cloud: initial reconcile failed", "error", err)
	} else if len(rep.Adopted) > 0 {
		slog.Warn("cloud: adopted unknown instances", "hosts", rep.Adopted)
		for _, id := range rep.Adopted {
			c.record(Action{At: c.now(), Kind: "adopt", HostID: id, Reason: "instance with our tag was not known"})
		}
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := c.Tick(ctx); err != nil {
				slog.Warn("cloud: controller tick failed", "error", err)
			}
		}
	}
}
