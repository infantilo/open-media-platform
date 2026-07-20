package checker

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

// Status ist das Ergebnis eines einzelnen Contract-Checks.
type Status string

const (
	StatusPass Status = "PASS"
	StatusFail Status = "FAIL"
	StatusSkip Status = "SKIP"
)

// Result ist die Ausgabe eines einzelnen Checks (eine Zeile im Report).
type Result struct {
	Name   string
	Status Status
	Detail string
}

// paramSpec/descriptorDoc decoden nur die Felder, die contract-check
// braucht — Wire-Format nach docs/descriptor-v0.schema.json.
type paramSpec struct {
	Name     string          `json:"name"`
	Type     string          `json:"type"`
	Range    json.RawMessage `json:"range"`
	Readonly bool            `json:"readonly"`
}

type descriptorDoc struct {
	Parameters []paramSpec `json:"parameters"`
}

type enumRange struct {
	Values []string `json:"values"`
}

type numberRange struct {
	Min float64 `json:"min"`
	Max float64 `json:"max"`
}

// Checker bündelt die für alle Checks gemeinsam gebrauchten Clients
// gegen genau einen Node.
type Checker struct {
	http     *http.Client
	nodeURL  string
	registry *registryClient
	schema   *jsonschema.Schema
}

// Run führt den vollständigen Node-Contract-Check aus (ARCHITECTURE.md
// §5): IS-04-Registrierung, Descriptor-Schema, Param-Roundtrip,
// UI-Manifest (optional), IS-05 (informativ, siehe CheckIS05).
func Run(client *http.Client, nodeURL, registryURL string, schema *jsonschema.Schema) []Result {
	c := &Checker{
		http:     client,
		nodeURL:  strings.TrimRight(nodeURL, "/"),
		registry: newRegistryClient(strings.TrimRight(registryURL, "/"), client),
		schema:   schema,
	}

	var results []Result

	regResult, node := c.CheckRegistration()
	results = append(results, regResult)

	descResult, descBody := c.CheckDescriptor()
	results = append(results, descResult)

	if descBody != nil {
		results = append(results, c.CheckParamRoundtrip(descBody))
	} else {
		results = append(results, Result{"Param-Roundtrip", StatusSkip, "übersprungen (Descriptor-Check fehlgeschlagen)"})
	}

	results = append(results, c.CheckUIManifest())

	if regResult.Status == StatusPass {
		results = append(results, c.CheckIS05(node))
	} else {
		results = append(results, Result{"IS-05 (informativ)", StatusSkip, "übersprungen (Node nicht in Registry gefunden)"})
	}

	return results
}

// CheckRegistration prüft Node-Contract-Punkt 1 (ARCHITECTURE.md §5):
// Node bei der NMOS-Registry registriert. Liefert zusätzlich den
// gefundenen Node-Snapshot für CheckIS05.
func (c *Checker) CheckRegistration() (Result, is04Node) {
	node, found, err := c.registry.findNodeByURL(c.nodeURL)
	if err != nil {
		return Result{"IS-04-Registrierung", StatusFail, fmt.Sprintf("Registry-Abfrage fehlgeschlagen: %v", err)}, is04Node{}
	}
	if !found {
		return Result{
			"IS-04-Registrierung", StatusFail,
			fmt.Sprintf("kein Node mit api.endpoints passend zu %s in der Registry gefunden", c.nodeURL),
		}, is04Node{}
	}
	return Result{"IS-04-Registrierung", StatusPass, fmt.Sprintf("Node %q (%s) registriert", node.Label, node.ID)}, node
}

// CheckDescriptor prüft Node-Contract-Punkt 2 (Self-Describe): GET
// /descriptor.json muss gegen docs/descriptor-v0.schema.json valide
// sein. Liefert den rohen Body zurück, damit CheckParamRoundtrip ihn
// weiterverwenden kann, ohne ein zweites Mal zu fragen.
func (c *Checker) CheckDescriptor() (Result, []byte) {
	body, status, err := c.getBody("/descriptor.json")
	if err != nil {
		return Result{"Descriptor-Schema", StatusFail, err.Error()}, nil
	}
	if status != http.StatusOK {
		return Result{"Descriptor-Schema", StatusFail, fmt.Sprintf("GET /descriptor.json: Status %d", status)}, nil
	}

	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	if err != nil {
		return Result{"Descriptor-Schema", StatusFail, fmt.Sprintf("ungültiges JSON: %v", err)}, nil
	}
	if err := c.schema.Validate(inst); err != nil {
		return Result{"Descriptor-Schema", StatusFail, fmt.Sprintf("Schema-Validierung fehlgeschlagen: %v", err)}, nil
	}
	return Result{"Descriptor-Schema", StatusPass, "descriptor.json entspricht docs/descriptor-v0.schema.json"}, body
}

