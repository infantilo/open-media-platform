package alertsink

import (
	"bufio"
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

// fakeSMTP nimmt eine Nachricht an und liefert Umschlag + Daten.
func fakeSMTP(t *testing.T) (port string, got chan string) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	got = make(chan string, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		r := bufio.NewReader(c)
		w := func(s string) { c.Write([]byte(s + "\r\n")) }
		w("220 test ESMTP")
		var sb strings.Builder
		data := false
		for {
			l, err := r.ReadString('\n')
			if err != nil {
				return
			}
			l = strings.TrimRight(l, "\r\n")
			if data {
				if l == "." {
					data = false
					w("250 ok")
					got <- sb.String()
					continue
				}
				sb.WriteString(l + "\n")
				continue
			}
			switch cmd := strings.ToUpper(l); {
			case strings.HasPrefix(cmd, "EHLO"):
				w("250 test")
			case strings.HasPrefix(cmd, "MAIL"), strings.HasPrefix(cmd, "RCPT"):
				sb.WriteString(l + "\n")
				w("250 ok")
			case cmd == "DATA":
				data = true
				w("354 go")
			case cmd == "QUIT":
				w("221 bye")
				return
			default:
				w("250 ok")
			}
		}
	}()
	_, p, _ := net.SplitHostPort(ln.Addr().String())
	return p, got
}

func TestMailerSendsAlert(t *testing.T) {
	port, got := fakeSMTP(t)
	m, err := NewMailer("127.0.0.1", port, "", "", "omp@example.org", "a@example.org, b@example.org", "none")
	if err != nil || m == nil {
		t.Fatal(m, err)
	}
	a := Alert{Kind: "node-alert", Subject: "n1", Name: "Köln\r\nBcc: x@evil", Message: "Pipeline gerissen", Time: time.Now()}
	if err := m.Send(context.Background(), a); err != nil {
		t.Fatal(err)
	}
	msg := <-got
	for _, want := range []string{"MAIL FROM:<omp@example.org>", "RCPT TO:<a@example.org>", "RCPT TO:<b@example.org>", "Pipeline gerissen", "charset=UTF-8"} {
		if !strings.Contains(msg, want) {
			t.Errorf("fehlt %q in:\n%s", want, msg)
		}
	}
	if strings.Contains(msg, "\nBcc:") {
		t.Errorf("Header-Injection:\n%s", msg)
	}
}

func TestNewMailerValidation(t *testing.T) {
	if m, err := NewMailer("", "", "", "", "", "a@b.de", ""); m != nil || err != nil {
		t.Error("ohne Host: nil erwartet")
	}
	if _, err := NewMailer("h", "x", "", "", "", "a@b.de", ""); err == nil {
		t.Error("ungültiger Port")
	}
	if _, err := NewMailer("h", "", "", "", "", "kaputt", ""); err == nil {
		t.Error("ungültiger Empfänger")
	}
	if _, err := NewMailer("h", "", "", "", "", "a@b.de", "ssl"); err == nil {
		t.Error("unbekannte Sicherung")
	}
	m, _ := NewMailer("h", "", "", "", "", "a@b.de", "tls")
	if m.Port != 465 {
		t.Error("tls-Port " + strconv.Itoa(m.Port))
	}
}

