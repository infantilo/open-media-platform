package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/config"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/nodeoptions"
)

type memValues struct{ m map[string]string } // "scope|subject|key" → value

func (v *memValues) Values(scope, subject string) (map[string]string, error) {
	out := map[string]string{}
	for k, val := range v.m {
		p := strings.SplitN(k, "|", 3)
		if p[0] == scope && p[1] == subject {
			out[p[2]] = val
		}
	}
	return out, nil
}
func (v *memValues) AllInstanceValues() (map[string]map[string]string, error) {
	out := map[string]map[string]string{}
	for k, val := range v.m {
		p := strings.SplitN(k, "|", 3)
		if p[0] == "instance" {
			if out[p[1]] == nil {
				out[p[1]] = map[string]string{}
			}
			out[p[1]][p[2]] = val
		}
	}
	return out, nil
}
func (v *memValues) MoveInstance(from, to string) error {
	for k, val := range v.m {
		if strings.HasPrefix(k, "instance|"+from+"|") {
			v.m["instance|"+to+"|"+strings.SplitN(k, "|", 3)[2]] = val
			delete(v.m, k)
		}
	}
	return nil
}
func (v *memValues) Set(scope, subject, key, value, _ string) error {
	k := scope + "|" + subject + "|" + key
	if value == "" {
		delete(v.m, k)
	} else {
		v.m[k] = value
	}
	return nil
}

type optLauncher struct {
	fakeLauncherService
	changed map[string]bool
}

func (o optLauncher) NodeOptions(t string) []nodeoptions.Option {
	if t != "omp-mxf-player" {
		return nil
	}
	return []nodeoptions.Option{
		{Key: "OMP_MEDIA_DIR", Label: "Medien", Type: nodeoptions.TypePath, PathKind: nodeoptions.PathDir, MustExist: true},
		{Key: "OMP_WIDTH", Label: "Breite", Type: nodeoptions.TypeInt},
	}
}
func (o optLauncher) OptionsChanged(_, id string) bool { return o.changed[id] }

