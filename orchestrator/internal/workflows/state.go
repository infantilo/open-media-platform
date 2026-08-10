package workflows

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"reflect"
	"time"
)

// Bugfix 2026-07-26 (docs/decisions.md Nachtrag 91 Punkt 4): "beim
// Workflow-Start fehlt gespeicherter Node-Zustand (PST/PGM, DSK/PIP-
// Quelle)". Nutzerentscheidung: automatisch letzter Stand vor Stop/
// Pause, kein separat gepflegter "Startzustand". Nutzt den bereits
// vorhandenen, node-eigenen `GET`/`POST /state`-Mechanismus
// (`nodes/omp-video-mixer-me`, `nodes/omp-audio-mixer` — heute nur für
// manuelle Presets aufgerufen) — der Orchestrator kennt den Inhalt
// nicht, reicht ihn nur zwischen Erfassung und Wiederherstellung durch
// (`Store.SetRoleState`/`GetRoleState`, Migration 0011). Node-Typen
// ohne `/state` (die meisten) liefern 404 — best effort, kein
// Fehlerfall, keine Sonderbehandlung nötig.
//
// **Live gefundenes, zunächst übersehenes Problem:** ein `/state`-Blob
// referenziert andere Nodes über deren Sender-IDs (z. B.
// `programSenderId`) — diese IDs sind aber pro Prozessstart neu
// (`crate::idgen::new_v4()`, `nodes/omp-node-sdk/src/node.rs`) und
// daher über einen Workflow-Neustart hinweg (der ALLE Rollen neu
// startet) grundsätzlich nicht wiederverwendbar. Ein reines
// Get-dann-Post des rohen Blobs "funktioniert" (200 OK), setzt aber
// eine Sender-ID, die nach dem Neustart gar nicht mehr existiert —
// beim `programInput` sichtbar geworden: blieb leer statt der
// erwarteten Quelle, obwohl `POST /state` erfolgreich war.
// Lösung: Sender-IDs, die beim Erfassen zu einer **eigenen Rolle
// desselben Workflows** gehörten, werden vor dem Speichern durch einen
// stabilen Platzhalter `role:<rollenName>:sender:<index>` ersetzt (s.
// senderAliasPrefix) — `index` ist die Position in der Sender-Liste
// des jeweiligen Node-**Typs**, die für einen gegebenen Typ bei jedem
// Start in derselben Reihenfolge neu registriert wird (fester
// `SenderSpec`-Vektor je Node, live an zwei aufeinanderfolgenden
// Läufen verifiziert, nicht angenommen). Beim Wiederherstellen wird
// der Platzhalter mit der **aktuellen** Sender-ID derselben Rolle/
// Position aufgelöst. Sender-IDs außerhalb des eigenen Workflows
// (fremde Quellen) bleiben unverändert und damit nach einem Neustart
// zwangsläufig stale — dokumentierte Grenze, kein Bug: der Orchestrator
// kennt nur die Sender seiner eigenen Workflow-Rollen.
const senderAliasPrefix = "@@omp-role-sender:"

const roleStateTimeout = 3 * time.Second
const maxRoleStateBytes = 1 << 20 // 1 MiB — ein Bedienzustand ist ein paar hundert Bytes JSON, keine Mediendaten

// roleSeedEnvKey ist der ExtraEnv-Schlüssel, über den eine Workflow-Rolle
// omp-node-sdk (node::start) einen über einen Stop/Start-Zyklus stabilen
// Seed für node_id/device_id mitgibt (Bug 2026-08-10: "UIDs ändern sich
// beim Neustart"). Muss zusätzlich zur launcher-eigenen Env-Allowlist
// auch in host-agent/internal/commands/commands.go (allowedExtraEnvKeys)
// eingetragen sein, sonst lehnt ein Remote-Host den Start komplett ab.
const roleSeedEnvKey = "OMP_ROLE_SEED"

