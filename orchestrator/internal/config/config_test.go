package config

import "testing"

func TestLoadDefaults(t *testing.T) {
	t.Setenv("OMP_LISTEN", "")
	t.Setenv("OMP_REGISTRY_URL", "")
	t.Setenv("OMP_NATS_URL", "")
	t.Setenv("OMP_UI_DIR", "")

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
}

func TestLoadOverrides(t *testing.T) {
	t.Setenv("OMP_LISTEN", ":9000")
	t.Setenv("OMP_REGISTRY_URL", "http://registry.example:8010")
	t.Setenv("OMP_NATS_URL", "nats://nats.example:4222")
	t.Setenv("OMP_UI_DIR", "/srv/omp/ui")

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
}
