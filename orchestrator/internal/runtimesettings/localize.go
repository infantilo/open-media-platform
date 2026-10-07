package runtimesettings

import "github.com/infantilo/openmediaplatform/orchestrator/internal/config"

// Englische Anzeigetexte der Betriebswerte (Grundsprache der Definitionen
// ist Deutsch). Sprache kommt aus Accept-Language, s. httpapi.requestLang.
type text struct{ label, desc, group string }

var enText = map[string]text{
	"OMP_AUDIT_RETENTION_DAYS":             {"Audit log", "How long audit entries (and domain audit) are kept. 0 = never delete.", "Retention"},
	"OMP_LOG_RETENTION_HOURS":              {"Central log", "Retention of the central log (hours instead of days, the volume is large). 0 = never delete.", "Retention"},
	"OMP_WORKFLOW_RUN_RETENTION_DAYS":      {"Workflow runs", "Retention of the workflow run history.", "Retention"},
	"OMP_OUTBOX_RETENTION_DAYS":            {"Event outbox", "Retention of delivered events in the outbox.", "Retention"},
	"OMP_HOST_TOKEN_RETENTION_DAYS":        {"Host tokens", "Retention of expired host agent tokens.", "Retention"},
	"OMP_PROCESS_EXECUTION_RETENTION_DAYS": {"Process executions", "Retention of the execution history of the process engine.", "Retention"},
	"OMP_BACKUP_KEEP":                      {"Number of backups", "How many database backups are kept; older ones are deleted when a new one is created.", "Backup"},
	"OMP_PLACEMENT_CPU_THRESHOLD":          {"CPU — overloaded from", "A host counts as overloaded from this CPU load (no target for new instances).", "Placement (load thresholds)"},
	"OMP_PLACEMENT_HEALTHY_CPU_THRESHOLD":  {"CPU — healthy up to", "Below this CPU load a host counts as healthy (preferred target).", "Placement (load thresholds)"},
	"OMP_PLACEMENT_MEM_THRESHOLD":          {"RAM — overloaded from", "A host counts as overloaded from this RAM load.", "Placement (load thresholds)"},
	"OMP_PLACEMENT_HEALTHY_MEM_THRESHOLD":  {"RAM — healthy up to", "Below this RAM load a host counts as healthy.", "Placement (load thresholds)"},
	"OMP_PLACEMENT_NET_THRESHOLD":          {"Network — overloaded from", "A host counts as overloaded from this network load (share of the card bandwidth).", "Placement (load thresholds)"},
	"OMP_PLACEMENT_HEALTHY_NET_THRESHOLD":  {"Network — healthy up to", "Below this network load a host counts as healthy.", "Placement (load thresholds)"},
	"OMP_PLACEMENT_GPU_THRESHOLD":          {"GPU — overloaded from", "A host counts as overloaded from this GPU load.", "Placement (load thresholds)"},
	"OMP_PLACEMENT_HEALTHY_GPU_THRESHOLD":  {"GPU — healthy up to", "Below this GPU load a host counts as healthy.", "Placement (load thresholds)"},
}

var enUnit = map[string]string{"Tage": "days", "Stunden": "hours", "Stück": "pcs"}

// Localized liefert die Definition mit den Anzeigetexten der Sprache lang
// ("" = Deutsch).
func (d Def) Localized(lang string) Def {
	if lang != "en" {
		return d
	}
	if t, ok := enText[d.Key]; ok {
		d.Label, d.Description, d.Group = t.label, t.desc, t.group
	}
	if u, ok := enUnit[d.Unit]; ok {
		d.Unit = u
	}
	return d
}

// ItemsLang wie Items, mit lokalisierten Anzeigetexten.
func ItemsLang(active *config.Config, overrides map[string]string, lang string) []Item {
	items := Items(active, overrides)
	for i := range items {
		items[i].Def = items[i].Def.Localized(lang)
	}
	return items
}

var enStartup = map[string]string{
	"OMP_LISTEN": "Listen address", "OMP_ORCHESTRATOR_URL": "Orchestrator URL", "OMP_REGISTRY_URL": "NMOS registry", "OMP_NATS_URL": "NATS",
	"OMP_POSTGRES_URL": "Database", "OMP_AUTH_JWT_SECRET": "JWT secret", "OMP_STORAGE_SECRET_KEY": "Storage master key",
	"OMP_MTLS_ENABLED": "mTLS", "OMP_NATS_TLS_ENABLED": "NATS TLS", "OMP_REGISTRY_TLS_ENABLED": "Registry TLS", "OMP_UI_DIR": "UI directory",
	"OMP_CATALOG_PATH": "Catalog", "OMP_BACKUP_DIR": "Backup directory", "OMP_UPDATE_DIR": "Update storage", "OMP_NODE_VERSIONS_DIR": "Version store",
	"OMP_UPDATE_ALLOW_UNSIGNED": "Unsigned updates allowed", "OMP_SUPERVISOR_URL": "Supervisor", "OMP_NODE_ID": "Cluster node ID",
	"OMP_RAFT_LISTEN": "Raft address", "OMP_RAFT_DATA_DIR": "Raft data", "OMP_CLUSTER_PEERS": "Cluster members",
}

var enValue = map[string]string{"nicht gesetzt": "not set", "gesetzt": "set", "ein": "on", "aus": "off"}

// StartupInfoLang wie StartupInfo, mit lokalisierten Beschriftungen/Werten.
func StartupInfoLang(c config.Config, lang string) []StartupEntry {
	out := StartupInfo(c)
	if lang != "en" {
		return out
	}
	for i := range out {
		if l, ok := enStartup[out[i].Key]; ok {
			out[i].Label = l
		}
		if v, ok := enValue[out[i].Value]; ok {
			out[i].Value = v
		}
	}
	return out
}
