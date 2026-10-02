// Package runtimesettings macht die Betriebswerte des Orchestrators (Aufbewahrung,
// Platzierungs-Schwellwerte, Backup-Anzahl) über die UI einstellbar (Kapitel 29).
// Die Werte liegen in Postgres und überschreiben beim Start die Umgebungsvariablen
// bzw. Defaults aus config.Load; sie wirken nach dem nächsten Neustart des
// Orchestrators (die Verbraucher lesen ihre Werte einmal beim Start).
//
// Bewusst NICHT hier: Geheimnisse und Infrastruktur (JWT-Secret, TLS-/mTLS-Dateien,
// Datenbank-/NATS-URL, Update-Schalter) — sie sind Start-Konfiguration; eine falsche
// Eingabe würde den Zugang zur UI selbst sperren. Sie erscheinen nur lesend
// (siehe StartupInfo, Geheimnisse maskiert).
package runtimesettings

import (
	"database/sql"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/config"
)

// Def beschreibt eine einstellbare Betriebsgröße.
type Def struct {
	Key         string  `json:"key"` // Name der Umgebungsvariable
	Label       string  `json:"label"`
	Description string  `json:"description"`
	Group       string  `json:"group"`
	Unit        string  `json:"unit,omitempty"`
	Min         float64 `json:"min"`
	Max         float64 `json:"max"`
	Integer     bool    `json:"integer"`

	get func(c *config.Config) float64
	set func(c *config.Config, v float64)
}

// Value formatiert den aktuellen Wert aus c.
func (d Def) Value(c *config.Config) string { return format(d.get(c), d.Integer) }

func format(v float64, integer bool) string {
	if integer {
		return strconv.FormatInt(int64(v), 10)
	}
	return strconv.FormatFloat(v, 'f', -1, 64)
}

func intDef(key, label, desc, group, unit string, min, max float64, get func(*config.Config) int, set func(*config.Config, int)) Def {
	return Def{Key: key, Label: label, Description: desc, Group: group, Unit: unit, Min: min, Max: max, Integer: true,
		get: func(c *config.Config) float64 { return float64(get(c)) },
		set: func(c *config.Config, v float64) { set(c, int(v)) }}
}

func pctDef(key, label, desc string, get func(*config.Config) float64, set func(*config.Config, float64)) Def {
	return Def{Key: key, Label: label, Description: desc, Group: "Platzierung (Auslastungs-Schwellwerte)", Unit: "%", Min: 1, Max: 100, get: get, set: set}
}

const (
	groupRetention = "Aufbewahrung"
	groupBackup    = "Backup"
)

