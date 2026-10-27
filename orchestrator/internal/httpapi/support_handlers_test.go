package httpapi

import (
	"errors"

	"archive/zip"
	"bytes"
	"encoding/json"
	"github.com/infantilo/openmediaplatform/jobwire"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/support"
)

// supportTestMux: ein Router mit Attrappen der Endpunkte, aus denen Selbsttest und Paket sammeln. Die Attrappen
// prüfen, dass die Anmeldedaten der aufrufenden Person durchgereicht werden.
func supportTestMux(t *testing.T) *http.ServeMux { return supportTestMuxHosts(t, "") }

// supportTestMuxHosts: wie supportTestMux; hostsJSON (nicht leer) ersetzt die Hostliste.
func supportTestMuxHosts(t *testing.T, hostsJSON string) *http.ServeMux {
	mux := http.NewServeMux()
	serve := func(path, body string) {
		mux.HandleFunc("GET "+path, func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer caller-token" {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			io.WriteString(w, body)
		})
	}
	serve("/api/v1/logs", `[{"message":"db login failed password=hunter2"}]`)
	if hostsJSON == "" {
		hostsJSON = `[{"id":"h1","label":"Regie","metrics":{"cpuPercent":10,"memUsedBytes":1,"memTotalBytes":10,"receivedAt":"` + time.Now().UTC().Format(time.RFC3339) + `"}},
	  {"id":"h2","label":"Cut","metrics":{"cpuPercent":10,"memUsedBytes":1,"memTotalBytes":10,"receivedAt":"2020-01-01T00:00:00Z"}}]`
	}
	serve("/api/v1/hosts", hostsJSON)
	serve("/api/v1/instances", `[{"id":"i1","type":"omp-source","label":"Kamera 1","crashed":true,"crashMessage":"exit 1"}]`)
	serve("/api/v1/nodes", `[{"id":"n1","label":"Quelle","online":true},{"id":"n2","label":"Mixer","online":false}]`)
	serve("/api/v1/admin/settings/system", `{"OMP_DB_PASSWORD":"s3cret","launchSecret":"abc","name":"ok"}`)
	return mux
}

func authed(path string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, path, nil)
	r.Header.Set("Authorization", "Bearer caller-token")
	return r
}

func TestSelftestHandlerUsesCallerCredentials(t *testing.T) {
	rec := httptest.NewRecorder()
	handleSelftest(supportTestMux(t), "", nil, nil)(rec, authed("/api/v1/admin/selftest"))
	if rec.Code != http.StatusOK {
		t.Fatal(rec.Code, rec.Body.String())
	}
	var rep support.Report
	if err := json.Unmarshal(rec.Body.Bytes(), &rep); err != nil {
		t.Fatal(err)
	}
	ids := map[string]support.Level{}
	for _, c := range rep.Checks {
		ids[c.ID] = c.Level
	}
	if rep.Level != support.LevelErr || ids["host:h2"] != support.LevelErr || ids["host:h1"] != support.LevelOK ||
		ids["instances-crashed"] != support.LevelErr || ids["nodes"] != support.LevelWarn || ids["database"] != support.LevelOK {
		t.Fatalf("report = %+v", rep)
	}

	// Ohne Anmeldedaten sieht der Selbsttest nichts (kein Rechte-Umweg über den Router).
	rec = httptest.NewRecorder()
	handleSelftest(supportTestMux(t), "", nil, nil)(rec, httptest.NewRequest(http.MethodGet, "/api/v1/admin/selftest", nil))
	var anon support.Report
	_ = json.Unmarshal(rec.Body.Bytes(), &anon)
	if c := func() *support.Check {
		for i := range anon.Checks {
			if anon.Checks[i].ID == "host:h1" {
				return &anon.Checks[i]
			}
		}
		return nil
	}(); c != nil {
		t.Fatalf("Hosts ohne Anmeldung sichtbar: %+v", c)
	}
}

