// sender.go implementiert die IS-05-Sender-seitige Connection-API für den
// Mock-Node (Nachtrag 193) — Pendant zu receiver.go, bisher bewusst
// unimplementiert (Schritt B1: "der Mock-Node ist rein Receiver-seitig").
// Grund für die Ergänzung: AMWA IS-05-01s `auto_connection_1/2/3/4/5/6/13`
// brauchen einen echten, IS-04-registrierten Sender zum Verbinden
// (UMSETZUNG.md D11) — ohne Sender-Fixture bleiben diese sieben Tests
// dauerhaft eine Ausnahme statt echter Konformität.
//
// Feldnamen/Struktur GEPRÜFT gegen AMWA-TV/is-05 (Branch v1.1.2) statt
// vom Receiver-Pendant übernommen zu raten (Projektregel §0.6):
// APIs/schemas/sender-stage-schema.json, sender-response-schema.json,
// sender_transport_params_rtp.json, activation-response-schema.json,
// examples/sender-get-200-uninit.json, sender-active-get-uninit.json,
// sender-constraints-get-200.json, ConnectionAPI.raml (transportfile-
// Response-Codes). Wichtigste Abweichungen vom Receiver:
//   - KEIN `transport_file`-Feld auf der Resource selbst (anders als
//     ReceiverResource) — der Sender-Transport-File ist ein eigener
//     Endpunkt (`/transportfile`), nicht Teil von staged/active.
//   - Andere Transport-Parameter-Feldmenge: `source_ip`/`source_port`
//     (Quelladresse) statt `interface_ip`/`multicast_ip`
//     (Empfangsschnittstelle), zusätzlich `fec_type`/`fec_block_width`/
//     `fec_block_height`/`fec1D_source_port`/`fec2D_source_port`/
//     `rtcp_source_port`, die receiver_transport_params_rtp.json nicht
//     kennt — ein Receiver-Feld hier wäre wegen
//     `additionalProperties: false` ein echter Validierungsfehler.
package connection

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"sync"
	"time"
)

// SenderResource ist die staged/active-Repräsentation eines Senders
// (sender-stage-schema.json / sender-response-schema.json).
type SenderResource struct {
	ReceiverID      *string          `json:"receiver_id"`
	MasterEnable    bool             `json:"master_enable"`
	Activation      Activation       `json:"activation"`
	TransportParams []map[string]any `json:"transport_params"`
}

// senderDefaultTransportParamsLeg spiegelt
// examples/sender-get-200-uninit.json (AMWA-TV/is-05 v1.1.2) wortgleich:
// alle "auto"-fähigen Felder auf "auto", `fec_type`/`fec_mode`/
// `fec_block_width`/`fec_block_height` auf ihre dort gezeigten festen
// Defaults (nicht "auto"-fähig laut Schema), `rtp_enabled: true`,
// `fec_enabled`/`rtcp_enabled: false`.
func senderDefaultTransportParamsLeg() map[string]any {
	return map[string]any{
		"source_ip":              "auto",
		"destination_ip":         "auto",
		"source_port":            "auto",
		"destination_port":       "auto",
		"fec_enabled":            false,
		"fec_destination_ip":     "auto",
		"fec_type":               "XOR",
		"fec_mode":               "1D",
		"fec_block_width":        4,
		"fec_block_height":       4,
		"fec1D_destination_port": "auto",
		"fec2D_destination_port": "auto",
		"fec1D_source_port":      "auto",
		"fec2D_source_port":      "auto",
		"rtcp_enabled":           false,
		"rtcp_destination_ip":    "auto",
		"rtcp_destination_port":  "auto",
		"rtcp_source_port":       "auto",
		"rtp_enabled":            true,
	}
}

func defaultSenderResource() SenderResource {
	return SenderResource{
		TransportParams: []map[string]any{senderDefaultTransportParamsLeg()},
	}
}

