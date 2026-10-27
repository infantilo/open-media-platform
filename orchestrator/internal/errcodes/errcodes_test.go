package errcodes

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestCatalogIsComplete(t *testing.T) {
	codeRe := regexp.MustCompile(`^OMP-\d{4}$`)
	for _, e := range All() {
		if !codeRe.MatchString(e.Code) {
			t.Errorf("%s: ungültiges Format", e.Code)
		}
		if e.Title.DE == "" || e.Title.EN == "" || e.Cause.DE == "" || e.Cause.EN == "" {
			t.Errorf("%s: Titel/Ursache fehlen in einer Sprache", e.Code)
		}
		if len(e.Fix.DE) == 0 || len(e.Fix.DE) != len(e.Fix.EN) {
			t.Errorf("%s: Lösungsschritte fehlen oder DE/EN ungleich (%d/%d)", e.Code, len(e.Fix.DE), len(e.Fix.EN))
		}
		if e.Severity != SevError && e.Severity != SevWarn && e.Severity != SevInfo {
			t.Errorf("%s: Stufe %q", e.Code, e.Severity)
		}
		// Muster müssen im Browser (JavaScript) genauso laufen: keine Inline-Schalter, kein Rückblick.
		for _, bad := range []string{"(?i", "(?s", "(?m", "(?<", "(?=", "(?!"} {
			if strings.Contains(e.Match, bad) {
				t.Errorf("%s: Muster nicht portabel (%s)", e.Code, bad)
			}
		}
		if e.Doc() != "FEHLERCODES.md#"+strings.ToLower(e.Code) {
			t.Errorf("%s: Anker %s", e.Code, e.Doc())
		}
	}
}

