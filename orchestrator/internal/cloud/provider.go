// Package cloud: dynamische Cloud-Hosts (ARCHITECTURE.md §27, UMSETZUNG.md Kapitel 35).
// Kern ohne Anbieter-SDK: die Schnittstelle [Provider], ein Mock-Adapter für Tests und
// Simulation und der Host-Lebenszyklus ([Manager]). Echte Adapter (AWS) hängen hinter
// einem Build-Tag und gehören nicht zu diesem Paket.
package cloud

import (
	"context"
	"errors"
	"time"
)

// InstanceType beschreibt eine buchbare Instanzart samt Preis.
type InstanceType struct {
	Name         string  `json:"name"`
	VCPU         int     `json:"vcpu"`
	MemGB        float64 `json:"memGb"`
	GPU          int     `json:"gpu"`
	PricePerHour float64 `json:"pricePerHour"`
	Currency     string  `json:"currency"`
}

// Tag-Schlüssel, mit denen jede Cloud-Ressource markiert wird (Kostenzuordnung,
// Abgleich verwaister Instanzen).
const (
	TagDeployment = "omp-deployment"
	TagPool       = "omp-pool"
	TagHost       = "omp-host"
)

// LaunchRequest ist der Wunsch nach einer neuen Instanz.
type LaunchRequest struct {
	InstanceType string
	Region       string
	// UserData enthält die Bootstrap-Konfiguration des Host-Agents (inkl. einmaligem Token).
	UserData string
	Tags     map[string]string
	Label    string
}

// InstanceRef identifiziert eine Instanz beim Anbieter.
type InstanceRef struct {
	Provider string `json:"provider"`
	ID       string `json:"id"`
}

// State ist der Zustand einer Instanz aus Sicht des Anbieters.
type State string

const (
	StatePending    State = "pending"
	StateRunning    State = "running"
	StateStopping   State = "stopping"
	StateTerminated State = "terminated"
	StateUnknown    State = "unknown"
)

// InstanceInfo ist ein Eintrag aus [Provider.List].
type InstanceInfo struct {
	Ref   InstanceRef
	State State
	Tags  map[string]string
	Type  string
}

// CostReport sind vom Anbieter abgerechnete Kosten mit Datenstand — nie mit Schätzungen mischen.
type CostReport struct {
	From, To time.Time
	Amount   float64
	Currency string
	// AsOf: bis wann der Anbieter Daten geliefert hat (Abrechnungsdaten kommen verzögert).
	AsOf time.Time
}

// ErrNotFound: die Instanz kennt der Anbieter nicht (mehr).
var ErrNotFound = errors.New("cloud: instance not found")

// ErrSuggestionNotFound: der Vorschlag existiert nicht (mehr).
var ErrSuggestionNotFound = errors.New("cloud: suggestion not found")

// ErrBudget: der Budgetdeckel verbietet den Schritt.
var ErrBudget = errors.New("cloud: budget cap")

// Provider ist die Anbieter-Schnittstelle (§27.2).
type Provider interface {
	Name() string
	Catalog(ctx context.Context, region string) ([]InstanceType, error)
	Launch(ctx context.Context, req LaunchRequest) (InstanceRef, error)
	Describe(ctx context.Context, ref InstanceRef) (State, error)
	Terminate(ctx context.Context, ref InstanceRef) error
	// List liefert alle Instanzen, die alle Tags in filter tragen (auch beendete, solange sichtbar).
	List(ctx context.Context, filter map[string]string) ([]InstanceInfo, error)
	ActualCost(ctx context.Context, from, to time.Time, filter map[string]string) (CostReport, error)
}
