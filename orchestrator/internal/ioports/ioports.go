// Package ioports verwaltet das Geräte-Inventar und die Belegung
// physischer I/O-Karten-Ports (z. B. Blackmagic-DeckLink-SDI-Ein-/
// Ausgänge) über Hosts hinweg — ARCHITECTURE.md §6.1 Erweiterung
// 2026-07-10 ("I/O-Karten als erstklassige Host-Ressource"),
// UMSETZUNG.md D13.
//
// Zwei getrennte Zustände (s. db/migrations/0015_io_ports.sql):
//   - Inventar (SetInventory/ListInventory/ListAllPorts): welche Ports
//     existieren pro Host — vom Host-Agent bei der Registrierung
//     gemeldet, ändert sich praktisch nie zur Laufzeit.
//   - Belegung (Claim/Release/ListClaims): welcher Port ist gerade von
//     welcher Workflow-Rolle belegt — ändert sich mit jedem Start/Stop
//     einer Rolle, die einen Port braucht.
//
// Bewusst kein Anschluss an die Raft-Cluster-Schicht (ARCHITECTURE.md
// §19.3, UMSETZUNG.md D12): Claim/Release sind über den PRIMARY KEY von
// io_port_claims bereits atomar und cluster-sicher, unabhängig davon,
// welche/wie viele Orchestrator-Instanzen gleichzeitig einen
// Workflow-Start bearbeiten — dieselbe Lehre wie D12 Teil 3 (Nachtrag
// 149): Postgres' eigene Atomarität reicht, wenn die Exklusivität
// tatsächlich zeilenweise über eine Unique-Bedingung abbildbar ist,
// keine zweite, Raft-replizierte Kopie derselben Tatsache nötig.
package ioports

import (
	"database/sql"
	"time"
)

// Port ist ein einzelner, vom Host-Agent gemeldeter physischer I/O-Port
// (statisches Inventar).
type Port struct {
	HostID    string `json:"hostId"`
	PortID    string `json:"portId"`
	CardType  string `json:"cardType"`
	Direction string `json:"direction"` // "in" | "out"
	Label     string `json:"label,omitempty"`
}

// Claim ist die aktuelle Belegung eines Ports (dynamischer Zustand).
type Claim struct {
	HostID     string    `json:"hostId"`
	PortID     string    `json:"portId"`
	WorkflowID string    `json:"workflowId"`
	Role       string    `json:"role"`
	InstanceID string    `json:"instanceId"`
	ClaimedAt  time.Time `json:"claimedAt"`
}

// Store persistiert Inventar und Belegung in Postgres.
type Store struct {
	db *sql.DB
}

// NewStore erstellt einen Store gegen die gegebene DB-Verbindung.
func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

// SetInventory ersetzt das gemeldete Port-Inventar von hostID durch
// ports — aufgerufen bei jeder Host-Registrierung (auch bei einem
// Re-Register nach Host-Agent-Neustart). Fügt neue/geänderte Ports per
// Upsert ein und entfernt zuvor gemeldete, jetzt nicht mehr gemeldete
// Ports — mit EINER Ausnahme: ein aktuell belegter Port wird NIE
// entfernt, selbst wenn er im neuen Inventar fehlt (ein Host-Agent, der
// mit geänderter/unvollständiger Inventar-Konfiguration neu startet,
// soll keinen laufenden Claim stillschweigend verwaisen lassen — die
// Diskrepanz bleibt sichtbar, statt sie per CASCADE zu verschlucken).
func (s *Store) SetInventory(hostID string, ports []Port) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	reported := make([]string, 0, len(ports))
	for _, p := range ports {
		reported = append(reported, p.PortID)
		if _, err := tx.Exec(`
			INSERT INTO host_io_ports (host_id, port_id, card_type, direction, label)
			VALUES ($1, $2, $3, $4, $5)
			ON CONFLICT (host_id, port_id) DO UPDATE SET card_type = $3, direction = $4, label = $5
		`, hostID, p.PortID, p.CardType, p.Direction, p.Label); err != nil {
			return err
		}
	}

	if _, err := tx.Exec(`
		DELETE FROM host_io_ports
		WHERE host_id = $1
		  AND NOT (port_id = ANY($2))
		  AND port_id NOT IN (SELECT port_id FROM io_port_claims WHERE host_id = $1)
	`, hostID, reported); err != nil {
		return err
	}

	return tx.Commit()
}