func TestSinkMailOnly(t *testing.T) {
	port, got := fakeSMTP(t)
	m, _ := NewMailer("127.0.0.1", port, "", "", "omp@example.org", "a@example.org", "none")
	s := NewWithMail("", "", m)
	if s == nil {
		t.Fatal("Sink nil")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Run(ctx)
	s.Send(Alert{Kind: "host-offline", Subject: "h1", Message: "weg"})
	select {
	case msg := <-got:
		if !strings.Contains(msg, "weg") {
			t.Error(msg)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("keine Mail")
	}
}

func TestRoutesRecipients(t *testing.T) {
	routes := []Route{
		{Name: "Technik", Enabled: true, Kinds: []string{"media-lost", "node-silent"}, To: "technik@example.org"},
		{Name: "Leitung", Enabled: true, Severities: []string{"critical"}, To: "leitung@example.org; technik@example.org"},
		{Name: "Aus", Enabled: false, To: "nie@example.org"},
		{Name: "Stumm", Enabled: true, Severities: []string{"info"}, To: ""},
	}
	m, err := NewMailerWithRoutes("h", "", "", "", "omp@example.org", "standard@example.org", "none", routes)
	if err != nil || m == nil {
		t.Fatal(m, err)
	}
	cases := []struct {
		kind, sev string
		want      string
	}{
		{"media-lost", SevCritical, "technik@example.org,leitung@example.org"}, // Vereinigung ohne Doppelte
		{"node-alert", SevCritical, "leitung@example.org,technik@example.org"},
		{"load-high", SevWarning, "standard@example.org"}, // keine Regel passt → Standard
		{"host-online", SevInfo, ""},                      // passende Regel ohne Empfänger → nichts
	}
	for _, c := range cases {
		got := strings.Join(m.Recipients(Alert{Kind: c.kind, Severity: c.sev}), ",")
		if got != c.want {
			t.Errorf("%s/%s: %q, erwartet %q", c.kind, c.sev, got, c.want)
		}
	}
	if DefaultSeverity("load-high") != SevWarning || DefaultSeverity("host-offline") != SevCritical || DefaultSeverity("media-recovered") != SevInfo {
		t.Error("Standard-Schweregrade")
	}
	if _, err := NewMailerWithRoutes("h", "", "", "", "", "", "none", []Route{{Enabled: true, Kinds: []string{"Quatsch Art"}}}); err == nil {
		t.Error("unbekannte Art muss abgelehnt werden")
	}
	// Ohne Standard-Empfänger genügt eine aktive Regel mit Empfängern.
	if m, _ := NewMailerWithRoutes("h", "", "", "", "", "", "none", routes[:1]); m == nil {
		t.Error("nur Regel: Mailer erwartet")
	}
	if m, _ := NewMailerWithRoutes("h", "", "", "", "", "", "none", nil); m != nil {
		t.Error("ohne Empfänger: nil erwartet")
	}
}

func TestDeliverUsesRoutes(t *testing.T) {
	port, got := fakeSMTP(t)
	routes := []Route{{Name: "x", Enabled: true, Kinds: []string{"media-lost"}, To: "technik@example.org"}}
	m, _ := NewMailerWithRoutes("127.0.0.1", port, "", "", "omp@example.org", "standard@example.org", "none", routes)
	if err := m.Deliver(context.Background(), Alert{Kind: "media-lost", Subject: "n", Message: "weg", Time: time.Now(), Severity: SevCritical}); err != nil {
		t.Fatal(err)
	}
	msg := <-got
	if !strings.Contains(msg, "RCPT TO:<technik@example.org>") || strings.Contains(msg, "standard@") || !strings.Contains(msg, "CRITICAL") {
		t.Errorf("%s", msg)
	}
	// Stumme Regel: keine Verbindung nötig.
	mm, _ := NewMailerWithRoutes("127.0.0.1", "1", "", "", "omp@example.org", "standard@example.org", "none",
		[]Route{{Enabled: true, Severities: []string{"info"}}})
	if err := mm.Deliver(context.Background(), Alert{Kind: "host-online", Severity: SevInfo, Time: time.Now()}); err != nil {
		t.Errorf("unterdrückt, aber Fehler: %v", err)
	}
}

func TestRoutesByWorkflow(t *testing.T) {
	routes := []Route{
		{Name: "Studio A", Enabled: true, Workflows: []string{"wf-a"}, To: "a@example.org"},
		{Name: "Alle kritischen", Enabled: true, Severities: []string{"critical"}, To: "leitung@example.org"},
	}
	m, _ := NewMailerWithRoutes("h", "", "", "", "omp@example.org", "standard@example.org", "none", routes)
	wf := func(ids ...string) []WorkflowRef {
		var out []WorkflowRef
		for _, i := range ids {
			out = append(out, WorkflowRef{ID: i, Name: i})
		}
		return out
	}
	cases := []struct {
		a    Alert
		want string
	}{
		{Alert{Kind: "media-lost", Severity: SevCritical, Workflows: wf("wf-a")}, "a@example.org,leitung@example.org"},
		{Alert{Kind: "media-lost", Severity: SevCritical, Workflows: wf("wf-b")}, "leitung@example.org"},
		{Alert{Kind: "host-offline", Severity: SevCritical, Workflows: wf("wf-b", "wf-a")}, "a@example.org,leitung@example.org"}, // Host mit mehreren Workflows
		{Alert{Kind: "load-high", Severity: SevWarning}, "standard@example.org"},                                                 // ohne Workflow trifft keine Workflow-Regel
		{Alert{Kind: "load-high", Severity: SevWarning, Workflows: wf("wf-a")}, "a@example.org"},
	}
	for i, c := range cases {
		if got := strings.Join(m.Recipients(c.a), ","); got != c.want {
			t.Errorf("Fall %d: %q, erwartet %q", i, got, c.want)
		}
	}
	// Name im Mailtext.
	msg := string(m.Message(Alert{Kind: "media-lost", Severity: SevCritical, Time: time.Now(), Workflows: wf("wf-a")}, []string{"a@example.org"}))
	if !strings.Contains(msg, "Workflow:  wf-a") {
		t.Error(msg)
	}
	// Sink löst Workflows beim Senden auf.
	s := NewWithMail("", "", nil)
	s.Resolve = func(a Alert) []WorkflowRef { return wf("wf-x") }
	s.Send(Alert{Kind: "media-lost", Subject: "n1", Message: "x"})
	if got := (<-s.queue).Workflows; len(got) != 1 || got[0].ID != "wf-x" {
		t.Errorf("Resolve: %+v", got)
	}
}

func TestRoutesByProcess(t *testing.T) {
	routes := []Route{
		{Name: "Nachtkopie", Enabled: true, Processes: []string{"p1"}, To: "nacht@example.org"},
		{Name: "Studio A oder Nachtkopie2", Enabled: true, Workflows: []string{"wf-a"}, Processes: []string{"p2"}, To: "gemischt@example.org"},
	}
	m, _ := NewMailerWithRoutes("h", "", "", "", "omp@example.org", "standard@example.org", "none", routes)
	pr := func(id string) []ProcessRef { return []ProcessRef{{ID: id, Name: id}} }
	cases := []struct {
		a    Alert
		want string
	}{
		{Alert{Kind: "process-failed", Severity: SevCritical, Processes: pr("p1")}, "nacht@example.org"},
		{Alert{Kind: "process-failed", Severity: SevCritical, Processes: pr("p2")}, "gemischt@example.org"},
		{Alert{Kind: "media-lost", Severity: SevCritical, Workflows: []WorkflowRef{{ID: "wf-a"}}}, "gemischt@example.org"},
		{Alert{Kind: "process-failed", Severity: SevCritical, Processes: pr("p3")}, "standard@example.org"},
		{Alert{Kind: "media-lost", Severity: SevCritical}, "standard@example.org"},
	}
	for i, c := range cases {
		if got := strings.Join(m.Recipients(c.a), ","); got != c.want {
			t.Errorf("Fall %d: %q, erwartet %q", i, got, c.want)
		}
	}
	if DefaultSeverity("process-failed") != SevCritical {
		t.Error("process-failed ist kritisch")
	}
	if msg := string(m.Message(Alert{Kind: "process-failed", Severity: SevCritical, Time: time.Now(), Processes: pr("Nachtkopie")}, []string{"a@example.org"})); !strings.Contains(msg, "Prozess:   Nachtkopie") {
		t.Error(msg)
	}
}

func TestDynamicKindsAndOptInUserActions(t *testing.T) {
	// Dynamisch: eine neue Art anmelden, sie ist sofort bekannt, mit eigenem Standard-Schweregrad.
	RegisterKind(KindInfo{Kind: "x-test-kind", Severity: SevCritical, Group: "test", Label: "Test"})
	defer UnregisterKind("x-test-kind")
	if DefaultSeverity("x-test-kind") != SevCritical {
		t.Fatal("Standard-Schweregrad der neuen Art")
	}
	found := false
	for _, k := range ListKinds() {
		found = found || k.Kind == "x-test-kind"
	}
	if !found {
		t.Fatal("neue Art fehlt in ListKinds")
	}
	UnregisterKind("x-test-kind")
	if DefaultSeverity("x-test-kind") != SevWarning {
		t.Fatal("abgemeldete Art: Rückfall Warnung")
	}

	routes := []Route{
		{Name: "alle", Enabled: true, To: "alle@example.org"}, // „alle Arten“ darf Benutzeraktionen NICHT einschließen
		{Name: "Ablehnungen", Enabled: true, Kinds: []string{"user-action"}, Actions: []string{"review.rejected", "workflow.*"}, To: "leitung@example.org"},
	}
	m, _ := NewMailerWithRoutes("h", "", "", "", "omp@example.org", "standard@example.org", "none", routes)
	ua := func(action string) Alert {
		return Alert{Kind: "user-action", Severity: SevInfo, Action: action}
	}
	cases := []struct {
		a    Alert
		want string
	}{
		{ua("review.rejected"), "leitung@example.org"},
		{ua("workflow.deleted"), "leitung@example.org"},
		{ua("review.approved"), ""},                                          // keine Regel → nie Standard-Empfänger
		{Alert{Kind: "qc-failed", Severity: SevWarning}, "alle@example.org"}, // normale Arten wie gehabt
	}
	for i, c := range cases {
		if got := strings.Join(m.Recipients(c.a), ","); got != c.want {
			t.Errorf("Fall %d: %q, erwartet %q", i, got, c.want)
		}
	}
	// Opt-in-Alarme gehen nie an den Webhook.
	hits := make(chan struct{}, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits <- struct{}{} }))
	defer srv.Close()
	s := New(srv.URL, "")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.Run(ctx)
	s.Send(Alert{Kind: "user-action", Subject: "a", Message: "x", Action: "review.rejected"})
	s.Send(Alert{Kind: "qc-failed", Subject: "a", Message: "x"})
	select {
	case <-hits:
	case <-time.After(3 * time.Second):
		t.Fatal("qc-failed muss den Webhook erreichen")
	}
	select {
	case <-hits:
		t.Fatal("user-action darf den Webhook nicht erreichen")
	case <-time.After(300 * time.Millisecond):
	}
}
