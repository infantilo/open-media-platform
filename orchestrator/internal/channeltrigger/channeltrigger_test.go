package channeltrigger

import (
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/playout"
)

func TestNormalizeEventAndLate(t *testing.T) {
	for in, want := range map[string]string{"NEXT_LIVE": EventNextLive, "channel_cut": EventCut, " hold ": EventHold, "CHANNEL_JUMP": EventJump} {
		if got, err := NormalizeEvent(in); err != nil || got != want {
			t.Errorf("%q → %q %v", in, got, err)
		}
	}
	if _, err := NormalizeEvent("EXPLODE"); !errors.Is(err, ErrValidation) {
		t.Fatal("unbekanntes Event")
	}
	if p, err := NormalizeLate(""); err != nil || p != LateExecuteImmediately {
		t.Fatal(p, err)
	}
	if _, err := NormalizeLate("whenever"); !errors.Is(err, ErrValidation) {
		t.Fatal("unbekannte Policy")
	}
}

func TestTargetValidate(t *testing.T) {
	for _, ok := range []Target{{Channel: "a"}, {Group: "regional"}, {All: true}} {
		if err := ok.Validate(); err != nil {
			t.Errorf("%+v: %v", ok, err)
		}
	}
	for _, bad := range []Target{{}, {Channel: "a", Group: "b"}, {All: true, Group: "x"}} {
		if err := bad.Validate(); !errors.Is(err, ErrValidation) {
			t.Errorf("%+v sollte ungültig sein", bad)
		}
	}
}

var (
	national = playout.Channel{ID: "nat", Name: "National", Group: "national"}
	north    = playout.Channel{ID: "n", Name: "Nord", Group: "regional"}
	south    = playout.Channel{ID: "s", Name: "Süd", Group: "regional"}
	sport    = playout.Channel{ID: "sp", Name: "Sport", Group: "sport"}
)

func TestAllowedByRulesAndSelf(t *testing.T) {
	rules := []Rule{{Origin: "group:national", Target: "group:regional"}, {Origin: "channel:sp", Target: "channel:nat"}}
	if !Allowed(rules, national, national) {
		t.Fatal("ein Channel darf sich selbst steuern")
	}
	if !Allowed(rules, national, north) || !Allowed(rules, national, south) {
		t.Fatal("National → Regional per Gruppen-Regel")
	}
	if Allowed(rules, north, national) || Allowed(rules, north, south) {
		t.Fatal("Regional darf weder National noch Geschwister steuern (keine Regel)")
	}
	if !Allowed(rules, sport, national) || Allowed(rules, sport, north) {
		t.Fatal("Kanal-Regel gilt nur für das genannte Ziel")
	}
	if !Allowed([]Rule{{Origin: "*", Target: "*"}}, north, sport) {
		t.Fatal("Wildcard")
	}
	if Allowed(nil, national, north) {
		t.Fatal("ohne Regeln: nichts erlaubt (Standard = verweigern)")
	}
}

func TestTargetsResolution(t *testing.T) {
	all := []playout.Channel{national, north, south, sport}
	rules := []Rule{{Origin: "group:national", Target: "group:regional"}}
	ids := func(l []playout.Channel) string {
		s := ""
		for _, c := range l {
			s += c.ID + ","
		}
		return s
	}
	if got := ids(targets(Target{Group: "regional"}, national, all, rules)); got != "n,s," {
		t.Fatalf("Gruppe: %s", got)
	}
	if got := ids(targets(Target{Channel: "Nord"}, national, all, rules)); got != "n," {
		t.Fatalf("Kanal per Name: %s", got)
	}
	if got := ids(targets(Target{All: true}, national, all, rules)); got != "n,s," {
		t.Fatalf("all = nur die erlaubten, ohne Ursprung: %s", got)
	}
	if got := ids(targets(Target{Group: "national"}, national, all, rules)); got != "" {
		t.Fatalf("Gruppe ohne den Ursprung selbst: %s", got)
	}
}

type fakePub struct {
	mu   sync.Mutex
	msgs []Envelope
	subj []string
	fail bool
}

func (f *fakePub) Publish(subject string, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail {
		return errors.New("bus weg")
	}
	var e Envelope
	_ = json.Unmarshal(data, &e)
	f.msgs = append(f.msgs, e)
	f.subj = append(f.subj, subject)
	return nil
}

