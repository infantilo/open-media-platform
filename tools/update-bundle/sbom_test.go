package main

import (
	"encoding/json"
	"strings"
	"testing"
)

const fixtureMeta = `{
 "packages": [
  {"name":"app","version":"0.1.0","id":"app 0.1.0","source":null,"license":""},
  {"name":"libA","version":"1.0.0","id":"libA 1.0.0","source":"registry+https://github.com/rust-lang/crates.io-index","license":"MIT/Apache-2.0"},
  {"name":"libB","version":"2.0.0","id":"libB 2.0.0","source":"registry+https://github.com/rust-lang/crates.io-index","license":"ISC"},
  {"name":"testonly","version":"3.0.0","id":"testonly 3.0.0","source":"registry+https://github.com/rust-lang/crates.io-index","license":"MIT"},
  {"name":"gitdep","version":"0.2.0","id":"gitdep 0.2.0","source":"git+https://example.org/x#abc","license":"MIT"}
 ],
 "workspace_members": ["app 0.1.0"],
 "resolve": {"nodes": [
  {"id":"app 0.1.0","deps":[
    {"pkg":"libA 1.0.0","dep_kinds":[{"kind":null}]},
    {"pkg":"testonly 3.0.0","dep_kinds":[{"kind":"dev"}]},
    {"pkg":"gitdep 0.2.0","dep_kinds":[{"kind":"build"}]}]},
  {"id":"libA 1.0.0","deps":[{"pkg":"libB 2.0.0","dep_kinds":[{"kind":null}]}]},
  {"id":"libB 2.0.0","deps":[]},{"id":"testonly 3.0.0","deps":[]},{"id":"gitdep 0.2.0","deps":[]}
 ]}
}`

func TestBuildCargoComponents(t *testing.T) {
	var m cargoMeta
	if err := json.Unmarshal([]byte(fixtureMeta), &m); err != nil {
		t.Fatal(err)
	}
	comps, deps := buildCargoComponents(m, map[string]string{"libA@1.0.0": strings.Repeat("a", 64)})
	byRef := map[string]cdxComponent{}
	for _, c := range comps {
		byRef[c.BOMRef] = c
	}
	if _, ok := byRef["pkg:cargo/testonly@3.0.0"]; ok {
		t.Error("nur über dev erreichbares Paket gehört nicht in die SBOM")
	}
	a, ok := byRef["pkg:cargo/libA@1.0.0"]
	if !ok || a.Hashes[0].Alg != "SHA-256" || a.Hashes[0].Content != strings.Repeat("a", 64) {
		t.Errorf("libA mit Prüfsumme erwartet: %+v", a)
	}
	if a.Licenses[0].Expression != "MIT OR Apache-2.0" {
		t.Errorf("Lizenz „MIT/Apache-2.0“ muss SPDX-Ausdruck werden: %q", a.Licenses[0].Expression)
	}
	if _, ok := byRef["pkg:cargo/libB@2.0.0"]; !ok {
		t.Error("transitive Abhängigkeit fehlt")
	}
	app := byRef["omp-crate:app@0.1.0"]
	if app.Type != "application" || app.PURL != "" {
		t.Errorf("Workspace-Mitglied: type application, kein purl erwartet: %+v", app)
	}
	g := byRef["pkg:cargo/gitdep@0.2.0"]
	if len(g.Properties) < 2 || !strings.Contains(g.Properties[len(g.Properties)-1].Value, "git+") {
		t.Errorf("Nicht-crates.io-Quelle muss als Eigenschaft sichtbar sein: %+v", g.Properties)
	}
	for _, d := range deps {
		if d.Ref == "omp-crate:app@0.1.0" && strings.Join(d.DependsOn, ",") != "pkg:cargo/gitdep@0.2.0,pkg:cargo/libA@1.0.0" {
			t.Errorf("Graph von app: %v", d.DependsOn)
		}
	}
	// Reihenfolge deterministisch
	c2, _ := buildCargoComponents(m, nil)
	for i := range comps {
		if comps[i].BOMRef != c2[i].BOMRef {
			t.Fatal("Reihenfolge nicht deterministisch")
		}
	}
}

func TestSerialNumberFormat(t *testing.T) {
	for i := 0; i < 50; i++ {
		if s := newSerial(); !uuidRe.MatchString(s) {
			t.Fatalf("serialNumber verletzt das Schema-Muster: %s", s)
		}
	}
}

func TestParseAndBuildGo(t *testing.T) {
	a := parseGoDeps("github.com/x/y v1.2.3\ngithub.com/x/y v1.2.3\n\nbogus\ngolang.org/z v0.1.0\n")
	b := parseGoDeps("github.com/x/y v1.2.3\n")
	c := buildGoComponents(map[string]map[string]string{"orchestrator": a, "supervisor": b})
	if len(c) != 2 || c[0].PURL != "pkg:golang/github.com/x/y@v1.2.3" {
		t.Fatalf("go: %+v", c)
	}
	if c[0].Properties[1].Value != "orchestrator,supervisor" {
		t.Errorf("Zuordnung zu Modulen: %v", c[0].Properties)
	}
}