// Echte Meldungen aus dem laufenden System und typische Fehlerbilder.
// Echte Meldungen aus dem laufenden System (gemeinsamer Prüfstand mit der Oberfläche: ui/shell/testdata).
func TestClassifyRealMessages(t *testing.T) {
	raw, err := os.ReadFile("../../../ui/shell/testdata/errorcode-samples.json")
	if err != nil {
		t.Fatal(err)
	}
	var fx struct {
		Samples  []struct{ Message, Code string } `json:"samples"`
		Harmless []string                         `json:"harmless"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	for _, sm := range fx.Samples {
		e, ok := Classify(sm.Message)
		if !ok || e.Code != sm.Code {
			t.Errorf("%q\n  → %v (%s), erwartet %s", sm.Message, ok, e.Code, sm.Code)
		}
	}
	for _, harmless := range fx.Harmless {
		if e, ok := Classify(harmless); ok {
			t.Errorf("%q fälschlich als %s erkannt", harmless, e.Code)
		}
	}
}

func TestClassifyTagWinsOverPattern(t *testing.T) {
	// Der Code in der Meldung zählt mehr als jedes Muster (hier stünde sonst „Node nicht erreichbar“).
	e, ok := Classify("[OMP-3005] connection refused by device")
	if !ok || e.Code != "OMP-3005" {
		t.Fatalf("%v %s", ok, e.Code)
	}
	if _, ok := Classify("[OMP-9999] unbekannter Code und sonst nichts"); ok {
		t.Error("unbekannter Code darf nichts erkennen")
	}
	if Tag("OMP-3001", "x") != "[OMP-3001] x" || Tag("OMP-0000", "x") != "x" {
		t.Error("Tag")
	}
}

func TestForCheckPointsToExistingCodes(t *testing.T) {
	for _, id := range []string{"database", "cluster", "disk:/", "memory", "fds", "load", "shm", "host:h1", "host:h1:disk:/", "host:h1:memory", "host:h1:shm",
		"nodes", "online", "registry", "instances-crashed", "crashed", "instances-restarts", "restarts", "instances-outdated", "outdated", "media", "fps", "cpu",
		"threads", "trend:host:h1:host.cpu:deviation", "trend:instance:x:y:proc.rss:drift", "pipeline-queues:main", "pipeline-elements:main", "pipeline:main"} {
		code := ForCheck(id)
		if code == "" {
			t.Errorf("%s: kein Code", id)
			continue
		}
		if _, ok := Lookup(code); !ok {
			t.Errorf("%s → %s: Code nicht im Katalog", id, code)
		}
	}
	if ForCheck("irgendwas") != "" {
		t.Error("unbekannte Befund-ID bekommt keinen Code")
	}
}

func TestDocIsUpToDate(t *testing.T) {
	got, err := os.ReadFile("../../../docs/FEHLERCODES.md")
	if err != nil {
		t.Fatalf("docs/FEHLERCODES.md fehlt: %v (cd orchestrator && go run ./cmd/errcodedoc > ../docs/FEHLERCODES.md)", err)
	}
	if string(got) != Markdown() {
		t.Fatal("docs/FEHLERCODES.md ist veraltet: cd orchestrator && go run ./cmd/errcodedoc > ../docs/FEHLERCODES.md")
	}
}

func TestCatalogFixtureForUIIsUpToDate(t *testing.T) {
	got, err := os.ReadFile("../../../ui/shell/testdata/errorcodes.json")
	if err != nil {
		t.Fatalf("errorcodes.json fehlt: %v (cd orchestrator && go run ./cmd/errcodedoc -json > ../ui/shell/testdata/errorcodes.json)", err)
	}
	if string(got) != CatalogJSON() {
		t.Fatal("ui/shell/testdata/errorcodes.json ist veraltet: cd orchestrator && go run ./cmd/errcodedoc -json > ../ui/shell/testdata/errorcodes.json")
	}
}

func TestKeywordsAgreeWithPatterns(t *testing.T) {
	for _, e := range All() {
		for _, k := range e.Keywords {
			if k != strings.ToLower(k) {
				t.Errorf("%s: Schlüsselwort %q nicht klein geschrieben", e.Code, k)
			}
			got, ok := Classify(k)
			if !ok || got.Code != e.Code {
				t.Errorf("%s: Schlüsselwort %q führt zu %v (%s) — Muster und Schlüsselwort widersprechen sich", e.Code, k, ok, got.Code)
			}
		}
	}
}

func TestRustTableIsUpToDate(t *testing.T) {
	got, err := os.ReadFile("../../../nodes/omp-node-sdk/src/errcodes_table.rs")
	if err != nil {
		t.Fatalf("errcodes_table.rs fehlt: %v (cd orchestrator && go run ./cmd/errcodedoc -rust > ../nodes/omp-node-sdk/src/errcodes_table.rs)", err)
	}
	if string(got) != RustTable() {
		t.Fatal("nodes/omp-node-sdk/src/errcodes_table.rs ist veraltet: cd orchestrator && go run ./cmd/errcodedoc -rust > ../nodes/omp-node-sdk/src/errcodes_table.rs")
	}
}

// Jeder Code, der in Rust oder Go als Text steht („[OMP-nnnn]“), muss im Katalog existieren — ein Tippfehler bliebe sonst unbemerkt.
func TestCodesUsedInSourcesExist(t *testing.T) {
	re := regexp.MustCompile(`OMP-\d{4}`)
	root := "../../.."
	for _, dir := range []string{"nodes", "orchestrator/internal", "host-agent", "jobwire"} {
		_ = filepath.WalkDir(filepath.Join(root, dir), func(p string, d os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() && (d.Name() == "target" || d.Name() == "errcodes" || d.Name() == "node_modules") {
				return filepath.SkipDir
			}
			if d.IsDir() || !(strings.HasSuffix(p, ".rs") || strings.HasSuffix(p, ".go")) || strings.HasSuffix(p, "_test.go") || strings.HasSuffix(p, "errcodes_table.rs") {
				return nil
			}
			b, _ := os.ReadFile(p)
			for _, code := range re.FindAllString(string(b), -1) {
				if _, ok := Lookup(code); !ok {
					t.Errorf("%s: Code %s steht nicht im Katalog", p, code)
				}
			}
			return nil
		})
	}
}
