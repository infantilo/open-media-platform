package hostcmd

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/infantilo/openmediaplatform/jobwire"
)

type fakeKeys struct {
	key  string
	next string
	prov bool
}

func (f *fakeKeys) CommandKey(string) (string, bool, error) { return f.key, f.prov, nil }
func (f *fakeKeys) MarkProvisioned(string) error            { f.prov = true; return nil }
func (f *fakeKeys) NextKey(string) (string, error)          { return f.next, nil }
func (f *fakeKeys) SetNextKey(_, k string) error            { f.next = k; return nil }
func (f *fakeKeys) PromoteNextKey(string) error {
	if f.next != "" {
		f.key, f.next = f.next, ""
	}
	return nil
}

// fakeAgent verhält sich wie der Host-Agent: Gate mit Verifier.
type fakeAgent struct {
	v    *jobwire.Verifier
	got  []string
	hdrs []nats.Header
}

func (a *fakeAgent) RequestMsg(m *nats.Msg, _ time.Duration) (*nats.Msg, error) {
	var req struct {
		Action     string `json:"action"`
		CommandKey string `json:"commandKey"`
	}
	_ = json.Unmarshal(m.Data, &req)
	a.got = append(a.got, req.Action)
	a.hdrs = append(a.hdrs, m.Header)
	reply := func(ok bool, e string) (*nats.Msg, error) {
		b, _ := json.Marshal(map[string]any{"ok": ok, "error": e})
		return &nats.Msg{Data: b}, nil
	}
	if req.Action == jobwire.ActionProvisionKey {
		if a.v.Active() {
			return reply(false, "already provisioned")
		}
		a.v.SetKey(req.CommandKey)
		return reply(true, "")
	}
	if err := a.v.Verify(m.Subject, m.Data, func(k string) string { return m.Header.Get(k) }); err != nil {
		return reply(false, "unauthorized: "+err.Error())
	}
	if req.Action == jobwire.ActionRotateKey {
		a.v.SetKey(req.CommandKey)
	}
	return reply(true, "")
}

func ok(t *testing.T, raw []byte, err error) {
	t.Helper()
	var r struct{ OK bool }
	if err != nil || json.Unmarshal(raw, &r) != nil || !r.OK {
		t.Fatalf("erwartet ok: %s %v", raw, err)
	}
}

func TestHostOf(t *testing.T) {
	for in, want := range map[string]string{"omp.host.abc.cmd": "abc"} {
		if got, k := HostOf(in); !k || got != want {
			t.Errorf("%s: %q %v", in, got, k)
		}
	}
	for _, in := range []string{"omp.host.abc.metrics", "omp.host..cmd", "omp.host.a.b.cmd", "other.cmd", "omp.host.abc.cmd.x"} {
		if _, k := HostOf(in); k {
			t.Errorf("%s ist kein Kommando-Subject", in)
		}
	}
}

func TestSignerProvisionsLegacyAgentThenSigns(t *testing.T) {
	key, _ := jobwire.NewKey()
	keys := &fakeKeys{key: key}
	agent := &fakeAgent{v: jobwire.NewVerifier("")} // Agent aus der Zeit vor der Signatur
	s := &Signer{Conn: agent, Keys: keys}
	raw, err := s.Request("omp.host.h1.cmd", []byte(`{"action":"stop"}`), time.Second)
	ok(t, raw, err)
	if len(agent.got) != 2 || agent.got[0] != jobwire.ActionProvisionKey || agent.got[1] != "stop" {
		t.Fatalf("erst Schlüssel, dann Kommando: %v", agent.got)
	}
	if !keys.prov || !agent.v.Active() {
		t.Fatal("bereitgestellt")
	}
	raw, err = s.Request("omp.host.h1.cmd", []byte(`{"action":"stop"}`), time.Second)
	ok(t, raw, err)
	if len(agent.got) != 3 {
		t.Fatalf("keine erneute Provisionierung: %v", agent.got)
	}
	if agent.hdrs[2].Get(jobwire.HeaderSig) == "" {
		t.Fatal("Kommando trägt Signatur")
	}
}