// SenderConstraints ist die IS-05-`constraints/`-Antwort für Sender:
// dieselbe "jedes Feld auf `{}` (=unconstrained)"-Konvention wie
// [Constraints] (Receiver), aber mit der Sender-Feldmenge — Feldliste
// exakt aus examples/sender-constraints-get-200.json übernommen (19
// Felder, KEIN `interface_ip`/`multicast_ip`, die dort nicht auftauchen,
// obwohl die generische Registry-Schema-Datei sie permissiv erlaubt).
func SenderConstraints() []map[string]any {
	return []map[string]any{{
		"source_ip":              map[string]any{},
		"destination_ip":         map[string]any{},
		"source_port":            map[string]any{},
		"destination_port":       map[string]any{},
		"fec_enabled":            map[string]any{},
		"fec_destination_ip":     map[string]any{},
		"fec_type":               map[string]any{},
		"fec_mode":               map[string]any{},
		"fec_block_width":        map[string]any{},
		"fec_block_height":       map[string]any{},
		"fec1D_destination_port": map[string]any{},
		"fec2D_destination_port": map[string]any{},
		"fec1D_source_port":      map[string]any{},
		"fec2D_source_port":      map[string]any{},
		"rtcp_enabled":           map[string]any{},
		"rtcp_destination_ip":    map[string]any{},
		"rtcp_destination_port":  map[string]any{},
		"rtcp_source_port":       map[string]any{},
		"rtp_enabled":            map[string]any{},
	}}
}

// senderPatchableFields — sender-stage-schema.json: additionalProperties:
// false, dieselbe Validierung wie [patchableFields] für Receiver.
var senderPatchableFields = map[string]bool{
	"receiver_id":      true,
	"master_enable":    true,
	"activation":       true,
	"transport_params": true,
}

// OptionalReceiverID unterscheidet "receiver_id nicht angegeben" von
// "explizit auf null gesetzt" (Unicast-Ziel trennen) — Pendant zu
// [OptionalSenderID] auf der Receiver-Seite, gleiche Begründung.
type OptionalReceiverID struct {
	Set   bool
	Value *string
}

func (o *OptionalReceiverID) UnmarshalJSON(data []byte) error {
	o.Set = true
	return json.Unmarshal(data, &o.Value)
}

// SenderPatchRequest ist der von PATCH .../senders/{id}/staged akzeptierte
// Body — echte Teil-Update-Semantik wie [PatchRequest] für Receiver.
type SenderPatchRequest struct {
	ReceiverID      OptionalReceiverID `json:"receiver_id"`
	MasterEnable    *bool              `json:"master_enable"`
	Activation      *Activation        `json:"activation"`
	TransportParams []map[string]any   `json:"transport_params"`
}

