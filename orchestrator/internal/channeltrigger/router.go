package channeltrigger

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/playout"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/tracing"
)

// Publisher veröffentlicht auf dem Nachrichtenbus (NATS).
type Publisher interface {
	Publish(subject string, data []byte) error
}

// Channels liefert die bekannten Channels (*playout.Store).
type Channels interface {
	ListChannels() ([]playout.Channel, error)
}

// AuditFunc protokolliert Ereignisse im Domänen-Audit (Spec §165).
type AuditFunc func(actor, objectID, action string, details map[string]any)

// Timing der Zustellung.
const (
	RedeliverEvery = 3 * time.Second
	MaxAttempts    = 5
	// MaxAge: spätestens danach gilt eine unquittierte Zustellung als „expired“.
	MaxAge = 90 * time.Second
	// MaxHorizon: weiter in der Zukunft liegende Zielzeiten werden abgelehnt (Schutz vor Dauer-Hängern).
	MaxHorizon = 6 * time.Hour
)

// Router stellt Trigger zu.
type Router struct {
	Store    *Store
	Channels Channels
	Pub      Publisher
	Audit    AuditFunc
	Now      func() time.Time
}

func (r *Router) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

func (r *Router) audit(actor, id, action string, d map[string]any) {
	if r.Audit != nil {
		r.Audit(actor, id, action, d)
	}
}

func envelopeOf(rec Record) Envelope {
	return Envelope{
		ID: rec.ID, CorrelationID: rec.CorrelationID, OriginChannel: rec.OriginChannel, TargetChannel: rec.TargetChannel,
		Event: rec.Event, Args: rec.Args, TargetTime: rec.TargetTime, RelativeOffsetMs: rec.RelativeOffsetMs,
		LatePolicy: rec.LatePolicy, Seq: rec.Seq, Timestamp: rec.CreatedAt.UTC(), Attempt: rec.Attempts,
	}
}

func (r *Router) publish(rec Record) error {
	if r.Pub == nil {
		return fmt.Errorf("kein Nachrichtenbus (NATS) verfügbar")
	}
	data, err := json.Marshal(envelopeOf(rec))
	if err != nil {
		return err
	}
	return r.Pub.Publish(Subject(rec.TargetChannel), data)
}

// targets löst den Selektor zu Ziel-Channels auf (ohne Ursprung bei group/all).
func targets(t Target, origin playout.Channel, all []playout.Channel, rules []Rule) []playout.Channel {
	var out []playout.Channel
	for _, ch := range all {
		switch {
		case t.Channel != "":
			if ch.ID == t.Channel || ch.Name == t.Channel {
				out = append(out, ch)
			}
		case t.Group != "":
			if ch.Group == t.Group && ch.ID != origin.ID {
				out = append(out, ch)
			}
		case t.All:
			if ch.ID != origin.ID && Allowed(rules, origin, ch) {
				out = append(out, ch)
			}
		}
	}
	return out
}

