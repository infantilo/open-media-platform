// Package authz implementiert die Autorisierungs-Semantik aus
// ARCHITECTURE.md §12 (UMSETZUNG.md D3 Teil 2): Rechte als Tripel
// (Subject, Node-Rolle, Verb), zentral im Orchestrator durchgesetzt (§12
// Punkt 3). Ersetzt die bisherige, handgepflegte data/role-bindings.json
// (C13-Stub, internal/consoles) durch eine Postgres-Tabelle — gleiche
// Bindungs-Semantik, jetzt über eine echte Login-Identität statt eines
// spoofbaren Stub-Headers gefüllt.
//
// Kapitel 12 Teil 4 (docs/END-GOAL-FEATURES.md §12.3e) ergänzt den in
// §12 Punkt 2 von Anfang an vorgesehenen, aber bis D7 zurückgestellten
// Workflow-Scope (s. Binding-Doku unten) — das Projekt hat seit D7/
// Kapitel 12 Teil 1–3 jetzt ein echtes Workflow-Objekt mit stabilen
// Rollennamen.
package authz

// Verb ist die Wirkungsart einer Rollenbindung (§12 Punkt 2).
type Verb string

const (
	VerbView      Verb = "view"
	VerbOperate   Verb = "operate"
	VerbConfigure Verb = "configure"
	VerbAdmin     Verb = "admin"
)

// rank ordnet Verben für "mindestens X"-Prüfungen (Check unten): admin
// deckt alles ab, was configure abdeckt, das wiederum alles, was operate
// abdeckt, usw. — dieselbe Annahme, die internal/consoles.Resolve schon
// trifft ("configure/admin" ⇒ auch Engineering-Zugriff, also implizit
// mehr als operate).
var rank = map[Verb]int{
	VerbView:      1,
	VerbOperate:   2,
	VerbConfigure: 3,
	VerbAdmin:     4,
}

func (v Verb) covers(min Verb) bool {
	return rank[v] >= rank[min]
}

// Binding bindet subject (Nutzername) an einen Wirkungsbereich mit
// einem Verb — zwei Formen (§12 Punkt 2 nennt beide von Anfang an):
//
//   - WorkflowID == "" (unverändertes Vor-Kapitel-12-Teil-4-Verhalten):
//     NodeID ist entweder eine stabile Instanz-ID (s. internal/consoles/
//     resolve.go:NodeRoleID) oder AnyNode ("*" = alle Nodes global).
//   - WorkflowID != "" (Kapitel 12 Teil 4, docs/END-GOAL-FEATURES.md
//     §12.3e): NodeID ist der stabile Rollenname aus
//     workflows.Definition.Roles (oder AnyNode = "der ganze Workflow")
//     — bewusst NICHT die Instanz-ID, die überlebt einen Workflow-
//     Neustart nicht (jeder Start()/Resume() vergibt neue). Das ist
//     genau der Bildmeister-Fall: "nur den Bildmischer in Regieplatz 1",
//     stabil über beliebig viele Neustarts der Rolle hinweg.
type Binding struct {
	ID         string
	Subject    string
	WorkflowID string
	NodeID     string
	Verb       Verb
}

// AnyNode ist der NodeID-Wert für eine Bindung, die für alle Nodes gilt.
const AnyNode = "*"
