package alertsink

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"html"
	"mime"
	"net"
	"net/mail"
	"net/smtp"
	"strconv"
	"strings"
	"time"
)

// Mailer verschickt Alarme per SMTP (RFC 5321, Nachrichtenformat RFC 5322, Kopfzeilen-Kodierung RFC 2047).
// Sicherung: "starttls" (Standard, Port 587, RFC 3207), "tls" (implizites TLS, Port 465, RFC 8314) oder "none" (nur für vertrauenswürdige Relays im LAN).
type Mailer struct {
	Host     string
	Port     int
	User     string
	Password string
	From     string
	To       []string // Standard-Empfänger (wenn keine Regel passt)
	Routes   []Route  // Empfängerregeln nach Art und Schweregrad
	Security string   // starttls | tls | none
	Timeout  time.Duration
	// ServerName überschreibt den TLS-Namen (Standard: Host).
	ServerName string
	// InsecureSkipVerify nur für Tests/interne Zertifizierungsstellen ohne Import.
	InsecureSkipVerify bool
}

// NewMailer legt einen Mailer an; host oder Empfänger leer = nil.
func NewMailer(host, port, user, password, from, to, security string) (*Mailer, error) {
	return NewMailerWithRoutes(host, port, user, password, from, to, security, nil)
}

// NewMailerWithRoutes wie NewMailer, mit Empfängerregeln. Ohne Standard-Empfänger genügt
// mindestens eine aktive Regel mit Empfängern; ohne beides (oder ohne Server) = nil.
func NewMailerWithRoutes(host, port, user, password, from, to, security string, routes []Route) (*Mailer, error) {
	host = strings.TrimSpace(host)
	rcpt := splitAddrs(to)
	for _, r := range routes {
		if err := r.Validate(); err != nil {
			return nil, err
		}
	}
	routed := false
	for _, r := range routes {
		if r.Enabled && len(splitAddrs(r.To)) > 0 {
			routed = true
		}
	}
	if host == "" || (len(rcpt) == 0 && !routed) {
		return nil, nil
	}
	sec := strings.ToLower(strings.TrimSpace(security))
	if sec == "" {
		sec = "starttls"
	}
	if sec != "starttls" && sec != "tls" && sec != "none" {
		return nil, fmt.Errorf("OMP_ALERT_SMTP_SECURITY %q unbekannt (starttls|tls|none)", security)
	}
	p := 587
	if sec == "tls" {
		p = 465
	}
	if strings.TrimSpace(port) != "" {
		n, err := strconv.Atoi(strings.TrimSpace(port))
		if err != nil || n < 1 || n > 65535 {
			return nil, fmt.Errorf("OMP_ALERT_SMTP_PORT %q ungültig", port)
		}
		p = n
	}
	if from = strings.TrimSpace(from); from == "" {
		from = "openmediaplatform@" + hostnameOr("localhost")
	}
	if _, err := mail.ParseAddress(from); err != nil {
		return nil, fmt.Errorf("OMP_ALERT_SMTP_FROM: %w", err)
	}
	for _, r := range rcpt {
		if _, err := mail.ParseAddress(r); err != nil {
			return nil, fmt.Errorf("OMP_ALERT_SMTP_TO %q: %w", r, err)
		}
	}
	return &Mailer{Host: host, Port: p, User: user, Password: password, From: from, To: rcpt, Security: sec, Routes: routes, Timeout: 15 * time.Second}, nil
}

func hostnameOr(def string) string {
	if h, err := net.LookupAddr("127.0.0.1"); err == nil && len(h) > 0 {
		return strings.TrimSuffix(h[0], ".")
	}
	return def
}