// withRoleSeed setzt roleSeedEnvKey deterministisch aus (Workflow-ID,
// Rollenname) — dieselbe Rolle desselben Workflows bekommt bei jedem aus
// runStart/runRestartRole gestarteten Prozess denselben Seed und damit
// dieselbe NMOS-Node-/Device-ID. Nur an Aufrufstellen verwenden, an
// denen eine eventuell noch laufende alte Instanz derselben Rolle
// garantiert bereits gestoppt ist, bevor die neue startet (runStart:
// erst nach vollständigem Stop erreichbar; runRestartRole: stoppt die
// alte Instanz explizit vor diesem Aufruf) — sonst liefen kurzzeitig
// zwei NMOS-Nodes mit identischer ID parallel. executeMigration
// (migration.go) startet bewusst NICHT so: dort läuft die alte Instanz
// während des Starts der neuen weiter (Live-Migration), deshalb dort
// kein withRoleSeed.
func withRoleSeed(env map[string]string, workflowID, roleName string) map[string]string {
	out := make(map[string]string, len(env)+1)
	for k, v := range env {
		out[k] = v
	}
	sum := sha256.Sum256([]byte(workflowID + "|" + roleName))
	out[roleSeedEnvKey] = hex.EncodeToString(sum[:])
	return out
}

// captureRoleState fragt vor dem Stoppen jeder Rolle ihren aktuellen
// Zustand ab und persistiert ihn — best effort, jeder einzelne
// Rollen-Fehler (Node antwortet nicht mehr, kein /state, Timeout)
// wird nur geloggt, bricht den eigentlichen Stop-Vorgang nie ab.
func (s *Service) captureRoleState(wf Workflow) {
	senderToAlias := s.buildSenderAliasIndex(wf)
	for role := range wf.Runtime {
		s.captureOneRoleState(wf, role, senderToAlias)
	}
}

// roleStateKindNode/roleStateKindParams unterscheiden, wie ein
// gespeicherter role_state-Eintrag wiederhergestellt werden muss — s.
// roleStateEnvelope.
const (
	roleStateKindNode   = "node-state"
	roleStateKindParams = "params"
)

// roleStateEnvelope ist die ab 2026-08-10 gespeicherte Hülle um einen
// role_state-Eintrag (Bug: "beim Stoppen/Neustarten eines Workflows
// verlieren viele Nodes ihre Einstellungen" — ursprünglich griff
// captureRoleState nur bei Nodes mit eigener `/state`-Route, s. Moduldoku
// oben; das sind bislang nur omp-video-mixer-me/omp-audio-mixer, alle
// anderen Node-Typen — z. B. omp-source mit seinem `pattern`-Parameter —
// lieferten 404 und wurden stillschweigend übersprungen). Kind
// "node-state": Blob ist die rohe `GET .../state`-Antwort (unverändertes
// Verhalten, Node hat Vorrang, s. captureOneRoleState). Kind "params":
// Params sind Name->Wert aller schreibbaren Parameter, generisch über
// descriptor.json + /params/<name> erfasst (dasselbe Muster wie das
// manuelle Szenen-Feature, `internal/snapshots`, dort aber nicht an den
// Workflow-Lifecycle gekoppelt) — Fallback für jeden Node-Typ ohne
// eigene `/state`-Route.
//
// Rückwärtskompatibel zu vor dieser Änderung gespeicherten Zeilen: eine
// alte Zeile ist direkt die `{"state": ...}`-GET-Antwort — hat also
// zufällig auch ein Top-Level-Feld "state", landet aber wegen des
// JSON-Tags "__blob" (nicht "state") NICHT in Blob, sondern lässt Kind
// und Blob leer. restoreOneRoleState behandelt Kind=="" als
// node-state-Fall und verwendet dann den kompletten (aliasaufgelösten)
// Rohwert statt Blob — exakt das alte Verhalten.
type roleStateEnvelope struct {
	Kind   string                     `json:"__kind,omitempty"`
	Blob   json.RawMessage            `json:"__blob,omitempty"`
	Params map[string]json.RawMessage `json:"__params,omitempty"`
}

