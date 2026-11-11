// Package directory bindet ein Windows-Active-Directory (oder einen anderen LDAP-Server) für die
// Anmeldung an (Nutzerauftrag 2026-11-11, ARCHITECTURE.md §12 Punkt 1).
//
// Ablauf einer Anmeldung: (1) optional mit einem Dienstkonto binden, (2) den Nutzer per Filter suchen
// (genau ein Treffer), (3) mit dessen DN und dem eingegebenen Passwort binden — das Verzeichnis prüft
// das Passwort, OMP speichert keines —, (4) die Gruppen des Nutzers lesen (bei AD standardmäßig
// verschachtelt über LDAP_MATCHING_RULE_IN_CHAIN, OID 1.2.840.113556.1.4.1941, MS-ADTS §3.1.1.3.4.4).
// Die Gruppen werden von MapStore auf OMP-Gruppen abgebildet.
//
// Sicherheitsregeln: ein leeres Passwort wird nie gebunden (ein LDAP-Bind mit leerem Passwort ist ein
// anonymer Bind und "gelingt", RFC 4513 §5.1.2); Klartext-ldap:// ohne StartTLS wird nur mit
// ausdrücklicher Freigabe zugelassen; Nutzername und DN werden vor dem Einsetzen in Filter maskiert
// (RFC 4515 §3).
//
// NICHT gegen ein echtes AD getestet (kein Verzeichnis in der Entwicklungsumgebung). Getestet ist die
// Logik gegen einen eigenen Minimal-LDAP-Server im Test; Filter-Vorgaben und AD-Besonderheiten sind
// gegen die Microsoft-Dokumentation geprüft, nicht gegen eine Installation.
package directory

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/go-ldap/ldap/v3"
)

// ErrInvalidCredentials: Nutzer unbekannt, Passwort falsch, Konto gesperrt/deaktiviert oder die
// Pflichtgruppe fehlt — nach außen bewusst nicht unterscheidbar.
var ErrInvalidCredentials = errors.New("directory: invalid credentials")

// Config beschreibt die Anbindung. Alle Felder kommen aus OMP_LDAP_* (config.Config).
type Config struct {
	// URLs: ein oder mehrere Domänencontroller, "ldaps://dc1.example.org:636". Reihenfolge = Ausfallreihenfolge.
	URLs []string
	// StartTLS: bei ldap://-URLs vor dem Bind auf TLS umschalten (RFC 4513 §3).
	StartTLS bool
	// AllowPlain: ldap:// ohne StartTLS erlauben (Passwörter laufen unverschlüsselt!). Nur für Tests im Labor.
	AllowPlain bool
	// CAFile: PEM mit der Zertifizierungsstelle des Verzeichnisses (leer = Systemzertifikate).
	CAFile string
	// BaseDN: Suchbasis für Nutzer, z. B. "DC=example,DC=org".
	BaseDN string
	// BindDN/BindPassword: Dienstkonto für die Suche (leer = anonym; AD erlaubt das meist nicht).
	BindDN       string
	BindPassword string
	// UserFilter: Suchfilter, {user} wird durch den maskierten Anmeldenamen ersetzt.
	UserFilter string
	// UserAttr: Attribut mit dem kanonischen OMP-Benutzernamen (AD: sAMAccountName).
	UserAttr string
	// GroupBaseDN: Suchbasis für Gruppen (leer = BaseDN).
	GroupBaseDN string
	// GroupFilter: {dn} wird durch den maskierten DN des Nutzers ersetzt.
	GroupFilter string
	// RequiredGroup: nur Mitglieder dieser Gruppe (DN oder CN) dürfen sich anmelden (leer = alle im Verzeichnis).
	RequiredGroup string
	// Timeout für Verbindungsaufbau und jede Anfrage.
	Timeout time.Duration
}

// Defaults für Active Directory.
const (
	DefaultUserFilter  = "(&(objectCategory=person)(objectClass=user)(|(sAMAccountName={user})(userPrincipalName={user})))"
	DefaultUserAttr    = "sAMAccountName"
	DefaultGroupFilter = "(&(objectClass=group)(member:1.2.840.113556.1.4.1941:={dn}))"
)

// Identity ist das Ergebnis einer erfolgreichen Anmeldung.
type Identity struct {
	Username    string  // kanonischer Name (UserAttr)
	DN          string  // Distinguished Name des Nutzers
	DisplayName string  // displayName, falls vorhanden
	Groups      []Group // Gruppen des Nutzers
}

