// Package cluster bündelt die Raft-Konsens-Schicht zwischen mehreren
// Orchestrator-Instanzen (ARCHITECTURE.md §19.3, UMSETZUNG.md D12) —
// löst die Orchestrator-Redundanz/Control-Plane-HA-Frage, ersetzt die
// ursprünglich vorgesehene Postgres-Advisory-Lock-Leader-Wahl (s.
// ARCHITECTURE.md §19.3 für die Begründung des Wechsels, docs/
// decisions.md Nachtrag 146).
//
// D12 Teil 1 lieferte das Grundgerüst: TCP(+mTLS)-Transport, dauerhaften
// Log/Snapshot-Store, Selbst-Bootstrap als Ein-Knoten-Cluster (kein
// Sonderfall-Code für "nur eine Instanz" — das ist der Normalfall) sowie
// Bootstrap mit einer vorab bekannten Gründungs-Peer-Liste
// (ParsePeers/Config.FoundingPeers), falls OMP_CLUSTER_PEERS gesetzt
// ist.
//
// D12 Teil 2 (dieser Schritt) fügt Laufzeit-Mitgliedschaft hinzu: eine
// Instanz kann mit Config.SkipBootstrap=true starten (bootstrapt sich
// NICHT selbst, wartet passiv, bis eine bestehende Leader-Instanz sie
// per Join() aufnimmt — Standard-Beitritts-Muster für hashicorp/raft,
// s. New-Doku), plus Join/Leave zum Hinzufügen/Entfernen von Mitgliedern
// eines bereits laufenden Clusters. Jede Instanz kündigt ihre eigene
// HTTP-API-Adresse an, sobald sie Leader wird (watchLeadership) — die
// FSM-replizierte Peer-HTTP-Adressbuch-Zuordnung (fsm.go) erlaubt jeder
// Instanz, einen bei ihr eingehenden, aber nur auf dem Leader gültigen
// Admin-Aufruf (Join/Leave) transparent weiterzuleiten (§19.3 Punkt 6),
// ohne den in der alten Postgres-Advisory-Lock-Skizze noch nötigen
// externen VIP/Proxy-Baustein.
//
// Die eigentliche FSM-Nutzung für die in §19.3 Punkt 5 aufgezählten
// Control-Plane-Zustände (Migrations-Sperren, Crash-Loop-Zähler,
// Standby-Beförderung, Scheduler-Feuerzustand) sowie das Aktiv/Passiv-
// Gating der Hintergrund-Loops kommt erst mit D12 Teil 3.
package cluster

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/hashicorp/raft"
	raftboltdb "github.com/hashicorp/raft-boltdb/v2"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/mtls"
)

// ErrLastVoterIsLeader — Nutzerfund 2026-08-27 (im Anschluss an den
// eigenen Cluster-Tab-Testlauf desselben Tages live erlebt): der
// Leader kann sich selbst entfernen (raft.Config.ShutdownOnRemove
// greift dann, s. Leave()-Doku unten) — solange andere Mitglieder
// übrig bleiben, ist das eine unterstützte Übergabe (Neuwahl unter den
// Verbleibenden). Ist er aber das EINZIGE Mitglied, entfernt er sich
// aus einer Konfiguration mit null verbleibenden Servern — der Cluster
// kann sich danach nie wieder selbst bootstrappen (kein Mitglied mehr
// vorhanden, das eine Wahl abhalten könnte), einzige Reparatur ist ein
// manuelles Löschen des Raft-Datenverzeichnisses und ein Neustart als
// frischer Ein-Knoten-Cluster. Dieser Fall wird hart abgelehnt, statt
// ihn erst live scheitern zu lassen.
var ErrLastVoterIsLeader = errors.New("cluster: refusing to remove the last remaining member (would permanently break the cluster)")