// captureOneRoleState ist der pro-Rolle-Kern von captureRoleState,
// herausgelöst für K7 Teil 4 (failover.go): der Failover-Ticker ruft dies
// periodisch NUR für Primärrollen mit einer Standby-Rolle auf (kein
// unnötiger /state-Overhead für redundanzlose Rollen) — sonst gäbe es beim
// Host-Offline-Trigger keinen aktuellen Bedienzustand zum Übertragen, weil
// die tote Node dann nicht mehr befragbar ist. senderToAlias wird vom
// Aufrufer einmal pro Workflow gebaut (buildSenderAliasIndex braucht einen
// vollständigen Registry-Scan, nicht pro Rolle wiederholen).
func (s *Service) captureOneRoleState(wf Workflow, role string, senderToAlias map[string]string) {
	node, ok := s.nodeForRole(wf, role)
	if !ok || node.APIBaseURL == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), roleStateTimeout)
	defer cancel()

	var env roleStateEnvelope
	if blob, err := getNodeState(ctx, s.httpClient, node.APIBaseURL); err == nil {
		env = roleStateEnvelope{Kind: roleStateKindNode, Blob: blob}
	} else {
		// Kein /state (häufigster Fall, die meisten Node-Typen) oder
		// Node bereits nicht mehr erreichbar — beides erwartbar, keine
		// Warnung wert. Fallback: generische schreibbare Parameter
		// (deckt z. B. omp-source::pattern ab, das nie /state
		// implementiert hat).
		params, perr := captureGenericParams(ctx, s.httpClient, node.APIBaseURL)
		if perr != nil || len(params) == 0 {
			return
		}
		env = roleStateEnvelope{Kind: roleStateKindParams, Params: params}
	}

	raw, err := json.Marshal(env)
	if err != nil {
		slog.Warn("workflows: failed to marshal role state envelope", "workflow", wf.ID, "role", role, "error", err)
		return
	}
	state, err := aliasSenderIDs(raw, senderToAlias)
	if err != nil {
		slog.Warn("workflows: failed to alias role state", "workflow", wf.ID, "role", role, "error", err)
		return
	}
	if err := s.store.SetRoleState(wf.ID, role, state); err != nil {
		slog.Warn("workflows: failed to persist role state", "workflow", wf.ID, "role", role, "error", err)
	}
}

// captureGenericParams fragt den Descriptor eines Nodes nach seinen
// schreibbaren Parametern und liest jeden davon einzeln — dasselbe
// Muster wie snapshots.Service.Create für Nodes ohne eigene /state-Route
// (internal/snapshots/nodeclient.go), hier bewusst dupliziert statt
// importiert (gleicher Stil wie getNodeState/postNodeState oben: dieses
// Paket kennt den generischen HTTP-Node-Client aus internal/snapshots
// nicht, beide Pakete sprechen unabhängig denselben Standard-Node-
// Contract). Best effort: ein einzelner Parameter, der nicht gelesen
// werden kann, wird übersprungen statt den ganzen Capture-Versuch
// abzubrechen.
func captureGenericParams(ctx context.Context, client *http.Client, apiBaseURL string) (map[string]json.RawMessage, error) {
	names, err := getWritableParamNames(ctx, client, apiBaseURL)
	if err != nil {
		return nil, err
	}
	out := make(map[string]json.RawMessage, len(names))
	for _, name := range names {
		value, err := getParamValue(ctx, client, apiBaseURL, name)
		if err != nil {
			slog.Warn("workflows: failed to capture param", "node", apiBaseURL, "param", name, "error", err)
			continue
		}
		out[name] = value
	}
	return out, nil
}

