package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
)

// Node-Typ-weite (nicht Instanz-weite) Einstellungen für omp-mxf-player
// (Nutzerwunsch 2026-08-06: "Shuffle Presets und Output Groups
// dynamisch... definieren, für einfachere künftige Anpassungen" statt
// des bisher in nodes/omp-mxf-player/src/presets.rs hart codierten
// Standards). Persistiert über den generischen NodeSettingsStore
// (node_type_settings-Tabelle) — dieser Handler ist die einzige
// Stelle, die den Blob-Inhalt tatsächlich versteht/validiert.
//
// Änderungen an den Programmgruppen wirken sich erst nach einem
// Neustart der jeweiligen omp-mxf-player-Instanz aus (sie registrieren
// bei jedem Start feste NMOS-Sender pro Gruppe, s.
// nodes/omp-mxf-player/src/pipeline.rs — Nutzerentscheidung: kein
// neuer Live-Sender-Add/Remove-Mechanismus, alle anderen Nodes im
// System handhaben ihre Sender-Liste genauso restart-on-apply).

const mxfPlayerNodeType = "omp-mxf-player"

type mxfProgramGroup struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Channels int    `json:"channels"`
}

type mxfRoute struct {
	SrcTrack     int    `json:"srcTrack"`
	Group        string `json:"group"`
	GroupChannel int    `json:"groupChannel"`
}

type mxfPreset struct {
	ID     string     `json:"id"`
	Label  string     `json:"label"`
	Routes []mxfRoute `json:"routes"`
}

type mxfPlayerSettings struct {
	Groups  []mxfProgramGroup `json:"groups"`
	Presets []mxfPreset       `json:"presets"`
}