// transportMaxPool/transportTimeout sind Raft-Transport-Parameter ohne
// projektspezifische Bedeutung — Werte aus der hashicorp/raft-eigenen
// Dokumentation/den dortigen Beispielen übernommen (nicht geraten,
// UMSETZUNG.md §0 Punkt 6), nicht konfigurierbar gemacht: nichts an
// diesem Projekt braucht abweichende Werte, ein weiteres Config-Feld
// wäre unbegründete Komplexität.
const (
	transportMaxPool = 3
	transportTimeout = 10 * time.Second
	snapshotRetain   = 2
	// applyTimeout gilt für die Kommandos aus D12 Teil 2 (Peer-HTTP-
	// Adressbuch) — deutlich unter der HTTP-Handler-üblichen Zeitspanne,
	// damit ein hängender Apply (z. B. während einer Führungswechsel-
	// Übergangsphase) den aufrufenden Admin-Request nicht unbegrenzt
	// blockiert.
	applyTimeout = 5 * time.Second
)

// PeerSpec ist ein einzelner Cluster-Mitglied-Eintrag aus
// OMP_CLUSTER_PEERS (ID + Raft-TCP-Adresse). Die HTTP-Adresse jeder
// Instanz — gebraucht für die Follower→Leader-Weiterleitung ab D12
// Teil 2 — ist bewusst nicht Teil dieses Formats: Teil 1 braucht sie
// noch nicht, ein Feld ohne Verwendung wäre vorgezogene Komplexität
// (`UMSETZUNG.md` §0 Punkt 2: nichts aus späteren Schritten mitnehmen).
type PeerSpec struct {
	ID       string
	RaftAddr string
}

// ParsePeers liest OMP_CLUSTER_PEERS ("id1=host:port,id2=host:port,…").
// Ein leerer String ist kein Fehler — er bedeutet "keine vorab bekannte
// Gründungs-Mitgliederliste", s. Config.FoundingPeers-Doku.
func ParsePeers(spec string) ([]PeerSpec, error) {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return nil, nil
	}
	entries := strings.Split(spec, ",")
	peers := make([]PeerSpec, 0, len(entries))
	for _, entry := range entries {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		idAddr := strings.SplitN(entry, "=", 2)
		if len(idAddr) != 2 || idAddr[0] == "" || idAddr[1] == "" {
			return nil, fmt.Errorf("cluster: invalid peer entry %q, want id=host:port", entry)
		}
		peers = append(peers, PeerSpec{ID: idAddr[0], RaftAddr: idAddr[1]})
	}
	return peers, nil
}