// resolveSenderAutoValues — Pendant zu [resolveAutoValues] für die
// Sender-Feldmenge. `source_ip`/`destination_ip` fallen beide auf
// Loopback zurück (Mock-Node ohne echte Netzwerkschnittstelle, gleiche
// Begründung wie bei `interface_ip` auf der Receiver-Seite).
// `fec_destination_ip`/`rtcp_destination_ip` lösen laut Schema-Text
// ("auto = destination_ip by default" bzw. "same as RTP destination_ip")
// zu `destination_ip` auf — NICHT zu `source_ip`, obwohl das AMWA-
// Referenzbeispiel (`sender-active-get-uninit.json`) an dieser Stelle
// zufällig denselben Wert wie `source_ip` zeigt (dort sind beide
// IPs unterschiedliche Werte, `fec_destination_ip` matcht `source_ip`,
// nicht `destination_ip` — vermutlich eine Inkonsistenz im Beispiel
// selbst; der Schema-FLIESSTEXT ist hier die verlässlichere Quelle).
// `fec1D`/`fec2D`-Portoffsets (+2/+4) UND die analogen `*_source_port`-
// Felder folgen derselben RTP/RTCP/FEC-Konvention wie beim Receiver,
// nur bezogen auf `source_port` statt `destination_port` für die
// Source-Varianten (Schema-Text: "auto = RTP source_port + 2/+4").
func resolveSenderAutoValues(leg map[string]any) map[string]any {
	resolved := make(map[string]any, len(leg))
	for k, v := range leg {
		resolved[k] = v
	}

	isAuto := func(v any) bool {
		s, ok := v.(string)
		return ok && s == "auto"
	}

	if isAuto(resolved["source_ip"]) {
		resolved["source_ip"] = "127.0.0.1"
	}
	if isAuto(resolved["destination_ip"]) {
		resolved["destination_ip"] = "127.0.0.1"
	}

	sourcePort := 5004
	if v, ok := resolved["source_port"]; ok {
		if isAuto(v) {
			resolved["source_port"] = sourcePort
		} else if n, ok := toInt(v); ok {
			sourcePort = n
		}
	}
	destPort := 5004
	if v, ok := resolved["destination_port"]; ok {
		if isAuto(v) {
			resolved["destination_port"] = destPort
		} else if n, ok := toInt(v); ok {
			destPort = n
		}
	}

	destIP, _ := resolved["destination_ip"].(string)
	if isAuto(resolved["fec_destination_ip"]) {
		resolved["fec_destination_ip"] = destIP
	}
	if isAuto(resolved["rtcp_destination_ip"]) {
		resolved["rtcp_destination_ip"] = destIP
	}
	if isAuto(resolved["fec1D_destination_port"]) {
		resolved["fec1D_destination_port"] = destPort + 2
	}
	if isAuto(resolved["fec2D_destination_port"]) {
		resolved["fec2D_destination_port"] = destPort + 4
	}
	if isAuto(resolved["rtcp_destination_port"]) {
		resolved["rtcp_destination_port"] = destPort + 1
	}
	if isAuto(resolved["fec1D_source_port"]) {
		resolved["fec1D_source_port"] = sourcePort + 2
	}
	if isAuto(resolved["fec2D_source_port"]) {
		resolved["fec2D_source_port"] = sourcePort + 4
	}
	if isAuto(resolved["rtcp_source_port"]) {
		resolved["rtcp_source_port"] = sourcePort + 1
	}
	return resolved
}

// senderSDP baut die `.../transportfile`-Antwort aus einem aufgelösten
// (nicht "auto") Transport-Parameter-Leg — ST 2110-20-konform, geprüft
// gegen AMWA-TV/nmos-testing `test_data/sdp/video.sdp` (die Referenz-
// SDP-Vorlage, die der echte SDPoker-Validator des AMWA-Testing-Tools
// gegenprüft) statt geraten. Live an AMWA-`test_41`/`test_09_01`/
// `test_25`/`test_27`/`test_29` gefunden (Nachtrag 194): eine frühere,
// minimale Fassung ohne `a=fmtp`/`a=mediaclk`/`a=ts-refclk` und mit
// Taktrate = Framerate statt der von RFC 4175/ST 2110-20 verlangten
// 90000 Hz erzeugte 13 SDPoker-Fehler UND ließ
// `IS05Utils.check_sdp_matches_params` mit einer unbehandelten
// Python-Exception abstürzen (Regex auf ein nicht vorhandenes
// `fmtp`-Feld). Feste Platzhalter-Bildmaße (640×480, wie
// `nodes/omp-mediaio/src/rtp.rs WIDTH/HEIGHT`) — der Mock-Node hat kein
// echtes Bildformat.
func senderSDP(leg map[string]any) string {
	host, _ := leg["destination_ip"].(string)
	if host == "" {
		host = "127.0.0.1"
	}
	port := 5004
	if n, ok := toInt(leg["destination_port"]); ok {
		port = n
	}
	return fmt.Sprintf(
		"v=0\r\n"+
			"o=- 0 0 IN IP4 %s\r\n"+
			"s=OpenMediaPlatform Mock Sender\r\n"+
			"c=IN IP4 %s\r\n"+
			"t=0 0\r\n"+
			"m=video %d RTP/AVP 96\r\n"+
			"a=ts-refclk:ptp=IEEE1588-2008:EC-46-70-FF-FE-00-CE-DE:0\r\n"+
			"a=mediaclk:direct=0\r\n"+
			"a=rtpmap:96 raw/90000\r\n"+
			"a=fmtp:96 sampling=YCbCr-4:2:2; width=640; height=480; depth=8; "+
			"SSN=ST2110-20:2017; colorimetry=BT709; PM=2110GPM; TP=2110TPN; "+
			"TCS=SDR; exactframerate=25\r\n",
		host, host, port,
	)
}

