package cloud

import (
	"context"
	"fmt"
	"time"
)

// Service bündelt Manager, Controller und Reservierungen für die HTTP-API.
type Service struct {
	Manager      *Manager
	Controller   *PoolController
	Reservations ReservationStore
	Policies     PolicyStore
	Now          func() time.Time
}

// PoolInfo beschreibt einen konfigurierten Pool für die Anzeige.
type PoolInfo struct {
	Name         string `json:"name"`
	InstanceType string `json:"instanceType"`
	Region       string `json:"region"`
	Min          int    `json:"min"`
	Max          int    `json:"max"`
}

func (s *Service) Pools() []PoolInfo {
	out := make([]PoolInfo, 0, len(s.Manager.pools))
	for _, p := range s.Manager.pools {
		out = append(out, PoolInfo{Name: p.Name, InstanceType: p.InstanceType, Region: p.Region, Min: p.Min, Max: p.Max})
	}
	sortPools(out)
	return out
}

func sortPools(p []PoolInfo) {
	for i := 1; i < len(p); i++ {
		for j := i; j > 0 && p[j].Name < p[j-1].Name; j-- {
			p[j], p[j-1] = p[j-1], p[j]
		}
	}
}

func (s *Service) Hosts() []Host     { return s.Manager.Hosts() }
func (s *Service) Actions() []Action { return s.Controller.Actions() }
func (s *Service) List(from, to time.Time) ([]Reservation, error) {
	return s.Reservations.List(from, to)
}

// Create validiert gegen die Pools und legt die Reservierung an.
func (s *Service) Create(in ReservationInput, by string) (Reservation, error) {
	if err := in.Validate(s.Manager.pools); err != nil {
		return Reservation{}, err
	}
	return s.Reservations.Create(in, by)
}

func (s *Service) Delete(id string) error { return s.Reservations.Delete(id) }

// Release beendet einen Host auf ausdrücklichen Wunsch (geordnet über Draining).
func (s *Service) Release(ctx context.Context, id string) error { return s.Manager.Release(ctx, id) }

// Policy liefert die Autoscaling-Regeln eines Pools (Standard: aus).
func (s *Service) Policy(pool string) (Policy, error) {
	if _, ok := s.Manager.pools[pool]; !ok {
		return Policy{}, fmt.Errorf("cloud: unknown pool %q", pool)
	}
	return s.Policies.Get(pool)
}

// SetPolicy validiert gegen den Pool und speichert die Regeln.
func (s *Service) SetPolicy(p Policy, by string) error {
	pl, ok := s.Manager.pools[p.Pool]
	if !ok {
		return fmt.Errorf("%w: unknown pool %q", ErrPolicyValidation, p.Pool)
	}
	if err := p.Validate(pl); err != nil {
		return err
	}
	return s.Policies.Put(p, by)
}

func (s *Service) Suggestions() []Suggestion { return s.Controller.Suggestions() }
func (s *Service) Accept(ctx context.Context, id, by string) error {
	return s.Controller.Accept(ctx, id, by)
}
func (s *Service) Dismiss(id string) bool                         { return s.Controller.Dismiss(id) }
func (s *Service) Costs(ctx context.Context) ([]PoolCosts, error) { return s.Controller.Costs(ctx) }
