package httpapi

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/alarmacks"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/sse"
)

// AlarmAckStore persistiert Quittier-/Maskierstände (implementiert von
// *alarmacks.Store, Nachtrag 243).
type AlarmAckStore interface {
	List() ([]alarmacks.Ack, error)
	Put(alarmacks.Ack) error
	Delete(key string) error
}

// HandlerOption erweitert NewHandler um optionale Abhängigkeiten, ohne
// dessen ohnehin lange Parameterliste (und alle Testaufrufer) zu ändern.
type HandlerOption func(*handlerOptions)

type handlerOptions struct {
	alarmAcks       AlarmAckStore
	scriptCommands  []string
	domainAudit     DomainAuditLogger
	domainAuditR    DomainAuditReader
	assetLinks      AssetLinkService
	storageBackends StorageBackendService
	organizations   OrganizationService
}

// WithAlarmAckStore aktiviert /api/v1/alarms/acks.
func WithAlarmAckStore(s AlarmAckStore) HandlerOption {
	return func(o *handlerOptions) { o.alarmAcks = s }
}

// WithDomainAudit aktiviert das fachliche Domain-Audit (Kapitel 21, B13:
// GET /api/v1/domain-audit-log) und die Protokollierung an den
// Process-/Asset-Mutationsstellen in process_handlers.go/
// asset_handlers.go. Optional wie WithAlarmAckStore — fehlt die Option
// (z. B. in bestehenden Tests), bleiben Log-Aufrufe an den
// Mutationsstellen No-Ops (nil-Check dort), der Endpunkt ist inaktiv.
func WithDomainAudit(logger DomainAuditLogger, reader DomainAuditReader) HandlerOption {
	return func(o *handlerOptions) { o.domainAudit = logger; o.domainAuditR = reader }
}

// WithAssetLinks aktiviert das Verknüpfen von ProcessExecutions mit
// AssetVersions (Kapitel 21 B10, Nachtrag 277) — gleiches optionales
// Muster wie WithAlarmAckStore/WithDomainAudit.
func WithAssetLinks(svc AssetLinkService) HandlerOption {
	return func(o *handlerOptions) { o.assetLinks = svc }
}

// WithStorageBackends aktiviert die super-admin-verwaltete Storage-
// Backend-Registry (Nutzerauftrag 2026-09-24, löst Kapitel 21 B5s
// einzelnes, fest über OMP_MINIO_* konfiguriertes WithObjectStore ab) —
// sowohl die Verwaltungs-Endpunkte (/api/v1/storage-backends) als auch
// die Presigned-Upload-/Download-URLs, die jetzt ein Backend per ID
// wählen statt einer einzigen globalen Instanz. Fehlt die Option (kein
// OMP_STORAGE_SECRET_KEY gesetzt), bleiben beide Endpunkt-Gruppen
// inaktiv statt mit nil-Panic zu crashen — die Handler prüfen
// `backends == nil` selbst und antworten 503.
func WithStorageBackends(svc StorageBackendService) HandlerOption {
	return func(o *handlerOptions) { o.storageBackends = svc }
}

// WithOrganizations aktiviert die Organisations-Verwaltung
// (/api/v1/organizations, Kapitel 21 B14, Nachtrag 283) — gleiches
// optionales Muster wie die anderen With*-Optionen. Fehlt die Option
// (z. B. in bestehenden Tests), bleiben die Endpunkte inaktiv (404 über
// den ungeroutet bleibenden Pfad), das Org-Scoping der übrigen Domänen
// (orgMatches in org_enforcement.go) ist davon unabhängig und bleibt
// aktiv.
func WithOrganizations(svc OrganizationService) HandlerOption {
	return func(o *handlerOptions) { o.organizations = svc }
}

const alarmAckChangedEvent = "alarm.ack.changed"

func handleListAlarmAcks(store AlarmAckStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		acks, err := store.List()
		if err != nil {
			slog.Warn("alarm acks: list failed", "error", err)
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, acks)
	}
}

type putAlarmAckRequest struct {
	Key         string `json:"key"`
	Fingerprint string `json:"fingerprint"`
	Mode        string `json:"mode"`
	Comment     string `json:"comment"`
	// DurationMinutes: nur für Maskieren sinnvoll; 0/fehlend = bis zur
	// Änderung des Alarm-Zustands (Fingerprint), ohne Zeitlimit.
	DurationMinutes int `json:"durationMinutes"`
}

// handlePutAlarmAck quittiert oder maskiert einen Alarm-Zustand. events
// darf nil sein (Tests).
func handlePutAlarmAck(store AlarmAckStore, events EventSubscriber) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req putAlarmAckRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		if req.DurationMinutes < 0 || len(req.Comment) > 500 || len(req.Key) > 300 || len(req.Fingerprint) > 2000 {
			http.Error(w, "invalid duration/comment/key/fingerprint", http.StatusBadRequest)
			return
		}
		user := "unknown"
		if p, ok := principalFromContext(r); ok {
			user = p.Username
		}
		ack := alarmacks.Ack{Key: req.Key, Fingerprint: req.Fingerprint, Mode: req.Mode, Comment: req.Comment, Username: user}
		if req.DurationMinutes > 0 {
			exp := time.Now().Add(time.Duration(req.DurationMinutes) * time.Minute)
			ack.ExpiresAt = &exp
		}
		if err := store.Put(ack); err != nil {
			if err == alarmacks.ErrInvalid {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			slog.Warn("alarm acks: put failed", "error", err)
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		broadcastAlarmAckChanged(events)
		w.WriteHeader(http.StatusNoContent)
	}
}

// handleDeleteAlarmAck hebt Quittierung/Maskierung auf (?key=...) — der
// Key steht in der Query, weil er Doppelpunkte/Schrägstriche enthalten kann.
func handleDeleteAlarmAck(store AlarmAckStore, events EventSubscriber) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := r.URL.Query().Get("key")
		if key == "" {
			http.Error(w, "key required", http.StatusBadRequest)
			return
		}
		if err := store.Delete(key); err != nil {
			slog.Warn("alarm acks: delete failed", "error", err)
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		broadcastAlarmAckChanged(events)
		w.WriteHeader(http.StatusNoContent)
	}
}

func broadcastAlarmAckChanged(events EventSubscriber) {
	if events != nil {
		events.Broadcast(sse.Event{Type: alarmAckChangedEvent, Data: json.RawMessage("null")})
	}
}
