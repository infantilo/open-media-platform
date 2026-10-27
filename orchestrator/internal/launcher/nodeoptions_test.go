package launcher

import (
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/nodeoptions"
)

func TestWithOptionsPrecedenceAndRestartDetection(t *testing.T) {
	store := nodeoptions.NewStore(dbtest.Open(t))
	l := &Launcher{}
	l.SetNodeOptions(map[string][]nodeoptions.Option{"omp-mxf-player": {
		{Key: "OMP_MEDIA_DIR", Label: "Medien", Type: nodeoptions.TypeString},
		{Key: "OMP_WIDTH", Label: "Breite", Type: nodeoptions.TypeInt},
	}}, store)

	_ = store.Set(nodeoptions.ScopeType, "omp-mxf-player", "OMP_MEDIA_DIR", "/mnt/type", "t")
	_ = store.Set(nodeoptions.ScopeType, "omp-mxf-player", "OMP_WIDTH", "1280", "t")
	_ = store.Set(nodeoptions.ScopeType, "omp-mxf-player", "OMP_UNDECLARED", "x", "t") // nicht im Schema
	_ = store.Set(nodeoptions.ScopeInstance, "i1", "OMP_MEDIA_DIR", "/mnt/inst", "t")

	extra := map[string]string{"OMP_WIDTH": "1920", "OMP_HEIGHT": "1080"} // Workflow-Format
	got := l.withOptions("omp-mxf-player", "i1", "", extra)
	want := map[string]string{"OMP_MEDIA_DIR": "/mnt/inst", "OMP_WIDTH": "1920", "OMP_HEIGHT": "1080"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Rangfolge Typ < Workflow < Instanz:\n got  %v\n want %v", got, want)
	}
	if extra["OMP_MEDIA_DIR"] != "" {
		t.Fatal("extraEnv (Instance.ExtraEnv) darf nicht verändert werden")
	}
	// Andere Instanz ohne eigenen Wert: Typ-Wert.
	if got := l.withOptions("omp-mxf-player", "i2", "", nil); got["OMP_MEDIA_DIR"] != "/mnt/type" || got["OMP_WIDTH"] != "1280" || len(got) != 2 {
		t.Fatalf("Typ-Werte: %v", got)
	}

	l.instances = map[string]Instance{"i1": {ID: "i1", Type: "omp-mxf-player"}, "alt": {ID: "alt", Type: "omp-mxf-player"}}
	l.withOptions("omp-mxf-player", "i1", "", extra) // Start: Stand wird in der Instanz festgehalten
	if l.instances["i1"].OptionsApplied == "" {
		t.Fatal("Optionsstand muss in der Instanz persistiert werden")
	}
	if l.OptionsChanged("omp-mxf-player", "i1") {
		t.Fatal("direkt nach dem Start nicht veraltet")
	}
	_ = store.Set(nodeoptions.ScopeType, "omp-mxf-player", "OMP_WIDTH", "1280", "t")
	if l.OptionsChanged("omp-mxf-player", "i1") {
		t.Fatal("gleicher Wert = keine Änderung")
	}
	_ = store.Set(nodeoptions.ScopeInstance, "i1", "OMP_MEDIA_DIR", "/mnt/anders", "t")
	if !l.OptionsChanged("omp-mxf-player", "i1") {
		t.Fatal("geänderter Wert muss als „Neustart nötig“ erkannt werden")
	}
	l.withOptions("omp-mxf-player", "i1", "", nil) // Neustart übernimmt den Stand
	if l.OptionsChanged("omp-mxf-player", "i1") {
		t.Fatal("nach dem Neustart wieder aktuell")
	}
	// Neustart mit neuer ID erbt die Instanz-Werte der alten.
	if got := l.withOptions("omp-mxf-player", "i9", "i1", nil); got["OMP_MEDIA_DIR"] != "/mnt/anders" {
		t.Fatalf("Vererbung: %v", got)
	}
	if l.OptionsChanged("omp-mxf-player", "unbekannt") {
		t.Fatal("unbekannte Instanz = nicht veraltet")
	}
	// Vor Kapitel 29 gestartet (kein gespeicherter Stand) UND es gibt Typ-Werte → Neustart nötig.
	if !l.OptionsChanged("omp-mxf-player", "alt") {
		t.Fatal("Instanz ohne gespeicherten Stand, aber mit wirksamen Optionswerten: Neustart nötig")
	}
}

