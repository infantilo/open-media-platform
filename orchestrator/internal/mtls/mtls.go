// Package mtls lädt Client-TLS-Konfiguration für die Orchestrator-Seite
// der mTLS-Strecke Orchestrator↔Nodes (UMSETZUNG.md D3,
// ARCHITECTURE.md §4.6: "step-ca … von Anfang an, nicht nachrüsten" —
// hier nachträglich, aber bewusst additiv/opt-in, s. Config.Enabled,
// damit alle bisher verifizierten Flows ohne mTLS unverändert
// weiterlaufen). Node-seitige Server-TLS-Konfiguration lebt separat in
// `nodes/mock/internal/mtls` (eigenes Go-Modul, kein Code-Sharing über
// Modulgrenzen — bewusste Duplikation eines kleinen Ladevorgangs statt
// eines dritten, nur dafür existierenden Moduls).
//
// **Scope-Entscheidung (2026-07-13):** D3 bündelt drei Themen (mTLS
// Orchestrator↔Nodes, IS-10/OAuth2 für die UI, §12-Rollenmodell). Dieser
// Schritt deckt nur mTLS Orchestrator↔Nodes ab — konkret nur die
// Go-Seite (Orchestrator-Client, `nodes/mock`-Server): der
// `omp-node-sdk`-Rust-Server (`tiny_http`, kein eingebautes TLS) braucht
// dafür eine eigene, größere Ausbaustufe (TLS-Terminierung + neue
// Dependency), IS-10/OAuth2/§12 bleiben ausdrücklich offen — beides in
// `docs/decisions.md`/`UMSETZUNG.md` D3 als verbleibender Scope
// festgehalten, nicht stillschweigend übersprungen.
package mtls

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
)

// Config beschreibt, ob und mit welchen Zertifikaten der Orchestrator
// mTLS gegenüber Nodes spricht.
type Config struct {
	Enabled  bool
	CertFile string
	KeyFile  string
	CAFile   string
}

// ClientTLSConfig baut die *tls.Config für einen mTLS-fähigen
// http.Client: eigenes Client-Zertifikat (von Nodes zur Authentifizierung
// verlangt) + Root-CA-Pool (zum Verifizieren des Node-Server-Zertifikats).
// Liefert (nil, nil), wenn cfg.Enabled false ist — der Aufrufer verwendet
// dann seinen bisherigen, TLS-losen http.Client unverändert weiter.
func ClientTLSConfig(cfg Config) (*tls.Config, error) {
	if !cfg.Enabled {
		return nil, nil
	}

	cert, err := tls.LoadX509KeyPair(cfg.CertFile, cfg.KeyFile)
	if err != nil {
		return nil, fmt.Errorf("mtls: load client cert/key: %w", err)
	}

	caPool, err := loadCAPool(cfg.CAFile)
	if err != nil {
		return nil, err
	}

	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		RootCAs:      caPool,
		MinVersion:   tls.VersionTLS12,
	}, nil
}

func loadCAPool(caFile string) (*x509.CertPool, error) {
	pem, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("mtls: read CA file: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("mtls: no valid certificates found in %s", caFile)
	}
	return pool, nil
}
