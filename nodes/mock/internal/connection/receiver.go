// Package connection implementiert einen minimalen IS-05-Connection-API-
// Endpunkt für die Receiver des Mock-Nodes (staged/active) — Grundlage
// für das IS-05-PATCH aus Schritt B1 (UMSETZUNG.md). Feldnamen geprüft
// gegen AMWA-TV/is-05 (Branch v1.1.x, APIs/schemas/receiver-*.json,
// activation-schema.json). Sender-seitige Connection-Endpoints bleiben
// bewusst unimplementiert (der Mock-Node ist rein Receiver-seitig, siehe
// docs/decisions.md) — die Basis-Discovery-Subresourcen (Wurzel-Listing,
// constraints/, transporttype/) sind seit UMSETZUNG.md D9 implementiert
// (vorher für B1 nicht nötig), Feldnamen/Pfade gegen AMWA-TV/is-05
// v1.1.x geprüft (APIs/ConnectionAPI.raml, APIs/schemas/receiver-
// constraints-schema.json über constraints-schema-rtp.json).
package connection

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"sync"
	"time"
)

// nowTimestamp liefert einen für `activation_time` gültigen Wert
// (Pattern "^[0-9]+:[0-9]+$", dieselbe Konvention wie `is04.nowVersion`)
// — keine exakte TAI-Zeit nötig (gleiche Begründung wie dort).
func nowTimestamp() string {
	now := time.Now()
	return fmt.Sprintf("%d:%d", now.Unix(), now.Nanosecond())
}

// TransportType ist die IS-05-`transporttype/`-Antwort für jeden Receiver
// des Mock-Nodes — RTP, wie auch dessen IS-04-Registrierung
// (nodes/mock/internal/is04/resources.go transportRTP; eigene Kopie hier,
// da beide Pakete keine gemeinsame Konstantenquelle teilen, gleiches
// bewusste Duplikations-Muster wie im Rust-SDK-Pendant).
const TransportType = "urn:x-nmos:transport:rtp"

// Constraints ist die IS-05-`constraints/`-Antwort: ein Element pro Leg
// (der Mock-Node kennt keine 2022-7-Redundanz, also genau eines), jedes
// Transport-Parameter-Feld auf `{}` (= unconstrained) — der Mock-Node
// akzeptiert für `transport_params` jeden Wert (PatchRequest übernimmt
// dieses Feld ohnehin nicht, s. u.). Feldnamen exakt aus dem AMWA-Beispiel
// `receiver-constraints-get-200.json` (RTP-Leg) übernommen.
func Constraints() []map[string]any {
	return []map[string]any{{
		"source_ip":              map[string]any{},
		"multicast_ip":           map[string]any{},
		"interface_ip":           map[string]any{},
		"destination_port":       map[string]any{},
		"fec_enabled":            map[string]any{},
		"fec_destination_ip":     map[string]any{},
		"fec_mode":               map[string]any{},
		"fec1D_destination_port": map[string]any{},
		"fec2D_destination_port": map[string]any{},
		"rtcp_enabled":           map[string]any{},
		"rtcp_destination_ip":    map[string]any{},
		"rtcp_destination_port":  map[string]any{},
		"rtp_enabled":            map[string]any{},
	}}
}

// Activation beschreibt, wann eine gestagte Änderung aktiv wird.
// `ActivationTime` fehlte bis UMSETZUNG.md D11 komplett — live an
// AMWA-`test_18` gefunden (docs/decisions.md): das echte
// `activation-schema.json` verlangt alle drei Felder als `required`
// (auch wenn `null`), nicht nur `mode`/`requested_time`.
type Activation struct {
	Mode           *string `json:"mode"`
	RequestedTime  *string `json:"requested_time"`
	ActivationTime *string `json:"activation_time"`
}

// TransportFile ist Teil des vollständigen IS-05-Receiver-Resource;
// der Mock-Node routet keine echten Transport-Files, daher immer null/null.
type TransportFile struct {
	Data *string `json:"data"`
	Type *string `json:"type"`
}

// ReceiverResource ist die staged/active-Repräsentation eines Receivers
// (receiver-stage-schema.json / receiver-response-schema.json).
type ReceiverResource struct {
	SenderID        *string          `json:"sender_id"`
	MasterEnable    bool             `json:"master_enable"`
	Activation      Activation       `json:"activation"`
	TransportFile   TransportFile    `json:"transport_file"`
	TransportParams []map[string]any `json:"transport_params"`
}

