package main

import (
	"context"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestResolvePrimaryTrustsConfiguredCA(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"members":[{"name":"n1","role":"leader","port":5432}]}`))
	}))
	defer server.Close()
	nodes := []patroniNode{{container: "n1", restURL: server.URL}}

	t.Setenv("OMP_POSTGRES_PATRONI_CA_FILE", "")
	if _, _, err := resolvePrimary(context.Background(), nodes); err == nil {
		t.Fatal("unbekannte CA darf nicht angenommen werden")
	}
	ca := filepath.Join(t.TempDir(), "ca.crt")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OMP_POSTGRES_PATRONI_CA_FILE", ca)
	if name, port, err := resolvePrimary(context.Background(), nodes); err != nil || name != "n1" || port != 5432 {
		t.Fatalf("resolvePrimary() = %q, %d, %v", name, port, err)
	}
}
