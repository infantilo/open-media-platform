package cluster

import (
	"context"
	"fmt"
	"net"
	"reflect"
	"testing"
	"time"

	"github.com/hashicorp/raft"
)

// reserveFreeAddr fragt das OS per ":0"-Bind nach einem freien lokalen
// Port (gleiche Technik wie launcher/podman.go, UMSETZUNG.md §17 Teil 4)
// und gibt ihn sofort wieder frei, damit New() ihn selbst binden kann.
func reserveFreeAddr() (string, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	addr := ln.Addr().String()
	if err := ln.Close(); err != nil {
		return "", err
	}
	return addr, nil
}

func TestParsePeersEmpty(t *testing.T) {
	got, err := ParsePeers("")
	if err != nil {
		t.Fatalf("ParsePeers() error = %v, want nil", err)
	}
	if got != nil {
		t.Errorf("ParsePeers(\"\") = %v, want nil", got)
	}
}

func TestParsePeersParsesIDAddrPairs(t *testing.T) {
	got, err := ParsePeers("a=127.0.0.1:8301, b=127.0.0.1:8302 ,c=127.0.0.1:8303")
	if err != nil {
		t.Fatalf("ParsePeers() error = %v", err)
	}
	want := []PeerSpec{
		{ID: "a", RaftAddr: "127.0.0.1:8301"},
		{ID: "b", RaftAddr: "127.0.0.1:8302"},
		{ID: "c", RaftAddr: "127.0.0.1:8303"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("ParsePeers() = %+v, want %+v", got, want)
	}
}

func TestParsePeersRejectsMalformedEntry(t *testing.T) {
	if _, err := ParsePeers("a-without-equals-sign"); err == nil {
		t.Fatal("ParsePeers() error = nil, want error for entry without '='")
	}
	if _, err := ParsePeers("a="); err == nil {
		t.Fatal("ParsePeers() error = nil, want error for empty address")
	}
}

// freeTCPAddr reserviert einen freien lokalen Port über das ":0"-Listen-
// Muster (gleiche Technik wie launcher/podman.go, s. UMSETZUNG.md §17
// Teil 4) und gibt ihn sofort wieder frei — ausreichend robust für Tests,
// die den Port kurz danach selbst binden (kein echter Wettlauf mit
// anderen Prozessen auf einer CI-Maschine, die nur diesen einen Test
// gleichzeitig ausführt).
func freeTCPAddr(t *testing.T) string {
	t.Helper()
	addr, err := reserveFreeAddr()
	if err != nil {
		t.Fatalf("reserve free tcp addr: %v", err)
	}
	return addr
}

func TestSingleNodeBootstrapsAndBecomesLeader(t *testing.T) {
	cfg := Config{
		NodeID:   "solo",
		RaftAddr: freeTCPAddr(t),
		DataDir:  t.TempDir(),
	}
	node, err := New(cfg)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = node.Shutdown(ctx)
	}()

	if !waitFor(10*time.Second, node.IsLeader) {
		t.Fatalf("single-node cluster never became leader, status=%+v", node.Status())
	}

	status := node.Status()
	if !status.IsLeader {
		t.Errorf("Status().IsLeader = false, want true")
	}
	if status.LeaderID != "solo" {
		t.Errorf("Status().LeaderID = %q, want %q", status.LeaderID, "solo")
	}
	if len(status.Peers) != 1 {
		t.Errorf("Status().Peers = %+v, want exactly 1 (self)", status.Peers)
	}
}

