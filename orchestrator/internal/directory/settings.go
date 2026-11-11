package directory

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/storagebackends"
)

// ErrNoSecretKey: ohne OMP_STORAGE_SECRET_KEY darf kein Kennwort gespeichert werden.
var ErrNoSecretKey = errors.New("Kennwort kann nicht gespeichert werden: OMP_STORAGE_SECRET_KEY ist nicht gesetzt")

// Settings sind die in der Oberfläche einstellbaren Werte (Tabelle directory_config, eine Zeile).
// Das Dienstkonto-Kennwort wird nie zurückgegeben (HasPassword), nur eingegeben (BindPassword).
type Settings struct {
	Enabled       bool     `json:"enabled"`
	URLs          []string `json:"urls"`
	StartTLS      bool     `json:"startTls"`
	AllowPlain    bool     `json:"allowPlain"`
	CAPEM         string   `json:"caPem"`
	BaseDN        string   `json:"baseDn"`
	BindDN        string   `json:"bindDn"`
	UserFilter    string   `json:"userFilter"`
	UserAttr      string   `json:"userAttr"`
	GroupBaseDN   string   `json:"groupBaseDn"`
	GroupFilter   string   `json:"groupFilter"`
	RequiredGroup string   `json:"requiredGroup"`
	TimeoutS      int      `json:"timeoutS"`

	HasPassword   bool   `json:"hasPassword"`
	BindPassword  string `json:"bindPassword,omitempty"` // nur Eingabe
	ClearPassword bool   `json:"clearPassword,omitempty"`
	// Source: "ui" (gespeichert) oder "env" (Umgebungsvariablen, solange nichts gespeichert ist). Nur Ausgabe.
	Source string `json:"source,omitempty"`
	// CAFile aus der Umgebung (nur Anzeige/Übernahme, nicht in der Oberfläche änderbar).
	CAFile string `json:"caFile,omitempty"`
}

func (s Settings) toConfig(password string) Config {
	urls := make([]string, 0, len(s.URLs))
	for _, u := range s.URLs {
		if u = strings.TrimSpace(u); u != "" {
			urls = append(urls, u)
		}
	}
	return Config{URLs: urls, StartTLS: s.StartTLS, AllowPlain: s.AllowPlain, CAFile: s.CAFile, CAPEM: s.CAPEM, BaseDN: strings.TrimSpace(s.BaseDN),
		BindDN: strings.TrimSpace(s.BindDN), BindPassword: password, UserFilter: strings.TrimSpace(s.UserFilter), UserAttr: strings.TrimSpace(s.UserAttr),
		GroupBaseDN: strings.TrimSpace(s.GroupBaseDN), GroupFilter: strings.TrimSpace(s.GroupFilter), RequiredGroup: strings.TrimSpace(s.RequiredGroup),
		Timeout: time.Duration(s.TimeoutS) * time.Second}
}

// Manager hält den aktuellen Client, liest/speichert die Einstellungen und tauscht den Client ohne Neustart aus.
// Er erfüllt auth.Directory (Anmeldung) und die Verwaltungsschnittstelle der HTTP-API.
type Manager struct {
	db          *sql.DB
	key         []byte
	env         Settings // Rückfall aus den Umgebungsvariablen
	envPassword string

	mu     sync.RWMutex
	client *Client
	err    error // Fehler beim letzten Laden (Fehlkonfiguration)
}

// NewManager: secretKey ist OMP_STORAGE_SECRET_KEY (leer erlaubt); env/envPassword sind die Werte aus OMP_LDAP_*.
func NewManager(db *sql.DB, secretKey string, env Settings, envPassword string) (*Manager, error) {
	m := &Manager{db: db, env: env, envPassword: envPassword}
	if secretKey != "" {
		k, err := storagebackends.DecodeMasterKey(secretKey)
		if err != nil {
			return nil, err
		}
		m.key = k
	}
	return m, nil
}

// Load liefert die wirksamen Einstellungen (gespeicherte, sonst die aus der Umgebung) und das Kennwort.
func (m *Manager) load(ctx context.Context) (Settings, string, error) {
	var s Settings
	var enc []byte
	var urls string
	err := m.db.QueryRowContext(ctx, `SELECT enabled, urls, start_tls, allow_plain, ca_pem, base_dn, bind_dn, password_enc, user_filter, user_attr,
		group_base_dn, group_filter, required_group, timeout_s FROM directory_config WHERE id = 1`).
		Scan(&s.Enabled, &urls, &s.StartTLS, &s.AllowPlain, &s.CAPEM, &s.BaseDN, &s.BindDN, &enc, &s.UserFilter, &s.UserAttr, &s.GroupBaseDN, &s.GroupFilter, &s.RequiredGroup, &s.TimeoutS)
	if errors.Is(err, sql.ErrNoRows) {
		e := m.env
		e.Source, e.HasPassword = "env", m.envPassword != ""
		return e, m.envPassword, nil
	}
	if err != nil {
		return Settings{}, "", err
	}
	for _, u := range strings.Split(urls, "\n") {
		if u = strings.TrimSpace(u); u != "" {
			s.URLs = append(s.URLs, u)
		}
	}
	s.Source, s.HasPassword, s.CAFile = "ui", len(enc) > 0, m.env.CAFile
	pw := ""
	if len(enc) > 0 {
		if m.key == nil {
			return s, "", ErrNoSecretKey
		}
		if pw, err = storagebackends.DecryptSecret(m.key, enc); err != nil {
			return s, "", err
		}
	}
	return s, pw, nil
}