func TestSupportBundleZipIsRedactedAndComplete(t *testing.T) {
	rec := httptest.NewRecorder()
	handleSupportBundle(supportTestMux(t), "", nil, nil)(rec, authed("/api/v1/admin/support-bundle?minutes=30"))
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "application/zip" ||
		!strings.Contains(rec.Header().Get("Content-Disposition"), "omp-support-") {
		t.Fatal(rec.Code, rec.Header())
	}
	zr, err := zip.NewReader(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	all := map[string]string{}
	for _, f := range zr.File {
		rc, _ := f.Open()
		b, _ := io.ReadAll(rc)
		rc.Close()
		all[f.Name] = string(b)
	}
	for _, name := range []string{"README.txt", "manifest.json", "selftest.json", "api/hosts.json", "api/instances.json", "api/settings-system.json", "logs/all-recent.json", "orchestrator/goroutines.txt", "system/os-release.txt"} {
		if _, ok := all[name]; !ok {
			t.Errorf("%s fehlt im Paket", name)
		}
	}
	for name, body := range all {
		if strings.HasPrefix(name, "system/") {
			continue // echte Ausgabe dieses Rechners (u. a. die Kommandozeile des Testlaufs), nicht aus den Attrappen
		}
		for _, secret := range []string{"hunter2", "s3cret", "caller-token"} {
			if strings.Contains(body, secret) {
				t.Errorf("%s enthält %q", name, secret)
			}
		}
	}
	if !strings.Contains(all["api/settings-system.json"], `"name": "ok"`) {
		t.Errorf("Unbedenkliches fehlt: %s", all["api/settings-system.json"])
	}
	var man support.Manifest
	if err := json.Unmarshal([]byte(all["manifest.json"]), &man); err != nil {
		t.Fatal(err)
	}
	if man.Window != "30 min" || man.Failed["api/graph.json"] == "" {
		t.Errorf("manifest = %+v (fehlende Teile müssen benannt sein)", man)
	}
}

// fakeSysinfo: h1 hat eine fast volle Platte und einen Textbericht, h3 ist ein älterer Agent ohne die Aktion.
func fakeSysinfo(id string) (jobwire.Sysinfo, error) {
	switch id {
	case "h1":
		return jobwire.Sysinfo{Hostname: "regie", CPUs: 4, MemTotal: 8 << 30, MemAvailable: 4 << 30,
			Disks: []jobwire.DiskUse{{Path: "/", Label: "System", FreeBytes: 1 << 30, TotalBytes: 100 << 30}},
			Files: map[string]string{"processes.txt": "1 init\n2 cmd --password hunter2\n", "os-release.txt": "Debian"}}, nil
	}
	return jobwire.Sysinfo{}, errors.New("unknown action \"sysinfo\"")
}

func hostSysTestMux(t *testing.T) *http.ServeMux {
	now := time.Now().UTC().Format(time.RFC3339)
	return supportTestMuxHosts(t, `[{"id":"h1","label":"Regie","metrics":{"cpuPercent":10,"memUsedBytes":1,"memTotalBytes":10,"receivedAt":"`+now+`"}},
		  {"id":"h3","label":"Alt","metrics":{"cpuPercent":10,"memUsedBytes":1,"memTotalBytes":10,"receivedAt":"`+now+`"}}]`)
}

func TestSelftestAndBundleIncludeHostSysinfo(t *testing.T) {
	calls := 0
	sc := newSysCache(func(id string) (jobwire.Sysinfo, error) { calls++; return fakeSysinfo(id) }, time.Minute)
	mux := hostSysTestMux(t)

	rec := httptest.NewRecorder()
	handleSelftest(mux, "", nil, sc)(rec, authed("/api/v1/admin/selftest"))
	var rep support.Report
	if err := json.Unmarshal(rec.Body.Bytes(), &rep); err != nil {
		t.Fatal(err)
	}
	var disk *support.Check
	for i := range rep.Checks {
		if rep.Checks[i].ID == "host:h1:disk:/" {
			disk = &rep.Checks[i]
		}
	}
	if disk == nil || disk.Level != support.LevelErr || disk.Group != "Hosts: Regie" {
		t.Fatalf("Platte des Hosts fehlt oder falsch: %+v", disk)
	}
	if calls != 2 {
		t.Fatalf("calls = %d, erwartet je ein Abruf pro Host", calls)
	}
	// Zweiter Selbsttest innerhalb der Gültigkeit: aus dem Zwischenspeicher.
	handleSelftest(mux, "", nil, sc)(httptest.NewRecorder(), authed("/api/v1/admin/selftest"))
	if calls != 2 {
		t.Fatalf("Zwischenspeicher nicht genutzt: calls = %d", calls)
	}

	// Das Paket fragt frisch ab, schwärzt den Bericht und nennt den älteren Agent unter failed.
	rec = httptest.NewRecorder()
	handleSupportBundle(mux, "", nil, sc)(rec, authed("/api/v1/admin/support-bundle"))
	zr, err := zip.NewReader(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	all := map[string]string{}
	for _, f := range zr.File {
		rc, _ := f.Open()
		b, _ := io.ReadAll(rc)
		rc.Close()
		all[f.Name] = string(b)
	}
	proc := all["hosts/Regie-h1/processes.txt"]
	if proc == "" || strings.Contains(proc, "hunter2") || !strings.Contains(proc, "[entfernt]") {
		t.Fatalf("Prozessliste des Hosts: %q", proc)
	}
	if _, ok := all["hosts/Regie-h1/sysinfo.json"]; !ok {
		t.Error("sysinfo.json des Hosts fehlt")
	}
	var man support.Manifest
	_ = json.Unmarshal([]byte(all["manifest.json"]), &man)
	if !strings.Contains(man.Failed["hosts/Alt-h3/sysinfo"], "unknown action") {
		t.Errorf("älterer Agent nicht im manifest: %v", man.Failed)
	}
}