// Config beschreibt eine einzelne Orchestrator-Instanz im Cluster.
type Config struct {
	// NodeID ist die über Neustarts hinweg stabile Raft-Server-ID dieser
	// Instanz (raft.ServerID) — OMP_NODE_ID.
	NodeID string
	// RaftAddr ist zugleich Bind-Adresse des Raft-TCP-Transports UND die
	// Adresse, unter der andere Peers diese Instanz erreichen (Raft hat
	// kein separates Advertise-Adressen-Konzept jenseits der Adresse, die
	// im Cluster-Konfigurationseintrag dieser Instanz steht) — MUSS
	// deshalb eine konkrete, von anderen Instanzen erreichbare Adresse
	// sein (kein ":8300"-Wildcard-Bind wie bei cfg.Config.Listen), s.
	// streamLayer-Doku. OMP_RAFT_LISTEN.
	RaftAddr string
	// DataDir hält den dauerhaften Raft-Log (BoltDB) + Snapshots —
	// OMP_RAFT_DATA_DIR, muss pro Instanz eindeutig sein (mehrere
	// Instanzen auf derselben Maschine, s. UMSETZUNG.md D12 Teil 1
	// Verifikation, brauchen getrennte Verzeichnisse wie schon heute
	// getrennte OMP_LISTEN-Ports).
	DataDir string
	// TLS sichert den Raft-TCP-Transport mTLS-verschlüsselt — dieselbe
	// Config-Struktur wie Orchestrator↔Node (§4.6), hier für die
	// Orchestrator↔Orchestrator-Richtung. Enabled=false (Default) ergibt
	// Klartext-TCP, unverändertes Opt-in-Muster.
	TLS mtls.Config
	// FoundingPeers ist die vollständige Cluster-Mitgliederliste
	// (inklusive dieser Instanz selbst), mit der ein Cluster ohne
	// bestehenden Raft-Log gebootstrapt wird (raft.BootstrapCluster,
	// s. New-Doku) — leer bedeutet "nur ich selbst" (Ein-Knoten-Cluster,
	// der Normalfall für den heutigen Single-Host-Dev-/Demo-Betrieb).
	// Wird nur beim allerersten Start einer Instanz ohne vorhandenen
	// Log ausgewertet; danach ist die tatsächliche Cluster-Konfiguration
	// im Raft-Log selbst die einzige Wahrheit (dieses Feld hat dann
	// keine Wirkung mehr). Ignoriert, wenn SkipBootstrap true ist.
	FoundingPeers []PeerSpec
	// HTTPAddr ist die von anderen Instanzen erreichbare HTTP-API-
	// Basis-Adresse dieser Instanz (OMP_ORCHESTRATOR_URL — bewusst
	// wiederverwendet statt eines neuen Config-Felds, s.
	// docs/decisions.md Nachtrag 147/148) — wird bei jedem
	// Führungswechsel automatisch ins FSM geschrieben (watchLeadership),
	// damit jede Instanz die aktuelle Leader-HTTP-Adresse auflösen kann
	// (LeaderHTTPAddr, D12 Teil 2). Leer ist zulässig (Follower→Leader-
	// Weiterleitung funktioniert dann nicht, alles andere unverändert).
	HTTPAddr string
	// SkipBootstrap unterdrückt den Selbst-Bootstrap für eine frische
	// Instanz (kein vorhandener Log) — die Instanz startet dann
	// unkonfiguriert und wartet passiv, bis eine bestehende
	// Leader-Instanz sie per Join() aufnimmt (D12 Teil 2, Standard-
	// Beitritts-Muster: "bootstrap a single server … then invoke
	// AddVoter() on it to add other servers", raft.Raft.
	// BootstrapCluster-Doku). Wirkungslos, wenn bereits ein Log
	// existiert (dann läuft ohnehin kein Bootstrap, s. New-Doku).
	SkipBootstrap bool
}

// Node kapselt eine laufende Raft-Instanz samt ihrer Speicher-/
// Transport-Ressourcen.
type Node struct {
	raft      *raft.Raft
	fsm       *FSM
	transport *raft.NetworkTransport
	logStore  *raftboltdb.BoltStore
	config    Config
	notifyCh  chan bool
	stopCh    chan struct{}
	stopOnce  sync.Once
}

