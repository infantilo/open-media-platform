// update-bundle baut, signiert und prüft OMP-Update-Pakete
// (docs/ENTWURF-SYSTEM-UPDATE.md).
//
//	update-bundle keygen -out <dir>
//	    erzeugt <dir>/update-signing.key (GEHEIM, 0600) und update-trusted.pub
//	update-bundle pack -version V -key <signing.key> -out <paket.tar.gz>
//	    [-orchestrator F] [-supervisor F] [-host-agent F] [-ui-dir D]
//	    [-node omp-source=F ...] [-min-from V] [-migrations a.sql,b.sql]
//	    [-commit C] [-notes T] [-arch linux/amd64] [-unsigned]
//	update-bundle verify -pub <trusted.pub> <paket.tar.gz>
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"github.com/infantilo/openmediaplatform/update"
)

type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "keygen":
		err = keygen(os.Args[2:])
	case "pack":
		err = pack(os.Args[2:])
	case "verify":
		err = verify(os.Args[2:])
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "Fehler:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "Usage: update-bundle keygen|pack|verify …  (siehe Kopfkommentar in main.go)")
	os.Exit(2)
}

func keygen(args []string) error {
	fs := flag.NewFlagSet("keygen", flag.ExitOnError)
	out := fs.String("out", ".", "Zielverzeichnis")
	_ = fs.Parse(args)
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(*out, 0o700); err != nil {
		return err
	}
	keyFile := filepath.Join(*out, "update-signing.key")
	pubFile := filepath.Join(*out, "update-trusted.pub")
	if _, err := os.Stat(keyFile); err == nil {
		return fmt.Errorf("%s existiert bereits — nicht überschrieben", keyFile)
	}
	if err := os.WriteFile(keyFile, []byte(base64.StdEncoding.EncodeToString(priv)+"\n"), 0o600); err != nil {
		return err
	}
	pubLine := fmt.Sprintf("# OMP-Update-Signaturschlüssel %s\n%s\n", update.KeyID(pub), base64.StdEncoding.EncodeToString(pub))
	if err := os.WriteFile(pubFile, []byte(pubLine), 0o644); err != nil {
		return err
	}
	fmt.Printf("Privater Schlüssel (GEHEIM aufbewahren): %s\nÖffentlicher Schlüssel (auf dem Server unter .run/update-trusted.pub ablegen): %s\nKey-ID: %s\n", keyFile, pubFile, update.KeyID(pub))
	return nil
}

func loadPrivateKey(file string) (ed25519.PrivateKey, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(data)))
	if err != nil || len(raw) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("%s: ungültiger privater Schlüssel", file)
	}
	return ed25519.PrivateKey(raw), nil
}

