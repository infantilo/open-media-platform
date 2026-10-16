package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/authz"
)

// ProcessScopePrefix kennzeichnet in role_bindings.workflow_id eine
// Prozess-gescopte Bindung ("process:<processDefinitionId>", nodeId "*").
// Kein eigenes Schema nötig: workflow_id ist ein freier Bereichsschlüssel,
// CheckWorkflow prüft ihn unverändert.
const ProcessScopePrefix = "process:"

// requireVerbOnProcess erlaubt die Aktion, wenn der Nutzer minVerb ENTWEDER
// global hat (wie bisher requireVerbGlobal) ODER eine Bindung auf genau den
// Prozess, den resolve aus der Anfrage ermittelt (leer = nur global).
func (g *authGate) requireVerbOnProcess(minVerb authz.Verb, resolve func(r *http.Request) string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, bypass, ok := g.authenticate(r)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if !bypass {
			allowed, err := g.authz.Check(p.Username, authz.AnyNode, minVerb)
			if err == nil && !allowed {
				if defID := resolve(r); defID != "" {
					allowed, err = g.authz.CheckWorkflow(p.Username, ProcessScopePrefix+defID, authz.AnyNode, minVerb)
				}
			}
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			if !allowed {
				g.audit.Log(p.Username, r.Method, r.URL.Path, "", http.StatusForbidden)
				http.Error(w, "forbidden", http.StatusForbidden)
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

func processDefFromPath(r *http.Request) string { return r.PathValue("id") }

func processDefFromVersionPath(svc ProcessStoreService) func(*http.Request) string {
	return func(r *http.Request) string {
		v, err := svc.GetVersion(r.PathValue("id"))
		if err != nil {
			return ""
		}
		return v.ProcessDefinitionID
	}
}

func processDefFromExecutionPath(svc ProcessStoreService) func(*http.Request) string {
	return func(r *http.Request) string {
		e, err := svc.GetExecution(r.PathValue("id"))
		if err != nil {
			return ""
		}
		return e.ProcessDefinitionID
	}
}

// processDefFromBody liest processDefinitionId aus dem JSON-Body und stellt
// den Body für den eigentlichen Handler wieder her.
func processDefFromBody(r *http.Request) string {
	if r.Body == nil {
		return ""
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		return ""
	}
	r.Body = io.NopCloser(bytes.NewReader(raw))
	var b struct {
		ProcessDefinitionID string `json:"processDefinitionId"`
	}
	_ = json.Unmarshal(raw, &b)
	return b.ProcessDefinitionID
}
