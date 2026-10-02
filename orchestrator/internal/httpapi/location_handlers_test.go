package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/launcher"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/locations"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/nodeoptions"
)

type memLocations struct {
	list []locations.Location
	seq  int
}

func (m *memLocations) List() ([]locations.Location, error) { return m.list, nil }
func (m *memLocations) Get(id string) (locations.Location, error) {
	for _, l := range m.list {
		if l.ID == id {
			return l, nil
		}
	}
	return locations.Location{}, locations.ErrNotFound
}
func (m *memLocations) Create(in locations.Input, by string) (locations.Location, error) {
	for _, l := range m.list {
		if l.Name == in.Name || (l.HostID == in.HostID && l.Path == in.Path) {
			return locations.Location{}, locations.ErrDuplicate
		}
	}
	m.seq++
	l := locations.Location{ID: string(rune('a' + m.seq)), Name: in.Name, HostID: in.HostID, Path: in.Path, Status: "active", CreatedBy: by, CreatedAt: time.Now()}
	m.list = append(m.list, l)
	return l, nil
}
func (m *memLocations) Update(id, name, note, status string) (locations.Location, error) {
	for i, l := range m.list {
		if l.ID == id {
			m.list[i].Name, m.list[i].Note, m.list[i].Status = name, note, status
			return m.list[i], nil
		}
	}
	return locations.Location{}, locations.ErrNotFound
}
func (m *memLocations) Delete(id string) error {
	for i, l := range m.list {
		if l.ID == id {
			m.list = append(m.list[:i], m.list[i+1:]...)
			return nil
		}
	}
	return locations.ErrNotFound
}

func TestLocationsCreateCheckUsageAndDeleteGuard(t *testing.T) {
	dir := t.TempDir()
	store := &memLocations{}
	vals := &memValues{m: map[string]string{}}
	svc := optLauncher{fakeLauncherService: fakeLauncherService{
		catalog:   []launcher.CatalogEntry{{Type: "omp-mxf-player", Label: "MXF"}},
		instances: []launcher.Instance{{ID: "i1", Type: "omp-mxf-player", Label: "A", PID: 3}},
	}}

	create := func(body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		handleCreateLocation(store, svc, nil)(rec, httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(body)))
		return rec
	}
	// Nicht vorhandener Pfad: abgelehnt, mit force angelegt (Warnung).
	if rec := create(`{"name":"Fehlt","path":"/gibt/es/nicht"}`); rec.Code != 400 {
		t.Fatalf("fehlender Pfad: %d %s", rec.Code, rec.Body)
	}
	if rec := create(`{"name":"Fehlt","path":"/gibt/es/nicht","force":true}`); rec.Code != 201 || !strings.Contains(rec.Body.String(), "existiert nicht") {
		t.Fatalf("force: %d %s", rec.Code, rec.Body)
	}
	if rec := create(`{"name":"Relativ","path":"data/media"}`); rec.Code != 400 {
		t.Fatalf("relativer Pfad: %d", rec.Code)
	}
	if rec := create(`{"name":"Medien","path":"` + dir + `"}`); rec.Code != 201 {
		t.Fatalf("anlegen: %d %s", rec.Code, rec.Body)
	}
	if rec := create(`{"name":"Medien","path":"` + dir + `x"}`); rec.Code == 201 {
		t.Fatal("doppelter Name muss scheitern")
	}

	// Verwendung: eine Typ-Einstellung zeigt in den Ort.
	_ = vals.Set("type", "omp-mxf-player", "OMP_MEDIA_DIR", dir+"/clips", "t")
	rec := httptest.NewRecorder()
	handleListLocations(store, vals, svc)(rec, httptest.NewRequest(http.MethodGet, "/l", nil))
	var list struct {
		Locations []locationView `json:"locations"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil || len(list.Locations) != 2 {
		t.Fatalf("Liste: %v %s", err, rec.Body)
	}
	var media locationView
	for _, l := range list.Locations {
		if l.Name == "Medien" {
			media = l
		}
	}
	if media.Check == nil || !media.Check.Readable || len(media.Usage) != 1 || media.Usage[0].Option != "OMP_MEDIA_DIR" {
		t.Fatalf("Check/Usage: %+v", media)
	}

	del := func(id string) int {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodDelete, "/d", nil)
		req.SetPathValue("id", id)
		handleDeleteLocation(store, vals, svc, nil)(rec, req)
		return rec.Code
	}
	if c := del(media.ID); c != 409 {
		t.Fatalf("in Gebrauch: %d", c)
	}
	_ = vals.Set("type", "omp-mxf-player", "OMP_MEDIA_DIR", "", "t")
	if c := del(media.ID); c != 204 {
		t.Fatalf("frei: %d", c)
	}
	if c := del("nix"); c != 404 {
		t.Fatalf("unbekannt: %d", c)
	}
	_ = nodeoptions.PathInfo{}
}
