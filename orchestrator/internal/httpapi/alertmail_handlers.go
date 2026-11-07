package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/alertsink"
)

// AlertMailStore ist die Einstellung der E-Mail-Alarmierung (*alertsink.MailStore, Kap. 83).
type AlertMailStore interface {
	Get() (alertsink.MailConfig, bool, error)
	Save(c alertsink.MailConfig, by string) error
	Delete() error
	Source() string
	TestMailer(c alertsink.MailConfig) (*alertsink.Mailer, error)
	RemoveProcess(processID string) error
	KnownActions() ([]string, error)
}

// WithAlertMail aktiviert /api/v1/admin/settings/alert-mail*. Ein nil-Zeiger schaltet es aus.
func WithAlertMail(s *alertsink.MailStore) HandlerOption {
	return func(o *handlerOptions) {
		if s != nil {
			o.alertMail = s
		}
	}
}

// WithAlertStatus liefert die Statusbeilage für Testmail und Vorschau (dieselbe Quelle wie beim echten Alarm).
func WithAlertStatus(f func(alertsink.Alert) *alertsink.StatusReport) HandlerOption {
	return func(o *handlerOptions) { o.alertStatus = f }
}

// handleAlertStatusPreview: POST {"node": "<Node-ID, leer = Node mit dem längsten Signalweg>"} → Statusbeilage als Text, PNG (Base64) und SVG.
// Braucht keinen Mailserver — zum Ansehen, bevor ein Server eingerichtet ist.
func handleAlertStatusPreview(f func(alertsink.Alert) *alertsink.StatusReport) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if f == nil {
			http.Error(w, "Statusbeilage nicht verfügbar", http.StatusNotImplemented)
			return
		}
		var body struct {
			Node string `json:"node"`
		}
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body)
		rep := f(alertsink.Alert{Kind: "test", Subject: strings.TrimSpace(body.Node), Name: "Vorschau", Time: time.Now()})
		if rep == nil {
			http.Error(w, "kein Status verfügbar", http.StatusServiceUnavailable)
			return
		}
		title := "Signalweg bis zur Wurzel"
		png, _ := rep.Flow.PNG(title)
		writeJSON(w, http.StatusOK, map[string]any{"text": rep.Text(), "png": base64.StdEncoding.EncodeToString(png), "svg": string(rep.Flow.SVG(title)), "report": rep})
	}
}

// handleGetAlertMail: GET → gespeicherte Werte (ohne Kennwort), wirksame Quelle.
func handleGetAlertMail(s AlertMailStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s == nil {
			http.Error(w, "E-Mail-Alarmierung nicht konfiguriert", http.StatusNotImplemented)
			return
		}
		c, ok, err := s.Get()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if !ok {
			c = alertsink.MailConfig{Enabled: false, Security: "starttls", Routes: []alertsink.Route{}} // ohne eingetragenen Server standardmäßig aus
		}
		c.Password = ""
		actions, err := s.KnownActions()
		if err != nil {
			actions = []string{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"config": c, "stored": ok, "source": s.Source(), "kinds": alertsink.ListKinds(), "actions": actions})
	}
}

func decodeMailConfig(w http.ResponseWriter, r *http.Request) (alertsink.MailConfig, bool) {
	var c alertsink.MailConfig
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(&c); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return c, false
	}
	return c, true
}

// handlePutAlertMail: PUT speichert (wirksam binnen etwa 15 s, ohne Neustart).
func handlePutAlertMail(s AlertMailStore, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s == nil {
			http.Error(w, "E-Mail-Alarmierung nicht konfiguriert", http.StatusNotImplemented)
			return
		}
		c, ok := decodeMailConfig(w, r)
		if !ok {
			return
		}
		if err := s.Save(c, actorFromRequest(r)); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "system_setting", "alert_mail", "set",
			map[string]any{"host": c.Host, "port": c.Port, "security": c.Security, "to": c.To, "enabled": c.Enabled, "routes": len(c.Routes)})
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

// handleDeleteAlertMail: DELETE entfernt die Oberflächen-Einstellung (zurück zu den Umgebungsvariablen).
func handleDeleteAlertMail(s AlertMailStore, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s == nil {
			http.Error(w, "E-Mail-Alarmierung nicht konfiguriert", http.StatusNotImplemented)
			return
		}
		if err := s.Delete(); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "system_setting", "alert_mail", "delete", nil)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

// handleTestAlertMail: POST sendet sofort eine Testmail mit den übergebenen (noch ungespeicherten) Werten.
// Mit "testKind" (und optional "testSeverity") wird sie wie ein echter Alarm dieser Art durch die Regeln geleitet.
func handleTestAlertMail(s AlertMailStore, f func(alertsink.Alert) *alertsink.StatusReport) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s == nil {
			http.Error(w, "E-Mail-Alarmierung nicht konfiguriert", http.StatusNotImplemented)
			return
		}
		var body struct {
			alertsink.MailConfig
			TestKind     string `json:"testKind"`
			TestSeverity string `json:"testSeverity"`
			TestWorkflow string `json:"testWorkflow"`
			TestProcess  string `json:"testProcess"`
			TestAction   string `json:"testAction"`
			TestStatus   string `json:"testStatus"`
			TestNode     string `json:"testNode"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		m, err := s.TestMailer(body.MailConfig)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
		defer cancel()
		to, err := alertsink.TestSend(ctx, m, body.TestKind, body.TestSeverity, body.TestWorkflow, body.TestProcess, body.TestAction, statusFor(f, body.TestNode), body.TestStatus)
		if err != nil {
			http.Error(w, "Senden fehlgeschlagen: "+err.Error(), http.StatusBadGateway)
			return
		}
		if to == nil {
			to = []string{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "recipients": to})
	}
}

// statusFor bindet den Test-Node an den Provider (leer = der Provider wählt selbst den Node mit dem längsten Signalweg).
func statusFor(f func(alertsink.Alert) *alertsink.StatusReport, node string) func(alertsink.Alert) *alertsink.StatusReport {
	if f == nil {
		return nil
	}
	return func(a alertsink.Alert) *alertsink.StatusReport {
		if a.Subject == "alert-mail" { // Platzhalter-Gegenstand der Testmail
			a.Subject = strings.TrimSpace(node)
		}
		return f(a)
	}
}
