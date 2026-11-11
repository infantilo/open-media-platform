package directory

import (
	"context"
	"errors"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	ber "github.com/go-asn1-ber/asn1-ber"
	"github.com/go-ldap/ldap/v3"
)

// fakeLDAP ist ein Minimal-LDAP-Server (Bind + Search) für die Tests — kein Ersatz für ein echtes AD.
type fakeLDAP struct {
	ln net.Listener
	mu sync.Mutex
	// users: sAMAccountName -> (DN, Passwort); groups: Nutzer-DN -> Gruppen
	users   map[string][2]string
	groups  map[string][][2]string // DN, CN
	filters []string
	binds   []string
}

func newFakeLDAP(t *testing.T) *fakeLDAP {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeLDAP{ln: ln, users: map[string][2]string{}, groups: map[string][][2]string{}}
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go f.serve(c)
		}
	}()
	t.Cleanup(func() { ln.Close() })
	return f
}

func (f *fakeLDAP) url() string { return "ldap://" + f.ln.Addr().String() }

func resp(id int64, tag ber.Tag, children ...*ber.Packet) *ber.Packet {
	p := ber.Encode(ber.ClassUniversal, ber.TypeConstructed, ber.TagSequence, nil, "")
	p.AppendChild(ber.NewInteger(ber.ClassUniversal, ber.TypePrimitive, ber.TagInteger, id, "id"))
	op := ber.Encode(ber.ClassApplication, ber.TypeConstructed, tag, nil, "")
	for _, c := range children {
		op.AppendChild(c)
	}
	p.AppendChild(op)
	return p
}

func result(code int64) []*ber.Packet {
	return []*ber.Packet{
		ber.NewInteger(ber.ClassUniversal, ber.TypePrimitive, ber.TagEnumerated, code, "code"),
		ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, "", "matched"),
		ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, "", "msg"),
	}
}

func entry(id int64, dn string, attrs map[string]string) *ber.Packet {
	var kids []*ber.Packet
	kids = append(kids, ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, dn, "dn"))
	al := ber.Encode(ber.ClassUniversal, ber.TypeConstructed, ber.TagSequence, nil, "attrs")
	for k, v := range attrs {
		a := ber.Encode(ber.ClassUniversal, ber.TypeConstructed, ber.TagSequence, nil, "attr")
		a.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, k, "type"))
		vs := ber.Encode(ber.ClassUniversal, ber.TypeConstructed, ber.TagSet, nil, "vals")
		vs.AppendChild(ber.NewString(ber.ClassUniversal, ber.TypePrimitive, ber.TagOctetString, v, "val"))
		a.AppendChild(vs)
		al.AppendChild(a)
	}
	kids = append(kids, al)
	return resp(id, 4, kids...)
}

func (f *fakeLDAP) serve(c net.Conn) {
	defer c.Close()
	for {
		p, err := ber.ReadPacket(c)
		if err != nil {
			return
		}
		id := p.Children[0].Value.(int64)
		op := p.Children[1]
		switch op.Tag {
		case 0: // Bind
			dn := op.Children[1].Value.(string)
			pw := string(op.Children[2].Data.Bytes())
			code := int64(49) // invalidCredentials
			f.mu.Lock()
			f.binds = append(f.binds, dn+"|"+pw)
			if dn == "CN=svc,DC=t" && pw == "svcpw" || dn == "" && pw == "" {
				code = 0
			}
			for _, u := range f.users {
				if u[0] == dn && u[1] == pw && pw != "" {
					code = 0
				}
			}
			f.mu.Unlock()
			c.Write(resp(id, 1, result(code)...).Bytes())
		case 3: // Search
			filter, _ := ldap.DecompileFilter(op.Children[6])
			f.mu.Lock()
			f.filters = append(f.filters, filter)
			f.mu.Unlock()
			send := func(e *ber.Packet) { c.Write(e.Bytes()) }
			if strings.Contains(filter, "1.2.840.113556.1.4.1941") {
				for dn, gs := range f.groups {
					if strings.Contains(filter, "="+ldap.EscapeFilter(dn)+")") {
						for _, g := range gs {
							send(entry(id, g[0], map[string]string{"cn": g[1]}))
						}
					}
				}
			} else {
				for name, u := range f.users {
					if strings.Contains(filter, "sAMAccountName="+name+")") {
						send(entry(id, u[0], map[string]string{"sAMAccountName": name, "displayName": "Anzeige " + name}))
					}
				}
			}
			c.Write(resp(id, 5, result(0)...).Bytes())
		case 2: // Unbind
			return
		}
	}
}