// New startet eine Raft-Instanz für cfg. Eine frische Instanz (kein
// vorhandener Log unter cfg.DataDir) bootstrapt sich selbst — entweder
// als Ein-Knoten-Cluster (cfg.FoundingPeers leer) oder mit der vollen
// Gründungs-Mitgliederliste (cfg.FoundingPeers gesetzt; jede in der
// Liste genannte Instanz muss beim ersten Start dieselbe Liste
// übergeben — Standard-Muster für "alle Gründungsmitglieder vorab
// bekannt", s. raft.Raft.BootstrapCluster-Doku "identical configuration
// listing all Voter servers") — es sei denn, cfg.SkipBootstrap ist
// gesetzt: dann bootstrapt sich eine frische Instanz NICHT selbst,
// sondern wartet passiv auf Join() durch eine bestehende Leader-Instanz
// (D12 Teil 2). Eine bereits bestehende Instanz (Log vorhanden, z. B.
// nach einem Neustart) ignoriert cfg.FoundingPeers/SkipBootstrap und
// resumed unverändert aus ihrem eigenen Log/Snapshot.
func New(cfg Config) (*Node, error) {
	if cfg.NodeID == "" {
		return nil, fmt.Errorf("cluster: NodeID required")
	}
	if cfg.RaftAddr == "" {
		return nil, fmt.Errorf("cluster: RaftAddr required")
	}
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return nil, fmt.Errorf("cluster: create data dir %s: %w", cfg.DataDir, err)
	}

	tlsConfig, err := peerTLSConfig(cfg.TLS)
	if err != nil {
		return nil, fmt.Errorf("cluster: tls config: %w", err)
	}

	layer, err := newStreamLayer(cfg.RaftAddr, tlsConfig)
	if err != nil {
		return nil, fmt.Errorf("cluster: listen %s: %w", cfg.RaftAddr, err)
	}
	transport := raft.NewNetworkTransport(layer, transportMaxPool, transportTimeout, os.Stderr)

	snapshotStore, err := raft.NewFileSnapshotStore(cfg.DataDir, snapshotRetain, os.Stderr)
	if err != nil {
		return nil, fmt.Errorf("cluster: snapshot store: %w", err)
	}

	logStore, err := raftboltdb.NewBoltStore(filepath.Join(cfg.DataDir, "raft.db"))
	if err != nil {
		return nil, fmt.Errorf("cluster: bolt store: %w", err)
	}

	hasState, err := raft.HasExistingState(logStore, logStore, snapshotStore)
	if err != nil {
		return nil, fmt.Errorf("cluster: check existing state: %w", err)
	}

	fsm := NewFSM()

	raftCfg := raft.DefaultConfig()
	raftCfg.LocalID = raft.ServerID(cfg.NodeID)
	// Default-Log-Level von hashicorp/raft ist DEBUG (live beim ersten
	// Testlauf gesehen: sehr geschwätzig, jede Pre-Vote/Vote-RPC einzeln)
	// — WARN reicht für den Produktionsbetrieb (Leader-Wechsel/Fehler
	// bleiben sichtbar), passt zum Rest des Projekts (strukturierte,
	// knappe slog-Logs statt Debug-Rauschen).
	raftCfg.LogLevel = "WARN"
	// notifyCh treibt watchLeadership (Selbst-Ankündigung der eigenen
	// HTTP-Adresse bei jedem Führungswechsel, s. Paketkommentar) —
	// gepuffert mit 1, weil raft.Config.NotifyCh-Doku ausdrücklich vor
	// blockierendem Schreiben warnt ("Raft will block writing to this
	// channel").
	notifyCh := make(chan bool, 1)
	raftCfg.NotifyCh = notifyCh

	r, err := raft.NewRaft(raftCfg, fsm, logStore, logStore, snapshotStore, transport)
	if err != nil {
		return nil, fmt.Errorf("cluster: new raft: %w", err)
	}

	if !hasState && !cfg.SkipBootstrap {
		founders := cfg.FoundingPeers
		if len(founders) == 0 {
			founders = []PeerSpec{{ID: cfg.NodeID, RaftAddr: cfg.RaftAddr}}
		}
		servers := make([]raft.Server, len(founders))
		for i, p := range founders {
			servers[i] = raft.Server{
				ID:       raft.ServerID(p.ID),
				Address:  raft.ServerAddress(p.RaftAddr),
				Suffrage: raft.Voter,
			}
		}
		future := r.BootstrapCluster(raft.Configuration{Servers: servers})
		// ErrCantBootstrap ("already has state") kann trotz hasState==false
		// theoretisch auftreten, wenn zwei Instanzen exakt gleichzeitig
		// zum allerersten Mal starten und sich dabei bereits gegenseitig
		// über den Transport erreichen, bevor beide BootstrapCluster
		// aufgerufen haben — raft.Raft.BootstrapCluster-Doku nennt das
		// explizit sicher ignorierbar ("Any further attempts to bootstrap
		// will return an error that can be safely ignored").
		if err := future.Error(); err != nil && err != raft.ErrCantBootstrap {
			return nil, fmt.Errorf("cluster: bootstrap: %w", err)
		}
	}

	node := &Node{
		raft:      r,
		fsm:       fsm,
		transport: transport,
		logStore:  logStore,
		config:    cfg,
		notifyCh:  notifyCh,
		stopCh:    make(chan struct{}),
	}
	go node.watchLeadership()
	return node, nil
}

