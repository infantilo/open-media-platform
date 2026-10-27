package errcodes

import (
	"encoding/json"
	"os"
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
		"threads", "pipeline-queues:main", "pipeline-elements:main", "pipeline:main"} {
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
