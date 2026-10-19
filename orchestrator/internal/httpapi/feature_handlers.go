package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/module"
)

// Funktionsrechte, Kachel-Sicht und Aufgabenliste (Kapitel 44).

// featureStore ist die optionale Fähigkeit des Rechte-Speichers (implementiert von *authz.Store).
type featureStore interface {
	HasFeature(username, feature string) (bool, error)
	FeaturePatterns(username string) (patterns []string, all bool, err error)
	GroupsOf(username string) ([]string, error)
	ListFeatureGrants() ([]authz.FeatureGrant, error)
	CreateFeatureGrant(subjectType, subject, feature, createdBy string) (authz.FeatureGrant, error)
	DeleteFeatureGrant(id string) error
	DeleteFeatureGrantsBySubject(subjectType, subject string) error
}

// requireFeature verlangt das Funktionsrecht `feature` (globales `configure` deckt es ab). Im Bootstrap-Modus (noch kein
// Nutzer) offen wie die übrigen Rechteprüfungen.
func (g *authGate) requireFeature(features []string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, bypass, ok := g.authenticate(r)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if !bypass {
			fs, ok := g.authz.(featureStore)
			if !ok {
				http.Error(w, "feature rights unavailable", http.StatusInternalServerError)
				return
			}
			allowed := false
			for _, feature := range features {
				ok, err := fs.HasFeature(p.Username, feature)
				if err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
				if ok {
					allowed = true
					break
				}
			}
			if !allowed {
				g.audit.Log(p.Username, r.Method, r.URL.Path, "", http.StatusForbidden)
				http.Error(w, "forbidden: missing right "+strings.Join(features, " or "), http.StatusForbidden)
				return
			}
			r = r.WithContext(contextWithPrincipal(r.Context(), p))
		}
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next(rec, r)
		if !bypass && r.Method != http.MethodGet {
			g.audit.Log(p.Username, r.Method, r.URL.Path, "", rec.status)
		}
	}
}

// handleListFeatures: GET /api/v1/features — Katalog aller Funktionsrechte der gemounteten Module.
func handleListFeatures(reg *module.Registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		out := []module.FeatureDef{}
		if reg != nil {
			out = append(out, reg.Features()...)
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// handleMeFeatures: GET /api/v1/me/features — was der angemeldete Nutzer darf: `all` (globales configure) oder Muster.
func handleMeFeatures(authzStore AuthzChecker) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, ok := principalFromContext(r)
		if !ok { // Bootstrap-Modus: alles erlaubt
			writeJSON(w, http.StatusOK, map[string]any{"all": true, "patterns": []string{}, "groups": []string{}})
			return
		}
		fs, ok := authzStore.(featureStore)
		if !ok {
			writeJSON(w, http.StatusOK, map[string]any{"all": false, "patterns": []string{}, "groups": []string{}})
			return
		}
		patterns, all, err := fs.FeaturePatterns(p.Username)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if patterns == nil {
			patterns = []string{}
		}
		groups, err := fs.GroupsOf(p.Username)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if groups == nil {
			groups = []string{}
		}
		// groups: IDs der Gruppen der Person — die Oberfläche erkennt daran „meine“ Gruppenaufgaben.
		writeJSON(w, http.StatusOK, map[string]any{"all": all, "patterns": patterns, "groups": groups})
	}
}

func handleListFeatureGrants(authzStore AuthzChecker) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		fs, ok := authzStore.(featureStore)
		if !ok {
			http.Error(w, "feature rights unavailable", http.StatusInternalServerError)
			return
		}
		list, err := fs.ListFeatureGrants()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, list)
	}
}

