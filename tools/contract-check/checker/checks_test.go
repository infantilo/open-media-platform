package checker

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

func compileTestSchema(t *testing.T) *jsonschema.Schema {
	t.Helper()
	c := jsonschema.NewCompiler()
	sch, err := c.Compile(DefaultSchemaPath())
	if err != nil {
		t.Fatalf("failed to compile docs/descriptor-v0.schema.json: %v", err)
	}
	return sch
}

// compileMxlSchemas kompiliert die beiden echten BCP-007-03-Schemas
// (docs/bcp-007-03/) — dieselben, die auch der echte `contract-check`
// benutzt, keine Test-Fixtures.
func compileMxlSchemas(t *testing.T) (sender, receiver *jsonschema.Schema) {
	t.Helper()
	c := jsonschema.NewCompiler()
	s, err := c.Compile(DefaultMxlSenderTransportSchemaPath())
	if err != nil {
		t.Fatalf("failed to compile sender_transport_params_mxl.schema.json: %v", err)
	}
	r, err := c.Compile(DefaultMxlReceiverTransportSchemaPath())
	if err != nil {
		t.Fatalf("failed to compile receiver_transport_params_mxl.schema.json: %v", err)
	}
	return s, r
}

// runAll ruft Run() mit den echten Schemas auf — Kurzform, damit nicht
// jeder Testfall alle drei Schemas einzeln durchreichen muss.
func runAll(t *testing.T, client *http.Client, nodeURL, registryURL string) []Result {
	t.Helper()
	mxlSender, mxlReceiver := compileMxlSchemas(t)
	return Run(client, nodeURL, registryURL, compileTestSchema(t), mxlSender, mxlReceiver)
}

// fakeNode ist ein minimaler HTTP-Server, der genug vom Node-Contract
// (Descriptor-Self-Describe + optionales UI-Bundle) nachbildet, um
// checks.go ohne einen echten Rust/Go-Node zu testen.
type fakeNode struct {
	mu         sync.Mutex
	descriptor []byte
	params     map[string]any
	withUI     bool
}

