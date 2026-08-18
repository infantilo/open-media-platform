package cluster

import (
	"encoding/json"
	"io"
	"sync"

	"github.com/hashicorp/raft"
)

// CommandType unterscheidet die über Apply replizierten Kommandos (D12
// Teil 2 — die ersten echten Kommandotypen dieses FSM, s.
// Paketkommentar in cluster.go). Teil 3 fügt die eigentlichen §19.3-
// Punkt-5-Zustände (Migrations-Sperren, Crash-Loop-Zähler, …) als
// weitere CommandType-Werte hinzu, keine zweite Command-Hülle.
type CommandType string

const (
	// CommandSetPeerHTTPAddr/CommandRemovePeerHTTPAddr pflegen die
	// cluster-weite Zuordnung Raft-Server-ID → HTTP-API-Adresse dieser
	// Instanz — gebraucht, damit eine Follower-Instanz einen an sie
	// gerichteten schreibenden Admin-Aufruf (Join/Leave) an die
	// tatsächliche Leader-HTTP-Adresse weiterleiten kann (ARCHITECTURE.md
	// §19.3 Punkt 6, ersetzt den in der alten Postgres-Advisory-Lock-
	// Skizze noch für nötig gehaltenen externen VIP/Proxy-Baustein).
	// Bewusst im FSM statt in einer lokalen Config-Map: jede Instanz
	// braucht dieselbe Sicht, unabhängig davon, wann sie selbst
	// gestartet ist (ein neu beigetretener Knoten lernt die Zuordnung
	// beim Nachziehen des Logs/Snapshots automatisch mit, kein
	// separater Discovery-Mechanismus nötig).
	CommandSetPeerHTTPAddr    CommandType = "set_peer_http_addr"
	CommandRemovePeerHTTPAddr CommandType = "remove_peer_http_addr"
)

// Command ist die über raft.Apply(data, …) verschickte Nutzlast —
// JSON, damit sie sich verlustfrei im Snapshot spiegeln lässt und beim
// Debuggen lesbar bleibt (kein Binärformat nötig, die Nutzlast ist
// klein, gleiche Abwägung wie beim Snapshot-Format, s. fsmSnapshotState).
type Command struct {
	Type     CommandType `json:"type"`
	NodeID   string      `json:"nodeId,omitempty"`
	HTTPAddr string      `json:"httpAddr,omitempty"`
}

// FSM ist die Raft-Zustandsmaschine des Orchestrator-Clusters
// (ARCHITECTURE.md §19.3 Punkt 5, UMSETZUNG.md D12). D12 Teil 1 hielt sie
// noch bewusst minimal (nur ein Versionszähler, als Nachweis echter
// Log-Replikation). D12 Teil 2 fügt die erste echte Nutzlast hinzu — die
// Peer-HTTP-Adressbuch-Zuordnung oben; die eigentlichen, in §19.3
// Punkt 5 aufgezählten Zustände (Migrations-Sperren, Crash-Loop-Zähler,
// Standby-Beförderung, Scheduler-Feuerzustand) kommen erst mit D12
// Teil 3.
type FSM struct {
	mu            sync.Mutex
	version       uint64
	peerHTTPAddrs map[string]string // Raft-Server-ID -> HTTP-API-Adresse
}

// NewFSM erzeugt eine leere Zustandsmaschine (version 0) — der
// tatsächliche Stand wird beim Start entweder aus einem Snapshot
// (Restore) oder durch erneutes Anwenden des Raft-Logs (Apply)
// wiederhergestellt, beides von *raft.Raft selbst gesteuert, nicht von
// dieser Konstruktorfunktion.
func NewFSM() *FSM {
	return &FSM{peerHTTPAddrs: make(map[string]string)}
}

