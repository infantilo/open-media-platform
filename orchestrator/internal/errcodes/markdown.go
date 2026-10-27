package errcodes

import (
	"encoding/json"
	"fmt"
	"strings"
)

var groups = []struct {
	Prefix string
	Title  string
}{
	{"OMP-1", "1xxx — Plattform und Rechner"},
	{"OMP-2", "2xxx — Nodes und Instanzen"},
	{"OMP-3", "3xxx — Medien und Pipeline"},
	{"OMP-4", "4xxx — Verbindungen"},
	{"OMP-5", "5xxx — Hosts"},
	{"OMP-6", "6xxx — Zugriff"},
	{"OMP-7", "7xxx — Update"},
}

// Markdown erzeugt docs/FEHLERCODES.md aus dem Katalog (ein Test hält die Datei aktuell:
// go run ./cmd/errcodedoc > ../docs/FEHLERCODES.md).
func Markdown() string {
	var b strings.Builder
	b.WriteString("# Fehlercodes\n\n")
	b.WriteString("<!-- GENERIERT aus orchestrator/internal/errcodes/catalog.go — nicht von Hand ändern: `cd orchestrator && go run ./cmd/errcodedoc > ../docs/FEHLERCODES.md` -->\n\n")
	b.WriteString("Jeder bekannte Fehler hat einen stabilen Code **OMP-nnnn**. Die Oberfläche zeigt ihn mit Ursache und Lösungsschritten an\n")
	b.WriteString("(Administration → Diagnose, Support, Node-Diagnose 🩺, Startdialog). Dieselbe Liste liegt im Support-Paket (`api/errorcodes.json`).\n")
	b.WriteString("Meldungen lassen sich auch selbst mit einem Code versehen: eine Meldung mit `[OMP-3001]` wird direkt zugeordnet.\n\n")
	for _, g := range groups {
		first := true
		for _, e := range catalog {
			if !strings.HasPrefix(e.Code, g.Prefix) {
				continue
			}
			if first {
				fmt.Fprintf(&b, "## %s\n\n", g.Title)
				first = false
			}
			sev := map[string]string{SevError: "Fehler", SevWarn: "Hinweis", SevInfo: "Information"}[e.Severity]
			fmt.Fprintf(&b, "### %s\n\n**%s** — %s\n\n", e.Code, e.Title.DE, sev)
			fmt.Fprintf(&b, "**Ursache:** %s\n\n**Was tun?**\n\n", e.Cause.DE)
			for i, s := range e.Fix.DE {
				fmt.Fprintf(&b, "%d. %s\n", i+1, s)
			}
			b.WriteString("\n")
		}
	}
	return b.String()
}

// CatalogJSON ist der Katalog (Deutsch) als JSON — Prüfstand der Oberfläche: die Deno-Tests lassen die Muster dort gegen dieselben
// Beispielmeldungen laufen wie die Go-Tests, damit RE2 und JavaScript nie auseinanderlaufen.
func CatalogJSON() string {
	type view struct {
		Code     string   `json:"code"`
		Severity string   `json:"severity"`
		Title    string   `json:"title"`
		Cause    string   `json:"cause"`
		Steps    []string `json:"steps"`
		Match    string   `json:"match,omitempty"`
		Doc      string   `json:"doc"`
	}
	out := make([]view, 0, len(catalog))
	for _, e := range catalog {
		out = append(out, view{e.Code, e.Severity, e.Title.DE, e.Cause.DE, e.Fix.DE, e.Match, e.Doc()})
	}
	b, _ := json.MarshalIndent(out, "", " ")
	return string(b) + "\n"
}

// RustTable erzeugt nodes/omp-node-sdk/src/errcodes_table.rs: Code → Schlüsselwörter, in der Reihenfolge des Katalogs. Die Nodes
// ordnen ihre Meldungen damit zu (omp_node_sdk::errcode::tag), ohne eigene Regel-Kopie und ohne Regex-Bibliothek.
func RustTable() string {
	var b strings.Builder
	b.WriteString("// GENERIERT aus orchestrator/internal/errcodes/catalog.go — nicht von Hand ändern:\n")
	b.WriteString("//   cd orchestrator && go run ./cmd/errcodedoc -rust > ../nodes/omp-node-sdk/src/errcodes_table.rs\n")
	b.WriteString("// Reihenfolge = Reihenfolge der Zuordnung; Schlüsselwörter sind klein geschrieben (Teilstring-Suche).\n\n")
	b.WriteString("pub(crate) const TABLE: &[(&str, &[&str])] = &[\n")
	for _, e := range catalog {
		if len(e.Keywords) == 0 {
			continue
		}
		fmt.Fprintf(&b, "    (%q, &[", e.Code)
		for i, k := range e.Keywords {
			if i > 0 {
				b.WriteString(", ")
			}
			fmt.Fprintf(&b, "%q", k)
		}
		b.WriteString("]),\n")
	}
	b.WriteString("];\n")
	return b.String()
}