// watchLeadership kündigt bei jedem Führungswechsel dieser Instanz
// (notifyCh liefert true) die eigene HTTP-API-Adresse cluster-weit über
// das FSM an (SetPeerHTTPAddr) — Grundlage der Follower→Leader-
// Weiterleitung (D12 Teil 2, s. Paketkommentar). Bewusst best-effort:
// schlägt der Apply-Aufruf fehl (z. B. weil die Führung schon während
// des Aufrufs wieder verloren ging), bleibt die Instanz einfach ohne
// bekannte eigene Adresse im FSM — kein Absturz, der nächste
// Führungswechsel versucht es erneut. Läuft bis Shutdown (stopCh).
func (n *Node) watchLeadership() {
	for {
		select {
		case <-n.stopCh:
			return
		case isLeader, ok := <-n.notifyCh:
			if !ok {
				return
			}
			if isLeader && n.config.HTTPAddr != "" {
				_ = n.SetPeerHTTPAddr(n.config.NodeID, n.config.HTTPAddr)
			}
		}
	}
}

// Shutdown stoppt die Raft-Instanz und schließt Log-/Transport-
// Ressourcen. Blockiert höchstens bis ctx abläuft. Mehrfacher Aufruf ist
// sicher (sync.Once um das stopCh-Close) — raft.Raft.Shutdown() selbst
// ist laut Doku bereits idempotent, ein Test/Aufrufer, der eine Instanz
// gezielt vorzeitig stoppt und danach trotzdem noch in einer
// generischen "alle aufräumen"-Schleife landet, darf nicht in eine
// doppelt-close-Panik laufen.
func (n *Node) Shutdown(ctx context.Context) error {
	n.stopOnce.Do(func() { close(n.stopCh) })
	future := n.raft.Shutdown()
	errCh := make(chan error, 1)
	go func() { errCh <- future.Error() }()

	var shutdownErr error
	select {
	case shutdownErr = <-errCh:
	case <-ctx.Done():
		shutdownErr = ctx.Err()
	}

	_ = n.transport.Close()
	if closeErr := n.logStore.Close(); closeErr != nil && shutdownErr == nil {
		shutdownErr = closeErr
	}
	return shutdownErr
}

// IsLeader meldet, ob diese Instanz aktuell der Raft-Leader ist —
// Grundlage des ab D12 Teil 3 eingeführten Aktiv/Passiv-Gatings
// (ARCHITECTURE.md §19.3 Punkt 6): nur der Leader treibt die
// cluster-weiten Hintergrund-Loops.
func (n *Node) IsLeader() bool {
	return n.raft.State() == raft.Leader
}

// FSM liefert die zugrundeliegende Zustandsmaschine — gebraucht ab D12
// Teil 3, wenn workflows/placement echte Kommandos über Apply schicken;
// bis dahin nur für den Status-Endpunkt (Version/PeerHTTPAddrs) und
// Tests.
func (n *Node) FSM() *FSM {
	return n.fsm
}

// SetPeerHTTPAddr appliziert CommandSetPeerHTTPAddr — muss auf dem
// Leader laufen (raft.Raft.Apply liefert sonst raft.ErrNotLeader über
// die zurückgegebene Future). Exportiert für main.go (Selbst-Ankündigung
// beim erstmaligen Beitritt ist bereits über watchLeadership automatisch
// abgedeckt; dieser Aufruf bleibt für Join() unten und für Tests
// nützlich).
func (n *Node) SetPeerHTTPAddr(nodeID, httpAddr string) error {
	return n.apply(Command{Type: CommandSetPeerHTTPAddr, NodeID: nodeID, HTTPAddr: httpAddr})
}

func (n *Node) apply(cmd Command) error {
	data, err := json.Marshal(cmd)
	if err != nil {
		return fmt.Errorf("cluster: marshal command: %w", err)
	}
	future := n.raft.Apply(data, applyTimeout)
	return future.Error()
}

// Join fügt eine neue Instanz als stimmberechtigtes Mitglied hinzu
// (raft.Raft.AddVoter) und trägt ihre HTTP-Adresse ins FSM ein, damit
// sie ab sofort für die Follower→Leader-Weiterleitung auflösbar ist —
// muss auf dem Leader laufen, s. httpapi.handleClusterJoin für die
// Weiterleitung, falls diese Instanz gerade nicht Leader ist. Ist raftAddr
// bereits Mitglied, aktualisiert AddVoter nur dessen Adresse (idempotent,
// s. dortige Doku) — kein Sonderfall für einen erneuten Join-Versuch
// nötig.
func (n *Node) Join(nodeID, raftAddr, httpAddr string) error {
	if !n.IsLeader() {
		return raft.ErrNotLeader
	}
	future := n.raft.AddVoter(raft.ServerID(nodeID), raft.ServerAddress(raftAddr), 0, applyTimeout)
	if err := future.Error(); err != nil {
		return fmt.Errorf("cluster: add voter: %w", err)
	}
	if httpAddr != "" {
		if err := n.SetPeerHTTPAddr(nodeID, httpAddr); err != nil {
			return fmt.Errorf("cluster: announce joined peer http addr: %w", err)
		}
	}
	return nil
}