// Settings liefert die Einstellungen für die Oberfläche (ohne Kennwort).
func (m *Manager) Settings(ctx context.Context) (Settings, error) {
	s, _, err := m.load(ctx)
	if s.URLs == nil {
		s.URLs = []string{}
	}
	return s, err
}

// Reload baut den Client aus den wirksamen Einstellungen neu. Ein Fehler lässt die Anmeldung per Verzeichnis aus
// (lokale Konten bleiben), er wird mit LastError angezeigt.
func (m *Manager) Reload(ctx context.Context) error {
	s, pw, err := m.load(ctx)
	var c *Client
	if err == nil && s.Enabled && len(s.URLs) > 0 {
		c, err = New(s.toConfig(pw))
	}
	m.mu.Lock()
	m.client, m.err = c, err
	m.mu.Unlock()
	return err
}

// LastError: Fehler des letzten Ladens (leer = in Ordnung).
func (m *Manager) LastError() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.err != nil {
		return m.err.Error()
	}
	return ""
}

// Enabled: ist die Verzeichnis-Anmeldung gerade wirksam?
func (m *Manager) Enabled() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.client != nil
}

func (m *Manager) current() *Client {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.client
}

// Authenticate erfüllt auth.Directory. Ohne Client: Anmeldung abgelehnt.
func (m *Manager) Authenticate(ctx context.Context, username, password string) (Identity, error) {
	c := m.current()
	if c == nil {
		return Identity{}, ErrInvalidCredentials
	}
	return c.Authenticate(ctx, username, password)
}

// Save prüft und speichert die Einstellungen und wendet sie sofort an. Leeres BindPassword behält das bisherige
// (außer ClearPassword). Eine ungültige Einstellung wird abgelehnt und nicht gespeichert.
func (m *Manager) Save(ctx context.Context, s Settings) error {
	_, oldPw, lerr := m.load(ctx)
	if lerr != nil && !errors.Is(lerr, ErrNoSecretKey) {
		return lerr
	}
	pw := oldPw
	switch {
	case s.ClearPassword:
		pw = ""
	case s.BindPassword != "":
		pw = s.BindPassword
	}
	if s.Enabled || len(s.URLs) > 0 {
		if _, err := New(s.toConfig(pw)); err != nil {
			return err
		}
	}
	var enc []byte
	if pw != "" {
		if m.key == nil {
			return ErrNoSecretKey
		}
		var err error
		if enc, err = storagebackends.EncryptSecret(m.key, pw); err != nil {
			return err
		}
	}
	if s.TimeoutS <= 0 {
		s.TimeoutS = 8
	}
	_, err := m.db.ExecContext(ctx, `INSERT INTO directory_config (id, enabled, urls, start_tls, allow_plain, ca_pem, base_dn, bind_dn, password_enc,
		user_filter, user_attr, group_base_dn, group_filter, required_group, timeout_s, updated_at)
		VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
		ON CONFLICT (id) DO UPDATE SET enabled=$1, urls=$2, start_tls=$3, allow_plain=$4, ca_pem=$5, base_dn=$6, bind_dn=$7, password_enc=$8,
		user_filter=$9, user_attr=$10, group_base_dn=$11, group_filter=$12, required_group=$13, timeout_s=$14, updated_at=now()`,
		s.Enabled, strings.Join(s.toConfig("").URLs, "\n"), s.StartTLS, s.AllowPlain, s.CAPEM, strings.TrimSpace(s.BaseDN), strings.TrimSpace(s.BindDN), enc,
		strings.TrimSpace(s.UserFilter), strings.TrimSpace(s.UserAttr), strings.TrimSpace(s.GroupBaseDN), strings.TrimSpace(s.GroupFilter),
		strings.TrimSpace(s.RequiredGroup), s.TimeoutS)
	if err != nil {
		return err
	}
	return m.Reload(ctx)
}

// Test prüft Erreichbarkeit und Dienstkonto. s != nil: die (noch nicht gespeicherten) Formularwerte, ein leeres
// Kennwort nimmt das bisherige; s == nil: der aktuelle Client.
func (m *Manager) Test(ctx context.Context, s *Settings) error {
	if s == nil {
		c := m.current()
		if c == nil {
			return errors.New("Verzeichnis-Anmeldung ist nicht eingeschaltet")
		}
		return c.Ping(ctx)
	}
	_, oldPw, _ := m.load(ctx)
	pw := oldPw
	if s.BindPassword != "" {
		pw = s.BindPassword
	}
	if s.ClearPassword {
		pw = ""
	}
	c, err := New(s.toConfig(pw))
	if err != nil {
		return err
	}
	return c.Ping(ctx)
}

// Watch lädt die Einstellungen neu, wenn ein anderer Orchestrator des Clusters sie geändert hat (Prüfung der
// Änderungszeit alle every). Endet mit ctx.
func (m *Manager) Watch(ctx context.Context, every time.Duration) {
	var last time.Time
	_ = m.db.QueryRowContext(ctx, `SELECT updated_at FROM directory_config WHERE id = 1`).Scan(&last)
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		var cur time.Time
		if err := m.db.QueryRowContext(ctx, `SELECT updated_at FROM directory_config WHERE id = 1`).Scan(&cur); err != nil || cur.Equal(last) {
			continue
		}
		last = cur
		_ = m.Reload(ctx)
	}
}