// defaultMxfPlayerSettings ist der ORF-Standard aus `Audio
// Tonspurerweiterung Q3 2026 PD.pdf`, identisch zu den bisherigen
// `nodes/omp-mxf-player/src/presets.rs`-Konstanten übertragen — dient
// als Antwort, solange kein Admin je etwas über PUT gespeichert hat
// (unverändertes Verhalten für jeden, der die neue Einstellungsseite
// nie öffnet).
func defaultMxfPlayerSettings() mxfPlayerSettings {
	return mxfPlayerSettings{
		Groups: []mxfProgramGroup{
			{ID: "pt", Label: "Programmton", Channels: 2},
			{ID: "ad", Label: "Hörfilm/AD", Channels: 2},
			{ID: "ot", Label: "Originalton", Channels: 2},
			{ID: "dolbye", Label: "Dolby E", Channels: 2},
			{ID: "surround51", Label: "5.1 Diskret", Channels: 6},
		},
		Presets: []mxfPreset{
			{ID: "mono", Label: "Mono", Routes: []mxfRoute{
				{SrcTrack: 1, Group: "pt", GroupChannel: 0},
				{SrcTrack: 1, Group: "pt", GroupChannel: 1},
			}},
			{ID: "stereo", Label: "Stereo", Routes: []mxfRoute{
				{SrcTrack: 1, Group: "pt", GroupChannel: 0},
				{SrcTrack: 2, Group: "pt", GroupChannel: 1},
			}},
			{ID: "2ton-mono", Label: "2-Ton-Mono", Routes: []mxfRoute{
				{SrcTrack: 1, Group: "pt", GroupChannel: 0},
				{SrcTrack: 1, Group: "pt", GroupChannel: 1},
				{SrcTrack: 2, Group: "ad", GroupChannel: 0},
				{SrcTrack: 2, Group: "ad", GroupChannel: 1},
			}},
			{ID: "stereo-hoerfilm", Label: "Stereo/Hörfilm", Routes: []mxfRoute{
				{SrcTrack: 1, Group: "pt", GroupChannel: 0},
				{SrcTrack: 2, Group: "pt", GroupChannel: 1},
				{SrcTrack: 5, Group: "ad", GroupChannel: 0},
				{SrcTrack: 6, Group: "ad", GroupChannel: 1},
			}},
			{ID: "stereo-ot-56", Label: "Stereo/OT 5,6", Routes: []mxfRoute{
				{SrcTrack: 1, Group: "pt", GroupChannel: 0},
				{SrcTrack: 2, Group: "pt", GroupChannel: 1},
				{SrcTrack: 5, Group: "ot", GroupChannel: 0},
				{SrcTrack: 6, Group: "ot", GroupChannel: 1},
			}},
			{ID: "stereo-ot", Label: "Stereo/OT", Routes: []mxfRoute{
				{SrcTrack: 1, Group: "pt", GroupChannel: 0},
				{SrcTrack: 2, Group: "pt", GroupChannel: 1},
				{SrcTrack: 7, Group: "ot", GroupChannel: 0},
				{SrcTrack: 8, Group: "ot", GroupChannel: 1},
			}},
			{ID: "stereo-hoerfilm-ot", Label: "Stereo/Hörfilm/OT", Routes: []mxfRoute{
				{SrcTrack: 1, Group: "pt", GroupChannel: 0},
				{SrcTrack: 2, Group: "pt", GroupChannel: 1},
				{SrcTrack: 5, Group: "ad", GroupChannel: 0},
				{SrcTrack: 6, Group: "ad", GroupChannel: 1},
				{SrcTrack: 7, Group: "ot", GroupChannel: 0},
				{SrcTrack: 8, Group: "ot", GroupChannel: 1},
			}},
			{ID: "stereo-dolbye", Label: "Stereo/Dolby E", Routes: []mxfRoute{
				{SrcTrack: 1, Group: "pt", GroupChannel: 0},
				{SrcTrack: 2, Group: "pt", GroupChannel: 1},
				{SrcTrack: 3, Group: "dolbye", GroupChannel: 0},
				{SrcTrack: 4, Group: "dolbye", GroupChannel: 1},
			}},
			{ID: "stereo-dolbye-hoerfilm", Label: "Stereo/Dolby E/Hörfilm", Routes: []mxfRoute{
				{SrcTrack: 1, Group: "pt", GroupChannel: 0},
				{SrcTrack: 2, Group: "pt", GroupChannel: 1},
				{SrcTrack: 3, Group: "dolbye", GroupChannel: 0},
				{SrcTrack: 4, Group: "dolbye", GroupChannel: 1},
				{SrcTrack: 5, Group: "ad", GroupChannel: 0},
				{SrcTrack: 6, Group: "ad", GroupChannel: 1},
			}},
			{ID: "stereo-dolbye-ot-56", Label: "Stereo/Dolby E/OT 5,6", Routes: []mxfRoute{
				{SrcTrack: 1, Group: "pt", GroupChannel: 0},
				{SrcTrack: 2, Group: "pt", GroupChannel: 1},
				{SrcTrack: 3, Group: "dolbye", GroupChannel: 0},
				{SrcTrack: 4, Group: "dolbye", GroupChannel: 1},
				{SrcTrack: 5, Group: "ot", GroupChannel: 0},
				{SrcTrack: 6, Group: "ot", GroupChannel: 1},
			}},
			{ID: "stereo-dolbye-ot", Label: "Stereo/Dolby E/OT", Routes: []mxfRoute{
				{SrcTrack: 1, Group: "pt", GroupChannel: 0},
				{SrcTrack: 2, Group: "pt", GroupChannel: 1},
				{SrcTrack: 3, Group: "dolbye", GroupChannel: 0},
				{SrcTrack: 4, Group: "dolbye", GroupChannel: 1},
				{SrcTrack: 7, Group: "ot", GroupChannel: 0},
				{SrcTrack: 8, Group: "ot", GroupChannel: 1},
			}},
			{ID: "stereo-dolbye-hoerfilm-ot", Label: "Stereo/Dolby E/Hörfilm/OT", Routes: []mxfRoute{
				{SrcTrack: 1, Group: "pt", GroupChannel: 0},
				{SrcTrack: 2, Group: "pt", GroupChannel: 1},
				{SrcTrack: 3, Group: "dolbye", GroupChannel: 0},
				{SrcTrack: 4, Group: "dolbye", GroupChannel: 1},
				{SrcTrack: 5, Group: "ad", GroupChannel: 0},
				{SrcTrack: 6, Group: "ad", GroupChannel: 1},
				{SrcTrack: 7, Group: "ot", GroupChannel: 0},
				{SrcTrack: 8, Group: "ot", GroupChannel: 1},
			}},
			{ID: "stereo-51-diskret", Label: "Stereo/5.1 diskret", Routes: []mxfRoute{
				{SrcTrack: 1, Group: "pt", GroupChannel: 0},
				{SrcTrack: 2, Group: "pt", GroupChannel: 1},
				{SrcTrack: 3, Group: "surround51", GroupChannel: 0},
				{SrcTrack: 4, Group: "surround51", GroupChannel: 1},
				{SrcTrack: 5, Group: "surround51", GroupChannel: 2},
				{SrcTrack: 6, Group: "surround51", GroupChannel: 3},
				{SrcTrack: 7, Group: "surround51", GroupChannel: 4},
				{SrcTrack: 8, Group: "surround51", GroupChannel: 5},
			}},
		},
	}
}

