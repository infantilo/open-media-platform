package checker

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// Die folgenden Typen decoden nur die Felder, die contract-check braucht
// — kein vollständiges Abbild der IS-04-Schemas, dieselbe Praxis wie
// orchestrator/internal/registry/types.go (ARCHITECTURE.md §2/§11.1:
// "kein Orchestrator-Sonderwissen").

type is04Node struct {
	ID    string      `json:"id"`
	Label string      `json:"label"`
	API   is04NodeAPI `json:"api"`
}

type is04NodeAPI struct {
	Endpoints []is04NodeEndpoint `json:"endpoints"`
}

type is04NodeEndpoint struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}

type is04Device struct {
	ID     string `json:"id"`
	NodeID string `json:"node_id"`
}

type is04Sender struct {
	ID       string `json:"id"`
	DeviceID string `json:"device_id"`
}

type is04Receiver struct {
	ID       string `json:"id"`
	DeviceID string `json:"device_id"`
}

// registryClient fragt die Standard-IS-04-Query-API einer NMOS-Registry
// ab — dieselbe API-Form wie orchestrator/internal/registry.Client,
// hier unabhängig neu implementiert (contract-check ist ein
// eigenständiges Go-Modul ohne Abhängigkeit auf den Orchestrator).
type registryClient struct {
	baseURL string
	http    *http.Client
}

func newRegistryClient(baseURL string, httpClient *http.Client) *registryClient {
	return &registryClient{baseURL: baseURL, http: httpClient}
}

func (c *registryClient) getJSON(resource string, dst any) error {
	reqURL := fmt.Sprintf("%s/x-nmos/query/v1.3/%s", c.baseURL, resource)
	resp, err := c.http.Get(reqURL)
	if err != nil {
		return fmt.Errorf("GET %s: %w", reqURL, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: unexpected status %d", reqURL, resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(dst)
}

// findNodeByURL sucht im Registry-Snapshot den Node, dessen erster
// api.endpoints-Eintrag zu nodeURL passt (Host:Port-Vergleich) —
// dasselbe Verfahren wie orchestrator/internal/registry.apiBaseURL, nur
// in umgekehrter Richtung, ohne jedes Node-Typ-Sonderwissen. Der
// Host-Vergleich löst beide Seiten per DNS auf (statt reinem
// String-Vergleich): Nodes registrieren sich standardmäßig unter
// OMP_HOST=127.0.0.1, ein Nutzer tippt für NODE_URL aber naheliegend
// "localhost" — beides muss als dieselbe Adresse erkannt werden.
func (c *registryClient) findNodeByURL(nodeURL string) (is04Node, bool, error) {
	var nodes []is04Node
	if err := c.getJSON("nodes", &nodes); err != nil {
		return is04Node{}, false, err
	}
	u, err := url.Parse(nodeURL)
	if err != nil {
		return is04Node{}, false, fmt.Errorf("invalid node URL %q: %w", nodeURL, err)
	}
	host, portStr, err := net.SplitHostPort(u.Host)
	if err != nil {
		return is04Node{}, false, fmt.Errorf("invalid host:port in node URL %q: %w", nodeURL, err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		return is04Node{}, false, fmt.Errorf("invalid port in node URL %q: %w", nodeURL, err)
	}
	for _, n := range nodes {
		for _, ep := range n.API.Endpoints {
			if ep.Port == port && hostsMatch(ep.Host, host) {
				return n, true, nil
			}
		}
	}
	return is04Node{}, false, nil
}

// hostsMatch vergleicht zwei Hostnamen/IPs auf tatsächliche
// Adressgleichheit statt reinem String-Vergleich (siehe findNodeByURL).
func hostsMatch(a, b string) bool {
	if strings.EqualFold(a, b) {
		return true
	}
	for _, ai := range resolveHost(a) {
		for _, bi := range resolveHost(b) {
			if ai.Equal(bi) {
				return true
			}
		}
	}
	return false
}

func resolveHost(host string) []net.IP {
	if ip := net.ParseIP(host); ip != nil {
		return []net.IP{ip}
	}
	ips, err := net.LookupIP(host)
	if err != nil {
		return nil
	}
	return ips
}

func (c *registryClient) devicesForNode(nodeID string) ([]is04Device, error) {
	var devices []is04Device
	if err := c.getJSON("devices", &devices); err != nil {
		return nil, err
	}
	var out []is04Device
	for _, d := range devices {
		if d.NodeID == nodeID {
			out = append(out, d)
		}
	}
	return out, nil
}

func (c *registryClient) allSenders() ([]is04Sender, error) {
	var s []is04Sender
	return s, c.getJSON("senders", &s)
}

func (c *registryClient) allReceivers() ([]is04Receiver, error) {
	var r []is04Receiver
	return r, c.getJSON("receivers", &r)
}
