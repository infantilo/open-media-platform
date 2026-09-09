package connection

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// corsPreflight registriert eine OPTIONS-Antwort für einen Pfad, der laut
// RAML (`ConnectionAPI.raml`) CORS-Preflight unterstützen muss (dort als
// `options:` mit Response 200/403 deklariert) — Go liefert für einen
// nur-GET/PATCH-registrierten Pfad ohne diesen Handler automatisch 405,
// nicht 200/403. Live an AMWA-`auto_connection_5`/`6`/`13`/`20` gefunden
// (Nachtrag 194): `bulk/senders`, `bulk/receivers`,
// `single/receivers/{id}/staged`, `single/senders/{id}/staged` fehlte
// das alle. `methods` sind die anderen an diesem Pfad erlaubten Methoden
// (ohne OPTIONS selbst) für `Access-Control-Allow-Methods` — das
// AMWA-Tool prüft genau diesen Header gegen die RAML-deklarierten
// Methoden dieses Pfads (`check_CORS`, `GenericTest.py`).
func corsPreflight(mux *http.ServeMux, path string, methods []string) {
	mux.HandleFunc("OPTIONS "+path, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Methods", strings.Join(methods, ", "))
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.WriteHeader(http.StatusOK)
	})
}

// Handler baut den HTTP-Handler für die IS-05-Connection-API-Pfade von
// Receivern UND Sendern: GET/PATCH .../staged, GET .../active, plus die
// Basis-Discovery-Pfade (Wurzel/single/{senders,receivers}-Listing,
// constraints/transporttype pro Resource, UMSETZUNG.md D9) — Grundlage
// für AMWA-IS-05-01-Konformitätstests, die vor D9 an den fehlenden
// Discovery-Pfaden mit 0 ausgeführten Tests abbrachen (docs/decisions.md
// 2026-07-13). Bulk-`POST /bulk/receivers` seit UMSETZUNG.md D11 echt
// implementiert (live an AMWA-`test_37` gefunden) — dieselbe
// `PatchStaged`-Logik wie das Einzel-PATCH, s. dort. Sender-seitig war
// dieser Mock-Node bis Nachtrag 193 bewusst unimplementiert ("rein
// Receiver-seitig", Schritt B1) — Grund für die Ergänzung: AMWA
// IS-05-01s `auto_connection_1/2/3/4/5/6/13` (UMSETZUNG.md D11) brauchen
// einen echten, IS-04-registrierten Sender zum Verbinden, sonst bleiben
// sie dauerhaft eine Ausnahme statt echter Konformität. Sender-Feldnamen
// s. sender.go-Moduldoku (eigenständig gegen AMWA-TV/is-05 v1.1.2
// geprüft, nicht vom Receiver-Pendant übernommen).
// Bedient seit Nachtrag 189 sowohl `v1.1` als auch `v1.2` (s.
// [apiVersions]) — v1.2.0 ist wire-kompatibel zu v1.1.x, daher dieselben
// Handler für beide Versionspfade statt einer zweiten Implementierung.
//
// Jedes Leaf-Resource (constraints/staged/active/transporttype) wird
// bewusst SOWOHL ohne als auch mit abschließendem "/" registriert: das
// AMWA-Testing-Tool ruft beide Formen ab (am echten Tool-Lauf beobachtet,
// docs/decisions.md D9). Ohne die explizite "/"-Variante fängt Gos
// `ServeMux` (`{id}/` ist ein Teilbaum-Muster, da es auf "/" endet) diese
// Anfragen fälschlich im Wurzel-Listing-Handler ab — echter Bug, live am
// Tool-Lauf gefunden: `test_12_02`/`test_16` schlugen mit `TypeError:
// list indices must be integers` fehl, weil `GET .../active/` (mit
// Slash) das Listing-Array statt der Active-Resource lieferte.
// apiVersions sind die IS-05-Connection-API-Versionen, die dieser
// Mock-Node parallel bedient: `v1.1` (bisheriger Stand) und `v1.2`
// (AMWA-TV/is-05 Release v1.2.0, Aug. 2024). v1.2 ist gegenüber v1.1
// abwärtskompatibel — die einzige inhaltliche Änderung ist, dass weitere
// Transport-Typen ab v1.2 über das NMOS-"Transports"-Parameter-Register
// statt fest in der Spec definiert werden; die hier implementierten
// Pfade/Schemas (staged/active/constraints/transporttype/bulk) sind
// identisch. Deshalb registriert jede Version dieselben Handler unter
// ihrem eigenen Pfad-Prefix, statt zwei getrennte Implementierungen zu
// pflegen.
var apiVersions = []string{"v1.1", "v1.2"}

