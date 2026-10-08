package cloud

import (
	"fmt"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/hosts"
)

// SimEnv ist die Simulation der Orchestrator-Anbindung für den Mock-Anbieter: Es gibt keinen echten
// Host-Agent, also "meldet sich" der Agent nach einer Verzögerung selbst an. Es wird NICHTS in die echte
// Host-Tabelle geschrieben und das Placement kennt die simulierten Hosts nicht — sonst könnten echte Workflows
// auf einen nicht existierenden Host gelegt werden.
type SimEnv struct {
	Now        func() time.Time
	AgentDelay time.Duration

	mu       sync.Mutex
	seen     map[string]time.Time
	tokens   int
	Draining map[string]bool
}

func NewSimEnv(now func() time.Time, agentDelay time.Duration) *SimEnv {
	return &SimEnv{Now: now, AgentDelay: agentDelay, seen: map[string]time.Time{}, Draining: map[string]bool{}}
}

func (e *SimEnv) NewBootstrapToken(time.Duration) (string, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.tokens++
	return fmt.Sprintf("sim-token-%d", e.tokens), nil
}

func (e *SimEnv) AgentRegistered(cloudHostID string) (string, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	first, ok := e.seen[cloudHostID]
	if !ok {
		e.seen[cloudHostID] = e.Now()
		first = e.Now()
	}
	if e.Now().Sub(first) >= e.AgentDelay {
		return "sim-agent-" + cloudHostID, true
	}
	return "", false
}

func (e *SimEnv) InstanceCount(string) (int, error) { return 0, nil }

func (e *SimEnv) SetDraining(agentHostID string, on bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.Draining[agentHostID] = on
}

// HostsEnv bindet den Manager an die echte Host-Verwaltung: Bootstrap-Token aus dem Host-Store, Agent-Anmeldung
// über das Label (die User-Data setzen es auf die Cloud-Host-ID), Instanzzahl aus dem Launcher, Draining im Placement.
type HostsEnv struct {
	Tokens interface {
		CreateBootstrapToken(createdBy string, ttl time.Duration) (string, time.Time, error)
	}
	Hosts     interface{ ListHosts() ([]hosts.Host, error) }
	Instances interface{ CountOnHost(hostID string) int }
	Placement interface{ SetDraining(hostID string, on bool) }
}

func (e HostsEnv) NewBootstrapToken(ttl time.Duration) (string, error) {
	tok, _, err := e.Tokens.CreateBootstrapToken("cloud-controller", ttl)
	return tok, err
}

func (e HostsEnv) AgentRegistered(cloudHostID string) (string, bool) {
	list, err := e.Hosts.ListHosts()
	if err != nil {
		return "", false
	}
	for _, h := range list {
		if h.Label == cloudHostID {
			return h.ID, true
		}
	}
	return "", false
}

func (e HostsEnv) InstanceCount(agentHostID string) (int, error) {
	return e.Instances.CountOnHost(agentHostID), nil
}

func (e HostsEnv) SetDraining(agentHostID string, on bool) { e.Placement.SetDraining(agentHostID, on) }

var (
	_ Env = (*SimEnv)(nil)
	_ Env = HostsEnv{}
)
