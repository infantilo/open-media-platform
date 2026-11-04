package cluster

import (
	"errors"
	"fmt"

	"github.com/hashicorp/raft"
)

// Bausteine für das Cluster-Rolling-Update (Kap. 84, docs/ENTWURF-SYSTEM-UPDATE.md §11).
// Der Treiber selbst folgt in 84.3; hier nur: Führung abgeben und das Tor je Mitglied.

// DefaultMaxLag ist die Standard-Schwelle für lastIndex−appliedIndex, unter der ein Mitglied als „aufgeholt“ gilt.
const DefaultMaxLag uint64 = 8

// ErrTransferTarget: Ziel der Führungsübergabe ist ungültig.
var ErrTransferTarget = errors.New("cluster: Ziel der Fuehrungsuebergabe ist kein anderer stimmberechtigter Knoten")

// TransferLeadership gibt die Führung an das stimmberechtigte Mitglied targetID ab (raft.LeadershipTransferToServer).
// Nur auf dem Leader; blockiert, bis das Ziel Leader ist oder der Versuch scheitert. Dient dem Rollout: der alte Leader
// wird erst aktualisiert, nachdem ein bereits aktualisiertes Mitglied übernommen hat.
func (n *Node) TransferLeadership(targetID string) error {
	if n.raft.State() != raft.Leader {
		return raft.ErrNotLeader
	}
	if targetID == "" || targetID == n.config.NodeID {
		return ErrTransferTarget
	}
	cfg := n.raft.GetConfiguration()
	if err := cfg.Error(); err != nil {
		return fmt.Errorf("cluster: Konfiguration lesen: %w", err)
	}
	for _, s := range cfg.Configuration().Servers {
		if string(s.ID) == targetID {
			if s.Suffrage != raft.Voter {
				return ErrTransferTarget
			}
			return n.raft.LeadershipTransferToServer(s.ID, s.Address).Error()
		}
	}
	return ErrTransferTarget
}

// Lag liefert den Rückstand dieses Knotens (lastIndex−appliedIndex), 0 wenn nicht negativ.
func (s Status) Lag() uint64 {
	if s.LastIndex > s.AppliedIndex {
		return s.LastIndex - s.AppliedIndex
	}
	return 0
}

// voterCount zählt die stimmberechtigten Mitglieder aus der Sicht von s.
func (s Status) voterCount() int {
	n := 0
	for _, p := range s.Peers {
		if p.Suffrage == raft.Voter.String() {
			n++
		}
	}
	return n
}

// MemberGate ist das Tor je Mitglied (§11.2 Punkt 4), ausgewertet auf dem Status dieses Mitglieds: Raft-Zustand
// Follower/Leader, Rückstand unter maxLag, Mehrheit vorhanden. Version/healthz prüft der Treiber (84.3/84.4).
// Leere Antwort = Tor offen; sonst Klartext, warum nicht.
func MemberGate(s Status, maxLag uint64) error {
	if s.State != raft.Follower.String() && s.State != raft.Leader.String() {
		return fmt.Errorf("Raft-Zustand %q (erwartet Follower oder Leader)", s.State)
	}
	if s.LeaderID == "" {
		return errors.New("kein Leader bekannt")
	}
	if s.QuorumLost {
		return errors.New("keine Mehrheit (Quorum verloren)")
	}
	if lag := s.Lag(); lag > maxLag {
		return fmt.Errorf("Rueckstand %d Eintraege (Schwelle %d)", lag, maxLag)
	}
	return nil
}

// RolloutPrecheck prüft die Vorbedingungen für den Gesamt-Rollout aus den Status-Antworten aller Mitglieder
// (§11.2 Punkt 1, Entscheidung §11.9.1): mindestens 3 Stimmberechtigte (2 reichen nicht, es gäbe beim Neustart
// eines Mitglieds keine Mehrheit), jedes Mitglied hat geantwortet und besteht sein Tor.
// Rückgabe: Klartext-Befunde; leer = Rollout möglich.
func RolloutPrecheck(statuses []Status, maxLag uint64) []string {
	var out []string
	if len(statuses) == 0 {
		return []string{"keine Mitglieder-Status vorhanden"}
	}
	voters := statuses[0].voterCount()
	if voters < 3 {
		out = append(out, fmt.Sprintf("cluster-quorum: nur %d stimmberechtigte Mitglieder - mindestens 3 noetig (dritten Orchestrator oder Zeugen hinzufuegen)", voters))
	}
	if len(statuses) < len(statuses[0].Peers) {
		out = append(out, fmt.Sprintf("%d von %d Mitgliedern erreichbar", len(statuses), len(statuses[0].Peers)))
	}
	for _, s := range statuses {
		if err := MemberGate(s, maxLag); err != nil {
			out = append(out, fmt.Sprintf("%s: %v", s.NodeID, err))
		}
	}
	return out
}