// restoreStateRetries/restoreStateRetryDelay (live gefunden, s. u.):
// `POST /state` antwortet immer mit 200, auch wenn der Node intern eine
// enthaltene Sender-ID nicht anwenden konnte — `omp-video-mixer-me`s
// `restore_state` ruft für `programSenderId` `pipeline.take()` auf,
// das nur einen Befehl über einen Kanal an den separaten Pipeline-
// Thread schickt (fire-and-forget) und dort den Sender selbst noch
// einmal über dieselbe Registry auflöst (`MxlVideoInput::new`) — trifft
// dabei denselben, bereits an anderer Stelle dokumentierten Registry-
// Verzögerungs-Bug (Projekt-Memory "NMOS mock-registry bulk /senders
// list sometimes omits a resource"): unmittelbar nach
// `awaitRegistration` ist der frisch registrierte Sender für den
// *Orchestrator* schon sichtbar (sonst gäbe es keinen Alias dafür),
// aber nicht zwangsläufig schon für jede andere Node, die dieselbe
// Registry unabhängig selbst abfragt.
//
// Live reproduziert, zwei unabhängige Funde: (1) derselbe `POST
// /state`-Body, manuell Sekunden später wiederholt, setzte
// `programSenderId` korrekt — der erste Versuch direkt nach dem Start
// ließ es auf `null`, obwohl die HTTP-Antwort beide Male 200 war. (2)
// Eine reine "kommt die aufgelöste ID irgendwo im Rück-`GET` vor"-
// Prüfung reicht NICHT als Erfolgskriterium: `pinnedSenderIds` wird
// synchron (ohne Registry-Abhängigkeit) gesetzt und enthält die ID
// bereits beim ersten Versuch, obwohl `programSenderId` (asynchron,
// abhängig vom `take()`-Erfolg) noch `null` ist — ein Verifikations-
// Check muss den kompletten zurückgegebenen Zustand mit dem gerade
// gesendeten vergleichen (`stateMatches`), nicht nur nach irgendeinem
// Teiltreffer suchen, sonst wird nach dem ersten, unvollständigen
// Versuch fälschlich "erledigt" gemeldet.
// Live gefundene dritte, tiefere Ursache derselben Symptomklasse (per
// `omp-video-mixer-me`s eigenem Log-Fund, nicht nur vermutet): selbst
// nach erfolgreicher NMOS-Sender→Flow-ID-Auflösung kann
// `MxlVideoInput::new`s `get_flow_def()` noch mit "Flow not found"
// scheitern — das ist eine dritte, von der NMOS-Registry unabhängige
// Verzögerung auf MXL-Shared-Memory-Ebene (`/dev/shm/omp-mxl`): die
// Quelle registriert ihren NMOS-Sender, bevor ihr eigener
// `MxlVideoOutput` den zugehörigen Flow im Shared-Memory-Domain-
// Verzeichnis tatsächlich anlegt. Großzügigeres Zeitbudget als
// ursprünglich angenommen nötig.
const restoreStateRetries = 8
const restoreStateRetryDelay = 2 * time.Second

// restoreRoleState wird nach erfolgreicher Verkabelung eines frisch
// gestarteten Workflows aufgerufen (nach den `applyConnection`-Aufrufen
// in runStart, s. Nachtrag 91 Punkt 3). Best effort, wie
// captureRoleState.
func (s *Service) restoreRoleState(wf Workflow) {
	saved, err := s.store.GetRoleState(wf.ID)
	if err != nil {
		slog.Warn("workflows: failed to load role state", "workflow", wf.ID, "error", err)
		return
	}
	if len(saved) == 0 {
		return
	}

	for role, raw := range saved {
		if err := s.restoreOneRoleState(wf, role, raw); err != nil {
			slog.Warn("workflows: failed to restore role state", "workflow", wf.ID, "role", role, "error", err)
		}
	}
}

