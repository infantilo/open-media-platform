// bundlereport wertet ein Support-Paket oder eine Momentaufnahme (ZIP) offline aus und schreibt den Markdown-Bericht auf die
// Standardausgabe (dieselbe Auswertung wie der Support-Tab, UMSETZUNG.md Kap. 73). Genutzt von der Issue-Vorsortierung
// (.github/workflows/issue-triage.yml). Mit -verdict wird nur die Ampel (ok | warn | err) ausgegeben.
// Die Datei gilt als nicht vertrauenswürdig: nur lesen und auswerten, nie etwas daraus ausführen.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/support/analyze"
)

const maxZip = 64 << 20 // gleiche Größenordnung wie die Obergrenze der Auswertung

func main() {
	lang := flag.String("lang", "de", "Sprache des Berichts (de | en)")
	verdict := flag.Bool("verdict", false, "nur die Ampel ausgeben (ok | warn | err)")
	flag.Parse()
	if flag.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "Aufruf: bundlereport [-lang de|en] [-verdict] <paket.zip>")
		os.Exit(2)
	}
	f, err := os.Open(flag.Arg(0))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxZip+1))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if len(data) > maxZip {
		fmt.Fprintln(os.Stderr, "Paket zu groß")
		os.Exit(1)
	}
	r, err := analyze.Analyze(data, *lang)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Paket nicht auswertbar:", err)
		os.Exit(1)
	}
	if *verdict {
		fmt.Println(r.Verdict)
		return
	}
	fmt.Print(analyze.Markdown(r, *lang))
}
