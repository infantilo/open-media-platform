// Package config lädt die Orchestrator-Konfiguration aus Umgebungsvariablen.
package config

import (
	"os"
	"strconv"
)

// defaultNatsURL zeigt auf den per `make up` gestarteten Drei-Knoten-
// NATS-Cluster (ARCHITECTURE.md §19.3 Punkt 7, UMSETZUNG.md D14) —
// Ports/Adressen exakt wie in `Makefile`s `up`-Target (Client-Ports
// 4222/4223/4224). `nats.go` teilt die kommagetrennte Liste selbst auf.
const defaultNatsURL = "nats://localhost:4222,nats://localhost:4223,nats://localhost:4224"

// Config bündelt die zur Laufzeit veränderbaren Einstellungen des
// Orchestrators. Alle Felder haben sinnvolle Defaults für den lokalen
// Dev-Betrieb (siehe Load).
type Config struct {
	// Listen ist die Adresse, auf der der HTTP-Server lauscht (net/http-Syntax).
	Listen string
	// RegistryURL zeigt auf die NMOS-Registry (IS-04 Query/Registration API).
	RegistryURL string
	// OrchestratorURL ist die von gestarteten Instanzen erreichbare
	// Basis-URL des Orchestrators selbst (ARCHITECTURE.md §24.1,
	// UMSETZUNG.md C16) — genutzt von Control-Plane-Nodes
	// (z. B. omp-playout-automation), die den generischen Node-Proxy
	// (A8) statt eines direkten Node-zu-Node-Zugriffs ansprechen sollen.
	// Gleiches Muster wie RegistryURL: vom Launcher an jede gestartete
	// Instanz als OMP_ORCHESTRATOR_URL durchgereicht.
	OrchestratorURL string
	// NatsURL zeigt auf den NATS-Event-Bus — seit D14 (ARCHITECTURE.md
	// §19.3 Punkt 7, NATS-Clustering) im Default eine kommagetrennte
	// Liste aller drei Dev-Cluster-Knoten statt einer einzelnen Adresse.
	// `nats.go` teilt eine solche Liste selbst auf (`processUrlString`)
	// und wählt/failt automatisch zwischen den Servern um — kein
	// Code-Unterschied zum Ein-Knoten-Fall nötig, nur der Wert ändert
	// sich. Ein einzelner Eintrag (kein Komma) funktioniert unverändert.
	NatsURL string
	// UIDir ist das Verzeichnis, aus dem die UI-Shell statisch ausgeliefert wird.
	UIDir string
	// CatalogPath zeigt auf die Katalog-Datei des Instanz-Launchers
	// (UMSETZUNG.md C8) — Node-Typen, die sich aus der GUI heraus
	// starten lassen.
	CatalogPath string
	// PostgresURL ist die Verbindungs-DSN für Layouts/Snapshots
	// (UMSETZUNG.md D1, ARCHITECTURE.md §4.4) sowie seit S4
	// (docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md) den Instanz-Launcher-
	// Zustand (vorher data/instances.json, C8) — kein separates DataDir
	// mehr nötig, dieses Feld wurde mit S4 entfernt (nichts referenzierte
	// es mehr; role-bindings.json war bereits mit D3 Teil 2 durch die
	// authz-Tabelle ersetzt).
	PostgresURL string
	// MTLSEnabled schaltet mTLS zwischen Orchestrator und Nodes ein
	// (UMSETZUNG.md D3, ARCHITECTURE.md §4.6) — Default **aus**, bewusst
	// additiv: ohne gesetztes OMP_MTLS_ENABLED verhält sich der
	// Orchestrator exakt wie vor D3 (reines HTTP, keine Zertifikate
	// nötig). Betrifft nur die Orchestrator→Node-Richtung (generischer
	// Proxy, IS-05-Client, Snapshot-Node-Client) — die vom Browser
	// erreichte Orchestrator-API selbst bleibt unverändert (das ist
	// IS-10/OAuth2-Scope, nicht Teil dieses Schritts, s.
	// docs/decisions.md D3).
	MTLSEnabled bool
	// MTLSCertFile/MTLSKeyFile sind das eigene Client-Zertifikat des
	// Orchestrators (von step-ca ausgestellt, deploy/dev/mtls-issue-
	// cert.sh); MTLSCAFile ist das Root-CA-Zertifikat, gegen das
	// Node-Server-Zertifikate verifiziert werden.
	MTLSCertFile string
	MTLSKeyFile  string
	MTLSCAFile   string
	// JWTSecret ist ein direkt gesetztes HMAC-Secret für die
	// Token-Signierung (UMSETZUNG.md D3 Teil 2) — für echte Deployments,
	// die ein Secret aus einer eigenen Verwaltung (Vault, K8s-Secret, …)
	// einspeisen wollen. Leer im Dev-Default: dann greift
	// JWTSecretFile.
	JWTSecret string
	// JWTSecretFile ist der Pfad, unter dem der Orchestrator ein
	// automatisch generiertes Token-Secret persistiert, falls JWTSecret
	// leer ist (auth.LoadOrCreateSecret) — Zero-Config-Dev-Default,
	// gleiches Muster wie CatalogPath.
	JWTSecretFile string
	// PlacementCPUThreshold/PlacementMemThreshold (Prozent) markieren
	// einen Host mit laufenden Instanzen als überlastet (ARCHITECTURE.md
	// §6.1, UMSETZUNG.md D6 Teil 3 — erste, advisory-only Ausbaustufe).
	// PlacementHealthyCPUThreshold/PlacementHealthyMemThreshold legen
	// fest, ab wann ein anderer Host als Ausweichziel vorgeschlagen wird
	// (bewusst mit Abstand unter den Alarm-Schwellwerten, s.
	// placement.Thresholds-Doku).
	PlacementCPUThreshold        float64
	PlacementMemThreshold        float64
	PlacementHealthyCPUThreshold float64
	PlacementHealthyMemThreshold float64
	// AuditRetentionDays ist die Aufbewahrungsdauer des Audit-Logs (S5,
	// docs/REVIEW-2026-07-17-SKALIERUNG-24-7.md) — audit.Store.RunRetention
	// löscht täglich Zeilen, die älter sind. <= 0 deaktiviert die
	// Löschung (s. audit.Store.PurgeOlderThan).
	AuditRetentionDays int
	// BackupDir/PostgresContainer/BackupKeep (Nutzerwunsch 2026-08-13:
	// Backup über das Browser-UI) — spiegeln exakt deploy/dev/
	// backup-omp.shs BACKUP_DIR/Container-Name/BACKUP_KEEP, beide Wege
	// teilen sich denselben Ordner und dieselbe Rotation. Default relativ
	// zum orchestrator/-Arbeitsverzeichnis (Dev-Fallback, gleiches Muster
	// wie UIDir/CatalogPath oben) — start-omp.sh exportiert den
	// tatsächlichen absoluten Pfad.
	BackupDir         string
	PostgresContainer string
	BackupKeep        int
	// SupervisorURL zeigt auf den eigenständigen Backup/Restore-
	// Supervisor-Prozess (supervisor/main.go, Nutzerwunsch 2026-08-13) —
	// lauscht nur auf 127.0.0.1, s. dessen Kopfkommentar zur
	// Vertrauensgrenze.
	SupervisorURL string
	// ClusterNodeID/ClusterRaftAddr/ClusterDataDir/ClusterPeers steuern
	// die Raft-Konsens-Schicht zwischen Orchestrator-Instanzen
	// (ARCHITECTURE.md §19.3, UMSETZUNG.md D12) — läuft immer (kein
	// Ein-/Ausschalter wie MTLSEnabled: ein Ein-Knoten-Cluster IST der
	// Normalfall, s. cluster.Config-Doku), nicht optional wie mTLS.
	// ClusterPeers leer bedeutet Ein-Knoten-Cluster (heutiges
	// Single-Host-Dev-Verhalten unverändert); gesetzt bedeutet
	// statisches Gründungs-Bootstrap mit dieser Mitgliederliste (D12
	// Teil 1). ClusterJoin (D12 Teil 2) ist das Gegenteil von
	// ClusterPeers-Bootstrap: statt sich selbst zu bootstrappen, wartet
	// die Instanz passiv, bis eine bestehende Leader-Instanz sie per
	// POST /api/v1/cluster/join aufnimmt (Operator-Aktion, s.
	// cluster.Config.SkipBootstrap-Doku) — beide Felder ergeben nur
	// gemeinsam Sinn, wenn ClusterJoin true ist, ist ClusterPeers
	// wirkungslos (New() bootstrapt dann gar nicht).
	ClusterNodeID   string
	ClusterRaftAddr string
	ClusterDataDir  string
	ClusterPeers    string
	ClusterJoin     bool
}

