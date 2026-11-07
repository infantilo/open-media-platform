package alertsink

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/storagebackends"
)

// MailConfig ist die in der Oberfläche eingestellte E-Mail-Alarmierung.
type MailConfig struct {
	Enabled     bool    `json:"enabled"`
	Host        string  `json:"host"`
	Port        int     `json:"port"` // 0 = Standard je Sicherung
	Security    string  `json:"security"`
	User        string  `json:"user"`
	Password    string  `json:"password,omitempty"` // nur Eingabe; wird nie ausgegeben
	HasPassword bool    `json:"hasPassword"`
	From        string  `json:"from"`
	To          string  `json:"to"` // Standard-Empfänger (wenn keine Regel passt)
	Routes      []Route `json:"routes"`
}

// ErrNoSecretKey: ohne OMP_STORAGE_SECRET_KEY darf kein Kennwort gespeichert werden.
var ErrNoSecretKey = errors.New("Kennwort kann nicht gespeichert werden: OMP_STORAGE_SECRET_KEY ist nicht gesetzt")

// MailStore liest und schreibt die Konfiguration (Tabelle alert_mail_config) und
// liefert dem Sink den jeweils aktuellen Mailer (kurz zwischengespeichert, damit
// auch ein anderer Orchestrator im Cluster nach einem Leaderwechsel die Werte nutzt).
type MailStore struct {
	db  *sql.DB
	key []byte // nil = kein Kennwort speicherbar
	env *Mailer

	mu      sync.Mutex
	cached  *Mailer
	cacheAt time.Time
	now     func() time.Time
}

// NewMailStore: secretKey ist OMP_STORAGE_SECRET_KEY (leer erlaubt); env ist der Mailer aus
// den Umgebungsvariablen (Rückfall, solange in der Oberfläche nichts eingestellt ist).
func NewMailStore(db *sql.DB, secretKey string, env *Mailer) (*MailStore, error) {
	s := &MailStore{db: db, env: env, now: time.Now}
	if secretKey != "" {
		k, err := storagebackends.DecodeMasterKey(secretKey)
		if err != nil {
			return nil, err
		}
		s.key = k
	}
	return s, nil
}

// Get liefert die gespeicherte Konfiguration (ok=false: nichts eingestellt).
func (s *MailStore) Get() (MailConfig, bool, error) {
	var c MailConfig
	var enc, routes []byte
	err := s.db.QueryRow(`SELECT enabled, host, port, security, username, password_enc, from_addr, to_addrs, routes FROM alert_mail_config WHERE id = 1`).
		Scan(&c.Enabled, &c.Host, &c.Port, &c.Security, &c.User, &enc, &c.From, &c.To, &routes)
	if errors.Is(err, sql.ErrNoRows) {
		return MailConfig{}, false, nil
	}
	if err != nil {
		return MailConfig{}, false, err
	}
	c.HasPassword = len(enc) > 0
	if err := json.Unmarshal(routes, &c.Routes); err != nil {
		return MailConfig{}, false, err
	}
	if c.Routes == nil {
		c.Routes = []Route{}
	}
	return c, true, nil
}

func (s *MailStore) password() (string, error) {
	var enc []byte
	if err := s.db.QueryRow(`SELECT password_enc FROM alert_mail_config WHERE id = 1`).Scan(&enc); err != nil || len(enc) == 0 {
		return "", nil
	}
	if s.key == nil {
		return "", ErrNoSecretKey
	}
	return storagebackends.DecryptSecret(s.key, enc)
}

// Mailer baut aus der gespeicherten Konfiguration einen Mailer (nil = ausgeschaltet/unvollständig).
func (s *MailStore) mailerFromDB() (*Mailer, bool, error) {
	c, ok, err := s.Get()
	if err != nil || !ok {
		return nil, false, err
	}
	if !c.Enabled {
		return nil, true, nil
	}
	pw, err := s.password()
	if err != nil {
		return nil, true, err
	}
	m, err := NewMailerWithRoutes(c.Host, portText(c.Port), c.User, pw, c.From, c.To, c.Security, c.Routes)
	return m, true, err
}

func portText(p int) string {
	if p == 0 {
		return ""
	}
	return strconv.Itoa(p)
}

// Current ist der Anbieter für Sink.MailProvider.
func (s *MailStore) Current() *Mailer {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.now().Sub(s.cacheAt) < 15*time.Second && !s.cacheAt.IsZero() {
		return s.cached
	}
	m, inDB, err := s.mailerFromDB()
	if err != nil {
		// Datenbank oder Konfiguration unbrauchbar: letzten guten Stand behalten.
		return s.cached
	}
	if !inDB {
		m = s.env
	}
	s.cached, s.cacheAt = m, s.now()
	return m
}