func Handler(receivers *ReceiverStore, senders *SenderStore) http.Handler {
	mux := http.NewServeMux()

	// Nachtrag 190: der nackte `/x-nmos/connection/` (ohne Version) fehlte
	// bisher komplett — jede Version hatte nur ihre eigene Wurzel
	// (`.../v1.1/`, `.../v1.2/`), nicht die node-globale Versionsliste, die
	// die IS-05-Spec dafür vorsieht. Gleiches "exaktes Pfad-Match statt
	// Teilbaum-Wildcard"-Muster wie bei den Versions-Wurzeln unten
	// (dieselbe `ServeMux`-Falle, s. dortiger Kommentar).
	mux.HandleFunc("GET /x-nmos/connection/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/x-nmos/connection/" {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		listing := make([]string, len(apiVersions))
		for i, version := range apiVersions {
			listing[i] = version + "/"
		}
		writeJSON(w, http.StatusOK, listing)
	})

	for _, version := range apiVersions {
		registerVersion(mux, receivers, senders, version)
	}

	return mux
}

func registerVersion(mux *http.ServeMux, store *ReceiverStore, senders *SenderStore, version string) {
	base := "/x-nmos/connection/" + version + "/"

	mux.HandleFunc("GET "+base, func(w http.ResponseWriter, r *http.Request) {
		// `net/http`s `ServeMux` behandelt ein auf "/" endendes Muster als
		// Teilbaum-Wildcard: ohne diesen expliziten Pfad-Vergleich würde
		// JEDER nicht anderweitig registrierte Unterpfad (z. B.
		// `bulk/senders`) hier fälschlich mit dem Wurzel-Listing statt 404
		// beantwortet — echter Bug, live an AMWA-`test_34`/`test_35`
		// gefunden (erwarteten 405 für GET auf die zwei per RAML
		// (`ConnectionAPI.raml`) fest definierten `bulk/senders`+
		// `bulk/receivers`-Pfade, bekamen stattdessen 200 mit dem
		// Wurzel-Listing-Body). Derselbe Bugtyp wie der bereits oben
		// gefixte `{id}/`-Fall, hier eine Ebene höher.
		if r.URL.Path != base {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		// Nachtrag 194: `connectionapi-base.json`/`examples/base-get-200.json`
		// (AMWA-TV/is-05 v1.1.2) verlangen BEIDE Einträge — live an
		// AMWA-`auto_connection_3` gefunden ("Response schema validation
		// error"): `["single/"]` allein erfüllt das Schema nicht
		// (`minItems: 2`).
		writeJSON(w, http.StatusOK, []string{"bulk/", "single/"})
	})

	// `GET .../bulk/` — Nachtrag 194: fehlte bisher komplett (nur
	// `bulk/senders`+`bulk/receivers` waren registriert, nicht die
	// Bulk-Wurzel selbst) — live an AMWA-`auto_connection_4` gefunden
	// ("Incorrect response code: 404"), derselbe Bugtyp wie der schon
	// gefixte `/x-nmos/connection/`-Wurzel-Fall (Nachtrag 190): das RAML
	// deklariert den Pfad ohne Trailing-Slash ("/bulk"), das AMWA-Tool
	// ruft ihn auch so ab — `net/http`s automatischer Trailing-Slash-
	// Redirect (Subtree-Pattern) braucht dafür ÜBERHAUPT ein registriertes
	// `.../bulk/`-Pattern zum Umleiten auf, das fehlte hier ganz (anders
	// als bei `single/`, das genau deshalb schon vorher funktionierte).
	mux.HandleFunc("GET "+base+"bulk/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, []string{"senders/", "receivers/"})
	})

	// `bulk/senders`+`bulk/receivers` sind laut RAML (`ConnectionAPI.raml`)
	// feste Basis-Discovery-Pfade: GET liefert dort laut Spec immer 405
	// (Method Not Allowed), nicht 404. Beide bekommen unten zusätzlich
	// einen echten POST-Handler (seit Nachtrag 193 auch `bulk/senders`)
	// und einen echten OPTIONS-Preflight-Handler (s. `corsPreflight`).
	bulkMethodNotAllowed := func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusMethodNotAllowed, "GET not allowed on bulk resources")
	}
	mux.HandleFunc("GET "+base+"bulk/senders", bulkMethodNotAllowed)
	mux.HandleFunc("GET "+base+"bulk/receivers", bulkMethodNotAllowed)
	corsPreflight(mux, base+"bulk/senders", []string{"POST"})
	corsPreflight(mux, base+"bulk/receivers", []string{"POST"})

	mux.HandleFunc("GET "+base+"single/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, []string{"senders/", "receivers/"})
	})

	mux.HandleFunc("GET "+base+"single/senders/", func(w http.ResponseWriter, r *http.Request) {
		ids := senders.IDs()
		listing := make([]string, len(ids))
		for i, id := range ids {
			listing[i] = id + "/"
		}
		writeJSON(w, http.StatusOK, listing)
	})

	mux.HandleFunc("GET "+base+"single/receivers/", func(w http.ResponseWriter, r *http.Request) {
		ids := store.IDs()
		listing := make([]string, len(ids))
		for i, id := range ids {
			listing[i] = id + "/"
		}
		writeJSON(w, http.StatusOK, listing)
	})

	resourceRoot := func(w http.ResponseWriter, r *http.Request) {
		if !store.Exists(r.PathValue("id")) {
			writeError(w, http.StatusNotFound, "unknown receiver")
			return
		}
		writeJSON(w, http.StatusOK, []string{"constraints/", "staged/", "active/", "transporttype/"})
	}
	mux.HandleFunc("GET "+base+"single/receivers/{id}/", resourceRoot)

	constraints := func(w http.ResponseWriter, r *http.Request) {
		if !store.Exists(r.PathValue("id")) {
			writeError(w, http.StatusNotFound, "unknown receiver")
			return
		}
		writeJSON(w, http.StatusOK, Constraints())
	}
	mux.HandleFunc("GET "+base+"single/receivers/{id}/constraints", constraints)
	mux.HandleFunc("GET "+base+"single/receivers/{id}/constraints/", constraints)

	transportType := func(w http.ResponseWriter, r *http.Request) {
		if !store.Exists(r.PathValue("id")) {
			writeError(w, http.StatusNotFound, "unknown receiver")
			return
		}
		writeJSON(w, http.StatusOK, TransportType)
	}
	mux.HandleFunc("GET "+base+"single/receivers/{id}/transporttype", transportType)
	mux.HandleFunc("GET "+base+"single/receivers/{id}/transporttype/", transportType)

	staged := func(w http.ResponseWriter, r *http.Request) {
		res, ok := store.Staged(r.PathValue("id"))
		if !ok {
			writeError(w, http.StatusNotFound, "unknown receiver")
			return
		}
		writeJSON(w, http.StatusOK, res)
	}
	mux.HandleFunc("GET "+base+"single/receivers/{id}/staged", staged)
	mux.HandleFunc("GET "+base+"single/receivers/{id}/staged/", staged)
	corsPreflight(mux, base+"single/receivers/{id}/staged", []string{"GET", "PATCH"})

	mux.HandleFunc("PATCH "+base+"single/receivers/{id}/staged", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			writeError(w, http.StatusBadRequest, "reading request body failed")
			return
		}

		req, err := parsePatchRequest(body)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}

		res, status, ok := store.PatchStaged(r.PathValue("id"), req)
		if !ok {
			writeError(w, http.StatusNotFound, "unknown receiver")
			return
		}
		writeJSON(w, status, res)
	})

	// `POST /bulk/receivers` — echte Bulk-Aktivierung (live an
	// AMWA-`test_37` gefunden, docs/decisions.md): jeder Eintrag wendet
	// dieselbe `PatchStaged`-Logik wie das Einzel-PATCH an (kein
	// separater Codepfad, keine zweite Fehlerquelle), Antwortform nach
	// `bulk-response-schema.json` (Array aus `{id, code, error?,
	// debug?}`). Kein `/bulk/senders`-POST-Handler — der Mock-Node hat
	// nie eigene Sender (s. Moduldoku), GET dort bleibt bei 405 (Go
	// liefert das für POST auf einen nur-GET-registrierten Pfad
	// automatisch), kein Testfall dieses Projekts braucht mehr.
	mux.HandleFunc("POST "+base+"bulk/receivers", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			writeError(w, http.StatusBadRequest, "reading request body failed")
			return
		}

		var items []bulkRequestItem
		if err := json.Unmarshal(body, &items); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}

		results := make([]bulkResultItem, 0, len(items))
		for _, item := range items {
			req, err := parsePatchRequest(item.Params)
			if err != nil {
				msg := err.Error()
				results = append(results, bulkResultItem{ID: item.ID, Code: http.StatusBadRequest, Error: &msg})
				continue
			}
			_, status, ok := store.PatchStaged(item.ID, req)
			if !ok {
				msg := "unknown receiver"
				results = append(results, bulkResultItem{ID: item.ID, Code: http.StatusNotFound, Error: &msg})
				continue
			}
			results = append(results, bulkResultItem{ID: item.ID, Code: status})
		}
		writeJSON(w, http.StatusOK, results)
	})

	active := func(w http.ResponseWriter, r *http.Request) {
		res, ok := store.Active(r.PathValue("id"))
		if !ok {
			writeError(w, http.StatusNotFound, "unknown receiver")
			return
		}
		writeJSON(w, http.StatusOK, res)
	}
	mux.HandleFunc("GET "+base+"single/receivers/{id}/active", active)
	mux.HandleFunc("GET "+base+"single/receivers/{id}/active/", active)

	registerSenderRoutes(mux, senders, base)
}

