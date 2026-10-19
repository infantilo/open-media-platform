package module

import (
	"context"
	"time"
)

// Funktionsrechte, Kacheln und Aufgaben der Module (Kapitel 44).

// FeatureDef beschreibt ein Funktionsrecht, das ein Modul deklariert. Die Administration zeigt den Katalog beim Vergeben.
type FeatureDef struct {
	// ID ist stabil und hat die Form "<modul>.<bereich>.<aktion>" (nur a–z, 0–9, '.', '_', '-').
	ID string `json:"id"`
	// Label und Description je Sprache ("de", "en").
	Label       map[string]string `json:"label"`
	Description map[string]string `json:"description,omitempty"`
	// Group fasst Rechte in der Oberfläche zusammen (Beschriftung je Sprache).
	Group map[string]string `json:"group,omitempty"`
}

// FeatureProvider: das Modul deklariert Funktionsrechte.
type FeatureProvider interface {
	Features() []FeatureDef
}

// UITile ist eine Kachel für die Operator-Konsole (Arbeitsplatz-Ansicht). Sie erscheint nur, wenn der Nutzer mindestens
// eines der Rechte in `Needs` besitzt (Muster wie `ingest.*` sind erlaubt).
type UITile struct {
	ID      string            `json:"id"`
	Label   map[string]string `json:"label"`
	Needs   []string          `json:"needs"`
	Element string            `json:"element"`
	Bundle  string            `json:"bundle"`
}

// TileProvider: das Modul bringt Kacheln für die Operator-Konsole mit.
type TileProvider interface {
	Tiles() []UITile
}

// Identity ist der anfragende Mensch, wie ihn ein Modul für Aufgaben und Zuständigkeit braucht.
type Identity struct {
	User string
	// Groups: IDs der Gruppen, in denen der Nutzer Mitglied ist.
	Groups []string
	// Has prüft ein Funktionsrecht des Nutzers.
	Has func(feature string) bool
}

// InGroup: ist der Nutzer Mitglied der Gruppe?
func (i Identity) InGroup(id string) bool {
	for _, g := range i.Groups {
		if g == id {
			return true
		}
	}
	return false
}

// Task ist eine Aufgabe in der Aufgabenliste eines Nutzers (modulübergreifend).
type Task struct {
	// ID ist im Modul eindeutig (z. B. Asset- oder Auftrags-ID); Module + ID ergeben den Schlüssel.
	ID     string `json:"id"`
	Module string `json:"module"`
	// Kind: Art der Aufgabe, z. B. "qc" (Datei prüfen) oder "recording" (Aufnahme).
	Kind  string `json:"kind"`
	Title string `json:"title"`
	// Detail: eine Zeile Zusatzinfo (Datei, Quelle, …).
	Detail string `json:"detail,omitempty"`
	// State: Zustand des Gegenstands im Modul; Status: "ok" | "warn" | "error" | "active" für die Darstellung.
	State  string `json:"state"`
	Status string `json:"status"`
	// Assignee/AssigneeGroup: Zuständige(r) bzw. zuständige Gruppe; "mine" heißt: dem Nutzer persönlich zugewiesen.
	Assignee      string `json:"assignee,omitempty"`
	AssigneeGroup string `json:"assigneeGroup,omitempty"`
	Mine          bool   `json:"mine"`
	// Claimable: eine Gruppenaufgabe, die der Nutzer übernehmen kann.
	Claimable bool       `json:"claimable,omitempty"`
	DueAt     *time.Time `json:"dueAt,omitempty"`
	Overdue   bool       `json:"overdue,omitempty"`
	// Problem: Begründung im Klartext (Rückfall), ProblemCode: stabiler Schlüssel, den die Oberfläche übersetzt
	// ("overdue", "failed", "not_admitted", "waiting_resources", "qc_not_run", "qc_failed", "rejected").
	Problem     string `json:"problem,omitempty"`
	ProblemCode string `json:"problemCode,omitempty"`
	// Action: Ziel in der Oberfläche (Tab-ID des Moduls und Gegenstand).
	Action TaskAction `json:"action"`
}

// TaskAction sagt der Oberfläche, wohin ein Klick auf die Aufgabe führt.
type TaskAction struct {
	Tab string `json:"tab"`
	Ref string `json:"ref,omitempty"`
}

// TaskProvider: das Modul liefert Aufgaben für einen Nutzer.
type TaskProvider interface {
	Tasks(ctx context.Context, who Identity) ([]Task, error)
}
