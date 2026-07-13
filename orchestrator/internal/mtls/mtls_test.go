package mtls

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// generateSelfSignedCert erzeugt ein PEM-Cert+Key-Paar für Tests (keine
// echte CA nötig — ClientTLSConfig lädt nur das Dateipaar, prüft nicht
// gegen eine Kette).
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

func TestClientTLSConfigDisabledReturnsNil(t *testing.T) {
	got, err := ClientTLSConfig(Config{Enabled: false})
	if err != nil {
		t.Fatalf("ClientTLSConfig() error = %v, want nil", err)
	}
	if got != nil {
		t.Errorf("ClientTLSConfig() = %v, want nil when disabled", got)
	}
}

func TestClientTLSConfigLoadsCertAndCAPool(t *testing.T) {
	certPEM, keyPEM := generateSelfSignedCert(t)
	certFile, keyFile, caFile := writeTempFiles(t, certPEM, keyPEM)

	got, err := ClientTLSConfig(Config{Enabled: true, CertFile: certFile, KeyFile: keyFile, CAFile: caFile})
	if err != nil {
		t.Fatalf("ClientTLSConfig() error = %v", err)
	}
	if len(got.Certificates) != 1 {
		t.Errorf("Certificates = %d entries, want 1", len(got.Certificates))
	}
	if got.RootCAs == nil {
		t.Error("RootCAs is nil, want populated pool")
	}
}

func TestClientTLSConfigMissingCertFileErrors(t *testing.T) {
	certPEM, keyPEM := generateSelfSignedCert(t)
	_, _, caFile := writeTempFiles(t, certPEM, keyPEM)
	_, err := ClientTLSConfig(Config{Enabled: true, CertFile: "/no/such/file", KeyFile: "/no/such/file", CAFile: caFile})
	if err == nil {
		t.Fatal("ClientTLSConfig() error = nil, want error for missing cert file")
	}
}

func TestClientTLSConfigInvalidCAFileErrors(t *testing.T) {
	certPEM, keyPEM := generateSelfSignedCert(t)
	certFile, keyFile, _ := writeTempFiles(t, certPEM, keyPEM)
	dir := t.TempDir()
	badCA := filepath.Join(dir, "bad-ca.pem")
	if err := os.WriteFile(badCA, []byte("not a cert"), 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := ClientTLSConfig(Config{Enabled: true, CertFile: certFile, KeyFile: keyFile, CAFile: badCA})
	if err == nil {
		t.Fatal("ClientTLSConfig() error = nil, want error for invalid CA file")
	}
}
