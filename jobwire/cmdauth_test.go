package jobwire

import (
	"testing"
	"time"
)

func hdr(ts, nonce, sig string) func(string) string {
	return func(k string) string {
		switch k {
		case HeaderTs:
			return ts
		case HeaderNonce:
			return nonce
		case HeaderSig:
			return sig
		}
		return ""
	}
}

func TestSignVerifyRoundTripAndTamper(t *testing.T) {
	key, _ := NewKey()
	v := NewVerifier(key)
	pl := []byte(`{"action":"stop","instanceId":"i1"}`)
	ts, n, sig, err := Sign(key, "omp.host.h1.cmd", pl, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if err := v.Verify("omp.host.h1.cmd", pl, hdr(ts, n, sig)); err != nil {
		t.Fatalf("gültig: %v", err)
	}
	if err := v.Verify("omp.host.h1.cmd", pl, hdr(ts, n, sig)); err != ErrReplayed {
		t.Fatalf("Wiederholung muss scheitern: %v", err)
	}
	ts, n, sig, _ = Sign(key, "omp.host.h1.cmd", pl, time.Now())
	if err := v.Verify("omp.host.h1.cmd", []byte(`{"action":"start"}`), hdr(ts, n, sig)); err != ErrBadSig {
		t.Fatalf("geänderte Nutzlast: %v", err)
	}
	ts, n, sig, _ = Sign(key, "omp.host.h1.cmd", pl, time.Now())
	if err := v.Verify("omp.host.h2.cmd", pl, hdr(ts, n, sig)); err != ErrBadSig {
		t.Fatalf("anderes Subject (Umleiten auf anderen Host): %v", err)
	}
	other, _ := NewKey()
	ts, n, sig, _ = Sign(other, "omp.host.h1.cmd", pl, time.Now())
	if err := v.Verify("omp.host.h1.cmd", pl, hdr(ts, n, sig)); err != ErrBadSig {
		t.Fatalf("falscher Schlüssel: %v", err)
	}
}

func TestVerifyUnsignedStaleAndInactive(t *testing.T) {
	key, _ := NewKey()
	v := NewVerifier(key)
	if err := v.Verify("s", nil, hdr("", "", "")); err != ErrUnsigned {
		t.Fatalf("unsigniert: %v", err)
	}
	ts, n, sig, _ := Sign(key, "s", nil, time.Now().Add(-10*time.Minute))
	if err := v.Verify("s", nil, hdr(ts, n, sig)); err != ErrStale {
		t.Fatalf("alt: %v", err)
	}
	ts, n, sig, _ = Sign(key, "s", nil, time.Now().Add(10*time.Minute))
	if err := v.Verify("s", nil, hdr(ts, n, sig)); err != ErrStale {
		t.Fatalf("Zukunft: %v", err)
	}
	if err := v.Verify("s", nil, hdr("x", "n", "s")); err == nil {
		t.Fatal("kaputter Zeitstempel")
	}
	none := NewVerifier("")
	if none.Active() || none.Verify("s", nil, hdr("", "", "")) != nil {
		t.Fatal("ohne Schlüssel keine Prüfung (Übergang)")
	}
	none.SetKey(key)
	if !none.Active() || none.Verify("s", nil, hdr("", "", "")) != ErrUnsigned {
		t.Fatal("nach SetKey Pflicht")
	}
}

func TestNonceCacheForgetsOldEntries(t *testing.T) {
	key, _ := NewKey()
	v := NewVerifier(key)
	base := time.Now()
	v.nowFn = func() time.Time { return base }
	ts, n, sig, _ := Sign(key, "s", nil, base)
	if err := v.Verify("s", nil, hdr(ts, n, sig)); err != nil {
		t.Fatal(err)
	}
	v.nowFn = func() time.Time { return base.Add(10 * time.Minute) }
	ts2, n2, sig2, _ := Sign(key, "s", nil, base.Add(10*time.Minute))
	if err := v.Verify("s", nil, hdr(ts2, n2, sig2)); err != nil {
		t.Fatal(err)
	}
	if len(v.seen) != 1 {
		t.Fatalf("alte Einmalwerte werden verworfen: %d", len(v.seen))
	}
}

func hdrTerm(ts, nonce, sig, term string) func(string) string {
	base := hdr(ts, nonce, sig)
	return func(k string) string {
		if k == HeaderTerm {
			return term
		}
		return base(k)
	}
}

// Fencing (Audit H4/M10): ein früherer Leader (kleinere Amtszeit) wird abgewiesen, die Amtszeit ist signiert und wird gespeichert.
func TestFencingRejectsSupersededLeader(t *testing.T) {
	key, _ := NewKey()
	v := NewVerifier(key)
	var saved []uint64
	v.SetTerm(0, func(n uint64) { saved = append(saved, n) })
	pl := []byte(`{"action":"stop","instanceId":"i1"}`)
	send := func(term uint64) error {
		ts, n, sig, _ := SignTerm(key, "omp.host.h1.cmd", pl, time.Now(), term)
		return v.Verify("omp.host.h1.cmd", pl, hdrTerm(ts, n, sig, FormatTerm(term)))
	}
	if err := send(5); err != nil {
		t.Fatal(err)
	}
	if err := send(7); err != nil {
		t.Fatal(err)
	}
	if err := send(5); err != ErrStaleTerm {
		t.Fatalf("alter Leader muss scheitern: %v", err)
	}
	if err := send(7); err != nil {
		t.Fatalf("gleiche Amtszeit bleibt erlaubt: %v", err)
	}
	if v.MaxTerm() != 7 || len(saved) != 2 || saved[1] != 7 {
		t.Fatalf("max=%d gespeichert=%v", v.MaxTerm(), saved)
	}
	// Ohne Amtszeit nach Fencing: abgewiesen (sonst durch Weglassen zu umgehen).
	ts, n, sig, _ := Sign(key, "omp.host.h1.cmd", pl, time.Now())
	if err := v.Verify("omp.host.h1.cmd", pl, hdr(ts, n, sig)); err != ErrNoTerm {
		t.Fatalf("ohne Amtszeit: %v", err)
	}
}

func TestFencingTermIsCoveredBySignature(t *testing.T) {
	key, _ := NewKey()
	v := NewVerifier(key)
	pl := []byte(`{"action":"stop"}`)
	ts, n, sig, _ := SignTerm(key, "omp.host.h1.cmd", pl, time.Now(), 3)
	// Angreifer hebt die Amtszeit im Header an, um den Agent für den echten Leader zu sperren.
	if err := v.Verify("omp.host.h1.cmd", pl, hdrTerm(ts, n, sig, "999")); err != ErrBadSig {
		t.Fatalf("manipulierte Amtszeit: %v", err)
	}
	if v.MaxTerm() != 0 {
		t.Fatal("Amtszeit darf nicht übernommen werden")
	}
}

func TestWithoutTermsBehavesAsBefore(t *testing.T) {
	key, _ := NewKey()
	v := NewVerifier(key)
	pl := []byte(`x`)
	ts, n, sig, _ := Sign(key, "omp.host.h1.cmd", pl, time.Now())
	if err := v.Verify("omp.host.h1.cmd", pl, hdr(ts, n, sig)); err != nil {
		t.Fatal(err)
	}
}
