package connection

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

// Handler baut den HTTP-Handler für die IS-05-Connection-API-Pfade der
// Receiver: GET/PATCH .../staged, GET .../active, plus die
// Basis-Discovery-Pfade (Wurzel/single/receivers-Listing,
// constraints/transporttype pro Receiver, UMSETZUNG.md D9) — Grundlage
// für AMWA-IS-05-01-Konformitätstests, die vor D9 an den fehlenden
// Discovery-Pfaden mit 0 ausgeführten Tests abbrachen (docs/decisions.md
// 2026-07-13). Bulk-`POST /bulk/receivers` seit UMSETZUNG.md D11 echt
// implementiert (live an AMWA-`test_37` gefunden) — dieselbe
// `PatchStaged`-Logik wie das Einzel-PATCH, s. dort. Kein
// `/bulk/senders`-POST (der Mock-Node hat nie eigene Sender, s. u.).
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
func Handler(store *ReceiverStore) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /x-nmos/connection/v1.1/", func(w http.ResponseWriter, r *http.Request) {
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
		if r.URL.Path != "/x-nmos/connection/v1.1/" {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		writeJSON(w, http.StatusOK, []string{"single/"})
	})

	// `bulk/senders`+`bulk/receivers` sind laut RAML (`ConnectionAPI.raml`)
	// feste Basis-Discovery-Pfade: GET liefert dort laut Spec immer 405
	// (Method Not Allowed), nicht 404. `bulk/senders` bleibt komplett
	// ohne POST-Handler (Go liefert dafür automatisch 405 — korrekt,
	// der Mock-Node hat nie eigene Sender). `bulk/receivers` bekommt
	// unten zusätzlich einen echten POST-Handler.
	bulkMethodNotAllowed := func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusMethodNotAllowed, "GET not allowed on bulk resources")
	}
	mux.HandleFunc("GET /x-nmos/connection/v1.1/bulk/senders", bulkMethodNotAllowed)
	mux.HandleFunc("GET /x-nmos/connection/v1.1/bulk/receivers", bulkMethodNotAllowed)

	mux.HandleFunc("GET /x-nmos/connection/v1.1/single/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, []string{"senders/", "receivers/"})
	})

	mux.HandleFunc("GET /x-nmos/connection/v1.1/single/senders/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, []string{})
	})

	mux.HandleFunc("GET /x-nmos/connection/v1.1/single/receivers/", func(w http.ResponseWriter, r *http.Request) {
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
	mux.HandleFunc("GET /x-nmos/connection/v1.1/single/receivers/{id}/", resourceRoot)

	constraints := func(w http.ResponseWriter, r *http.Request) {
		if !store.Exists(r.PathValue("id")) {
			writeError(w, http.StatusNotFound, "unknown receiver")
			return
		}
		writeJSON(w, http.StatusOK, Constraints())
	}
	mux.HandleFunc("GET /x-nmos/connection/v1.1/single/receivers/{id}/constraints", constraints)
	mux.HandleFunc("GET /x-nmos/connection/v1.1/single/receivers/{id}/constraints/", constraints)

	transportType := func(w http.ResponseWriter, r *http.Request) {
		if !store.Exists(r.PathValue("id")) {
			writeError(w, http.StatusNotFound, "unknown receiver")
			return
		}
		writeJSON(w, http.StatusOK, TransportType)
	}
	mux.HandleFunc("GET /x-nmos/connection/v1.1/single/receivers/{id}/transporttype", transportType)
	mux.HandleFunc("GET /x-nmos/connection/v1.1/single/receivers/{id}/transporttype/", transportType)

	staged := func(w http.ResponseWriter, r *http.Request) {
		res, ok := store.Staged(r.PathValue("id"))
		if !ok {
			writeError(w, http.StatusNotFound, "unknown receiver")
			return
		}
		writeJSON(w, http.StatusOK, res)
	}
	mux.HandleFunc("GET /x-nmos/connection/v1.1/single/receivers/{id}/staged", staged)
	mux.HandleFunc("GET /x-nmos/connection/v1.1/single/receivers/{id}/staged/", staged)

	mux.HandleFunc("PATCH /x-nmos/connection/v1.1/single/receivers/{id}/staged", func(w http.ResponseWriter, r *http.Request) {
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
	mux.HandleFunc("POST /x-nmos/connection/v1.1/bulk/receivers", func(w http.ResponseWriter, r *http.Request) {
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
	mux.HandleFunc("GET /x-nmos/connection/v1.1/single/receivers/{id}/active", active)
	mux.HandleFunc("GET /x-nmos/connection/v1.1/single/receivers/{id}/active/", active)

	return mux
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