func TestWithOptionsWithoutSchemaIsTransparent(t *testing.T) {
	l := &Launcher{}
	in := map[string]string{"A": "b"}
	if got := l.withOptions("x", "i", "", in); !reflect.DeepEqual(got, in) {
		t.Fatalf("%v", got)
	}
}

// Audit 2026-10-23 B1: jeder gestartete Node bekommt das Node-API-Token, ohne dass es in Instance.ExtraEnv landet.
func TestWithOptionsInjectsNodeAPIToken(t *testing.T) {
	l := &Launcher{}
	l.SetNodeAPIToken("tok")
	in := map[string]string{"A": "b"}
	got := l.withOptions("x", "i", "", in)
	if got["OMP_NODE_API_TOKEN"] != "tok" || got["A"] != "b" {
		t.Fatalf("%v", got)
	}
	if _, leaked := in["OMP_NODE_API_TOKEN"]; leaked {
		t.Fatal("token must not be written into the caller's map")
	}
	if got := l.withOptions("x", "i", "", nil); got["OMP_NODE_API_TOKEN"] != "tok" {
		t.Fatalf("nil extraEnv: %v", got)
	}
}

// Startdialog des Flow-Editors: Instanz-Optionen werden vor dem Start gespeichert, der Prozess liest sie schon beim ersten Start.
func TestStartWithOptionsAppliesInstanceValuesAtFirstStart(t *testing.T) {
	disableAutoRestart(t)
	envFile := t.TempDir() + "/env.txt"
	catalog := []CatalogEntry{{Type: "envdump", Label: "EnvDump", Runner: "process", Command: []string{"/bin/sh", "-c", "env > " + envFile}}}
	l := newWithStore(catalog, "http://registry:8010", "nats://nats:4222", newFakeInstanceStore(), nil, nil, nil)
	store := nodeoptions.NewStore(dbtest.Open(t))
	l.SetNodeOptions(map[string][]nodeoptions.Option{"envdump": {
		{Key: "OMP_TEST_NAME", Label: "Name", Type: nodeoptions.TypeString},
		{Key: "OMP_TEST_COUNT", Label: "Zahl", Type: nodeoptions.TypeInt},
	}}, store)

	if _, err := l.StartWithOptions("envdump", "", "", "", nil, map[string]string{"OMP_NOPE": "x"}); !errors.Is(err, ErrInvalidStartOption) {
		t.Fatalf("unbekannte Option: %v", err)
	}
	if _, err := l.StartWithOptions("envdump", "", "", "", nil, map[string]string{"OMP_TEST_COUNT": "viele"}); !errors.Is(err, ErrInvalidStartOption) {
		t.Fatalf("ungültiger Wert: %v", err)
	}
	if len(l.List()) != 0 {
		t.Fatal("bei ungültiger Option darf nichts gestartet werden")
	}

	inst, err := l.StartWithOptions("envdump", "", "", "", nil, map[string]string{"OMP_TEST_NAME": "Regie", "OMP_TEST_COUNT": "7"})
	if err != nil {
		t.Fatal(err)
	}
	var data []byte
	for i := 0; i < 100; i++ {
		data, _ = os.ReadFile(envFile)
		if len(data) > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !strings.Contains(string(data), "OMP_TEST_NAME=Regie") || !strings.Contains(string(data), "OMP_TEST_COUNT=7") {
		t.Fatalf("Optionen im Prozess-Umfeld fehlen:\n%s", data)
	}
	vals, _ := store.Values(nodeoptions.ScopeInstance, inst.ID)
	if vals["OMP_TEST_NAME"] != "Regie" || vals["OMP_TEST_COUNT"] != "7" {
		t.Fatalf("Instanz-Werte: %v", vals)
	}
}
