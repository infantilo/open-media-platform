package ebucore

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/asset"
)

func ip(i int) *int         { return &i }
func fp(f float64) *float64 { return &f }
func lp(i int64) *int64     { return &i }

func sampleAsset() (asset.Asset, []asset.Representation, []asset.Field) {
	a := asset.Asset{
		ID: "a1", Type: "VIDEO", Title: "Interview <Master> & Co", Description: "Beschreibung",
		CreatedAt: time.Date(2026, 11, 2, 9, 30, 0, 0, time.UTC),
		Metadata: asset.Metadata{
			Descriptive: map[string]any{
				"alternativeTitle": []any{"Alt 1", "Alt 2"}, "subject": []any{"Sport"}, "language": []any{"de"},
				"genre": []any{"Magazin"}, "creator": []any{"Erika Muster"}, "publisher": []any{"Sender X"},
				"contributor": []any{"Max Beispiel"},
			},
			Editorial: map[string]any{"synopsis": "Kurzfassung", "externalId": []any{"X-77"}},
			Technical: map[string]any{"loudness_lufs": -23.0, "interlaced": false, "profile": "XDCAM"},
			Custom:    map[string]any{"kostenstelle": "4711", "anzahl": 3.0},
		},
	}
	reps := []asset.Representation{{
		ID: "r1", Type: "master", Storage: asset.StorageLocation{Provider: "s3", URI: "s3://bucket/a1.mxf"},
		Codec: "AVC", Container: "MXF", Width: ip(1920), Height: ip(1080), FrameRate: fp(25),
		SampleRate: ip(48000), Channels: ip(2), Bitrate: lp(50000000), SizeBytes: lp(123456789), Checksum: "ab12",
	}, {
		ID: "r2", Type: "proxy", Storage: asset.StorageLocation{Provider: "fs", URI: "file:///p.mp4"},
		Width: ip(640), Height: ip(360), FrameRate: fp(29.97),
	}}
	fields := append(asset.BuiltinFields(),
		asset.Field{Category: "custom", Key: "kostenstelle", Label: "Kostenstelle", DataType: asset.FieldText},
		asset.Field{Category: "custom", Key: "anzahl", Label: "Anzahl", DataType: asset.FieldInteger},
	)
	return a, reps, fields
}

// Der Export muss dem offiziellen Schema entsprechen. Der Test braucht das XSD samt
// Importen (nicht im Repo) und einen XSD-Prüfer: OMP_EBUCORE_XSD=/pfad/ebucore.xsd,
// OMP_XSDCHECK=/pfad/xsdcheck (kleines libxml2-Programm, s. docs/ENTWURF-NORMEN-...).
func TestExportValidatesAgainstOfficialSchema(t *testing.T) {
	xsd, checker := os.Getenv("OMP_EBUCORE_XSD"), os.Getenv("OMP_XSDCHECK")
	if xsd == "" || checker == "" {
		t.Skip("OMP_EBUCORE_XSD/OMP_XSDCHECK nicht gesetzt")
	}
	a, reps, fields := sampleAsset()
	doc, err := Export(a, reps, fields, time.Date(2026, 11, 2, 10, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(t.TempDir(), "out.xml")
	if err := os.WriteFile(file, doc, 0o600); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command(checker, xsd, file).CombinedOutput()
	if err != nil {
		t.Fatalf("XSD-Prüfung fehlgeschlagen: %v\n%s\n--- Dokument ---\n%s", err, out, doc)
	}
}

func TestRoundTripKeepsDynamicFields(t *testing.T) {
	a, reps, fields := sampleAsset()
	doc, err := Export(a, reps, fields, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	got, err := Import(bytes.NewReader(doc), fields)
	if err != nil {
		t.Fatalf("Import: %v\n%s", err, doc)
	}
	if got.Title != a.Title || got.Description != a.Description {
		t.Errorf("title/description: %q / %q", got.Title, got.Description)
	}
	if !reflect.DeepEqual(got.Metadata.Descriptive, a.Metadata.Descriptive) {
		t.Errorf("descriptive:\n got %v\nwant %v", got.Metadata.Descriptive, a.Metadata.Descriptive)
	}
	if got.Metadata.Editorial["synopsis"] != "Kurzfassung" {
		t.Errorf("editorial: %v", got.Metadata.Editorial)
	}
	if got.Metadata.Custom["kostenstelle"] != "4711" || got.Metadata.Custom["anzahl"] != 3.0 {
		t.Errorf("custom (typed by registry): %v", got.Metadata.Custom)
	}
	// Technische Werte ohne Registrierung kommen als Text zurück (EBUCore trägt sie als
	// technicalAttribute*); sie bleiben erhalten.
	for _, k := range []string{"loudness_lufs", "interlaced", "profile"} {
		if _, ok := got.Metadata.Technical[k]; !ok {
			t.Errorf("technical %q lost: %v", k, got.Metadata.Technical)
		}
	}
}

func TestImportRejectsForeignRoot(t *testing.T) {
	if _, err := Import(bytes.NewReader([]byte(`<x/>`)), nil); err == nil {
		t.Error("foreign root accepted")
	}
	if _, err := Import(bytes.NewReader([]byte(`<not xml`)), nil); err == nil {
		t.Error("broken XML accepted")
	}
}

// Das Beispiel aus Tech 3293 §3.19 (DPP-Datei) muss lesbar sein.
func TestImportSpecExample(t *testing.T) {
	doc := `<ebucore:ebuCoreMain xmlns:ebucore="urn:ebu:metadata-schema:ebucore" xmlns:dc="http://purl.org/dc/elements/1.1/">
 <ebucore:coreMetadata>
  <ebucore:title typeLabel="PROGRAMME TITLE"><dc:title>Programme Title</dc:title></ebucore:title>
  <ebucore:description typeLabel="SYNOPSIS"><dc:description>DPP test material</dc:description></ebucore:description>
  <ebucore:type><ebucore:genre typeDefinition="Test Material"/></ebucore:type>
 </ebucore:coreMetadata>
</ebucore:ebuCoreMain>`
	got, err := Import(bytes.NewReader([]byte(doc)), asset.BuiltinFields())
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "Programme Title" {
		t.Errorf("title %q", got.Title)
	}
	if got.Metadata.Descriptive["genre"].([]any)[0] != "Test Material" {
		t.Errorf("genre: %v", got.Metadata.Descriptive)
	}
	if got.Metadata.Editorial["synopsis"] != "DPP test material" {
		t.Errorf("SYNOPSIS should map to built-in description field: %v", got.Metadata)
	}
}
