package mcr

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

var (
	ErrNotFound   = errors.New("mcr: nicht gefunden")
	ErrState      = errors.New("mcr: im aktuellen Zustand nicht erlaubt")
	ErrValidation = errors.New("mcr: ungültige Eingabe")
)

// ValidationError sammelt die Probleme einer Eingabe (HTTP 400).
type ValidationError struct{ Problems []string }

func (e *ValidationError) Error() string {
	return "mcr: ungültige Eingabe: " + strings.Join(e.Problems, "; ")
}
func (e *ValidationError) Is(t error) bool { return t == ErrValidation }

func bad(format string, a ...any) error {
	return &ValidationError{Problems: []string{fmt.Sprintf(format, a...)}}
}

// Zustände eines Events (ARCHITECTURE §33.2 M8).
const (
	StatePlanned   = "planned"
	StateTesting   = "testing"
	StateLive      = "live"
	StateTeardown  = "teardown"
	StateDone      = "done"
	StateCancelled = "cancelled"
)

// Leitungsarten.
const (
	KindSRT    = "srt"
	KindRIST   = "rist"
	KindST2110 = "st2110"
	KindHLS    = "hls"
	KindMXL    = "mxl"
)

var lineKinds = map[string]bool{KindSRT: true, KindRIST: true, KindST2110: true, KindHLS: true, KindMXL: true}

// Rollen je Event (ARCHITECTURE §33.2 M11).
const (
	RoleLead        = "lead"
	RoleEngineer    = "engineer"
	RoleCommentator = "commentator"
	RoleViewer      = "viewer"
)

var eventRoles = map[string]bool{RoleLead: true, RoleEngineer: true, RoleCommentator: true, RoleViewer: true}

// Line ist eine Leitung eines Events (oder einer Vorlage). Alle JSON-Felder sind Objekte; **Geheimnisse stehen nie darin**
// (nur der Schlüsselname, z. B. `passphraseKey`, siehe checkNoSecrets).
type Line struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Kind        string          `json:"kind"`
	Transport   json.RawMessage `json:"transport,omitempty"`
	Normalize   json.RawMessage `json:"normalize,omitempty"`
	Avsync      json.RawMessage `json:"avsync,omitempty"`
	Record      json.RawMessage `json:"record,omitempty"`
	Intercom    json.RawMessage `json:"intercom,omitempty"`
	HouseFormat json.RawMessage `json:"houseFormat,omitempty"`
	Position    int             `json:"position"`
}

type Member struct {
	SubjectType string `json:"subjectType"` // user | group
	Subject     string `json:"subject"`
	Role        string `json:"role"`
}

type Template struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	Lines       []Line          `json:"lines"`
	HouseFormat json.RawMessage `json:"houseFormat,omitempty"`
	CreatedBy   string          `json:"createdBy,omitempty"`
	CreatedAt   time.Time       `json:"createdAt"`
	UpdatedAt   time.Time       `json:"updatedAt"`
}

