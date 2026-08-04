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

import (
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
)

// Status-Werte eines Workflows (Lifecycle, §6.2; paused/pausing:
// Kapitel 12 Teil 3, docs/END-GOAL-FEATURES.md §12.3c). "paused" hat
// dieselbe Ressourcen-Wirkung wie "stopped" (keine Prozesse) — der
// Unterschied ist ausschließlich Editor-Sichtbarkeit/Absicht ("kommt
// wieder"): der Flow-Editor rendert einen pausierten Workflow
// weiterhin als benannten Rahmen mit Platzhalter-Kacheln, ein
// gestoppter verschwindet von der Canvas. Resume = normaler Start()
// (kein eigener Zustandsübergang).
const (
	StatusStopped  = "stopped"
	StatusStarting = "starting"
	StatusStarted  = "started"
	StatusStopping = "stopping"
	StatusFailed   = "failed"
	StatusPaused   = "paused"
	StatusPausing  = "pausing"
)

// Role ist eine benötigte Node-Rolle innerhalb eines Workflows — „Rolle"
// im Sinn von §6.2, nicht die Rollenbindung aus §12 (Namenskollision im
// Konzeptpapier, hier bewusst als NodeType/Label statt "role" betitelt,
// um Verwechslung mit authz.Verb-Rollen zu vermeiden).
//
// HostID (Nachtrag 99, 2026-07-27 — Bedeutung geändert): war bis dahin
// ein Zwang (leer = lokal, gesetzt = genau dieser Host oder Start-
// Fehlschlag). Ist jetzt nur noch eine PRÄFERENZ — reicht der Host nicht
// (fehlt/überlastet/durch eine Redundanz-Gruppe blockiert), platziert
// `placement.Engine.SelectHost` automatisch anderswo, der Start selbst
// schlägt dafür nie mehr fehl (s. service.go runStart). Der tatsächlich
// gewählte Host landet in `RoleRuntime.HostID` (s. u.), nicht hier.
//
// AffinityGroup/RedundancyGroup (Nachtrag 99): freie Tags, GLOBAL
// (nicht workflow-scoped) — ein Redundanzpaar besteht typischerweise aus
// zwei Rollen in zwei VERSCHIEDENEN Workflows (§21.3 "(c)": parallele,
// identisch bediente Standby-Instanz), Affinität kann ebenso
// workflow-übergreifend gemeint sein (z. B. zwei Rollen mit derselben
// DMA-/MXL-lokalen Kopplung). Rollen mit demselben AffinityGroup-Tag
// werden von SelectHost bevorzugt auf denselben Host gezogen, Rollen mit
// demselben RedundancyGroup-Tag bevorzugt AUSEINANDER gehalten (aber nie
// so strikt, dass ein Start deswegen scheitert).
type Role struct {
	Name            string `json:"name"`
	NodeType        string `json:"nodeType"`
	HostID          string `json:"hostId,omitempty"`
	AffinityGroup   string `json:"affinityGroup,omitempty"`
	RedundancyGroup string `json:"redundancyGroup,omitempty"`
	// Format (Nutzerwunsch 2026-07-28): benanntes Standard-Auflösung+
	// Framerate-Preset für diese Rolle (s. formats.go,
	// StandardFormatNames) — leer = Node-eigener Default (unverändertes
	// Verhalten). Bewusst pro Rolle statt workflow-weit wie Settings.
	// ProgramWidth/-Height (Kapitel 15): verschiedene Quellen im selben
	// Workflow können unterschiedliche native Formate brauchen, ein
	// Scaler-/Framerate-Converter-Node gleicht Unterschiede bei Bedarf
	// aus. Wirkt nur beim Start (kein Live-Wechsel — ein Auflösungs-
	// wechsel braucht einen MXL-Flow-Neuaufbau, gleiche Einschränkung
	// wie die bestehende Programm-Auflösung).
	Format string `json:"format,omitempty"`
	// StandbyFor (K7 Teil 4, docs/END-GOAL-FEATURES.md §7.4/§7.7): Name
	// einer anderen Rolle DESSELBEN Workflows, für die diese Rolle als
	// warmer Standby dient. Leer = normale Rolle (unverändertes
	// Verhalten). Eine Standby-Rolle wird beim Start wie jede andere
	// Rolle provisioniert/registriert (NMOS-discoverable, "warm"), bleibt
	// aber automatisch unverbunden — `Definition.Connections` referenziert
	// nur die Primärrolle, nie die Standby-Rolle selbst, s. runStart.
	// Übernimmt die Primärrolle erst bei einer echten Übernahme
	// (failover.go: Crash-Loop erschöpft ODER Host komplett offline).
	// Validierung (validate() in service.go): referenzierte Rolle muss
	// existieren, denselben NodeType haben, keine Selbstreferenz, keine
	// Ketten (eine Rolle ist entweder Primär- oder Standby-Rolle, nicht
	// beides), höchstens ein Standby pro Primärrolle (kein `replicas`
	// diese Runde — YAGNI, s. Plan).
	StandbyFor string `json:"standbyFor,omitempty"`
	// Placement (D6 Teil 4, ARCHITECTURE.md §6.1 Erweiterung
	// 2026-07-13 Punkt 2): pro-Rolle konfigurierbare Eskalationsstufe
	// für die Placement-Engine (placement.Engine.evaluateOnce-Alarm bei
	// Überlast). nil verhält sich exakt wie vor D6 Teil 4 — reines
	// Advisory, keine automatische Aktion. Bewusst ein Pointer (nicht
	// ein Wert-Struct): Gos `encoding/json` behandelt `omitempty` bei
	// Struct-**Werten** nie als "leer" (nur bei Slices/Maps/Strings/
	// Zahlen/Pointern) — ein Wert-Struct hätte für JEDE Rolle
	// dauerhaft ein sichtbares, aber bedeutungsloses `"placement":{}`
	// in jede Workflow-Definition geschrieben (live per echtem
	// `POST /api/v1/workflows`-Roundtrip gefunden, nicht vermutet).
	Placement *RolePlacementPolicy `json:"placement,omitempty"`
}

