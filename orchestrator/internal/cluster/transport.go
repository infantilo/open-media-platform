package cluster

import (
	"crypto/tls"
	"net"
	"time"

	"github.com/hashicorp/raft"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/mtls"
)

// streamLayer implementiert raft.StreamLayer (net.Listener + Dial) über
// echtes TCP, optional mTLS-gesichert — ARCHITECTURE.md §19.3 Punkt 2:
// bewusst der Raft-eigene, erprobte TCP-Transport statt eines
// selbstgebauten Transports über den bestehenden NATS-Bus (NATS-Pub/Sub
// bietet nicht die geordnete, verbindungsgebundene Punkt-zu-Punkt-
// Zustellung, auf der Raft-Korrektheit beruht).
type streamLayer struct {
	ln        net.Listener
	tlsConfig *tls.Config // nil = Klartext, Default (mTLS ist opt-in wie überall im Projekt)
}

// newStreamLayer bindet bindAddr (Form "host:port", MUSS eine konkrete,
// von anderen Instanzen erreichbare Adresse sein — anders als
// cfg.Config.Listen der HTTP-API ist diese Adresse zugleich die
// Selbstauskunft an den Rest des Clusters, s. Config.RaftAddr-Doku).
// tlsConfig nil ergibt einen reinen net.Listen("tcp", ...) — identisches
// Opt-in-Verhalten wie mtls.ClientTLSConfig/ServerTLSConfig.
func newStreamLayer(bindAddr string, tlsConfig *tls.Config) (*streamLayer, error) {
	var ln net.Listener
	var err error
	if tlsConfig != nil {
		ln, err = tls.Listen("tcp", bindAddr, tlsConfig)
	} else {
		ln, err = net.Listen("tcp", bindAddr)
	}
	if err != nil {
		return nil, err
	}
	return &streamLayer{ln: ln, tlsConfig: tlsConfig}, nil
}

func (s *streamLayer) Accept() (net.Conn, error) { return s.ln.Accept() }
func (s *streamLayer) Close() error              { return s.ln.Close() }
func (s *streamLayer) Addr() net.Addr            { return s.ln.Addr() }

// Dial baut die ausgehende Verbindung zu einer Peer-Raft-Adresse auf.
// Mit aktivem mTLS verifiziert tls.DialWithDialer den Server-Hostnamen
// aus address gegen das Peer-Zertifikat — dieselbe SAN-Falle wie beim
// ursprünglichen mTLS-Rollout (UMSETZUNG.md D3, docs/decisions.md
// 2026-07-13 Punkt 3: Zertifikate brauchen eine zur tatsächlichen
// Verbindungsadresse passende SAN, nicht nur den Node-Label als Subject)
// gilt hier unverändert — Zertifikatsausstellung für den Raft-Port muss
// dieselbe Regel befolgen.
func (s *streamLayer) Dial(address raft.ServerAddress, timeout time.Duration) (net.Conn, error) {
	dialer := &net.Dialer{Timeout: timeout}
	if s.tlsConfig != nil {
		return tls.DialWithDialer(dialer, "tcp", string(address), s.tlsConfig)
	}
	return dialer.Dial("tcp", string(address))
}

// peerTLSConfig baut eine einzelne *tls.Config, die gleichzeitig als
// TLS-Client (Peer als Server anrufen) UND als TLS-Server (von einem
// Peer angerufen werden) taugt — Raft-Instanzen sind sich gegenseitig
// gleichrangige Peers, nicht Client/Server in getrennten Rollen wie bei
// Orchestrator↔Node (dort deckt mtls.ClientTLSConfig/ServerTLSConfig je
// eine Richtung ab). Merged deshalb beide bestehenden Funktionen statt
// eine dritte, Cluster-eigene Zertifikatslade-Logik zu duplizieren.
// Liefert (nil, nil) bei cfg.Enabled=false (Klartext-Default).
func peerTLSConfig(cfg mtls.Config) (*tls.Config, error) {
	if !cfg.Enabled {
		return nil, nil
	}
	serverCfg, err := mtls.ServerTLSConfig(cfg)
	if err != nil {
		return nil, err
	}
	clientCfg, err := mtls.ClientTLSConfig(cfg)
	if err != nil {
		return nil, err
	}
	serverCfg.RootCAs = clientCfg.RootCAs
	return serverCfg, nil
}
