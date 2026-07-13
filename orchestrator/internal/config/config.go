// Package config lädt die Orchestrator-Konfiguration aus Umgebungsvariablen.
package config

import "os"

// Config bündelt die zur Laufzeit veränderbaren Einstellungen des
// Orchestrators. Alle Felder haben sinnvolle Defaults für den lokalen
// Dev-Betrieb (siehe Load).
type Config struct {
	// Listen ist die Adresse, auf der der HTTP-Server lauscht (net/http-Syntax).
	Listen string
	// RegistryURL zeigt auf die NMOS-Registry (IS-04 Query/Registration API).
	RegistryURL string
	// NatsURL zeigt auf den NATS-Event-Bus.
	NatsURL string
	// UIDir ist das Verzeichnis, aus dem die UI-Shell statisch ausgeliefert wird.
	UIDir string
	// DataDir ist das Verzeichnis für persistente Orchestrator-Daten
	// (aktuell: Layouts, B5, Instanz-Launcher-Zustand, C8) — Datei-
	// Backend, bis PostgreSQL in Phase D (D1) übernimmt.
	DataDir string
	// CatalogPath zeigt auf die Katalog-Datei des Instanz-Launchers
	// (UMSETZUNG.md C8) — Node-Typen, die sich aus der GUI heraus
	// starten lassen.
	CatalogPath string
	// PostgresURL ist die Verbindungs-DSN für Layouts/Snapshots
	// (UMSETZUNG.md D1, ARCHITECTURE.md §4.4) — ersetzt das bisherige
	// Datei-Backend unterhalb von DataDir für genau diese zwei Stores.
	// DataDir bleibt für den Instanz-Launcher-Zustand (C8, PID-gebundene
	// Laufzeit-Bookkeeping, kein Metadaten-Persistenz-Fall) und
	// role-bindings.json (handgepflegt wie deploy/catalog.json, C13)
	// unverändert bestehen — Begründung siehe docs/decisions.md D1.
	PostgresURL string
}

// Load liest die Konfiguration aus den Umgebungsvariablen OMP_LISTEN,
// OMP_REGISTRY_URL, OMP_NATS_URL, OMP_UI_DIR, OMP_DATA_DIR,
// OMP_CATALOG_PATH und OMP_POSTGRES_URL; fehlende Werte fallen auf
// Defaults für den lokalen Dev-Betrieb zurück (Registry/NATS-Ports aus
// UMSETZUNG.md A2/A3, Postgres-Port aus D1, alle Pfade relativ zum
// orchestrator/-Arbeitsverzeichnis).
func Load() Config {
	return Config{
		Listen:      getEnv("OMP_LISTEN", ":8000"),
		RegistryURL: getEnv("OMP_REGISTRY_URL", "http://localhost:8010"),
		NatsURL:     getEnv("OMP_NATS_URL", "nats://localhost:4222"),
		UIDir:       getEnv("OMP_UI_DIR", "../ui"),
		DataDir:     getEnv("OMP_DATA_DIR", "../data"),
		CatalogPath: getEnv("OMP_CATALOG_PATH", "../deploy/catalog.json"),
		PostgresURL: getEnv("OMP_POSTGRES_URL", "postgres://omp:omp@localhost:5432/omp?sslmode=disable"),
	}
}

func getEnv(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}
