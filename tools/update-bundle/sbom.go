package main

// SBOM (HAERTUNG-PLAN.md 98.2): `update-bundle sbom` schreibt eine Software-Stückliste im Format CycloneDX
// (ECMA-424, JSON, specVersion 1.6; Schema und Pflichtfelder im Original gelesen: bomFormat, specVersion; je Komponente type, name).
// Quellen, ohne zusätzliche Werkzeuge im Build:
//   - Rust: `cargo metadata --locked --all-features` (Auflösung aus nodes/Cargo.lock; Pakete, die nur über dev-Abhängigkeiten
//     erreichbar sind, fehlen, weil sie nie ausgeliefert werden), mit Prüfsumme (SHA-256 aus Cargo.lock) und Abhängigkeitsgraph.
//   - Go: `go list -deps` je ausgeliefertem Modul (nur Module, die wirklich in das Binary einfließen; kein Test-Code).
// Nicht enthalten: Systembibliotheken (GStreamer, ffmpeg, libmxl-Abhängigkeiten) — dafür gibt es das Bibliotheksverzeichnis je
// Node-Binary (tools/sbom/libs.sh, Support-Paket). Go-Module tragen keinen Abhängigkeitsgraphen (go list -deps liefert nur Mengen).

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Ausgelieferte Go-Module (Verzeichnisse relativ zum Wurzelverzeichnis).
var sbomGoDirs = []string{"orchestrator", "supervisor", "host-agent", "nodes/mock", "nodes/omp-vfa", "nodes/omp-vfa-vision"}

type cdxBOM struct {
	BOMFormat    string          `json:"bomFormat"`
	SpecVersion  string          `json:"specVersion"`
	SerialNumber string          `json:"serialNumber"`
	Version      int             `json:"version"`
	Metadata     cdxMetadata     `json:"metadata"`
	Components   []cdxComponent  `json:"components"`
	Dependencies []cdxDependency `json:"dependencies,omitempty"`
}

type cdxMetadata struct {
	Timestamp string `json:"timestamp"`
	Tools     struct {
		Components []cdxComponent `json:"components"`
	} `json:"tools"`
	Component cdxComponent `json:"component"`
}

type cdxComponent struct {
	Type       string        `json:"type"`
	BOMRef     string        `json:"bom-ref,omitempty"`
	Name       string        `json:"name"`
	Version    string        `json:"version,omitempty"`
	PURL       string        `json:"purl,omitempty"`
	Licenses   []cdxLicense  `json:"licenses,omitempty"`
	Hashes     []cdxHash     `json:"hashes,omitempty"`
	Properties []cdxProperty `json:"properties,omitempty"`
}

type cdxLicense struct {
	Expression string `json:"expression"`
}
type cdxHash struct {
	Alg     string `json:"alg"`
	Content string `json:"content"`
}
type cdxProperty struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}
type cdxDependency struct {
	Ref       string   `json:"ref"`
	DependsOn []string `json:"dependsOn,omitempty"`
}

// cargoMeta ist der benötigte Ausschnitt von `cargo metadata --format-version 1`.
type cargoMeta struct {
	Packages []struct {
		Name    string  `json:"name"`
		Version string  `json:"version"`
		ID      string  `json:"id"`
		Source  *string `json:"source"`
		License string  `json:"license"`
	} `json:"packages"`
	WorkspaceMembers []string `json:"workspace_members"`
	Resolve          *struct {
		Nodes []struct {
			ID   string `json:"id"`
			Deps []struct {
				Pkg      string `json:"pkg"`
				DepKinds []struct {
					Kind *string `json:"kind"`
				} `json:"dep_kinds"`
			} `json:"deps"`
		} `json:"nodes"`
	} `json:"resolve"`
}

var (
	uuidRe       = regexp.MustCompile(`^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	cargoLockSum = regexp.MustCompile(`(?m)^name = "([^"]+)"\nversion = "([^"]+)"\nsource = "[^"]+"\nchecksum = "([0-9a-f]{64})"`)
)

