package cloud

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"
)

// Pool ist eine Konfiguration gemieteter Hosts (kein Code, §27.2).
type Pool struct {
	Name         string
	Region       string
	InstanceType string
	Min, Max     int
	// UserDataTemplate: Bootstrap-Konfiguration; {{token}} und {{host}} werden ersetzt.
	UserDataTemplate string
	// IdleAfter: so lange ohne Instanzen, bevor ein Host als leerlaufend gilt.
	IdleAfter time.Duration
	// MaxLifetime: danach Hinweis (0 = unbegrenzt).
	MaxLifetime time.Duration
	// BootTimeout: so lange darf Anbieter-Start + Agent-Anmeldung dauern (Standard 10 min).
	BootTimeout time.Duration
}

// HostState ist der Zustand eines gemieteten Hosts (§27.2).
type HostState string

const (
	HostBooting      HostState = "booting"       // beim Anbieter angefordert, läuft noch nicht
	HostWaitingAgent HostState = "waiting-agent" // Instanz läuft, Host-Agent hat sich noch nicht angemeldet
	HostReady        HostState = "ready"         // Agent registriert, nimmt Last
	HostDraining     HostState = "draining"      // kein neues Placement, wird geleert und beendet
	HostTerminated   HostState = "terminated"
	HostFailed       HostState = "failed"
)

// Host ist ein vom Manager geführter Cloud-Host.
type Host struct {
	ID           string      `json:"id"` // Tag omp-host
	Pool         string      `json:"pool"`
	Ref          InstanceRef `json:"ref"`
	InstanceType string      `json:"instanceType"`
	State        HostState   `json:"state"`
	RequestedAt  time.Time   `json:"requestedAt"`
	RunningAt    time.Time   `json:"runningAt,omitzero"`
	ReadyAt      time.Time   `json:"readyAt,omitzero"`
	// IdleSince: seit wann ohne Instanzen (nur Zustand ready).
	IdleSince    time.Time `json:"idleSince,omitzero"`
	EndedAt      time.Time `json:"endedAt,omitzero"`
	AgentHostID  string    `json:"agentHostId,omitempty"`
	Err          string    `json:"error,omitempty"`
	Adopted      bool      `json:"adopted,omitempty"`
	LifetimeOver bool      `json:"lifetimeExceeded,omitempty"`
}

// Env bindet den Manager an den Rest des Orchestrators (Bootstrap, Hosts, Placement).
type Env interface {
	// NewBootstrapToken liefert ein einmaliges, kurzlebiges Token für den neuen Host (§18.3).
	NewBootstrapToken(ttl time.Duration) (string, error)
	// AgentRegistered: hat sich der Agent des Cloud-Hosts (Tag omp-host) angemeldet? → OMP-Host-ID.
	AgentRegistered(cloudHostID string) (agentHostID string, ok bool)
	// InstanceCount: Anzahl laufender Instanzen/Rollen auf dem Host.
	InstanceCount(agentHostID string) (int, error)
	// SetDraining sperrt/entsperrt neues Placement auf dem Host.
	SetDraining(agentHostID string, on bool)
}

// Manager führt den Lebenszyklus gemieteter Hosts. Der Zustand liegt im Speicher; nach einem
// Neustart baut [Manager.Reconcile] ihn aus den Anbieter-Tags wieder auf (bezahlte Hosts
// gehen so nicht verloren).
type Manager struct {
	mu         sync.Mutex
	provider   Provider
	deployment string
	pools      map[string]Pool
	env        Env
	now        func() time.Time
	hosts      map[string]*Host
	seq        int
	store      HostStore
	saved      map[string]Host
}

// NewManager legt einen Manager an. `deployment` markiert alle Ressourcen dieses Orchestrators.
func NewManager(p Provider, deployment string, pools []Pool, env Env, now func() time.Time) *Manager {
	if now == nil {
		now = time.Now
	}
	m := &Manager{provider: p, deployment: deployment, pools: map[string]Pool{}, env: env, now: now, hosts: map[string]*Host{}, saved: map[string]Host{}}
	for _, pl := range pools {
		if pl.BootTimeout == 0 {
			pl.BootTimeout = 10 * time.Minute
		}
		m.pools[pl.Name] = pl
	}
	return m
}

func active(h *Host) bool { return h.State != HostTerminated && h.State != HostFailed }