// PlacementEscalation liefert die Eskalationsstufe dieser Rolle,
// nil-sicher (Placement=="" gilt als EscalationAdvisory) — einzige
// Stelle, die r.Placement dereferenziert, alle anderen Aufrufer (service.go
// validate, migration.go considerMigration) nutzen dies statt selbst
// nil zu prüfen.
func (r Role) PlacementEscalation() string {
	if r.Placement == nil || r.Placement.Escalation == "" {
		return EscalationAdvisory
	}
	return r.Placement.Escalation
}

// PlacementConfirmWindowSeconds liefert das konfigurierte
// Bestätigungsfenster dieser Rolle, nil-sicher (0 = Backend-Default,
// s. DefaultConfirmWindowSeconds).
func (r Role) PlacementConfirmWindowSeconds() int {
	if r.Placement == nil {
		return 0
	}
	return r.Placement.ConfirmWindowSeconds
}

// Eskalationsstufen-Werte für RolePlacementPolicy.Escalation.
const (
	EscalationAdvisory          = "advisory"
	EscalationAutoConfirmWindow = "auto-confirm-window"
	EscalationAuto              = "auto"
)

// DefaultConfirmWindowSeconds gilt, wenn Escalation=="auto-confirm-window"
// und ConfirmWindowSeconds==0 — 30s, wie in §6.1 als Beispielwert
// genannt ("z. B. 30 s").
const DefaultConfirmWindowSeconds = 30

// RolePlacementPolicy steuert, was passiert, wenn die Placement-Engine
// den Host dieser Rolle als überlastet meldet und einen gesunden
// Ausweichhost gefunden hat (placement.Advice.SuggestedHostID):
//
//   - "" / "advisory" (Default): nur der bestehende UI-Alarm+Vorschlag,
//     keine automatische Aktion — unverändertes Vor-D6-Teil-4-Verhalten.
//   - "auto-confirm-window": ein Timer (ConfirmWindowSeconds, Default
//     DefaultConfirmWindowSeconds) läuft an; ohne manuellen Eingriff
//     (POST .../confirm oder .../cancel) führt der Ablauf des Timers
//     dieselbe Migration aus wie "auto".
//   - "auto": die Migration (migration.go: executeMigration, echtes
//     Make-before-break — neue Instanz zuerst, alte erst nach
//     erfolgreicher Umschaltung gestoppt) läuft sofort, sobald die
//     Engine den Alarm meldet.
//
// Bewusst pro Rolle statt global (wie Role.StandbyFor/§17.1s
// Erkennungsgeschwindigkeit): nicht jede Rolle soll gleich vertrauens-
// voll automatisch umgezogen werden.
type RolePlacementPolicy struct {
	Escalation           string `json:"escalation,omitempty"`
	ConfirmWindowSeconds int    `json:"confirmWindowSeconds,omitempty"`
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
	// TargetLatencyFrames (D8 Teil 2, ARCHITECTURE.md §15.1 Punkt 2): pro
	// Workflow konfigurierbares Latenzbudget in Video-Frames — Start()
	// verweigert den Start, wenn kein Pfad im Verbindungs-Template dieses
	// Budget mit der Summe der deklarierten minLatencyFrames unterschreiten
	// kann (ehrliche Ablehnung statt stillem Kürzer-Start, dieselbe
	// Haltung wie beim I/O-Karten-Fall §6.1). 0 = nicht gesetzt (kein
	// Check, unverändertes Verhalten) — gleiche Konvention wie
	// ProgramWidth/-Height oben. Bewusst nur Video-Frames in dieser
	// Scheibe: Audio-/Daten-Pfade sind laut Plan D8 Teil 4 (§15.1 Punkt 5:
	// "kein Kopieren des Video-Frame-Budgets").
	TargetLatencyFrames uint32 `json:"targetLatencyFrames,omitempty"`
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
	// Title/Description/Tags/Category (Kapitel 12 Teil 6,
	// docs/END-GOAL-FEATURES.md §12.3g, ARCHITECTURE.md §22.3 Punkte
	// 4+7): additive, rein darstellungsbezogene Felder für den
	// Workflow-Katalog (Kachel-Grid) — bewusst Teil der Definition statt
	// eines eigenen Objekts/einer eigenen Create/Update-Signatur: wie
	// Roles/Connections sind sie nutzerseitig gesetzt und nur per
	// Update() (§22.3 Punkt 2) änderbar, und wandern damit automatisch
	// mit durch Export/Import (Kapitel 12 Teil 3) statt eines separaten
	// Wire-Format-Felds. Title leer = Name als Anzeige-Titel-Fallback in
	// der UI (kein Bruch bestehender Workflows ohne Metadaten).
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	// Tags: Freitext-Schlagworte für die künftige Volltextsuche
	// (§22.3 Punkt 8, noch nicht Teil dieser Sitzung).
	Tags []string `json:"tags,omitempty"`
	// Category erweitert den §13.5-Node-Kategorien-Enum
	// (input/output/audio/video/graphics/data/control) um "regieplatz"
	// (§22.3 Punkt 7: "ein Workflow 'ist' typischerweise ein
	// Regieplatz") — nicht serverseitig validiert (§13.5: "fehlt
	// category, erscheint in einer 'Sonstige'-Gruppe statt einen Fehler
	// zu werfen", dieselbe Robustheit gilt hier: freies Textfeld, die UI
	// zeigt einen generischen Platzhalter für unbekannte/leere Werte).
	Category string `json:"category,omitempty"`
}

