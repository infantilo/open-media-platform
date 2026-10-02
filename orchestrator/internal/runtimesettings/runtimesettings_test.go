package runtimesettings

import (
	"strings"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/config"
)

func base() config.Config {
	return config.Config{
		AuditRetentionDays: 90, LogRetentionHours: 24, WorkflowRunRetentionDays: 30, OutboxRetentionDays: 14,
		HostTokenRetentionDays: 7, ProcessExecutionRetentionDays: 180, BackupKeep: 5,
		PlacementCPUThreshold: 85, PlacementHealthyCPUThreshold: 60, PlacementMemThreshold: 85, PlacementHealthyMemThreshold: 60,
		PlacementNetThreshold: 80, PlacementHealthyNetThreshold: 50, PlacementGpuThreshold: 85, PlacementHealthyGpuThreshold: 60,
	}
}

func TestApplyOverridesAndSkipsInvalid(t *testing.T) {
	c := base()
	skipped := Apply(&c, map[string]string{
		"OMP_AUDIT_RETENTION_DAYS":        "365",
		"OMP_PLACEMENT_CPU_THRESHOLD":     "90",
		"OMP_BACKUP_KEEP":                 "zehn",  // keine Zahl
		"OMP_OUTBOX_RETENTION_DAYS":       "99999", // außerhalb
		"OMP_GIBTS_NICHT":                 "1",     // unbekannt
		"OMP_WORKFLOW_RUN_RETENTION_DAYS": "7.5",   // nicht ganzzahlig
	})
	if c.AuditRetentionDays != 365 || c.PlacementCPUThreshold != 90 {
		t.Fatalf("gültige Werte nicht angewendet: %+v", c)
	}
	if c.BackupKeep != 5 || c.OutboxRetentionDays != 14 || c.WorkflowRunRetentionDays != 30 {
		t.Fatalf("ungültige Werte dürfen nichts ändern: %+v", c)
	}
	if len(skipped) != 4 {
		t.Fatalf("4 übersprungene Einträge erwartet: %v", skipped)
	}
}

func TestApplyRejectsContradictoryThresholdsAsAWhole(t *testing.T) {
	c := base()
	skipped := Apply(&c, map[string]string{"OMP_AUDIT_RETENTION_DAYS": "365", "OMP_PLACEMENT_HEALTHY_CPU_THRESHOLD": "95"})
	if c.AuditRetentionDays != 90 || c.PlacementHealthyCPUThreshold != 60 {
		t.Fatalf("bei Widerspruch bleibt alles beim Alten: %+v", c)
	}
	if len(skipped) == 0 || !strings.Contains(skipped[len(skipped)-1], "verworfen") {
		t.Fatalf("Meldung erwartet: %v", skipped)
	}
}

func TestItemsShowPendingRestart(t *testing.T) {
	c := base()
	items := Items(&c, map[string]string{"OMP_AUDIT_RETENTION_DAYS": "365", "OMP_BACKUP_KEEP": "5"})
	byKey := map[string]Item{}
	for _, it := range items {
		byKey[it.Key] = it
	}
	if !byKey["OMP_AUDIT_RETENTION_DAYS"].PendingRestart || byKey["OMP_AUDIT_RETENTION_DAYS"].Active != "90" {
		t.Fatalf("%+v", byKey["OMP_AUDIT_RETENTION_DAYS"])
	}
	if byKey["OMP_BACKUP_KEEP"].PendingRestart {
		t.Fatal("gleicher Wert wie aktiv = nichts ausstehend")
	}
	if byKey["OMP_LOG_RETENTION_HOURS"].Override != "" || byKey["OMP_LOG_RETENTION_HOURS"].PendingRestart {
		t.Fatal("ohne Überschreibung nichts ausstehend")
	}
}

func TestParseBounds(t *testing.T) {
	d, _ := Find("OMP_PLACEMENT_CPU_THRESHOLD")
	for _, bad := range []string{"0", "101", "x", ""} {
		if _, err := d.Parse(bad); err == nil {
			t.Errorf("%q sollte abgelehnt werden", bad)
		}
	}
	if v, err := d.Parse(" 72.5 "); err != nil || v != 72.5 {
		t.Fatal(v, err)
	}
}

func TestStartupInfoMasksSecrets(t *testing.T) {
	c := base()
	c.PostgresURL = "postgres://omp:geheim@host/db"
	c.JWTSecret = "supergeheim"
	for _, e := range StartupInfo(c) {
		if strings.Contains(e.Value, "geheim") {
			t.Fatalf("Geheimnis im Klartext: %+v", e)
		}
		if e.Secret && e.Value != "gesetzt" && e.Value != "nicht gesetzt" {
			t.Fatalf("%+v", e)
		}
	}
}
