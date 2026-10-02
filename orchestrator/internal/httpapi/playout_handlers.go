package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/playout"
)

// ---- Playout-Domäne (Kapitel 27 / P1a) -----------------------------------------------------------
//
// Zugriffsregeln (E2: eine Instanz pro Channel):
//   - Channels anlegen/ändern/löschen: global `configure`.
//   - Channels lesen: jede angemeldete Identität (auch die Automator-Instanz,
//     die keine globale Bindung hat); Namen/Zeitzone sind nicht geheim.
//   - Zustand + Ausführungsjournal eines Channels: die an ihn gebundene
//     Automator-Instanz (Service-Token-Principal == instanceId) ODER global
//     `operate`. So kann ein Automator nur SEINEN Channel schreiben.

// PlayoutService wird von *playout.Store implementiert.
type PlayoutService interface {
	CreateChannel(in playout.ChannelInput, createdBy string) (playout.Channel, error)
	GetChannel(id string) (playout.Channel, error)
	ChannelByInstance(instanceID string) (playout.Channel, error)
	ChannelByRole(workflowID, role string) (playout.Channel, error)
	ListChannels() ([]playout.Channel, error)
	UpdateChannel(id string, in playout.ChannelInput) (playout.Channel, error)
	DeleteChannel(id string) error
	GetState(channelID string) (playout.State, error)
	PutState(channelID string, expectedVersion int64, state json.RawMessage) (playout.State, error)
	RecordExecution(channelID, executionID, kind string) (bool, error)
}

// InstanceRoleResolver ordnet eine Launcher-Instanz ihrer aktuellen
// Workflow-Rolle zu (*workflows.Service). Nil erlaubt = nur Instanz-Bindung.
type InstanceRoleResolver interface {
	FindRoleForInstance(instanceID string) (workflowID, role string, ok bool)
}

// boundTo meldet, ob `instanceID` die an den Channel gebundene Instanz ist:
// direkt per Instanz-ID oder über die Workflow-Rolle des Channels (die auch
// nach einem Workflow-Neustart mit neuer Instanz-ID gilt).
func boundTo(ch playout.Channel, instanceID string, roles InstanceRoleResolver) bool {
	if instanceID == "" {
		return false
	}
	if ch.Instance != "" && ch.Instance == instanceID {
		return true
	}
	if ch.WorkflowID != "" && roles != nil {
		if wf, role, ok := roles.FindRoleForInstance(instanceID); ok {
			return wf == ch.WorkflowID && role == ch.Role
		}
	}
	return false
}

// verbChecker ist der Ausschnitt von AuthzChecker, den die Playout-Handler brauchen.
type verbChecker interface {
	Check(subject, nodeID string, minVerb authz.Verb) (bool, error)
}

func writePlayoutError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, playout.ErrNotFound):
		http.Error(w, err.Error(), http.StatusNotFound)
	case errors.Is(err, playout.ErrValidation):
		http.Error(w, err.Error(), http.StatusBadRequest)
	case errors.Is(err, playout.ErrConflict):
		http.Error(w, err.Error(), http.StatusConflict)
	default:
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// channelAccess lässt die Anfrage zu, wenn der Principal die gebundene
// Instanz des Channels ist oder global mindestens `operate` hat. Ohne
// Principal im Kontext (Bootstrap-Bypass, noch kein Nutzer angelegt) wird
// wie überall sonst durchgelassen.
func channelAccess(svc PlayoutService, az verbChecker, roles InstanceRoleResolver, w http.ResponseWriter, r *http.Request) (playout.Channel, bool) {
	ch, err := svc.GetChannel(r.PathValue("id"))
	if err != nil {
		writePlayoutError(w, err)
		return playout.Channel{}, false
	}
	p, ok := principalFromContext(r)
	if !ok {
		return ch, true
	}
	if boundTo(ch, p.Username, roles) {
		return ch, true
	}
	allowed, err := az.Check(p.Username, authz.AnyNode, authz.VerbOperate)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return playout.Channel{}, false
	}
	if !allowed {
		http.Error(w, "forbidden", http.StatusForbidden)
		return playout.Channel{}, false
	}
	return ch, true
}