type fakeChannels []playout.Channel

func (f fakeChannels) ListChannels() ([]playout.Channel, error) { return f, nil }

func newRouter(t *testing.T) (*Router, *fakePub) {
	t.Helper()
	store := NewStore(dbtest.Open(t))
	// Reste früherer Läufe (die Test-DB lebt zwischen Läufen).
	_, _ = store.db.Exec(`DELETE FROM channel_triggers`)
	_, _ = store.db.Exec(`DELETE FROM channel_trigger_rules`)
	pub := &fakePub{}
	return &Router{Store: store, Channels: fakeChannels{national, north, south, sport}, Pub: pub}, pub
}

func TestSendGroupDeliversOnlyToAllowedAndRecordsDenials(t *testing.T) {
	r, pub := newRouter(t)
	if _, err := r.Store.AddRule("group:national", "channel:n", "admin"); err != nil {
		t.Fatal(err)
	}
	// National → Gruppe regional: Nord erlaubt, Süd verweigert.
	d, err := r.Send(national, Request{Event: "NEXT_LIVE", Target: Target{Group: "regional"}}, "admin")
	if err != nil || len(d) != 2 {
		t.Fatalf("%+v %v", d, err)
	}
	byTarget := map[string]Delivery{}
	for _, x := range d {
		byTarget[x.TargetChannel] = x
	}
	if byTarget["n"].Status != StatusPublished || byTarget["s"].Status != StatusDenied {
		t.Fatalf("Nord zugestellt, Süd verweigert: %+v", byTarget)
	}
	if len(pub.msgs) != 1 || pub.subj[0] != "omp.channel.n.trigger" || pub.msgs[0].Event != EventNextLive || pub.msgs[0].OriginChannel != "nat" {
		t.Fatalf("nur Nord erhält die Nachricht: %+v %v", pub.msgs, pub.subj)
	}
	if pub.msgs[0].CorrelationID == "" || pub.msgs[0].Seq != 1 || pub.msgs[0].ID == "" || pub.msgs[0].LatePolicy != LateExecuteImmediately {
		t.Fatalf("Envelope: %+v", pub.msgs[0])
	}
	// Das Protokoll enthält BEIDE Zeilen mit gemeinsamer Korrelations-ID (Spec §84/§165).
	list, _ := r.Store.List("", 10)
	if len(list) != 2 || list[0].CorrelationID != list[1].CorrelationID {
		t.Fatalf("Protokoll: %+v", list)
	}
	// Zweiter Trigger an dasselbe Ziel: Sequenznummer steigt.
	_, _ = r.Send(national, Request{Event: "NEXT", Target: Target{Channel: "n"}}, "admin")
	if got := pub.msgs[len(pub.msgs)-1].Seq; got != 2 {
		t.Fatalf("Seq = %d", got)
	}
}

func TestSendValidationAndSelfTrigger(t *testing.T) {
	r, pub := newRouter(t)
	for name, req := range map[string]Request{
		"Event":          {Event: "BOOM", Target: Target{Channel: "n"}},
		"Ziel":           {Event: "NEXT", Target: Target{}},
		"Policy":         {Event: "NEXT", Target: Target{Channel: "n"}, LatePolicy: "x"},
		"Jump ohne Item": {Event: "JUMP", Target: Target{Channel: "n"}},
		"args":           {Event: "TRIGGER", Target: Target{Channel: "n"}, Args: json.RawMessage(`{kaputt`)},
	} {
		if _, err := r.Send(national, req, "a"); !errors.Is(err, ErrValidation) {
			t.Errorf("%s: %v", name, err)
		}
	}
	far := time.Now().Add(MaxHorizon + time.Hour)
	if _, err := r.Send(national, Request{Event: "NEXT", Target: Target{Channel: "nat"}, TargetTime: &far}, "a"); !errors.Is(err, ErrValidation) {
		t.Errorf("zu ferne Zielzeit: %v", err)
	}
	if _, err := r.Send(national, Request{Event: "NEXT", Target: Target{Channel: "gibts-nicht"}}, "a"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unbekanntes Ziel: %v", err)
	}
	// Selbst-Trigger braucht keine Regel.
	if d, err := r.Send(national, Request{Event: "HOLD", Target: Target{Channel: "nat"}}, "a"); err != nil || len(d) != 1 || d[0].Status != StatusPublished {
		t.Fatalf("%+v %v", d, err)
	}
	if len(pub.msgs) != 1 {
		t.Fatalf("nur der Selbst-Trigger wurde zugestellt: %d", len(pub.msgs))
	}
}