func newClient(t *testing.T, f *fakeLDAP, mod func(*Config)) *Client {
	t.Helper()
	cfg := Config{URLs: []string{f.url()}, AllowPlain: true, BaseDN: "DC=t", BindDN: "CN=svc,DC=t", BindPassword: "svcpw", Timeout: 3 * time.Second}
	if mod != nil {
		mod(&cfg)
	}
	c, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func seeded(t *testing.T) *fakeLDAP {
	f := newFakeLDAP(t)
	f.users["hans"] = [2]string{"CN=Hans Meier,OU=Leute,DC=t", "geheim-1234"}
	f.groups["CN=Hans Meier,OU=Leute,DC=t"] = [][2]string{
		{"CN=Regie1,OU=Gruppen,DC=t", "Regie1"},
		{"CN=Alle,OU=Gruppen,DC=t", "Alle"},
	}
	return f
}

func TestAuthenticateOK(t *testing.T) {
	f := seeded(t)
	id, err := newClient(t, f, nil).Authenticate(context.Background(), "hans", "geheim-1234")
	if err != nil {
		t.Fatal(err)
	}
	if id.Username != "hans" || id.DN != "CN=Hans Meier,OU=Leute,DC=t" || id.DisplayName != "Anzeige hans" {
		t.Fatalf("identity: %+v", id)
	}
	if !id.InGroup("Regie1") || !id.InGroup("cn=regie1, ou=Gruppen, dc=t") || id.InGroup("Nope") {
		t.Fatalf("groups: %+v", id.Groups)
	}
}

func TestAuthenticateRejects(t *testing.T) {
	f := seeded(t)
	c := newClient(t, f, nil)
	for name, tc := range map[string][2]string{
		"falsches Passwort":  {"hans", "falsch"},
		"unbekannter Nutzer": {"nobody", "x"},
		"leeres Passwort":    {"hans", ""},
		"leerer Name":        {"", "geheim-1234"},
	} {
		if _, err := c.Authenticate(context.Background(), tc[0], tc[1]); !errors.Is(err, ErrInvalidCredentials) {
			t.Errorf("%s: err=%v", name, err)
		}
	}
	// Leeres Passwort darf den Server gar nicht erreichen (anonymer Bind "gelingt" sonst).
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, b := range f.binds {
		if b == "CN=Hans Meier,OU=Leute,DC=t|" {
			t.Fatal("Bind mit leerem Passwort gesendet")
		}
	}
}

func TestFilterInjectionEscaped(t *testing.T) {
	f := seeded(t)
	c := newClient(t, f, nil)
	if _, err := c.Authenticate(context.Background(), "*)(sAMAccountName=hans", "x"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("err=%v", err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	last := f.filters[len(f.filters)-1]
	if strings.Contains(last, "=*)(") || !strings.Contains(last, `\2a\29\28`) {
		t.Fatalf("Filter nicht maskiert: %s", last)
	}
}

func TestRequiredGroup(t *testing.T) {
	f := seeded(t)
	if _, err := newClient(t, f, func(c *Config) { c.RequiredGroup = "Regie1" }).Authenticate(context.Background(), "hans", "geheim-1234"); err != nil {
		t.Fatal(err)
	}
	if _, err := newClient(t, f, func(c *Config) { c.RequiredGroup = "Chefs" }).Authenticate(context.Background(), "hans", "geheim-1234"); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("err=%v", err)
	}
}

func TestFailoverAndUnreachable(t *testing.T) {
	f := seeded(t)
	dead, _ := net.Listen("tcp", "127.0.0.1:0")
	deadURL := "ldap://" + dead.Addr().String()
	dead.Close()
	c := newClient(t, f, func(c *Config) { c.URLs = []string{deadURL, f.url()} })
	if _, err := c.Authenticate(context.Background(), "hans", "geheim-1234"); err != nil {
		t.Fatalf("Ausfall auf zweiten DC: %v", err)
	}
	c = newClient(t, f, func(c *Config) { c.URLs = []string{deadURL} })
	_, err := c.Authenticate(context.Background(), "hans", "geheim-1234")
	if err == nil || errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("erreichbarkeit: %v", err)
	}
	if err := newClient(t, f, nil).Ping(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestConfigValidation(t *testing.T) {
	base := Config{URLs: []string{"ldaps://dc:636"}, BaseDN: "DC=t"}
	if _, err := New(base); err != nil {
		t.Fatal(err)
	}
	bad := map[string]func(*Config){
		"ohne URL":         func(c *Config) { c.URLs = nil },
		"ohne BaseDN":      func(c *Config) { c.BaseDN = "" },
		"Klartext":         func(c *Config) { c.URLs = []string{"ldap://dc"} },
		"Schema":           func(c *Config) { c.URLs = []string{"http://dc"} },
		"Filter ohne user": func(c *Config) { c.UserFilter = "(cn=x)" },
		"Gruppenfilter":    func(c *Config) { c.GroupFilter = "(cn=x)" },
		"CA fehlt":         func(c *Config) { c.CAFile = "/nonexistent.pem" },
	}
	for name, mod := range bad {
		c := base
		mod(&c)
		if _, err := New(c); err == nil {
			t.Errorf("%s: kein Fehler", name)
		}
	}
	c := base
	c.URLs = []string{"ldap://dc"}
	c.StartTLS = true
	if _, err := New(c); err != nil {
		t.Errorf("StartTLS: %v", err)
	}
}
