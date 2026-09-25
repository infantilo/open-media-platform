package httpapi

import (
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/ffmpegtools"
)

// FFmpegToolsService ist das schmale Interface, das dieses Paket von
// *ffmpegtools.Store braucht — eigenes Interface statt des konkreten
// Typs, gleiches Testnaht-Muster wie ProcessEngineService/NodeLister
// (main.go injiziert *ffmpegtools.Store, Tests können ein Fake
// einsetzen).
type FFmpegToolsService interface {
	Available() bool
	Encoders() ([]ffmpegtools.CodecEntry, error)
	Decoders() ([]ffmpegtools.CodecEntry, error)
	Formats() ([]ffmpegtools.FormatEntry, error)
	PixFmts() ([]ffmpegtools.PixFmtEntry, error)
	Filters() ([]ffmpegtools.FilterEntry, error)
	Detail(kind, name string) (*ffmpegtools.Detail, error)
}

// WithFFmpegTools aktiviert `/api/v1/tools/ffmpeg/...` (UMSETZUNG.md
// Kapitel 22, W1) — optional wie WithAlarmAckStore: main.go übergibt sie
// nur, wenn ffmpeg tatsächlich in der Script-Allow-Liste steht
// (dieselbe exec.LookPath-Ermittlung), bestehende Tests bleiben ohne
// die Option unverändert lauffähig.
func WithFFmpegTools(svc FFmpegToolsService) HandlerOption {
	return func(o *handlerOptions) { o.ffmpegTools = svc }
}

// handleFFmpegCapabilities liefert GET /api/v1/tools/ffmpeg/capabilities
// — ob ffmpeg auf diesem Host überhaupt introspizierbar ist, damit die
// Wizard-UI ohne einen fehlschlagenden Folge-Request weiß, ob sie den
// Experten-Rohargument-Modus als einzige Option anbieten muss.
func handleFFmpegCapabilities(svc FFmpegToolsService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if svc == nil {
			writeJSON(w, http.StatusOK, map[string]any{"available": false})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"available": svc.Available()})
	}
}

// handleFFmpegList liefert GET /api/v1/tools/ffmpeg/{encoders,decoders,
// formats,pix-fmts,filters} — welche Liste, entscheidet `which`
// (main.go registriert diese Funktion je einmal pro Listenart, s.
// server.go).
func handleFFmpegList(svc FFmpegToolsService, which string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if svc == nil || !svc.Available() {
			http.Error(w, "ffmpeg ist auf diesem Host nicht verfügbar", http.StatusNotFound)
			return
		}
		var (
			payload any
			err     error
		)
		switch which {
		case "encoders":
			payload, err = svc.Encoders()
		case "decoders":
			payload, err = svc.Decoders()
		case "formats":
			payload, err = svc.Formats()
		case "pix-fmts":
			payload, err = svc.PixFmts()
		case "filters":
			payload, err = svc.Filters()
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, payload)
	}
}

// handleFFmpegDetail liefert GET /api/v1/tools/ffmpeg/{kind}/{name} —
// die AVOptions eines einzelnen Encoders/Decoders/Muxers/Demuxers/
// Filters (Kind per URL-Pfadsegment, gegen ffmpegtools.ValidKind
// geprüft statt roh an `ffmpeg -h` durchgereicht).
func handleFFmpegDetail(svc FFmpegToolsService) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if svc == nil || !svc.Available() {
			http.Error(w, "ffmpeg ist auf diesem Host nicht verfügbar", http.StatusNotFound)
			return
		}
		kind := r.PathValue("kind")
		name := r.PathValue("name")
		if !ffmpegtools.ValidKind(kind) {
			http.Error(w, "unbekannte Kategorie: "+kind, http.StatusBadRequest)
			return
		}
		detail, err := svc.Detail(kind, name)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, detail)
	}
}
