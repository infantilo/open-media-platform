package descriptor

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
)

// schemaPath findet docs/descriptor-v0.schema.json relativ zu dieser
// Testdatei, unabhängig vom Arbeitsverzeichnis, aus dem `go test` läuft.
func schemaPath(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("failed to determine test file path via runtime.Caller")
	}
	return filepath.Join(filepath.Dir(thisFile), "..", "..", "..", "..", "docs", "descriptor-v0.schema.json")
}

func compileSchema(t *testing.T) *jsonschema.Schema {
	t.Helper()
	c := jsonschema.NewCompiler()
	sch, err := c.Compile(schemaPath(t))
	if err != nil {
		t.Fatalf("failed to compile docs/descriptor-v0.schema.json: %v", err)
	}
	return sch
}

func TestMockDescriptorMatchesSchema(t *testing.T) {
	sch := compileSchema(t)

	store := NewStore("Mock Node")
	body, err := json.Marshal(store.Descriptor())
	if err != nil {
		t.Fatalf("failed to marshal descriptor: %v", err)
	}

	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("failed to unmarshal descriptor JSON: %v", err)
	}

	if err := sch.Validate(inst); err != nil {
		t.Fatalf("mock node descriptor does not conform to docs/descriptor-v0.schema.json: %v", err)
	}
}

func TestSchemaRejectsUnexpectedTopLevelProperty(t *testing.T) {
	sch := compileSchema(t)

	bad := map[string]any{
		"parameters": []any{},
		"methods":    []any{},
		"unexpected": true,
	}
	body, err := json.Marshal(bad)
	if err != nil {
		t.Fatalf("failed to marshal test fixture: %v", err)
	}
	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("failed to unmarshal test fixture: %v", err)
	}

	if err := sch.Validate(inst); err == nil {
		t.Fatal("expected validation error for descriptor with unexpected top-level property, got nil")
	}
}

func TestSchemaRejectsMissingRequiredField(t *testing.T) {
	sch := compileSchema(t)

	bad := map[string]any{"parameters": []any{}}
	body, err := json.Marshal(bad)
	if err != nil {
		t.Fatalf("failed to marshal test fixture: %v", err)
	}
	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("failed to unmarshal test fixture: %v", err)
	}

	if err := sch.Validate(inst); err == nil {
		t.Fatal("expected validation error for descriptor missing 'methods', got nil")
	}
}