// registerSenderRoutes registriert die Sender-seitige IS-05-Connection-API
// (Nachtrag 193) — Struktur bewusst parallel zu den Receiver-Routen oben,
// aber eigenständig (andere Resource-Form, s. sender.go-Moduldoku), plus
// `transportfile/`, das Receiver nicht haben.
func registerSenderRoutes(mux *http.ServeMux, senders *SenderStore, base string) {
	senderResourceRoot := func(w http.ResponseWriter, r *http.Request) {
		if !senders.Exists(r.PathValue("id")) {
			writeError(w, http.StatusNotFound, "unknown sender")
			return
		}
		writeJSON(w, http.StatusOK, []string{"constraints/", "staged/", "active/", "transportfile/", "transporttype/"})
	}
	mux.HandleFunc("GET "+base+"single/senders/{id}/", senderResourceRoot)

	senderConstraints := func(w http.ResponseWriter, r *http.Request) {
		if !senders.Exists(r.PathValue("id")) {
			writeError(w, http.StatusNotFound, "unknown sender")
			return
		}
		writeJSON(w, http.StatusOK, SenderConstraints())
	}
	mux.HandleFunc("GET "+base+"single/senders/{id}/constraints", senderConstraints)
	mux.HandleFunc("GET "+base+"single/senders/{id}/constraints/", senderConstraints)

	senderTransportType := func(w http.ResponseWriter, r *http.Request) {
		if !senders.Exists(r.PathValue("id")) {
			writeError(w, http.StatusNotFound, "unknown sender")
			return
		}
		writeJSON(w, http.StatusOK, TransportType)
	}
	mux.HandleFunc("GET "+base+"single/senders/{id}/transporttype", senderTransportType)
	mux.HandleFunc("GET "+base+"single/senders/{id}/transporttype/", senderTransportType)

	senderStaged := func(w http.ResponseWriter, r *http.Request) {
		res, ok := senders.Staged(r.PathValue("id"))
		if !ok {
			writeError(w, http.StatusNotFound, "unknown sender")
			return
		}
		writeJSON(w, http.StatusOK, res)
	}
	mux.HandleFunc("GET "+base+"single/senders/{id}/staged", senderStaged)
	mux.HandleFunc("GET "+base+"single/senders/{id}/staged/", senderStaged)
	corsPreflight(mux, base+"single/senders/{id}/staged", []string{"GET", "PATCH"})

	mux.HandleFunc("PATCH "+base+"single/senders/{id}/staged", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			writeError(w, http.StatusBadRequest, "reading request body failed")
			return
		}

		req, err := parseSenderPatchRequest(body)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}

		res, status, ok := senders.PatchStaged(r.PathValue("id"), req)
		if !ok {
			writeError(w, http.StatusNotFound, "unknown sender")
			return
		}
		writeJSON(w, status, res)
	})

	senderActive := func(w http.ResponseWriter, r *http.Request) {
		res, ok := senders.Active(r.PathValue("id"))
		if !ok {
			writeError(w, http.StatusNotFound, "unknown sender")
			return
		}
		writeJSON(w, http.StatusOK, res)
	}
	mux.HandleFunc("GET "+base+"single/senders/{id}/active", senderActive)
	mux.HandleFunc("GET "+base+"single/senders/{id}/active/", senderActive)

	// `.../transportfile` — RAML erlaubt 200 (SDP direkt)/307 (Redirect)/
	// 404 (kein Transport-File nötig/Sender nicht konfiguriert). Dieser
	// Mock liefert immer 200 mit einer aus dem aufgelösten `active`-Zustand
	// gebauten SDP (s. `senderSDP`) — genug, damit `auto_connection_*` eine
	// gültige Ziel-Adresse/Port daraus extrahieren kann.
	senderTransportFile := func(w http.ResponseWriter, r *http.Request) {
		sdp, ok := senders.TransportFile(r.PathValue("id"))
		if !ok {
			writeError(w, http.StatusNotFound, "unknown sender")
			return
		}
		w.Header().Set("Content-Type", "application/sdp")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(sdp))
	}
	mux.HandleFunc("GET "+base+"single/senders/{id}/transportfile", senderTransportFile)
	mux.HandleFunc("GET "+base+"single/senders/{id}/transportfile/", senderTransportFile)

	// `POST /bulk/senders` — echte Bulk-Aktivierung, spiegelbildlich zu
	// `POST /bulk/receivers` oben (dieselbe `bulkRequestItem`/
	// `bulkResultItem`-Form, `bulk-sender-post-schema.json` ist
	// strukturell identisch zu `bulk-receiver-post-schema.json`, nur mit
	// `sender-stage-schema.json` statt `receiver-stage-schema.json` als
	// `params`-Referenz).
	mux.HandleFunc("POST "+base+"bulk/senders", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			writeError(w, http.StatusBadRequest, "reading request body failed")
			return
		}

		var items []bulkRequestItem
		if err := json.Unmarshal(body, &items); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON body")
			return
		}

		results := make([]bulkResultItem, 0, len(items))
		for _, item := range items {
			req, err := parseSenderPatchRequest(item.Params)
			if err != nil {
				msg := err.Error()
				results = append(results, bulkResultItem{ID: item.ID, Code: http.StatusBadRequest, Error: &msg})
				continue
			}
			_, status, ok := senders.PatchStaged(item.ID, req)
			if !ok {
				msg := "unknown sender"
				results = append(results, bulkResultItem{ID: item.ID, Code: http.StatusNotFound, Error: &msg})
				continue
			}
			results = append(results, bulkResultItem{ID: item.ID, Code: status})
		}
		writeJSON(w, http.StatusOK, results)
	})
}

