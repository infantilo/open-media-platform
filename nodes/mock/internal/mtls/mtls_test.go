package mtls

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func generateSelfSignedCert(t *testing.T) (certPEM, keyPEM []byte) {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "test"},
		NotBefore:    time.Now(),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		t.Fatalf("create certificate: %v", err)
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyDER, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	return certPEM, keyPEM
}

func writeTempFiles(t *testing.T, certPEM, keyPEM []byte) (certFile, keyFile, caFile string) {
	t.Helper()
	dir := t.TempDir()
	certFile = filepath.Join(dir, "cert.pem")
	keyFile = filepath.Join(dir, "key.pem")
	caFile = filepath.Join(dir, "ca.pem")
	if err := os.WriteFile(certFile, certPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyFile, keyPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(caFile, certPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	return certFile, keyFile, caFile
}

func TestServerTLSConfigDisabledReturnsNil(t *testing.T) {
	got, err := ServerTLSConfig(Config{Enabled: false})
	if err != nil {
		t.Fatalf("ServerTLSConfig() error = %v, want nil", err)
	}
	if got != nil {
		t.Errorf("ServerTLSConfig() = %v, want nil when disabled", got)
	}
}

func TestServerTLSConfigRequiresAndVerifiesClientCert(t *testing.T) {
	certPEM, keyPEM := generateSelfSignedCert(t)
	certFile, keyFile, caFile := writeTempFiles(t, certPEM, keyPEM)

	got, err := ServerTLSConfig(Config{Enabled: true, CertFile: certFile, KeyFile: keyFile, CAFile: caFile})
	if err != nil {
		t.Fatalf("ServerTLSConfig() error = %v", err)
	}
	if got.ClientAuth != tls.RequireAndVerifyClientCert {
		t.Errorf("ClientAuth = %v, want RequireAndVerifyClientCert — an ohne Client-Zertifikat verbundener Aufrufer muss abgewiesen werden", got.ClientAuth)
	}
	if len(got.Certificates) != 1 {
		t.Errorf("Certificates = %d entries, want 1", len(got.Certificates))
	}
	if got.ClientCAs == nil {
		t.Error("ClientCAs is nil, want populated pool")
	}
}

func TestServerTLSConfigMissingCertFileErrors(t *testing.T) {
	certPEM, keyPEM := generateSelfSignedCert(t)
	_, _, caFile := writeTempFiles(t, certPEM, keyPEM)
	_, err := ServerTLSConfig(Config{Enabled: true, CertFile: "/no/such/file", KeyFile: "/no/such/file", CAFile: caFile})
	if err == nil {
		t.Fatal("ServerTLSConfig() error = nil, want error for missing cert file")
	}
}
