package cluster

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/hashicorp/raft"
)

func TestTransferLeadershipMovesLeaderAndRejectsBadTargets(t *testing.T) {
	nodes := startFoundingCluster(t, 3)
	defer shutdownAll(nodes)
	leader := waitForLeader(t, nodes, 10*time.Second)

	var follower *Node
	for _, n := range nodes {
		if n != leader {
			follower = n
			break
		}
	}
	if err := follower.TransferLeadership(leader.config.NodeID); !errors.Is(err, raft.ErrNotLeader) {
		t.Fatalf("Follower: err = %v, want ErrNotLeader", err)
	}
	for _, bad := range []string{"", leader.config.NodeID, "gibt-es-nicht"} {
		if err := leader.TransferLeadership(bad); !errors.Is(err, ErrTransferTarget) {
			t.Fatalf("Ziel %q: err = %v, want ErrTransferTarget", bad, err)
		}
	}
	if err := leader.TransferLeadership(follower.config.NodeID); err != nil {
		t.Fatalf("TransferLeadership: %v", err)
	}
	if !waitFor(5*time.Second, func() bool { return follower.IsLeader() && !leader.IsLeader() }) {
		t.Fatalf("Fuehrung nicht uebergegangen: follower=%s leader=%s", follower.raft.State(), leader.raft.State())
	}
}

func TestMemberGateAndRolloutPrecheckOnLiveCluster(t *testing.T) {
	nodes := startFoundingCluster(t, 3)
	defer shutdownAll(nodes)
	leader := waitForLeader(t, nodes, 10*time.Second)
	if err := leader.apply(Command{Type: CommandSetPeerHTTPAddr, NodeID: "x", HTTPAddr: "127.0.0.1:1"}); err != nil {
		t.Fatal(err)
	}
	var sts []Status
	if !waitFor(5*time.Second, func() bool {
		sts = sts[:0]
		for _, n := range nodes {
			s := n.Status()
			if MemberGate(s, DefaultMaxLag) != nil {
				return false
			}
			sts = append(sts, s)
		}
		return true
	}) {
		t.Fatal("Tor wurde nicht offen")
	}
	if f := RolloutPrecheck(sts, DefaultMaxLag); len(f) != 0 {
		t.Fatalf("Vorpruefung 3 Knoten: %v", f)
	}
}

func TestRolloutPrecheckBlocksTwoMembersAndUnreachable(t *testing.T) {
	v := raft.Voter.String()
	mk := func(id string, peers int) Status {
		s := Status{NodeID: id, State: "Follower", LeaderID: "a", AppliedIndex: 10, LastIndex: 10}
		for i := 0; i < peers; i++ {
			s.Peers = append(s.Peers, Peer{ID: string(rune('a' + i)), Suffrage: v})
		}
		return s
	}
	f := RolloutPrecheck([]Status{mk("a", 2), mk("b", 2)}, DefaultMaxLag)
	if len(f) != 1 || !strings.Contains(f[0], "cluster-quorum") {
		t.Fatalf("2 Mitglieder: %v", f)
	}
	f = RolloutPrecheck([]Status{mk("a", 3), mk("b", 3)}, DefaultMaxLag)
	if len(f) != 1 || !strings.Contains(f[0], "2 von 3") {
		t.Fatalf("unerreichbar: %v", f)
	}
	lag := mk("c", 3)
	lag.LastIndex = 100
	cand := mk("b", 3)
	cand.State = "Candidate"
	f = RolloutPrecheck([]Status{mk("a", 3), cand, lag}, DefaultMaxLag)
	if len(f) != 2 {
		t.Fatalf("Tor-Befunde: %v", f)
	}
}