// handleGetMxfPlayerSettings liefert GET
// /api/v1/node-types/omp-mxf-player/settings — für jeden
// authentifizierten Nutzer lesbar (wie GET /api/v1/catalog), auch von
// einer omp-mxf-player-Instanz selbst per Service-Token beim Start
// abgerufen (s. nodes/omp-mxf-player/src/main.rs).
func handleGetMxfPlayerSettings(store NodeSettingsStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, err := store.Get(mxfPlayerNodeType)
		if errors.Is(err, launcher.ErrNodeSettingsNotFound) {
			writeJSON(w, http.StatusOK, defaultMxfPlayerSettings())
			return
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}
}

// handlePutMxfPlayerSettings liefert PUT
// /api/v1/node-types/omp-mxf-player/settings (admin-only,
// requireVerbGlobal(authz.VerbAdmin, ...) in server.go — dieselbe
// Schwelle wie POST /api/v1/catalog). Ersetzt das gesamte Dokument
// (bewusstes Ganz-Speichern statt PATCH-per-Feld,
// feedback_editors_need_explicit_save) nach Validierung.
func handlePutMxfPlayerSettings(store NodeSettingsStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var settings mxfPlayerSettings
		if err := json.NewDecoder(r.Body).Decode(&settings); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		if err := validateMxfPlayerSettings(settings); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		data, err := json.Marshal(settings)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if err := store.Put(mxfPlayerNodeType, data); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, settings)
	}
}

// validateMxfPlayerSettings prüft die Invarianten, die
// nodes/omp-mxf-player/src/pipeline.rs beim Aufbau der Pipeline
// voraussetzt (s. dortige presets::matrix_for-Doku): eindeutige,
// nicht-leere IDs, plausible Kanalzahlen, jede Route referenziert eine
// tatsächlich vorhandene Gruppe innerhalb ihrer Kanalzahl, und
// mindestens eine Gruppe/ein Preset bleibt übrig (sonst hätte die
// Instanz keine Sender/keine Auswahl mehr).
func validateMxfPlayerSettings(s mxfPlayerSettings) error {
	if len(s.Groups) == 0 {
		return errors.New("at least one program group is required")
	}
	if len(s.Presets) == 0 {
		return errors.New("at least one shuffle preset is required")
	}

	groupChannels := make(map[string]int, len(s.Groups))
	seenGroup := make(map[string]bool, len(s.Groups))
	for _, g := range s.Groups {
		if g.ID == "" {
			return errors.New("group id must not be empty")
		}
		if seenGroup[g.ID] {
			return fmt.Errorf("duplicate group id: %s", g.ID)
		}
		seenGroup[g.ID] = true
		if g.Label == "" {
			return fmt.Errorf("group %s: label must not be empty", g.ID)
		}
		if g.Channels < 1 || g.Channels > 64 {
			return fmt.Errorf("group %s: channels must be between 1 and 64", g.ID)
		}
		groupChannels[g.ID] = g.Channels
	}

	seenPreset := make(map[string]bool, len(s.Presets))
	for _, p := range s.Presets {
		if p.ID == "" {
			return errors.New("preset id must not be empty")
		}
		if seenPreset[p.ID] {
			return fmt.Errorf("duplicate preset id: %s", p.ID)
		}
		seenPreset[p.ID] = true
		if p.Label == "" {
			return fmt.Errorf("preset %s: label must not be empty", p.ID)
		}
		for _, route := range p.Routes {
			channels, ok := groupChannels[route.Group]
			if !ok {
				return fmt.Errorf("preset %s: route references unknown group %q", p.ID, route.Group)
			}
			if route.GroupChannel < 0 || route.GroupChannel >= channels {
				return fmt.Errorf("preset %s: route groupChannel %d out of range for group %s (%d channels)", p.ID, route.GroupChannel, route.Group, channels)
			}
			if route.SrcTrack < 1 {
				return fmt.Errorf("preset %s: route srcTrack must be >= 1", p.ID)
			}
		}
	}
	return nil
}