// defaultTransportParamsLeg spiegelt das AMWA-Referenzbeispiel
// `receiver-get-200-uninit.json` (v1.1.x) wortgleich — live an
// AMWA-`test_10`/`test_14`/`test_32` gefunden (docs/decisions.md): ein
// leeres `{}` statt dieser vollständigen Feldliste ließ Schema-
// Validierung/Constraints-Abgleich fehlschlagen, weil das reale Schema
// alle Felder als vorhanden (ggf. `null`) erwartet, nicht nur die
// tatsächlich gesetzten.
func defaultTransportParamsLeg() map[string]any {
	return map[string]any{
		"source_ip":              nil,
		"multicast_ip":           nil,
		"interface_ip":           "auto",
		"destination_port":       "auto",
		"fec_enabled":            false,
		"fec_destination_ip":     "auto",
		"fec_mode":               "1D",
		"fec1D_destination_port": "auto",
		"fec2D_destination_port": "auto",
		"rtcp_enabled":           false,
		"rtcp_destination_ip":    "auto",
		"rtcp_destination_port":  "auto",
		"rtp_enabled":            true,
	}
}

func defaultResource() ReceiverResource {
	return ReceiverResource{
		TransportFile:   TransportFile{},
		TransportParams: []map[string]any{defaultTransportParamsLeg()},
	}
}

// patchableFields sind die einzigen laut `receiver-stage-schema.json`
// gültigen Top-Level-Felder eines PATCH-Bodys — jeder andere Schlüssel
// muss laut Schema (`additionalProperties: false`) mit 400 abgelehnt
// werden. Live an AMWA-`test_20` gefunden (docs/decisions.md): ein
// Body wie `{"bad":"data"}` dekodierte bisher klaglos in eine leere
// `PatchRequest` (Go ignoriert unbekannte JSON-Felder standardmäßig)
// und lieferte 200 statt der geforderten 400.
var patchableFields = map[string]bool{
	"sender_id":        true,
	"master_enable":    true,
	"activation":       true,
	"transport_params": true,
}

// OptionalSenderID unterscheidet "sender_id im Body nicht angegeben"
// (Feld bleibt unverändert) von "sender_id explizit auf null gesetzt"
// (Trennen — ein legitimer, häufiger Wert: das Orchestrator-Proxy-
// PATCH für "keine Quelle mehr" schickt genau das). Ein einfaches
// `*string`-Feld kann diese beiden Fälle NICHT unterscheiden (Go
// dekodiert sowohl ein fehlendes Feld als auch `"sender_id": null` zum
// selben nil-Pointer) — echter, live gefundener Bug: die naive
// `*string`-Fassung hätte jedes Disconnect-PATCH stillschweigend
// ignoriert (docs/decisions.md).
type OptionalSenderID struct {
	Set   bool
	Value *string
}

// UnmarshalJSON wird von `encoding/json` NUR aufgerufen, wenn der
// Schlüssel im Body tatsächlich vorkommt — das ist der Mechanismus,
// über den `Set` Anwesenheit erkennt (kein manuelles Nachschlagen im
// rohen JSON nötig für dieses eine Feld).
func (o *OptionalSenderID) UnmarshalJSON(data []byte) error {
	o.Set = true
	return json.Unmarshal(data, &o.Value)
}

// PatchRequest ist der von PATCH .../staged akzeptierte Body — echte
// Teil-Update-Semantik (jedes Feld optional, nur explizit angegebene
// Felder werden geändert), wie es der volle IS-05-Standard verlangt.
type PatchRequest struct {
	SenderID        OptionalSenderID `json:"sender_id"`
	MasterEnable    *bool            `json:"master_enable"`
	Activation      *Activation      `json:"activation"`
	TransportParams []map[string]any `json:"transport_params"`
}