// restoreOneRoleState löst Alias→aktuelle-Sender-ID auf, postet und
// bestätigt per Rück-`GET`, dass jede tatsächlich aufgelöste Sender-ID
// im Node angekommen ist — wiederholt bis zu restoreStateRetries mal
// (s. restoreStateRetries-Doku oben), Alias-Tabelle **und** Verifikation
// beide pro Versuch neu, nicht nur der POST: derselbe Registry-
// Verzögerungs-Bug kann schon den Aufbau der Alias-Tabelle selbst
// treffen (ein Sender-Index, der beim ersten Versuch im Orchestrator-
// Cache noch fehlt, bleibt sonst dauerhaft unauflösbar, obwohl ein
// späterer Versuch ihn gefunden hätte). Ein leeres resolvedIDs (kein
// Alias im Blob enthalten, z. B. reine DVE-Box-/Enabled-Flags ohne
// Sender-Bezug) verifiziert nicht extra — ein einzelner POST reicht.
func (s *Service) restoreOneRoleState(wf Workflow, role string, raw json.RawMessage) error {
	var lastErr error
	for attempt := 1; attempt <= restoreStateRetries; attempt++ {
		if attempt > 1 {
			time.Sleep(restoreStateRetryDelay)
		}

		node, ok := s.nodeForRole(wf, role)
		if !ok || node.APIBaseURL == "" {
			lastErr = fmt.Errorf("role not registered")
			continue
		}
		aliasToSender := s.buildAliasSenderIndex(wf)
		resolved, resolvedIDs, err := resolveSenderAliases(raw, aliasToSender)
		if err != nil {
			return err // Parsing-Fehler, kein Retry-würdiger Zustand
		}

		var env roleStateEnvelope
		if err := json.Unmarshal(resolved, &env); err != nil {
			return err // Parsing-Fehler, kein Retry-würdiger Zustand
		}

		if env.Kind == roleStateKindParams {
			ctx, cancel := context.WithTimeout(context.Background(), roleStateTimeout)
			err := restoreGenericParams(ctx, s.httpClient, node.APIBaseURL, env.Params)
			cancel()
			if err != nil {
				lastErr = err
				continue
			}
			return nil
		}

		// Kind == roleStateKindNode oder leer (Rückwärtskompatibilität
		// zu vor dieser Änderung gespeicherten Zeilen, s. roleStateEnvelope-
		// Doku): Blob ist dann leer, resolved selbst IST bereits der
		// vollständige, alte GET-/state-Rohwert.
		state := env.Blob
		if env.Kind == "" && len(state) == 0 {
			state = resolved
		}

		ctx, cancel := context.WithTimeout(context.Background(), roleStateTimeout)
		postErr := postNodeState(ctx, s.httpClient, node.APIBaseURL, state)
		cancel()
		if postErr != nil {
			lastErr = postErr
			continue
		}
		if len(resolvedIDs) == 0 {
			return nil
		}

		// `take()` selbst ist fire-and-forget (s. Moduldoku) — dem
		// Pipeline-Thread etwas Zeit geben, den Befehl tatsächlich zu
		// verarbeiten, bevor direkt danach zurückgelesen wird.
		time.Sleep(200 * time.Millisecond)

		ctx, cancel = context.WithTimeout(context.Background(), roleStateTimeout)
		after, err := getNodeState(ctx, s.httpClient, node.APIBaseURL)
		cancel()
		switch {
		case err != nil:
			lastErr = err
		case stateMatches(after, state):
			return nil
		default:
			lastErr = fmt.Errorf("restored state did not stick (registry propagation lag)")
		}
	}
	return lastErr
}