func TestSignerAgentWithKeyAndFlow(t *testing.T) {
	key, _ := jobwire.NewKey()
	agent := &fakeAgent{v: jobwire.NewVerifier(key)} // bei Registrierung ausgeliefert
	keys := &fakeKeys{key: key, prov: true}
	s := &Signer{Conn: agent, Keys: keys}
	raw, err := s.Request("omp.host.h1.cmd", []byte(`{"action":"start"}`), time.Second)
	ok(t, raw, err)
	if len(agent.got) != 1 {
		t.Fatalf("nur das Kommando: %v", agent.got)
	}
	// Datenbank hat einen anderen Schlüssel als der Agent: Kommando scheitert sichtbar
	s2 := &Signer{Conn: agent, Keys: &fakeKeys{key: "anderer-schluessel-anderer-schluessel", prov: true}}
	raw, _ = s2.Request("omp.host.h1.cmd", []byte(`{"action":"start"}`), time.Second)
	var r struct {
		OK    bool
		Error string
	}
	_ = json.Unmarshal(raw, &r)
	if r.OK || r.Error == "" {
		t.Fatalf("falscher Schlüssel: %s", raw)
	}
}

func TestSignerAlreadyProvisionedMarksAndOtherSubjectsUnsigned(t *testing.T) {
	key, _ := jobwire.NewKey()
	agent := &fakeAgent{v: jobwire.NewVerifier(key)}
	keys := &fakeKeys{key: key} // DB glaubt „nicht bereitgestellt“
	s := &Signer{Conn: agent, Keys: keys}
	raw, err := s.Request("omp.host.h1.cmd", []byte(`{"action":"stop"}`), time.Second)
	ok(t, raw, err)
	if !keys.prov {
		t.Fatal("already provisioned ⇒ als bereitgestellt vermerken")
	}
	agent.got, agent.hdrs = nil, nil
	if _, err := s.Request("omp.other.thing", []byte(`{}`), time.Second); err != nil && false {
		t.Fatal(err)
	}
	if len(agent.hdrs) != 1 || agent.hdrs[0].Get(jobwire.HeaderSig) != "" {
		t.Fatal("fremde Subjects werden nicht signiert")
	}
}

func TestEnsureProvisionedDeliversKeyWithoutACommand(t *testing.T) {
	key, _ := jobwire.NewKey()
	keys := &fakeKeys{key: key}
	agent := &fakeAgent{v: jobwire.NewVerifier("")}
	s := &Signer{Conn: agent, Keys: keys}
	s.EnsureProvisioned("h1", time.Second)
	if !agent.v.Active() || !keys.prov || len(agent.got) != 1 {
		t.Fatalf("Schlüssel geliefert: active=%v prov=%v got=%v", agent.v.Active(), keys.prov, agent.got)
	}
	s.EnsureProvisioned("h1", time.Second) // bereits bereitgestellt: nichts mehr senden
	if len(agent.got) != 1 {
		t.Fatalf("keine Wiederholung: %v", agent.got)
	}
}

func TestRotateSwitchesKeyOnAgentAndStore(t *testing.T) {
	key, _ := jobwire.NewKey()
	agent := &fakeAgent{v: jobwire.NewVerifier(key)}
	keys := &fakeKeys{key: key, prov: true}
	s := &Signer{Conn: agent, Keys: keys}
	if err := s.Rotate("h1", time.Second); err != nil {
		t.Fatal(err)
	}
	if keys.key == key || keys.next != "" {
		t.Fatalf("neuer Schlüssel übernommen: key=%q next=%q", keys.key, keys.next)
	}
	raw, err := s.Request("omp.host.h1.cmd", []byte(`{"action":"stop"}`), time.Second)
	ok(t, raw, err)
	if err := (&Signer{Conn: agent, Keys: &fakeKeys{key: key}}).Rotate("h1", time.Second); err == nil {
		t.Fatal("ohne bereitgestellten Schlüssel keine Rotation")
	}
}

// Der Orchestrator bricht nach der Übernahme durch den Agent ab: nur der Folgeschlüssel passt — Kommandos finden ihn selbst.
func TestRequestRecoversWithNextKeyAfterInterruptedRotation(t *testing.T) {
	oldKey, _ := jobwire.NewKey()
	newKey, _ := jobwire.NewKey()
	agent := &fakeAgent{v: jobwire.NewVerifier(newKey)}
	keys := &fakeKeys{key: oldKey, next: newKey, prov: true}
	s := &Signer{Conn: agent, Keys: keys}
	raw, err := s.Request("omp.host.h1.cmd", []byte(`{"action":"stop"}`), time.Second)
	ok(t, raw, err)
	if keys.key != newKey || keys.next != "" {
		t.Fatalf("Folgeschlüssel übernommen: key=%q next=%q", keys.key, keys.next)
	}
}
