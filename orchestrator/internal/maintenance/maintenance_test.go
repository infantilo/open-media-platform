package maintenance

import (
	"context"
	"testing"
	"time"
)

type fakeFlags struct{ on map[string]bool }

func (f *fakeFlags) SetMaintenance(id string, on bool) error { f.on[id] = on; return nil }
func (f *fakeFlags) MaintenanceHosts() ([]string, error)     { return nil, nil }

type fakeGate struct{ on map[string]bool }

func (g *fakeGate) SetMaintenance(id string, on bool) { g.on[id] = on }

type fakeEvac struct {
	roles   []Item
	release chan struct{}
	fail    bool
}

func (f *fakeEvac) EvacuateHost(ctx context.Context, id string, onStep func(Step)) {
	onStep(Step{Total: len(f.roles)})
	<-f.release
	if f.fail {
		onStep(Step{Total: len(f.roles), Failed: f.roles})
		return
	}
	f.roles = nil
	onStep(Step{Total: 1, Moved: 1})
}
func (f *fakeEvac) RolesOn(string) []Item { return f.roles }

type fakeInsts struct{ items []Item }

func (f fakeInsts) ListOnHost(string) []Item { return f.items }

func wait(t *testing.T, m *Manager, want string) Status {
	t.Helper()
	for i := 0; i < 200; i++ {
		if st, ok := m.Status("h"); ok && st.State == want {
			return st
		}
		time.Sleep(5 * time.Millisecond)
	}
	st, _ := m.Status("h")
	t.Fatalf("state = %q, want %q", st.State, want)
	return st
}

func TestEnterEvacuatesThenDrained(t *testing.T) {
	flags, gate := &fakeFlags{on: map[string]bool{}}, &fakeGate{on: map[string]bool{}}
	ev := &fakeEvac{roles: []Item{{Kind: "role", InstanceID: "i1"}}, release: make(chan struct{})}
	m := NewManager(flags, gate, ev, fakeInsts{}, nil)
	if err := m.Enter("h"); err != nil {
		t.Fatal(err)
	}
	if !flags.on["h"] || !gate.on["h"] {
		t.Fatal("flag and placement gate must be set immediately")
	}
	wait(t, m, "evacuating")
	close(ev.release)
	wait(t, m, "drained")
	if err := m.Leave("h"); err != nil {
		t.Fatal(err)
	}
	if _, ok := m.Status("h"); ok || flags.on["h"] || gate.on["h"] {
		t.Fatal("Leave must clear everything")
	}
}

func TestStandaloneInstanceBlocks(t *testing.T) {
	ev := &fakeEvac{release: make(chan struct{})}
	close(ev.release)
	m := NewManager(&fakeFlags{on: map[string]bool{}}, &fakeGate{on: map[string]bool{}}, ev, fakeInsts{items: []Item{{Kind: "instance", InstanceID: "solo"}}}, nil)
	_ = m.Enter("h")
	st := wait(t, m, "blocked")
	if len(st.Remaining) != 1 || st.Remaining[0].InstanceID != "solo" {
		t.Fatalf("remaining = %+v", st.Remaining)
	}
}