// Defs sind alle einstellbaren Betriebswerte (stabile Reihenfolge).
var Defs = []Def{
	intDef("OMP_AUDIT_RETENTION_DAYS", "Audit-Log", "Wie lange Audit-Einträge (und Domänen-Audit) aufbewahrt werden. 0 = nie löschen.", groupRetention, "Tage", 0, 3650,
		func(c *config.Config) int { return c.AuditRetentionDays }, func(c *config.Config, v int) { c.AuditRetentionDays = v }),
	intDef("OMP_LOG_RETENTION_HOURS", "Zentrales Log", "Aufbewahrung des zentralen Logs (Stunden statt Tage, das Volumen ist groß). 0 = nie löschen.", groupRetention, "Stunden", 0, 8760,
		func(c *config.Config) int { return c.LogRetentionHours }, func(c *config.Config, v int) { c.LogRetentionHours = v }),
	intDef("OMP_WORKFLOW_RUN_RETENTION_DAYS", "Workflow-Läufe", "Aufbewahrung der Lauf-Historie der Workflows.", groupRetention, "Tage", 1, 3650,
		func(c *config.Config) int { return c.WorkflowRunRetentionDays }, func(c *config.Config, v int) { c.WorkflowRunRetentionDays = v }),
	intDef("OMP_OUTBOX_RETENTION_DAYS", "Ereignis-Outbox", "Aufbewahrung zugestellter Ereignisse der Outbox.", groupRetention, "Tage", 1, 365,
		func(c *config.Config) int { return c.OutboxRetentionDays }, func(c *config.Config, v int) { c.OutboxRetentionDays = v }),
	intDef("OMP_HOST_TOKEN_RETENTION_DAYS", "Host-Tokens", "Aufbewahrung abgelaufener Host-Agent-Tokens.", groupRetention, "Tage", 1, 365,
		func(c *config.Config) int { return c.HostTokenRetentionDays }, func(c *config.Config, v int) { c.HostTokenRetentionDays = v }),
	intDef("OMP_PROCESS_EXECUTION_RETENTION_DAYS", "Prozess-Ausführungen", "Aufbewahrung der Ausführungs-Historie der Prozess-Engine.", groupRetention, "Tage", 1, 3650,
		func(c *config.Config) int { return c.ProcessExecutionRetentionDays }, func(c *config.Config, v int) { c.ProcessExecutionRetentionDays = v }),
	intDef("OMP_BACKUP_KEEP", "Anzahl Backups", "Wie viele Datenbank-Backups behalten werden; ältere werden beim Anlegen eines neuen gelöscht.", groupBackup, "Stück", 1, 1000,
		func(c *config.Config) int { return c.BackupKeep }, func(c *config.Config, v int) { c.BackupKeep = v }),
	pctDef("OMP_PLACEMENT_CPU_THRESHOLD", "CPU — überlastet ab", "Ein Host gilt ab dieser CPU-Auslastung als überlastet (kein Ziel für neue Instanzen).",
		func(c *config.Config) float64 { return c.PlacementCPUThreshold }, func(c *config.Config, v float64) { c.PlacementCPUThreshold = v }),
	pctDef("OMP_PLACEMENT_HEALTHY_CPU_THRESHOLD", "CPU — gesund bis", "Unterhalb dieser CPU-Auslastung gilt ein Host als gesund (bevorzugtes Ziel).",
		func(c *config.Config) float64 { return c.PlacementHealthyCPUThreshold }, func(c *config.Config, v float64) { c.PlacementHealthyCPUThreshold = v }),
	pctDef("OMP_PLACEMENT_MEM_THRESHOLD", "RAM — überlastet ab", "Ein Host gilt ab dieser RAM-Auslastung als überlastet.",
		func(c *config.Config) float64 { return c.PlacementMemThreshold }, func(c *config.Config, v float64) { c.PlacementMemThreshold = v }),
	pctDef("OMP_PLACEMENT_HEALTHY_MEM_THRESHOLD", "RAM — gesund bis", "Unterhalb dieser RAM-Auslastung gilt ein Host als gesund.",
		func(c *config.Config) float64 { return c.PlacementHealthyMemThreshold }, func(c *config.Config, v float64) { c.PlacementHealthyMemThreshold = v }),
	pctDef("OMP_PLACEMENT_NET_THRESHOLD", "Netz — überlastet ab", "Ein Host gilt ab dieser Netz-Auslastung (Anteil der Kartenbandbreite) als überlastet.",
		func(c *config.Config) float64 { return c.PlacementNetThreshold }, func(c *config.Config, v float64) { c.PlacementNetThreshold = v }),
	pctDef("OMP_PLACEMENT_HEALTHY_NET_THRESHOLD", "Netz — gesund bis", "Unterhalb dieser Netz-Auslastung gilt ein Host als gesund.",
		func(c *config.Config) float64 { return c.PlacementHealthyNetThreshold }, func(c *config.Config, v float64) { c.PlacementHealthyNetThreshold = v }),
	pctDef("OMP_PLACEMENT_GPU_THRESHOLD", "GPU — überlastet ab", "Ein Host gilt ab dieser GPU-Auslastung als überlastet.",
		func(c *config.Config) float64 { return c.PlacementGpuThreshold }, func(c *config.Config, v float64) { c.PlacementGpuThreshold = v }),
	pctDef("OMP_PLACEMENT_HEALTHY_GPU_THRESHOLD", "GPU — gesund bis", "Unterhalb dieser GPU-Auslastung gilt ein Host als gesund.",
		func(c *config.Config) float64 { return c.PlacementHealthyGpuThreshold }, func(c *config.Config, v float64) { c.PlacementHealthyGpuThreshold = v }),
}