// SenderStore hält staged/active-Zustand für eine feste Menge von
// Sender-IDs — Pendant zu [ReceiverStore], gleiche Nebenläufigkeits-/
// Aktivierungs-Semantik (Activate-Lifecycle ist rollenunabhängig).
type SenderStore struct {
	mu                sync.RWMutex
	staged            map[string]SenderResource
	active            map[string]SenderResource
	pendingActivation map[string]*time.Timer
}

// NewSenderStore erstellt einen Store mit unverbundenen Sendern.
func NewSenderStore(senderIDs []string) *SenderStore {
	s := &SenderStore{
		staged:            make(map[string]SenderResource, len(senderIDs)),
		active:            make(map[string]SenderResource, len(senderIDs)),
		pendingActivation: make(map[string]*time.Timer, len(senderIDs)),
	}
	for _, id := range senderIDs {
		s.staged[id] = defaultSenderResource()

		activeDefault := defaultSenderResource()
		activeDefault.MasterEnable = true // examples/sender-active-get-uninit.json
		activeDefault.TransportParams = []map[string]any{resolveSenderAutoValues(activeDefault.TransportParams[0])}
		s.active[id] = activeDefault
	}
	return s
}

func (s *SenderStore) Staged(id string) (SenderResource, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.staged[id]
	return r, ok
}

func (s *SenderStore) Active(id string) (SenderResource, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.active[id]
	return r, ok
}

func (s *SenderStore) Exists(id string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.staged[id]
	return ok
}

// IDs liefert alle bekannten Sender-IDs (für `GET .../single/senders/`),
// sortiert für ein deterministisches Discovery-Ergebnis.
func (s *SenderStore) IDs() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ids := make([]string, 0, len(s.staged))
	for id := range s.staged {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// TransportFile liefert die aufgelöste SDP für `.../transportfile` — immer
// verfügbar (kein 404-Fall, s. Moduldoku), da der Mock-Node keine echte
// Medien-Abhängigkeit hat, die eine SDP verweigern könnte.
func (s *SenderStore) TransportFile(id string) (string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.active[id]
	if !ok || len(r.TransportParams) == 0 {
		return "", false
	}
	return senderSDP(r.TransportParams[0]), true
}

func (s *SenderStore) activateLocked(id string, mode, requestedTime *string) {
	current, ok := s.staged[id]
	if !ok {
		return
	}

	now := nowTimestamp()
	activated := current
	if len(activated.TransportParams) > 0 {
		activated.TransportParams = []map[string]any{resolveSenderAutoValues(activated.TransportParams[0])}
	}
	activated.Activation = Activation{Mode: mode, RequestedTime: requestedTime, ActivationTime: &now}
	s.active[id] = activated

	current.Activation = Activation{}
	s.staged[id] = current
}

// scheduleActivation — identische Semantik zu [ReceiverStore.scheduleActivation]
// (s. dort für die ausführliche TAI/UTC-Begründung), nur auf `SenderStore`
// umgehängt, da der Timer/State-Typ unterschiedlich ist.
func (s *SenderStore) scheduleActivation(id string, mode string, requestedTime *string) (activationTime string, ok bool) {
	if requestedTime == nil {
		return "", false
	}
	sec, nsec, err := parseTaiTimestamp(*requestedTime)
	if err != nil {
		return "", false
	}

	var delay time.Duration
	var target time.Time
	switch mode {
	case "activate_scheduled_relative":
		delay = time.Duration(sec)*time.Second + time.Duration(nsec)*time.Nanosecond
		target = time.Now().Add(delay)
	case "activate_scheduled_absolute":
		target = time.Unix(sec-taiUtcOffsetSeconds, nsec)
		delay = time.Until(target)
		if delay < 0 {
			delay = 0
		}
	default:
		return "", false
	}

	if t, ok := s.pendingActivation[id]; ok {
		t.Stop()
	}
	modeCopy, timeCopy := mode, *requestedTime
	s.pendingActivation[id] = time.AfterFunc(delay, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		delete(s.pendingActivation, id)
		s.activateLocked(id, &modeCopy, &timeCopy)
	})
	return fmt.Sprintf("%d:%d", target.Unix(), target.Nanosecond()), true
}

