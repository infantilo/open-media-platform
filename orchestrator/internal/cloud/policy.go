package cloud

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// Mode: Autoscaling aus (Standard), nur vorschlagen (Operator bestätigt) oder automatisch (§27.5).
type Mode string

const (
	ModeOff     Mode = "off"
	ModeSuggest Mode = "suggest"
	ModeAuto    Mode = "auto"
)

// Policy sind die Autoscaling-Regeln eines Pools. Das Autoscaling betrifft nur ZUSÄTZLICHE Hosts über Pool-Minimum
// und Reservierungen hinaus; der Budgetdeckel gilt für jedes Hochfahren (auch Reservierungen und Pool-Minimum).
type Policy struct {
	Pool string `json:"pool"`
	Mode Mode   `json:"mode"`
	// Hochfahren: Auslastung (Durchschnitt der Hosts) mindestens UpCPU- ODER UpMemPercent für UpAfter.
	UpCPUPercent float64 `json:"upCpuPercent"`
	UpMemPercent float64 `json:"upMemPercent"`
	UpAfterSec   int     `json:"upAfterSec"`
	// Abbauen: CPU unter DownCPUPercent (und Speicher unter UpMem) für DownAfter → ein zusätzlicher Host weniger.
	DownCPUPercent float64 `json:"downCpuPercent"`
	DownAfterSec   int     `json:"downAfterSec"`
	// Cooldown: Mindestabstand zwischen zwei Skalierungsschritten (Hysterese gegen Flattern).
	CooldownSec int `json:"cooldownSec"`
	// MaxAutoHosts: Obergrenze zusätzlicher Hosts durch das Autoscaling (höchstens Pool-Max).
	MaxAutoHosts int `json:"maxAutoHosts"`
	// Budgetdeckel in der Währung der Preisliste; 0 = kein Deckel.
	DailyBudget   float64 `json:"dailyBudget"`
	MonthlyBudget float64 `json:"monthlyBudget"`
}

func (p Policy) UpAfter() time.Duration   { return time.Duration(p.UpAfterSec) * time.Second }
func (p Policy) DownAfter() time.Duration { return time.Duration(p.DownAfterSec) * time.Second }
func (p Policy) Cooldown() time.Duration  { return time.Duration(p.CooldownSec) * time.Second }

// DefaultPolicy: Autoscaling aus, vorsichtige Werte für den Fall des Einschaltens.
func DefaultPolicy(pool string) Policy {
	return Policy{
		Pool: pool, Mode: ModeOff,
		UpCPUPercent: 80, UpMemPercent: 85, UpAfterSec: 300,
		DownCPUPercent: 30, DownAfterSec: 600, CooldownSec: 600,
		MaxAutoHosts: 1,
	}
}

var ErrPolicyValidation = errors.New("cloud: invalid policy")

// Validate prüft die Regeln gegen den Pool.
func (p *Policy) Validate(pl Pool) error {
	switch {
	case p.Mode != ModeOff && p.Mode != ModeSuggest && p.Mode != ModeAuto:
		return fmt.Errorf("%w: mode must be off, suggest or auto", ErrPolicyValidation)
	case p.UpCPUPercent < 10 || p.UpCPUPercent > 100 || p.UpMemPercent < 10 || p.UpMemPercent > 100:
		return fmt.Errorf("%w: up thresholds must be 10–100 %%", ErrPolicyValidation)
	case p.DownCPUPercent < 1 || p.DownCPUPercent >= p.UpCPUPercent:
		return fmt.Errorf("%w: downCpuPercent must be ≥ 1 and below upCpuPercent (hysteresis)", ErrPolicyValidation)
	case p.UpAfterSec < 60 || p.DownAfterSec < 60 || p.CooldownSec < 60:
		return fmt.Errorf("%w: durations must be at least 60 seconds", ErrPolicyValidation)
	case p.MaxAutoHosts < 0 || p.MaxAutoHosts > MaxReservationHosts || (pl.Max > 0 && p.MaxAutoHosts > pl.Max):
		return fmt.Errorf("%w: maxAutoHosts must be 0–%d and not above the pool maximum", ErrPolicyValidation, MaxReservationHosts)
	case p.DailyBudget < 0 || p.MonthlyBudget < 0:
		return fmt.Errorf("%w: budgets must not be negative", ErrPolicyValidation)
	case p.DailyBudget > 0 && p.MonthlyBudget > 0 && p.DailyBudget > p.MonthlyBudget:
		return fmt.Errorf("%w: daily budget above monthly budget", ErrPolicyValidation)
	case p.Mode == ModeAuto && p.DailyBudget == 0 && p.MonthlyBudget == 0:
		return fmt.Errorf("%w: automatic mode requires a daily or monthly budget cap", ErrPolicyValidation)
	}
	return nil
}

// PolicyStore speichert die Regeln.
type PolicyStore interface {
	Get(pool string) (Policy, error) // fehlt der Eintrag: DefaultPolicy
	Put(p Policy, by string) error
}

// SQLPolicies speichert in Postgres (Tabelle cloud_policies).
type SQLPolicies struct{ db *sql.DB }

func NewSQLPolicies(db *sql.DB) *SQLPolicies { return &SQLPolicies{db: db} }

func (s *SQLPolicies) Get(pool string) (Policy, error) {
	var raw []byte
	err := s.db.QueryRow(`SELECT doc FROM cloud_policies WHERE pool = $1`, pool).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return DefaultPolicy(pool), nil
	}
	if err != nil {
		return Policy{}, err
	}
	p := DefaultPolicy(pool)
	if err := json.Unmarshal(raw, &p); err != nil {
		return Policy{}, err
	}
	p.Pool = pool
	return p, nil
}

func (s *SQLPolicies) Put(p Policy, by string) error {
	raw, err := json.Marshal(p)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT INTO cloud_policies (pool, doc, updated_by) VALUES ($1,$2,$3)
		ON CONFLICT (pool) DO UPDATE SET doc = EXCLUDED.doc, updated_by = EXCLUDED.updated_by, updated_at = now()`, p.Pool, raw, by)
	return err
}

// HostStore speichert die geführten Hosts (Kostenbuchführung über Neustarts hinweg).
type HostStore interface {
	Save(h Host) error
	LoadAll() ([]Host, error)
}

// SQLHosts speichert in Postgres (Tabelle cloud_hosts).
type SQLHosts struct{ db *sql.DB }

func NewSQLHosts(db *sql.DB) *SQLHosts { return &SQLHosts{db: db} }

func (s *SQLHosts) Save(h Host) error {
	raw, err := json.Marshal(h)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`INSERT INTO cloud_hosts (id, doc) VALUES ($1,$2)
		ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()`, h.ID, raw)
	return err
}

func (s *SQLHosts) LoadAll() ([]Host, error) {
	rows, err := s.db.Query(`SELECT doc FROM cloud_hosts ORDER BY updated_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Host
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var h Host
		if err := json.Unmarshal(raw, &h); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

var (
	_ PolicyStore = (*SQLPolicies)(nil)
	_ HostStore   = (*SQLHosts)(nil)
)
