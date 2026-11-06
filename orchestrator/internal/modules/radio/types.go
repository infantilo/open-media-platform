// Package radio ist das Modul „Radio“ (Kapitel 89, docs/ENTWURF-RADIO-KONSOLE.md): Sendungen, die Moderatorinnen und Moderatoren
// **vor** der Sendung vorbereiten (Ablauf, Moderationskarten, Hotkeys, Notizen) und die zur Sendezeit in die Radio-Automation geladen werden.
// Eine Sendung ist ein Dokument mit Versionen, Zeitfenster, Verantwortlichen und Status; Vorlagen (Formate) sind Sendungen mit `template`.
package radio

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

var (
	ErrNotFound   = errors.New("radio: nicht gefunden")
	ErrConflict   = errors.New("radio: Revisionskonflikt — die Sendung wurde inzwischen geändert")
	ErrState      = errors.New("radio: Statuswechsel nicht erlaubt")
	ErrValidation = errors.New("radio: ungültige Eingabe")
	ErrForbidden  = errors.New("radio: keine Berechtigung für diese Sendung")
)

type ValidationError struct{ Problems []string }

func (e *ValidationError) Error() string {
	return "radio: ungültige Eingabe: " + strings.Join(e.Problems, "; ")
}
func (e *ValidationError) Is(t error) bool { return t == ErrValidation }

// Status einer Sendung.
const (
	StatusDraft    = "draft"    // in Vorbereitung
	StatusReady    = "ready"    // freigegeben, kann geladen werden
	StatusLive     = "live"     // läuft
	StatusDone     = "done"     // gesendet
	StatusArchived = "archived" // abgelegt
)

// transitions: erlaubte Statuswechsel. Wer sie auslösen darf, regelt der Handler (Freigabe-Recht für ready/live/done).
var transitions = map[string][]string{
	StatusDraft:    {StatusReady, StatusArchived},
	StatusReady:    {StatusDraft, StatusLive, StatusArchived},
	StatusLive:     {StatusDone, StatusReady},
	StatusDone:     {StatusArchived, StatusDraft},
	StatusArchived: {StatusDraft},
}

func canTransition(from, to string) bool {
	for _, t := range transitions[from] {
		if t == to {
			return true
		}
	}
	return false
}

// needsRelease: diese Zielzustände verlangen das Recht „Freigeben“ (der Entwurf darf jede(r) Bearbeitende zurückholen oder ablegen).
func needsRelease(to string) bool { return to == StatusReady || to == StatusLive || to == StatusDone }

