// Package profile prüft die Konfiguration gegen ein Produktionsprofil (Audit 2026-10-23 B4/B5: der Produktions-Deployment war der Dev-Stack — Datenbank mit
// Dev-Passwort, NATS ohne TLS, Zwei-Knoten-Raft). Mit OMP_PROFILE=production verweigert der Orchestrator den Start, solange ein kritischer Befund
// offen ist; bewusst Akzeptiertes steht in OMP_PROFILE_ACCEPT (Komma-Liste der Befund-IDs). Im Entwicklungsprofil (Standard) werden die Befunde nur
// gemeldet (Log, GET /api/v1/admin/profile).
package profile

import (
	"fmt"
	"net/url"
	"sort"
	"strings"
)

const (
	Critical = "critical"
	Warning  = "warning"
)

// Finding ist ein Befund.
type Finding struct {
	ID       string `json:"id"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
	Hint     string `json:"hint"`
}

// Inputs sind die geprüften Einstellungen (aus config.Config, hier ohne Abhängigkeit zum Konfigurationspaket).
type Inputs struct {
	PostgresURL            string
	NatsURL                string
	NatsTLS                bool
	RegistryTLS            bool
	NodeMTLS               bool
	JWTSecret              string // nur, wenn per Umgebung gesetzt (sonst erzeugt und gespeichert)
	BootstrapOpen          bool
	UpdateAllowUnsigned    bool
	BackupPassphrase       string
	BackupCopyDir          string
	MetricsToken           string
	ClusterPeers           string // "id=host:port,…" (leer = Einzelbetrieb)
	LeaderPlusPeersAtLeast int    // optional: bereits bekannte Clustergröße (0 = aus ClusterPeers ableiten)
}

func clusterSize(in Inputs) int {
	if in.LeaderPlusPeersAtLeast > 0 {
		return in.LeaderPlusPeersAtLeast
	}
	n := 0
	for _, p := range strings.Split(in.ClusterPeers, ",") {
		if strings.TrimSpace(p) != "" {
			n++
		}
	}
	if n == 0 {
		return 1
	}
	return n + 1 // Peers plus dieser Knoten
}

func postgresDefaultCreds(dsn string) bool {
	// Mehrere Hosts in der DSN ("postgres://u:p@h1,h2/db"): url.Parse verträgt das nicht überall — Benutzer und Passwort stehen vor dem letzten "@".
	rest := strings.TrimPrefix(strings.TrimPrefix(dsn, "postgres://"), "postgresql://")
	at := strings.LastIndex(rest, "@")
	if at < 0 {
		return false
	}
	cred := rest[:at]
	user, pass, _ := strings.Cut(cred, ":")
	if u, err := url.PathUnescape(pass); err == nil {
		pass = u
	}
	return pass == "" || pass == user || pass == "omp" || pass == "postgres" || pass == "password"
}

// Evaluate liefert alle Befunde, kritische zuerst.
func Evaluate(in Inputs) []Finding {
	var f []Finding
	add := func(id, sev, msg, hint string) {
		f = append(f, Finding{ID: id, Severity: sev, Message: msg, Hint: hint})
	}

	if postgresDefaultCreds(in.PostgresURL) {
		add("postgres-default-credentials", Critical, "Die Datenbank läuft mit dem Dev-Passwort.", "OMP_POSTGRES_URL mit eigenem, starkem Passwort setzen (Patroni-/Postgres-Konfiguration passend ändern).")
	}
	if strings.HasPrefix(in.NatsURL, "nats://") && !in.NatsTLS {
		add("nats-plain", Critical, "NATS läuft ohne Verschlüsselung und ohne Anmeldung (Host-Kommandos, Telemetrie, Dienst-Token im Klartext).", "OMP_NATS_TLS_ENABLED=1 mit Zertifikaten; NATS-Anmeldung einrichten.")
	}
	if in.JWTSecret != "" && len(in.JWTSecret) < 32 {
		add("jwt-secret-weak", Critical, "Das JWT-Geheimnis aus der Umgebung ist kürzer als 32 Zeichen.", "OMP_AUTH_JWT_SECRET weglassen (wird erzeugt und gemeinsam in der Datenbank gehalten) oder mit ≥ 32 Zufallszeichen setzen.")
	}
	if in.BootstrapOpen {
		add("bootstrap-open", Critical, "Der Bootstrap-Modus ist für alle offen (OMP_BOOTSTRAP_OPEN).", "Nach dem Anlegen des ersten Administrators abschalten; sonst OMP_BOOTSTRAP_TOKEN verwenden.")
	}
	if in.UpdateAllowUnsigned {
		add("update-unsigned", Critical, "Unsignierte Update-Pakete sind erlaubt.", "OMP_UPDATE_ALLOW_UNSIGNED nicht setzen.")
	}
	switch n := clusterSize(in); {
	case n < 2:
		add("cluster-single", Warning, "Nur ein Orchestrator: Failover und Scheduler stehen bei dessen Ausfall.", "Mindestens drei Raft-Knoten auf getrennten Rechnern (Zeuge zählt mit) betreiben.")
	case n == 2:
		add("cluster-quorum", Critical, "Zwei Raft-Knoten haben bei Ausfall eines Knotens kein Quorum (Failover und Scheduler stehen).", "Einen dritten Knoten auf einem eigenen Rechner ergänzen: den Raft-Zeugen (cmd/witness, deploy/systemd/omp-raft-witness.service). Notfalls: Notausgang unter Administration → Cluster.")
	}
	if !in.NodeMTLS {
		add("node-mtls-off", Warning, "Orchestrator↔Node ohne gegenseitiges TLS (das Node-API-Token geht im Klartext).", "OMP_MTLS_ENABLED=1 mit Zertifikaten (make mtls-issue-certs).")
	}
	if !in.RegistryTLS {
		add("registry-plain", Warning, "Die NMOS-Registry läuft ohne TLS.", "OMP_REGISTRY_TLS_ENABLED=1.")
	}
	if in.MetricsToken == "" {
		add("metrics-open", Warning, "/metrics ist ohne Anmeldung erreichbar.", "OMP_METRICS_TOKEN setzen.")
	}
	if in.BackupPassphrase == "" {
		add("backup-no-keys", Warning, "Die Sicherung enthält kein Schlüsselmaterial (keine OMP_BACKUP_PASSPHRASE).", "Passphrase setzen und sicher verwahren.")
	}
	if in.BackupCopyDir == "" {
		add("backup-same-machine", Warning, "Die Sicherung liegt nur auf dem Orchestrator-Rechner.", "OMP_BACKUP_COPY_DIR auf ein Fremdziel setzen.")
	}
	sort.SliceStable(f, func(i, j int) bool { return f[i].Severity == Critical && f[j].Severity != Critical })
	return f
}

// Accepted liest OMP_PROFILE_ACCEPT.
func Accepted(list string) map[string]bool {
	out := map[string]bool{}
	for _, id := range strings.Split(list, ",") {
		if id = strings.TrimSpace(id); id != "" {
			out[id] = true
		}
	}
	return out
}

// Enforce: im Produktionsprofil ein Fehler, solange ein kritischer Befund nicht ausdrücklich akzeptiert ist. Andere Profile: nie.
func Enforce(profile string, findings []Finding, accepted map[string]bool) error {
	if !strings.EqualFold(profile, "production") {
		return nil
	}
	var open []string
	for _, x := range findings {
		if x.Severity == Critical && !accepted[x.ID] {
			open = append(open, x.ID+": "+x.Message+" "+x.Hint)
		}
	}
	if len(open) == 0 {
		return nil
	}
	return fmt.Errorf("Produktionsprofil verletzt (OMP_PROFILE=production):\n  - %s\nBewusst akzeptieren: OMP_PROFILE_ACCEPT=<id>,…", strings.Join(open, "\n  - "))
}