// Find sucht eine Definition.
func Find(key string) (Def, bool) {
	for _, d := range Defs {
		if d.Key == key {
			return d, true
		}
	}
	return Def{}, false
}

// Parse prüft einen Eingabewert gegen die Definition.
func (d Def) Parse(raw string) (float64, error) {
	raw = strings.TrimSpace(raw)
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return 0, fmt.Errorf("%s: „%s“ ist keine Zahl", d.Label, raw)
	}
	if d.Integer && v != float64(int64(v)) {
		return 0, fmt.Errorf("%s: ganze Zahl erwartet", d.Label)
	}
	if v < d.Min || v > d.Max {
		return 0, fmt.Errorf("%s: erlaubt sind %v–%v%s", d.Label, d.Min, d.Max, unitSuffix(d.Unit))
	}
	return v, nil
}

func unitSuffix(u string) string {
	if u == "" {
		return ""
	}
	return " " + u
}

// CheckConsistency prüft Beziehungen zwischen Werten (gesund < überlastet).
func CheckConsistency(c *config.Config) error {
	pairs := [][2]string{
		{"OMP_PLACEMENT_HEALTHY_CPU_THRESHOLD", "OMP_PLACEMENT_CPU_THRESHOLD"},
		{"OMP_PLACEMENT_HEALTHY_MEM_THRESHOLD", "OMP_PLACEMENT_MEM_THRESHOLD"},
		{"OMP_PLACEMENT_HEALTHY_NET_THRESHOLD", "OMP_PLACEMENT_NET_THRESHOLD"},
		{"OMP_PLACEMENT_HEALTHY_GPU_THRESHOLD", "OMP_PLACEMENT_GPU_THRESHOLD"},
	}
	for _, p := range pairs {
		h, _ := Find(p[0])
		o, _ := Find(p[1])
		if h.get(c) >= o.get(c) {
			return fmt.Errorf("„%s“ (%s %%) muss kleiner sein als „%s“ (%s %%)", h.Label, h.Value(c), o.Label, o.Value(c))
		}
	}
	return nil
}

// Store speichert die Überschreibungen (Tabelle orchestrator_settings).
type Store struct{ db *sql.DB }

// NewStore erstellt den Speicher auf einer migrierten Datenbank.
func NewStore(db *sql.DB) *Store { return &Store{db: db} }