func TestNodeSettingsListSetAndGuards(t *testing.T) {
	dir := t.TempDir()
	vals := &memValues{m: map[string]string{}}
	svc := optLauncher{
		fakeLauncherService: fakeLauncherService{
			catalog: []launcher.CatalogEntry{{Type: "omp-mxf-player", Label: "MXF Player"}, {Type: "omp-scope", Label: "Scope"}},
			instances: []launcher.Instance{
				{ID: "local1", Type: "omp-mxf-player", Label: "A", PID: 5},
				{ID: "remote1", Type: "omp-mxf-player", Label: "B", PID: 6, HostID: "h1"},
			},
		},
		changed: map[string]bool{"local1": true},
	}
	put := func(typ, key, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPut, "/x", strings.NewReader(body))
		req.SetPathValue("type", typ)
		req.SetPathValue("key", key)
		handleSetNodeSetting(vals, svc, nil)(rec, req)
		return rec
	}

	// Typ-weit setzen (Pfad existiert) → gespeichert, ein lokaler Neustart nötig.
	rec := put("omp-mxf-player", "OMP_MEDIA_DIR", `{"value":"`+dir+`"}`)
	if rec.Code != 200 || vals.m["type|omp-mxf-player|OMP_MEDIA_DIR"] != dir {
		t.Fatalf("typ setzen: %d %s", rec.Code, rec.Body)
	}
	var resp struct{ RestartNeeded int }
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp.RestartNeeded != 1 {
		t.Fatalf("restartNeeded = %d, erwartet 1 (nur die lokale, veränderte Instanz)", resp.RestartNeeded)
	}
	// Fehlender Pfad bei MustExist, Unsinn bei Zahl, unbekannte Option, falscher Typ.
	if rec := put("omp-mxf-player", "OMP_MEDIA_DIR", `{"value":"`+dir+`/fehlt"}`); rec.Code != 400 {
		t.Fatalf("fehlender Pfad: %d", rec.Code)
	}
	if rec := put("omp-mxf-player", "OMP_WIDTH", `{"value":"breit"}`); rec.Code != 400 {
		t.Fatalf("Zahl: %d", rec.Code)
	}
	if rec := put("omp-mxf-player", "OMP_NIX", `{"value":"1"}`); rec.Code != 404 {
		t.Fatalf("unbekannte Option: %d", rec.Code)
	}
	if rec := put("omp-scope", "OMP_MEDIA_DIR", `{"value":"1"}`); rec.Code != 404 {
		t.Fatalf("Typ ohne Optionen: %d", rec.Code)
	}
	// Instanz-Override: lokal ok, Remote-Host abgelehnt, falscher Typ 404.
	if rec := put("omp-mxf-player", "OMP_WIDTH", `{"value":"1280","instanceId":"local1"}`); rec.Code != 200 || vals.m["instance|local1|OMP_WIDTH"] != "1280" {
		t.Fatalf("Instanz: %d %s", rec.Code, rec.Body)
	}
	// Remote-Instanz: Pfad wird NICHT gegen das lokale Dateisystem geprüft, der Host-Agent entscheidet.
	if rec := put("omp-mxf-player", "OMP_MEDIA_DIR", `{"value":"/nur/auf/dem/remote/host","instanceId":"remote1"}`); rec.Code != 200 {
		t.Fatalf("Remote-Instanz mit fremdem Pfad: %d %s", rec.Code, rec.Body)
	}
	// Typ-weit: fehlender lokaler Pfad scheitert, mit force wird er mit Warnung gespeichert.
	if rec := put("omp-mxf-player", "OMP_MEDIA_DIR", `{"value":"/nur/auf/dem/remote/host"}`); rec.Code != 400 {
		t.Fatalf("ohne force: %d", rec.Code)
	}
	if rec := put("omp-mxf-player", "OMP_MEDIA_DIR", `{"value":"/nur/auf/dem/remote/host","force":true}`); rec.Code != 200 || !strings.Contains(rec.Body.String(), "erzwungen") {
		t.Fatalf("mit force: %d %s", rec.Code, rec.Body)
	}
	if rec := put("omp-mxf-player", "OMP_WIDTH", `{"value":"1280","instanceId":"gibtsnicht"}`); rec.Code != 404 {
		t.Fatalf("unbekannte Instanz: %d", rec.Code)
	}
	// Leer = zurücksetzen.
	if rec := put("omp-mxf-player", "OMP_MEDIA_DIR", `{"value":""}`); rec.Code != 200 || vals.m["type|omp-mxf-player|OMP_MEDIA_DIR"] != "" {
		t.Fatalf("zurücksetzen: %d", rec.Code)
	}

	// Liste: nur Typen mit Optionen, Instanzen mit Overrides und Neustart-Flag.
	rec = httptest.NewRecorder()
	handleListNodeSettings(vals, svc)(rec, httptest.NewRequest(http.MethodGet, "/l", nil))
	var list struct {
		Types []settingsNodeType `json:"types"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil || len(list.Types) != 1 {
		t.Fatalf("Liste: %v %s", err, rec.Body)
	}
	got := list.Types[0]
	if len(got.Options) != 2 || len(got.Instances) != 2 {
		t.Fatalf("%+v", got)
	}
	for _, in := range got.Instances {
		switch in.ID {
		case "local1":
			if in.Overrides["OMP_WIDTH"] != "1280" || !in.RestartNeeded {
				t.Fatalf("local1: %+v", in)
			}
		case "remote1":
			if !in.Remote || in.RestartNeeded {
				t.Fatalf("remote1: %+v", in)
			}
		}
	}
}

func TestSystemSettingsRejectsContradictionAndInvalid(t *testing.T) {
	active := config.Config{
		AuditRetentionDays: 90, BackupKeep: 5, LogRetentionHours: 24,
		PlacementCPUThreshold: 85, PlacementHealthyCPUThreshold: 60, PlacementMemThreshold: 85, PlacementHealthyMemThreshold: 60,
		PlacementNetThreshold: 80, PlacementHealthyNetThreshold: 50, PlacementGpuThreshold: 85, PlacementHealthyGpuThreshold: 60,
	}
	store := &memSystem{m: map[string]string{}}
	put := func(key, body string) int {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPut, "/x", strings.NewReader(body))
		req.SetPathValue("key", key)
		handleSetSystemSetting(store, active, nil)(rec, req)
		return rec.Code
	}
	if c := put("OMP_AUDIT_RETENTION_DAYS", `{"value":"365"}`); c != 200 || store.m["OMP_AUDIT_RETENTION_DAYS"] != "365" {
		t.Fatalf("gültig: %d %v", c, store.m)
	}
	if c := put("OMP_AUDIT_RETENTION_DAYS", `{"value":"-1"}`); c != 400 {
		t.Fatalf("außerhalb: %d", c)
	}
	if c := put("OMP_PLACEMENT_HEALTHY_CPU_THRESHOLD", `{"value":"90"}`); c != 400 {
		t.Fatalf("gesund >= überlastet muss 400 sein: %d", c)
	}
	if c := put("OMP_NIX", `{"value":"1"}`); c != 404 {
		t.Fatalf("unbekannt: %d", c)
	}
	if c := put("OMP_AUDIT_RETENTION_DAYS", `{"value":""}`); c != 200 || store.m["OMP_AUDIT_RETENTION_DAYS"] != "" {
		t.Fatalf("zurücksetzen: %d %v", c, store.m)
	}

	rec := httptest.NewRecorder()
	handleListSystemSettings(store, active, nil)(rec, httptest.NewRequest(http.MethodGet, "/l", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"startup"`) || strings.Contains(rec.Body.String(), "postgres://") {
		t.Fatalf("Liste: %d %s", rec.Code, rec.Body)
	}
}

type memSystem struct{ m map[string]string }

func (s *memSystem) Overrides() (map[string]string, error) { return s.m, nil }
func (s *memSystem) Set(k, v, _ string) error {
	if v == "" {
		delete(s.m, k)
	} else {
		s.m[k] = v
	}
	return nil
}

func TestCheckPathHandler(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(dir+"/a", []byte("x"), 0o644)
	rec := httptest.NewRecorder()
	handleCheckPath(fakeLauncherService{})(rec, httptest.NewRequest(http.MethodPost, "/c", strings.NewReader(`{"path":"`+dir+`","kind":"dir"}`)))
	var info nodeoptions.PathInfo
	_ = json.Unmarshal(rec.Body.Bytes(), &info)
	if rec.Code != 200 || !info.Readable || info.Entries != 1 {
		t.Fatalf("%d %+v", rec.Code, info)
	}
	rec = httptest.NewRecorder()
	handleCheckPath(fakeLauncherService{})(rec, httptest.NewRequest(http.MethodPost, "/c", strings.NewReader(`{}`)))
	if rec.Code != 400 {
		t.Fatalf("ohne Pfad: %d", rec.Code)
	}
}
