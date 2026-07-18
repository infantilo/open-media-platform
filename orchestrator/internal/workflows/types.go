// Package workflows implementiert das „Workflow"-Objekt (ARCHITECTURE.md
// §6.2, UMSETZUNG.md D7 Teil 1): eine benannte Menge von Node-Rollen plus
// ein Rolle→Rolle-Verbindungs-Template, die als Bündel gestartet/gestoppt
// werden. Ein Workflow bestimmt, welche Prozesse überhaupt existieren und
// wo — anders als ein Snapshot (B7), der nur den Parameter-/Kantenzustand
// bereits laufender Nodes erfasst/wiederherstellt, aber nie einen Prozess
// startet. Rein additiv zum bestehenden Instanz-Launcher (C8/D6 Teil 2):
// Start eines Workflows ruft denselben Launcher pro Rolle auf.
//
// D7 Teil 2 (ARCHITECTURE.md §6.2-Erweiterung 2026-07-10) ergänzt die in
// D7 Teil 1 bewusst zurückgestellten drei Punkte: Zeitsteuerung
// (Schedule, s. u.), Stop-Sicherheitsabfrage (Settings.ConfirmStop) und
// Ressourcen-Vorprüfung als harte Start-Vorbedingung (s. service.go
// checkResources).
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
// FromSender/ToReceiver sind optionale IS-04-Port-**Labels** (Kapitel 12
// Teil 1, docs/END-GOAL-FEATURES.md §12.3a) — leer = Kompatibilitäts-
// Fallback auf den jeweils ersten Sender/Receiver der Rolle (bisheriges
// Verhalten, kein Bruch bestehender Workflows). Node-IDs scheiden als
// Referenz aus (pro Prozessstart neu), Labels sind pro Node-Typ stabil
// (z. B. omp-source: unbenannt=Video/Audio-Index, omp-ograf: "Fill"/
// "Key").
//
// **Crosspoint-Ziele (docs/decisions.md 2026-07-18):** die meisten
// Node-Typen mit Eingängen (omp-switcher, omp-video-mixer-me, …)
// registrieren gar keinen IS-04-Receiver — sie entdecken alle
// MXL-Sender im Netz automatisch (discovery_loop) und wählen den
// aktiven Eingang über eine eigene Crosspoint-Methode statt IS-05
// Connect. Zeigt ToRole auf einen solchen Node-Typ (s.
// crosspointByNodeType), wird die Connection stattdessen als "setze
// diesen Sender beim Start als aktiven Eingang" aufgelöst (Methodenruf,
// kein Connect) — der Operator kann danach frei umschalten, das ist nur
// der Start-Default. Pro Crosspoint-Zielrolle ist daher höchstens eine
// eingehende Connection sinnvoll (validate() erzwingt das).
type Connection struct {
	FromRole   string `json:"fromRole"`
	FromSender string `json:"fromSender,omitempty"`
	ToRole     string `json:"toRole"`
	ToReceiver string `json:"toReceiver,omitempty"`
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
	// ConfirmStop (D7 Teil 2, ARCHITECTURE.md §6.2 Punkt 2): wenn gesetzt,
	// verlangt Stop() ein explizites confirm=true (zweistufig — ein Stop
	// ohne Bestätigung wird mit ErrConfirmationRequired abgelehnt, die UI
	// zeigt dann einen Bestätigungsdialog). Ein zeitgesteuerter Stop
	// (Schedule, s. u.) überspringt diese Abfrage bewusst — die
	// Bestätigung ist beim Anlegen des Zeitplans bereits erfolgt, nicht
	// erst um 03:00 nachts (ARCHITECTURE.md §6.2 Punkt 2, wörtlich).
	ConfirmStop bool `json:"confirmStop,omitempty"`
}

// ScheduleKind unterscheidet einmalige von wiederkehrenden Zeitplänen
// (D7 Teil 2, ARCHITECTURE.md §6.2 Punkt 1).
type ScheduleKind string

const (
	ScheduleOnce   ScheduleKind = "once"
	ScheduleDaily  ScheduleKind = "daily"
	ScheduleWeekly ScheduleKind = "weekly"
)

// ScheduleAction ist die vom Zeitplan ausgelöste Lifecycle-Aktion.
type ScheduleAction string

const (
	ScheduleActionStart ScheduleAction = "start"
	ScheduleActionStop  ScheduleAction = "stop"
)

// Schedule ist ein einzelner Zeitplan-Eintrag eines Workflows (D7 Teil 2)
// — ein Workflow kann mehrere haben (z. B. "täglich 08:00 starten,
// 22:00 stoppen"). Zeitbasis ist die Systemzeit des Orchestrators (NTP),
// bewusst nicht PTP (ARCHITECTURE.md §6.2-Erweiterung: "Kontroll-
// Zeitbasis, hier bewusst nicht mit der Media-Zeitbasis vermengt").
//
// Nachhol-Regel bei verpassten Zeitpunkten (Orchestrator war zum
// geplanten Zeitpunkt down): **verfallen lassen**, nicht nachholen —
// Entscheidung dieser Sitzung (ARCHITECTURE.md nennt die Wahl explizit
// offen, "Detail in D7"). Begründung: ein verspätet nachgeholter Start/
// Stop Stunden nach dem geplanten Zeitpunkt kann mit zwischenzeitlicher
// manueller Bedienung kollidieren — für einen Sendebetrieb ist ein
// stiller Ausfall des Zeitplans (sichtbar im Audit-Log/Alarm-View)
// sicherer als eine überraschende verspätete Aktion. Implementiert über
// LastFiredAt: Scheduler.tick() feuert nur, wenn der berechnete
// Ist-Zeitpunkt innerhalb eines kurzen, aktuellen Zeitfensters liegt
// (scheduler.go fireWindow) UND von LastFiredAt abweicht — ein länger
// zurückliegender, verpasster Zeitpunkt fällt aus diesem Fenster heraus
// und feuert nie nachträglich.
type Schedule struct {
	ID     string         `json:"id"`
	Kind   ScheduleKind   `json:"kind"`
	Action ScheduleAction `json:"action"`
	// At (nur "once"): fester Zeitpunkt, RFC3339.
	At *time.Time `json:"at,omitempty"`
	// TimeOfDay (nur "daily"/"weekly"): "HH:MM" in der Orchestrator-
	// Ortszeit.
	TimeOfDay string `json:"timeOfDay,omitempty"`
	// Weekday (nur "weekly"): 0=Sonntag..6=Samstag (time.Weekday-
	// kompatibel).
	Weekday *int `json:"weekday,omitempty"`
	// LastFiredAt wird ausschließlich vom Scheduler geschrieben (s. o.)
	// — ein Client, der einen Workflow per PUT aktualisiert, sollte den
	// zuletzt per GET gelesenen Wert unverändert zurückschicken, sonst
	// kann ein bereits gefeuertes "once"-Schedule erneut feuern.
	LastFiredAt *time.Time `json:"lastFiredAt,omitempty"`
}

// Definition ist der vom Nutzer festgelegte, unveränderliche Teil eines
// Workflows (im Gegensatz zu Status/Runtime, die sich beim Start/Stop
// ändern).
type Definition struct {
	Roles       []Role       `json:"roles"`
	Connections []Connection `json:"connections"`
	Settings    Settings     `json:"settings,omitempty"`
	Schedules   []Schedule   `json:"schedules,omitempty"`
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
