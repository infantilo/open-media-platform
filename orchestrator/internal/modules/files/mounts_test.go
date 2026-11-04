package files

import (
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/infantilo/openmediaplatform/jobwire"
)

type scriptedHosts struct {
	mu    sync.Mutex
	calls []string
	fn    func(host string) ([]byte, error)
}

func (s *scriptedHosts) FileOp(host string, op jobwire.FileOp) ([]byte, error) {
	s.mu.Lock()
	s.calls = append(s.calls, host)
	s.mu.Unlock()
	return s.fn(host)
}

func newMountModule(h HostOps) (*Module, *[]string) {
	m := New()
	m.Hosts = h
	var got []string
	var mu sync.Mutex
	m.Alerter = func(kind, sev, subject, name, msg string) {
		mu.Lock()
		got = append(got, kind+":"+sev)
		mu.Unlock()
	}
	return m, &got
}

func TestSharedRootFailsOverAndRemembersHost(t *testing.T) {
	h := &scriptedHosts{fn: func(host string) ([]byte, error) {
		if host == "A" {
			return nil, errors.New("nats: timeout")
		}
		return []byte(`{"free":1,"total":2}`), nil
	}}
	m, alerts := newMountModule(h)
	root := Root{ID: "r1", Name: "Isilon", Path: "/mnt/isilon", HostID: "A", Shared: true, Hosts: []string{"A", "B"}}
	for i := 0; i < 3; i++ {
		if _, err := m.rootOp(root, jobwire.FileOp{Op: jobwire.FileOpDF}); err != nil {
			t.Fatal(err)
		}
	}
	// 1. Aufruf: A (Fehler) dann B; danach bevorzugt B — A wird nicht mehr zuerst befragt.
	if fmt.Sprint(h.calls) != "[A B B B]" {
		t.Fatalf("Aufrufe: %v", h.calls)
	}
	if mi := m.mountInfo("r1"); mi.State != MountOK || mi.ActiveHost != "B" {
		t.Fatalf("Zustand: %+v", mi)
	}
	if len(*alerts) != 0 {
		t.Fatalf("Alarm trotz Ausweichen: %v", *alerts)
	}
}

func TestInvalidRequestDoesNotFailOverOrAlarm(t *testing.T) {
	h := &scriptedHosts{fn: func(string) ([]byte, error) { return nil, fmt.Errorf("%w: „..“ im Pfad", jobwire.ErrFileOp) }}
	m, alerts := newMountModule(h)
	root := Root{ID: "r", Name: "X", Path: "/p", Shared: true, Hosts: []string{"A", "B"}}
	for i := 0; i < 3; i++ {
		if _, err := m.rootOp(root, jobwire.FileOp{Op: jobwire.FileOpList}); err == nil {
			t.Fatal("Fehler erwartet")
		}
	}
	if len(h.calls) != 3 || len(*alerts) != 0 {
		t.Fatalf("Aufrufe %v, Alarme %v", h.calls, *alerts)
	}
}

func TestHungMountAlertOnceThenRecovery(t *testing.T) {
	hung := true
	h := &scriptedHosts{fn: func(string) ([]byte, error) {
		if hung {
			return nil, fmt.Errorf("%w: /mnt/x antwortet nicht", jobwire.ErrMountHung)
		}
		return []byte(`{"free":1,"total":2}`), nil
	}}
	m, alerts := newMountModule(h)
	root := Root{ID: "r", Name: "NAS", Path: "/mnt/x", Shared: true, Hosts: []string{"A", "B"}}
	op := jobwire.FileOp{Op: jobwire.FileOpDF}
	_, _ = m.rootOp(root, op)
	if len(*alerts) != 0 {
		t.Fatalf("Entprellung: erster Fehlschlag darf nicht alarmieren: %v", *alerts)
	}
	for i := 0; i < 3; i++ {
		_, err := m.rootOp(root, op)
		if !jobwire.IsMountHung(err) {
			t.Fatalf("Fehlerart: %v", err)
		}
	}
	if len(*alerts) != 1 || (*alerts)[0] != "file-mount-hung:critical" {
		t.Fatalf("Alarm: %v", *alerts)
	}
	if mi := m.mountInfo("r"); mi.State != MountHung || mi.Since == "" {
		t.Fatalf("Zustand: %+v", mi)
	}
	hung = false
	if _, err := m.rootOp(root, op); err != nil {
		t.Fatal(err)
	}
	if len(*alerts) != 2 || (*alerts)[1] != "file-mount-recovered:info" {
		t.Fatalf("Erholung: %v", *alerts)
	}
	_, _ = m.rootOp(root, op)
	if len(*alerts) != 2 {
		t.Fatalf("Erholung doppelt gemeldet: %v", *alerts)
	}
}

func TestUnreachableHostAlertsAsWarning(t *testing.T) {
	h := &scriptedHosts{fn: func(string) ([]byte, error) { return nil, errors.New("nats: timeout") }}
	m, alerts := newMountModule(h)
	root := Root{ID: "r", Name: "Fern", Path: "/m", HostID: "H"}
	for i := 0; i < 3; i++ {
		_, _ = m.rootOp(root, jobwire.FileOp{Op: jobwire.FileOpDF})
	}
	if len(*alerts) != 1 || (*alerts)[0] != "file-root-unreachable:warning" {
		t.Fatalf("Alarm: %v", *alerts)
	}
}

func TestServedLocally(t *testing.T) {
	cases := []struct {
		r    Root
		want bool
	}{{Root{}, true}, {Root{HostID: "H"}, false}, {Root{Shared: true, Hosts: []string{"H", ""}}, true}, {Root{Shared: true, Hosts: []string{"H"}}, false}}
	for i, c := range cases {
		if servedLocally(c.r) != c.want {
			t.Errorf("Fall %d", i)
		}
	}
}