// parsePatchRequest dekodiert+validiert einen PATCH-`staged`-Body —
// gemeinsame Logik für das Einzel-PATCH und jeden Eintrag von
// `POST /bulk/receivers` (dasselbe `params`-Objekt, nur eingebettet in
// ein Array-Element statt der alleinige Body). Lehnt unbekannte
// Top-Level-Felder ab (`receiver-stage-schema.json`:
// `additionalProperties: false`, live an AMWA-`test_20` gefunden).
func parsePatchRequest(body []byte) (PatchRequest, error) {
	var rawFields map[string]json.RawMessage
	if err := json.Unmarshal(body, &rawFields); err != nil {
		return PatchRequest{}, errors.New("invalid JSON body")
	}
	for field := range rawFields {
		if !patchableFields[field] {
			return PatchRequest{}, fmt.Errorf("unknown field: %s", field)
		}
	}

	var req PatchRequest
	if err := json.Unmarshal(body, &req); err != nil {
		return PatchRequest{}, errors.New("invalid JSON body")
	}
	return req, nil
}

// bulkRequestItem ist ein Element des `POST /bulk/receivers`-Bodys
// (`bulk-receiver-post-schema.json`) — `Params` bleibt roh, weil es
// exakt derselbe Body wie ein Einzel-PATCH ist (`parsePatchRequest`
// entscheidet, nicht ein zweites Schema).
type bulkRequestItem struct {
	ID     string          `json:"id"`
	Params json.RawMessage `json:"params"`
}

// bulkResultItem ist ein Element der `bulk-response-schema.json`-Antwort
// — `Error`/`Debug` nur bei einem Fehler-`Code` gesetzt (`omitempty`,
// das Schema erlaubt beide Felder wegzulassen, anders als bei der
// Einzel-PATCH-`errorResponse`, deren `debug` immer required ist).
type bulkResultItem struct {
	ID    string  `json:"id"`
	Code  int     `json:"code"`
	Error *string `json:"error,omitempty"`
	Debug *string `json:"debug,omitempty"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// errorResponse ist die IS-05-Standard-Fehlerantwort (`error-schema.json`
// — code/error/debug, alle drei required). `http.Error` liefert dagegen
// hartcodiert `text/plain` — live an AMWA-`test_34`/`test_35`/
// `auto_connection_22` gefunden (UMSETZUNG.md D9, docs/decisions.md):
// "API signalled a Content-Type of text/plain ... rather than
// application/json".
type errorResponse struct {
	Code  int     `json:"code"`
	Error string  `json:"error"`
	Debug *string `json:"debug"`
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, errorResponse{Code: status, Error: message, Debug: nil})
}
