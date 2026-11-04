// Package files ist das Modul „Dateien“ (Kapitel 86, docs/ENTWURF-DATEIVERWALTUNG.md): Explorer über Wurzeln je Host
// (Host-Agent-Operationen aus jobwire), Dateizustand je Representation („Datei fehlt“-Filter und -Alarme), Löschen über einen
// Papierkorb mit Verwendungsprüfung und dynamischem Sperrfenster, Notfall-Leerung bei knappem Speicher.
package files

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/jobwire"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/asset"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

// HostOps führt Dateioperationen auf einem Host aus (hostID leer = Orchestrator-Rechner).
type HostOps interface {
	FileOp(hostID string, op jobwire.FileOp) ([]byte, error)
}

// DefaultRoot ist ein beim ersten Start angelegter Ort auf dem Orchestrator-Rechner.
type DefaultRoot struct {
	Name, Path, Role string
	ReadOnly         bool
}

// Module ist das Dateien-Modul.
type Module struct {
	// Assets: derselbe Store wie im Kern (Asset/Version/Representation anlegen).
	Assets *asset.Store
	// Hosts: Dateioperationen je Host.
	Hosts HostOps
	// Alerter: Alarm über alle Wege (Webhook, E-Mail). severity: critical | warning | info.
	Alerter func(kind, severity, subject, name, message string)
	// Events: optional — Ereignis in den Outbox/Ereignisbus.
	Events func(subject string, payload any)
	// ObjectHead: optional — Existenzprüfung für S3-Representations (storageBackendID, uri).
	ObjectHead func(ctx context.Context, backendID, uri string) (exists bool, size int64, err error)
	// DefaultRoots: Orte, die beim ersten Start angelegt werden (Medien, Import, Proxys, Untertitel …).
	DefaultRoots []DefaultRoot

	mu    sync.Mutex
	d     module.Deps
	cfg   Config
	cfgAt time.Time
	cfgOK bool

	mounts *mountTracker
}

// New legt das Modul an.
func New() *Module { return &Module{} }

// Name implementiert module.Module.
func (*Module) Name() string { return "files" }

func (m *Module) db() *sql.DB {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.d.DB
}

func (m *Module) deps() module.Deps {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.d
}

// Config liefert die Einstellungen (5 s zwischengespeichert).
func (m *Module) Config() Config {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cfgOK && time.Since(m.cfgAt) < 5*time.Second {
		return m.cfg
	}
	var raw []byte
	if m.d.Settings != nil {
		raw, _ = m.d.Settings.Get(settingsKey)
	}
	c, err := ParseConfig(raw)
	if err != nil {
		slog.Warn("files: Konfiguration ungültig, Standardwerte aktiv", "error", err)
		c = DefaultConfig()
	}
	m.cfg, m.cfgAt, m.cfgOK = c, time.Now(), true
	return c
}

func (m *Module) invalidate() {
	m.mu.Lock()
	m.cfgOK = false
	m.mu.Unlock()
}

// Migrations implementiert module.Migrator.
func (*Module) Migrations() []module.Migration {
	return []module.Migration{{Version: 1, Name: "file_roots_representation_health", SQL: schema}, {Version: 2, Name: "file_roots_shared", SQL: schemaV2}}
}

func (m *Module) audit(actor, objectType, id, action string, details map[string]any) {
	if a := m.deps().Audit; a != nil {
		a.Log(actor, objectType, id, action, details)
	}
}

func (m *Module) event(subject string, payload any) {
	if m.Events != nil {
		m.Events(subject, payload)
	}
}

func (m *Module) alert(kind, severity, subject, name, message string) {
	if m.Alerter != nil {
		m.Alerter(kind, severity, subject, name, message)
	}
}

// Start implementiert module.Starter (läuft nur auf dem Leader): Orte anlegen, Prüf- und Pflegeschleife.
func (m *Module) Start(ctx context.Context, d module.Deps) error {
	m.mu.Lock()
	m.d = d
	m.mu.Unlock()
	if d.DB == nil {
		return nil
	}
	m.seedRoots(ctx)
	go m.loop(ctx)
	return nil
}

func (m *Module) loop(ctx context.Context) {
	tick := time.NewTicker(30 * time.Second)
	defer tick.Stop()
	var lastSweep time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		func() {
			defer func() {
				if p := recover(); p != nil {
					slog.Error("files: Hintergrundlauf abgestürzt", "panic", p)
				}
			}()
			m.ProbeRoots(ctx)
			cfg := m.Config()
			if err := m.CheckDue(ctx, cfg); err != nil {
				slog.Warn("files: Dateiprüfung fehlgeschlagen", "error", err)
			}
			if time.Since(lastSweep) >= time.Duration(cfg.SweepEveryMin)*time.Minute {
				lastSweep = time.Now()
				m.Sweep(ctx, cfg)
			}
		}()
	}
}

// seedRoots legt die Standardorte einmalig an (Einstellung files.seeded), damit ein später entfernter Ort nicht wiederkehrt.
func (m *Module) seedRoots(ctx context.Context) {
	d := m.deps()
	if d.Settings != nil {
		if b, err := d.Settings.Get("files.seeded"); err == nil && len(b) > 0 {
			return
		}
	}
	for _, r := range m.DefaultRoots {
		id, err := ensureLocation(ctx, d.DB, r.Name, r.Path)
		if err != nil {
			slog.Warn("files: Ort nicht angelegt", "name", r.Name, "error", err)
			continue
		}
		if err := SaveRootSettings(ctx, d.DB, Root{ID: id, Role: r.Role, ReadOnly: r.ReadOnly}); err != nil {
			slog.Warn("files: Ort nicht eingerichtet", "name", r.Name, "error", err)
		}
	}
	if d.Settings != nil {
		raw, _ := json.Marshal(map[string]any{"at": time.Now().UTC()})
		_ = d.Settings.Put("files.seeded", raw)
	}
}

// ensureLocation liefert die ID des Orts (host_id leer) mit diesem Pfad; legt ihn bei Bedarf an (eindeutiger Name).
func ensureLocation(ctx context.Context, db *sql.DB, name, path string) (string, error) {
	var id string
	err := db.QueryRowContext(ctx, `SELECT id FROM storage_locations WHERE host_id = '' AND path = $1`, path).Scan(&id)
	if err == nil {
		return id, nil
	}
	if err != sql.ErrNoRows {
		return "", err
	}
	id = newID()
	n := name
	for i := 2; i < 20; i++ {
		var c int
		_ = db.QueryRowContext(ctx, `SELECT count(*) FROM storage_locations WHERE name = $1`, n).Scan(&c)
		if c == 0 {
			break
		}
		n = name + " " + string(rune('0'+i%10))
	}
	_, err = db.ExecContext(ctx, `INSERT INTO storage_locations (id, name, host_id, path, note, created_by) VALUES ($1,$2,'',$3,'Dateien (Kapitel 86)','system')`, id, n, path)
	return id, err
}
