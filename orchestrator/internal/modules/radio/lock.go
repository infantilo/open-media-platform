package radio

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"time"
)

// Weiche Bearbeitungssperre: je Sendung höchstens ein Halter (Person + Sitzung). Die Sperre verhindert kein Schreiben auf Serverebene
// (das schützt die Revisionsprüfung `rowVersion`), sie zeigt anderen, wer gerade bearbeitet, und lässt das Bedienfeld den Rest schreibgeschützt
// anzeigen. Ohne Herzschlag verfällt sie nach `lockTTL`; wer die Sendung bearbeiten darf, kann sie übernehmen.

const lockTTL = 30 * time.Second

// Lock beschreibt den aktuellen Halter.
type Lock struct {
	ShowID  string    `json:"showId"`
	Holder  string    `json:"holder"`
	Session string    `json:"session"`
	Since   time.Time `json:"since"`
	Beat    time.Time `json:"beat"`
	// Active: der Herzschlag ist jünger als lockTTL.
	Active bool `json:"active"`
}

// ErrLocked: die Sendung wird gerade von jemand anderem bearbeitet (Halter im Fehler der Antwort).
var ErrLocked = errors.New("radio: die Sendung wird gerade bearbeitet")

// GetLock liefert den Halter oder nil.
func (s *Store) GetLock(ctx context.Context, showID string, now time.Time) (*Lock, error) {
	var l Lock
	err := s.db.QueryRowContext(ctx, `SELECT show_id, holder, session, since, beat FROM radio_show_locks WHERE show_id=$1`, showID).Scan(&l.ShowID, &l.Holder, &l.Session, &l.Since, &l.Beat)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	l.Active = now.Sub(l.Beat) < lockTTL
	return &l, nil
}

// Acquire nimmt oder erneuert die Sperre für (holder, session). Hält jemand anderes sie aktiv, gibt es ErrLocked samt Halter —
// außer `takeover`: dann geht sie über. Gleiche Person in anderer Sitzung gilt als „jemand anderes“ (zwei Tabs sollen sich nicht überschreiben).
func (s *Store) Acquire(ctx context.Context, showID, holder, session string, takeover bool, now time.Time) (*Lock, error) {
	if _, err := s.Get(ctx, showID); err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	// Zeile je Sendung anlegen und sperren, dann entscheiden
	if _, err := tx.ExecContext(ctx, `INSERT INTO radio_show_locks (show_id, holder, session, since, beat) VALUES ($1,'','',$2,'epoch') ON CONFLICT DO NOTHING`, showID, now); err != nil {
		return nil, err
	}
	var cur Lock
	if err := tx.QueryRowContext(ctx, `SELECT show_id, holder, session, since, beat FROM radio_show_locks WHERE show_id=$1 FOR UPDATE`, showID).Scan(&cur.ShowID, &cur.Holder, &cur.Session, &cur.Since, &cur.Beat); err != nil {
		return nil, err
	}
	cur.Active = cur.Holder != "" && now.Sub(cur.Beat) < lockTTL
	own := cur.Holder == holder && cur.Session == session
	if cur.Active && !own && !takeover {
		return &cur, ErrLocked
	}
	since := now
	if own {
		since = cur.Since
	}
	if _, err := tx.ExecContext(ctx, `UPDATE radio_show_locks SET holder=$2, session=$3, since=$4, beat=$5 WHERE show_id=$1`, showID, holder, session, since, now); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &Lock{ShowID: showID, Holder: holder, Session: session, Since: since, Beat: now, Active: true}, nil
}

// Release gibt die Sperre frei, wenn (holder, session) sie hält.
func (s *Store) Release(ctx context.Context, showID, holder, session string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM radio_show_locks WHERE show_id=$1 AND holder=$2 AND session=$3`, showID, holder, session)
	return err
}

// ---- HTTP ---------------------------------------------------------------------------------------------------------------

func lockBody(l *Lock) map[string]any {
	if l == nil || l.Holder == "" || !l.Active {
		return map[string]any{"lock": nil}
	}
	return map[string]any{"lock": l}
}

func (a *api) getLock() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		l, err := a.m.store().GetLock(r.Context(), r.PathValue("id"), time.Now())
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, lockBody(l))
	}
}

// acquireLock: Body {"session": "...", "takeover": false}. 200 = Sperre gehalten (auch Erneuerung/Herzschlag); 409 = jemand anderes hält sie.
func (a *api) acquireLock() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		var body struct {
			Session  string `json:"session"`
			Takeover bool   `json:"takeover"`
		}
		if !readBody(w, r, &body) {
			return
		}
		if body.Session == "" || len(body.Session) > 64 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "session: 1–64 Zeichen"})
			return
		}
		cur, err := a.m.store().Get(r.Context(), id)
		if err != nil {
			writeErr(w, err)
			return
		}
		if !a.mayEdit(r, cur) {
			writeErr(w, ErrForbidden)
			return
		}
		l, err := a.m.store().Acquire(r.Context(), id, actorOf(r), body.Session, body.Takeover, time.Now())
		if errors.Is(err, ErrLocked) {
			writeJSON(w, http.StatusConflict, map[string]any{"error": ErrLocked.Error(), "code": "locked", "lock": l})
			return
		}
		if err != nil {
			writeErr(w, err)
			return
		}
		if body.Takeover {
			a.log(r, id, "lock-takeover", nil)
		}
		writeJSON(w, http.StatusOK, lockBody(l))
	}
}

func (a *api) releaseLock() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Session string `json:"session"`
		}
		if !readBody(w, r, &body) {
			return
		}
		if err := a.m.store().Release(r.Context(), r.PathValue("id"), actorOf(r), body.Session); err != nil {
			writeErr(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