// Apply wird für jeden von der Mehrheit bestätigten Log-Eintrag genau
// einmal aufgerufen — muss deterministisch sein (§19.3: das ist exakt
// die Eigenschaft, die die in Punkt 5 aufgezählten Zustände cluster-weit
// exakt-einmal statt pro-Instanz macht). Jeder Aufruf zählt zusätzlich
// weiterhin den Versionszähler hoch (D12 Teil 1) — unverändert nützlich
// als billiger Konvergenz-Nachweis in Tests, unabhängig vom
// Kommando-Inhalt. Nicht dekodierbare/leere Nutzlast (z. B. die rohen
// Testbytes aus D12 Teil 1, cluster_test.go) ist kein Fehler — Apply
// darf laut raft.FSM-Doku nie selbst fehlschlagen, nur ein
// Response-Objekt zurückgeben.
func (f *FSM) Apply(log *raft.Log) interface{} {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.version++

	var cmd Command
	if len(log.Data) == 0 || json.Unmarshal(log.Data, &cmd) != nil {
		return f.version
	}
	switch cmd.Type {
	case CommandSetPeerHTTPAddr:
		if cmd.NodeID != "" {
			f.peerHTTPAddrs[cmd.NodeID] = cmd.HTTPAddr
		}
	case CommandRemovePeerHTTPAddr:
		delete(f.peerHTTPAddrs, cmd.NodeID)
	}
	return f.version
}

// Version liefert den zuletzt lokal angewendeten Versionszähler — genutzt
// vom Cluster-Status-Endpunkt (D12 Teil 1) und von Tests, um Konvergenz
// zwischen mehreren Instanzen nachzuweisen.
func (f *FSM) Version() uint64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.version
}

// PeerHTTPAddr löst die HTTP-API-Adresse einer Raft-Server-ID auf — s.
// CommandSetPeerHTTPAddr-Doku. Genutzt von Node.LeaderHTTPAddr für die
// Follower→Leader-Weiterleitung (D12 Teil 2).
func (f *FSM) PeerHTTPAddr(nodeID string) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	addr, ok := f.peerHTTPAddrs[nodeID]
	return addr, ok
}

// PeerHTTPAddrs liefert eine Kopie der vollständigen Zuordnung — genutzt
// vom Cluster-Status-Endpunkt (Diagnose/Debugging).
func (f *FSM) PeerHTTPAddrs() map[string]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make(map[string]string, len(f.peerHTTPAddrs))
	for k, v := range f.peerHTTPAddrs {
		out[k] = v
	}
	return out
}

// fsmSnapshotState ist die auf Platte/über den Snapshot-Sink persistierte
// Form des FSM-Zustands (reines JSON, kein Binärformat — der Zustand ist
// bewusst klein, s. Paketkommentar).
type fsmSnapshotState struct {
	Version       uint64            `json:"version"`
	PeerHTTPAddrs map[string]string `json:"peerHttpAddrs,omitempty"`
}

type fsmSnapshot struct {
	state fsmSnapshotState
}

// Snapshot erfasst einen konsistenten Zeigerstand (kein teures IO hier,
// s. raft.FSM-Doku) — die eigentliche Serialisierung passiert erst in
// Persist, außerhalb des Apply-Ausschlusses.
func (f *FSM) Snapshot() (raft.FSMSnapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	peers := make(map[string]string, len(f.peerHTTPAddrs))
	for k, v := range f.peerHTTPAddrs {
		peers[k] = v
	}
	return &fsmSnapshot{state: fsmSnapshotState{Version: f.version, PeerHTTPAddrs: peers}}, nil
}

// Restore ersetzt den kompletten FSM-Zustand durch den Snapshot-Inhalt —
// wird von *raft.Raft beim Start (vorhandener Snapshot) oder bei einer
// InstallSnapshot-RPC (stark zurückliegender Follower) aufgerufen, nie
// nebenläufig zu Apply (s. raft.FSM-Doku).
func (f *FSM) Restore(rc io.ReadCloser) error {
	defer rc.Close()
	var state fsmSnapshotState
	if err := json.NewDecoder(rc).Decode(&state); err != nil {
		return err
	}
	f.mu.Lock()
	f.version = state.Version
	f.peerHTTPAddrs = state.PeerHTTPAddrs
	if f.peerHTTPAddrs == nil {
		f.peerHTTPAddrs = make(map[string]string)
	}
	f.mu.Unlock()
	return nil
}

func (s *fsmSnapshot) Persist(sink raft.SnapshotSink) error {
	data, err := json.Marshal(s.state)
	if err != nil {
		sink.Cancel()
		return err
	}
	if _, err := sink.Write(data); err != nil {
		sink.Cancel()
		return err
	}
	return sink.Close()
}

func (s *fsmSnapshot) Release() {}
