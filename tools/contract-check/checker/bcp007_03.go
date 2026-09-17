package checker

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

// transportMxlUrn muss mit nodes/omp-node-sdk/src/is04.rs::TRANSPORT_MXL
// übereinstimmen (AMWA BCP-007-03 v1.0.0, seit docs/decisions.md
// Nachtrag 229) — keine gemeinsame Konstante über die Modul-/
// Sprachgrenze hinweg möglich, gleiche Praxis wie
// ui/graph/flow-canvas.ts' eigene Kopie.
const transportMxlUrn = "urn:x-nmos:transport:mxl"

// CheckBcp00703Transports prüft für jeden Sender/Receiver dieses Nodes,
// dessen `transporttype` transportMxlUrn meldet, dass `staged.
// transport_params[0]` tatsächlich gegen das jeweilige offizielle
// BCP-007-03-v1.0.0-Schema (docs/bcp-007-03/*.schema.json, byte-genau
// von specs.amwa.tv geladen) valide ist — beweist das tatsächliche
// Wire-Verhalten, nicht nur eine korrekte URN im transporttype-Feld.
//
// Kein AMWA-nmos-testing-Suite deckt BCP-007-03 ab (Stand 2026-09,
// gegen die Suite-Liste des AMWA-TV/nmos-testing-Repos geprüft, s.
// docs/decisions.md Nachtrag 229) — dieser Check ist der eigene Ersatz,
// bis eine offizielle Suite erscheint (dann zusätzlich, nicht statt
// dessen: die AMWA-Suite deckt Verhaltens-Testfälle ab, die dieser rein
// formbasierte Schema-Check nicht abdeckt).
//
// SKIP (kein Sender/Receiver dieses Nodes meldet MXL als Transport) ist
// kein Fehler — die meisten Node-Rollen sind nie MXL (z. B. reine
// RTP-Senderrollen wie `playout`).
func (c *Checker) CheckBcp00703Transports(node is04Node, senderSchema, receiverSchema *jsonschema.Schema) Result {
	const name = "BCP-007-03 (MXL-Transport)"

	devices, err := c.registry.devicesForNode(node.ID)
	if err != nil {
		return Result{name, StatusSkip, fmt.Sprintf("Devices nicht abfragbar: %v", err)}
	}
	deviceIDs := make(map[string]bool, len(devices))
	for _, d := range devices {
		deviceIDs[d.ID] = true
	}

	senders, err := c.registry.allSenders()
	if err != nil {
		return Result{name, StatusSkip, fmt.Sprintf("Senders nicht abfragbar: %v", err)}
	}
	receivers, err := c.registry.allReceivers()
	if err != nil {
		return Result{name, StatusSkip, fmt.Sprintf("Receivers nicht abfragbar: %v", err)}
	}

	var lines []string
	failed := false
	checked := false

	for _, s := range senders {
		if !deviceIDs[s.DeviceID] {
			continue
		}
		ok, skip, detail := c.checkMxlLeg("senders", s.ID, senderSchema)
		if skip {
			continue
		}
		checked = true
		failed = failed || !ok
		lines = append(lines, fmt.Sprintf("sender %s: %s", s.ID, detail))
	}
	for _, r := range receivers {
		if !deviceIDs[r.DeviceID] {
			continue
		}
		ok, skip, detail := c.checkMxlLeg("receivers", r.ID, receiverSchema)
		if skip {
			continue
		}
		checked = true
		failed = failed || !ok
		lines = append(lines, fmt.Sprintf("receiver %s: %s", r.ID, detail))
	}

	if !checked {
		return Result{name, StatusSkip, "kein Sender/Receiver mit MXL-Transport gefunden"}
	}
	status := StatusPass
	if failed {
		status = StatusFail
	}
	return Result{name, status, strings.Join(lines, "; ")}
}

// checkMxlLeg meldet für genau einen Sender/Receiver, ob sein
// `staged.transport_params[0]` gegen `schema` valide ist. `skip=true`
// heißt: `transporttype` ist nicht transportMxlUrn (oder nicht
// abfragbar) — dieser Port zählt dann gar nicht in
// CheckBcp00703Transports' Gesamturteil, dasselbe "informativ pro
// Port"-Muster wie CheckIS05/probeIS05.
func (c *Checker) checkMxlLeg(kind, id string, schema *jsonschema.Schema) (ok bool, skip bool, detail string) {
	typeBody, typeStatus, err := c.getBody(fmt.Sprintf("/x-nmos/connection/v1.2/single/%s/%s/transporttype", kind, id))
	if err != nil || typeStatus != http.StatusOK {
		return false, true, ""
	}
	var transportType string
	if err := json.Unmarshal(typeBody, &transportType); err != nil || transportType != transportMxlUrn {
		return false, true, ""
	}

	stagedBody, stagedStatus, err := c.getBody(fmt.Sprintf("/x-nmos/connection/v1.2/single/%s/%s/staged", kind, id))
	if err != nil {
		return false, false, fmt.Sprintf("GET staged fehlgeschlagen: %v", err)
	}
	if stagedStatus != http.StatusOK {
		return false, false, fmt.Sprintf("GET staged: Status %d", stagedStatus)
	}

	var doc struct {
		TransportParams []json.RawMessage `json:"transport_params"`
	}
	if err := json.Unmarshal(stagedBody, &doc); err != nil || len(doc.TransportParams) == 0 {
		return false, false, "staged.transport_params fehlt oder nicht parsebar"
	}

	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(doc.TransportParams[0]))
	if err != nil {
		return false, false, fmt.Sprintf("transport_params[0] kein gültiges JSON: %v", err)
	}
	if err := schema.Validate(inst); err != nil {
		return false, false, fmt.Sprintf("BCP-007-03-Schema-Verletzung: %v", err)
	}
	return true, false, "BCP-007-03-konform"
}
