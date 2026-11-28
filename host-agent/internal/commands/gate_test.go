package commands

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/jobwire"
)

func hdrs(ts, n, sig string) func(string) string {
	return func(k string) string {
		switch k {
		case jobwire.HeaderTs:
			return ts
		case jobwire.HeaderNonce:
			return n
		case jobwire.HeaderSig:
			return sig
		}
		return ""
	}
}

func TestGateUnprovisionedAcceptsThenProvisionsOnceThenRequiresSignature(t *testing.T) {
	var saved string
	g := &Gate{Verifier: jobwire.NewVerifier(""), AllowNATSProvision: true, Persist: func(k string) error { saved = k; return nil }}
	none := hdrs("", "", "")
	if _, stop := g.Admit("omp.host.h.cmd", []byte(`{"action":"stop"}`), none, Request{Action: "stop"}); stop {
		t.Fatal("ohne Schlüssel gelten Kommandos (Übergang)")
	}
	key, _ := jobwire.NewKey()
	if r, stop := g.Admit("omp.host.h.cmd", nil, none, Request{Action: jobwire.ActionProvisionKey, CommandKey: key}); !stop || !r.OK || saved != key {
		t.Fatalf("Provisionierung: %+v saved=%q", r, saved)
	}
	if r, stop := g.Admit("omp.host.h.cmd", []byte(`{"action":"stop"}`), none, Request{Action: "stop"}); !stop || r.OK || !strings.Contains(r.Error, "unauthorized") {
		t.Fatalf("unsigniert nach Provisionierung: %+v", r)
	}
	evil, _ := jobwire.NewKey()
	if r, stop := g.Admit("omp.host.h.cmd", nil, none, Request{Action: jobwire.ActionProvisionKey, CommandKey: evil}); !stop || r.OK || saved != key {
		t.Fatalf("zweite Provisionierung darf den Schlüssel nicht ersetzen: %+v saved=%q", r, saved)
	}
	pl := []byte(`{"action":"stop"}`)
	ts, n, sig, _ := jobwire.Sign(key, "omp.host.h.cmd", pl, time.Now())
	if _, stop := g.Admit("omp.host.h.cmd", pl, hdrs(ts, n, sig), Request{Action: "stop"}); stop {
		t.Fatal("signiertes Kommando wird ausgeführt")
	}
	if r, stop := g.Admit("omp.host.h.cmd", pl, hdrs(ts, n, sig), Request{Action: "stop"}); !stop || r.OK {
		t.Fatal("Wiederholung abgelehnt")
	}
}

func TestGateRejectsShortKeyAndPersistFailure(t *testing.T) {
	g := &Gate{Verifier: jobwire.NewVerifier(""), AllowNATSProvision: true, Persist: func(string) error { return errors.New("disk full") }}
	if r, stop := g.Admit("s", nil, hdrs("", "", ""), Request{Action: jobwire.ActionProvisionKey, CommandKey: "kurz"}); !stop || r.OK {
		t.Fatal("zu kurzer Schlüssel")
	}
	key, _ := jobwire.NewKey()
	if r, stop := g.Admit("s", nil, hdrs("", "", ""), Request{Action: jobwire.ActionProvisionKey, CommandKey: key}); !stop || r.OK {
		t.Fatal("Persistenzfehler muss scheitern")
	}
	if g.Verifier.Active() {
		t.Fatal("bei Persistenzfehler darf der Schlüssel nicht aktiv werden (sonst nach Neustart ausgesperrt)")
	}
}

func TestGateRequireKeyRefusesCommandsBeforeProvisioning(t *testing.T) {
	g := &Gate{Verifier: jobwire.NewVerifier(""), RequireKey: true, AllowNATSProvision: true}
	if r, stop := g.Admit("s", []byte(`{}`), hdrs("", "", ""), Request{Action: "stop"}); !stop || r.OK {
		t.Fatal("ohne Schlüssel kein Kommando")
	}
	key, _ := jobwire.NewKey()
	if r, stop := g.Admit("s", nil, hdrs("", "", ""), Request{Action: jobwire.ActionProvisionKey, CommandKey: key}); !stop || !r.OK {
		t.Fatal("Provisionierung bleibt möglich")
	}
}

