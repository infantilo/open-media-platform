// Package outbox implementiert das Transactional-Outbox-Muster
// (Kapitel 21 Phase 4 Teil 1, UMSETZUNG.md §6b/21.4 Punkt 4 + A8/B9) —
// die Antwort auf die in Kapitel-21-Phase-1 als offen dokumentierte
// Zuverlässigkeitsfrage für Domain-Events (JetStream vs. Outbox), vom
// Nutzer am 2026-09-22 als Kombination beider entschieden: Outbox löst
// das "Dual-Write"-Problem auf der SCHREIBSEITE (ein Statuswechsel und
// sein Event landen atomar in derselben Postgres-Transaktion — kein
// Event kann verloren gehen, wenn der State-Change committed wurde, und
// keines kann für einen nie committeten State-Change entstehen); Relay
// (relay.go) löst die ZUSTELLSEITE über NATS JetStream (bereits
// laufende Infrastruktur seit D14, `-js`-Flag, bisher ungenutzt —
// dieselbe nats.go-Abhängigkeit wie internal/eventbus, keine neue).
//
// Store.Enqueue nimmt bewusst ein *sql.Tx (nicht *sql.DB) entgegen —
// Aufrufer MÜSSEN es innerhalb derselben Transaktion wie ihren eigentlichen
// State-Change aufrufen, sonst ist die Atomaritäts-Garantie wertlos.
// EnqueueDB (schwächere, transaktionslose Variante) existiert nur für
// Fälle ohne sinnvollen Zustands-Bezug (z. B. reine Benachrichtigungen).
package outbox

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/tracing"
)

// Event ist eine Zeile der outbox_events-Tabelle.
type Event struct {
	ID           string          `json:"id"`
	Subject      string          `json:"subject"`
	Payload      json.RawMessage `json:"payload"`
	DedupKey     string          `json:"dedupKey,omitempty"`
	CreatedAt    time.Time       `json:"createdAt"`
	DispatchedAt *time.Time      `json:"dispatchedAt,omitempty"`
}

// Store persistiert Outbox-Events (db/migrations/0021_outbox_events.sql).
type Store struct {
	db *sql.DB
}

// NewStore erstellt einen Store gegen die gegebene, bereits migrierte
// Datenbankverbindung.
func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

func newID() (string, error) {
	id := tracing.NewID()
	if id == "" {
		return "", fmt.Errorf("outbox: id generation failed")
	}
	return id, nil
}

// Enqueue schreibt ein Event INNERHALB der gegebenen Transaktion — der
// Aufrufer ist dafür verantwortlich, dieselbe tx auch für den
// eigentlichen State-Change zu verwenden und danach zu committen
// (Atomaritäts-Garantie, s. Moduldoku). dedupKey ist optional (leer =
// kein Dedup-Wunsch) — wird vom Relay als JetStream-Nats-Msg-Id
// weitergereicht (relay.go).
func (s *Store) Enqueue(tx *sql.Tx, subject string, payload json.RawMessage, dedupKey string) (Event, error) {
	if subject == "" {
		return Event{}, fmt.Errorf("outbox: subject is required")
	}
	id, err := newID()
	if err != nil {
		return Event{}, err
	}
	if payload == nil {
		payload = json.RawMessage(`{}`)
	}
	e := Event{ID: id, Subject: subject, Payload: payload, DedupKey: dedupKey, CreatedAt: time.Now().UTC()}
	_, err = tx.Exec(`
		INSERT INTO outbox_events (id, subject, payload, dedup_key, created_at)
		VALUES ($1, $2, $3, NULLIF($4, ''), $5)
	`, e.ID, e.Subject, []byte(e.Payload), e.DedupKey, e.CreatedAt)
	if err != nil {
		return Event{}, err
	}
	return e, nil
}

// EnqueueDB ist die transaktionslose Variante von Enqueue — bewusst
// getrennt benannt (nicht einfach ein optionales tx-Argument), damit an
// jeder Aufrufstelle im Code sofort sichtbar ist, ob die
// Atomaritäts-Garantie gilt oder nicht. Nur für Fälle ohne sinnvollen
// State-Change-Bezug verwenden (s. Moduldoku) — jeder Aufrufer, der
// einen Statuswechsel begleitet, MUSS Enqueue(tx, …) innerhalb seiner
// eigenen Transaktion nutzen.
func (s *Store) EnqueueDB(subject string, payload json.RawMessage, dedupKey string) (Event, error) {
	ctx := context.Background()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Event{}, err
	}
	defer func() { _ = tx.Rollback() }()
	e, err := s.Enqueue(tx, subject, payload, dedupKey)
	if err != nil {
		return Event{}, err
	}
	if err := tx.Commit(); err != nil {
		return Event{}, err
	}
	return e, nil
}

const eventSelectColumns = `id, subject, payload, dedup_key, created_at, dispatched_at`

func scanEvent(row interface{ Scan(...any) error }) (Event, error) {
	var e Event
	var dedupKey sql.NullString
	var dispatchedAt sql.NullTime
	err := row.Scan(&e.ID, &e.Subject, &e.Payload, &dedupKey, &e.CreatedAt, &dispatchedAt)
	if err != nil {
		return Event{}, err
	}
	e.DedupKey = dedupKey.String
	if dispatchedAt.Valid {
		t := dispatchedAt.Time
		e.DispatchedAt = &t
	}
	return e, nil
}

// Undispatched liefert die ältesten noch nicht versendeten Events, bis
// zu limit Stück — der Relay ruft dies in einer Polling-Schleife auf
// (relay.go).
func (s *Store) Undispatched(limit int) ([]Event, error) {
	rows, err := s.db.Query(`SELECT `+eventSelectColumns+` FROM outbox_events WHERE dispatched_at IS NULL ORDER BY created_at ASC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Event{}
	for rows.Next() {
		e, err := scanEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// ErrNotFound wird geliefert, wenn keine Zeile mit der gegebenen ID
// existiert.
var ErrNotFound = errors.New("outbox: not found")

// MarkDispatched markiert ein Event als erfolgreich versendet —
// idempotent (ein zweiter Aufruf mit derselben ID ist kein Fehler,
// überschreibt dispatched_at aber nicht erneut), damit ein Relay-Neustart
// nach einem erfolgreichen, aber noch nicht quittierten Publish keinen
// Fehler auslöst.
func (s *Store) MarkDispatched(id string) error {
	res, err := s.db.Exec(`UPDATE outbox_events SET dispatched_at = now() WHERE id = $1 AND dispatched_at IS NULL`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		var exists bool
		if err := s.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM outbox_events WHERE id = $1)`, id).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrNotFound
		}
		// Bereits dispatched — idempotent, kein Fehler.
	}
	return nil
}
