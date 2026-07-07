// Package uibundle liefert das Beispiel-Node-UI-Bundle des Mock-Nodes aus
// (UMSETZUNG.md B6, ARCHITECTURE.md §4.5): /ui/manifest.json +
// /ui/bundle.js, per --ui-bundle-Flag optional aktivierbar (main.go),
// damit weiterhin die meisten Mock-Instanzen das generische, aus dem
// Descriptor erzeugte Parameter-Panel zeigen und beide Pfade testbar
// bleiben.
package uibundle

import (
	"embed"
	"net/http"
)

//go:embed manifest.json bundle.js
var files embed.FS

// Handler liefert GET /ui/manifest.json und /ui/bundle.js aus den
// eingebetteten Dateien.
func Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ui/manifest.json", serveFile("manifest.json", "application/json"))
	mux.HandleFunc("GET /ui/bundle.js", serveFile("bundle.js", "text/javascript"))
	return mux
}

func serveFile(name, contentType string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, err := files.ReadFile(name)
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", contentType)
		w.Write(data)
	}
}
