// keybundle entpackt oder listet ein verschlüsseltes Schlüsselbündel einer Sicherung (omp-….keys.enc, Audit M8).
//
//	keybundle -file omp-X.keys.enc -list
//	keybundle -file omp-X.keys.enc -out ./wiederhergestellt     (legt die Dateien unter -out ab, Pfade wie gesichert)
//
// Passphrase: OMP_BACKUP_PASSPHRASE oder -passphrase-file.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/backup"
)

func main() {
	file := flag.String("file", "", "Schlüsselbündel (….keys.enc)")
	out := flag.String("out", "", "Zielverzeichnis zum Entpacken")
	list := flag.Bool("list", false, "nur auflisten")
	pf := flag.String("passphrase-file", "", "Datei mit der Passphrase (sonst OMP_BACKUP_PASSPHRASE)")
	flag.Parse()
	pass := os.Getenv("OMP_BACKUP_PASSPHRASE")
	if *pf != "" {
		b, err := os.ReadFile(*pf)
		if err != nil {
			fail(err)
		}
		pass = strings.TrimSpace(string(b))
	}
	if *file == "" || pass == "" || (!*list && *out == "") {
		flag.Usage()
		os.Exit(2)
	}
	data, err := os.ReadFile(*file)
	if err != nil {
		fail(err)
	}
	files, err := backup.OpenKeys(data, pass)
	if err != nil {
		fail(err)
	}
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		fmt.Println(n, len(files[n]), "Bytes")
		if *list {
			continue
		}
		dest := filepath.Join(*out, filepath.Clean("/"+n))
		if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
			fail(err)
		}
		if err := os.WriteFile(dest, files[n], 0o600); err != nil {
			fail(err)
		}
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "keybundle:", err)
	os.Exit(1)
}