// Show ist eine Sendung (oder Vorlage). `Content` ist das Sendungsdokument (s. ValidateContent) und wird in Listen weggelassen.
type Show struct {
	ID          string          `json:"id"`
	Title       string          `json:"title"`
	Description string          `json:"description,omitempty"`
	Template    bool            `json:"template"`
	Status      string          `json:"status"`
	SlotStart   *time.Time      `json:"slotStart,omitempty"`
	SlotEnd     *time.Time      `json:"slotEnd,omitempty"`
	Presenters  []string        `json:"presenters"`
	Owner       string          `json:"owner"`
	Tags        []string        `json:"tags"`
	Content     json.RawMessage `json:"content,omitempty"`
	// Recurrence: nur bei Vorlagen — erzeugt Sendungen im Voraus (s. Recurrence).
	Recurrence json.RawMessage `json:"recurrence,omitempty"`
	// SourceTemplateID: Vorlage, aus der die Wiederkehr diese Sendung erzeugt hat.
	SourceTemplateID string `json:"sourceTemplateId,omitempty"`
	// AutoLive: das Modul schaltet die Sendung zum Beginn des Zeitfensters auf „live“ und zum Ende auf „done“.
	AutoLive   bool      `json:"autoLive"`
	RowVersion int       `json:"rowVersion"`
	CreatedBy  string    `json:"createdBy"`
	UpdatedBy  string    `json:"updatedBy"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

// Version ist ein früherer Stand des Sendungsdokuments.
type Version struct {
	ShowID    string          `json:"showId"`
	Version   int             `json:"version"`
	Reason    string          `json:"reason,omitempty"`
	CreatedBy string          `json:"createdBy"`
	CreatedAt time.Time       `json:"createdAt"`
	Content   json.RawMessage `json:"content,omitempty"`
}

// Input ist der änderbare Teil einer Sendung (Anlegen und Ändern).
type Input struct {
	Title       string          `json:"title"`
	Description string          `json:"description"`
	Template    bool            `json:"template"`
	SlotStart   *time.Time      `json:"slotStart"`
	SlotEnd     *time.Time      `json:"slotEnd"`
	Presenters  []string        `json:"presenters"`
	Tags        []string        `json:"tags"`
	Content     json.RawMessage `json:"content"`
	Recurrence  json.RawMessage `json:"recurrence"`
	// AutoLive: nil = unverändert (neue Sendung: an).
	AutoLive *bool `json:"autoLive"`
	// RowVersion: beim Ändern der Stand, auf dem die Änderung beruht (Konflikterkennung).
	RowVersion int `json:"rowVersion"`
	// Reason: Vermerk zur Version („Hotkeys angepasst“).
	Reason string `json:"reason"`

	sourceTemplate string // nur intern: Herkunft bei erzeugten Sendungen
}

const (
	maxContentBytes = 2 << 20
	maxCarts        = 64
	maxItems        = 2000
	maxCards        = 1000
)

// ValidateContent prüft das Sendungsdokument. Es ist ein JSON-Objekt; bekannte Schlüssel werden auf Form und Größe geprüft,
// unbekannte bleiben erhalten (das Format wächst mit den Funktionen, ohne dass das Modul angefasst werden muss):
//
//	log    — Objekt der Radio-Automation (`items` höchstens 2000)
//	carts  — Hotkeys (höchstens 64)
//	cards  — Moderationskarten [{id, title, text, afterItem, minutes}] (höchstens 1000)
//	notes  — freie Notizen [{id, text}]
func ValidateContent(raw json.RawMessage) error {
	if len(raw) == 0 {
		return nil
	}
	if len(raw) > maxContentBytes {
		return &ValidationError{[]string{fmt.Sprintf("Sendungsdokument größer als %d MiB", maxContentBytes>>20)}}
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		return &ValidationError{[]string{"content muss ein JSON-Objekt sein"}}
	}
	var problems []string
	arr := func(key string, max int) []json.RawMessage {
		v, ok := doc[key]
		if !ok || string(v) == "null" {
			return nil
		}
		var a []json.RawMessage
		if err := json.Unmarshal(v, &a); err != nil {
			problems = append(problems, key+" muss eine Liste sein")
			return nil
		}
		if len(a) > max {
			problems = append(problems, fmt.Sprintf("%s: höchstens %d Einträge", key, max))
		}
		return a
	}
	arr("carts", maxCarts)
	arr("cards", maxCards)
	arr("notes", maxCards)
	if v, ok := doc["log"]; ok && string(v) != "null" {
		var l struct {
			Items []json.RawMessage `json:"items"`
		}
		if err := json.Unmarshal(v, &l); err != nil {
			problems = append(problems, "log muss ein Objekt sein")
		} else if len(l.Items) > maxItems {
			problems = append(problems, fmt.Sprintf("log.items: höchstens %d Einträge", maxItems))
		}
	}
	if len(problems) > 0 {
		return &ValidationError{problems}
	}
	return nil
}

// Validate prüft die Eingabe.
func (in *Input) Validate() error {
	var p []string
	if t := strings.TrimSpace(in.Title); t == "" || len([]rune(t)) > 200 {
		p = append(p, "Titel 1–200 Zeichen")
	}
	if len(in.Description) > 4000 {
		p = append(p, "Beschreibung höchstens 4000 Zeichen")
	}
	if in.SlotStart != nil && in.SlotEnd != nil && !in.SlotEnd.After(*in.SlotStart) {
		p = append(p, "Ende muss nach dem Beginn liegen")
	}
	if in.Template && (in.SlotStart != nil || in.SlotEnd != nil) {
		p = append(p, "Eine Vorlage hat kein Zeitfenster")
	}
	if len(in.Presenters) > 20 || len(in.Tags) > 30 {
		p = append(p, "höchstens 20 Moderierende und 30 Schlagworte")
	}
	if len(in.Recurrence) > 0 && string(in.Recurrence) != "null" {
		if !in.Template {
			p = append(p, "Wiederkehr gibt es nur bei Vorlagen")
		} else if _, err := ParseRecurrence(in.Recurrence); err != nil {
			p = append(p, err.Error())
		}
	}
	if err := ValidateContent(in.Content); err != nil {
		var ve *ValidationError
		if errors.As(err, &ve) {
			p = append(p, ve.Problems...)
		}
	}
	if len(p) > 0 {
		return &ValidationError{p}
	}
	return nil
}

func cleanList(in []string) []string {
	out := make([]string, 0, len(in))
	seen := map[string]bool{}
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}