// Message baut die RFC-5322-Nachricht (UTF-8, Quoted-Printable-frei: 8bit; Betreff RFC 2047).
func (m *Mailer) Message(a Alert, to []string) []byte {
	subj := sanitizeHeader(fmt.Sprintf("[OpenMediaPlatform] %s %s: %s", strings.ToUpper(a.Severity), a.Kind, firstNonEmpty(a.Name, a.Subject)))
	var b strings.Builder
	b.WriteString("From: " + m.From + "\r\n")
	b.WriteString("To: " + strings.Join(to, ", ") + "\r\n")
	b.WriteString("Subject: " + mimeEncode(subj) + "\r\n")
	b.WriteString("Date: " + a.Time.Format(time.RFC1123Z) + "\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	headEnd := b.Len()
	wf := ""
	if len(a.Workflows) > 0 {
		names := make([]string, 0, len(a.Workflows))
		for _, w := range a.Workflows {
			names = append(names, sanitizeHeader(w.Name))
		}
		wf = "Workflow:  " + strings.Join(names, ", ") + "\r\n"
	}
	if a.Action != "" {
		wf += "Aktion:    " + sanitizeHeader(a.Action) + "\r\n"
	}
	if len(a.Processes) > 0 {
		names := make([]string, 0, len(a.Processes))
		for _, p := range a.Processes {
			names = append(names, sanitizeHeader(p.Name))
		}
		wf += "Prozess:   " + strings.Join(names, ", ") + "\r\n"
	}
	body := wf + fmt.Sprintf("Schwere:  %s\r\nArt:      %s\r\nGegenstand: %s\r\nName:     %s\r\nZeit:     %s\r\n\r\n%s\r\n",
		sanitizeHeader(a.Severity), sanitizeHeader(a.Kind), sanitizeHeader(a.Subject), sanitizeHeader(a.Name), a.Time.Format(time.RFC3339), strings.ReplaceAll(strings.ReplaceAll(a.Message, "\r\n", "\n"), "\n", "\r\n"))
	crlf := func(t string) string { return strings.ReplaceAll(strings.ReplaceAll(t, "\r\n", "\n"), "\n", "\r\n") }
	if a.Status != nil && a.StatusMode != StatusNone {
		body += "\r\n" + crlf(a.Status.Text())
	}
	head := b.String()[:headEnd]
	var png []byte
	if a.Status != nil && a.StatusMode == StatusGraph {
		png, _ = a.Status.Flow.PNG("Signalweg bis zur Wurzel: " + firstNonEmpty(a.Name, a.Subject))
	}
	if a.Status != nil && a.StatusMode == StatusSVG {
		if svg := a.Status.Flow.SVG("Signalweg bis zur Wurzel: " + firstNonEmpty(a.Name, a.Subject)); svg != nil {
			const mixed = "omp-mix-7d1f"
			var o strings.Builder
			o.WriteString(head + "Content-Type: multipart/mixed; boundary=\"" + mixed + "\"\r\nAuto-Submitted: auto-generated\r\n\r\n")
			o.WriteString("--" + mixed + "\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n" + body + "\r\n")
			o.WriteString("--" + mixed + "\r\nContent-Type: image/svg+xml; name=\"signalweg.svg\"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename=\"signalweg.svg\"\r\n\r\n")
			enc := base64.StdEncoding.EncodeToString(svg)
			for len(enc) > 76 {
				o.WriteString(enc[:76] + "\r\n")
				enc = enc[76:]
			}
			o.WriteString(enc + "\r\n--" + mixed + "--\r\n")
			return []byte(o.String())
		}
	}
	if png == nil {
		return []byte(head + "Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\nAuto-Submitted: auto-generated\r\n\r\n" + body)
	}
	// multipart/alternative: Text | multipart/related: HTML + eingebettetes PNG (cid)
	const outer, inner = "omp-alt-7d1f", "omp-rel-7d1f"
	var o strings.Builder
	o.WriteString(head + "Content-Type: multipart/alternative; boundary=\"" + outer + "\"\r\nAuto-Submitted: auto-generated\r\n\r\n")
	o.WriteString("--" + outer + "\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n" + body + "\r\n")
	o.WriteString("--" + outer + "\r\nContent-Type: multipart/related; boundary=\"" + inner + "\"\r\n\r\n")
	o.WriteString("--" + inner + "\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n")
	o.WriteString("<html><body><pre style=\"font-family:monospace\">" + crlf(html.EscapeString(body)) + "</pre>")
	o.WriteString("<p><img src=\"cid:signalweg@omp\" alt=\"Signalweg\"></p></body></html>\r\n")
	o.WriteString("--" + inner + "\r\nContent-Type: image/png; name=\"signalweg.png\"\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <signalweg@omp>\r\nContent-Disposition: inline; filename=\"signalweg.png\"\r\n\r\n")
	enc := base64.StdEncoding.EncodeToString(png)
	for len(enc) > 76 {
		o.WriteString(enc[:76] + "\r\n")
		enc = enc[76:]
	}
	o.WriteString(enc + "\r\n--" + inner + "--\r\n--" + outer + "--\r\n")
	return []byte(o.String())
}

// sanitizeHeader entfernt Zeilenumbrüche (Header-Injection).
func sanitizeHeader(s string) string {
	return strings.Map(func(r rune) rune {
		if r == '\r' || r == '\n' {
			return ' '
		}
		return r
	}, s)
}

func mimeEncode(s string) string {
	for _, r := range s {
		if r > 126 || r < 32 {
			return mimeQ(s)
		}
	}
	return s
}

func mimeQ(s string) string { return mime.BEncoding.Encode("UTF-8", s) }

// Deliver schickt den Alarm an die nach den Regeln bestimmten Empfänger (keine Empfänger = nichts senden).
func (m *Mailer) Deliver(ctx context.Context, a Alert) error {
	to := m.Recipients(a)
	if len(to) == 0 {
		return nil
	}
	return m.SendTo(ctx, a, to)
}

// Send liefert eine Nachricht an alle Standard-Empfänger (ohne Regeln).
func (m *Mailer) Send(ctx context.Context, a Alert) error { return m.SendTo(ctx, a, m.To) }

// SendTo liefert eine Nachricht an die genannten Empfänger.
func (m *Mailer) SendTo(ctx context.Context, a Alert, to []string) error {
	addr := net.JoinHostPort(m.Host, strconv.Itoa(m.Port))
	d := net.Dialer{Timeout: m.Timeout}
	cfg := &tls.Config{ServerName: firstNonEmpty(m.ServerName, m.Host), MinVersion: tls.VersionTLS12, InsecureSkipVerify: m.InsecureSkipVerify}
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return err
	}
	_ = conn.SetDeadline(time.Now().Add(m.Timeout * 2))
	if m.Security == "tls" {
		conn = tls.Client(conn, cfg)
	}
	c, err := smtp.NewClient(conn, m.Host)
	if err != nil {
		conn.Close()
		return err
	}
	defer c.Close()
	if m.Security == "starttls" {
		if ok, _ := c.Extension("STARTTLS"); !ok {
			return fmt.Errorf("Server bietet kein STARTTLS (OMP_ALERT_SMTP_SECURITY=none setzen, falls gewollt)")
		}
		if err := c.StartTLS(cfg); err != nil {
			return err
		}
	}
	if m.User != "" {
		// PLAIN nur über verschlüsselte Verbindung (net/smtp lehnt es sonst selbst ab, außer localhost).
		if err := c.Auth(smtp.PlainAuth("", m.User, m.Password, m.Host)); err != nil {
			return err
		}
	}
	from, _ := mail.ParseAddress(m.From)
	if err := c.Mail(from.Address); err != nil {
		return err
	}
	for _, r := range to {
		p, _ := mail.ParseAddress(r)
		if err := c.Rcpt(p.Address); err != nil {
			return err
		}
	}
	w, err := c.Data()
	if err != nil {
		return err
	}
	if _, err := w.Write(m.Message(a, to)); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	return c.Quit()
}
