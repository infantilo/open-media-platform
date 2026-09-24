package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/groups"
)

// ---- Gruppen (Nutzerauftrag 2026-09-24) ------------------------------------------------------------
//
// Bewusst global gescopt (VerbAdmin, s. server.go-Routen) — dieselbe
// Stufe wie Rollenbindungen/Organisationen/Nutzerverwaltung selbst:
// eine Gruppe verwalten heißt letztlich Rechte verwalten, kein
// gewöhnliches "configure".

// GroupService verwaltet Gruppen + Mitgliedschaft (implementiert von
// *groups.Store).
type GroupService interface {
	Create(name, description, createdBy string) (groups.Group, error)
	Get(id string) (groups.Group, error)
	List() ([]groups.Group, error)
	UpdateMeta(id, name, description string) (groups.Group, error)
	Delete(id string, cascadeBindings bool) error
	CountBindings(id string) (int, error)
	ListMembers(groupID string) ([]string, error)
	AddMember(groupID, username string) error
	RemoveMember(groupID, username string) error
}

func handleListGroups(svc GroupService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := svc.List()
		if err != nil {
			writeGroupError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

func handleGetGroup(svc GroupService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		g, err := svc.Get(r.PathValue("id"))
		if err != nil {
			writeGroupError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, g)
	}
}

func handleCreateGroup(svc GroupService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name        string `json:"name"`
			Description string `json:"description"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		createdBy := actorFromRequest(r)
		g, err := svc.Create(body.Name, body.Description, createdBy)
		if err != nil {
			writeGroupError(w, err)
			return
		}
		logDomainAudit(domainAudit, createdBy, "group", g.ID, "created", map[string]any{"name": g.Name})
		writeJSON(w, http.StatusOK, g)
	}
}

func handleUpdateGroup(svc GroupService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name        string `json:"name"`
			Description string `json:"description"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		g, err := svc.UpdateMeta(r.PathValue("id"), body.Name, body.Description)
		if err != nil {
			writeGroupError(w, err)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "group", g.ID, "updated", map[string]any{"name": g.Name})
		writeJSON(w, http.StatusOK, g)
	}
}

// handleDeleteGroup liefert DELETE /api/v1/groups/{id}[?cascade=true].
// Ohne ?cascade=true UND solange noch Rollenbindungen auf die Gruppe
// verweisen: 409 mit der genauen Anzahl (Nutzerauftrag: "protection
// guards... with warnings") — role_bindings kann diese Beziehung nicht
// per Fremdschlüssel selbst schützen (s. Migrations-Doku), deshalb hier
// vorab gezählt. Mit ?cascade=true werden die Bindungen mitgelöscht
// (bewusst sicher, s. groups.Store.Delete-Doku: anders als bei
// Storage-Backends/Organisationen ist das Kaskadieren hier ungefährlich)
// — AUSSER die Gruppe trägt die einzige globale Admin-Bindung des
// anfragenden Nutzers selbst (Selbstschutz analog handleDeleteUser/
// handleDeleteRoleBinding, §11.4b): sonst könnte ein Löschen der
// GRUPPE denselben Aussperr-Effekt haben wie das direkte Löschen der
// einzelnen Bindung, ohne von der dortigen Prüfung erfasst zu werden.
func handleDeleteGroup(svc GroupService, authzStore AuthzChecker, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		cascade := r.URL.Query().Get("cascade") == "true"
		if !cascade {
			if n, err := svc.CountBindings(id); err == nil && n > 0 {
				http.Error(w, groupInUseMessage(n), http.StatusConflict)
				return
			}
		} else if p, ok := principalFromContext(r); ok {
			if blocked := wouldRemoveOwnLastAdminAccess(p.Username, id, svc, authzStore); blocked {
				http.Error(w, "cannot delete this group: it is your own last remaining path to admin access", http.StatusConflict)
				return
			}
		}
		if err := svc.Delete(id, cascade); err != nil {
			writeGroupError(w, err)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "group", id, "deleted", map[string]any{"cascade": cascade})
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// wouldRemoveOwnLastAdminAccess prüft, ob username Mitglied von groupID
// ist, groupID eine globale Admin-Bindung trägt, UND username dadurch
// aktuell der einzige globale Admin ist — der gemeinsame Kern der
// Selbstschutzprüfung in handleDeleteGroup (Kaskaden-Löschung) und
// perspektivisch handleRemoveGroupMember, falls dort künftig dieselbe
// Lücke auftritt. Best effort: liefert false (kein Block) bei einem
// Lade-Fehler, statt eine Aktion mit einem verwirrenden 500 zu
// blockieren — dieselbe Abwägung wie die übrigen Selbstschutzprüfungen.
func wouldRemoveOwnLastAdminAccess(username, groupID string, svc GroupService, authzStore AuthzChecker) bool {
	bindings, err := authzStore.Load()
	if err != nil {
		return false
	}
	admins := globalAdminSubjects(bindings, svc)
	if !admins[username] || len(admins) != 1 {
		return false
	}
	hasGroupAdminBinding := false
	for _, b := range bindings {
		if b.SubjectType == authz.SubjectTypeGroup && b.Subject == groupID && b.NodeID == authz.AnyNode && b.Verb == authz.VerbAdmin {
			hasGroupAdminBinding = true
			break
		}
	}
	if !hasGroupAdminBinding {
		return false
	}
	members, err := svc.ListMembers(groupID)
	if err != nil {
		return false
	}
	for _, m := range members {
		if m == username {
			return true
		}
	}
	return false
}

func groupInUseMessage(n int) string {
	if n == 1 {
		return "this group still has 1 role binding — remove it first, or delete with ?cascade=true to remove it along with the group"
	}
	return "this group still has role bindings — remove them first, or delete with ?cascade=true to remove them along with the group"
}

func handleListGroupMembers(svc GroupService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		members, err := svc.ListMembers(r.PathValue("id"))
		if err != nil {
			writeGroupError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, members)
	}
}

func handleAddGroupMember(svc GroupService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Username string `json:"username"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Username == "" {
			http.Error(w, "username required", http.StatusBadRequest)
			return
		}
		groupID := r.PathValue("id")
		if err := svc.AddMember(groupID, body.Username); err != nil {
			writeGroupError(w, err)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "group", groupID, "member_added", map[string]any{"username": body.Username})
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

func handleRemoveGroupMember(svc GroupService, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		groupID := r.PathValue("id")
		username := r.PathValue("username")
		if err := svc.RemoveMember(groupID, username); err != nil {
			writeGroupError(w, err)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "group", groupID, "member_removed", map[string]any{"username": username})
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

func writeGroupError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, groups.ErrNotFound):
		http.Error(w, err.Error(), http.StatusNotFound)
	case errors.Is(err, groups.ErrValidation):
		http.Error(w, err.Error(), http.StatusBadRequest)
	default:
		if isForeignKeyViolation(err) {
			// AddMember gegen einen erfundenen Nutzernamen (s. Migrations-
			// Doku: group_members.username hat einen echten Fremdschlüssel
			// auf users, anders als role_bindings.subject).
			http.Error(w, "unknown username", http.StatusBadRequest)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}
