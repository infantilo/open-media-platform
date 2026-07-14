// Package authz implementiert die Autorisierungs-Semantik aus
// ARCHITECTURE.md §12 (UMSETZUNG.md D3 Teil 2): Rechte als Tripel
// (Subject, Node-Rolle, Verb), zentral im Orchestrator durchgesetzt (§12
// Punkt 3). Ersetzt die bisherige, handgepflegte data/role-bindings.json
// (C13-Stub, internal/consoles) durch eine Postgres-Tabelle — gleiche
// Bindungs-Semantik, jetzt über eine echte Login-Identität statt eines
// spoofbaren Stub-Headers gefüllt.
//
// Bewusst kein Workflow-Scope in dieser Runde (§12 Punkt 2 nennt
// Workflow *oder* Node-Rolle als Wirkungsbereich): das Projekt kennt noch
// kein eigenständiges Workflow-Objekt (ARCHITECTURE.md §6.2, erst ab D7)
// — es gibt weiterhin genau den einen impliziten Workflow, den
// internal/consoles schon als StubWorkflowID kennt. Node-Rollen-Scope
// (NodeID "*" oder eine konkrete Instanz-ID) ist der einzige Wirkungs-
// bereich, den es heute sinnvoll gibt.
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

// Binding bindet subject (Nutzername) an einen Node (per stabiler
// Instanz-ID, s. internal/consoles/resolve.go:nodeRoleID) oder an "*"
// (alle Nodes) mit einem Verb.
type Binding struct {
	ID      string
	Subject string
	NodeID  string
	Verb    Verb
}

// AnyNode ist der NodeID-Wert für eine Bindung, die für alle Nodes gilt.
const AnyNode = "*"
