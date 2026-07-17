// Package workflows implementiert das „Workflow"-Objekt (ARCHITECTURE.md
// §6.2, UMSETZUNG.md D7 Teil 1): eine benannte Menge von Node-Rollen plus
// ein Rolle→Rolle-Verbindungs-Template, die als Bündel gestartet/gestoppt
// werden. Ein Workflow bestimmt, welche Prozesse überhaupt existieren und
// wo — anders als ein Snapshot (B7), der nur den Parameter-/Kantenzustand
// bereits laufender Nodes erfasst/wiederherstellt, aber nie einen Prozess
// startet. Rein additiv zum bestehenden Instanz-Launcher (C8/D6 Teil 2):
// Start eines Workflows ruft denselben Launcher pro Rolle auf.
//
// **Bewusst nicht in D7 Teil 1** (dokumentierte Scope-Grenze, §6.2 nennt
// den vollen Umfang): Zeitsteuerung (start_at/stop_at), Stop-
// Sicherheitsabfrage (confirm_stop), Ressourcen-Vorprüfung/Placement-
// Integration (§6.1, selbst noch zurückgestellt) — dieser Schritt liefert
// nur das Workflow-Objekt selbst plus manuelles Bundle-Start/Stop mit
// automatischer Verkabelung, sobald die erwarteten Nodes erscheinen.
package workflows

import "time"

// Status-Werte eines Workflows (Lifecycle, §6.2).
const (
	StatusStopped  = "stopped"
	StatusStarting = "starting"
	StatusStarted  = "started"
	StatusStopping = "stopping"
	StatusFailed   = "failed"
)

// Role ist eine benötigte Node-Rolle innerhalb eines Workflows — „Rolle"
// im Sinn von §6.2, nicht die Rollenbindung aus §12 (Namenskollision im
// Konzeptpapier, hier bewusst als NodeType/Label statt "role" betitelt,
// um Verwechslung mit authz.Verb-Rollen zu vermeiden). HostID ist
// optional (leer = lokal, gesetzt = Remote-Host, UMSETZUNG.md D6 Teil 2)
// — dieselbe Semantik wie beim Instanz-Launcher.
type Role struct {
	Name     string `json:"name"`
	NodeType string `json:"nodeType"`
	HostID   string `json:"hostId,omitempty"`
}

// Connection ist ein Eintrag im Verbindungs-Template: Rolle→Rolle, nicht
// Port→Port (ARCHITECTURE.md §6.2 wörtlich: "Rolle→Rolle, wird beim
// Erscheinen konkreter Node-IDs zu echten IS-05-Connections aufgelöst").
// Aufgelöst wird auf den jeweils ersten Sender/Receiver der Rolle — eine
// bewusste Vereinfachung für Teil 1: alle heutigen Katalog-Nodes haben
// höchstens einen relevanten Sender bzw. Receiver pro Rolle im
// Regieplatz-Kontext. Mehrere Sender/Receiver pro Rolle (Port-genaues
// Template) ist dokumentierte Folgearbeit, kein stiller Gap.
type Connection struct {
	FromRole string `json:"fromRole"`
	ToRole   string `json:"toRole"`
}

// Settings sind pro Workflow konfigurierbare, aber node-übergreifende
// Werte (Kapitel 15, docs/END-GOAL-FEATURES.md §15.3c, 2026-07-17
// Nutzerfeedback "generell müssen wir pro Workflow Settings haben,
// welche Auflösung dieser haben soll") — additiv, kein Node-Contract-
// Thema. 0 = Node-eigener Default (heute 640×480 in den meisten
// Katalog-Nodes fest verdrahtet, s. runStart) statt eines erzwungenen
// Werts, damit ein Workflow ohne Settings sich exakt wie vor diesem
// Feld verhält.
type Settings struct {
	ProgramWidth  uint32 `json:"programWidth,omitempty"`
	ProgramHeight uint32 `json:"programHeight,omitempty"`
}

// Definition ist der vom Nutzer festgelegte, unveränderliche Teil eines
// Workflows (im Gegensatz zu Status/Runtime, die sich beim Start/Stop
// ändern).
type Definition struct {
	Roles       []Role       `json:"roles"`
	Connections []Connection `json:"connections"`
	Settings    Settings     `json:"settings,omitempty"`
}

// RoleRuntime hält fest, welche konkrete Instanz/Node gerade eine Rolle
// erfüllt — leer, solange der Workflow gestoppt ist.
type RoleRuntime struct {
	InstanceID string `json:"instanceId"`
	NodeID     string `json:"nodeId,omitempty"`
}

// Workflow ist der Body von GET /api/v1/workflows (Liste/Einzelabruf)
// bzw. das Ergebnis von POST /api/v1/workflows.
type Workflow struct {
	ID         string                 `json:"id"`
	Name       string                 `json:"name"`
	Definition Definition             `json:"definition"`
	Status     string                 `json:"status"`
	Error      string                 `json:"error,omitempty"`
	Runtime    map[string]RoleRuntime `json:"runtime,omitempty"`
	CreatedAt  time.Time              `json:"createdAt"`
	UpdatedAt  time.Time              `json:"updatedAt"`
}
