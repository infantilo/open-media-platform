package nodeauth

import (
	"net/http"
	"net/url"
	"strings"
)

// Target ist eine bekannte Node-API-Adresse samt dem Host, auf dem die Instanz läuft ("" = ohne Host-Agent).
type Target struct {
	BaseURL string
	HostID  string
}

// HostResolver baut den Resolver für SetResolver: genaue Adresse "name:port", sonst (Zusatzports wie Vorschau-Streams)
// der Rechnername, wenn alle Nodes dieses Namens auf demselben Host laufen. targets wird je Anfrage gelesen.
func HostResolver(secret []byte, targets func() []Target) func(string) string {
	return func(hostport string) string {
		name := hostName(hostport)
		byName, ambiguous := "", false
		for _, t := range targets() {
			addr := t.BaseURL
			if i := strings.Index(addr, "://"); i >= 0 {
				addr = addr[i+3:]
			}
			addr, _, _ = strings.Cut(addr, "/")
			if strings.EqualFold(addr, hostport) {
				return DeriveHost(secret, t.HostID)
			}
			if strings.EqualFold(hostName(addr), name) {
				token := DeriveHost(secret, t.HostID)
				ambiguous = ambiguous || (byName != "" && byName != token)
				byName = token
			}
		}
		if ambiguous {
			return ""
		}
		return byName
	}
}

func hostName(hostport string) string {
	if i := strings.LastIndex(hostport, ":"); i >= 0 && !strings.HasSuffix(hostport, "]") {
		hostport = hostport[:i]
	}
	return strings.Trim(hostport, "[]")
}

// Attach setzt an eine Anfrage an einen Zusatzport eines Nodes (z. B. Vorschau-Stream) das Token seiner API-Adresse
// apiBaseURL — nur bei demselben Rechnernamen und nur an interne Ziele. Der Rechnername allein ist nicht eindeutig,
// wenn mehrere Hosts dieselbe Adresse nutzen.
func Attach(r *http.Request, apiBaseURL string) {
	api, err := url.Parse(apiBaseURL)
	if err != nil || !strings.EqualFold(api.Hostname(), r.URL.Hostname()) || !internalHost(r.URL.Hostname()) {
		return
	}
	if t := TokenFor(api.Host); t != "" {
		r.Header.Set(Header, t)
	}
}
