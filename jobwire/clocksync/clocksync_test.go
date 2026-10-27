package clocksync

import (
	"encoding/binary"
	"errors"
	"syscall"
	"testing"
	"time"
)

func TestStateFrom(t *testing.T) {
	if s := stateFrom(0, 0, 10, 5, 37); !s.Synced || s.TAIOffsetS != 37 {
		t.Fatalf("%+v", s)
	}
	if stateFrom(0, staUnsync, 0, 0, 37).Synced || stateFrom(timeError, 0, 0, 0, 37).Synced {
		t.Fatal("unsynced states must not be synced")
	}
}

func TestNTPTimestampRoundTrip(t *testing.T) {
	now := time.Unix(1_800_000_000, 123_456_789)
	got := fromNTP(toNTP(now))
	if d := got.Sub(now); d < -2*time.Nanosecond || d > 2*time.Nanosecond {
		t.Fatalf("drift %v", d)
	}
}

func reply(t1, t2, t3 time.Time, li, stratum, mode byte) []byte {
	b := make([]byte, 48)
	b[0], b[1] = li<<6|4<<3|mode, stratum
	binary.BigEndian.PutUint64(b[24:], toNTP(t1))
	binary.BigEndian.PutUint64(b[32:], toNTP(t2))
	binary.BigEndian.PutUint64(b[40:], toNTP(t3))
	return b
}

func TestParseSNTPOffsetAndRTT(t *testing.T) {
	t1 := time.Unix(1_800_000_000, 0)
	// Server geht 2 s vor, Hin- und Rückweg je 10 ms, Verarbeitung 1 ms.
	t2 := t1.Add(10*time.Millisecond + 2*time.Second)
	t3 := t2.Add(time.Millisecond)
	t4 := t1.Add(21 * time.Millisecond)
	off, rtt, err := parseSNTP(reply(t1, t2, t3, 0, 2, 4), t1, t4)
	if err != nil {
		t.Fatal(err)
	}
	if d := off - 2*time.Second; d < -time.Microsecond || d > time.Microsecond {
		t.Fatalf("offset %v", off)
	}
	if d := rtt - 20*time.Millisecond; d < -time.Microsecond || d > time.Microsecond {
		t.Fatalf("rtt %v", rtt)
	}
}

func TestParseSNTPRejects(t *testing.T) {
	t1 := time.Unix(1_800_000_000, 0)
	t4 := t1.Add(time.Millisecond)
	for name, b := range map[string][]byte{
		"kurz":           make([]byte, 10),
		"li3":            reply(t1, t1, t1, 3, 2, 4),
		"stratum0":       reply(t1, t1, t1, 0, 0, 4),
		"stratum16":      reply(t1, t1, t1, 0, 16, 4),
		"client-modus":   reply(t1, t1, t1, 0, 2, 3),
		"fremde-antwort": reply(t1.Add(time.Second), t1, t1, 0, 2, 4),
	} {
		if _, _, err := parseSNTP(b, t1, t4); err == nil {
			t.Errorf("%s: erwartet Fehler", name)
		}
	}
}

func fakeKernel(t *testing.T, tai int, status int64, errOnSet error) *[]syscall.Timex {
	t.Helper()
	var calls []syscall.Timex
	old := adjtimex
	t.Cleanup(func() { adjtimex = old })
	adjtimex = func(tx *syscall.Timex) (int, error) {
		if tx.Modes != 0 {
			if errOnSet != nil {
				return 0, errOnSet
			}
			calls = append(calls, *tx)
			if tx.Modes&admTAI != 0 {
				tai = int(tx.Constant)
			}
			if tx.Modes&admStatus != 0 {
				status = int64(tx.Status)
			}
			return 0, nil
		}
		tx.Tai, tx.Status = int32(tai), int32(status)
		return 0, nil
	}
	return &calls
}

func TestOnceSetsTAIOnly(t *testing.T) {
	calls := fakeKernel(t, 0, 0, nil) // synchron, TAI fehlt
	if err := Once(Config{TAIOffset: 37, Servers: []string{"x.invalid"}}); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 || (*calls)[0].Modes != admTAI || (*calls)[0].Constant != 37 || Fix() != "tai-set" {
		t.Fatalf("%+v fix=%s", *calls, Fix())
	}
}

func TestOnceLeavesSyncedClockAlone(t *testing.T) {
	calls := fakeKernel(t, 37, 0, nil)
	if err := Once(Config{TAIOffset: 37, Servers: []string{"x.invalid"}}); err != nil || len(*calls) != 0 {
		t.Fatalf("%v %+v", err, *calls)
	}
}

func TestOncePermissionDenied(t *testing.T) {
	fakeKernel(t, 0, 0, syscall.EPERM)
	err := Once(Config{TAIOffset: 37})
	if !errors.Is(err, syscall.EPERM) || Fix() != "no-permission" {
		t.Fatalf("%v fix=%s", err, Fix())
	}
}

func TestApplySlewVsStep(t *testing.T) {
	calls := fakeKernel(t, 37, staUnsync, nil)
	if err := apply(30*time.Millisecond, 10*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if Fix() != "slewed" || (*calls)[0].Modes != admOffset || (*calls)[0].Offset != 30000 {
		t.Fatalf("slew: %+v fix=%s", *calls, Fix())
	}
	last := (*calls)[len(*calls)-1]
	if last.Status&staUnsync != 0 || last.Maxerror == 0 {
		t.Fatalf("muss als synchron markieren: %+v", last)
	}
	*calls = nil
	if err := apply(-1500*time.Millisecond, 10*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	c := (*calls)[0]
	if Fix() != "stepped" || c.Modes != admSetOffset|admNano || c.Time.Sec != -2 || c.Time.Usec != 500_000_000 {
		t.Fatalf("step: %+v fix=%s", c, Fix())
	}
}

func TestConfigFromEnv(t *testing.T) {
	t.Setenv("OMP_CLOCK_NTP_SERVERS", " a.example , b.example ,")
	t.Setenv("OMP_CLOCK_TAI_OFFSET", "36")
	t.Setenv("OMP_CLOCK_DISCIPLINE", "off")
	c := ConfigFromEnv()
	if !c.Off || c.TAIOffset != 36 || len(c.Servers) != 2 || c.Servers[1] != "b.example" {
		t.Fatalf("%+v", c)
	}
	t.Setenv("OMP_CLOCK_NTP_SERVERS", "")
	if len(ConfigFromEnv().Servers) != 0 {
		t.Fatal("leere Liste schaltet NTP ab")
	}
}
