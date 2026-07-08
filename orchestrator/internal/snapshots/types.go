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

// Snapshot ist der Body von GET /api/v1/snapshots (Liste) bzw. das
// Ergebnis von POST /api/v1/snapshots.
type Snapshot struct {
	ID        string       `json:"id"`
	Label     string       `json:"label"`
	CreatedAt time.Time    `json:"created_at"`
	Edges     []Edge       `json:"edges"`
	Params    []ParamValue `json:"params"`
}

// ApplyResult ist der Body von POST /api/v1/snapshots/<id>/apply.
// Errors ist immer ein (ggf. leeres) Array, nie null.
type ApplyResult struct {
	Errors []string `json:"errors"`
}