// Source nennt die wirksame Quelle: "ui", "env" oder "none".
func (s *MailStore) Source() string {
	if _, ok, _ := s.Get(); ok {
		return "ui"
	}
	if s.env != nil {
		return "env"
	}
	return "none"
}

// Save prüft und speichert. Leeres Password behält das vorhandene.
func (s *MailStore) Save(c MailConfig, by string) error {
	pw := c.Password
	m, err := NewMailerWithRoutes(c.Host, portText(c.Port), c.User, pw, c.From, c.To, c.Security, c.Routes)
	if err != nil {
		return err
	}
	if m == nil {
		return fmt.Errorf("Server und mindestens ein Empfänger (Standard oder in einer aktiven Regel) sind Pflicht")
	}
	routes, _ := json.Marshal(c.Routes)
	if c.Routes == nil {
		routes = []byte("[]")
	}
	var enc []byte
	if pw != "" {
		if s.key == nil {
			return ErrNoSecretKey
		}
		var err error
		if enc, err = storagebackends.EncryptSecret(s.key, pw); err != nil {
			return err
		}
	}
	if c.User == "" {
		enc = nil
		pw = ""
	}
	_, err = s.db.Exec(`INSERT INTO alert_mail_config (id, enabled, host, port, security, username, password_enc, from_addr, to_addrs, updated_by, routes)
		VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
		ON CONFLICT (id) DO UPDATE SET enabled=$1, host=$2, port=$3, security=$4, username=$5,
		  password_enc = CASE WHEN $5 = '' THEN NULL WHEN $6::bytea IS NULL THEN alert_mail_config.password_enc ELSE $6 END,
		  from_addr=$7, to_addrs=$8, updated_by=$9, routes=$10::jsonb, updated_at=now()`,
		c.Enabled, c.Host, c.Port, nz(c.Security, "starttls"), c.User, enc, c.From, c.To, by, string(routes))
	if err == nil {
		s.mu.Lock()
		s.cacheAt = time.Time{}
		s.mu.Unlock()
	}
	return err
}

func nz(v, d string) string {
	if v == "" {
		return d
	}
	return v
}

// Delete entfernt die Einstellung in der Oberfläche (zurück zu den Umgebungsvariablen).
func (s *MailStore) Delete() error {
	_, err := s.db.Exec(`DELETE FROM alert_mail_config WHERE id = 1`)
	s.mu.Lock()
	s.cacheAt = time.Time{}
	s.mu.Unlock()
	return err
}

// TestMailer baut für „Testmail senden“ den Mailer aus Eingabewerten; leeres Kennwort nimmt das gespeicherte.
func (s *MailStore) TestMailer(c MailConfig) (*Mailer, error) {
	pw := c.Password
	if pw == "" && c.User != "" {
		pw, _ = s.password()
	}
	m, err := NewMailerWithRoutes(c.Host, portText(c.Port), c.User, pw, c.From, c.To, c.Security, c.Routes)
	if err == nil && m == nil {
		err = fmt.Errorf("Server und mindestens ein Empfänger sind Pflicht")
	}
	return m, err
}

// TestSend schickt eine Testmail. Ohne kind direkt an alle Empfänger (Standard + Regeln);
// mit kind (und optional workflowID) wie ein echter Alarm dieser Art (Schweregrad severity, leer = Standard der Art) durch die Regeln geleitet.
// Rückgabe: die Empfänger.
// status (optional) liefert die Statusbeilage; statusMode überschreibt den Wunsch der Regeln (leer = Regeln entscheiden,
// bei der ungerichteten Testmail: keine Beilage).
func TestSend(ctx context.Context, m *Mailer, kind, severity, workflowID, processID, action string, status func(Alert) *StatusReport, statusMode string) ([]string, error) {
	a := Alert{Kind: "test", Subject: "alert-mail", Name: "Testmail", Time: time.Now(), Severity: SevInfo,
		Message: "Dies ist eine Testnachricht der OpenMediaPlatform. Die E-Mail-Alarmierung funktioniert."}
	to := m.allRecipients()
	if kind != "" {
		if !validKindName(kind) {
			return nil, fmt.Errorf("ungültige Alarmart %q", kind)
		}
		a.Kind = kind
		a.Action = action
		if processID != "" {
			a.Processes = []ProcessRef{{ID: processID, Name: processID}}
		}
		if workflowID != "" {
			a.Workflows = []WorkflowRef{{ID: workflowID, Name: workflowID}}
		}
		a.Severity = severity
		if !validSeverity(a.Severity) {
			a.Severity = DefaultSeverity(kind)
		}
		a.Message = "TESTMELDUNG (kein echter Alarm) — zeigt, wer diese Alarmart mit diesem Schweregrad erhält."
		to = m.Recipients(a)
		if len(to) == 0 {
			return nil, nil
		}
		if statusMode == "" {
			statusMode = m.StatusMode(a)
		}
	}
	if validStatusMode(statusMode) && statusMode != StatusNone && status != nil {
		a.StatusMode = statusMode
		a.Status = status(a)
	}
	return to, m.SendTo(ctx, a, to)
}