// restoreGenericParams ist die Kehrseite von captureGenericParams: setzt
// jeden erfassten Parameter einzeln per PATCH /params/<name>. Anders als
// der node-state-Pfad oben keine Rück-GET-Verifikation nötig — ein Node
// setzt einen einfachen Parameterwert synchron (kein fire-and-forget wie
// `take()` bei Sender-IDs, s. restoreStateRetries-Doku), ein 200-OK auf
// den PATCH ist daher bereits der Beweis, dass er angekommen ist. Ein
// einzelner fehlgeschlagener Parameter bricht die übrigen nicht ab
// (bestmögliche Wiederherstellung statt Alles-oder-nichts), wird aber
// als Fehler zurückgegeben, damit der äußere Retry-Loop es erneut
// versucht (z. B. wenn der Node unmittelbar nach dem Start kurzzeitig
// noch nicht antwortet).
func restoreGenericParams(ctx context.Context, client *http.Client, apiBaseURL string, params map[string]json.RawMessage) error {
	var lastErr error
	for name, value := range params {
		pctx, cancel := context.WithTimeout(ctx, roleStateTimeout)
		err := patchParamValue(pctx, client, apiBaseURL, name, value)
		cancel()
		if err != nil {
			lastErr = err
			slog.Warn("workflows: failed to restore param", "node", apiBaseURL, "param", name, "error", err)
		}
	}
	return lastErr
}

// buildSenderAliasIndex sammelt, für jede aktuell laufende Rolle dieses
// Workflows, die Sender-IDs ihres Nodes -> stabiler Alias (Rollenname +
// Position in dessen Sender-Liste). Läuft vor dem Erfassen, während
// alle Rollen noch leben.
func (s *Service) buildSenderAliasIndex(wf Workflow) map[string]string {
	out := map[string]string{}
	for role := range wf.Runtime {
		node, ok := s.nodeForRole(wf, role)
		if !ok {
			continue
		}
		for i, sender := range node.Senders {
			out[sender.ID] = fmt.Sprintf("%s%s:%d", senderAliasPrefix, role, i)
		}
	}
	return out
}

// buildAliasSenderIndex ist die Umkehrung, gegen den frisch gestarteten
// Node-Bestand (neue Sender-IDs) statt des Stands zum Erfassungs-
// Zeitpunkt.
func (s *Service) buildAliasSenderIndex(wf Workflow) map[string]string {
	out := map[string]string{}
	for role := range wf.Runtime {
		node, ok := s.nodeForRole(wf, role)
		if !ok {
			continue
		}
		for i, sender := range node.Senders {
			out[fmt.Sprintf("%s%s:%d", senderAliasPrefix, role, i)] = sender.ID
		}
	}
	return out
}

// aliasSenderIDs/resolveSenderAliases wandern rekursiv durch den
// JSON-Baum eines /state-Blobs und ersetzen jeden String-Wert, der im
// jeweiligen lookup vorkommt — schemafrei (kein Wissen über einzelne
// Feldnamen nötig), funktioniert für jeden Node-Typ, der /state
// implementiert, auch künftige. resolveSenderAliases liefert zusätzlich
// die Liste der tatsächlich eingesetzten Ersatzwerte (für
// postAndVerifyState — nur diese müssen nach dem `POST` im Node
// nachweisbar sein, nicht der ganze Blob).
func aliasSenderIDs(raw json.RawMessage, senderToAlias map[string]string) (json.RawMessage, error) {
	out, _, err := mapJSONStrings(raw, senderToAlias)
	return out, err
}

func resolveSenderAliases(raw json.RawMessage, aliasToSender map[string]string) (json.RawMessage, []string, error) {
	return mapJSONStrings(raw, aliasToSender)
}

func mapJSONStrings(raw json.RawMessage, lookup map[string]string) (json.RawMessage, []string, error) {
	if len(lookup) == 0 {
		return raw, nil, nil
	}
	var v interface{}
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, nil, err
	}
	var used []string
	result := substituteStrings(v, lookup, &used)
	out, err := json.Marshal(result)
	if err != nil {
		return nil, nil, err
	}
	return out, used, nil
}

