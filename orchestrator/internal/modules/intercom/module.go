// Package intercom ist das Modul „Intercom“ (UMSETZUNG.md Kapitel 47): Kanäle, Teilnehmer (Panels, Rollenplätze,
// Programmquellen), Gast-Zugänge und die Weitergabe an den Echtzeit-Node `omp-intercom`. Die Konfiguration ist ein Dokument
// im Einstellungsspeicher; der Node hält keinen eigenen Dauerzustand und bekommt sie regelmäßig zurück.
package intercom

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"time"

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

// WriteMetrics: Kennzahlen aus dem Status des Intercom-Nodes für GET /metrics (ohne laufenden Node: nichts).
func (m *Module) WriteMetrics(w io.Writer) {
	m.mu.Lock()
	svc := m.svc
	m.mu.Unlock()
	if svc == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	raw, err := svc.Status(ctx)
	if err != nil {
		return
	}
	var st struct {
		Parties []struct {
			Online    bool  `json:"online"`
			Underruns int64 `json:"underruns"`
		} `json:"parties"`
		LateTicks int64 `json:"late_ticks"`
		MaxTickUS int64 `json:"max_tick_us"`
	}
	if json.Unmarshal(raw, &st) != nil {
		return
	}
	var online, under int64
	for _, p := range st.Parties {
		if p.Online {
			online++
		}
		under += p.Underruns
	}
	fmt.Fprintf(w, "# HELP omp_intercom_parties Intercom-Teilnehmer\n# TYPE omp_intercom_parties gauge\n")
	fmt.Fprintf(w, "omp_intercom_parties{state=\"online\"} %d\nomp_intercom_parties{state=\"total\"} %d\n", online, len(st.Parties))
	fmt.Fprintf(w, "# HELP omp_intercom_late_ticks_total Verspätete 20-ms-Mischtakte\n# TYPE omp_intercom_late_ticks_total counter\nomp_intercom_late_ticks_total %d\n", st.LateTicks)
	fmt.Fprintf(w, "# HELP omp_intercom_max_tick_seconds Längster Mischdurchlauf\n# TYPE omp_intercom_max_tick_seconds gauge\nomp_intercom_max_tick_seconds %g\n", float64(st.MaxTickUS)/1e6)
	fmt.Fprintf(w, "# HELP omp_intercom_underruns_total Eingangspuffer leer beim Abholen (Aussetzer)\n# TYPE omp_intercom_underruns_total counter\nomp_intercom_underruns_total %d\n", under)
}