func handleListPlayoutChannels(svc PlayoutService, roles InstanceRoleResolver) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// ?instanceId=…: der Automator findet seinen Channel (höchstens einer).
		if inst := r.URL.Query().Get("instanceId"); inst != "" {
			ch, err := svc.ChannelByInstance(inst)
			if errors.Is(err, playout.ErrNotFound) && roles != nil {
				// Kein direkter Treffer: über die Workflow-Rolle der Instanz suchen.
				if wf, role, ok := roles.FindRoleForInstance(inst); ok {
					ch, err = svc.ChannelByRole(wf, role)
				}
			}
			if errors.Is(err, playout.ErrNotFound) {
				writeJSON(w, http.StatusOK, []playout.Channel{})
				return
			}
			if err != nil {
				writePlayoutError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, []playout.Channel{ch})
			return
		}
		list, err := svc.ListChannels()
		if err != nil {
			writePlayoutError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

func handleGetPlayoutChannel(svc PlayoutService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Lesen ist für view-Nutzer (Routen-Guard) UND die gebundene Instanz erlaubt.
		ch, err := svc.GetChannel(r.PathValue("id"))
		if err != nil {
			writePlayoutError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, ch)
	}
}

func handleCreatePlayoutChannel(svc PlayoutService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in playout.ChannelInput
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		actor := actorFromRequest(r)
		ch, err := svc.CreateChannel(in, actor)
		if err != nil {
			writePlayoutError(w, err)
			return
		}
		logDomainAudit(domainAudit, actor, "playout_channel", ch.ID, "created", map[string]any{"name": ch.Name})
		writeJSON(w, http.StatusOK, ch)
	}
}

func handleUpdatePlayoutChannel(svc PlayoutService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in playout.ChannelInput
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		ch, err := svc.UpdateChannel(r.PathValue("id"), in)
		if err != nil {
			writePlayoutError(w, err)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "playout_channel", ch.ID, "updated", map[string]any{"name": ch.Name, "instanceId": ch.Instance})
		writeJSON(w, http.StatusOK, ch)
	}
}

func handleDeletePlayoutChannel(svc PlayoutService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if err := svc.DeleteChannel(id); err != nil {
			writePlayoutError(w, err)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "playout_channel", id, "deleted", nil)
		w.WriteHeader(http.StatusNoContent)
	}
}

func handleGetPlayoutState(svc PlayoutService, az verbChecker, roles InstanceRoleResolver) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ch, ok := channelAccess(svc, az, roles, w, r)
		if !ok {
			return
		}
		st, err := svc.GetState(ch.ID)
		if err != nil {
			writePlayoutError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, st)
	}
}

// handlePutPlayoutState: PUT {id}/state?version=<n>, Body = Snapshot-JSON.
// `version` ist die zuletzt gelesene Version (0 = erster Schreibzugriff);
// stimmt sie nicht, 409 (Spec §168).
func handlePutPlayoutState(svc PlayoutService, az verbChecker, roles InstanceRoleResolver) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ch, ok := channelAccess(svc, az, roles, w, r)
		if !ok {
			return
		}
		ver, err := strconv.ParseInt(r.URL.Query().Get("version"), 10, 64)
		if err != nil || ver < 0 {
			http.Error(w, "version: erwartet nichtnegative Ganzzahl", http.StatusBadRequest)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, playout.MaxStateBytes+1))
		if err != nil {
			http.Error(w, "state too large or unreadable", http.StatusRequestEntityTooLarge)
			return
		}
		st, err := svc.PutState(ch.ID, ver, body)
		if err != nil {
			writePlayoutError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, st)
	}
}

// handleRecordPlayoutExecution: POST {id}/executions {executionId, kind}
// → {"first": true|false}. first=false: nicht erneut ausführen.
func handleRecordPlayoutExecution(svc PlayoutService, az verbChecker, roles InstanceRoleResolver) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ch, ok := channelAccess(svc, az, roles, w, r)
		if !ok {
			return
		}
		var body struct {
			ExecutionID string `json:"executionId"`
			Kind        string `json:"kind"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		first, err := svc.RecordExecution(ch.ID, body.ExecutionID, body.Kind)
		if err != nil {
			writePlayoutError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"first": first})
	}
}