// Load liest die Konfiguration aus den Umgebungsvariablen OMP_LISTEN,
// OMP_ORCHESTRATOR_URL, OMP_REGISTRY_URL, OMP_NATS_URL, OMP_UI_DIR,
// OMP_CATALOG_PATH, OMP_POSTGRES_URL, OMP_MTLS_*, OMP_AUTH_JWT_*,
// OMP_PLACEMENT_*, OMP_AUDIT_RETENTION_DAYS, OMP_BACKUP_DIR/
// OMP_POSTGRES_CONTAINER/OMP_BACKUP_KEEP und OMP_NODE_ID/
// OMP_RAFT_LISTEN/OMP_RAFT_DATA_DIR/OMP_CLUSTER_PEERS/OMP_CLUSTER_JOIN
// (ARCHITECTURE.md §19.3, UMSETZUNG.md D12); fehlende Werte
// fallen auf Defaults für den lokalen Dev-Betrieb zurück (Registry/
// NATS-Ports aus UMSETZUNG.md A2/A3, Postgres-Port aus D1, alle Pfade
// relativ zum orchestrator/-Arbeitsverzeichnis).
func Load() Config {
	mtlsEnabled, _ := strconv.ParseBool(getEnv("OMP_MTLS_ENABLED", "false"))
	// ClusterNodeID zuerst aufgelöst, weil ClusterDataDirs Default davon
	// abhängt (../data/raft/<nodeID> statt eines von OMP_NODE_ID
	// unabhängigen fixen Pfades — sonst würden zwei Instanzen mit
	// unterschiedlichem OMP_NODE_ID, aber ohne explizit gesetztem
	// OMP_RAFT_DATA_DIR, versehentlich denselben Log/Snapshot-Ordner
	// teilen).
	clusterNodeID := getEnv("OMP_NODE_ID", "node-1")
	clusterJoin, _ := strconv.ParseBool(getEnv("OMP_CLUSTER_JOIN", "false"))
	return Config{
		Listen:          getEnv("OMP_LISTEN", ":8000"),
		OrchestratorURL: getEnv("OMP_ORCHESTRATOR_URL", "http://localhost:8000"),
		RegistryURL:     getEnv("OMP_REGISTRY_URL", "http://localhost:8010"),
		NatsURL:         getEnv("OMP_NATS_URL", defaultNatsURL),
		UIDir:           getEnv("OMP_UI_DIR", "../ui"),
		CatalogPath:     getEnv("OMP_CATALOG_PATH", "../deploy/catalog.json"),
		PostgresURL:     getEnv("OMP_POSTGRES_URL", "postgres://omp:omp@localhost:5432/omp?sslmode=disable"),
		MTLSEnabled:     mtlsEnabled,
		MTLSCertFile:    getEnv("OMP_MTLS_CERT_FILE", "../.run/mtls/orchestrator.crt"),
		MTLSKeyFile:     getEnv("OMP_MTLS_KEY_FILE", "../.run/mtls/orchestrator.key"),
		MTLSCAFile:      getEnv("OMP_MTLS_CA_FILE", "../.run/mtls/root_ca.crt"),
		JWTSecret:       getEnv("OMP_AUTH_JWT_SECRET", ""),
		JWTSecretFile:   getEnv("OMP_AUTH_JWT_SECRET_FILE", "../data/auth-jwt-secret"),
		// Defaults spiegeln placement.DefaultThresholds (bewusst hier
		// dupliziert statt importiert, config bleibt frei von
		// Business-Logik-Abhängigkeiten, gleiches Muster wie die
		// remoteCommand-Duplikation zwischen launcher und host-agent).
		PlacementCPUThreshold:        getEnvFloat("OMP_PLACEMENT_CPU_THRESHOLD", 85),
		PlacementMemThreshold:        getEnvFloat("OMP_PLACEMENT_MEM_THRESHOLD", 90),
		PlacementHealthyCPUThreshold: getEnvFloat("OMP_PLACEMENT_HEALTHY_CPU_THRESHOLD", 60),
		PlacementHealthyMemThreshold: getEnvFloat("OMP_PLACEMENT_HEALTHY_MEM_THRESHOLD", 70),
		// Default spiegelt audit.DefaultRetentionDays (bewusst hier
		// dupliziert statt importiert, gleiches Muster wie die
		// Placement-Defaults oben — config bleibt frei von
		// Business-Logik-Abhängigkeiten).
		AuditRetentionDays: getEnvInt("OMP_AUDIT_RETENTION_DAYS", 90),
		BackupDir:          getEnv("OMP_BACKUP_DIR", "../.backups"),
		PostgresContainer:  getEnv("OMP_POSTGRES_CONTAINER", "omp-postgres"),
		// Default spiegelt backup-omp.shs BACKUP_KEEP=14 (bewusst hier
		// dupliziert statt importiert, gleiches Muster wie die
		// Placement-/Audit-Defaults oben).
		BackupKeep:    getEnvInt("OMP_BACKUP_KEEP", 14),
		SupervisorURL: getEnv("OMP_SUPERVISOR_URL", "http://127.0.0.1:8091"),
		// Defaults ergeben einen einzelnen Ein-Knoten-Cluster auf einer
		// unbenutzten lokalen Adresse — identisch zum heutigen
		// Single-Host-Dev-Verhalten, solange nicht mehrere Instanzen
		// gleichzeitig gestartet werden (dann müssen alle drei
		// OMP_CLUSTER_*-Werte pro Instanz eindeutig gesetzt werden, s.
		// UMSETZUNG.md D12 Teil 1 Verifikation).
		ClusterNodeID:   clusterNodeID,
		ClusterRaftAddr: getEnv("OMP_RAFT_LISTEN", "127.0.0.1:8300"),
		ClusterDataDir:  getEnv("OMP_RAFT_DATA_DIR", "../data/raft/"+clusterNodeID),
		ClusterPeers:    getEnv("OMP_CLUSTER_PEERS", ""),
		ClusterJoin:     clusterJoin,
	}
}

func getEnv(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}

func getEnvFloat(key string, fallback float64) float64 {
	v, ok := os.LookupEnv(key)
	if !ok || v == "" {
		return fallback
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return fallback
	}
	return f
}

func getEnvInt(key string, fallback int) int {
	v, ok := os.LookupEnv(key)
	if !ok || v == "" {
		return fallback
	}
	i, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return i
}