// Overrides liefert alle gespeicherten Werte (Schlüssel → Wert).
func (s *Store) Overrides() (map[string]string, error) {
	rows, err := s.db.Query(`SELECT key, value FROM orchestrator_settings`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

// Set speichert einen Wert; "" löscht die Überschreibung (zurück zu Umgebung/Default).
func (s *Store) Set(key, value, by string) error {
	if value == "" {
		_, err := s.db.Exec(`DELETE FROM orchestrator_settings WHERE key = $1`, key)
		return err
	}
	_, err := s.db.Exec(
		`INSERT INTO orchestrator_settings (key, value, updated_by) VALUES ($1, $2, $3)
		 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
		key, value, by)
	return err
}

// Apply überschreibt c mit den gespeicherten Werten. Ungültige/unbekannte Einträge
// (z. B. nach einer Änderung der Grenzen) werden übersprungen und gemeldet, nie
// angewendet — der Start geht vor. Ergibt die Kombination einen Widerspruch
// (gesund ≥ überlastet), werden ALLE Überschreibungen verworfen.
func Apply(c *config.Config, overrides map[string]string) (skipped []string) {
	original := *c
	keys := make([]string, 0, len(overrides))
	for k := range overrides {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		d, ok := Find(k)
		if !ok {
			skipped = append(skipped, k+": unbekannt")
			continue
		}
		v, err := d.Parse(overrides[k])
		if err != nil {
			skipped = append(skipped, k+": "+err.Error())
			continue
		}
		d.set(c, v)
	}
	if err := CheckConsistency(c); err != nil {
		*c = original
		skipped = append(skipped, "alle Überschreibungen verworfen: "+err.Error())
	}
	return skipped
}

// Item ist die API-Sicht auf eine Einstellung.
type Item struct {
	Def
	// Active ist der Wert, mit dem der laufende Orchestrator arbeitet.
	Active string `json:"active"`
	// Override ist der gespeicherte Wert ("" = keiner, Umgebung/Default gilt).
	Override string `json:"override,omitempty"`
	// PendingRestart: gespeicherter Wert weicht vom aktiven ab.
	PendingRestart bool `json:"pendingRestart"`
}

// Items baut die API-Sicht: active = laufende Konfiguration.
func Items(active *config.Config, overrides map[string]string) []Item {
	out := make([]Item, 0, len(Defs))
	for _, d := range Defs {
		it := Item{Def: d, Active: d.Value(active), Override: overrides[d.Key]}
		if it.Override != "" {
			if v, err := d.Parse(it.Override); err == nil {
				it.PendingRestart = format(v, d.Integer) != it.Active
			} else {
				it.PendingRestart = true
			}
		}
		out = append(out, it)
	}
	return out
}

// StartupEntry ist eine nur lesende Start-Konfiguration.
type StartupEntry struct {
	Key   string `json:"key"`
	Label string `json:"label"`
	Value string `json:"value"`
	// Secret: Wert wird nie angezeigt, nur ob gesetzt.
	Secret bool `json:"secret,omitempty"`
}

// StartupInfo listet die nicht über die UI änderbare Start-Konfiguration (Geheimnisse maskiert).
func StartupInfo(c config.Config) []StartupEntry {
	set := func(s string) string {
		if s == "" {
			return "nicht gesetzt"
		}
		return "gesetzt"
	}
	b := func(v bool) string {
		if v {
			return "ein"
		}
		return "aus"
	}
	return []StartupEntry{
		{Key: "OMP_LISTEN", Label: "Listen-Adresse", Value: c.Listen},
		{Key: "OMP_ORCHESTRATOR_URL", Label: "Orchestrator-URL", Value: c.OrchestratorURL},
		{Key: "OMP_REGISTRY_URL", Label: "NMOS-Registry", Value: c.RegistryURL},
		{Key: "OMP_NATS_URL", Label: "NATS", Value: c.NatsURL},
		{Key: "OMP_POSTGRES_URL", Label: "Datenbank", Value: set(c.PostgresURL), Secret: true},
		{Key: "OMP_AUTH_JWT_SECRET", Label: "JWT-Secret", Value: set(c.JWTSecret + c.JWTSecretFile), Secret: true},
		{Key: "OMP_STORAGE_SECRET_KEY", Label: "Storage-Masterschlüssel", Value: set(c.StorageSecretKey), Secret: true},
		{Key: "OMP_MTLS_ENABLED", Label: "mTLS", Value: b(c.MTLSEnabled)},
		{Key: "OMP_NATS_TLS_ENABLED", Label: "NATS-TLS", Value: b(c.NatsTLSEnabled)},
		{Key: "OMP_REGISTRY_TLS_ENABLED", Label: "Registry-TLS", Value: b(c.RegistryTLSEnabled)},
		{Key: "OMP_UI_DIR", Label: "UI-Verzeichnis", Value: c.UIDir},
		{Key: "OMP_CATALOG_PATH", Label: "Katalog", Value: c.CatalogPath},
		{Key: "OMP_BACKUP_DIR", Label: "Backup-Verzeichnis", Value: c.BackupDir},
		{Key: "OMP_UPDATE_DIR", Label: "Update-Ablage", Value: c.UpdateDir},
		{Key: "OMP_NODE_VERSIONS_DIR", Label: "Versionsspeicher", Value: c.NodeVersionsDir},
		{Key: "OMP_UPDATE_ALLOW_UNSIGNED", Label: "Unsignierte Updates erlaubt", Value: b(c.UpdateAllowUnsigned)},
		{Key: "OMP_SUPERVISOR_URL", Label: "Supervisor", Value: c.SupervisorURL},
		{Key: "OMP_NODE_ID", Label: "Cluster-Knoten-ID", Value: c.ClusterNodeID},
		{Key: "OMP_RAFT_LISTEN", Label: "Raft-Adresse", Value: c.ClusterRaftAddr},
		{Key: "OMP_RAFT_DATA_DIR", Label: "Raft-Daten", Value: c.ClusterDataDir},
		{Key: "OMP_CLUSTER_PEERS", Label: "Cluster-Mitglieder", Value: c.ClusterPeers},
	}
}