func startFakeNode(t *testing.T, descriptor []byte, initialParams map[string]any, withUI bool) *httptest.Server {
	t.Helper()
	fn := &fakeNode{descriptor: descriptor, params: initialParams, withUI: withUI}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /descriptor.json", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write(fn.descriptor)
	})
	mux.HandleFunc("GET /params/{name}", func(w http.ResponseWriter, r *http.Request) {
		fn.mu.Lock()
		defer fn.mu.Unlock()
		v, ok := fn.params[r.PathValue("name")]
		if !ok {
			http.Error(w, "unknown parameter", http.StatusNotFound)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"value": v})
	})
	mux.HandleFunc("PATCH /params/{name}", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Value any `json:"value"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		fn.mu.Lock()
		fn.params[r.PathValue("name")] = body.Value
		fn.mu.Unlock()
		json.NewEncoder(w).Encode(map[string]any{"value": body.Value})
	})
	if withUI {
		mux.HandleFunc("GET /ui/manifest.json", func(w http.ResponseWriter, r *http.Request) {
			json.NewEncoder(w).Encode(map[string]string{"name": "fake-panel", "version": "0.1.0", "tag": "fake-panel"})
		})
		mux.HandleFunc("GET /ui/bundle.js", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/javascript")
			w.Write([]byte("customElements.define('fake-panel', class extends HTMLElement {});"))
		})
	}

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

// startFakeRegistry bildet genug der IS-04-Query-API nach (nodes,
// devices, senders, receivers), um is04.go zu bedienen.
func startFakeRegistry(t *testing.T, nodes []is04Node, devices []is04Device, senders []is04Sender, receivers []is04Receiver) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /x-nmos/query/v1.3/nodes", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(nodes)
	})
	mux.HandleFunc("GET /x-nmos/query/v1.3/devices", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(devices)
	})
	mux.HandleFunc("GET /x-nmos/query/v1.3/senders", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(senders)
	})
	mux.HandleFunc("GET /x-nmos/query/v1.3/receivers", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(receivers)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

// nodeResourceFor baut ein is04Node-Fixture, dessen api.endpoints exakt
// auf nodeServerURL zeigt (wie es findNodeByURL erwartet).
func nodeResourceFor(t *testing.T, id, label, nodeServerURL string) is04Node {
	t.Helper()
	u, err := url.Parse(nodeServerURL)
	if err != nil {
		t.Fatalf("invalid node server URL: %v", err)
	}
	host, portStr, err := net.SplitHostPort(u.Host)
	if err != nil {
		t.Fatalf("invalid node server host:port %q: %v", u.Host, err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatalf("invalid port %q: %v", portStr, err)
	}
	return is04Node{
		ID:    id,
		Label: label,
		API:   is04NodeAPI{Endpoints: []is04NodeEndpoint{{Host: host, Port: port}}},
	}
}

const validDescriptorJSON = `{
  "parameters": [
    {"name": "gain", "type": "number", "unit": "dB", "range": {"min": -20, "max": 20}, "readonly": false},
    {"name": "flowId", "type": "string", "unit": null, "range": null, "readonly": true}
  ],
  "methods": [{"name": "reset", "args": []}]
}`

const readonlyOnlyDescriptorJSON = `{
  "parameters": [
    {"name": "connectedFlowId", "type": "string", "unit": null, "range": null, "readonly": true}
  ],
  "methods": []
}`

const brokenDescriptorJSON = `{
  "parameters": [
    {"name": "gain", "type": "not-a-real-type", "readonly": false}
  ],
  "methods": []
}`

func TestRunAllChecksPassForValidNode(t *testing.T) {
	nodeServer := startFakeNode(t, []byte(validDescriptorJSON), map[string]any{"gain": float64(0), "flowId": "abc"}, true)
	deviceID := "device-1"
	node := nodeResourceFor(t, "node-1", "Fake Node", nodeServer.URL)
	registry := startFakeRegistry(t,
		[]is04Node{node},
		[]is04Device{{ID: deviceID, NodeID: node.ID}},
		[]is04Sender{{ID: "sender-1", DeviceID: deviceID}},
		nil,
	)

	client := &http.Client{Timeout: 2 * time.Second}
	results := runAll(t, client, nodeServer.URL, registry.URL)

	byName := resultsByName(results)
	assertStatus(t, byName, "IS-04-Registrierung", StatusPass)
	assertStatus(t, byName, "Descriptor-Schema", StatusPass)
	assertStatus(t, byName, "Param-Roundtrip", StatusPass)
	assertStatus(t, byName, "UI-Manifest", StatusPass)
	assertStatus(t, byName, "IS-05 (informativ)", StatusPass)
	// fakeNode implementiert keine /x-nmos/connection/-Endpunkte — der
	// BCP-007-03-Check muss das als "kein MXL-Transport" überspringen,
	// nicht fälschlich FAILen.
	assertStatus(t, byName, "BCP-007-03 (MXL-Transport)", StatusSkip)
}

func TestRunSkipsParamRoundtripWhenNoWritableParam(t *testing.T) {
	nodeServer := startFakeNode(t, []byte(readonlyOnlyDescriptorJSON), map[string]any{"connectedFlowId": ""}, false)
	node := nodeResourceFor(t, "node-1", "Fake Viewer", nodeServer.URL)
	registry := startFakeRegistry(t, []is04Node{node}, nil, nil, nil)

	client := &http.Client{Timeout: 2 * time.Second}
	results := runAll(t, client, nodeServer.URL, registry.URL)

	byName := resultsByName(results)
	assertStatus(t, byName, "Param-Roundtrip", StatusSkip)
	assertStatus(t, byName, "UI-Manifest", StatusSkip)
}

func TestRunFailsForUnregisteredNode(t *testing.T) {
	nodeServer := startFakeNode(t, []byte(validDescriptorJSON), map[string]any{"gain": float64(0)}, false)
	// Registry kennt den Node nicht (leere Node-Liste).
	registry := startFakeRegistry(t, nil, nil, nil, nil)

	client := &http.Client{Timeout: 2 * time.Second}
	results := runAll(t, client, nodeServer.URL, registry.URL)

	byName := resultsByName(results)
	assertStatus(t, byName, "IS-04-Registrierung", StatusFail)
	assertStatus(t, byName, "IS-05 (informativ)", StatusSkip)
}

// TestRunFailsForBrokenDescriptor deckt UMSETZUNG.md C9s explizite
// Verifikationsanforderung ab: "absichtlich kaputter Descriptor → Check
// schlägt mit klarer Meldung fehl".
func TestRunFailsForBrokenDescriptor(t *testing.T) {
	nodeServer := startFakeNode(t, []byte(brokenDescriptorJSON), map[string]any{"gain": float64(0)}, false)
	node := nodeResourceFor(t, "node-1", "Broken Node", nodeServer.URL)
	registry := startFakeRegistry(t, []is04Node{node}, nil, nil, nil)

	client := &http.Client{Timeout: 2 * time.Second}
	results := runAll(t, client, nodeServer.URL, registry.URL)

	byName := resultsByName(results)
	got, ok := byName["Descriptor-Schema"]
	if !ok {
		t.Fatal("missing Descriptor-Schema result")
	}
	if got.Status != StatusFail {
		t.Fatalf("Descriptor-Schema status = %v, want FAIL", got.Status)
	}
	if !strings.Contains(got.Detail, "parameters/0/type") {
		t.Errorf("Descriptor-Schema detail = %q, want a clear message pointing at the invalid field", got.Detail)
	}
	// Ohne validen Descriptor kann kein Parameter sicher synthetisiert
	// werden — Param-Roundtrip wird übersprungen, nicht fälschlich PASS.
	assertStatus(t, byName, "Param-Roundtrip", StatusSkip)
}

func TestRunReportsIS05AbsentWithoutFailing(t *testing.T) {
	// Node hat laut Registry einen Sender, implementiert aber keinen
	// IS-05-Endpoint dafür (z. B. omp-source, UMSETZUNG.md C5) — muss
	// als "nicht implementiert" reportet werden, nicht FAIL (siehe
	// CheckIS05-Dokumentation).
	nodeServer := startFakeNode(t, []byte(validDescriptorJSON), map[string]any{"gain": float64(0)}, false)
	deviceID := "device-1"
	node := nodeResourceFor(t, "node-1", "Fake Source", nodeServer.URL)
	registry := startFakeRegistry(t,
		[]is04Node{node},
		[]is04Device{{ID: deviceID, NodeID: node.ID}},
		[]is04Sender{{ID: "sender-1", DeviceID: deviceID}},
		nil,
	)

	client := &http.Client{Timeout: 2 * time.Second}
	results := runAll(t, client, nodeServer.URL, registry.URL)

	byName := resultsByName(results)
	got := byName["IS-05 (informativ)"]
	if got.Status != StatusPass {
		t.Fatalf("IS-05 status = %v, want PASS (informativ, nie FAIL)", got.Status)
	}
	if !strings.Contains(got.Detail, "nicht implementiert") {
		t.Errorf("IS-05 detail = %q, want it to note the missing sender-side endpoint", got.Detail)
	}
}

// startFakeMxlSender bildet gerade so viel eines echten MXL-Senders
// nach (`/x-nmos/connection/v1.2/single/senders/{id}/transporttype`+
// `/staged`), wie CheckBcp00703Transports braucht — `stagedTransportParams`
// wird 1:1 als `transport_params[0]` zurückgegeben, damit ein Testfall
// gezielt spec-konforme und spec-widrige Werte durchspielen kann.
func startFakeMxlSender(t *testing.T, senderID string, stagedTransportParams string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	path := "/x-nmos/connection/v1.2/single/senders/" + senderID
	mux.HandleFunc("GET "+path+"/transporttype", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`"` + transportMxlUrn + `"`))
	})
	mux.HandleFunc("GET "+path+"/staged", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"transport_params":[` + stagedTransportParams + `]}`))
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

