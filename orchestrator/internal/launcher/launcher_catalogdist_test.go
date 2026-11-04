package launcher

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func importedFixture(t *testing.T) (*Launcher, *fakeNATSRequester) {
	t.Helper()
	fake := &fakeNATSRequester{response: remoteResponse{OK: true, PID: 7}}
	l := newWithStore(sleepyCatalog(), "http://registry", "nats://nats", newFakeInstanceStore(), nil, fake, nil)
	l.importedCatalog[catalogKey("svc", "2")] = CatalogEntry{Type: "svc", Version: "2", Runner: runnerPodman, Image: "localhost/svc:2"}
	return l, fake
}

func TestRemoteStartOfImportedTypeNeedsInstallationOnHost(t *testing.T) {
	l, fake := importedFixture(t)
	want := errors.New("nicht installiert")
	l.SetRemoteTypeCheck(func(nodeType, version, hostID string) error {
		if nodeType != "svc" || version != "2" || hostID != "h1" {
			t.Errorf("Prüfung bekam %q %q %q", nodeType, version, hostID)
		}
		return want
	})
	if _, err := l.Start("svc", "", "h1", nil); !errors.Is(err, want) {
		t.Fatalf("erwartet Prüffehler, bekam %v", err)
	}
	if fake.lastSubject != "" {
		t.Fatal("bei fehlender Installation darf kein Kommando an den Host gehen")
	}
}

func TestRemoteStartOfImportedTypeSendsVersionAndStoresIt(t *testing.T) {
	l, fake := importedFixture(t)
	l.SetRemoteTypeCheck(func(string, string, string) error { return nil })
	inst, err := l.Start("svc", "", "h1", nil)
	if err != nil {
		t.Fatal(err)
	}
	var cmd remoteCommand
	if err := json.Unmarshal(fake.lastPayload, &cmd); err != nil {
		t.Fatal(err)
	}
	if cmd.Version != "2" || cmd.Type != "svc" {
		t.Fatalf("Kommando: %+v", cmd)
	}
	if inst.Version != "2" {
		t.Fatalf("Instanz soll die Version tragen (Neustart, Entfernen-Sperre): %+v", inst)
	}
}

func TestRemoteStartOfStaticAndUnknownTypesIsNotChecked(t *testing.T) {
	l, _ := importedFixture(t)
	l.SetRemoteTypeCheck(func(string, string, string) error { return errors.New("darf nicht aufgerufen werden") })
	// statischer Typ und ein dem Orchestrator unbekannter Typ (Host-Agent hat eigenen Katalog) bleiben unverändert
	for _, typ := range []string{"sleepy", "omp-source"} {
		if _, err := l.Start(typ, "", "h1", nil); err != nil && strings.Contains(err.Error(), "darf nicht") {
			t.Fatalf("%s wurde fälschlich geprüft", typ)
		}
	}
}

func TestImportedEntryLookup(t *testing.T) {
	l, _ := importedFixture(t)
	if e, ok := l.ImportedEntry("svc", ""); !ok || e.Version != "2" {
		t.Fatalf("eindeutiger Typ ohne Version: %+v %v", e, ok)
	}
	if _, ok := l.ImportedEntry("svc", "9"); ok {
		t.Fatal("unbekannte Version")
	}
	if _, ok := l.ImportedEntry("sleepy", ""); ok {
		t.Fatal("statischer Typ ist nicht importiert")
	}
	l.importedCatalog[catalogKey("svc", "3")] = CatalogEntry{Type: "svc", Version: "3", Runner: runnerPodman, Image: "localhost/svc:3"}
	if _, ok := l.ImportedEntry("svc", ""); ok {
		t.Fatal("mehrdeutig ohne Version darf nichts liefern")
	}
}