// RoleRuntime hält fest, welche konkrete Instanz/Node gerade eine Rolle
// erfüllt — leer, solange der Workflow gestoppt ist. HostID (Nachtrag
// 99) ist der von `placement.Engine.SelectHost` beim Start TATSÄCHLICH
// gewählte Host — kann von `Role.HostID` (nur noch eine Präferenz)
// abweichen, wenn dieser nicht erreichbar/überlastet war oder eine
// Redundanz-Gruppe ausgewichen ist.
type RoleRuntime struct {
	InstanceID string `json:"instanceId"`
	NodeID     string `json:"nodeId,omitempty"`
	HostID     string `json:"hostId,omitempty"`
	// StandbyActive (K7 Teil 4): gesetzt, sobald eine Übernahme
	// stattgefunden hat — diese Rolle wird gerade von der Instanz ihrer
	// (vormaligen) Standby-Rolle erfüllt statt von ihrer ursprünglichen
	// Primärinstanz. Rein informativ (UI-Badge/Alarm-Sichtbarkeit,
	// §7.2-Referenz "sichtbarer Status im UI"), beeinflusst kein
	// Orchestrator-Verhalten selbst.
	StandbyActive bool `json:"standbyActive,omitempty"`
}

// ExportedWorkflow ist das Datei-Format für Kapitel 12 Teil 3
// (docs/END-GOAL-FEATURES.md §12.3d: "ein Regieplatz wandert als Datei
// zwischen Systemen, ohne Nutzerdaten mitzuschleppen" — bewusst
// getrennt vom K11-Systemexport). Bewusst nur die Definition —
// `layoutFragment`/`parameterSnapshot` aus der vollen Spezifikation
// sind hier nicht Teil (docs/decisions.md 2026-07-18): reine Positions-
// /Parameter-Mitnahme ist UI-/Snapshot-Komfort, nicht Teil der
// Kernverifikation "Export → Delete → Import → Start → identisches
// Verhalten" — dokumentierte Folgearbeit.
type ExportedWorkflow struct {
	Version    int        `json:"version"`
	Name       string     `json:"name"`
	Definition Definition `json:"definition"`
	// Bindings (Nutzerwunsch 2026-07-28) — bewusst NICHT Teil des
	// Standard-Exports (leer/omitted, es sei denn `includeBindings=true`
	// wird explizit angefragt, s. Service.Export): der obige Grundsatz
	// "ohne Nutzerdaten mitzuschleppen" gilt für den portablen
	// Standardfall (ein Regieplatz wandert zwischen Systemen mit
	// potenziell anderen Nutzerkonten) unverändert. Dieses Feld deckt
	// den engeren, selben-System-Fall ab: ein endgültig gelöschter
	// Workflow (Service.Delete räumt seine Bindungen weg) lässt sich per
	// Export→Delete→Import auch mit denselben Berechtigungen
	// wiederherstellen, wenn der Exportierende das ausdrücklich anfordert.
	Bindings []ExportedBinding `json:"bindings,omitempty"`
}

// ExportedBinding ist eine Workflow-gescopte Rollenbindung (authz.Binding
// ohne ID/WorkflowID, die sich beim Import ohnehin ändern) — Nutzername,
// Rollenname (oder authz.AnyNode für "der ganze Workflow") und Verb.
type ExportedBinding struct {
	Subject string     `json:"subject"`
	Role    string     `json:"role"`
	Verb    authz.Verb `json:"verb"`
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