// Group ist eine Verzeichnisgruppe.
type Group struct{ DN, CN string }

// Client führt Anmeldungen gegen das Verzeichnis aus.
type Client struct {
	cfg  Config
	tlsC *tls.Config
}

// New prüft die Konfiguration und lädt die CA.
func New(cfg Config) (*Client, error) {
	if len(cfg.URLs) == 0 {
		return nil, errors.New("directory: keine LDAP-URL")
	}
	if cfg.BaseDN == "" {
		return nil, errors.New("directory: BaseDN fehlt")
	}
	if cfg.UserFilter == "" {
		cfg.UserFilter = DefaultUserFilter
	}
	if !strings.Contains(cfg.UserFilter, "{user}") {
		return nil, errors.New("directory: UserFilter braucht den Platzhalter {user}")
	}
	if cfg.UserAttr == "" {
		cfg.UserAttr = DefaultUserAttr
	}
	if cfg.GroupFilter == "" {
		cfg.GroupFilter = DefaultGroupFilter
	}
	if !strings.Contains(cfg.GroupFilter, "{dn}") {
		return nil, errors.New("directory: GroupFilter braucht den Platzhalter {dn}")
	}
	if cfg.GroupBaseDN == "" {
		cfg.GroupBaseDN = cfg.BaseDN
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 8 * time.Second
	}
	for _, raw := range cfg.URLs {
		u, err := url.Parse(raw)
		if err != nil || (u.Scheme != "ldap" && u.Scheme != "ldaps") || u.Host == "" {
			return nil, fmt.Errorf("directory: ungültige LDAP-URL %q", raw)
		}
		if u.Scheme == "ldap" && !cfg.StartTLS && !cfg.AllowPlain {
			return nil, fmt.Errorf("directory: %q ohne TLS — ldaps:// verwenden, StartTLS einschalten oder (nur Labor) Klartext ausdrücklich erlauben", raw)
		}
	}
	c := &Client{cfg: cfg, tlsC: &tls.Config{MinVersion: tls.VersionTLS12}}
	if cfg.CAFile != "" {
		pem, err := os.ReadFile(cfg.CAFile)
		if err != nil {
			return nil, fmt.Errorf("directory: CA-Datei: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("directory: CA-Datei enthält kein Zertifikat")
		}
		c.tlsC.RootCAs = pool
	}
	return c, nil
}

// connect verbindet zum ersten erreichbaren Domänencontroller.
func (c *Client) connect(ctx context.Context) (*ldap.Conn, error) {
	var last error
	for _, raw := range c.cfg.URLs {
		u, _ := url.Parse(raw)
		tc := c.tlsC.Clone()
		tc.ServerName = u.Hostname()
		d := &net.Dialer{Timeout: c.cfg.Timeout}
		opts := []ldap.DialOpt{ldap.DialWithDialer(d)}
		if u.Scheme == "ldaps" {
			opts = append(opts, ldap.DialWithTLSConfig(tc))
		}
		conn, err := ldap.DialURL(raw, opts...)
		if err != nil {
			last = err
			continue
		}
		conn.SetTimeout(c.cfg.Timeout)
		if u.Scheme == "ldap" && c.cfg.StartTLS {
			if err := conn.StartTLS(tc); err != nil {
				conn.Close()
				last = err
				continue
			}
		}
		return conn, nil
	}
	return nil, fmt.Errorf("directory: kein Domänencontroller erreichbar: %w", last)
}

func expand(tmpl, key, value string) string {
	return strings.ReplaceAll(tmpl, key, ldap.EscapeFilter(value))
}

// Authenticate prüft Nutzername und Passwort. Fehler ≠ ErrInvalidCredentials bedeuten: Verzeichnis
// nicht erreichbar oder falsch konfiguriert (Aufrufer meldet nach außen trotzdem nur "ungültig").
func (c *Client) Authenticate(ctx context.Context, username, password string) (Identity, error) {
	username = strings.TrimSpace(username)
	if username == "" || password == "" {
		return Identity{}, ErrInvalidCredentials
	}
	conn, err := c.connect(ctx)
	if err != nil {
		return Identity{}, err
	}
	defer conn.Close()

	// (1) Dienstkonto
	if c.cfg.BindDN != "" {
		if err := conn.Bind(c.cfg.BindDN, c.cfg.BindPassword); err != nil {
			return Identity{}, fmt.Errorf("directory: Dienstkonto-Bind: %w", err)
		}
	} else if err := conn.UnauthenticatedBind(""); err != nil {
		return Identity{}, fmt.Errorf("directory: anonymer Bind: %w", err)
	}

	// (2) Nutzer suchen
	attrs := []string{"dn", c.cfg.UserAttr, "displayName"}
	res, err := conn.Search(ldap.NewSearchRequest(c.cfg.BaseDN, ldap.ScopeWholeSubtree, ldap.NeverDerefAliases,
		2, int(c.cfg.Timeout.Seconds()), false, expand(c.cfg.UserFilter, "{user}", username), attrs, nil))
	if err != nil {
		return Identity{}, fmt.Errorf("directory: Nutzersuche: %w", err)
	}
	if len(res.Entries) != 1 {
		// 0 = unbekannt, >1 = mehrdeutig (z. B. UPN und sAMAccountName zweier Konten): beides ablehnen.
		return Identity{}, ErrInvalidCredentials
	}
	e := res.Entries[0]

	// (3) Passwort per Bind des Nutzers prüfen
	if err := conn.Bind(e.DN, password); err != nil {
		if ldap.IsErrorWithCode(err, ldap.LDAPResultInvalidCredentials) {
			return Identity{}, ErrInvalidCredentials
		}
		return Identity{}, fmt.Errorf("directory: Nutzer-Bind: %w", err)
	}
	// Zurück aufs Dienstkonto, damit das Gruppenlesen nicht von den Rechten des Nutzers abhängt.
	if c.cfg.BindDN != "" {
		if err := conn.Bind(c.cfg.BindDN, c.cfg.BindPassword); err != nil {
			return Identity{}, fmt.Errorf("directory: Dienstkonto-Bind: %w", err)
		}
	}

	id := Identity{Username: e.GetAttributeValue(c.cfg.UserAttr), DN: e.DN, DisplayName: e.GetAttributeValue("displayName")}
	if id.Username == "" {
		id.Username = username
	}

	// (4) Gruppen
	gres, err := conn.SearchWithPaging(ldap.NewSearchRequest(c.cfg.GroupBaseDN, ldap.ScopeWholeSubtree, ldap.NeverDerefAliases,
		0, int(c.cfg.Timeout.Seconds()), false, expand(c.cfg.GroupFilter, "{dn}", e.DN), []string{"cn"}, nil), 500)
	if err != nil {
		return Identity{}, fmt.Errorf("directory: Gruppensuche: %w", err)
	}
	for _, g := range gres.Entries {
		id.Groups = append(id.Groups, Group{DN: g.DN, CN: g.GetAttributeValue("cn")})
	}
	if c.cfg.RequiredGroup != "" && !id.InGroup(c.cfg.RequiredGroup) {
		return Identity{}, ErrInvalidCredentials
	}
	return id, nil
}

// InGroup: ist der Nutzer Mitglied der Gruppe (DN oder CN, ohne Groß-/Kleinschreibung)?
func (id Identity) InGroup(name string) bool {
	for _, g := range id.Groups {
		if g.matches(name) {
			return true
		}
	}
	return false
}

func (g Group) matches(name string) bool {
	return strings.EqualFold(normDN(name), normDN(g.DN)) || strings.EqualFold(strings.TrimSpace(name), g.CN)
}

// normDN entfernt Leerraum um Kommas/Gleichheitszeichen, damit "CN=a, OU=b" und "CN=a,OU=b" gleich sind.
func normDN(s string) string {
	parts := strings.Split(s, ",")
	for i, p := range parts {
		kv := strings.SplitN(p, "=", 2)
		for j := range kv {
			kv[j] = strings.TrimSpace(kv[j])
		}
		parts[i] = strings.Join(kv, "=")
	}
	return strings.Join(parts, ",")
}

// Ping prüft Erreichbarkeit und Dienstkonto (Administration: "Verbindung testen").
func (c *Client) Ping(ctx context.Context) error {
	conn, err := c.connect(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if c.cfg.BindDN == "" {
		return conn.UnauthenticatedBind("")
	}
	return conn.Bind(c.cfg.BindDN, c.cfg.BindPassword)
}
