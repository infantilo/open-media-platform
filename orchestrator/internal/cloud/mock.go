package cloud

import (
	"context"
	"fmt"
	"math"
	"sync"
	"time"
)

// MockProvider simuliert einen Anbieter vollständig im Speicher: Bootzeit, Preise,
// Abrechnung (sekundengenau, Mindestlaufzeit) und Fehler. Die Uhr ist austauschbar.
type MockProvider struct {
	mu        sync.Mutex
	Now       func() time.Time
	BootDelay time.Duration
	// MinBilled: Mindestabrechnung je Instanz (bei AWS Linux 60 s).
	MinBilled time.Duration
	Types     []InstanceType
	// BillingLag: so weit hinter der Gegenwart liegen abgerechnete Daten (AsOf).
	BillingLag time.Duration

	seq       int
	instances map[string]*mockInstance
	failNext  error
}

type mockInstance struct {
	id         string
	typ        string
	tags       map[string]string
	launchedAt time.Time
	endedAt    time.Time // zero = läuft
	userData   string
}

// NewMockProvider liefert einen Mock mit zwei Beispieltypen und Standardwerten.
func NewMockProvider() *MockProvider {
	return &MockProvider{
		Now:        time.Now,
		BootDelay:  90 * time.Second,
		MinBilled:  60 * time.Second,
		BillingLag: 6 * time.Hour,
		Types: []InstanceType{
			{Name: "m.medium", VCPU: 2, MemGB: 4, PricePerHour: 0.05, Currency: "EUR"},
			{Name: "g.large", VCPU: 8, MemGB: 32, GPU: 1, PricePerHour: 0.90, Currency: "EUR"},
		},
		instances: map[string]*mockInstance{},
	}
}

func (m *MockProvider) Name() string { return "mock" }

// FailNext lässt den nächsten Launch/Terminate mit err scheitern (Fehlerinjektion für Tests).
func (m *MockProvider) FailNext(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.failNext = err
}

func (m *MockProvider) takeFailure() error {
	err := m.failNext
	m.failNext = nil
	return err
}

func (m *MockProvider) Catalog(_ context.Context, _ string) ([]InstanceType, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]InstanceType(nil), m.Types...), nil
}

func (m *MockProvider) price(typ string) (InstanceType, bool) {
	for _, t := range m.Types {
		if t.Name == typ {
			return t, true
		}
	}
	return InstanceType{}, false
}

func (m *MockProvider) Launch(_ context.Context, req LaunchRequest) (InstanceRef, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.takeFailure(); err != nil {
		return InstanceRef{}, err
	}
	if _, ok := m.price(req.InstanceType); !ok {
		return InstanceRef{}, fmt.Errorf("cloud/mock: unknown instance type %q", req.InstanceType)
	}
	m.seq++
	id := fmt.Sprintf("mock-i-%04d", m.seq)
	tags := map[string]string{}
	for k, v := range req.Tags {
		tags[k] = v
	}
	m.instances[id] = &mockInstance{id: id, typ: req.InstanceType, tags: tags, launchedAt: m.Now(), userData: req.UserData}
	return InstanceRef{Provider: "mock", ID: id}, nil
}

func (m *MockProvider) state(i *mockInstance) State {
	switch {
	case !i.endedAt.IsZero():
		return StateTerminated
	case m.Now().Sub(i.launchedAt) < m.BootDelay:
		return StatePending
	default:
		return StateRunning
	}
}

// UserDataOf liefert die beim Start übergebenen User-Data (Test-Einblick).
func (m *MockProvider) UserDataOf(id string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	if i, ok := m.instances[id]; ok {
		return i.userData
	}
	return ""
}

func (m *MockProvider) Describe(_ context.Context, ref InstanceRef) (State, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	i, ok := m.instances[ref.ID]
	if !ok {
		return StateUnknown, ErrNotFound
	}
	return m.state(i), nil
}

func (m *MockProvider) Terminate(_ context.Context, ref InstanceRef) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.takeFailure(); err != nil {
		return err
	}
	i, ok := m.instances[ref.ID]
	if !ok {
		return ErrNotFound
	}
	if i.endedAt.IsZero() {
		i.endedAt = m.Now()
	}
	return nil
}

func matches(tags, filter map[string]string) bool {
	for k, v := range filter {
		if tags[k] != v {
			return false
		}
	}
	return true
}

func (m *MockProvider) List(_ context.Context, filter map[string]string) ([]InstanceInfo, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []InstanceInfo
	for _, i := range m.instances {
		if matches(i.tags, filter) {
			out = append(out, InstanceInfo{Ref: InstanceRef{Provider: "mock", ID: i.id}, State: m.state(i), Tags: i.tags, Type: i.typ})
		}
	}
	return out, nil
}

// ActualCost rechnet wie ein Anbieter ab: je Instanz Überlappung mit [from,to) in Sekunden,
// mindestens MinBilled je Instanz, Daten nur bis Now−BillingLag (AsOf).
func (m *MockProvider) ActualCost(_ context.Context, from, to time.Time, filter map[string]string) (CostReport, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	asOf := m.Now().Add(-m.BillingLag)
	end := to
	if asOf.Before(end) {
		end = asOf
	}
	total := 0.0
	cur := ""
	for _, i := range m.instances {
		if !matches(i.tags, filter) {
			continue
		}
		t, ok := m.price(i.typ)
		if !ok {
			continue
		}
		cur = t.Currency
		stop := i.endedAt
		if stop.IsZero() || stop.After(end) {
			stop = end
		}
		start := i.launchedAt
		if start.Before(from) {
			start = from
		}
		d := stop.Sub(start)
		if d < 0 {
			d = 0
		}
		// Mindestabrechnung nur für Instanzen, die im Zeitraum beendet wurden/liefen.
		if d > 0 && d < m.MinBilled && !i.endedAt.IsZero() {
			d = m.MinBilled
		}
		total += math.Round(t.PricePerHour*d.Seconds()/3600*1e6) / 1e6
	}
	return CostReport{From: from, To: to, Amount: total, Currency: cur, AsOf: asOf}, nil
}

var _ Provider = (*MockProvider)(nil)
