package httpapi

import (
	"net/http"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/errcodes"
)

// errorCodeView ist ein Eintrag des Fehlercode-Katalogs in der Sprache der Anfrage (UMSETZUNG.md Kap. 72.8).
type errorCodeView struct {
	Code     string   `json:"code"`
	Severity string   `json:"severity"`
	Title    string   `json:"title"`
	Cause    string   `json:"cause"`
	Steps    []string `json:"steps"`
	// Match ist das Erkennungsmuster (ohne Schalter, Groß-/Kleinschreibung egal): die Oberfläche ordnet damit auch Texte zu, die
	// nicht über den Server laufen (Fehlermeldungen im Startdialog, Absturzmeldungen).
	Match string `json:"match,omitempty"`
	Doc   string `json:"doc"`
}

func errorCodeViews(lang string) []errorCodeView {
	en := lang == "en"
	pick := func(t errcodes.Text) string {
		if en {
			return t.EN
		}
		return t.DE
	}
	out := make([]errorCodeView, 0, len(errcodes.All()))
	for _, e := range errcodes.All() {
		steps := e.Fix.DE
		if en {
			steps = e.Fix.EN
		}
		out = append(out, errorCodeView{Code: e.Code, Severity: e.Severity, Title: pick(e.Title), Cause: pick(e.Cause), Steps: steps, Match: e.Match, Doc: e.Doc()})
	}
	return out
}

// handleErrorCodes liefert GET /api/v1/errorcodes.
func handleErrorCodes(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, errorCodeViews(requestLang(r)))
}