func TestAckLifecycleIdempotenceAndOwnership(t *testing.T) {
	r, _ := newRouter(t)
	_, _ = r.Store.AddRule("*", "*", "admin")
	d, _ := r.Send(national, Request{Event: "CUT", Target: Target{Channel: "n"}}, "a")
	id := d[0].ID
	if _, err := r.Ack("s", id, StatusApplied, "", "x"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("falscher Channel darf nicht quittieren: %v", err)
	}
	if _, err := r.Ack("n", id, "komisch", "", "x"); !errors.Is(err, ErrValidation) {
		t.Fatalf("ungültiger Status: %v", err)
	}
	rec, err := r.Ack("n", id, StatusScheduled, "in 2 s", "x")
	if err != nil || rec.Status != StatusScheduled {
		t.Fatalf("%+v %v", rec, err)
	}
	rec, err = r.Ack("n", id, StatusApplied, "ok", "x")
	if err != nil || rec.Status != StatusApplied {
		t.Fatalf("scheduled → applied: %+v %v", rec, err)
	}
	// Doppelte Quittung ändert den Endzustand nicht.
	rec, err = r.Ack("n", id, StatusFailed, "spät", "x")
	if err != nil || rec.Status != StatusApplied {
		t.Fatalf("Endzustand bleibt: %+v %v", rec, err)
	}
}

func TestRedeliveryUntilAckThenExpiry(t *testing.T) {
	r, pub := newRouter(t)
	_, _ = r.Store.AddRule("*", "*", "admin")
	pub.fail = true // Bus zunächst weg: bleibt „published“
	d, err := r.Send(national, Request{Event: "NEXT", Target: Target{Channel: "n"}}, "a")
	if err != nil || d[0].Status != StatusPublished || d[0].Detail == "" {
		t.Fatalf("%+v %v", d, err)
	}
	// Letzter Versuch künstlich in die Vergangenheit schieben, dann Wiederholung bei wieder verfügbarem Bus.
	_, _ = r.Store.db.Exec(`UPDATE channel_triggers SET last_attempt = now() - interval '10 seconds' WHERE id = $1`, d[0].ID)
	pub.fail = false
	r.Housekeeping()
	if len(pub.msgs) != 1 || pub.msgs[0].ID != d[0].ID || pub.msgs[0].Attempt < 1 {
		t.Fatalf("Wiederholung: %+v", pub.msgs)
	}
	// Quittiert → keine weitere Wiederholung.
	_, _ = r.Ack("n", d[0].ID, StatusApplied, "", "x")
	_, _ = r.Store.db.Exec(`UPDATE channel_triggers SET last_attempt = now() - interval '10 seconds' WHERE id = $1`, d[0].ID)
	r.Housekeeping()
	if len(pub.msgs) != 1 {
		t.Fatalf("nach Quittung keine Wiederholung: %d", len(pub.msgs))
	}
	// Eine nie quittierte, alte Zustellung verfällt.
	d2, _ := r.Send(national, Request{Event: "NEXT", Target: Target{Channel: "s"}}, "a")
	_, _ = r.Store.db.Exec(`UPDATE channel_triggers SET created_at = now() - interval '5 minutes' WHERE id = $1`, d2[0].ID)
	r.Housekeeping()
	if rec, _ := r.Store.Get(d2[0].ID); rec.Status != StatusExpired {
		t.Fatalf("Status: %s", rec.Status)
	}
}

func TestRulesCrud(t *testing.T) {
	r, _ := newRouter(t)
	a, err := r.Store.AddRule("group:national", "group:regional", "admin")
	if err != nil {
		t.Fatal(err)
	}
	again, _ := r.Store.AddRule("group:national", "group:regional", "admin")
	if again.ID != a.ID {
		t.Fatal("idempotent")
	}
	if _, err := r.Store.AddRule("national", "x", "admin"); !errors.Is(err, ErrValidation) {
		t.Fatal("Selektor-Format")
	}
	if err := r.Store.DeleteRule(a.ID); err != nil {
		t.Fatal(err)
	}
	if err := r.Store.DeleteRule(a.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
}