func handleCreateFeatureGrant(authzStore AuthzChecker, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		fs, ok := authzStore.(featureStore)
		if !ok {
			http.Error(w, "feature rights unavailable", http.StatusInternalServerError)
			return
		}
		var body struct {
			SubjectType string `json:"subjectType"`
			Subject     string `json:"subject"`
			Feature     string `json:"feature"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&body); err != nil {
			http.Error(w, "invalid json", http.StatusBadRequest)
			return
		}
		actor := ""
		if p, ok := principalFromContext(r); ok {
			actor = p.Username
		}
		g, err := fs.CreateFeatureGrant(body.SubjectType, body.Subject, body.Feature, actor)
		if err != nil {
			if errors.Is(err, authz.ErrFeatureValidation) {
				http.Error(w, "invalid subject or feature", http.StatusBadRequest)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if domainAudit != nil {
			domainAudit.Log(actor, "feature_grant", g.ID, "grant", map[string]any{"subjectType": g.SubjectType, "subject": g.Subject, "feature": g.Feature})
		}
		writeJSON(w, http.StatusCreated, g)
	}
}

func handleDeleteFeatureGrant(authzStore AuthzChecker, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		fs, ok := authzStore.(featureStore)
		if !ok {
			http.Error(w, "feature rights unavailable", http.StatusInternalServerError)
			return
		}
		id := r.PathValue("id")
		if err := fs.DeleteFeatureGrant(id); err != nil {
			if errors.Is(err, authz.ErrFeatureNotFound) {
				http.Error(w, "not found", http.StatusNotFound)
				return
			}
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if domainAudit != nil {
			actor := ""
			if p, ok := principalFromContext(r); ok {
				actor = p.Username
			}
			domainAudit.Log(actor, "feature_grant", id, "revoke", nil)
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// handleMeTasks: GET /api/v1/me/tasks — Aufgaben des Nutzers aus allen Modulen (zugewiesen, Gruppenaufgaben, eigene Aufnahmen).
func handleMeTasks(reg *module.Registry, authzStore AuthzChecker) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if reg == nil {
			writeJSON(w, http.StatusOK, map[string]any{"tasks": []module.Task{}})
			return
		}
		who := module.Identity{Has: func(string) bool { return true }}
		if p, ok := principalFromContext(r); ok {
			who.User = p.Username
			if fs, ok := authzStore.(featureStore); ok {
				groups, err := fs.GroupsOf(p.Username)
				if err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
				who.Groups = groups
				patterns, all, err := fs.FeaturePatterns(p.Username)
				if err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
				who.Has = func(f string) bool {
					if all {
						return true
					}
					for _, pat := range patterns {
						if authz.FeatureMatches(pat, f) {
							return true
						}
					}
					return false
				}
			}
		}
		tasks, errs := reg.Tasks(r.Context(), who)
		writeJSON(w, http.StatusOK, map[string]any{"tasks": tasks, "errors": errs})
	}
}

// handleDirectory: GET /api/v1/directory — Nutzernamen und Gruppen (ID, Name) zum Auswählen von Verantwortlichen. Nur für
// Personen mit mindestens einem Funktionsrecht (oder globalem „configure“): Auswahl-Listen brauchen genau die, die zuweisen.
func handleDirectory(authSvc AuthService, groupSvc GroupService, authzStore AuthzChecker) http.HandlerFunc {
	type user struct {
		Username string `json:"username"`
	}
	type group struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if p, ok := principalFromContext(r); ok {
			fs, ok := authzStore.(featureStore)
			if !ok {
				http.Error(w, "feature rights unavailable", http.StatusInternalServerError)
				return
			}
			patterns, all, err := fs.FeaturePatterns(p.Username)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			if !all && len(patterns) == 0 {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
		}
		users, err := authSvc.ListUsers(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := struct {
			Users  []user  `json:"users"`
			Groups []group `json:"groups"`
		}{Users: []user{}, Groups: []group{}}
		for _, u := range users {
			out.Users = append(out.Users, user{Username: u.Username})
		}
		if groupSvc != nil {
			gs, err := groupSvc.List()
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			for _, g := range gs {
				out.Groups = append(out.Groups, group{ID: g.ID, Name: g.Name})
			}
		}
		writeJSON(w, http.StatusOK, out)
	}
}
