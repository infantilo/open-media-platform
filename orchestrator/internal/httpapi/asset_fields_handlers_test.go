package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/asset"
	"github.com/infantilo/openmediaplatform/orchestrator/internal/dbtest"
)

// Feld-Registry (Kapitel 78.1) gegen echte Datenbank: Anlegen, Validierung beim
// Speichern der Metadaten, Löschen.
func TestAssetFieldRegistryValidatesMetadata(t *testing.T) {
	database := dbtest.Open(t)
	_, _ = database.Exec(`DELETE FROM asset_metadata_fields`)
	_, _ = database.Exec(`DELETE FROM assets`)
	t.Cleanup(func() {
		_, _ = database.Exec(`DELETE FROM asset_metadata_fields`)
		_, _ = database.Exec(`DELETE FROM assets`)
	})
	svc := asset.NewStore(database)

	call := func(h http.HandlerFunc, method, id string, body any) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(body)
		req := httptest.NewRequest(method, "/x", bytes.NewReader(raw))
		req.SetPathValue("id", id)
		rec := httptest.NewRecorder()
		h(rec, req)
		return rec
	}

	rec := call(handleCreateAssetField(svc, nil), "POST", "", asset.Field{
		Category: "custom", Key: "freigabe", Label: "Freigabe", DataType: asset.FieldEnum,
		EnumValues: []string{"FSK0", "FSK12"}, Required: true,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("create field: %d %s", rec.Code, rec.Body)
	}
	var created asset.Field
	_ = json.Unmarshal(rec.Body.Bytes(), &created)

	a, err := svc.CreateAsset("VIDEO", "Test", "", "alice", "")
	if err != nil {
		t.Fatal(err)
	}
	put := func(custom map[string]any) *httptest.ResponseRecorder {
		return call(handleUpdateAssetMetadata(svc), "PUT", a.ID, map[string]any{
			"expectedRowVersion": a.RowVersion, "metadata": map[string]any{"custom": custom},
		})
	}
	if rec := put(map[string]any{"freigabe": "FSK99"}); rec.Code != http.StatusBadRequest {
		t.Errorf("value outside enum: want 400, got %d %s", rec.Code, rec.Body)
	}
	if rec := put(map[string]any{}); rec.Code != http.StatusBadRequest {
		t.Errorf("missing required: want 400, got %d %s", rec.Code, rec.Body)
	}
	if rec := put(map[string]any{"freigabe": "FSK12", "freies_feld": 7}); rec.Code != http.StatusOK {
		t.Errorf("valid + free key: want 200, got %d %s", rec.Code, rec.Body)
	}

	list := call(handleListAssetFields(svc), "GET", "", nil)
	var body struct {
		Fields []asset.Field `json:"fields"`
	}
	_ = json.Unmarshal(list.Body.Bytes(), &body)
	if len(body.Fields) < len(asset.BuiltinFields())+1 {
		t.Errorf("list must contain built-in and custom fields, got %d", len(body.Fields))
	}
	if rec := call(handleDeleteAssetField(svc, nil), "DELETE", "builtin:descriptive.subject", nil); rec.Code != http.StatusBadRequest {
		t.Errorf("delete built-in: want 400, got %d", rec.Code)
	}
	if rec := call(handleDeleteAssetField(svc, nil), "DELETE", created.ID, nil); rec.Code != http.StatusNoContent {
		t.Errorf("delete: want 204, got %d", rec.Code)
	}
}

// EBUCore-Rundlauf über die Handler (Kapitel 78.2): exportieren, in ein zweites Asset
// einlesen, Werte kommen an; ein Wert außerhalb der Auswahlliste wird abgelehnt.
func TestAssetEBUCoreExportImportHandlers(t *testing.T) {
	database := dbtest.Open(t)
	_, _ = database.Exec(`DELETE FROM asset_metadata_fields`)
	_, _ = database.Exec(`DELETE FROM assets`)
	t.Cleanup(func() {
		_, _ = database.Exec(`DELETE FROM asset_metadata_fields`)
		_, _ = database.Exec(`DELETE FROM assets`)
	})
	svc := asset.NewStore(database)
	if _, err := svc.CreateField(asset.Field{Category: "custom", Key: "stufe", Label: "Stufe", DataType: asset.FieldEnum, EnumValues: []string{"A", "B"}}, "t"); err != nil {
		t.Fatal(err)
	}
	src, _ := svc.CreateAsset("VIDEO", "Quelle", "", "t", "")
	src, err := svc.UpdateAssetMetadata(src.ID, src.RowVersion, asset.Metadata{
		Descriptive: map[string]any{"subject": []any{"Sport", "Wetter"}},
		Custom:      map[string]any{"stufe": "A", "frei": "x"},
	}, "t")
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest("GET", "/x", nil)
	req.SetPathValue("id", src.ID)
	rec := httptest.NewRecorder()
	handleExportAssetEBUCore(svc)(rec, req)
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") == "" {
		t.Fatalf("export: %d %s", rec.Code, rec.Body)
	}
	doc := rec.Body.Bytes()

	dst, _ := svc.CreateAsset("VIDEO", "Ziel", "", "t", "")
	imp := func(body []byte, q string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/x?"+q, bytes.NewReader(body))
		req.SetPathValue("id", dst.ID)
		rec := httptest.NewRecorder()
		handleImportAssetEBUCore(svc)(rec, req)
		return rec
	}
	if rec := imp(doc, "dryRun=1"); rec.Code != http.StatusOK {
		t.Fatalf("dryRun: %d %s", rec.Code, rec.Body)
	}
	if rec := imp(doc, ""); rec.Code != http.StatusOK {
		t.Fatalf("import: %d %s", rec.Code, rec.Body)
	}
	got, _ := svc.GetAsset(dst.ID)
	if got.Metadata.Custom["stufe"] != "A" || got.Metadata.Custom["frei"] != "x" {
		t.Errorf("custom after import: %v", got.Metadata.Custom)
	}
	if s, _ := got.Metadata.Descriptive["subject"].([]any); len(s) != 2 {
		t.Errorf("subject after import: %v", got.Metadata.Descriptive)
	}
	bad := bytes.Replace(doc, []byte(">A</"), []byte(">Z</"), 1)
	if rec := imp(bad, ""); rec.Code != http.StatusBadRequest {
		t.Errorf("value outside enum on import: want 400, got %d %s", rec.Code, rec.Body)
	}
}
