package alertsink

import (
	"encoding/base64"
	"strings"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
)

func TestMailStoreRoundtrip(t *testing.T) {
	db := dbtest.Open(t)
	_, _ = db.Exec(`DELETE FROM alert_mail_config`)
	key := base64.StdEncoding.EncodeToString([]byte(strings.Repeat("k", 32)))
	s, err := NewMailStore(db, key, nil)
	if err != nil {
		t.Fatal(err)
	}
	if s.Source() != "none" || s.Current() != nil {
		t.Fatal("leer erwartet")
	}
	c := MailConfig{Enabled: true, Host: "mail.example.org", Security: "starttls", User: "u", Password: "geheim", From: "omp@example.org", To: "a@example.org"}
	if err := s.Save(c, "admin"); err != nil {
		t.Fatal(err)
	}
	got, ok, _ := s.Get()
	if !ok || !got.HasPassword || got.Password != "" || got.Host != "mail.example.org" {
		t.Fatalf("%+v", got)
	}
	if pw, _ := s.password(); pw != "geheim" {
		t.Fatalf("Kennwort %q", pw)
	}
	var raw []byte
	_ = db.QueryRow(`SELECT password_enc FROM alert_mail_config`).Scan(&raw)
	if strings.Contains(string(raw), "geheim") {
		t.Fatal("Kennwort im Klartext")
	}
	// Leeres Kennwort beim Speichern behält das vorhandene.
	c.Password, c.Host = "", "mail2.example.org"
	if err := s.Save(c, "admin"); err != nil {
		t.Fatal(err)
	}
	if pw, _ := s.password(); pw != "geheim" {
		t.Fatalf("Kennwort verloren: %q", pw)
	}
	if m := s.Current(); m == nil || m.Host != "mail2.example.org" || m.Password != "geheim" {
		t.Fatalf("Mailer %+v", m)
	}
	// Regeln überleben Speichern/Lesen und landen im Mailer.
	c.Routes = []Route{{Name: "Technik", Enabled: true, Kinds: []string{"media-lost"}, Severities: []string{"critical"}, To: "t@example.org"}}
	if err := s.Save(c, "admin"); err != nil {
		t.Fatal(err)
	}
	if got, _, _ := s.Get(); len(got.Routes) != 1 || got.Routes[0].To != "t@example.org" || got.Routes[0].Kinds[0] != "media-lost" {
		t.Fatalf("Regeln: %+v", got.Routes)
	}
	if m := s.Current(); m == nil || len(m.Routes) != 1 {
		t.Fatalf("Mailer ohne Regeln: %+v", m)
	}
	c.Routes = []Route{{Enabled: true, Kinds: []string{"Quatsch Art"}, To: "t@example.org"}}
	if err := s.Save(c, "admin"); err == nil {
		t.Fatal("ungültige Regel muss abgelehnt werden")
	}
	c.Routes = nil
	_ = s.Save(c, "admin")
	// Ohne Benutzer fällt das Kennwort weg.
	c.User = ""
	_ = s.Save(c, "admin")
	if got, _, _ := s.Get(); got.HasPassword {
		t.Fatal("Kennwort ohne Benutzer behalten")
	}
	// Ausgeschaltet → kein Mailer, trotz env.
	c.Enabled = false
	_ = s.Save(c, "admin")
	if s.Current() != nil {
		t.Fatal("ausgeschaltet erwartet")
	}
	_ = s.Delete()
	if s.Source() != "none" {
		t.Fatal("Quelle")
	}
	// Ohne Schlüssel kein Kennwort.
	s2, _ := NewMailStore(db, "", nil)
	c.Enabled, c.User, c.Password = true, "u", "x"
	if err := s2.Save(c, "a"); err != ErrNoSecretKey {
		t.Fatalf("%v", err)
	}
}

func TestMailStoreWorkflowRoutes(t *testing.T) {
	db := dbtest.Open(t)
	_, _ = db.Exec(`DELETE FROM alert_mail_config`)
	s, _ := NewMailStore(db, "", nil)
	if err := s.AddWorkflowRules("w1", []Route{{Enabled: true, To: "a@example.org"}}); err != ErrNoMailConfig {
		t.Fatalf("ohne Konfiguration: %v", err)
	}
	if err := s.RemoveWorkflow("w1"); err != nil {
		t.Fatalf("Aufräumen ohne Konfiguration darf nicht scheitern: %v", err)
	}
	c := MailConfig{Enabled: true, Host: "h", From: "omp@example.org", To: "std@example.org", Security: "none", Routes: []Route{
		{Name: "nur w1", Enabled: true, Workflows: []string{"w1"}, To: "a@example.org"},
		{Name: "w1+w2", Enabled: true, Workflows: []string{"w1", "w2"}, To: "b@example.org"},
		{Name: "global", Enabled: true, To: "c@example.org"},
	}}
	if err := s.Save(c, "t"); err != nil {
		t.Fatal(err)
	}
	rules, _ := s.WorkflowRules("w1")
	if len(rules) != 2 || len(rules[0].Workflows) != 0 {
		t.Fatalf("WorkflowRules: %+v", rules)
	}
	if err := s.AddWorkflowRules("w3", rules); err != nil {
		t.Fatal(err)
	}
	if r3, _ := s.WorkflowRules("w3"); len(r3) != 2 {
		t.Fatalf("Import: %+v", r3)
	}
	if err := s.RemoveWorkflow("w1"); err != nil {
		t.Fatal(err)
	}
	got, _, _ := s.Get()
	names := ""
	for _, r := range got.Routes {
		names += r.Name + ":" + strings.Join(r.Workflows, "+") + ";"
	}
	if names != "w1+w2:w2;global:;nur w1:w3;w1+w2:w3;" {
		t.Fatalf("nach Löschen von w1: %s", names)
	}
}

func TestMailStoreRemoveProcess(t *testing.T) {
	db := dbtest.Open(t)
	_, _ = db.Exec(`DELETE FROM alert_mail_config`)
	s, _ := NewMailStore(db, "", nil)
	c := MailConfig{Enabled: true, Host: "h", From: "omp@example.org", To: "std@example.org", Security: "none", Routes: []Route{
		{Name: "nur p1", Enabled: true, Processes: []string{"p1"}, To: "a@example.org"},
		{Name: "p1+w1", Enabled: true, Processes: []string{"p1"}, Workflows: []string{"w1"}, To: "b@example.org"},
		{Name: "global", Enabled: true, To: "c@example.org"},
	}}
	if err := s.Save(c, "t"); err != nil {
		t.Fatal(err)
	}
	if err := s.RemoveProcess("p1"); err != nil {
		t.Fatal(err)
	}
	got, _, _ := s.Get()
	names := ""
	for _, r := range got.Routes {
		names += r.Name + ":" + strings.Join(r.Workflows, "+") + "/" + strings.Join(r.Processes, "+") + ";"
	}
	if names != "p1+w1:w1/;global:/;" {
		t.Fatalf("nach Löschen von p1: %s", names)
	}
}
