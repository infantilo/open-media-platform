package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/channeltrigger"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/playout"
)

// Channel-Trigger (Kapitel 27 / P7, Spec §77–90, §163–165). Senden: die an den Ursprungs-Channel
// gebundene Automator-Instanz ODER global `operate` (wie der übrige Channel-Zugriff); Quittieren:
// der Ziel-Channel selbst. Regeln (wer wen steuern darf): `configure`. Protokoll: `view`.

// ChannelTriggerService wird von *channeltrigger.Router (+ Store) implementiert.
type ChannelTriggerService interface {
	Send(origin playout.Channel, req channeltrigger.Request, by string) ([]channeltrigger.Delivery, error)
	Ack(channelID, id, status, detail, by string) (channeltrigger.Record, error)
}

// WithChannelTriggers aktiviert die Trigger-Routen. Der Store liefert Regeln und Protokoll.
func WithChannelTriggers(router ChannelTriggerService, store ChannelTriggerStore) HandlerOption {
	return func(o *handlerOptions) { o.triggerRouter, o.triggerStore = router, store }
}

// ChannelTriggerStore: Regeln und Protokoll (*channeltrigger.Store).
type ChannelTriggerStore interface {
	Rules() ([]channeltrigger.Rule, error)
	AddRule(origin, target, by string) (channeltrigger.Rule, error)
	DeleteRule(id string) error
	List(channel string, limit int) ([]channeltrigger.Record, error)
}

func writeTriggerError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, channeltrigger.ErrValidation):
		http.Error(w, err.Error(), http.StatusBadRequest)
	case errors.Is(err, channeltrigger.ErrNotFound):
		http.Error(w, err.Error(), http.StatusNotFound)
	default:
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// handleSendChannelTrigger: POST /api/v1/playout/channels/{id}/triggers.
func handleSendChannelTrigger(router ChannelTriggerService, svc PlayoutService, az verbChecker, roles InstanceRoleResolver) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		origin, ok := channelAccess(svc, az, roles, w, r)
		if !ok {
			return
		}
		var req channeltrigger.Request
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		deliveries, err := router.Send(origin, req, actorFromRequest(r))
		if err != nil {
			writeTriggerError(w, err)
			return
		}
		status := http.StatusAccepted
		denied := 0
		for _, d := range deliveries {
			if d.Status == channeltrigger.StatusDenied {
				denied++
			}
		}
		if denied == len(deliveries) {
			status = http.StatusForbidden // nichts zugestellt: alle Ziele verweigert
		}
		writeJSON(w, status, map[string]any{"deliveries": deliveries})
	}
}

// handleAckChannelTrigger: POST /api/v1/playout/channels/{id}/trigger-ack {"id","status","detail"}.
func handleAckChannelTrigger(router ChannelTriggerService, svc PlayoutService, az verbChecker, roles InstanceRoleResolver) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ch, ok := channelAccess(svc, az, roles, w, r)
		if !ok {
			return
		}
		var body struct {
			ID     string `json:"id"`
			Status string `json:"status"`
			Detail string `json:"detail"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&body); err != nil || body.ID == "" {
			http.Error(w, "id und status erforderlich", http.StatusBadRequest)
			return
		}
		rec, err := router.Ack(ch.ID, body.ID, body.Status, body.Detail, actorFromRequest(r))
		if err != nil {
			writeTriggerError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, rec)
	}
}

// handleListChannelTriggers: GET /api/v1/playout/triggers?channel=&limit=.
func handleListChannelTriggers(store ChannelTriggerStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		list, err := store.List(r.URL.Query().Get("channel"), limit)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

func handleListTriggerRules(store ChannelTriggerStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rules, err := store.Rules()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, rules)
	}
}

func handleAddTriggerRule(store ChannelTriggerStore, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Origin string `json:"origin"`
			Target string `json:"target"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		rule, err := store.AddRule(body.Origin, body.Target, actorFromRequest(r))
		if err != nil {
			writeTriggerError(w, err)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "channel_trigger_rule", rule.ID, "created", map[string]any{"origin": rule.Origin, "target": rule.Target})
		writeJSON(w, http.StatusCreated, rule)
	}
}

func handleDeleteTriggerRule(store ChannelTriggerStore, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := store.DeleteRule(r.PathValue("id")); err != nil {
			writeTriggerError(w, err)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "channel_trigger_rule", r.PathValue("id"), "deleted", nil)
		w.WriteHeader(http.StatusNoContent)
	}
}