// SetStore verdrahtet die Persistenz und lädt die bisher geführten Hosts (auch beendete: sie zählen weiter in die
// Kostenbuchführung). Vor dem ersten Tick aufrufen.
func (m *Manager) SetStore(s HostStore) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.store = s
	list, err := s.LoadAll()
	if err != nil {
		return err
	}
	for _, h := range list {
		h := h
		m.hosts[h.ID] = &h
		m.saved[h.ID] = h
	}
	return nil
}

// flush schreibt geänderte Hosts weg (Aufrufer hält m.mu). Fehler werden geloggt, nicht verschluckt.
func (m *Manager) flush() {
	if m.store == nil {
		return
	}
	for id, h := range m.hosts {
		if prev, ok := m.saved[id]; ok && prev == *h {
			continue
		}
		if err := m.store.Save(*h); err != nil {
			slog.Warn("cloud: saving host failed", "host", id, "error", err)
			continue
		}
		m.saved[id] = *h
	}
}

// Provision fordert einen neuen Host im Pool an (Max wird geprüft).
func (m *Manager) Provision(ctx context.Context, poolName string) (Host, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	pl, ok := m.pools[poolName]
	if !ok {
		return Host{}, fmt.Errorf("cloud: unknown pool %q", poolName)
	}
	n := 0
	for _, h := range m.hosts {
		if h.Pool == poolName && active(h) {
			n++
		}
	}
	if pl.Max > 0 && n >= pl.Max {
		return Host{}, fmt.Errorf("cloud: pool %q is at its maximum (%d hosts)", poolName, pl.Max)
	}
	m.seq++
	id := fmt.Sprintf("%s-%s-%d-%d", m.deployment, poolName, m.now().Unix(), m.seq)
	token, err := m.env.NewBootstrapToken(time.Hour)
	if err != nil {
		return Host{}, fmt.Errorf("cloud: bootstrap token: %w", err)
	}
	userData := strings.NewReplacer("{{token}}", token, "{{host}}", id).Replace(pl.UserDataTemplate)
	ref, err := m.provider.Launch(ctx, LaunchRequest{
		InstanceType: pl.InstanceType,
		Region:       pl.Region,
		UserData:     userData,
		Label:        id,
		Tags:         map[string]string{TagDeployment: m.deployment, TagPool: poolName, TagHost: id},
	})
	if err != nil {
		return Host{}, fmt.Errorf("cloud: launch: %w", err)
	}
	h := &Host{ID: id, Pool: poolName, Ref: ref, InstanceType: pl.InstanceType, State: HostBooting, RequestedAt: m.now()}
	m.hosts[id] = h
	m.flush()
	return *h, nil
}

// Release beendet einen Host geordnet: bereits startende Hosts sofort, laufende über Draining.
func (m *Manager) Release(ctx context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	defer m.flush()
	h, ok := m.hosts[id]
	if !ok {
		return fmt.Errorf("cloud: unknown host %q", id)
	}
	switch h.State {
	case HostBooting, HostWaitingAgent:
		return m.terminate(ctx, h)
	case HostReady:
		h.State = HostDraining
		if h.AgentHostID != "" {
			m.env.SetDraining(h.AgentHostID, true)
		}
	case HostDraining:
	default:
		return fmt.Errorf("cloud: host %q is already %s", id, h.State)
	}
	return nil
}

func (m *Manager) terminate(ctx context.Context, h *Host) error {
	if err := m.provider.Terminate(ctx, h.Ref); err != nil && err != ErrNotFound {
		h.Err = "terminate: " + err.Error()
		return err
	}
	h.State = HostTerminated
	h.EndedAt = m.now()
	h.Err = ""
	return nil
}

func (m *Manager) fail(ctx context.Context, h *Host, why string) {
	_ = m.provider.Terminate(ctx, h.Ref) // best effort, ein hängender Start soll nicht weiter kosten
	h.State = HostFailed
	h.EndedAt = m.now()
	h.Err = why
}

