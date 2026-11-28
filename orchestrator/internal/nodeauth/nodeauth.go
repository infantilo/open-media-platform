// Package nodeauth sichert die HTTP-API der Nodes (Audit 2026-10-23 B1: sie nahm von jedem erreichbaren Absender
// Parameteränderungen, Methodenaufrufe und IS-05-Verbindungen ohne Anmeldung an).
//
// Es gibt ein Node-API-Token je Plattform. Es wird aus dem gemeinsamen JWT-Geheimnis abgeleitet (HMAC), ist also auf allen
// Orchestrator-Instanzen eines Clusters gleich und übersteht Neustarts, ohne eigenen Speicher. Der Orchestrator gibt es als
// OMP_NODE_API_TOKEN an jeden Node, den er startet; ein Node mit dieser Variable verlangt es in jeder Anfrage
// (Header X-OMP-Node-Token) und antwortet sonst mit 401. Orchestrator und Nodes senden es an ihre Gegenstellen.
//
// Standard: ein Token für alle Nodes — wer einen Node übernimmt, kann damit die anderen ansprechen. Mit
// OMP_NODE_TOKEN_SCOPE=host bekommt jeder Host ein eigenes Token (nur der Orchestrator kennt alle); Nodes rufen
// einander dann mit dem Peer-Token auf, das nur die freigegebenen Aufrufe öffnet (docs/decisions.md 2026-11-28).
package nodeauth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
)

// Env ist die Umgebungsvariable, mit der ein Node das Token erhält (und die Nodes zum Prüfen veranlasst).
const Env = "OMP_NODE_API_TOKEN"

// Header trägt das Token in Anfragen an Nodes.
const Header = "X-OMP-Node-Token"

// Derive leitet das Plattform-Token aus dem gemeinsamen Geheimnis ab. Leeres Geheimnis ergibt kein Token.
func Derive(secret []byte) string { return derive(secret, "omp-node-api-v1") }

// PeerEnv: Peer-Token für Node-zu-Node-Aufrufe in der Betriebsart "Token je Host" (nur die Aufrufe, die ein Node
// dafür freigibt, s. omp-node-sdk nodeauth::peer_allowed).
const PeerEnv = "OMP_NODE_PEER_TOKEN"

// ScopeEnv schaltet mit dem Wert "host" auf ein Node-API-Token je Host um (Review 2026-11-27 B3).
const ScopeEnv = "OMP_NODE_TOKEN_SCOPE"

// LocalHost steht im Host-Token für Instanzen ohne Host-Agent (auf dem Orchestrator-Rechner).
const LocalHost = "local"

// DeriveHost leitet das Token der Nodes eines Hosts ab; es öffnet nur deren APIs.
func DeriveHost(secret []byte, hostID string) string {
	if hostID == "" {
		hostID = LocalHost
	}
	return derive(secret, "omp-node-api-v2:host:"+hostID)
}

// DerivePeer leitet das gemeinsame Peer-Token ab.
func DerivePeer(secret []byte) string { return derive(secret, "omp-node-peer-v1") }

func derive(secret []byte, label string) string {
	if len(secret) == 0 {
		return ""
	}
	m := hmac.New(sha256.New, secret)
	m.Write([]byte(label))
	return hex.EncodeToString(m.Sum(nil))
}

// Valid vergleicht in konstanter Zeit. Ein leeres Soll-Token akzeptiert nichts.
func Valid(want, got string) bool {
	return want != "" && hmac.Equal([]byte(want), []byte(got))
}

// internalHost: das Token geht nur an Ziele im eigenen Netz (Loopback, private/Link-Local-Adressen, Namen ohne Punkt oder
// .local/.internal/.lan), nie an öffentliche Namen (Cloud-APIs, Webhooks).
func internalHost(host string) bool {
	if host == "" {
		return false
	}
	if trusted(host) {
		return true
	}
	if ip := net.ParseIP(strings.Trim(host, "[]")); ip != nil {
		return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified()
	}
	h := strings.ToLower(host)
	if !strings.Contains(h, ".") {
		return true
	}
	for _, suf := range []string{".local", ".internal", ".lan", ".localdomain"} {
		if strings.HasSuffix(h, suf) {
			return true
		}
	}
	return false
}

var current atomic.Value // string

var extraHosts atomic.Value // []string

// SetExtraHosts erweitert die Ziele, an die das Token geht, um Rechnernamen oder Namensendungen (".example.org"), z. B. Nodes mit öffentlichen
// Namen. Aus der Umgebung: OMP_NODE_API_TOKEN_HOSTS (Komma-Liste).
func SetExtraHosts(hosts []string) {
	out := make([]string, 0, len(hosts))
	for _, h := range hosts {
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" {
			out = append(out, h)
		}
	}
	extraHosts.Store(out)
}

func trusted(host string) bool {
	list, _ := extraHosts.Load().([]string)
	h := strings.ToLower(host)
	for _, e := range list {
		if h == e || (strings.HasPrefix(e, ".") && strings.HasSuffix(h, e)) {
			return true
		}
	}
	return false
}

// SetToken legt das Token fest, das alle mit Wrap gebauten Transporte senden. Erst danach (Start des Orchestrators, sobald das
// gemeinsame Geheimnis geladen ist) wirken sie; vorher senden sie nichts.
func SetToken(t string) { current.Store(t) }

var resolver atomic.Value // func(string) string

// SetResolver setzt die Zuordnung Ziel (URL-Host "name:port") → Token dieses Ziels. Liefert sie "", geht das mit
// SetToken gesetzte Token mit (extern gestartete Nodes). Ohne Resolver gilt immer dieses.
func SetResolver(f func(hostport string) string) { resolver.Store(f) }

// TokenFor liefert das Token, das an ein Ziel geht ("name:port").
func TokenFor(hostport string) string {
	if f, _ := resolver.Load().(func(string) string); f != nil {
		if t := f(hostport); t != "" {
			return t
		}
	}
	return token()
}

func token() string {
	t, _ := current.Load().(string)
	return t
}

type transport struct{ base http.RoundTripper }

// Wrap liefert einen RoundTripper, der an interne Ziele das Token anhängt (außer die Anfrage trägt schon eines).
func Wrap(base http.RoundTripper) http.RoundTripper {
	if base == nil {
		base = http.DefaultTransport
	}
	return &transport{base: base}
}

func (t *transport) RoundTrip(r *http.Request) (*http.Response, error) {
	if tok := TokenFor(r.URL.Host); tok != "" && r.Header.Get(Header) == "" && internalHost(r.URL.Hostname()) {
		r = r.Clone(r.Context())
		r.Header.Set(Header, tok)
	}
	return t.base.RoundTrip(r)
}