// resolveAutoValues ersetzt "auto"-Platzhalter durch konkrete Werte —
// NUR beim Schreiben nach `active` (`staged` darf "auto" weiterhin
// zeigen, das ist der angeforderte, noch nicht aufgelöste Wert). Live
// an AMWA-`test_12_01`/`test_12_02` gefunden (docs/decisions.md):
// "auto" ist laut Spec ein reiner Anfrage-Platzhalter ("der Server
// wählt"), kein gültiger Zustand für eine tatsächlich aktive
// Verbindung — jedes im Response-Body verbleibende "auto" gilt als
// Fehler. `destination_port`s Default (5004) steht wortgleich im
// AMWA-Schema (`receiver_transport_params_rtp.json`); die übrigen
// Portwerte folgen der Standard-RTP/RTCP-Konvention (RTCP = RTP-Port+1,
// FEC-Spalten/-Zeilen +2/+4 — RFC 3550/SMPTE-2022-5-Konvention, nicht
// erfunden). `interface_ip`/`*_destination_ip` fallen auf Loopback
// zurück, da dieser Mock-Node an keine echte Netzwerkschnittstelle
// gebunden ist (ehrlicher Platzhalter für eine Umgebung ohne echtes
// 2110-Netz, kein Vorspiegeln einer realen Adresse).
func resolveAutoValues(leg map[string]any) map[string]any {
	resolved := make(map[string]any, len(leg))
	for k, v := range leg {
		resolved[k] = v
	}

	isAuto := func(v any) bool {
		s, ok := v.(string)
		return ok && s == "auto"
	}

	port := 5004
	if v, ok := resolved["destination_port"]; ok {
		if isAuto(v) {
			resolved["destination_port"] = port
		} else if n, ok := toInt(v); ok {
			port = n
		}
	}
	if isAuto(resolved["interface_ip"]) {
		resolved["interface_ip"] = "127.0.0.1"
	}
	// `fec_mode` fehlte hier bis zum zweiten AMWA-Lauf (live an
	// `test_12_02` gefunden, docs/decisions.md): `generate_mxl_flow_ids`
	// re. `fecAutoParams` in `IS05Utils.py` PATCHt auch dieses Feld auf
	// "auto" — derselbe Default wie `defaultTransportParamsLeg` ("1D").
	if isAuto(resolved["fec_mode"]) {
		resolved["fec_mode"] = "1D"
	}
	ip, _ := resolved["interface_ip"].(string)
	if isAuto(resolved["fec_destination_ip"]) {
		resolved["fec_destination_ip"] = ip
	}
	if isAuto(resolved["fec1D_destination_port"]) {
		resolved["fec1D_destination_port"] = port + 2
	}
	if isAuto(resolved["fec2D_destination_port"]) {
		resolved["fec2D_destination_port"] = port + 4
	}
	if isAuto(resolved["rtcp_destination_ip"]) {
		resolved["rtcp_destination_ip"] = ip
	}
	if isAuto(resolved["rtcp_destination_port"]) {
		resolved["rtcp_destination_port"] = port + 1
	}
	return resolved
}

// toInt liest destination_port unabhängig davon, ob es als JSON-Zahl
// (float64 nach `encoding/json`-Dekodierung) oder als String ankam
// (`receiver_transport_params_rtp.json` erlaubt laut Schema beides:
// `"type": ["integer", "string"]`).
func toInt(v any) (int, bool) {
	switch n := v.(type) {
	case float64:
		return int(n), true
	case int:
		return n, true
	case string:
		var i int
		if _, err := fmt.Sscanf(n, "%d", &i); err == nil {
			return i, true
		}
	}
	return 0, false
}

// parseTaiTimestamp parst "seconds:nanoseconds" (dieselbe Konvention
// wie `nowTimestamp`) zu einem `time.Time` — für
// `activate_scheduled_absolute` als absoluter Zeitpunkt, für
// `activate_scheduled_relative` als Offset ab jetzt (Aufrufer
// entscheidet die Interpretation, s. `scheduleActivation`).
func parseTaiTimestamp(s string) (sec int64, nsec int64, err error) {
	_, err = fmt.Sscanf(s, "%d:%d", &sec, &nsec)
	return sec, nsec, err
}

// taiUtcOffsetSeconds ist die aktuelle Differenz zwischen TAI und UTC
// (37 Schaltsekunden, unverändert seit 1. Januar 2017 laut IERS-
// Bulletins) — nur relevant, um einen vom Client gesendeten ABSOLUTEN
// `requested_time` (echte TAI, s. `scheduleActivation`) auf `time.Time`
// (UTC-basiert, `time.Unix`) zurückzurechnen. `nowTimestamp`/
// `activation_time`-Ausgabe bleiben bewusst UTC≈TAI (keine exakte
// TAI-Ausgabe nötig, gleiche Begründung wie `is04.nowVersion` — das
// AMWA-Tool prüft dort nur das Format, nicht den exakten Wert).
const taiUtcOffsetSeconds = 37

