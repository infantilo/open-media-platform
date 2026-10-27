package cluster

import (
	"context"
	"os"
	"testing"
	"time"
)

func stop(t *testing.T, nodes ...*Node) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, n := range nodes {
		_ = n.Shutdown(ctx)
	}
}

// B5: zwei Orchestratoren plus Zeuge haben bei Ausfall eines Orchestrators weiter eine Mehrheit — und der Zeuge behält nie die Führung.
func TestWitnessGivesTwoOrchestratorsAQuorumAndDoesNotKeepLeadership(t *testing.T) {
	founders := []PeerSpec{{ID: "a", RaftAddr: freeTCPAddr(t)}, {ID: "b", RaftAddr: freeTCPAddr(t)}, {ID: "w", RaftAddr: freeTCPAddr(t)}}
	mk := func(i int, witness bool) *Node {
		n, err := New(Config{NodeID: founders[i].ID, RaftAddr: founders[i].RaftAddr, DataDir: t.TempDir(), FoundingPeers: founders, Witness: witness})
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	a, b, w := mk(0, false), mk(1, false), mk(2, true)
	defer stop(t, a, b, w)

	leader := waitForLeader(t, []*Node{a, b}, 20*time.Second)
	if !waitFor(10*time.Second, func() bool { return !w.IsLeader() }) {
		t.Fatal("der Zeuge muss die Führung abgeben")
	}
	if !w.Status().Witness {
		t.Fatal("Status muss den Zeugen kennzeichnen")
	}

	// Der Leader fällt aus: der andere Orchestrator gewinnt mit der Stimme des Zeugen.
	survivor := a
	if leader == a {
		survivor = b
	}
	stop(t, leader)
	if !waitFor(25*time.Second, func() bool { return survivor.IsLeader() }) {
		t.Fatalf("der verbliebene Orchestrator wurde nicht Leader (Zustand %s)", survivor.raft.State())
	}
	if survivor.QuorumLost() {
		t.Fatal("mit Zeuge ist die Mehrheit nicht verloren")
	}
}

// B5 Notausgang: ohne Zeugen steht ein Zwei-Knoten-Cluster nach Ausfall des Partners; die Marke baut den verbliebenen Knoten beim nächsten Start zum Einzelknoten um.
func TestEmergencySoloRecoversALeaderlessTwoNodeCluster(t *testing.T) {
	old := QuorumLostAfter
	QuorumLostAfter = 2 * time.Second
	defer func() { QuorumLostAfter = old }()

	founders := []PeerSpec{{ID: "a", RaftAddr: freeTCPAddr(t)}, {ID: "b", RaftAddr: freeTCPAddr(t)}}
	dirA, dirB := t.TempDir(), t.TempDir()
	cfgA := Config{NodeID: "a", RaftAddr: founders[0].RaftAddr, DataDir: dirA, FoundingPeers: founders}
	a, err := New(cfgA)
	if err != nil {
		t.Fatal(err)
	}
	b, err := New(Config{NodeID: "b", RaftAddr: founders[1].RaftAddr, DataDir: dirB, FoundingPeers: founders})
	if err != nil {
		t.Fatal(err)
	}
	defer stop(t, b)
	leader := waitForLeader(t, []*Node{a, b}, 20*time.Second)

	// Solange ein Leader da ist, verweigert der Notausgang.
	if err := a.RequestSolo("admin"); err == nil {
		t.Fatal("mit Leader darf der Notausgang nicht gehen")
	}

	// Der Partner fällt aus (hier: der andere Knoten als Leader oder Follower — wir stoppen b; ist b der Leader, hat a danach keinen mehr).
	if leader == a {
		// a ist Leader: dann stoppen wir a und lassen b übrig.
		stop(t, a)
		a, b = b, a
	}
	stop(t, b)
	if !waitFor(20*time.Second, func() bool { return a.QuorumLost() }) {
		t.Fatalf("Mehrheitsverlust nicht erkannt (noLeader %v)", a.NoLeaderFor())
	}
	if !a.Status().QuorumLost || a.Status().NoLeaderSeconds < 2 {
		t.Fatalf("Status: %+v", a.Status())
	}
	if err := a.RequestSolo("admin"); err != nil {
		t.Fatal(err)
	}
	if !a.SoloPending() {
		t.Fatal("Marke fehlt")
	}
	// Rücknahme möglich.
	if err := a.CancelSolo(); err != nil || a.SoloPending() {
		t.Fatalf("Rücknahme: %v", err)
	}
	if err := a.RequestSolo("admin"); err != nil {
		t.Fatal(err)
	}

	// Neustart derselben Instanz mit demselben Datenverzeichnis.
	stop(t, a)
	cfg := Config{NodeID: a.config.NodeID, RaftAddr: a.config.RaftAddr, DataDir: a.config.DataDir}
	a2, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer stop(t, a2)
	if !waitFor(20*time.Second, func() bool { return a2.IsLeader() }) {
		t.Fatalf("Einzelknoten wurde nicht Leader (Zustand %s)", a2.raft.State())
	}
	if n := len(a2.Status().Peers); n != 1 {
		t.Fatalf("nach dem Notausgang genau ein Mitglied, hat %d", n)
	}
	if a2.SoloPending() {
		t.Fatal("die Marke muss verbraucht sein")
	}
	if err := a2.RequestSolo("admin"); err != ErrNoOtherMembers {
		t.Fatalf("allein gibt es nichts umzubauen: %v", err)
	}
}

func TestForeignOrBrokenMarkerIsDiscardedNotExecuted(t *testing.T) {
	dir := t.TempDir()
	_ = writeFile(markerPath(dir), `{"nodeId":"anderer","by":"x"}`)
	if _, ok, err := consumeRecoverMarker(dir, "ich"); err != nil || ok {
		t.Fatalf("fremde Marke: ok=%v err=%v", ok, err)
	}
	_ = writeFile(markerPath(dir), `kaputt`)
	if _, ok, _ := consumeRecoverMarker(dir, "ich"); ok {
		t.Fatal("beschädigte Marke darf nicht wirken")
	}
	if _, ok, _ := consumeRecoverMarker(dir, "ich"); ok {
		t.Fatal("Marke wurde nicht entfernt")
	}
}

func writeFile(path, content string) error { return os.WriteFile(path, []byte(content), 0o600) }