// ErrNoMailConfig: Regeln lassen sich nur speichern, wenn die E-Mail-Alarmierung in der Oberfläche eingerichtet ist.
var ErrNoMailConfig = errors.New("E-Mail-Alarmierung ist hier nicht in der Oberfläche eingerichtet")

// editRoutes liest die Regeln unter Zeilensperre, wendet f an und schreibt sie zurück.
func (s *MailStore) editRoutes(f func([]Route) ([]Route, error)) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var raw []byte
	if err := tx.QueryRow(`SELECT routes FROM alert_mail_config WHERE id = 1 FOR UPDATE`).Scan(&raw); errors.Is(err, sql.ErrNoRows) {
		return ErrNoMailConfig
	} else if err != nil {
		return err
	}
	var routes []Route
	if err := json.Unmarshal(raw, &routes); err != nil {
		return err
	}
	out, err := f(routes)
	if err != nil {
		return err
	}
	if out == nil {
		out = []Route{}
	}
	b, _ := json.Marshal(out)
	if _, err := tx.Exec(`UPDATE alert_mail_config SET routes = $1::jsonb, updated_at = now() WHERE id = 1`, string(b)); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.mu.Lock()
	s.cacheAt = time.Time{}
	s.mu.Unlock()
	return nil
}

// WorkflowRules liefert die Regeln, die (auch) für den Workflow gelten, übertragbar gemacht:
// ohne Workflow-Zuordnung (beim Import wird sie neu gesetzt).
func (s *MailStore) WorkflowRules(workflowID string) ([]Route, error) {
	c, ok, err := s.Get()
	if err != nil || !ok {
		return nil, err
	}
	var out []Route
	for _, r := range c.Routes {
		if member(r.Workflows, workflowID) {
			r.Workflows = []string{}
			r.Processes = []string{}
			out = append(out, r)
		}
	}
	return out, nil
}

// AddWorkflowRules hängt Regeln an, begrenzt auf den (neuen) Workflow.
func (s *MailStore) AddWorkflowRules(workflowID string, rules []Route) error {
	for _, r := range rules {
		if err := r.Validate(); err != nil {
			return err
		}
	}
	return s.editRoutes(func(cur []Route) ([]Route, error) {
		for _, r := range rules {
			r.Workflows = []string{workflowID}
			cur = append(cur, r)
		}
		return cur, nil
	})
}

// RemoveWorkflow räumt nach dem Löschen eines Workflows auf: die ID verschwindet aus allen Regeln;
// eine Regel, die danach keinen Geltungsbereich mehr hat, wird entfernt (sie würde sonst plötzlich für alle gelten).
// Ohne eingerichtete Mail-Konfiguration gibt es nichts aufzuräumen.
func (s *MailStore) RemoveWorkflow(workflowID string) error { return s.removeScope(workflowID, false) }

// RemoveProcess macht dasselbe nach dem Löschen eines Prozesses (Definition).
func (s *MailStore) RemoveProcess(processID string) error { return s.removeScope(processID, true) }

func (s *MailStore) removeScope(id string, process bool) error {
	drop := func(list []string) []string {
		var rest []string
		for _, w := range list {
			if w != id {
				rest = append(rest, w)
			}
		}
		return rest
	}
	err := s.editRoutes(func(cur []Route) ([]Route, error) {
		var out []Route
		for _, r := range cur {
			scoped := len(r.Workflows) > 0 || len(r.Processes) > 0
			if process {
				r.Processes = drop(r.Processes)
			} else {
				r.Workflows = drop(r.Workflows)
			}
			if scoped && len(r.Workflows) == 0 && len(r.Processes) == 0 {
				continue
			}
			out = append(out, r)
		}
		return out, nil
	})
	if errors.Is(err, ErrNoMailConfig) {
		return nil
	}
	return err
}

// KnownActions liefert die bisher protokollierten Benutzeraktionen (objektart.aktion) — dynamisch aus dem Domänen-Audit.
func (s *MailStore) KnownActions() ([]string, error) {
	rows, err := s.db.Query(`SELECT DISTINCT object_type || '.' || action FROM domain_audit_log ORDER BY 1`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var a string
		if err := rows.Scan(&a); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