// ReceiverStore hält staged/active-Zustand für eine feste Menge von
// Receiver-IDs, nebenläufig sicher nutzbar.
type ReceiverStore struct {
	mu     sync.RWMutex
	staged map[string]ReceiverResource
	active map[string]ReceiverResource
	// pendingActivation hält den Timer einer noch nicht ausgeführten
	// `activate_scheduled_relative`/`_absolute`-Aktivierung je Receiver
	// (UMSETZUNG.md D11, live an AMWA-`test_28`/`test_30` gefunden:
	// echte zeitgesteuerte Aktivierung statt eines nur akzeptierten,
	// nie ausgeführten PATCHes). Ein erneutes PATCH auf denselben
	// Receiver storniert einen noch ausstehenden Timer, bevor ggf. ein
	// neuer gesetzt wird — genau eine Aktivierung darf je Receiver
	// jeweils ausstehen.
	pendingActivation map[string]*time.Timer
}

// NewReceiverStore erstellt einen Store mit unverbundenen Receivern.
func NewReceiverStore(receiverIDs []string) *ReceiverStore {
	s := &ReceiverStore{
		staged:            make(map[string]ReceiverResource, len(receiverIDs)),
		active:            make(map[string]ReceiverResource, len(receiverIDs)),
		pendingActivation: make(map[string]*time.Timer, len(receiverIDs)),
	}
	for _, id := range receiverIDs {
		s.staged[id] = defaultResource()

		// `active`s uninitialisierter Default zeigt bereits konkret
		// aufgelöste Werte, KEIN "auto" — live an AMWA-`test_12_01`
		// gefunden (docs/decisions.md): das AMWA-Referenzbeispiel
		// `receiver-active-get-200-uninit.json` bestätigt exakt die
		// hier verwendeten Konventionen (destination_port 5004,
		// rtcp_destination_port 5005 = Port+1, fec1D/2D +2/+4) — kein
		// Raten, direkt gegengeprüft.
		activeDefault := defaultResource()
		activeDefault.TransportParams = []map[string]any{resolveAutoValues(activeDefault.TransportParams[0])}
		s.active[id] = activeDefault
	}
	return s
}

// Staged liefert den aktuellen staged-Zustand eines Receivers.
func (s *ReceiverStore) Staged(id string) (ReceiverResource, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.staged[id]
	return r, ok
}

// Active liefert den aktuellen active-Zustand eines Receivers.
func (s *ReceiverStore) Active(id string) (ReceiverResource, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.active[id]
	return r, ok
}

// Exists meldet, ob id ein bekannter Receiver ist (für die
// Basis-Discovery-Endpunkte: Wurzel-Listing/constraints/transporttype
// brauchen keinen staged/active-Zustand, nur die Existenzprüfung).
func (s *ReceiverStore) Exists(id string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.staged[id]
	return ok
}

