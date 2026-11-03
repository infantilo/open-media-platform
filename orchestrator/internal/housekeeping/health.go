package housekeeping

import (
	"context"
	"database/sql"
	"fmt"
	"syscall"
	"time"
)

// TableHealth: Größe und Müllanteil einer Tabelle (pg_stat_user_tables).
type TableHealth struct {
	Name          string     `json:"name"`
	Bytes         int64      `json:"bytes"`
	LiveTuples    int64      `json:"liveTuples"`
	DeadTuples    int64      `json:"deadTuples"`
	DeadRatio     float64    `json:"deadRatio"`
	LastAutovac   *time.Time `json:"lastAutovacuum,omitempty"`
	LastAutoAnaly *time.Time `json:"lastAutoanalyze,omitempty"`
}

// Health: Zustand der Datenbank für Metriken und Selbsttest.
type Health struct {
	DatabaseBytes int64         `json:"databaseBytes"`
	Autovacuum    bool          `json:"autovacuum"`
	Connections   int           `json:"connections"`
	MaxConns      int           `json:"maxConnections"`
	Volume        *Volume       `json:"volume,omitempty"`
	Tables        []TableHealth `json:"tables"` // größte zuerst, höchstens 15
	Findings      []Finding     `json:"findings"`
}

// Finding: Befund mit nächstem Schritt (gleiche Form wie die Selbsttest-Befunde).
type Finding struct {
	ID       string `json:"id"`
	Severity string `json:"severity"` // warn | error
	Message  string `json:"message"`
	Hint     string `json:"hint"`
}

// Schwellen: bewusst grob; Autovacuum hält gesunde Tabellen weit darunter.
const (
	deadRatioWarn   = 0.30
	deadMinTuples   = 10000 // kleine Tabellen nie melden
	autovacStaleAge = 7 * 24 * time.Hour
	connWarnRatio   = 0.80
)

// CheckHealth liest den Zustand der Datenbank (nur lesend, günstig).
func CheckHealth(ctx context.Context, db *sql.DB) (Health, error) {
	var h Health
	if err := db.QueryRowContext(ctx, `SELECT pg_database_size(current_database())`).Scan(&h.DatabaseBytes); err != nil {
		return h, fmt.Errorf("db size: %w", err)
	}
	var av string
	if err := db.QueryRowContext(ctx, `SELECT current_setting('autovacuum')`).Scan(&av); err == nil {
		h.Autovacuum = av == "on"
	}
	_ = db.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()),
		current_setting('max_connections')::int`).Scan(&h.Connections, &h.MaxConns)
	rows, err := db.QueryContext(ctx, `
		SELECT relname, pg_total_relation_size(relid), n_live_tup, n_dead_tup, last_autovacuum, last_autoanalyze
		FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 15`)
	if err != nil {
		return h, fmt.Errorf("table stats: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var t TableHealth
		var va, an sql.NullTime
		if err := rows.Scan(&t.Name, &t.Bytes, &t.LiveTuples, &t.DeadTuples, &va, &an); err != nil {
			return h, err
		}
		if va.Valid {
			t.LastAutovac = &va.Time
		}
		if an.Valid {
			t.LastAutoAnaly = &an.Time
		}
		if tot := t.LiveTuples + t.DeadTuples; tot > 0 {
			t.DeadRatio = float64(t.DeadTuples) / float64(tot)
		}
		h.Tables = append(h.Tables, t)
	}
	if err := rows.Err(); err != nil {
		return h, err
	}
	h.Findings = evaluate(h, time.Now())
	return h, nil
}

// evaluate leitet Befunde aus den Messwerten ab (rein, testbar).
func evaluate(h Health, now time.Time) []Finding {
	var f []Finding
	if !h.Autovacuum {
		f = append(f, Finding{"db.autovacuum_off", "error",
			"Autovacuum der Datenbank ist ausgeschaltet — Tabellen blähen sich auf.",
			"In postgresql.conf bzw. der Patroni-Konfiguration `autovacuum = on` setzen und Postgres neu laden."})
	}
	for _, t := range h.Tables {
		if t.DeadTuples >= deadMinTuples && t.DeadRatio >= deadRatioWarn {
			f = append(f, Finding{"db.bloat." + t.Name, "warn",
				fmt.Sprintf("Tabelle %s besteht zu %.0f %% aus Müll (%d tote Zeilen).", t.Name, t.DeadRatio*100, t.DeadTuples),
				"Läuft eine sehr lange Transaktion oder ein verwaister Replikations-Slot? Danach `VACUUM (ANALYZE) " + t.Name + "` ausführen."})
		}
		if h.Autovacuum && t.DeadTuples >= deadMinTuples && t.LastAutovac != nil && now.Sub(*t.LastAutovac) > autovacStaleAge {
			f = append(f, Finding{"db.vacuum_stale." + t.Name, "warn",
				fmt.Sprintf("Tabelle %s wurde seit über 7 Tagen nicht bereinigt.", t.Name),
				"Autovacuum-Einstellungen und lange Transaktionen prüfen; notfalls `VACUUM (ANALYZE) " + t.Name + "`."})
		}
	}
	if h.MaxConns > 0 && float64(h.Connections) >= connWarnRatio*float64(h.MaxConns) {
		f = append(f, Finding{"db.connections", "warn",
			fmt.Sprintf("%d von %d Datenbankverbindungen belegt.", h.Connections, h.MaxConns),
			"Verbindungs-Lecks suchen oder `max_connections` erhöhen."})
	}
	return f
}

// Volume: Platz auf dem Datenträger der Datenbank (nur wenn der Pfad auf diesem Rechner liegt).
type Volume struct {
	Path       string `json:"path"`
	FreeBytes  int64  `json:"freeBytes"`
	TotalBytes int64  `json:"totalBytes"`
}

// AddVolume misst den Datenträger unter path und ergänzt Befunde bei knappem Platz (< 15 % warn, < 5 % Fehler).
// Leerer Pfad oder nicht lesbar: nichts tun (Datenbank läuft z. B. auf einem anderen Rechner).
func AddVolume(h *Health, path string) {
	if path == "" {
		return
	}
	var st syscall.Statfs_t
	if syscall.Statfs(path, &st) != nil {
		return
	}
	v := &Volume{Path: path, FreeBytes: int64(st.Bavail) * int64(st.Bsize), TotalBytes: int64(st.Blocks) * int64(st.Bsize)}
	h.Volume = v
	h.Findings = append(h.Findings, volumeFindings(v)...)
}

func volumeFindings(v *Volume) []Finding {
	if v.TotalBytes <= 0 {
		return nil
	}
	free := float64(v.FreeBytes) / float64(v.TotalBytes)
	switch {
	case free < 0.05:
		return []Finding{{"db.disk_low", "error", fmt.Sprintf("Datenträger der Datenbank fast voll (%.0f %% frei).", free*100),
			"Sofort Platz schaffen (alte Backups, Logs) oder den Datenträger vergrößern — bei vollem Datenträger stoppt Postgres."}}
	case free < 0.15:
		return []Finding{{"db.disk_low", "warn", fmt.Sprintf("Datenträger der Datenbank wird knapp (%.0f %% frei).", free*100),
			"Aufbewahrungsfristen (OMP_*_RETENTION_*) verkürzen oder den Datenträger vergrößern."}}
	}
	return nil
}
