// Package snapshots implementiert „Szenen" (UMSETZUNG.md B7): kompletter
// Regie-Zustand (Kanten + alle schreibbaren Parameterwerte aller Nodes)
// speichern und wiederherstellen. Erfassung/Wiederherstellung läuft
// ausschließlich über Standard-Endpunkte, die es ohnehin schon gibt
// (Graph-API, generischer Parameter-Proxy) — kein Sonderwissen über
// Node-Typen.
package snapshots

import (
	"encoding/json"
	"time"
)

// Edge ist eine wiederherzustellende IS-05-Connection.
type Edge struct {
	FromSender string `json:"fromSender"`
	ToReceiver string `json:"toReceiver"`
}

// ParamValue ist ein erfasster Parameterwert eines Nodes.
type ParamValue struct {
	NodeID string          `json:"node_id"`
	Name   string          `json:"name"`
	Value  json.RawMessage `json:"value"`
}

// NodeState ist der über `GET /state` erfasste, node-eigene Vollzustand
// eines Nodes ohne schreibbare Parameter (docs/decisions.md Nachtrag
// 40) — ein opakes JSON-Objekt, dessen Form nur der jeweilige Node
// kennt; der Orchestrator transportiert es unverändert.
type NodeState struct {
	NodeID string          `json:"nodeId"`
	State  json.RawMessage `json:"state"`
}

// Snapshot ist der Body von GET /api/v1/snapshots (Liste) bzw. das
// Ergebnis von POST /api/v1/snapshots.
type Snapshot struct {
	ID        string       `json:"id"`
	Label     string       `json:"label"`
	CreatedAt time.Time    `json:"created_at"`
	Edges     []Edge       `json:"edges"`
	Params    []ParamValue `json:"params"`
	// States sind per `GET /state` erfasste Nodes (s. NodeState) —
	// additiv neben Params: ein Node liefert entweder darüber oder über
	// die generische Parametererfassung, nie beides (Create() versucht
	// GetState zuerst und überspringt die Parameterschleife bei Erfolg).
	States []NodeState `json:"states,omitempty"`
	// NodeIDs ist additiv (§4.6 Punkt 4, docs/END-GOAL-FEATURES.md,
	// "Mixer-Presets"): leer/fehlend = klassische, workflow-weite Szene
	// (unverändertes B7-Verhalten). Nicht-leer = ein "Node-Preset" —
	// `Create` beschränkt Parametererfassung dann auf genau diese
	// Node-IDs und lässt `Edges` bewusst leer (ein Preset ist
	// Node-interner Zustand, keine Verkabelung). Derselbe
	// Erfassungs-/Anwendungscode wie eine Szene, nur eingeschränkt —
	// keine zweite Persistenz-Schicht.
	NodeIDs []string `json:"nodeIds,omitempty"`
}

// ApplyResult ist der Body von POST /api/v1/snapshots/<id>/apply.
// Errors ist immer ein (ggf. leeres) Array, nie null.
type ApplyResult struct {
	Errors []string `json:"errors"`
}