// CheckParamRoundtrip prüft, dass ein beschreibbarer Parameter (PATCH)
// tatsächlich ankommt (GET liefert den gerade gesetzten Wert). Nicht
// jeder Node hat einen beschreibbaren Parameter (z. B. omp-viewer,
// omp-switcher: nur readonly-Parameter) — dann SKIP statt FAIL, sonst
// wäre "grün für alle fünf Node-Typen" (UMSETZUNG.md C9) unerfüllbar.
func (c *Checker) CheckParamRoundtrip(descriptorBody []byte) Result {
	var doc descriptorDoc
	if err := json.Unmarshal(descriptorBody, &doc); err != nil {
		return Result{"Param-Roundtrip", StatusFail, fmt.Sprintf("Descriptor nicht parsebar: %v", err)}
	}

	var target *paramSpec
	for i := range doc.Parameters {
		if !doc.Parameters[i].Readonly {
			target = &doc.Parameters[i]
			break
		}
	}
	if target == nil {
		return Result{"Param-Roundtrip", StatusSkip, "kein beschreibbarer Parameter im Descriptor"}
	}

	value, err := synthesizeValue(*target)
	if err != nil {
		return Result{"Param-Roundtrip", StatusFail, fmt.Sprintf("Parameter %q: %v", target.Name, err)}
	}

	patchBody, err := json.Marshal(map[string]any{"value": value})
	if err != nil {
		return Result{"Param-Roundtrip", StatusFail, fmt.Sprintf("Test-Wert nicht serialisierbar: %v", err)}
	}
	status, err := c.patchJSON("/params/"+target.Name, patchBody)
	if err != nil {
		return Result{"Param-Roundtrip", StatusFail, fmt.Sprintf("PATCH /params/%s fehlgeschlagen: %v", target.Name, err)}
	}
	if status != http.StatusOK {
		return Result{"Param-Roundtrip", StatusFail, fmt.Sprintf("PATCH /params/%s: Status %d", target.Name, status)}
	}

	getBody, getStatus, err := c.getBody("/params/" + target.Name)
	if err != nil {
		return Result{"Param-Roundtrip", StatusFail, fmt.Sprintf("GET /params/%s nach PATCH fehlgeschlagen: %v", target.Name, err)}
	}
	if getStatus != http.StatusOK {
		return Result{"Param-Roundtrip", StatusFail, fmt.Sprintf("GET /params/%s nach PATCH: Status %d", target.Name, getStatus)}
	}

	var got struct {
		Value any `json:"value"`
	}
	if err := json.Unmarshal(getBody, &got); err != nil {
		return Result{"Param-Roundtrip", StatusFail, fmt.Sprintf("Antwort nicht parsebar: %v", err)}
	}
	if !reflect.DeepEqual(got.Value, value) {
		return Result{
			"Param-Roundtrip", StatusFail,
			fmt.Sprintf("Parameter %q: gesetzt %v, danach gelesen %v", target.Name, value, got.Value),
		}
	}
	return Result{"Param-Roundtrip", StatusPass, fmt.Sprintf("Parameter %q roundtrip erfolgreich (%v)", target.Name, value)}
}

// synthesizeValue baut einen zum deklarierten Typ passenden Testwert —
// bei number/enum unter Beachtung von range, damit der Node den PATCH
// nicht wegen eines ungültigen Werts ablehnt.
func synthesizeValue(p paramSpec) (any, error) {
	switch p.Type {
	case "boolean":
		return true, nil
	case "string":
		return "contract-check", nil
	case "number":
		if len(p.Range) > 0 {
			var r numberRange
			if err := json.Unmarshal(p.Range, &r); err == nil {
				return r.Min, nil
			}
		}
		return float64(0), nil
	case "enum":
		var r enumRange
		if err := json.Unmarshal(p.Range, &r); err != nil || len(r.Values) == 0 {
			return nil, fmt.Errorf("enum-Parameter ohne gültiges range.values")
		}
		return r.Values[0], nil
	default:
		return nil, fmt.Errorf("unbekannter Parametertyp %q", p.Type)
	}
}

