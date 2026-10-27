package cluster

// Raft-Zeuge und Notausgang (Audit 2026-10-23 B5): zwei Orchestratoren haben bei Ausfall eines Knotens keine Mehrheit — Failover, Scheduler und alles, was nur der
// Leader tut, stehen. Zwei Wege:
//
//  1. Zeuge: ein dritter, leichter Raft-Knoten (cmd/witness) auf einem eigenen Rechner. Er stimmt ab, verwaltet aber nichts und behält nie die Führung (Config.Witness:
//     er erkennt Leader-Ausfälle erst nach der dreifachen Frist und überträgt eine zufällig gewonnene Führung sofort an einen Orchestrator). Mit ihm genügen 2 von 3.
//  2. Notausgang: fällt ein Partner dauerhaft aus und es gibt keinen Zeugen, kann ein Administrator den verbliebenen Knoten bewusst als Einzelknoten weiterbetreiben.
//     Das schreibt eine Marke ins Datenverzeichnis; beim nächsten Start baut der Knoten seine Raft-Konfiguration auf sich allein um (raft.RecoverCluster). Läuft der
//     Partner doch noch, entsteht Split-Brain — deshalb nur mit ausdrücklicher Bestätigung und nur, solange seit Sekunden kein Leader bekannt ist.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/hashicorp/raft"
)

// witnessTimeout: ein Zeuge muss den Ausfall des Leaders erkennen (nur dann gibt er seine Stimme an einen neuen), soll aber nicht vor den Orchestratoren (Standard 1 s)
// eine Wahl anstoßen: dreifache Frist. Gewinnt er trotzdem einmal (Rennen), gibt er die Führung sofort ab (relinquish).
const witnessTimeout = 3 * time.Second

// QuorumLostAfter: ab dieser Zeit ohne bekannten Leader (bei mehr als einem Mitglied) gilt der Cluster als ohne Mehrheit.
var QuorumLostAfter = 15 * time.Second

// ErrNotQuorumLost: der Notausgang ist nur ohne Leader erlaubt.
var ErrNotQuorumLost = errors.New("cluster: a leader is known (or was seen moments ago) — the emergency exit is only allowed without a leader")

// ErrNoOtherMembers: allein im Cluster gibt es nichts umzubauen.
var ErrNoOtherMembers = errors.New("cluster: this node is already the only member")

const recoverMarkerName = "recover-solo.json"

type recoverMarker struct {
	NodeID string `json:"nodeId"`
	By     string `json:"by"`
	At     string `json:"at"`
}

func markerPath(dataDir string) string { return filepath.Join(dataDir, recoverMarkerName) }

// applyWitnessTimeouts macht den Knoten zum reinen Stimmgeber.
func applyWitnessTimeouts(c *raft.Config) {
	c.HeartbeatTimeout = witnessTimeout
	c.ElectionTimeout = witnessTimeout
}

// relinquish: ein Zeuge, der trotz allem Leader wurde, überträgt die Führung an einen echten Orchestrator (bis es klappt oder er nicht mehr Leader ist).
func (n *Node) relinquish() {
	for {
		select {
		case <-n.stopCh:
			return
		default:
		}
		if n.raft.State() != raft.Leader {
			return
		}
		if err := n.raft.LeadershipTransfer().Error(); err == nil {
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// consumeRecoverMarker liest und löscht die Marke; ok=true, wenn sie für diesen Knoten vorlag.
func consumeRecoverMarker(dataDir, nodeID string) (recoverMarker, bool, error) {
	b, err := os.ReadFile(markerPath(dataDir))
	if errors.Is(err, os.ErrNotExist) {
		return recoverMarker{}, false, nil
	}
	if err != nil {
		return recoverMarker{}, false, err
	}
	var m recoverMarker
	if json.Unmarshal(b, &m) != nil || m.NodeID != nodeID {
		// Fremde oder beschädigte Marke: nicht ausführen, aber auch nicht liegen lassen (sonst später unbeabsichtigt wirksam).
		_ = os.Remove(markerPath(dataDir))
		return recoverMarker{}, false, nil
	}
	if err := os.Remove(markerPath(dataDir)); err != nil {
		return recoverMarker{}, false, err
	}
	return m, true, nil
}

// recoverSolo baut die Raft-Konfiguration auf diesen Knoten allein um (nur bei nicht laufender Instanz erlaubt).
func recoverSolo(cfg Config, raftCfg *raft.Config, fsm raft.FSM, logs raft.LogStore, stable raft.StableStore, snaps raft.SnapshotStore, trans raft.Transport) error {
	conf := raft.Configuration{Servers: []raft.Server{{ID: raft.ServerID(cfg.NodeID), Address: raft.ServerAddress(cfg.RaftAddr), Suffrage: raft.Voter}}}
	return raft.RecoverCluster(raftCfg, fsm, logs, stable, snaps, trans, conf)
}

// NoLeaderFor: wie lange dieser Knoten keinen Kontakt zu einem Leader hatte (0 = er ist selbst Leader oder hatte gerade Kontakt). Maßgeblich ist der letzte Kontakt
// (raft.LastContact), nicht die Leader-Adresse: die bleibt bei einem Follower nach Ausfall des Leaders eine Weile stehen und flackert bei fehlgeschlagenen Vorwahlen.
func (n *Node) NoLeaderFor() time.Duration {
	if n.raft.State() == raft.Leader {
		return 0
	}
	last := n.raft.LastContact()
	if last.IsZero() || last.Before(n.started) {
		last = n.started
	}
	d := time.Since(last)
	// Ein lebender Leader meldet sich mehrmals je Heartbeat-Intervall; alles unter der Wahl-Zeit gilt als „Leader da“.
	if d < 3*time.Second {
		return 0
	}
	return d
}

// QuorumLost: es gibt weitere Mitglieder, aber seit QuorumLostAfter keinen Leader.
func (n *Node) QuorumLost() bool {
	f := n.raft.GetConfiguration()
	if f.Error() != nil || len(f.Configuration().Servers) < 2 {
		return false
	}
	return n.NoLeaderFor() >= QuorumLostAfter
}

// RequestSolo (Notausgang): schreibt die Marke; wirksam beim nächsten Start dieses Orchestrators. Verweigert, wenn ein Leader bekannt ist.
func (n *Node) RequestSolo(by string) error {
	f := n.raft.GetConfiguration()
	if err := f.Error(); err != nil {
		return fmt.Errorf("cluster: read configuration: %w", err)
	}
	if len(f.Configuration().Servers) < 2 {
		return ErrNoOtherMembers
	}
	if n.NoLeaderFor() < QuorumLostAfter {
		return ErrNotQuorumLost
	}
	b, _ := json.Marshal(recoverMarker{NodeID: n.config.NodeID, By: by, At: time.Now().UTC().Format(time.RFC3339)})
	tmp := markerPath(n.config.DataDir) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, markerPath(n.config.DataDir))
}

// SoloPending: die Marke liegt vor (Neustart steht aus).
func (n *Node) SoloPending() bool {
	_, err := os.Stat(markerPath(n.config.DataDir))
	return err == nil
}

// CancelSolo nimmt die Marke zurück (z. B. weil der Partner doch wieder da ist).
func (n *Node) CancelSolo() error {
	if err := os.Remove(markerPath(n.config.DataDir)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// raftLogLevel: Protokollstufe der Raft-Bibliothek (WARN; in Tests für die Fehlersuche änderbar).
var raftLogLevel = "WARN"
