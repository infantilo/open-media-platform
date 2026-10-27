package trends

import (
	"context"
	"database/sql"
	"sync"
	"time"
)

// RetentionDays: so lange bleibt der Stundenverlauf (die Baseline braucht mindestens drei, besser zwei Wochen).
const RetentionDays = 35

type key struct{ subject, metric string }

type acc struct {
	hour       time.Time
	label      string
	sum, max   float64
	n          int
	flushedSum float64
	flushedN   int
	flushedMax float64
}

// Collector verdichtet Messwerte zu Stundenwerten und schreibt sie in trend_hourly. Die Werte einer laufenden Stunde werden regelmäßig
// als Zuwachs nachgetragen (kein Doppelzählen), ein Neustart des Orchestrators setzt die Stunde nahtlos fort.
type Collector struct {
	db  *sql.DB
	mu  sync.Mutex
	acc map[key]*acc
	// pending: abgeschlossene Stunden, die noch geschrieben werden müssen.
	pending []pendingRow
}

type pendingRow struct {
	k             key
	hour          time.Time
	label         string
	sumDelta, max float64
	nDelta        int
}

func NewCollector(db *sql.DB) *Collector { return &Collector{db: db, acc: map[key]*acc{}} }

// Observe nimmt einen Messwert auf.
func (c *Collector) Observe(subject, label, metric string, v float64, at time.Time) {
	k := key{subject, metric}
	hour := at.UTC().Truncate(time.Hour)
	c.mu.Lock()
	defer c.mu.Unlock()
	a := c.acc[k]
	if a != nil && !a.hour.Equal(hour) {
		c.closeLocked(k, a)
		a = nil
	}
	if a == nil {
		a = &acc{hour: hour}
		c.acc[k] = a
	}
	a.label = label
	a.sum += v
	a.n++
	if a.n == 1 || v > a.max {
		a.max = v
	}
}

func (c *Collector) closeLocked(k key, a *acc) {
	if a.n > a.flushedN {
		c.pending = append(c.pending, pendingRow{k: k, hour: a.hour, label: a.label, sumDelta: a.sum - a.flushedSum, max: a.max, nDelta: a.n - a.flushedN})
	}
}

// Flush schreibt abgeschlossene Stunden und den Zuwachs der laufenden.
func (c *Collector) Flush(ctx context.Context) error {
	c.mu.Lock()
	rows := c.pending
	c.pending = nil
	for k, a := range c.acc {
		if a.n > a.flushedN {
			rows = append(rows, pendingRow{k: k, hour: a.hour, label: a.label, sumDelta: a.sum - a.flushedSum, max: a.max, nDelta: a.n - a.flushedN})
			a.flushedSum, a.flushedN, a.flushedMax = a.sum, a.n, a.max
		}
	}
	c.mu.Unlock()
	for _, r := range rows {
		_, err := c.db.ExecContext(ctx, `INSERT INTO trend_hourly (subject, metric, hour, label, avg, max, samples) VALUES ($1,$2,$3,$4,$5,$6,$7)
			ON CONFLICT (subject, metric, hour) DO UPDATE SET
			  avg = (trend_hourly.avg * trend_hourly.samples + $5 * $7) / (trend_hourly.samples + $7),
			  max = GREATEST(trend_hourly.max, $6), samples = trend_hourly.samples + $7, label = $4`,
			r.k.subject, r.k.metric, r.hour, r.label, r.sumDelta/float64(r.nDelta), r.max, r.nDelta)
		if err != nil {
			return err
		}
	}
	return nil
}

// Series ist ein Stundenverlauf einer Messgröße.
type Series struct {
	Subject, Label, Metric string
	Points                 []Point
}

// All liefert alle Verläufe seit since (aus der Datenbank; zuvor Flush aufrufen).
func (c *Collector) All(ctx context.Context, since time.Time) ([]Series, error) {
	rows, err := c.db.QueryContext(ctx, `SELECT subject, metric, label, hour, avg, max FROM trend_hourly WHERE hour >= $1 ORDER BY subject, metric, hour`, since.UTC())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Series
	idx := map[key]int{}
	for rows.Next() {
		var subj, metric, label string
		var p Point
		if err := rows.Scan(&subj, &metric, &label, &p.T, &p.Avg, &p.Max); err != nil {
			return nil, err
		}
		k := key{subj, metric}
		i, ok := idx[k]
		if !ok {
			i = len(out)
			idx[k] = i
			out = append(out, Series{Subject: subj, Metric: metric})
		}
		out[i].Label = label
		out[i].Points = append(out[i].Points, p)
	}
	return out, rows.Err()
}

// Purge löscht Stundenwerte älter als RetentionDays.
func (c *Collector) Purge(ctx context.Context) (int64, error) {
	res, err := c.db.ExecContext(ctx, `DELETE FROM trend_hourly WHERE hour < now() - ($1 * interval '1 day')`, RetentionDays)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// RunFlush schreibt alle fünf Minuten und räumt täglich auf, bis ctx endet.
func (c *Collector) RunFlush(ctx context.Context, onError func(error)) {
	tick := time.NewTicker(5 * time.Minute)
	defer tick.Stop()
	purgeAt := time.Now()
	for {
		select {
		case <-ctx.Done():
			fctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = c.Flush(fctx)
			cancel()
			return
		case now := <-tick.C:
			if err := c.Flush(ctx); err != nil && onError != nil {
				onError(err)
			}
			if now.Sub(purgeAt) > 24*time.Hour {
				purgeAt = now
				_, _ = c.Purge(ctx)
			}
		}
	}
}
