// Command routetable liest die Routenregistrierungen des Orchestrators (`mux.HandleFunc`/`mux.Handle` in
// internal/httpapi) per AST und gibt die Routentabelle aus: Methode, Pfad, Rechtepflicht, Bedingung der Registrierung,
// Fundstelle, zugeordnete Domäne. Grundlage des Vorher/Nachher-Vergleichs beim Umzug in Module (UMSETZUNG.md Kapitel 36):
//
//	go run ./cmd/routetable                 # Tabelle (JSON) auf stdout
//	go run ./cmd/routetable -check FILE     # vergleicht gegen die Golden-Datei, Exit 1 bei Abweichung
//
// Die Fundstelle (Datei/Zeile) gehört bewusst NICHT zum Vergleich: ein Umzug verschiebt Code, nicht Verhalten.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Route ist ein Eintrag der Tabelle.
type Route struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	// Auth: none | auth | verb:<Verb> (global) | node-verb:<Verb> | custom:<Ausdruck>
	Auth string `json:"auth"`
	// When: Bedingung der Registrierung (z. B. `options.playout != nil`), leer = immer.
	When string `json:"when,omitempty"`
	// Domain: core | playout | audio-rules | cloud (Zuordnung nach Pfadpräfix, s. domainOf).
	Domain string `json:"domain"`
	// Source gehört nicht zum Vergleich.
	Source string `json:"source,omitempty"`
}

func domainOf(path string) string {
	switch {
	case strings.HasPrefix(path, "/api/v1/playout"):
		return "playout"
	case strings.HasPrefix(path, "/api/v1/audio-rules"):
		return "audio-rules"
	case strings.HasPrefix(path, "/api/v1/cloud"):
		return "cloud"
	}
	return "core"
}

func expr(fset *token.FileSet, e ast.Expr) string {
	var b strings.Builder
	_ = printer.Fprint(&b, fset, e)
	return strings.Join(strings.Fields(b.String()), " ")
}

// authOf bestimmt die Rechtepflicht aus dem äußersten Aufruf des Handler-Ausdrucks.
func authOf(fset *token.FileSet, h ast.Expr) string {
	call, ok := h.(*ast.CallExpr)
	if !ok {
		return "none"
	}
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return "custom:" + expr(fset, call.Fun)
	}
	switch sel.Sel.Name {
	case "requireAuth":
		return "auth"
	case "requireVerbGlobal":
		if len(call.Args) > 0 {
			return "verb:" + strings.TrimPrefix(expr(fset, call.Args[0]), "authz.Verb")
		}
	case "requireVerbOnNode":
		if len(call.Args) > 0 {
			return "node-verb:" + strings.TrimPrefix(expr(fset, call.Args[0]), "authz.Verb")
		}
	}
	return "custom:" + expr(fset, call.Fun)
}

func collect(dir string) ([]Route, error) {
	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, dir, func(fi os.FileInfo) bool { return !strings.HasSuffix(fi.Name(), "_test.go") }, 0)
	if err != nil {
		return nil, err
	}
	var routes []Route
	for _, pkg := range pkgs {
		for fname, f := range pkg.Files {
			// Bedingungen: Stack der umgebenden `if`-Bedingungen.
			var conds []string
			var walk func(n ast.Node)
			walk = func(n ast.Node) {
				ast.Inspect(n, func(x ast.Node) bool {
					switch v := x.(type) {
					case *ast.IfStmt:
						c := expr(fset, v.Cond)
						conds = append(conds, c)
						walk(v.Body)
						conds = conds[:len(conds)-1]
						if v.Else != nil {
							conds = append(conds, "!("+c+")")
							walk(v.Else)
							conds = conds[:len(conds)-1]
						}
						return false
					case *ast.CallExpr:
						sel, ok := v.Fun.(*ast.SelectorExpr)
						if !ok || (sel.Sel.Name != "HandleFunc" && sel.Sel.Name != "Handle") {
							return true
						}
						if id, ok := sel.X.(*ast.Ident); !ok || id.Name != "mux" || len(v.Args) < 2 {
							return true
						}
						lit, ok := v.Args[0].(*ast.BasicLit)
						if !ok || lit.Kind != token.STRING {
							return true
						}
						pattern, _ := strconv.Unquote(lit.Value)
						method, path := "ANY", pattern
						if i := strings.Index(pattern, " "); i > 0 {
							method, path = pattern[:i], pattern[i+1:]
						}
						pos := fset.Position(v.Pos())
						routes = append(routes, Route{
							Method: method, Path: path, Auth: authOf(fset, v.Args[1]),
							When: strings.Join(conds, " && "), Domain: domainOf(path),
							Source: fmt.Sprintf("%s:%d", filepath.Base(fname), pos.Line),
						})
					}
					return true
				})
			}
			walk(f)
		}
	}
	sort.Slice(routes, func(i, j int) bool {
		if routes[i].Path != routes[j].Path {
			return routes[i].Path < routes[j].Path
		}
		return routes[i].Method < routes[j].Method
	})
	return routes, nil
}

// key ist die Vergleichsidentität einer Route (ohne Fundstelle).
func key(r Route) string {
	return strings.Join([]string{r.Method, r.Path, r.Auth, r.When, r.Domain}, "|")
}

func main() {
	dir := flag.String("dir", "internal/httpapi", "Verzeichnis mit den Routenregistrierungen")
	check := flag.String("check", "", "Golden-Datei: Abweichung → Exit 1")
	strip := flag.Bool("strip-source", false, "Fundstellen weglassen (für die Golden-Datei)")
	flag.Parse()
	routes, err := collect(*dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if *strip || *check != "" {
		for i := range routes {
			routes[i].Source = ""
		}
	}
	if *check != "" {
		raw, err := os.ReadFile(*check)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		var want []Route
		if err := json.Unmarshal(raw, &want); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		have := map[string]int{}
		for _, r := range routes {
			have[key(r)]++
		}
		diff := 0
		for _, r := range want {
			if have[key(r)] == 0 {
				fmt.Printf("FEHLT   %s %s [%s] %s\n", r.Method, r.Path, r.Auth, r.When)
				diff++
			}
			have[key(r)]--
		}
		for _, r := range routes {
			if have[key(r)] > 0 {
				fmt.Printf("NEU     %s %s [%s] %s\n", r.Method, r.Path, r.Auth, r.When)
				have[key(r)]--
				diff++
			}
		}
		if diff > 0 {
			fmt.Printf("%d Abweichung(en) gegen %s\n", diff, *check)
			os.Exit(1)
		}
		fmt.Printf("Routentabelle identisch (%d Routen)\n", len(routes))
		return
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(routes)
}