func pack(args []string) error {
	fset := flag.NewFlagSet("pack", flag.ExitOnError)
	version := fset.String("version", "", "Versionsnummer (Pflicht), z. B. 2026.10.0")
	keyFile := fset.String("key", "", "privater Signaturschlüssel")
	unsigned := fset.Bool("unsigned", false, "OHNE Signatur (nur Entwicklung)")
	out := fset.String("out", "", "Ausgabedatei (.tar.gz)")
	orch := fset.String("orchestrator", "", "Orchestrator-Binary")
	sup := fset.String("supervisor", "", "Supervisor-Binary")
	agent := fset.String("host-agent", "", "Host-Agent-Binary")
	uiDir := fset.String("ui-dir", "", "UI-Verzeichnis ui/dist (alle Dateien)")
	minFrom := fset.String("min-from", "", "frühestens installierbar ab Version")
	migrations := fset.String("migrations", "", "Komma-Liste neuer Migrationsdateien")
	commit := fset.String("commit", "", "Git-Commit")
	notes := fset.String("notes", "", "Hinweistext")
	arch := fset.String("arch", runtime.GOOS+"/"+runtime.GOARCH, "Zielarchitektur")
	catalog := fset.String("catalog", "", "Katalog (deploy/catalog.json): alle dort referenzierten omp-* Binaries aus -nodes-dir aufnehmen")
	nodesDir := fset.String("nodes-dir", "", "Verzeichnis der Node-Binaries (z. B. nodes/target/debug), zusammen mit -catalog")
	var nodes multiFlag
	fset.Var(&nodes, "node", "Node-Binary name=datei (mehrfach), z. B. omp-source=nodes/target/debug/omp-source")
	_ = fset.Parse(args)
	if *version == "" || *out == "" {
		return fmt.Errorf("-version und -out sind Pflicht")
	}
	var priv ed25519.PrivateKey
	if !*unsigned {
		if *keyFile == "" {
			return fmt.Errorf("-key fehlt (oder bewusst -unsigned)")
		}
		var err error
		if priv, err = loadPrivateKey(*keyFile); err != nil {
			return err
		}
	}

	var files []update.BuildFile
	add := func(id, src, archive, target string) {
		files = append(files, update.BuildFile{ID: id, Source: src, Path: archive, Target: target})
	}
	if *orch != "" {
		add("orchestrator", *orch, "bin/omp-orchestrator", "bin/omp-orchestrator")
	}
	if *sup != "" {
		add("supervisor", *sup, "bin/omp-supervisor", "bin/omp-supervisor")
	}
	if *agent != "" {
		add("host-agent", *agent, "bin/omp-host-agent", "bin/omp-host-agent")
	}
	if *uiDir != "" {
		var rels []string
		err := filepath.WalkDir(*uiDir, func(p string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			rel, _ := filepath.Rel(*uiDir, p)
			rels = append(rels, filepath.ToSlash(rel))
			return nil
		})
		if err != nil {
			return err
		}
		sort.Strings(rels)
		for _, rel := range rels {
			add("ui/"+rel, filepath.Join(*uiDir, rel), "ui/dist/"+rel, "ui/dist/"+rel)
		}
	}
	if *catalog != "" {
		names, err := catalogNodeNames(*catalog)
		if err != nil {
			return err
		}
		for _, name := range names {
			src := filepath.Join(*nodesDir, name)
			if st, err := os.Stat(src); err != nil || !st.Mode().IsRegular() {
				fmt.Fprintf(os.Stderr, "Hinweis: Node-Binary %s nicht gefunden — nicht im Paket\n", src)
				continue
			}
			nodes = append(nodes, name+"="+src)
		}
	}
	for _, n := range nodes {
		name, file, ok := strings.Cut(n, "=")
		if !ok || name == "" || file == "" {
			return fmt.Errorf("-node erwartet name=datei, bekam %q", n)
		}
		add("node/"+name, file, "nodes/"+name, "node:"+name)
	}
	if len(files) == 0 {
		return fmt.Errorf("nichts zu packen (mindestens eine Komponente angeben)")
	}
	var migs []string
	for _, m := range strings.Split(*migrations, ",") {
		if m = strings.TrimSpace(m); m != "" {
			migs = append(migs, m)
		}
	}
	err := update.Build(*out, update.Manifest{
		Version: *version, GitCommit: *commit, Arch: *arch, MinFromVersion: *minFrom,
		Migrations: migs, Notes: *notes,
	}, priv, files)
	if err != nil {
		return err
	}
	fmt.Printf("Paket geschrieben: %s (%d Komponenten, %s)\n", *out, len(files), map[bool]string{true: "unsigniert", false: "signiert"}[*unsigned])
	return nil
}

// catalogNodeNames liefert die Namen aller omp-* Binaries, auf die
// Katalog-Einträge mit Command zeigen (dedupliziert, sortiert).
func catalogNodeNames(file string) ([]string, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	var cat []struct {
		Command []string `json:"command"`
	}
	if err := json.Unmarshal(data, &cat); err != nil {
		return nil, fmt.Errorf("%s: %w", file, err)
	}
	seen := map[string]bool{}
	var names []string
	for _, e := range cat {
		if len(e.Command) == 0 {
			continue
		}
		name := filepath.Base(e.Command[0])
		if update.CheckTarget("node:"+name) != nil || seen[name] {
			continue
		}
		seen[name] = true
		names = append(names, name)
	}
	sort.Strings(names)
	return names, nil
}

func verify(args []string) error {
	fset := flag.NewFlagSet("verify", flag.ExitOnError)
	pubFile := fset.String("pub", "", "trusted.pub")
	unsigned := fset.Bool("allow-unsigned", false, "auch unsignierte Pakete akzeptieren")
	_ = fset.Parse(args)
	if fset.NArg() != 1 {
		return fmt.Errorf("genau eine Paketdatei angeben")
	}
	var keys []ed25519.PublicKey
	if *pubFile != "" {
		var err error
		if keys, err = update.LoadPublicKeys(*pubFile); err != nil {
			return err
		}
	}
	pkg, err := update.ReadPackage(fset.Arg(0), update.Options{Trusted: keys, AllowUnsigned: *unsigned})
	if err != nil {
		return err
	}
	fmt.Printf("OK  Version %s  signiert=%v (Key %s)  sha256=%s\n", pkg.Manifest.Version, pkg.Signed, pkg.KeyID, pkg.SHA256)
	for _, c := range pkg.Manifest.Components {
		fmt.Printf("    %-28s → %s\n", c.ID, c.Target)
	}
	return nil
}
