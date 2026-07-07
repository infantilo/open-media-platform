package registry

// Die folgenden Typen decoden nur die Felder, die für das normalisierte
// Node-Inventar gebraucht werden — bewusst kein vollständiges Abbild der
// IS-04-Schemas (siehe specs.amwa.tv, AMWA-TV/is-04 v1.3.x). Unbekannte
// Felder werden von encoding/json stillschweigend ignoriert.

type is04Node struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type is04Device struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	NodeID string `json:"node_id"`
}

type is04Sender struct {
	ID       string  `json:"id"`
	Label    string  `json:"label"`
	DeviceID string  `json:"device_id"`
	FlowID   *string `json:"flow_id"`
}

type is04Receiver struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	DeviceID string `json:"device_id"`
	Format   string `json:"format"`
}

type is04Flow struct {
	ID     string `json:"id"`
	Format string `json:"format"`
}

// NodeView ist die vom Orchestrator normalisierte Sicht auf einen
// IS-04-Node samt seiner Devices, Senders und Receivers
// (ARCHITECTURE.md §2/§11.1: "kein Orchestrator-Sonderwissen", nur
// Standard-IS-04-Felder).
type NodeView struct {
	ID        string         `json:"id"`
	Label     string         `json:"label"`
	Online    bool           `json:"online"`
	Devices   []DeviceView   `json:"devices"`
	Senders   []SenderView   `json:"senders"`
	Receivers []ReceiverView `json:"receivers"`
}

// DeviceView ist die normalisierte Sicht auf ein IS-04-Device.
type DeviceView struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// SenderView ist die normalisierte Sicht auf einen IS-04-Sender inkl. des
// über den referenzierten Flow aufgelösten Medien-Formats.
type SenderView struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	DeviceID string `json:"device_id"`
	Format   string `json:"format"`
}

// ReceiverView ist die normalisierte Sicht auf einen IS-04-Receiver. Das
// Format steht bei Receivern (anders als bei Sendern) direkt am Resource,
// nicht über einen Flow.
type ReceiverView struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	DeviceID string `json:"device_id"`
	Format   string `json:"format"`
}
