// Package connection implementiert einen minimalen IS-05-Connection-API-
// Endpunkt für die Receiver des Mock-Nodes (staged/active) — Grundlage
// für das IS-05-PATCH aus Schritt B1 (UMSETZUNG.md). Feldnamen geprüft
// gegen AMWA-TV/is-05 (Branch v1.1.x, APIs/schemas/receiver-*.json,
// activation-schema.json). Sender-seitige Connection-Endpoints und die
// Discovery-Subresourcen (constraints/, transporttype/) sind für B1
// nicht nötig und daher bewusst nicht implementiert (siehe
// docs/decisions.md).
package connection

import "sync"

// Activation beschreibt, wann eine gestagte Änderung aktiv wird.
type Activation struct {
	Mode          *string `json:"mode"`
	RequestedTime *string `json:"requested_time"`
}

// TransportFile ist Teil des vollständigen IS-05-Receiver-Resource;
// der Mock-Node routet keine echten Transport-Files, daher immer null/null.
type TransportFile struct {
	Data *string `json:"data"`
	Type *string `json:"type"`
}

// ReceiverResource ist die staged/active-Repräsentation eines Receivers
// (receiver-stage-schema.json / receiver-response-schema.json).
type ReceiverResource struct {
	SenderID        *string          `json:"sender_id"`
	MasterEnable    bool             `json:"master_enable"`
	Activation      Activation       `json:"activation"`
	TransportFile   TransportFile    `json:"transport_file"`
	TransportParams []map[string]any `json:"transport_params"`
}

func defaultResource() ReceiverResource {
	return ReceiverResource{
		TransportFile:   TransportFile{},
		TransportParams: []map[string]any{{}},
	}
}

// PatchRequest ist der von PATCH .../staged akzeptierte Body. Anders als
// im vollen IS-05-Standard (der auch Teil-Updates einzelner Felder
// erlaubt) erwartet dieser Mock-Node-Endpoint immer alle drei Felder —
// ausreichend, weil er nur vom eigenen Orchestrator-Proxy angesprochen
// wird (siehe docs/decisions.md, Schritt B1).
type PatchRequest struct {
	SenderID     *string    `json:"sender_id"`
	MasterEnable bool       `json:"master_enable"`
	Activation   Activation `json:"activation"`
}

// ReceiverStore hält staged/active-Zustand für eine feste Menge von
// Receiver-IDs, nebenläufig sicher nutzbar.
type ReceiverStore struct {
	mu     sync.RWMutex
	staged map[string]ReceiverResource
	active map[string]ReceiverResource
}

// NewReceiverStore erstellt einen Store mit unverbundenen Receivern.
func NewReceiverStore(receiverIDs []string) *ReceiverStore {
	s := &ReceiverStore{
		staged: make(map[string]ReceiverResource, len(receiverIDs)),
		active: make(map[string]ReceiverResource, len(receiverIDs)),
	}
	for _, id := range receiverIDs {
		s.staged[id] = defaultResource()
		s.active[id] = defaultResource()
	}
	return s
}

// Staged liefert den aktuellen staged-Zustand eines Receivers.
func (s *ReceiverStore) Staged(id string) (ReceiverResource, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.staged[id]
	return r, ok
}

// Active liefert den aktuellen active-Zustand eines Receivers.
func (s *ReceiverStore) Active(id string) (ReceiverResource, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.active[id]
	return r, ok
}

// PatchStaged wendet req auf den staged-Zustand von id an. Ist
// activation.mode == "activate_immediate", wird der neue Zustand sofort
// auch in active übernommen. Liefert false, wenn id unbekannt ist.
func (s *ReceiverStore) PatchStaged(id string, req PatchRequest) (ReceiverResource, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	existing, ok := s.staged[id]
	if !ok {
		return ReceiverResource{}, false
	}

	updated := existing
	updated.SenderID = req.SenderID
	updated.MasterEnable = req.MasterEnable
	updated.Activation = req.Activation
	s.staged[id] = updated

	if req.Activation.Mode != nil && *req.Activation.Mode == "activate_immediate" {
		s.active[id] = updated
	}

	return updated, true
}