// Leave entfernt ein Mitglied (raft.Raft.RemoveServer) und räumt seinen
// FSM-Adressbucheintrag auf — muss auf dem Leader laufen. **Empirisch
// geklärt statt aus der Doku übernommen** (`raft.Config.
// ShutdownOnRemove`s Doku klingt so, als gelte sie für jede entfernte
// Instanz — der Quelltext, raft.go `leaderLoop`, zeigt: sie greift nur,
// wenn der LEADER SICH SELBST entfernt, s. docs/decisions.md Nachtrag
// 148). Für eine entfernte Nicht-Leader-Instanz gilt: ihr lokaler
// `*raft.Raft` fährt NICHT automatisch herunter — er bleibt als
// verwaister Follower bestehen (bekommt keine weiteren AppendEntries
// mehr, kann nie wieder Leader werden), erkennt seine Entfernung aber
// korrekt in der eigenen `GetConfiguration()`/Status()-Sicht (sich
// selbst nicht mehr in Peers, live verifiziert). Der
// Orchestrator-Prozess bleibt in jedem Fall am Leben (HTTP-API/UI
// unverändert erreichbar) — ein tatsächliches Herunterfahren des
// Prozesses ist Sache des normalen Instanz-Lebenszyklus (§18/K7), nicht
// dieser Methode.
func (n *Node) Leave(nodeID string) error {
	if !n.IsLeader() {
		return raft.ErrNotLeader
	}
	if nodeID == n.config.NodeID {
		cfgFuture := n.raft.GetConfiguration()
		if err := cfgFuture.Error(); err != nil {
			return fmt.Errorf("cluster: read configuration: %w", err)
		}
		if len(cfgFuture.Configuration().Servers) <= 1 {
			return ErrLastVoterIsLeader
		}
	}
	future := n.raft.RemoveServer(raft.ServerID(nodeID), 0, applyTimeout)
	if err := future.Error(); err != nil {
		return fmt.Errorf("cluster: remove server: %w", err)
	}
	if err := n.apply(Command{Type: CommandRemovePeerHTTPAddr, NodeID: nodeID}); err != nil {
		// Selbst-Entfernung des Leaders bei noch vorhandenen anderen
		// Mitgliedern (Nutzerfund 2026-08-27, Test
		// TestLeaveAllowsLeaderRemovingItselfWhenOthersRemain): das
		// RemoveServer oben löst über raft.Config.ShutdownOnRemove
		// bereits SYNCHRON das Herunterfahren dieser eigenen
		// Raft-Instanz aus, noch während Leave() läuft — der
		// nachfolgende Apply-Aufruf hier trifft dann unvermeidlich auf
		// eine bereits abgeschaltete Instanz (raft.ErrRaftShutdown) und
		// kann grundsätzlich nicht mehr gelingen, es gibt keine laufende
		// Instanz mehr, die ihn ausführen könnte. Die eigentliche
		// Entfernung (RemoveServer oben) ist zu diesem Zeitpunkt bereits
		// erfolgreich committed — nur der zusätzliche
		// Adressbuch-Eintrag des entfernten Knotens bleibt als
		// harmloser Rest im FSM der übrigen Instanzen stehen (wird bei
		// einem künftigen erneuten Join derselben Node-ID automatisch
		// überschrieben, s. Join()/SetPeerHTTPAddr) — kein Fehlerfall
		// für den Aufrufer. Jede andere Ursache (auch bei Selbst-
		// Entfernung) bleibt ein echter Fehler.
		if nodeID == n.config.NodeID && errors.Is(err, raft.ErrRaftShutdown) {
			return nil
		}
		return fmt.Errorf("cluster: forget peer http addr: %w", err)
	}
	return nil
}