type Event struct {
	ID           string          `json:"id"`
	Name         string          `json:"name"`
	TemplateID   string          `json:"templateId,omitempty"`
	State        string          `json:"state"`
	PlannedStart *time.Time      `json:"plannedStart,omitempty"`
	PlannedEnd   *time.Time      `json:"plannedEnd,omitempty"`
	WorkflowID   string          `json:"workflowId,omitempty"`
	Owner        string          `json:"owner,omitempty"`
	OwnerGroup   string          `json:"ownerGroup,omitempty"`
	HouseFormat  json.RawMessage `json:"houseFormat,omitempty"`
	Lines        []Line          `json:"lines"`
	Members      []Member        `json:"members"`
	// Warnings: Hinweise des Abgleichs (z. B. „Rückweg ohne Quelle“); leer = keine.
	Warnings  []string  `json:"warnings"`
	CreatedBy string    `json:"createdBy,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	// Nur in Antworten: wirksames Hausformat je Leitung (Vorgabe → Event → Leitung).
	Effective map[string]HouseFormat `json:"effectiveHouse,omitempty"`
}

// secretKeys: Feldnamen, die nie gespeichert werden (Vergleich ohne Groß-/Kleinschreibung). `passphraseKey` (Name eines
// Schlüssels in einer 0600-Datei) ist erlaubt, der Wert selbst nie.
var secretKeys = map[string]bool{"passphrase": true, "password": true, "secret": true, "token": true, "apikey": true, "privatekey": true}

// checkNoSecrets lehnt JSON ab, das ein Geheimnis-Feld trägt oder in einer Zeichenkette `passphrase=` enthält.
func checkNoSecrets(field string, raw json.RawMessage) error {
	if len(raw) == 0 {
		return nil
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return bad("%s: kein gültiges JSON", field)
	}
	var walk func(path string, v any) error
	walk = func(path string, v any) error {
		switch x := v.(type) {
		case map[string]any:
			for k, vv := range x {
				if secretKeys[strings.ToLower(k)] {
					return bad("%s: Feld „%s“ darf nie gespeichert werden (Geheimnisse nur über Schlüsselname, z. B. passphraseKey)", field, k)
				}
				if err := walk(path+"."+k, vv); err != nil {
					return err
				}
			}
		case []any:
			for _, vv := range x {
				if err := walk(path, vv); err != nil {
					return err
				}
			}
		case string:
			if strings.Contains(strings.ToLower(x), "passphrase=") {
				return bad("%s: Passphrase gehört nicht in eine Adresse", field)
			}
		}
		return nil
	}
	return walk(field, v)
}

func isObject(raw json.RawMessage) bool {
	s := strings.TrimSpace(string(raw))
	return strings.HasPrefix(s, "{")
}

// validateLine prüft eine Leitung (ohne Datenbank).
func validateLine(l *Line) error {
	if strings.TrimSpace(l.Name) == "" {
		return bad("Leitung ohne Namen")
	}
	if !lineKinds[l.Kind] {
		return bad("Leitung „%s“: Art „%s“ unbekannt (srt, rist, st2110, hls, mxl)", l.Name, l.Kind)
	}
	if err := validateTracks(*l); err != nil {
		return err
	}
	for name, raw := range map[string]json.RawMessage{"transport": l.Transport, "normalize": l.Normalize, "avsync": l.Avsync, "record": l.Record, "intercom": l.Intercom, "houseFormat": l.HouseFormat} {
		if len(raw) == 0 || strings.TrimSpace(string(raw)) == "null" {
			continue
		}
		if !isObject(raw) {
			return bad("Leitung „%s“: %s muss ein Objekt sein", l.Name, name)
		}
		if err := checkNoSecrets("Leitung „"+l.Name+"“ "+name, raw); err != nil {
			return err
		}
	}
	if _, err := ParseHouse(l.HouseFormat); err != nil {
		return bad("Leitung „%s“: %v", l.Name, err)
	}
	if len(l.Avsync) > 0 {
		var a struct {
			Mode string `json:"mode"`
		}
		_ = json.Unmarshal(l.Avsync, &a)
		switch a.Mode {
		case "", "off", "manual", "once":
		case "tracking":
			return bad("Leitung „%s“: Ausgleichsmodus „tracking“ ist nicht umgesetzt", l.Name)
		default:
			return bad("Leitung „%s“: Ausgleichsmodus „%s“ unbekannt (off, manual, once)", l.Name, a.Mode)
		}
	}
	return nil
}

func validateMembers(ms []Member) error {
	seen := map[string]bool{}
	for _, m := range ms {
		if m.SubjectType != "user" && m.SubjectType != "group" {
			return bad("Mitglied: subjectType muss user oder group sein")
		}
		if strings.TrimSpace(m.Subject) == "" {
			return bad("Mitglied ohne Name")
		}
		if !eventRoles[m.Role] {
			return bad("Mitglied „%s“: Rolle „%s“ unbekannt (lead, engineer, commentator, viewer)", m.Subject, m.Role)
		}
		k := m.SubjectType + "|" + m.Subject
		if seen[k] {
			return bad("Mitglied „%s“ doppelt", m.Subject)
		}
		seen[k] = true
	}
	return nil
}
