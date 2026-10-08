// Package cloud ist das Cloud-Modul des Orchestrators (UMSETZUNG.md Kapitel 36). Übergangsstand 36.3: das Modul bringt
// bisher nur seine Oberfläche mit (Tab „Cloud“ samt ESM-Bundle); die Routen und der Controller wandern mit 36.6 hierher.
package cloud

import (
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

// Module ist das Cloud-Modul.
type Module struct{}

func (Module) Name() string { return "cloud" }

// Mount: noch keine Routen (36.6).
func (Module) Mount(module.Routes, module.Deps) error { return nil }

// UI: der Tab „Cloud“ hinter „Hosts“; das Bundle liefert der Dateiserver der Shell (`make ui` baut ui/dist/modules/cloud.js).
func (Module) UI() []module.UITab {
	return []module.UITab{{
		ID: "cloud", Placement: "main", After: "hosts",
		Label:   map[string]string{"de": "Cloud", "en": "Cloud"},
		Element: "omp-cloud-view", Bundle: "/dist/modules/cloud.js",
	}}
}
