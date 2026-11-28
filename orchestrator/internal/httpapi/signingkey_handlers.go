package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

// WithSigningKeyRotator schaltet die Rotation des Token-Signaturschlüssels frei (nil = nicht möglich).
func WithSigningKeyRotator(rotate func(ctx context.Context, dropPrevious bool) error) HandlerOption {
	return func(o *handlerOptions) { o.signingKeyRotator = rotate }
}

// handleRotateSigningKey: POST /api/v1/admin/auth/rotate-signing-key, optional {"dropPrevious":true} (alle
// ausgestellten Tokens sofort ungültig, auch das eigene).
func handleRotateSigningKey(rotate func(context.Context, bool) error, domainAudit DomainAuditLogger) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if rotate == nil {
			http.Error(w, "signing key rotation not available (secret is fixed by OMP_AUTH_JWT_SECRET)", http.StatusNotImplemented)
			return
		}
		var body struct {
			DropPrevious bool `json:"dropPrevious"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if err := rotate(r.Context(), body.DropPrevious); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		logDomainAudit(domainAudit, actorFromRequest(r), "auth", "signing-key", "signing_key_rotated", map[string]any{"dropPrevious": body.DropPrevious})
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}
