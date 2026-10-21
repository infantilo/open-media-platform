// Package intercom ist das Modul „Intercom“ (UMSETZUNG.md Kapitel 47): Kanäle, Teilnehmer (Panels, Rollenplätze,
// Programmquellen), Gast-Zugänge und die Weitergabe an den Echtzeit-Node `omp-intercom`. Die Konfiguration ist ein Dokument
// im Einstellungsspeicher; der Node hält keinen eigenen Dauerzustand und bekommt sie regelmäßig zurück.
package intercom

import (
	"context"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

// Funktionsrechte.
const (
	FeatUse   = "intercom.use"
	FeatAdmin = "intercom.admin"
)

func (m *Module) Mount(r module.Routes, d module.Deps) error {
	a := &api{svc: m.service(d), access: d.Access}
	r.Handle("GET /api/v1/intercom/config", module.Feature("intercom.admin"), a.getConfig())
	r.Handle("PUT /api/v1/intercom/config", module.Feature("intercom.admin"), a.putConfig())
	r.Handle("POST /api/v1/intercom/parties/{id}/rotate-token", module.Feature("intercom.admin"), a.rotate())
	r.Handle("GET /api/v1/intercom/guests", module.Feature("intercom.admin"), a.listGuests())
	r.Handle("POST /api/v1/intercom/guests", module.Feature("intercom.admin"), a.createGuest())
	r.Handle("DELETE /api/v1/intercom/guests/{id}", module.Feature("intercom.admin"), a.deleteGuest())
	r.Handle("GET /api/v1/intercom/panels", module.Feature("intercom.use", "intercom.admin"), a.panels())
	r.Handle("GET /api/v1/intercom/status", module.Feature("intercom.use", "intercom.admin"), a.status())
	return nil
}

// Start: periodischer Abgleich mit den Nodes (nur auf dem Raft-Leader).
func (m *Module) Start(ctx context.Context, d module.Deps) error {
	go m.service(d).Run(ctx)
	return nil
}

func (*Module) Features() []module.FeatureDef {
	grp := map[string]string{"de": "Intercom", "en": "Intercom"}
	return []module.FeatureDef{
		{ID: FeatUse, Group: grp,
			Label:       map[string]string{"de": "Intercom nutzen", "en": "Use intercom"},
			Description: map[string]string{"de": "Eigene Sprechstelle (Panel) öffnen und sprechen/hören.", "en": "Open the own intercom panel and talk/listen."}},
		{ID: FeatAdmin, Group: grp,
			Label:       map[string]string{"de": "Intercom einrichten", "en": "Configure intercom"},
			Description: map[string]string{"de": "Kanäle, Teilnehmer, Rollenplätze und Gast-Zugänge verwalten.", "en": "Manage channels, parties, seats and guest access."}},
	}
}

// UI: Admin-Untertab (Einrichtung) und Kachel für die Operator-Konsole (eigenes Panel).
func (*Module) UI() []module.UITab {
	return []module.UITab{{
		ID: "intercom", Placement: "admin:production",
		Group:   map[string]string{"de": "Produktion", "en": "Production"},
		Label:   map[string]string{"de": "Intercom", "en": "Intercom"},
		Element: "omp-intercom-admin", Bundle: "/dist/modules/intercom.js",
	}}
}

func (*Module) Tiles() []module.UITile {
	return []module.UITile{{
		ID:      "intercom",
		Label:   map[string]string{"de": "Intercom", "en": "Intercom"},
		Needs:   []string{FeatUse},
		Element: "omp-intercom-tile", Bundle: "/dist/modules/intercom.js",
	}}
}