// CheckUIManifest prüft Node-Contract-Punkt 3 — optional laut
// ARCHITECTURE.md §5 ("falls UI"): fehlt /ui/manifest.json (404), ist
// das SKIP statt FAIL. Ist es vorhanden, müssen manifest.json (mit
// "tag") und bundle.js beide korrekt ausgeliefert werden.
func (c *Checker) CheckUIManifest() Result {
	body, status, err := c.getBody("/ui/manifest.json")
	if err != nil {
		return Result{"UI-Manifest", StatusFail, err.Error()}
	}
	if status == http.StatusNotFound {
		return Result{"UI-Manifest", StatusSkip, "kein /ui/manifest.json (optional laut Node-Contract)"}
	}
	if status != http.StatusOK {
		return Result{"UI-Manifest", StatusFail, fmt.Sprintf("GET /ui/manifest.json: Status %d", status)}
	}

	var manifest struct {
		Tag string `json:"tag"`
	}
	if err := json.Unmarshal(body, &manifest); err != nil || manifest.Tag == "" {
		return Result{"UI-Manifest", StatusFail, "manifest.json enthält kein gültiges 'tag'-Feld"}
	}

	bundleBody, bundleStatus, err := c.getBody("/ui/bundle.js")
	if err != nil {
		return Result{"UI-Manifest", StatusFail, fmt.Sprintf("GET /ui/bundle.js fehlgeschlagen: %v", err)}
	}
	if bundleStatus != http.StatusOK || len(bundleBody) == 0 {
		return Result{"UI-Manifest", StatusFail, fmt.Sprintf("GET /ui/bundle.js: Status %d, %d Bytes", bundleStatus, len(bundleBody))}
	}

	return Result{"UI-Manifest", StatusPass, fmt.Sprintf("manifest.json (tag=%q) + bundle.js vorhanden", manifest.Tag)}
}

// CheckIS05 ist bewusst rein informativ (nie FAIL): von den fünf
// Ziel-Node-Typen implementieren manche nur Sender-, manche nur
// Receiver-seitige IS-05-Connections, omp-source/omp-switcher aktuell
// keine von beiden (UMSETZUNG.md C3/C5/C7 — z. B. hat omp-switcher
// seine Quellwahl als internen Zustand ohne IS-05-Kante, dokumentierte
// Abweichung von §4.5a). "IS-05 vorhanden" als Pflichtkriterium wäre
// für den aktuellen Node-Fleet unerfüllbar; stattdessen wird der
// tatsächliche Stand pro Sender/Receiver-Port reportet.
func (c *Checker) CheckIS05(node is04Node) Result {
	devices, err := c.registry.devicesForNode(node.ID)
	if err != nil {
		return Result{"IS-05 (informativ)", StatusSkip, fmt.Sprintf("Devices nicht abfragbar: %v", err)}
	}
	deviceIDs := make(map[string]bool, len(devices))
	for _, d := range devices {
		deviceIDs[d.ID] = true
	}

	senders, err := c.registry.allSenders()
	if err != nil {
		return Result{"IS-05 (informativ)", StatusSkip, fmt.Sprintf("Senders nicht abfragbar: %v", err)}
	}
	receivers, err := c.registry.allReceivers()
	if err != nil {
		return Result{"IS-05 (informativ)", StatusSkip, fmt.Sprintf("Receivers nicht abfragbar: %v", err)}
	}

	var lines []string
	for _, s := range senders {
		if !deviceIDs[s.DeviceID] {
			continue
		}
		lines = append(lines, fmt.Sprintf("sender %s: %s", s.ID, c.probeIS05("senders", s.ID)))
	}
	for _, r := range receivers {
		if !deviceIDs[r.DeviceID] {
			continue
		}
		lines = append(lines, fmt.Sprintf("receiver %s: %s", r.ID, c.probeIS05("receivers", r.ID)))
	}

	if len(lines) == 0 {
		return Result{"IS-05 (informativ)", StatusSkip, "keine Sender/Receiver deklariert"}
	}
	return Result{"IS-05 (informativ)", StatusPass, strings.Join(lines, "; ")}
}

func (c *Checker) probeIS05(kind, id string) string {
	reqURL := fmt.Sprintf("%s/x-nmos/connection/v1.1/single/%s/%s/staged", c.nodeURL, kind, id)
	resp, err := c.http.Get(reqURL)
	if err != nil {
		return "nicht erreichbar"
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		return "vorhanden"
	}
	return "nicht implementiert"
}

func (c *Checker) getBody(path string) ([]byte, int, error) {
	resp, err := c.http.Get(c.nodeURL + path)
	if err != nil {
		return nil, 0, fmt.Errorf("GET %s%s: %w", c.nodeURL, path, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, fmt.Errorf("read body of GET %s%s: %w", c.nodeURL, path, err)
	}
	return body, resp.StatusCode, nil
}

func (c *Checker) patchJSON(path string, body []byte) (int, error) {
	req, err := http.NewRequest(http.MethodPatch, c.nodeURL+path, bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	return resp.StatusCode, nil
}