// Tick treibt alle Hosts einen Schritt weiter; regelmäßig aufrufen (z. B. alle 10 s).
func (m *Manager) Tick(ctx context.Context) {
	m.mu.Lock()
	defer m.mu.Unlock()
	defer m.flush()
	now := m.now()
	for _, h := range m.hosts {
		pl := m.pools[h.Pool]
		switch h.State {
		case HostBooting:
			st, err := m.provider.Describe(ctx, h.Ref)
			switch {
			case err != nil && err != ErrNotFound:
				// vorübergehender Anbieterfehler: nächster Tick; Zeitüberschreitung unten
			case err == ErrNotFound || st == StateTerminated || st == StateStopping:
				h.State, h.EndedAt, h.Err = HostFailed, now, "instance vanished while booting"
				continue
			case st == StateRunning:
				h.State, h.RunningAt = HostWaitingAgent, now
			}
			if (h.State == HostBooting) && now.Sub(h.RequestedAt) > pl.BootTimeout {
				m.fail(ctx, h, "boot timeout")
			}
		case HostWaitingAgent:
			if id, ok := m.env.AgentRegistered(h.ID); ok {
				h.State, h.ReadyAt, h.AgentHostID = HostReady, now, id
			} else if now.Sub(h.RequestedAt) > pl.BootTimeout {
				m.fail(ctx, h, "agent did not register in time")
			}
		case HostReady:
			n, err := m.env.InstanceCount(h.AgentHostID)
			switch {
			case err != nil:
			case n == 0 && h.IdleSince.IsZero():
				h.IdleSince = now
			case n > 0:
				h.IdleSince = time.Time{}
			}
			if pl.MaxLifetime > 0 && now.Sub(h.RequestedAt) > pl.MaxLifetime {
				h.LifetimeOver = true
			}
		case HostDraining:
			n, err := m.env.InstanceCount(h.AgentHostID)
			if err == nil && n == 0 {
				_ = m.terminate(ctx, h) // bei Fehler bleibt Draining, nächster Tick versucht es erneut
			}
		}
	}
}

// IdleHosts liefert Hosts, die mindestens `pool.IdleAfter` ohne Instanzen sind (Kandidaten für den Abbau).
func (m *Manager) IdleHosts() []Host {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	var out []Host
	for _, h := range m.hosts {
		if h.State == HostReady && !h.IdleSince.IsZero() && now.Sub(h.IdleSince) >= m.pools[h.Pool].IdleAfter {
			out = append(out, *h)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Hosts liefert eine Momentaufnahme aller geführten Hosts, nach Anforderungszeit sortiert.
func (m *Manager) Hosts() []Host {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Host, 0, len(m.hosts))
	for _, h := range m.hosts {
		out = append(out, *h)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].RequestedAt.Equal(out[j].RequestedAt) {
			return out[i].RequestedAt.Before(out[j].RequestedAt)
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// reconcileGrace: so lange gilt eine noch nicht gelistete Instanz nicht als verschwunden.
const reconcileGrace = 2 * time.Minute

// ReconcileReport fasst den Abgleich mit dem Anbieter zusammen.
type ReconcileReport struct {
	Adopted []string // beim Anbieter vorhanden, bisher unbekannt (z. B. nach Neustart)
	Lost    []string // intern aktiv, beim Anbieter nicht mehr vorhanden/beendet
}

// Reconcile gleicht die eigene Liste mit den getaggten Instanzen des Anbieters ab: Unbekannte
// werden übernommen (sie kosten sonst unbemerkt Geld), verschwundene als beendet/fehlgeschlagen markiert.
func (m *Manager) Reconcile(ctx context.Context) (ReconcileReport, error) {
	list, err := m.provider.List(ctx, map[string]string{TagDeployment: m.deployment})
	if err != nil {
		return ReconcileReport{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	defer m.flush()
	var rep ReconcileReport
	seen := map[string]bool{}
	for _, in := range list {
		id := in.Tags[TagHost]
		if id == "" {
			continue
		}
		seen[id] = true
		h, known := m.hosts[id]
		if !known {
			if in.State == StateTerminated || in.State == StateStopping {
				continue
			}
			m.hosts[id] = &Host{ID: id, Pool: in.Tags[TagPool], Ref: in.Ref, InstanceType: in.Type, State: HostWaitingAgent, RequestedAt: m.now(), Adopted: true}
			rep.Adopted = append(rep.Adopted, id)
			continue
		}
		if active(h) && (in.State == StateTerminated || in.State == StateStopping) {
			h.State, h.EndedAt, h.Err = HostFailed, m.now(), "terminated outside of OMP"
			rep.Lost = append(rep.Lost, id)
		}
	}
	for id, h := range m.hosts {
		// Frisch gestartete Instanzen erscheinen beim Anbieter evtl. verzögert in der Liste.
		if active(h) && !seen[id] && !h.Adopted && m.now().Sub(h.RequestedAt) > reconcileGrace {
			h.State, h.EndedAt, h.Err = HostFailed, m.now(), "not known to the provider"
			rep.Lost = append(rep.Lost, id)
		}
	}
	sort.Strings(rep.Adopted)
	sort.Strings(rep.Lost)
	return rep, nil
}
