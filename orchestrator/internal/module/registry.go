package module

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sort"
	"strings"
	"sync"
)

// State eines Moduls in der Registry.
type State string

const (
	StateRegistered State = "registered"
	StateMounted    State = "mounted"
	StateDisabled   State = "disabled"
	StateFailed     State = "failed"
)

// Info ist die Sicht für `GET /api/v1/modules` und die Betriebsdiagnose.
type Info struct {
	Name  string  `json:"name"`
	State State   `json:"state"`
	Error string  `json:"error,omitempty"`
	UI    []UITab `json:"ui,omitempty"`
}

type entry struct {
	m     Module
	state State
	err   string
}

// Registry hält die Module in Registrierungsreihenfolge. Sie ist threadsicher.
type Registry struct {
	mu       sync.Mutex
	order    []string
	mods     map[string]*entry
	disabled map[string]bool
}

// NewRegistry legt eine Registry an; `disable` (Namen) schaltet Module ab — sie werden weder gemountet noch gestartet
// noch migriert, ihre Routen antworten mit 404 und ihr Tab fehlt.
func NewRegistry(disable ...string) *Registry {
	r := &Registry{mods: map[string]*entry{}, disabled: map[string]bool{}}
	for _, n := range disable {
		if n = strings.TrimSpace(n); n != "" {
			r.disabled[n] = true
		}
	}
	return r
}

// DisabledFromEnv liest `OMP_MODULES_DISABLE` (Komma-Liste).
func DisabledFromEnv() []string {
	return strings.Split(os.Getenv("OMP_MODULES_DISABLE"), ",")
}

var (
	ErrDuplicate = errors.New("module: duplicate name")
	ErrBadName   = errors.New("module: invalid name")
)

// Register nimmt ein Modul auf. Der Name muss nicht leer sein, nur aus [a-z0-9-] bestehen und eindeutig sein.
func (r *Registry) Register(m Module) error {
	name := m.Name()
	if name == "" || strings.Trim(name, "abcdefghijklmnopqrstuvwxyz0123456789-") != "" {
		return fmt.Errorf("%w: %q", ErrBadName, name)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, dup := r.mods[name]; dup {
		return fmt.Errorf("%w: %q", ErrDuplicate, name)
	}
	st := StateRegistered
	if r.disabled[name] {
		st = StateDisabled
	}
	r.mods[name] = &entry{m: m, state: st}
	r.order = append(r.order, name)
	return nil
}

// Mount ruft `Mount` aller aktiven Module. Ein Fehler (auch eine Panik) markiert nur dieses Modul als `failed` und wird
// geloggt — der Kern und die übrigen Module laufen weiter, nichts scheitert still.
func (r *Registry) Mount(routes Routes, d Deps) {
	r.mu.Lock()
	names := append([]string(nil), r.order...)
	r.mu.Unlock()
	for _, n := range names {
		e := r.entry(n)
		if e.state == StateDisabled {
			slog.Info("module disabled", "module", n)
			continue
		}
		if e.state == StateFailed { // z. B. Migration fehlgeschlagen: nicht auf halbem Schema mounten
			continue
		}
		if err := safely(func() error { return e.m.Mount(routes, d) }); err != nil {
			r.fail(n, err)
			continue
		}
		r.setState(n, StateMounted, "")
	}
}

func safely(f func() error) (err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("panic: %v", p)
		}
	}()
	return f()
}

func (r *Registry) entry(n string) entry {
	r.mu.Lock()
	defer r.mu.Unlock()
	return *r.mods[n]
}

func (r *Registry) setState(n string, s State, msg string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.mods[n].state, r.mods[n].err = s, msg
}

func (r *Registry) fail(n string, err error) {
	slog.Error("module failed", "module", n, "error", err)
	r.setState(n, StateFailed, err.Error())
}

