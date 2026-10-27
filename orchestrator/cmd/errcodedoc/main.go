// errcodedoc schreibt docs/FEHLERCODES.md aus dem Fehlercode-Katalog auf die Standardausgabe.
package main

import (
	"flag"
	"fmt"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/errcodes"
)

func main() {
	asJSON := flag.Bool("json", false, "Katalog als JSON (Prüfstand der Oberfläche) statt Markdown")
	flag.Parse()
	if *asJSON {
		fmt.Print(errcodes.CatalogJSON())
		return
	}
	fmt.Print(errcodes.Markdown())
}