// LeaderHTTPAddr löst die HTTP-API-Adresse des aktuellen Leaders auf —
// (false, "") wenn gerade kein Leader bekannt ist ODER der bekannte
// Leader seine Adresse noch nicht angekündigt hat (kurzes Fenster direkt
// nach einem Führungswechsel, s. watchLeadership). Grundlage der
// Follower→Leader-Weiterleitung in httpapi (D12 Teil 2).
func (n *Node) LeaderHTTPAddr() (string, bool) {
	_, leaderID := n.raft.LeaderWithID()
	if leaderID == "" {
		return "", false
	}
	return n.fsm.PeerHTTPAddr(string(leaderID))
}

// Peer ist die Sicht auf ein einzelnes Cluster-Mitglied für Status.
type Peer struct {
	ID       string `json:"id"`
	RaftAddr string `json:"raftAddr"`
	Suffrage string `json:"suffrage"`
}

// Status ist die Antwort auf GET /api/v1/cluster/status.
type Status struct {
	NodeID         string            `json:"nodeId"`
	RaftAddr       string            `json:"raftAddr"`
	HTTPAddr       string            `json:"httpAddr,omitempty"`
	State          string            `json:"state"`
	IsLeader       bool              `json:"isLeader"`
	LeaderID       string            `json:"leaderId,omitempty"`
	LeaderRaftAddr string            `json:"leaderRaftAddr,omitempty"`
	LeaderHTTPAddr string            `json:"leaderHttpAddr,omitempty"`
	Term           uint64            `json:"term"`
	AppliedIndex   uint64            `json:"appliedIndex"`
	LastIndex      uint64            `json:"lastIndex"`
	FSMVersion     uint64            `json:"fsmVersion"`
	Peers          []Peer            `json:"peers"`
	PeerHTTPAddrs  map[string]string `json:"peerHttpAddrs,omitempty"`
}

// Status liest den aktuellen Raft-Zustand dieser Instanz — reine
// Lesezugriffe auf *raft.Raft, keine eigene Buchführung nötig (dieselbe
// Linie wie der Rest des Projekts: der Orchestrator hält so wenig
// eigenen, nicht wiederherstellbaren Zustand wie möglich,
// ARCHITECTURE.md §19.3).
func (n *Node) Status() Status {
	leaderAddr, leaderID := n.raft.LeaderWithID()

	var peers []Peer
	if cfgFuture := n.raft.GetConfiguration(); cfgFuture.Error() == nil {
		for _, s := range cfgFuture.Configuration().Servers {
			peers = append(peers, Peer{
				ID:       string(s.ID),
				RaftAddr: string(s.Address),
				Suffrage: s.Suffrage.String(),
			})
		}
	}

	// raft.Raft.Stats()s "term"-Wert ist laut dortiger Doku ein uint64
	// als String formatiert — kein separates Config.CurrentTerm()
	// existiert in dieser Bibliotheksversion (nicht geraten, per
	// `go doc`/Quelltext gegen v1.7.3 verifiziert, UMSETZUNG.md §0
	// Punkt 6).
	term, _ := strconv.ParseUint(n.raft.Stats()["term"], 10, 64)
	leaderHTTPAddr, _ := n.LeaderHTTPAddr()

	return Status{
		NodeID:         n.config.NodeID,
		RaftAddr:       n.config.RaftAddr,
		HTTPAddr:       n.config.HTTPAddr,
		State:          n.raft.State().String(),
		IsLeader:       n.raft.State() == raft.Leader,
		LeaderID:       string(leaderID),
		LeaderRaftAddr: string(leaderAddr),
		LeaderHTTPAddr: leaderHTTPAddr,
		Term:           term,
		AppliedIndex:   n.raft.AppliedIndex(),
		LastIndex:      n.raft.LastIndex(),
		FSMVersion:     n.fsm.Version(),
		Peers:          peers,
		PeerHTTPAddrs:  n.fsm.PeerHTTPAddrs(),
	}
}