func TestApplyReplicatesAcrossFoundingThreeNodeCluster(t *testing.T) {
	nodes := startFoundingCluster(t, 3)
	defer shutdownAll(nodes)

	leader := waitForLeader(t, nodes, 15*time.Second)

	// Ein Apply auf dem Leader muss auf JEDER Instanz denselben
	// FSM-Versionszähler erzeugen — das ist der eigentliche Nachweis,
	// dass der Log tatsächlich über echtes TCP repliziert und in
	// derselben Reihenfolge angewendet wird (nicht nur, dass ein Leader
	// gewählt wurde).
	future := leader.raft.Apply([]byte("noop"), 5*time.Second)
	if err := future.Error(); err != nil {
		t.Fatalf("Apply() error = %v", err)
	}

	for _, n := range nodes {
		if !waitFor(10*time.Second, func() bool { return n.FSM().Version() == 1 }) {
			t.Errorf("node %s FSM version = %d, want 1 (replication did not converge)", n.config.NodeID, n.FSM().Version())
		}
	}
}

func TestLeaderReelectionAfterLeaderShutdown(t *testing.T) {
	nodes := startFoundingCluster(t, 3)
	defer shutdownAll(nodes)

	leader := waitForLeader(t, nodes, 15*time.Second)
	leaderID := leader.config.NodeID

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	if err := leader.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown() error = %v", err)
	}
	cancel()

	var remaining []*Node
	for _, n := range nodes {
		if n.config.NodeID != leaderID {
			remaining = append(remaining, n)
		}
	}

	newLeader := waitForLeader(t, remaining, 20*time.Second)
	if newLeader.config.NodeID == leaderID {
		t.Fatalf("new leader is the shut-down former leader %s — reelection did not happen", leaderID)
	}
}

// startFoundingCluster startet n Instanzen mit identischer
// FoundingPeers-Liste (statisches Gründungs-Bootstrap, ARCHITECTURE.md
// §19.3 Punkt 3/D12 Teil 1 — die Laufzeit-Join-API kommt erst mit
// Teil 2), jede auf einem eigenen freien Loopback-Port und eigenem
// TempDir — echtes TCP zwischen echten *raft.Raft-Instanzen im selben
// Testprozess, kein simulierter/gemockter Transport.
func startFoundingCluster(t *testing.T, n int) []*Node {
	t.Helper()
	founders := make([]PeerSpec, n)
	for i := 0; i < n; i++ {
		founders[i] = PeerSpec{ID: fmt.Sprintf("node-%d", i), RaftAddr: freeTCPAddr(t)}
	}

	nodes := make([]*Node, n)
	for i, f := range founders {
		node, err := New(Config{
			NodeID:        f.ID,
			RaftAddr:      f.RaftAddr,
			DataDir:       t.TempDir(),
			FoundingPeers: founders,
		})
		if err != nil {
			// bereits gestartete Instanzen sauber stoppen, bevor der Test abbricht
			shutdownAll(nodes[:i])
			t.Fatalf("New() for %s error = %v", f.ID, err)
		}
		nodes[i] = node
	}
	return nodes
}

func shutdownAll(nodes []*Node) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, n := range nodes {
		if n != nil {
			_ = n.Shutdown(ctx)
		}
	}
}