func TestGateRotateKeyNeedsValidSignatureAndSwitchesKey(t *testing.T) {
	key, _ := jobwire.NewKey()
	var saved string
	g := &Gate{Verifier: jobwire.NewVerifier(key), EncryptedTransport: true, Persist: func(k string) error { saved = k; return nil }}
	next, _ := jobwire.NewKey()
	pl := []byte(`{"action":"rotate-key"}`)
	if r, stop := g.Admit("s", pl, hdrs("", "", ""), Request{Action: jobwire.ActionRotateKey, CommandKey: next}); !stop || r.OK || saved != "" {
		t.Fatal("unsigniert darf nicht rotieren")
	}
	ts, n, sig, _ := jobwire.Sign(key, "s", pl, time.Now())
	if r, stop := g.Admit("s", pl, hdrs(ts, n, sig), Request{Action: jobwire.ActionRotateKey, CommandKey: next}); !stop || !r.OK || saved != next {
		t.Fatalf("Rotation: %+v saved=%q", r, saved)
	}
	pl2 := []byte(`{"action":"stop"}`)
	ts, n, sig, _ = jobwire.Sign(key, "s", pl2, time.Now())
	if r, stop := g.Admit("s", pl2, hdrs(ts, n, sig), Request{Action: "stop"}); !stop || r.OK {
		t.Fatal("der alte Schlüssel gilt nicht mehr")
	}
	ts, n, sig, _ = jobwire.Sign(next, "s", pl2, time.Now())
	if _, stop := g.Admit("s", pl2, hdrs(ts, n, sig), Request{Action: "stop"}); stop {
		t.Fatal("der neue Schlüssel gilt")
	}
}

// Standardstellung eines Hosts ohne Schlüssel: nichts ausführen und keinen Schlüssel von irgendwem annehmen.
func TestGateDefaultRefusesUnsignedAndForeignProvisioning(t *testing.T) {
	var saved string
	g := &Gate{Verifier: jobwire.NewVerifier(""), RequireKey: true, Persist: func(k string) error { saved = k; return nil }}
	key, _ := jobwire.NewKey()
	for _, action := range []string{"start", "stop", jobwire.ActionProvisionKey, jobwire.ActionRotateKey} {
		if r, stop := g.Admit("s", []byte(`{}`), hdrs("", "", ""), Request{Action: action, CommandKey: key}); !stop || r.OK {
			t.Fatalf("%s muss abgelehnt werden: %+v", action, r)
		}
	}
	if saved != "" || g.Verifier.Active() {
		t.Fatal("kein Schlüssel darf übernommen werden")
	}
}

func TestGateRotateWithoutKeyIsNoBackDoor(t *testing.T) {
	var saved string
	g := &Gate{Verifier: jobwire.NewVerifier(""), EncryptedTransport: true, Persist: func(k string) error { saved = k; return nil }}
	key, _ := jobwire.NewKey()
	if r, stop := g.Admit("s", nil, hdrs("", "", ""), Request{Action: jobwire.ActionRotateKey, CommandKey: key}); !stop || r.OK || saved != "" {
		t.Fatalf("rotate-key ohne bisherigen Schlüssel: %+v saved=%q", r, saved)
	}
}

func TestGateRefusesRotationOverPlaintext(t *testing.T) {
	key, _ := jobwire.NewKey()
	var saved string
	g := &Gate{Verifier: jobwire.NewVerifier(key), RequireKey: true, Persist: func(k string) error { saved = k; return nil }}
	next, _ := jobwire.NewKey()
	pl := []byte(`{"action":"rotate-key"}`)
	ts, n, sig, _ := jobwire.Sign(key, "s", pl, time.Now())
	if r, stop := g.Admit("s", pl, hdrs(ts, n, sig), Request{Action: jobwire.ActionRotateKey, CommandKey: next}); !stop || r.OK || saved != "" {
		t.Fatalf("Rotation ohne TLS: %+v saved=%q", r, saved)
	}
}