func substituteStrings(v interface{}, lookup map[string]string, used *[]string) interface{} {
	switch val := v.(type) {
	case string:
		if repl, ok := lookup[val]; ok {
			*used = append(*used, repl)
			return repl
		}
		return val
	case []interface{}:
		out := make([]interface{}, len(val))
		for i, e := range val {
			out[i] = substituteStrings(e, lookup, used)
		}
		return out
	case map[string]interface{}:
		out := make(map[string]interface{}, len(val))
		for k, e := range val {
			out[k] = substituteStrings(e, lookup, used)
		}
		return out
	default:
		return val
	}
}

// stateMatches vergleicht zwei /state-JSON-Dokumente auf semantische
// Gleichheit (Feld-Reihenfolge egal) — Grundlage für
// restoreOneRoleState: ein reiner "kommt die ID irgendwo vor"-Test
// reicht nicht (s. dortige Doku, `pinnedSenderIds` wird synchron/immer
// gesetzt, `programSenderId` nur bei tatsächlich erfolgreichem,
// asynchronem `take()`) — nur ein vollständiger Abgleich des
// zurückgelesenen gegen den gerade gesendeten Zustand zeigt zuverlässig,
// ob wirklich alles angekommen ist.
func stateMatches(after, want json.RawMessage) bool {
	var a, w interface{}
	if err := json.Unmarshal(after, &a); err != nil {
		return false
	}
	if err := json.Unmarshal(want, &w); err != nil {
		return false
	}
	return reflect.DeepEqual(a, w)
}

func getNodeState(ctx context.Context, client *http.Client, apiBaseURL string) (json.RawMessage, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiBaseURL+"/state", nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("workflows: unexpected status %d from GET %s/state", resp.StatusCode, apiBaseURL)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxRoleStateBytes))
	if err != nil {
		return nil, err
	}
	if !json.Valid(body) {
		return nil, fmt.Errorf("workflows: GET %s/state did not return valid JSON", apiBaseURL)
	}
	return json.RawMessage(body), nil
}

func postNodeState(ctx context.Context, client *http.Client, apiBaseURL string, state json.RawMessage) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiBaseURL+"/state", bytes.NewReader(state))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("workflows: unexpected status %d from POST %s/state", resp.StatusCode, apiBaseURL)
	}
	return nil
}

// descriptorParam/descriptorResponse sind die für die generische
// Parametererfassung relevante Teilmenge eines Descriptors
// (docs/descriptor-v0.schema.json) — dieselbe Struktur wie
// internal/snapshots/nodeclient.go, hier unabhängig dupliziert (s.
// captureGenericParams-Doku).
type descriptorParam struct {
	Name     string `json:"name"`
	ReadOnly bool   `json:"readonly"`
}

type descriptorResponse struct {
	Parameters []descriptorParam `json:"parameters"`
}

func getWritableParamNames(ctx context.Context, client *http.Client, apiBaseURL string) ([]string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiBaseURL+"/descriptor.json", nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("workflows: unexpected status %d from GET %s/descriptor.json", resp.StatusCode, apiBaseURL)
	}
	var out descriptorResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	names := make([]string, 0, len(out.Parameters))
	for _, p := range out.Parameters {
		if !p.ReadOnly {
			names = append(names, p.Name)
		}
	}
	return names, nil
}

func getParamValue(ctx context.Context, client *http.Client, apiBaseURL, name string) (json.RawMessage, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiBaseURL+"/params/"+name, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("workflows: unexpected status %d from GET %s/params/%s", resp.StatusCode, apiBaseURL, name)
	}
	var body struct {
		Value json.RawMessage `json:"value"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, err
	}
	return body.Value, nil
}

func patchParamValue(ctx context.Context, client *http.Client, apiBaseURL, name string, value json.RawMessage) error {
	payload, err := json.Marshal(struct {
		Value json.RawMessage `json:"value"`
	}{Value: value})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPatch, apiBaseURL+"/params/"+name, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("workflows: unexpected status %d from PATCH %s/params/%s", resp.StatusCode, apiBaseURL, name)
	}
	return nil
}
