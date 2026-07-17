package config

import "testing"

func TestLoadDefaults(t *testing.T) {
	t.Setenv("OMP_LISTEN", "")
	t.Setenv("OMP_REGISTRY_URL", "")
	t.Setenv("OMP_NATS_URL", "")
	t.Setenv("OMP_UI_DIR", "")
	t.Setenv("OMP_DATA_DIR", "")
	t.Setenv("OMP_CATALOG_PATH", "")
	t.Setenv("OMP_POSTGRES_URL", "")
	t.Setenv("OMP_MTLS_ENABLED", "")
	t.Setenv("OMP_MTLS_CERT_FILE", "")
	t.Setenv("OMP_MTLS_KEY_FILE", "")
	t.Setenv("OMP_MTLS_CA_FILE", "")
	t.Setenv("OMP_AUDIT_RETENTION_DAYS", "")

	cfg := Load()

	if cfg.Listen != ":8000" {
		t.Errorf("Listen = %q, want %q", cfg.Listen, ":8000")
	}
	if cfg.RegistryURL != "http://localhost:8010" {
		t.Errorf("RegistryURL = %q, want %q", cfg.RegistryURL, "http://localhost:8010")
	}
	if cfg.NatsURL != "nats://localhost:4222" {
		t.Errorf("NatsURL = %q, want %q", cfg.NatsURL, "nats://localhost:4222")
	}
	if cfg.UIDir != "../ui" {
		t.Errorf("UIDir = %q, want %q", cfg.UIDir, "../ui")
	}
	if cfg.DataDir != "../data" {
		t.Errorf("DataDir = %q, want %q", cfg.DataDir, "../data")
	}
	if cfg.CatalogPath != "../deploy/catalog.json" {
		t.Errorf("CatalogPath = %q, want %q", cfg.CatalogPath, "../deploy/catalog.json")
	}
	if want := "postgres://omp:omp@localhost:5432/omp?sslmode=disable"; cfg.PostgresURL != want {
		t.Errorf("PostgresURL = %q, want %q", cfg.PostgresURL, want)
	}
	if cfg.MTLSEnabled {
		t.Error("MTLSEnabled = true, want false (opt-in, must default off)")
	}
	if cfg.MTLSCertFile != "../.run/mtls/orchestrator.crt" {
		t.Errorf("MTLSCertFile = %q, want %q", cfg.MTLSCertFile, "../.run/mtls/orchestrator.crt")
	}
	if cfg.MTLSKeyFile != "../.run/mtls/orchestrator.key" {
		t.Errorf("MTLSKeyFile = %q, want %q", cfg.MTLSKeyFile, "../.run/mtls/orchestrator.key")
	}
	if cfg.MTLSCAFile != "../.run/mtls/root_ca.crt" {
		t.Errorf("MTLSCAFile = %q, want %q", cfg.MTLSCAFile, "../.run/mtls/root_ca.crt")
	}
	if cfg.AuditRetentionDays != 90 {
		t.Errorf("AuditRetentionDays = %d, want 90", cfg.AuditRetentionDays)
	}
}

func TestLoadOverrides(t *testing.T) {
	t.Setenv("OMP_LISTEN", ":9000")
	t.Setenv("OMP_REGISTRY_URL", "http://registry.example:8010")
	t.Setenv("OMP_NATS_URL", "nats://nats.example:4222")
	t.Setenv("OMP_UI_DIR", "/srv/omp/ui")
	t.Setenv("OMP_DATA_DIR", "/srv/omp/data")
	t.Setenv("OMP_CATALOG_PATH", "/srv/omp/catalog.json")
	t.Setenv("OMP_POSTGRES_URL", "postgres://user:pw@db.example:5432/omp")
	t.Setenv("OMP_MTLS_ENABLED", "true")
	t.Setenv("OMP_MTLS_CERT_FILE", "/srv/omp/mtls/o.crt")
	t.Setenv("OMP_MTLS_KEY_FILE", "/srv/omp/mtls/o.key")
	t.Setenv("OMP_MTLS_CA_FILE", "/srv/omp/mtls/ca.crt")
	t.Setenv("OMP_AUDIT_RETENTION_DAYS", "30")

	cfg := Load()

	if cfg.Listen != ":9000" {
		t.Errorf("Listen = %q, want %q", cfg.Listen, ":9000")
	}
	if cfg.RegistryURL != "http://registry.example:8010" {
		t.Errorf("RegistryURL = %q, want %q", cfg.RegistryURL, "http://registry.example:8010")
	}
	if cfg.NatsURL != "nats://nats.example:4222" {
		t.Errorf("NatsURL = %q, want %q", cfg.NatsURL, "nats://nats.example:4222")
	}
	if cfg.UIDir != "/srv/omp/ui" {
		t.Errorf("UIDir = %q, want %q", cfg.UIDir, "/srv/omp/ui")
	}
	if cfg.DataDir != "/srv/omp/data" {
		t.Errorf("DataDir = %q, want %q", cfg.DataDir, "/srv/omp/data")
	}
	if cfg.CatalogPath != "/srv/omp/catalog.json" {
		t.Errorf("CatalogPath = %q, want %q", cfg.CatalogPath, "/srv/omp/catalog.json")
	}
	if want := "postgres://user:pw@db.example:5432/omp"; cfg.PostgresURL != want {
		t.Errorf("PostgresURL = %q, want %q", cfg.PostgresURL, want)
	}
	if !cfg.MTLSEnabled {
		t.Error("MTLSEnabled = false, want true")
	}
	if cfg.MTLSCertFile != "/srv/omp/mtls/o.crt" {
		t.Errorf("MTLSCertFile = %q, want %q", cfg.MTLSCertFile, "/srv/omp/mtls/o.crt")
	}
	if cfg.MTLSKeyFile != "/srv/omp/mtls/o.key" {
		t.Errorf("MTLSKeyFile = %q, want %q", cfg.MTLSKeyFile, "/srv/omp/mtls/o.key")
	}
	if cfg.MTLSCAFile != "/srv/omp/mtls/ca.crt" {
		t.Errorf("MTLSCAFile = %q, want %q", cfg.MTLSCAFile, "/srv/omp/mtls/ca.crt")
	}
	if cfg.AuditRetentionDays != 30 {
		t.Errorf("AuditRetentionDays = %d, want 30", cfg.AuditRetentionDays)
	}
}
