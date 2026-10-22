package extsvc

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

// Manifest beschreibt einen Dienst, der in einem Node läuft (`GET <node>/service.json`): was das Gateway über ihn
// wissen muss. Alles, was nicht im Manifest steht, ist verboten (Routen ohne Eintrag antworten mit 404).
type Manifest struct {
	// Name ist eindeutig und stabil (`/api/v1/ext/<Name>/…`).
	Name    string `json:"name"`
	Version int    `json:"version"`
	// Base: Pfadpräfix der Dienst-Routen am Node (z. B. "/service").
	Base string `json:"base"`
	// Features: Funktionsrechte des Dienstes; sie erscheinen im Rechte-Katalog wie die eines Moduls.
	Features []module.FeatureDef `json:"features,omitempty"`
	Routes   []RouteDef          `json:"routes"`
	UI       []module.UITab      `json:"ui,omitempty"`
	Tiles    []module.UITile     `json:"tiles,omitempty"`
	// Metrics: Pfad (relativ zu Base) mit Metriken im Prometheus-Textformat.
	Metrics string `json:"metrics,omitempty"`
	// Import: Altdaten aus dem Einstellungsspeicher, die der Dienst einmalig übernimmt.
	Import *ImportDef `json:"import,omitempty"`
	// Backup: Pfad (relativ zu Base), unter dem der Dienst seinen Stand als Sicherungskopie liefert. Das Gateway legt sie in
	// der Datenbank ab (Datensicherung des Orchestrators) und spielt sie über `Import.Path` ein, wenn der Dienst leer startet.
	Backup string `json:"backup,omitempty"`
}

// RouteDef ist eine erlaubte Route: Methode, Pfad relativ zum Dienst (`{name}` = ein Segment) und die Funktionsrechte, von
// denen **eines** genügt. Ohne Rechte ist eine Route ungültig (nie offen).
type RouteDef struct {
	Method   string   `json:"method"`
	Path     string   `json:"path"`
	Features []string `json:"features"`
}

// ImportDef: `SettingsKey` im Einstellungsspeicher wird einmal per POST an `Path` des Dienstes gegeben, sobald der Dienst
// `Importable` meldet (seine Konfiguration ist leer).
type ImportDef struct {
	SettingsKey string `json:"settings_key"`
	Path        string `json:"path"`
	Importable  bool   `json:"importable"`
}

var (
	nameRe    = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)
	featureRe = regexp.MustCompile(`^[a-z0-9._-]+$`)
)

var methods = map[string]bool{"GET": true, "POST": true, "PUT": true, "PATCH": true, "DELETE": true}

// Validate prüft ein Manifest streng: ein fehlerhaftes wird nicht übernommen.
func (m Manifest) Validate() error {
	if !nameRe.MatchString(m.Name) {
		return fmt.Errorf("Name %q ungültig", m.Name)
	}
	if !strings.HasPrefix(m.Base, "/") || strings.Contains(m.Base, "..") || strings.Contains(m.Base, "?") {
		return fmt.Errorf("Base %q ungültig", m.Base)
	}
	declared := map[string]bool{}
	for _, f := range m.Features {
		if !featureRe.MatchString(f.ID) {
			return fmt.Errorf("Funktionsrecht %q ungültig", f.ID)
		}
		if !strings.HasPrefix(f.ID, m.Name+".") {
			return fmt.Errorf("Funktionsrecht %q muss mit %q beginnen", f.ID, m.Name+".")
		}
		declared[f.ID] = true
	}
	for _, r := range m.Routes {
		if !methods[r.Method] {
			return fmt.Errorf("Route %s %s: Methode unbekannt", r.Method, r.Path)
		}
		if !strings.HasPrefix(r.Path, "/") || strings.Contains(r.Path, "..") || strings.Contains(r.Path, "?") {
			return fmt.Errorf("Route %s %s: Pfad ungültig", r.Method, r.Path)
		}
		if len(r.Features) == 0 {
			return fmt.Errorf("Route %s %s: ohne Funktionsrecht", r.Method, r.Path)
		}
		for _, f := range r.Features {
			if !declared[f] {
				return fmt.Errorf("Route %s %s: Funktionsrecht %q nicht deklariert", r.Method, r.Path, f)
			}
		}
	}
	for _, t := range m.UI {
		if t.Element == "" || t.Bundle == "" || !strings.HasPrefix(t.Bundle, "/") {
			return fmt.Errorf("UI-Tab %q ohne Element/Bundle", t.ID)
		}
	}
	for _, t := range m.Tiles {
		if t.Element == "" || t.Bundle == "" || !strings.HasPrefix(t.Bundle, "/") {
			return fmt.Errorf("Kachel %q ohne Element/Bundle", t.ID)
		}
	}
	if m.Metrics != "" && !strings.HasPrefix(m.Metrics, "/") {
		return fmt.Errorf("Metrikpfad %q ungültig", m.Metrics)
	}
	if m.Import != nil && (m.Import.SettingsKey == "" || !strings.HasPrefix(m.Import.Path, "/")) {
		return fmt.Errorf("Import unvollständig")
	}
	if m.Backup != "" && !strings.HasPrefix(m.Backup, "/") {
		return fmt.Errorf("Sicherungspfad %q ungültig", m.Backup)
	}
	return nil
}

// match prüft, ob `path` zur Muster-Route passt (`{x}` = genau ein nicht leeres Segment).
func matchPath(pattern, path string) bool {
	ps := strings.Split(strings.Trim(pattern, "/"), "/")
	xs := strings.Split(strings.Trim(path, "/"), "/")
	if len(ps) != len(xs) {
		return false
	}
	for i := range ps {
		if strings.HasPrefix(ps[i], "{") && strings.HasSuffix(ps[i], "}") {
			if xs[i] == "" {
				return false
			}
			continue
		}
		if ps[i] != xs[i] {
			return false
		}
	}
	return true
}

// Route sucht die Route für Methode und Pfad (relativ zum Dienst).
func (m Manifest) Route(method, path string) (RouteDef, bool) {
	for _, r := range m.Routes {
		if r.Method == method && matchPath(r.Path, path) {
			return r, true
		}
	}
	return RouteDef{}, false
}