func newSerial() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40 // RFC 4122 Version 4
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("urn:uuid:%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// spdxExpr macht aus der cargo-Lizenzangabe einen SPDX-Ausdruck (ältere Crates schreiben "MIT/Apache-2.0").
func spdxExpr(l string) string {
	l = strings.TrimSpace(l)
	l = strings.ReplaceAll(l, "/", " OR ")
	return strings.Join(strings.Fields(l), " ")
}

// buildCargoComponents leitet aus den Metadaten die Komponenten und den Graphen ab.
// sums: "name@version" → SHA-256 (aus Cargo.lock). Erreichbarkeit: von den Workspace-Mitgliedern über Kanten, die nicht
// ausschließlich dev sind.
func buildCargoComponents(m cargoMeta, sums map[string]string) ([]cdxComponent, []cdxDependency) {
	byID := map[string]int{}
	for i, p := range m.Packages {
		byID[p.ID] = i
	}
	members := map[string]bool{}
	for _, w := range m.WorkspaceMembers {
		members[w] = true
	}
	next := map[string][]string{}
	if m.Resolve != nil {
		for _, n := range m.Resolve.Nodes {
			for _, d := range n.Deps {
				dev := len(d.DepKinds) > 0
				for _, k := range d.DepKinds {
					if k.Kind == nil || *k.Kind != "dev" {
						dev = false
					}
				}
				if !dev {
					next[n.ID] = append(next[n.ID], d.Pkg)
				}
			}
		}
	}
	reach := map[string]bool{}
	var queue []string
	for w := range members {
		reach[w] = true
		queue = append(queue, w)
	}
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		for _, d := range next[id] {
			if !reach[d] {
				reach[d] = true
				queue = append(queue, d)
			}
		}
	}
	ref := func(i int) string {
		p := m.Packages[i]
		if members[p.ID] {
			return "omp-crate:" + p.Name + "@" + p.Version
		}
		return "pkg:cargo/" + p.Name + "@" + p.Version
	}
	var comps []cdxComponent
	var deps []cdxDependency
	for id := range reach {
		i, ok := byID[id]
		if !ok {
			continue
		}
		p := m.Packages[i]
		c := cdxComponent{Type: "library", BOMRef: ref(i), Name: p.Name, Version: p.Version,
			Properties: []cdxProperty{{Name: "omp:ecosystem", Value: "cargo"}}}
		if members[id] {
			c.Type = "application"
			c.Properties = append(c.Properties, cdxProperty{Name: "omp:workspace-member", Value: "true"})
		} else {
			c.PURL = "pkg:cargo/" + p.Name + "@" + p.Version
			if h, ok := sums[p.Name+"@"+p.Version]; ok {
				c.Hashes = []cdxHash{{Alg: "SHA-256", Content: h}}
			}
			if p.Source != nil && !strings.HasPrefix(*p.Source, "registry+https://github.com/rust-lang/crates.io-index") {
				c.Properties = append(c.Properties, cdxProperty{Name: "omp:source", Value: *p.Source})
			}
		}
		if e := spdxExpr(p.License); e != "" {
			c.Licenses = []cdxLicense{{Expression: e}}
		}
		comps = append(comps, c)
		d := cdxDependency{Ref: c.BOMRef}
		for _, t := range next[id] {
			if j, ok := byID[t]; ok && reach[t] {
				d.DependsOn = append(d.DependsOn, ref(j))
			}
		}
		sort.Strings(d.DependsOn)
		deps = append(deps, d)
	}
	sort.Slice(comps, func(a, b int) bool { return comps[a].BOMRef < comps[b].BOMRef })
	sort.Slice(deps, func(a, b int) bool { return deps[a].Ref < deps[b].Ref })
	return comps, deps
}

// parseGoDeps liest die Ausgabe von `go list -deps -f '{{if .Module}}{{if not .Module.Main}}{{.Module.Path}} {{.Module.Version}}{{end}}{{end}}'`.
func parseGoDeps(out string) map[string]string {
	mods := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) == 2 {
			mods[f[0]+"@"+f[1]] = f[1]
		}
	}
	return mods
}