// ListInventory liefert das Port-Inventar eines Hosts.
func (s *Store) ListInventory(hostID string) ([]Port, error) {
	rows, err := s.db.Query(`
		SELECT host_id, port_id, card_type, direction, label FROM host_io_ports
		WHERE host_id = $1 ORDER BY port_id
	`, hostID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanPorts(rows)
}

// ListAllPorts liefert das vollständige Inventar aller Hosts (für die
// Hosts-API/-UI, ARCHITECTURE.md §18.7).
func (s *Store) ListAllPorts() ([]Port, error) {
	rows, err := s.db.Query(`
		SELECT host_id, port_id, card_type, direction, label FROM host_io_ports
		ORDER BY host_id, port_id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanPorts(rows)
}

func scanPorts(rows *sql.Rows) ([]Port, error) {
	ports := []Port{}
	for rows.Next() {
		var p Port
		if err := rows.Scan(&p.HostID, &p.PortID, &p.CardType, &p.Direction, &p.Label); err != nil {
			return nil, err
		}
		ports = append(ports, p)
	}
	return ports, rows.Err()
}

// ListClaims liefert alle aktuellen Belegungen (für die Hosts-API/-UI).
func (s *Store) ListClaims() ([]Claim, error) {
	rows, err := s.db.Query(`
		SELECT host_id, port_id, workflow_id, role, instance_id, claimed_at FROM io_port_claims
		ORDER BY host_id, port_id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	claims := []Claim{}
	for rows.Next() {
		var c Claim
		if err := rows.Scan(&c.HostID, &c.PortID, &c.WorkflowID, &c.Role, &c.InstanceID, &c.ClaimedAt); err != nil {
			return nil, err
		}
		claims = append(claims, c)
	}
	return claims, rows.Err()
}

// GetClaim liefert die aktuelle Belegung von (workflowID, role), falls
// vorhanden — gebraucht von migration.go, um vor einer Migration den
// GENAUEN (hostID, portID)-Claim der ALTEN Instanz zu kennen, damit
// ReleasePort später gezielt nur ihn freigibt, nicht versehentlich auch
// den währenddessen bereits angelegten NEUEN Claim auf dem Zielhost
// (beide teilen sich vorübergehend denselben workflowID/role-Wert, s.
// Release-Doku).
func (s *Store) GetClaim(workflowID, role string) (Claim, bool, error) {
	var c Claim
	err := s.db.QueryRow(`
		SELECT host_id, port_id, workflow_id, role, instance_id, claimed_at FROM io_port_claims
		WHERE workflow_id = $1 AND role = $2
		ORDER BY claimed_at LIMIT 1
	`, workflowID, role).Scan(&c.HostID, &c.PortID, &c.WorkflowID, &c.Role, &c.InstanceID, &c.ClaimedAt)
	if err == sql.ErrNoRows {
		return Claim{}, false, nil
	}
	if err != nil {
		return Claim{}, false, err
	}
	return c, true, nil
}

// ReleasePort gibt einen einzelnen, konkret benannten Port frei — anders
// als Release (nach workflowID/role, kann während einer laufenden
// Migration mehrdeutig sein, s. GetClaim-Doku) für den Fall, dass genau
// EINER von ggf. zwei gleichzeitig bestehenden Claims desselben
// (workflowID, role) gemeint ist.
func (s *Store) ReleasePort(hostID, portID string) error {
	_, err := s.db.Exec(`DELETE FROM io_port_claims WHERE host_id = $1 AND port_id = $2`, hostID, portID)
	return err
}

// Claim reserviert atomar einen freien Port vom Typ cardType/direction
// für (workflowID, role, instanceID) — bevorzugt preferredHostID, falls
// gesetzt und dort ein passender freier Port existiert; ist
// preferredHostID gesetzt, aber DORT kein passender freier Port frei,
// wird NICHT stillschweigend auf einen anderen Host ausgewichen (leeres
// preferredHostID bedeutet dagegen "irgendein Host", s. Aufrufer in
// workflows.Service) — "kein stiller Fallback" ist hier bewusst
// identisch zur bestehenden §6.1-Haltung bei Migrations-Zielhosts.
//
// Die eigentliche Atomarität kommt aus einer einzigen SQL-Anweisung
// (WITH-CTE + FOR UPDATE ... SKIP LOCKED + INSERT): mehrere gleichzeitig
// laufende Aufrufer (auch über mehrere Orchestrator-Prozesse hinweg,
// UMSETZUNG.md D12) können nie denselben Port doppelt zugewiesen
// bekommen — Postgres serialisiert das selbst, keine Anwendungs-Sperre
// nötig (s. Paketkommentar).
func (s *Store) Claim(cardType, direction, preferredHostID, workflowID, role, instanceID string) (hostID, portID string, ok bool, err error) {
	row := s.db.QueryRow(`
		WITH candidate AS (
			SELECT p.host_id, p.port_id
			FROM host_io_ports p
			LEFT JOIN io_port_claims c ON c.host_id = p.host_id AND c.port_id = p.port_id
			WHERE p.card_type = $1 AND p.direction = $2
			  AND ($3 = '' OR p.host_id = $3)
			  AND c.host_id IS NULL
			ORDER BY p.host_id, p.port_id
			LIMIT 1
			FOR UPDATE OF p SKIP LOCKED
		)
		INSERT INTO io_port_claims (host_id, port_id, workflow_id, role, instance_id)
		SELECT host_id, port_id, $4, $5, $6 FROM candidate
		RETURNING host_id, port_id
	`, cardType, direction, preferredHostID, workflowID, role, instanceID)

	if err := row.Scan(&hostID, &portID); err != nil {
		if err == sql.ErrNoRows {
			return "", "", false, nil
		}
		return "", "", false, err
	}
	return hostID, portID, true, nil
}

// UpdateInstanceID trägt die tatsächliche Launcher-Instanz-ID eines
// bestehenden Claims nach — Claim() reserviert den Port als harte
// Startvorbedingung, BEVOR die Instanz überhaupt gestartet wird
// (workflows.Service.claimIOPortsForStart), die Instanz-ID ist zu dem
// Zeitpunkt noch unbekannt. Rein für Anzeigezwecke (ListClaims), ändert
// nichts an der Exklusivität des Claims selbst.
func (s *Store) UpdateInstanceID(workflowID, role, instanceID string) error {
	_, err := s.db.Exec(`UPDATE io_port_claims SET instance_id = $3 WHERE workflow_id = $1 AND role = $2`, workflowID, role, instanceID)
	return err
}

// Release gibt alle Port-Claims von (workflowID, role) frei — Stop()
// einer Rolle bzw. der "Break"-Schritt einer Migration (make-before-
// break, migration.go). Kein Fehler, wenn gerade kein Claim existiert
// (Rollen ohne RequiredIOPort rufen dies nicht auf, aber ein doppelter
// Release-Aufruf — z. B. nach einer bereits fehlgeschlagenen
// Migration — soll nicht selbst zum Fehlerfall werden).
func (s *Store) Release(workflowID, role string) error {
	_, err := s.db.Exec(`DELETE FROM io_port_claims WHERE workflow_id = $1 AND role = $2`, workflowID, role)
	return err
}

// ReleaseClaimedByInstance gibt den Claim frei, dessen `instance_id`
// exakt `instanceID` trägt — für Aufrufer ohne einen (workflowID, role)-
// Schlüssel (Nutzerfund 2026-08-20, "deklink node crasht immer noch
// beim start"): `httpapi.handleDeleteInstance` kennt beim Stoppen einer
// direkt über den Node-Katalog gestarteten Instanz nur deren
// Instanz-ID, keinen Workflow/keine Rolle. Setzt voraus, dass
// `UpdateInstanceID` den Claim bereits mit dieser Instanz-ID versehen
// hat (`httpapi.handlePostInstance`) — ohne passenden Claim ein No-Op,
// kein Fehler (gleiche Nachsicht wie `Release`).
func (s *Store) ReleaseClaimedByInstance(instanceID string) error {
	_, err := s.db.Exec(`DELETE FROM io_port_claims WHERE instance_id = $1`, instanceID)
	return err
}