// IDs liefert alle bekannten Receiver-IDs (für
// `GET .../single/receivers/`), sortiert für ein deterministisches
// Discovery-Ergebnis.
func (s *ReceiverStore) IDs() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ids := make([]string, 0, len(s.staged))
	for id := range s.staged {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// activateLocked schreibt das aktuell in `staged[id]` liegende Resource
// (mit aufgelösten "auto"-Werten, s. `resolveAutoValues`) nach
// `active[id]` und setzt `staged[id]`s Activation danach zurück —
// gemeinsame Logik für sowohl sofortige als auch (beim Timer-Ablauf)
// zeitgesteuerte Aktivierung. Erwartet `s.mu` bereits gehalten.
func (s *ReceiverStore) activateLocked(id string, mode, requestedTime *string) {
	current, ok := s.staged[id]
	if !ok {
		return
	}

	now := nowTimestamp()
	activated := current
	if len(activated.TransportParams) > 0 {
		activated.TransportParams = []map[string]any{resolveAutoValues(activated.TransportParams[0])}
	}
	activated.Activation = Activation{Mode: mode, RequestedTime: requestedTime, ActivationTime: &now}
	s.active[id] = activated

	current.Activation = Activation{}
	s.staged[id] = current
}

// scheduleActivation parst `requestedTime` gemäß `mode` und plant
// `activateLocked` per `time.AfterFunc` ein. Liefert zusätzlich den
// bereits jetzt berechneten absoluten Ziel-Zeitpunkt als
// `activation_time` — live an AMWA-`test_28`/`test_30` gefunden
// (docs/decisions.md): der Schema-Text sagt für geplante Aktivierungen
// ausdrücklich "will ... activate" (nicht nur "did"), das Feld muss
// also SOFORT in der PATCH-Antwort einen echten Zeitstempel zeigen,
// nicht erst wenn der Timer tatsächlich feuert. `ok=false` bei einem
// nicht parsbaren `requestedTime` (Aufrufer behandelt das wie "keine
// Aktivierung geplant", kein 500). Erwartet `s.mu` bereits gehalten
// (der Timer selbst holt sich beim Auslösen sein eigenes Lock, s.
// `activateLocked`-Aufruf unten).
func (s *ReceiverStore) scheduleActivation(id string, mode string, requestedTime *string) (activationTime string, ok bool) {
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
		// `requested_time` ist laut Spec eine ECHTE TAI-Zeit, nicht Unix/
		// UTC — live an AMWA-`test_30` gefunden (docs/decisions.md):
		// `NMOSUtils.get_TAI_time` (AMWA-TV/nmos-testing) addiert die
		// Schaltsekunden-Differenz (aktuell 37s, Stand der dortigen
		// `UTC_LEAP`-Tabelle seit 2017 unverändert) auf die UTC-Zeit.
		// Ohne den Abzug hier feuerte die Aktivierung ~37s zu spät — der
		// Test wartet nur `maxTries=3`-mal einen kurzen, festen Timeout
		// (deutlich unter 37s), sah die Änderung nie rechtzeitig.
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

// PatchStaged wendet req als ECHTES Teil-Update auf den staged-Zustand
// von id an (nur angegebene Felder ändern sich, s. `PatchRequest`-Doku)
// und mischt einen angegebenen `transport_params`-Leg in das bestehende
// Leg statt es zu ersetzen (nur die im Request enthaltenen Schlüssel
// überschreiben, andere bleiben erhalten — live an AMWA-`test_24`/
// `test_26`/`test_28`/`test_30` gefunden: die vorherige Fassung kannte
// `transport_params` im PATCH-Body gar nicht).
//
// Aktivierungs-Lebenszyklus (`activation-schema.json`, live an
// AMWA-`test_18` gefunden, docs/decisions.md): bei
// `activation.mode == "activate_immediate"` zeigt NUR die
// PATCH-Antwort (der Rückgabewert dieser Funktion) `mode:
// "activate_immediate"` + ein echtes `activation_time` — der in
// `staged` PERSISTIERTE Zustand setzt beide sofort wieder auf `null`
// zurück (Schema-Text: "returns to null on the staged endpoint once an
// activation is completed"), während `active` die Aktivierungsdaten
// dauerhaft trägt (AMWA-Beispiel `receiver-active-get-200.json` zeigt
// `mode`/`activation_time` dort persistent, nicht zurückgesetzt).
// `activate_scheduled_relative`/`_absolute` (live an AMWA-`test_28`/
// `test_30` gefunden) plant eine ECHTE zeitgesteuerte Aktivierung
// (`scheduleActivation`) statt nur zu akzeptieren und nie auszuführen —
// liefert 202 statt 200, `staged` behält die geplante Activation
// sichtbar (kein Reset, sie ist ja noch nicht eingetreten).
//
// Liefert (Resource, HTTP-Status, false) mit Status 0, wenn id unbekannt
// ist — Aufrufer prüft den bool, nicht den Status, für den 404-Fall.
func (s *ReceiverStore) PatchStaged(id string, req PatchRequest) (ReceiverResource, int, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	existing, ok := s.staged[id]
	if !ok {
		return ReceiverResource{}, 0, false
	}

	updated := existing
	if req.SenderID.Set {
		updated.SenderID = req.SenderID.Value
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
			// Geplante Activation bleibt in `staged` sichtbar (kein
			// Reset — sie ist ja noch nicht eingetreten), unabhängig
			// davon, ob `scheduleActivation` einen Timer setzen
			// konnte (bei nicht-parsbarem `requested_time` bleibt sie
			// einfach für immer ausstehend statt mit 500 zu scheitern
			// — kein AMWA-Test verlangt aktuell strengere Validierung
			// hier, s. docs/decisions.md).
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
