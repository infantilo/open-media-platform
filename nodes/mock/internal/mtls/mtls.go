// Package mtls lädt Server-TLS-Konfiguration für die Node-Seite der
// mTLS-Strecke Orchestrator↔Nodes (UMSETZUNG.md D3, ARCHITECTURE.md
// §4.6). Eigenständige, kleine Duplikation von
// orchestrator/internal/mtls (andere Go-Module, kein Cross-Modul-
// Import möglich/sinnvoll für so wenig Code) — dort die Client-, hier
// die Server-Seite (ClientAuth: RequireAndVerifyClientCert, verweigert
// jede Verbindung ohne gültiges, von derselben CA signiertes
// Client-Zertifikat — das ist der eigentliche Contract-Punkt "mTLS",
// nicht nur Transportverschlüsselung).
package mtls

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"
)

// Config beschreibt, ob und mit welchen Zertifikaten der Node mTLS
// gegenüber dem Orchestrator (bzw. jedem Aufrufer mit gültigem
// Client-Zertifikat derselben CA) spricht.
type Config struct {
	Enabled  bool
	CertFile string
	KeyFile  string
	CAFile   string
}

// ServerTLSConfig baut die *tls.Config für einen mTLS-pflichtigen HTTP-
// Server: eigenes Server-Zertifikat + Pflicht-Client-Zertifikats-
// Prüfung gegen den CA-Pool. Liefert (nil, nil), wenn cfg.Enabled false
// ist — der Aufrufer startet dann unverändert per http.ListenAndServe
// (Klartext, wie vor D3).
func ServerTLSConfig(cfg Config) (*tls.Config, error) {
	if !cfg.Enabled {
		return nil, nil
	}

	cert, err := tls.LoadX509KeyPair(cfg.CertFile, cfg.KeyFile)
	if err != nil {
		return nil, fmt.Errorf("mtls: load server cert/key: %w", err)
	}

	pem, err := os.ReadFile(cfg.CAFile)
	if err != nil {
		return nil, fmt.Errorf("mtls: read CA file: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("mtls: no valid certificates found in %s", cfg.CAFile)
	}

	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		ClientCAs:    pool,
		ClientAuth:   tls.RequireAndVerifyClientCert,
		MinVersion:   tls.VersionTLS12,
	}, nil
}
