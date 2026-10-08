package cloud

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/tracing"
)

var (
	ErrReservationNotFound   = errors.New("cloud: reservation not found")
	ErrReservationValidation = errors.New("cloud: invalid reservation")
)

// Reservation verlangt `HostCount` bereite Hosts im Pool von `From` bis `To` (§27.4).
type Reservation struct {
	ID        string    `json:"id"`
	Pool      string    `json:"pool"`
	HostCount int       `json:"hostCount"`
	From      time.Time `json:"from"`
	To        time.Time `json:"to"`
	Note      string    `json:"note,omitempty"`
	CreatedBy string    `json:"createdBy"`
	CreatedAt time.Time `json:"createdAt"`
}

// ReservationInput sind die schreibbaren Felder.
type ReservationInput struct {
	Pool      string    `json:"pool"`
	HostCount int       `json:"hostCount"`
	From      time.Time `json:"from"`
	To        time.Time `json:"to"`
	Note      string    `json:"note"`
}

// MaxReservationHosts begrenzt eine einzelne Reservierung (Schutz vor Tippfehlern, die Geld kosten).
const MaxReservationHosts = 50

// Validate prüft die Eingabe gegen die konfigurierten Pools.
func (in *ReservationInput) Validate(pools map[string]Pool) error {
	in.Pool = strings.TrimSpace(in.Pool)
	pl, ok := pools[in.Pool]
	switch {
	case !ok:
		return fmt.Errorf("%w: unknown pool %q", ErrReservationValidation, in.Pool)
	case in.HostCount < 1 || in.HostCount > MaxReservationHosts:
		return fmt.Errorf("%w: hostCount must be 1–%d", ErrReservationValidation, MaxReservationHosts)
	case pl.Max > 0 && in.HostCount > pl.Max:
		return fmt.Errorf("%w: pool %q allows at most %d hosts", ErrReservationValidation, in.Pool, pl.Max)
	case in.From.IsZero() || !in.To.After(in.From):
		return fmt.Errorf("%w: 'to' must be after 'from'", ErrReservationValidation)
	case in.To.Sub(in.From) > 31*24*time.Hour:
		return fmt.Errorf("%w: at most 31 days", ErrReservationValidation)
	case len(in.Note) > 500 || strings.ContainsAny(in.Note, "\x00"):
		return fmt.Errorf("%w: invalid note", ErrReservationValidation)
	}
	return nil
}

// ReservationStore ist die Persistenz der Reservierungen.
type ReservationStore interface {
	List(from, to time.Time) ([]Reservation, error)
	Create(in ReservationInput, by string) (Reservation, error)
	Delete(id string) error
}

// SQLReservations speichert in Postgres (Tabelle cloud_reservations).
type SQLReservations struct{ db *sql.DB }

func NewSQLReservations(db *sql.DB) *SQLReservations { return &SQLReservations{db: db} }

const resCols = `id, pool, host_count, from_at, to_at, note, created_by, created_at`

func scanRes(r interface{ Scan(...any) error }) (Reservation, error) {
	var x Reservation
	err := r.Scan(&x.ID, &x.Pool, &x.HostCount, &x.From, &x.To, &x.Note, &x.CreatedBy, &x.CreatedAt)
	return x, err
}

// List liefert alle Reservierungen, die [from, to) berühren, nach Beginn sortiert.
func (s *SQLReservations) List(from, to time.Time) ([]Reservation, error) {
	rows, err := s.db.Query(`SELECT `+resCols+` FROM cloud_reservations WHERE to_at > $1 AND from_at < $2 ORDER BY from_at, id`, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Reservation{}
	for rows.Next() {
		x, err := scanRes(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

// Create legt eine Reservierung an (Validierung gegen die Pools macht der Aufrufer über Validate).
func (s *SQLReservations) Create(in ReservationInput, by string) (Reservation, error) {
	id := tracing.NewID()
	if id == "" {
		return Reservation{}, errors.New("cloud: id generation failed")
	}
	return scanRes(s.db.QueryRow(`INSERT INTO cloud_reservations (id, pool, host_count, from_at, to_at, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING `+resCols,
		id, in.Pool, in.HostCount, in.From.UTC(), in.To.UTC(), in.Note, by))
}

func (s *SQLReservations) Delete(id string) error {
	res, err := s.db.Exec(`DELETE FROM cloud_reservations WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrReservationNotFound
	}
	return nil
}

var _ ReservationStore = (*SQLReservations)(nil)