func TestBcp00703TransportsPassesForSpecCompliantSenderLeg(t *testing.T) {
	senderID := "sender-1"
	nodeServer := startFakeMxlSender(t, senderID, `{"mxl_domain_id":"auto","mxl_flow_id":"auto"}`)
	deviceID := "device-1"
	node := nodeResourceFor(t, "node-1", "Fake MXL Sender", nodeServer.URL)
	registry := startFakeRegistry(t,
		[]is04Node{node},
		[]is04Device{{ID: deviceID, NodeID: node.ID}},
		[]is04Sender{{ID: senderID, DeviceID: deviceID}},
		nil,
	)

	client := &http.Client{Timeout: 2 * time.Second}
	senderSchema, receiverSchema := compileMxlSchemas(t)
	c := &Checker{http: client, nodeURL: nodeServer.URL, registry: newRegistryClient(registry.URL, client)}

	result := c.CheckBcp00703Transports(node, senderSchema, receiverSchema)
	if result.Status != StatusPass {
		t.Fatalf("status = %v, want PASS (detail: %s)", result.Status, result.Detail)
	}
}

// TestBcp00703TransportsFailsForRtpShapedLeg deckt genau den vor
// Nachtrag 229 bestehenden Bug ab: ein als MXL deklarierter Sender, der
// (wie damals) RTP-geformte transport_params liefert, muss jetzt als
// Schema-Verletzung erkannt werden.
func TestBcp00703TransportsFailsForRtpShapedLeg(t *testing.T) {
	senderID := "sender-1"
	nodeServer := startFakeMxlSender(t, senderID, `{"destination_ip":null,"destination_port":null,"rtp_enabled":false}`)
	deviceID := "device-1"
	node := nodeResourceFor(t, "node-1", "Fake Buggy MXL Sender", nodeServer.URL)
	registry := startFakeRegistry(t,
		[]is04Node{node},
		[]is04Device{{ID: deviceID, NodeID: node.ID}},
		[]is04Sender{{ID: senderID, DeviceID: deviceID}},
		nil,
	)

	client := &http.Client{Timeout: 2 * time.Second}
	senderSchema, receiverSchema := compileMxlSchemas(t)
	c := &Checker{http: client, nodeURL: nodeServer.URL, registry: newRegistryClient(registry.URL, client)}

	result := c.CheckBcp00703Transports(node, senderSchema, receiverSchema)
	if result.Status != StatusFail {
		t.Fatalf("status = %v, want FAIL for RTP-shaped transport_params under an MXL transporttype", result.Status)
	}
}

func resultsByName(results []Result) map[string]Result {
	m := make(map[string]Result, len(results))
	for _, r := range results {
		m[r.Name] = r
	}
	return m
}

func assertStatus(t *testing.T, byName map[string]Result, name string, want Status) {
	t.Helper()
	got, ok := byName[name]
	if !ok {
		t.Fatalf("missing result %q", name)
	}
	if got.Status != want {
		t.Errorf("%s status = %v, want %v (detail: %s)", name, got.Status, want, got.Detail)
	}
}