func waitForLeader(t *testing.T, nodes []*Node, timeout time.Duration) *Node {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		for _, n := range nodes {
			if n.IsLeader() {
				return n
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	states := make([]string, len(nodes))
	for i, n := range nodes {
		states[i] = fmt.Sprintf("%s=%s", n.config.NodeID, n.raft.State())
	}
	t.Fatalf("no leader elected within %s, states=%v", timeout, states)
	return nil
}

func TestLeaderSelfAnnouncesHTTPAddr(t *testing.T) {
	cfg := Config{
		NodeID:   "solo",
		RaftAddr: freeTCPAddr(t),
		HTTPAddr: "http://127.0.0.1:9999",
		DataDir:  t.TempDir(),
	}
	node, err := New(cfg)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	defer shutdownAll([]*Node{node})

	if !waitFor(10*time.Second, node.IsLeader) {
		t.Fatalf("never became leader")
	}
	if !waitFor(5*time.Second, func() bool {
		addr, ok := node.LeaderHTTPAddr()
		return ok && addr == cfg.HTTPAddr
	}) {
		addr, ok := node.LeaderHTTPAddr()
		t.Fatalf("LeaderHTTPAddr() = (%q, %v), want (%q, true) — leadership self-announce did not happen", addr, ok, cfg.HTTPAddr)
	}
}

func TestJoinAddsVoterAndAnnouncesHTTPAddr(t *testing.T) {
	leaderAddr := freeTCPAddr(t)
	leader, err := New(Config{
		NodeID:   "leader",
		RaftAddr: leaderAddr,
		HTTPAddr: "http://127.0.0.1:9101",
		DataDir:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("New(leader) error = %v", err)
	}
	defer shutdownAll([]*Node{leader})
	if !waitFor(10*time.Second, leader.IsLeader) {
		t.Fatalf("solo leader never elected")
	}

	joinerAddr := freeTCPAddr(t)
	joiner, err := New(Config{
		NodeID:        "joiner",
		RaftAddr:      joinerAddr,
		HTTPAddr:      "http://127.0.0.1:9102",
		DataDir:       t.TempDir(),
		SkipBootstrap: true, // wartet passiv auf Join(), bootstrapt sich nicht selbst
	})
	if err != nil {
		t.Fatalf("New(joiner) error = %v", err)
	}
	defer shutdownAll([]*Node{joiner})

	if err := leader.Join("joiner", joinerAddr, "http://127.0.0.1:9102"); err != nil {
		t.Fatalf("Join() error = %v", err)
	}

	if !waitFor(10*time.Second, func() bool { return len(leader.Status().Peers) == 2 }) {
		t.Fatalf("leader never saw 2 peers, status=%+v", leader.Status())
	}
	if !waitFor(10*time.Second, func() bool {
		_, id := joiner.raft.LeaderWithID()
		return id == "leader"
	}) {
		t.Fatalf("joiner never recognized the leader, status=%+v", joiner.Status())
	}

	addr, ok := leader.FSM().PeerHTTPAddr("joiner")
	if !ok || addr != "http://127.0.0.1:9102" {
		t.Errorf("leader FSM PeerHTTPAddr(joiner) = (%q, %v), want (\"http://127.0.0.1:9102\", true)", addr, ok)
	}
}

func TestJoinOnFollowerFailsWithErrNotLeader(t *testing.T) {
	nodes := startFoundingCluster(t, 2)
	defer shutdownAll(nodes)
	leader := waitForLeader(t, nodes, 15*time.Second)

	var follower *Node
	for _, n := range nodes {
		if n != leader {
			follower = n
		}
	}

	if err := follower.Join("someone", "127.0.0.1:1", "http://127.0.0.1:1"); err != raft.ErrNotLeader {
		t.Errorf("follower.Join() error = %v, want raft.ErrNotLeader", err)
	}
}

// Nutzerfund 2026-08-27 ("verhindere dass ich den cluster leader
// selbst entferne, vor allem, wenn es keinen anderen gibt") — live im
// eigenen Testlauf desselben Tages erlebt: ein Ein-Knoten-Cluster, der
// sich selbst entfernt, hat danach null Mitglieder und kann sich nie
// wieder selbst bootstrappen (kein Server mehr übrig, der eine Wahl
// abhalten könnte). Muss hart abgelehnt werden, statt live zu
// scheitern.
func TestLeaveRejectsRemovingLastVoterSelf(t *testing.T) {
	cfg := Config{
		NodeID:   "solo",
		RaftAddr: freeTCPAddr(t),
		DataDir:  t.TempDir(),
	}
	node, err := New(cfg)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = node.Shutdown(ctx)
	}()

	if !waitFor(10*time.Second, node.IsLeader) {
		t.Fatalf("single-node cluster never became leader, status=%+v", node.Status())
	}

	if err := node.Leave("solo"); err != ErrLastVoterIsLeader {
		t.Fatalf("Leave(self) on a 1-member cluster error = %v, want ErrLastVoterIsLeader", err)
	}
	// Muss tatsächlich Mitglied geblieben sein — kein Teilfortschritt.
	if len(node.Status().Peers) != 1 {
		t.Errorf("Status().Peers = %+v after rejected self-Leave, want still 1 (self)", node.Status().Peers)
	}
}

// Gegenprobe zum Block oben: entfernt sich der Leader selbst, während
// ANDERE Mitglieder übrig bleiben, ist das ein unterstützter Vorgang
// (raft.Config.ShutdownOnRemove greift für genau diesen Fall, s.
// Leave()-Doku) — die neue Prüfung darf das nicht mit blockieren.
func TestLeaveAllowsLeaderRemovingItselfWhenOthersRemain(t *testing.T) {
	nodes := startFoundingCluster(t, 3)
	defer shutdownAll(nodes)
	leader := waitForLeader(t, nodes, 15*time.Second)
	leaderID := leader.config.NodeID

	if err := leader.Leave(leaderID); err != nil {
		t.Fatalf("Leave(self) with other members present error = %v, want nil", err)
	}

	remaining := waitForLeader(t, nodes, 15*time.Second)
	if remaining.config.NodeID == leaderID {
		t.Fatalf("waitForLeader() still returned the removed former leader %s", leaderID)
	}
	if !waitFor(10*time.Second, func() bool { return len(remaining.Status().Peers) == 2 }) {
		t.Errorf("new leader still sees %d peers, want 2 (former leader removed)", len(remaining.Status().Peers))
	}
}

func TestLeaveRemovesVoterAndPeerHTTPAddr(t *testing.T) {
	nodes := startFoundingCluster(t, 3)
	defer shutdownAll(nodes)
	leader := waitForLeader(t, nodes, 15*time.Second)

	var toRemove *Node
	for _, n := range nodes {
		if n != leader {
			toRemove = n
			break
		}
	}
	removedID := toRemove.config.NodeID

	// Vor dem Entfernen einmal announcen, damit tatsächlich etwas zum
	// Aufräumen da ist (Nachweis, dass Leave den Eintrag wirklich
	// entfernt, nicht nur, dass er nie existierte).
	if err := leader.SetPeerHTTPAddr(removedID, "http://127.0.0.1:9999"); err != nil {
		t.Fatalf("SetPeerHTTPAddr() error = %v", err)
	}
	if !waitFor(5*time.Second, func() bool { _, ok := leader.FSM().PeerHTTPAddr(removedID); return ok }) {
		t.Fatalf("peer http addr never appeared before Leave()")
	}

	if err := leader.Leave(removedID); err != nil {
		t.Fatalf("Leave() error = %v", err)
	}

	if !waitFor(10*time.Second, func() bool { return len(leader.Status().Peers) == 2 }) {
		t.Fatalf("leader still sees %d peers after Leave(), want 2", len(leader.Status().Peers))
	}
	if _, ok := leader.FSM().PeerHTTPAddr(removedID); ok {
		t.Errorf("PeerHTTPAddr(%s) still present after Leave()", removedID)
	}
	// raft.Config.ShutdownOnRemove greift laut Quelltext (raft.go
	// leaderLoop) nur, wenn der LEADER SICH SELBST entfernt — eine
	// entfernte Nicht-Leader-Instanz fährt ihren lokalen *raft.Raft
	// NICHT automatisch herunter (empirisch geklärt, docs/decisions.md
	// Nachtrag 148), erkennt ihre Entfernung aber korrekt in der
	// eigenen Konfigurationssicht: sie sieht sich selbst nicht mehr in
	// ihrer eigenen Peers-Liste.
	if !waitFor(10*time.Second, func() bool {
		for _, p := range toRemove.Status().Peers {
			if p.ID == removedID {
				return false
			}
		}
		return true
	}) {
		t.Errorf("removed instance %s still lists itself as a peer, status=%+v", removedID, toRemove.Status())
	}
}

func waitFor(timeout time.Duration, cond func() bool) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return cond()
}
