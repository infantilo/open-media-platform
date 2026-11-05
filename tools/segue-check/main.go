package main

import (
	"fmt"
	"net/http"
	"os"
	"time"
)

// segue-check prüft einen laufenden Segue-Player gegen docs/CONTRACT-SEGUE-PLAYER.md.
//
//	NODE_URL=http://127.0.0.1:PORT [OMP_NODE_TOKEN=…] [FILE=/pfad/zur/datei.wav] go run ./tools/segue-check
//
// Ohne FILE wird nur der Aufbau (Descriptor) geprüft. Rückgabewert 0 = alles bestanden.
func main() {
	base := os.Getenv("NODE_URL")
	if base == "" {
		fmt.Fprintln(os.Stderr, "segue-check: NODE_URL ist erforderlich (z. B. http://127.0.0.1:41123)")
		os.Exit(2)
	}
	c := &client{base: base, token: os.Getenv("OMP_NODE_TOKEN"), http: &http.Client{Timeout: 8 * time.Second}}
	res := Structure(c)
	if f := os.Getenv("FILE"); f != "" {
		res = append(res, Behaviour(c, f)...)
	}
	failed := 0
	for _, r := range res {
		mark := "✔"
		if !r.OK {
			mark = "✘"
			failed++
		}
		fmt.Printf("%s %s", mark, r.Name)
		if r.Info != "" {
			fmt.Printf(" — %s", r.Info)
		}
		fmt.Println()
	}
	if failed > 0 {
		fmt.Printf("\n%d von %d Prüfungen nicht bestanden\n", failed, len(res))
		os.Exit(1)
	}
	fmt.Printf("\nalle %d Prüfungen bestanden\n", len(res))
}
