// Package housekeeping räumt Tabellen auf, die sonst unbegrenzt wachsen
// würden und keinen eigenen Retention-Lauf haben (Nutzerauftrag 2026-10-01:
// "datenbank purges/cleanup generell nicht vergessen"). Bereits anderswo
// bereinigt: audit_log, domain_audit_log (audit), logs (logbus),
// workflow_runs (workflows.RunStore), die JetStream-Streams (MaxAge).
// Hier: Outbox, Host-Einmaltokens, abgeschlossene Prozess-Ausführungen,
// quittierte Alarme. Alles idempotent und ohne Leader-Gating sicher.
//
// Bewusst NICHT automatisch gelöscht (Nutzerdaten bzw. Betriebsstand):
// Workflows, Snapshots, Layouts, Assets, Prozess-Definitionen, Hosts,
// Katalog, Profile je Node-Typ, Instanzen.
package housekeeping

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"time"
)

// Interval: Abstand zweier Durchläufe.
const Interval = 24 * time.Hour

// Config: Aufbewahrung in Tagen; <= 0 deaktiviert die jeweilige Löschung.
type Config struct {
	OutboxDays           int // versendete Outbox-Zeilen
	HostTokenDays        int // verbrauchte/abgelaufene Host-Einmaltokens
	ProcessExecutionDays int // abgeschlossene Prozess-Ausführungen samt Schritten/Aufgaben/Asset-Verknüpfungen
}

// AlarmAckPurger räumt abgelaufene Alarm-Quittierungen (alarmacks.Store).
type AlarmAckPurger interface {
	PurgeStale() (int64, error)
}

type Housekeeper struct {
	db   *sql.DB
	cfg  Config
	acks AlarmAckPurger
}

func New(db *sql.DB, cfg Config, acks AlarmAckPurger) *Housekeeper {
	return &Housekeeper{db: db, cfg: cfg, acks: acks}
}

// Result: gelöschte Zeilen je Bereich.
type Result struct {
	Outbox, HostTokens, ProcessExecutions, AlarmAcks int64
}

// PurgeOnce führt alle Bereinigungen einmal aus. Ein Fehler in einem Bereich
// bricht die anderen nicht ab; der erste Fehler wird zurückgegeben.
func (h *Housekeeper) PurgeOnce() (Result, error) {
	var res Result
	var firstErr error
	note := func(area string, err error) {
		if err != nil {
			slog.Warn("housekeeping: purge failed", "area", area, "error", err)
			if firstErr == nil {
				firstErr = fmt.Errorf("housekeeping %s: %w", area, err)
			}
		}
	}
	var err error
	if h.cfg.OutboxDays > 0 {
		// Nur bereits versendete Zeilen; unversendete bleiben immer.
		res.Outbox, err = h.exec(`DELETE FROM outbox_events WHERE dispatched_at IS NOT NULL AND dispatched_at < now() - ($1 * interval '1 day')`, h.cfg.OutboxDays)
		note("outbox", err)
	}
	if h.cfg.HostTokenDays > 0 {
		res.HostTokens, err = h.exec(`DELETE FROM host_bootstrap_tokens WHERE COALESCE(used_at, expires_at) < now() - ($1 * interval '1 day') AND expires_at < now()`, h.cfg.HostTokenDays)
		note("host tokens", err)
	}
	if h.cfg.ProcessExecutionDays > 0 {
		// Nur abgeschlossene Ausführungen ohne Kind-Ausführungen (parent_execution_id
		// hat kein ON DELETE CASCADE); Schritte, Aufgaben und Asset-Verknüpfungen
		// fallen per CASCADE mit. Ketten räumt der nächste Lauf ab.
		res.ProcessExecutions, err = h.exec(`
			DELETE FROM process_executions e
			WHERE e.completed_at IS NOT NULL AND e.completed_at < now() - ($1 * interval '1 day')
			  AND NOT EXISTS (SELECT 1 FROM process_executions c WHERE c.parent_execution_id = e.id)`, h.cfg.ProcessExecutionDays)
		note("process executions", err)
	}
	if h.acks != nil {
		res.AlarmAcks, err = h.acks.PurgeStale()
		note("alarm acks", err)
	}
	return res, firstErr
}

func (h *Housekeeper) exec(q string, days int) (int64, error) {
	r, err := h.db.Exec(q, days)
	if err != nil {
		return 0, err
	}
	return r.RowsAffected()
}

// Run löscht einmal sofort und danach alle Interval, bis ctx endet.
func (h *Housekeeper) Run(ctx context.Context) {
	h.once()
	t := time.NewTicker(Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			h.once()
		}
	}
}

func (h *Housekeeper) once() {
	res, _ := h.PurgeOnce()
	if res.Outbox+res.HostTokens+res.ProcessExecutions+res.AlarmAcks > 0 {
		slog.Info("housekeeping: purge completed",
			"outbox", res.Outbox, "host_tokens", res.HostTokens,
			"process_executions", res.ProcessExecutions, "alarm_acks", res.AlarmAcks)
	}
}
