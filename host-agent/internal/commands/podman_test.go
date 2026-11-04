package commands

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/host-agent/internal/catalog"
	"github.com/infantilo/openmediaplatform/host-agent/internal/microsvc"
	"github.com/infantilo/openmediaplatform/podmanrun"
)

// fakePodmanBin schreibt ein Skript, das `podman` nachbildet: run → Container-ID, wait blockiert bis die Datei
// "<dir>/stop-<id>" existiert (stop legt sie an) bzw. endet sofort mit dem Code aus "<dir>/exit", inspect liefert PID 4242.
func fakePodmanBin(t *testing.T, waitExit string) (dir string) {
	t.Helper()
	dir = t.TempDir()
	script := `#!/bin/sh
echo "$@" >> ` + dir + `/log
case "$1" in
  run) echo cid-1 ;;
  stop) touch ` + dir + `/stop-cid-1 ;;
  wait)
    if [ -n "` + waitExit + `" ]; then echo ` + waitExit + `; exit 0; fi
    i=0; while [ ! -e ` + dir + `/stop-cid-1 ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done; echo 0 ;;
  inspect) case "$*" in *State.Pid*) echo 4242 ;; *) echo true ;; esac ;;
esac
`
	bin := filepath.Join(dir, "podman")
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	old := podmanrun.Binary
	podmanrun.Binary = bin
	t.Cleanup(func() { podmanrun.Binary = old })
	return dir
}

var podEntry = catalog.Entry{Type: "svc", Runner: catalog.RunnerPodman, Image: "localhost/svc:1", Version: "1"}

func TestPodmanStartStopNoExitEvent(t *testing.T) {
	dir := fakePodmanBin(t, "")
	pub := &fakePublisher{}
	e := NewExecutor([]catalog.Entry{podEntry}, "http://127.0.0.1:8010", "nats://127.0.0.1:4222", "http://127.0.0.1:8000", "h1", pub)
	resp := e.Handle(Request{Action: "start", Type: "svc", InstanceID: "i1", Label: "L", NodeAPIToken: "tok"})
	if !resp.OK || resp.PID != 4242 {
		t.Fatalf("start: %+v", resp)
	}
	log, _ := os.ReadFile(filepath.Join(dir, "log"))
	for _, want := range []string{"--name omp-i1", "OMP_INSTANCE_ID=i1", "OMP_NODE_API_TOKEN=tok", "OMP_REGISTRY_URL=http://host.containers.internal:8010", "localhost/svc:1"} {
		if !strings.Contains(string(log), want) {
			t.Errorf("podman-Aufruf ohne %q:\n%s", want, log)
		}
	}
	if got := e.Instances(); len(got) != 1 || got[0].InstanceID != "i1" || got[0].PID != 4242 {
		t.Fatalf("Instances: %+v", got)
	}
	// idempotent
	if r := e.Handle(Request{Action: "start", Type: "svc", InstanceID: "i1"}); !r.OK {
		t.Fatalf("zweiter Start: %+v", r)
	}
	if r := e.Handle(Request{Action: "stop", InstanceID: "i1"}); !r.OK {
		t.Fatalf("stop: %+v", r)
	}
	time.Sleep(300 * time.Millisecond)
	if len(e.Instances()) != 0 {
		t.Fatal("Instanz nach Stop noch registriert")
	}
	if pub.count() != 0 {
		t.Fatalf("erwarteter Stop darf kein ExitEvent auslösen (%d)", pub.count())
	}
}

func TestPodmanUnexpectedExitPublishesEvent(t *testing.T) {
	fakePodmanBin(t, "7")
	pub := &fakePublisher{}
	e := NewExecutor([]catalog.Entry{podEntry}, "", "", "", "h1", pub)
	if r := e.Handle(Request{Action: "start", Type: "svc", InstanceID: "crash"}); !r.OK {
		t.Fatalf("start: %+v", r)
	}
	deadline := time.Now().Add(2 * time.Second)
	for pub.count() == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if pub.count() != 1 {
		t.Fatalf("ExitEvent erwartet, count=%d", pub.count())
	}
	_, data := pub.last()
	var ev ExitEvent
	json.Unmarshal(data, &ev)
	if ev.InstanceID != "crash" || ev.ExitCode != 7 {
		t.Fatalf("event: %+v", ev)
	}
}

func TestPodmanStartFailureIsReported(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "podman")
	os.WriteFile(bin, []byte("#!/bin/sh\necho 'image not known' >&2\nexit 125\n"), 0o755)
	old := podmanrun.Binary
	podmanrun.Binary = bin
	defer func() { podmanrun.Binary = old }()
	e := NewExecutor([]catalog.Entry{podEntry}, "", "", "", "h1", nil)
	r := e.Handle(Request{Action: "start", Type: "svc", InstanceID: "x"})
	if r.OK || !strings.Contains(r.Error, "image not known") {
		t.Fatalf("Fehler mit Podman-Meldung erwartet: %+v", r)
	}
	if len(e.Instances()) != 0 {
		t.Fatal("fehlgeschlagener Start darf nichts registrieren")
	}
}

func TestInstalledMicroserviceStartsByVersion(t *testing.T) {
	fakePodmanBin(t, "")
	e := NewExecutor(nil, "", "", "", "h1", nil)
	store, _ := microsvc.NewStore(t.TempDir(), microsvc.ParseAllow(""))
	e.SetMicroservices(store)
	if r := e.Handle(Request{Action: "start", Type: "svc", InstanceID: "a"}); r.OK {
		t.Fatal("nicht installierter Typ darf nicht starten")
	}
	if r := e.Handle(Request{Action: "catalog-list"}); !r.OK || r.Detail != "null" {
		t.Fatalf("catalog-list leer: %+v", r)
	}
}

func TestInstallBundleRejectsForeignPathAndMissingKey(t *testing.T) {
	e := NewExecutor(nil, "", "", "http://127.0.0.1:8000", "h1", nil)
	store, _ := microsvc.NewStore(t.TempDir(), microsvc.ParseAllow(""))
	e.SetMicroservices(store)
	for _, p := range []string{"http://evil/x", "/api/v1/host-updates/x", "/api/v1/host-catalog/../x"} {
		r := e.Handle(Request{Action: "catalog-install", BundlePath: p, BundleSHA256: "abc"})
		if r.OK || !strings.Contains(r.Error, "nicht erlaubt") {
			t.Errorf("%q: %+v", p, r)
		}
	}
	r := e.Handle(Request{Action: "catalog-install", BundlePath: "/api/v1/host-catalog/x?token=t", BundleSHA256: "abc"})
	if r.OK || !strings.Contains(r.Error, "Verteilschlüssel") {
		t.Fatalf("ohne Schlüssel: %+v", r)
	}
	// ohne aktivierten Store
	e2 := NewExecutor(nil, "", "", "", "h1", nil)
	if r := e2.Handle(Request{Action: "catalog-list"}); r.OK {
		t.Fatal("ohne Store muss abgelehnt werden")
	}
}
