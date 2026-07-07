package connection

import (
	"encoding/json"
	"net/http"
)

// Handler baut den HTTP-Handler für die IS-05-Connection-API-Pfade der
// Receiver: GET/PATCH .../staged, GET .../active.
func Handler(store *ReceiverStore) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /x-nmos/connection/v1.1/single/receivers/{id}/staged", func(w http.ResponseWriter, r *http.Request) {
		res, ok := store.Staged(r.PathValue("id"))
		if !ok {
			http.Error(w, "unknown receiver", http.StatusNotFound)
			return
		}
		writeJSON(w, http.StatusOK, res)
	})

	mux.HandleFunc("PATCH /x-nmos/connection/v1.1/single/receivers/{id}/staged", func(w http.ResponseWriter, r *http.Request) {
		var req PatchRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}

		res, ok := store.PatchStaged(r.PathValue("id"), req)
		if !ok {
			http.Error(w, "unknown receiver", http.StatusNotFound)
			return
		}
		writeJSON(w, http.StatusOK, res)
	})

	mux.HandleFunc("GET /x-nmos/connection/v1.1/single/receivers/{id}/active", func(w http.ResponseWriter, r *http.Request) {
		res, ok := store.Active(r.PathValue("id"))
		if !ok {
			http.Error(w, "unknown receiver", http.StatusNotFound)
			return
		}
		writeJSON(w, http.StatusOK, res)
	})

	return mux
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