// PatchStaged — identische Aktivierungs-Lebenszyklus-Semantik wie
// [ReceiverStore.PatchStaged] (s. dort für die ausführliche Begründung
// zu activate_immediate/scheduled_*), auf die Sender-Feldmenge
// (`receiver_id` statt `sender_id`) übertragen.
func (s *SenderStore) PatchStaged(id string, req SenderPatchRequest) (SenderResource, int, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	existing, ok := s.staged[id]
	if !ok {
		return SenderResource{}, 0, false
	}

	updated := existing
	if req.ReceiverID.Set {
		updated.ReceiverID = req.ReceiverID.Value
	}
	if req.MasterEnable != nil {
		updated.MasterEnable = *req.MasterEnable
	}
	if len(req.TransportParams) > 0 && len(updated.TransportParams) > 0 {
		merged := make(map[string]any, len(updated.TransportParams[0]))
		for k, v := range updated.TransportParams[0] {
			merged[k] = v
		}
		for k, v := range req.TransportParams[0] {
			merged[k] = v
		}
		updated.TransportParams = []map[string]any{merged}
	}
	s.staged[id] = updated

	status := http.StatusOK
	response := updated
	if req.Activation != nil {
		response.Activation = *req.Activation

		mode := req.Activation.Mode
		switch {
		case mode != nil && *mode == "activate_immediate":
			s.activateLocked(id, mode, req.Activation.RequestedTime)
			response.Activation = Activation{Mode: mode, RequestedTime: req.Activation.RequestedTime}
			if activated, ok := s.active[id]; ok {
				response.Activation.ActivationTime = activated.Activation.ActivationTime
			}
		case mode != nil && (*mode == "activate_scheduled_relative" || *mode == "activate_scheduled_absolute"):
			scheduledActivation := *req.Activation
			if activationTime, ok := s.scheduleActivation(id, *mode, req.Activation.RequestedTime); ok {
				status = http.StatusAccepted
				scheduledActivation.ActivationTime = &activationTime
			}
			updated.Activation = scheduledActivation
			s.staged[id] = updated
			response.Activation = scheduledActivation
		default:
			updated.Activation = *req.Activation
			s.staged[id] = updated
		}
	}

	return response, status, true
}

// parseSenderPatchRequest — Pendant zu [parsePatchRequest] (Receiver),
// gegen [senderPatchableFields] statt [patchableFields] validiert.
func parseSenderPatchRequest(body []byte) (SenderPatchRequest, error) {
	var rawFields map[string]json.RawMessage
	if err := json.Unmarshal(body, &rawFields); err != nil {
		return SenderPatchRequest{}, fmt.Errorf("invalid JSON body")
	}
	for field := range rawFields {
		if !senderPatchableFields[field] {
			return SenderPatchRequest{}, fmt.Errorf("unknown field: %s", field)
		}
	}

	var req SenderPatchRequest
	if err := json.Unmarshal(body, &req); err != nil {
		return SenderPatchRequest{}, fmt.Errorf("invalid JSON body")
	}
	return req, nil
}