func buildGoComponents(perBinary map[string]map[string]string) []cdxComponent {
	used := map[string][]string{}
	for dir, mods := range perBinary {
		for k := range mods {
			used[k] = append(used[k], dir)
		}
	}
	var comps []cdxComponent
	for k, dirs := range used {
		path, ver, _ := strings.Cut(k, "@")
		sort.Strings(dirs)
		comps = append(comps, cdxComponent{
			Type: "library", BOMRef: "pkg:golang/" + path + "@" + ver, Name: path, Version: ver, PURL: "pkg:golang/" + path + "@" + ver,
			Properties: []cdxProperty{{Name: "omp:ecosystem", Value: "go"}, {Name: "omp:go-modules", Value: strings.Join(dirs, ",")}},
		})
	}
	sort.Slice(comps, func(a, b int) bool { return comps[a].BOMRef < comps[b].BOMRef })
	return comps
}

func runIn(dir string, name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("%s %s (in %s): %v: %s", name, strings.Join(args, " "), dir, err, strings.TrimSpace(errb.String()))
	}
	return out.String(), nil
}

func sbom(args []string) error {
	fset := flag.NewFlagSet("sbom", flag.ExitOnError)
	root := fset.String("root", ".", "Wurzelverzeichnis des Repos")
	version := fset.String("version", "", "Version der Plattform (Pflicht), z. B. 2026.11.12.1")
	commit := fset.String("commit", "", "Git-Commit")
	out := fset.String("out", "", "Ausgabedatei (.cdx.json, Pflicht)")
	_ = fset.Parse(args)
	if *version == "" || *out == "" {
		return fmt.Errorf("-version und -out sind Pflicht")
	}
	nodes := filepath.Join(*root, "nodes")
	raw, err := runIn(nodes, "cargo", "metadata", "--format-version", "1", "--locked", "--all-features")
	if err != nil {
		return err
	}
	var meta cargoMeta
	if err := json.Unmarshal([]byte(raw), &meta); err != nil {
		return fmt.Errorf("cargo metadata: %w", err)
	}
	sums := map[string]string{}
	if lock, err := os.ReadFile(filepath.Join(nodes, "Cargo.lock")); err == nil {
		for _, m := range cargoLockSum.FindAllStringSubmatch(string(lock), -1) {
			sums[m[1]+"@"+m[2]] = m[3]
		}
	}
	comps, deps := buildCargoComponents(meta, sums)
	perBinary := map[string]map[string]string{}
	for _, d := range sbomGoDirs {
		o, err := runIn(filepath.Join(*root, d), "go", "list", "-deps", "-f",
			"{{if .Module}}{{if not .Module.Main}}{{.Module.Path}} {{.Module.Version}}{{end}}{{end}}", "./...")
		if err != nil {
			return err
		}
		perBinary[d] = parseGoDeps(o)
	}
	comps = append(comps, buildGoComponents(perBinary)...)

	b := cdxBOM{BOMFormat: "CycloneDX", SpecVersion: "1.6", SerialNumber: newSerial(), Version: 1, Components: comps, Dependencies: deps}
	b.Metadata.Timestamp = time.Now().UTC().Format(time.RFC3339)
	b.Metadata.Tools.Components = []cdxComponent{{Type: "application", Name: "update-bundle sbom", Version: "1"}}
	b.Metadata.Component = cdxComponent{Type: "application", BOMRef: "omp", Name: "OpenMediaPlatform", Version: *version}
	if *commit != "" {
		b.Metadata.Component.Properties = []cdxProperty{{Name: "omp:git-commit", Value: *commit}}
	}
	data, err := json.MarshalIndent(b, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(*out, append(data, '\n'), 0o644); err != nil {
		return err
	}
	fmt.Printf("SBOM geschrieben: %s (%d Komponenten: %d Rust/Cargo inkl. Workspace, %d Go-Module)\n", *out, len(comps), len(comps)-len(buildGoComponents(perBinary)), len(buildGoComponents(perBinary)))
	return nil
}