// Send prüft, protokolliert und stellt einen Trigger an alle aufgelösten Ziele zu. Pro Ziel
// entsteht eine Zustellung (Zeile); nicht erlaubte werden als „denied“ protokolliert, nie zugestellt.
func (r *Router) Send(origin playout.Channel, req Request, by string) ([]Delivery, error) {
	event, err := NormalizeEvent(req.Event)
	if err != nil {
		return nil, err
	}
	late, err := NormalizeLate(req.LatePolicy)
	if err != nil {
		return nil, err
	}
	if err := req.Target.Validate(); err != nil {
		return nil, err
	}
	if len(req.Args) > 0 && !json.Valid(req.Args) {
		return nil, fmt.Errorf("%w: args ist kein gültiges JSON", ErrValidation)
	}
	if len(req.Args) > 8192 {
		return nil, fmt.Errorf("%w: args zu groß (max. 8 KiB)", ErrValidation)
	}
	if req.TargetTime != nil && req.TargetTime.After(r.now().Add(MaxHorizon)) {
		return nil, fmt.Errorf("%w: targetTime liegt mehr als %s in der Zukunft", ErrValidation, MaxHorizon)
	}
	if event == EventJump && !strings.Contains(string(req.Args), "itemId") {
		return nil, fmt.Errorf("%w: CHANNEL_JUMP braucht args.itemId", ErrValidation)
	}
	all, err := r.Channels.ListChannels()
	if err != nil {
		return nil, err
	}
	rules, err := r.Store.Rules()
	if err != nil {
		return nil, err
	}
	// Ein ausdrücklich benanntes Ziel wird auch dann aufgelöst/protokolliert, wenn es nicht erlaubt ist.
	tgts := targets(req.Target, origin, all, rules)
	if len(tgts) == 0 {
		return nil, fmt.Errorf("%w: kein Ziel-Channel gefunden", ErrNotFound)
	}
	corr := req.CorrelationID
	if corr == "" {
		corr = tracing.NewID()
	}
	out := make([]Delivery, 0, len(tgts))
	for _, tgt := range tgts {
		base := Record{
			ID: tracing.NewID(), CorrelationID: corr, OriginChannel: origin.ID, TargetChannel: tgt.ID, Event: event,
			Args: req.Args, TargetTime: req.TargetTime, RelativeOffsetMs: req.RelativeOffsetMs, LatePolicy: late, CreatedBy: by,
		}
		if !Allowed(rules, origin, tgt) {
			base.Status, base.Detail = StatusDenied, fmt.Sprintf("Channel „%s“ darf Channel „%s“ nicht steuern (keine Regel)", origin.Name, tgt.Name)
			rec, err := r.Store.insert(base)
			if err != nil {
				return out, err
			}
			r.audit(by, rec.ID, "denied", map[string]any{"origin": origin.ID, "target": tgt.ID, "event": event, "correlation": corr})
			out = append(out, Delivery{ID: rec.ID, TargetChannel: tgt.ID, TargetName: tgt.Name, Status: StatusDenied, Detail: base.Detail, Seq: rec.Seq})
			continue
		}
		base.Status, base.Attempts = StatusPublished, 1
		rec, err := r.Store.insert(base)
		if err != nil {
			return out, err
		}
		d := Delivery{ID: rec.ID, TargetChannel: tgt.ID, TargetName: tgt.Name, Status: StatusPublished, Seq: rec.Seq}
		if perr := r.publish(rec); perr != nil {
			// Bleibt „published“ — die Wiederholung versucht es erneut, bis MaxAge/MaxAttempts.
			d.Detail = "Zustellung wird wiederholt: " + perr.Error()
			slog.Warn("channeltrigger: publish fehlgeschlagen", "id", rec.ID, "error", perr)
		}
		r.audit(by, rec.ID, "sent", map[string]any{"origin": origin.ID, "target": tgt.ID, "event": event, "correlation": corr, "seq": rec.Seq})
		out = append(out, d)
	}
	return out, nil
}

// Ack verarbeitet die Quittung des Ziel-Channels.
func (r *Router) Ack(channelID, id, status, detail, by string) (Record, error) {
	rec, first, err := r.Store.Ack(id, channelID, status, detail)
	if err != nil {
		return Record{}, err
	}
	if first {
		r.audit(by, id, "ack_"+status, map[string]any{"target": channelID, "origin": rec.OriginChannel, "event": rec.Event, "detail": detail})
	}
	return rec, nil
}

// Housekeeping wiederholt offene Zustellungen und lässt überfällige verfallen. Läuft periodisch.
func (r *Router) Housekeeping() {
	due, err := r.Store.DueForRedelivery(RedeliverEvery, MaxAttempts)
	if err != nil {
		slog.Warn("channeltrigger: Wiederholung nicht lesbar", "error", err)
		return
	}
	for _, rec := range due {
		if err := r.publish(rec); err != nil {
			slog.Warn("channeltrigger: Wiederholung fehlgeschlagen", "id", rec.ID, "error", err)
		}
		_ = r.Store.MarkAttempt(rec.ID)
	}
	expired, err := r.Store.ExpireOpen(MaxAge, RedeliverEvery, MaxAttempts)
	if err != nil {
		slog.Warn("channeltrigger: Verfall nicht ausführbar", "error", err)
		return
	}
	for _, rec := range expired {
		r.audit("system", rec.ID, "expired", map[string]any{"target": rec.TargetChannel, "origin": rec.OriginChannel, "event": rec.Event})
	}
}

// Run führt Housekeeping alle Sekunde aus, bis ctx endet.
func (r *Router) Run(ctx context.Context) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			r.Housekeeping()
		}
	}
}