// Start startet die Hintergrundjobs der gemounteten Module über `leader` (verwendet den Leader-Mechanismus des Kerns:
// `leader(ctx, fn)` ruft fn nur auf dem Raft-Leader und bricht es mit dem Verlust der Führung ab). Ein Fehler von
// `Start` wird geloggt und markiert das Modul als fehlgeschlagen.
func (r *Registry) Start(ctx context.Context, d Deps, leader func(ctx context.Context, fn func(context.Context))) {
	r.mu.Lock()
	names := append([]string(nil), r.order...)
	r.mu.Unlock()
	for _, n := range names {
		e := r.entry(n)
		s, ok := e.m.(Starter)
		if !ok || e.state != StateMounted {
			continue
		}
		n := n
		go leader(ctx, func(ctx context.Context) {
			if err := safely(func() error { return s.Start(ctx, d) }); err != nil && ctx.Err() == nil {
				r.fail(n, err)
			}
		})
	}
}

// Info liefert den Stand aller Module in Registrierungsreihenfolge; Oberfläche nur gemounteter Module.
func (r *Registry) Info() []Info {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Info, 0, len(r.order))
	for _, n := range r.order {
		e := r.mods[n]
		in := Info{Name: n, State: e.state, Error: e.err}
		if u, ok := e.m.(UIProvider); ok && e.state == StateMounted {
			in.UI = u.UI()
		}
		out = append(out, in)
	}
	return out
}

// Metrics schreibt die Metrikzeilen aller gemounteten Module in Registrierungsreihenfolge.
func (r *Registry) Metrics(w io.Writer) {
	for _, in := range r.Info() {
		if in.State != StateMounted {
			continue
		}
		if mp, ok := r.entry(in.Name).m.(MetricsProvider); ok {
			mp.WriteMetrics(w)
		}
	}
}

// migrationLockKey: eigener Advisory-Lock-Schlüssel (getrennt von den Kernmigrationen), serialisiert parallele Orchestratoren.
const migrationLockKey = 84271937

// Migrate wendet die ausstehenden Migrationen aller **aktiven** Module an. Je Modul müssen die Versionen lückenlos ab 1
// aufsteigen; jeder Schritt läuft in einer eigenen Transaktion, der Stand steht in `module_migrations`. Ein Fehler in
// einem Modul bricht dessen weitere Schritte ab und wird zurückgegeben (der Aufrufer entscheidet, ob der Start scheitert —
// ein Modul mit fehlgeschlagener Migration wird als `failed` markiert und nicht gemountet).
func (r *Registry) Migrate(ctx context.Context, db *sql.DB) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("module: acquire connection: %w", err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, `SELECT pg_advisory_lock($1)`, migrationLockKey); err != nil {
		return fmt.Errorf("module: migration lock: %w", err)
	}
	defer func() { _, _ = conn.ExecContext(ctx, `SELECT pg_advisory_unlock($1)`, migrationLockKey) }()
	if _, err := conn.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS module_migrations (
		module TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL DEFAULT '',
		applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (module, version))`); err != nil {
		return fmt.Errorf("module: create module_migrations: %w", err)
	}
	r.mu.Lock()
	names := append([]string(nil), r.order...)
	r.mu.Unlock()
	var errs []error
	for _, n := range names {
		e := r.entry(n)
		mg, ok := e.m.(Migrator)
		if !ok || e.state == StateDisabled {
			continue
		}
		if err := migrateModule(ctx, conn, n, mg.Migrations()); err != nil {
			r.fail(n, err)
			errs = append(errs, fmt.Errorf("module %s: %w", n, err))
		}
	}
	return errors.Join(errs...)
}

func migrateModule(ctx context.Context, conn *sql.Conn, name string, ms []Migration) error {
	sorted := append([]Migration(nil), ms...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Version < sorted[j].Version })
	for i, m := range sorted {
		if m.Version != i+1 {
			return fmt.Errorf("migration versions must be 1..n without gaps (got %d at position %d)", m.Version, i+1)
		}
	}
	for _, m := range sorted {
		var applied bool
		if err := conn.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM module_migrations WHERE module=$1 AND version=$2)`, name, m.Version).Scan(&applied); err != nil {
			return err
		}
		if applied {
			continue
		}
		tx, err := conn.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, m.SQL); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration %d %s: %w", m.Version, m.Name, err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO module_migrations (module, version, name) VALUES ($1,$2,$3)`, name, m.Version, m.Name); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}
