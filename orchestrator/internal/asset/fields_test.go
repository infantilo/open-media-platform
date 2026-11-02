package asset

import (
	"errors"
	"strings"
	"testing"
)

func fieldsDB(t *testing.T) *Store {
	t.Helper()
	database := testDB(t)
	clean := func() { _, _ = database.Exec(`DELETE FROM asset_metadata_fields`) }
	clean()
	t.Cleanup(clean)
	return NewStore(database)
}

func TestFieldCRUDAndScope(t *testing.T) {
	s := fieldsDB(t)

	f, err := s.CreateField(Field{Category: "custom", Key: "kostenstelle", Label: "Kostenstelle", DataType: FieldText, Required: true}, "alice")
	if err != nil {
		t.Fatalf("CreateField: %v", err)
	}
	if f.ID == "" || f.CreatedBy != "alice" {
		t.Fatalf("unexpected field %+v", f)
	}
	if _, err := s.CreateField(Field{Category: "custom", Key: "kostenstelle", Label: "x", DataType: FieldText}, "a"); !errors.Is(err, ErrValidation) {
		t.Errorf("duplicate: want ErrValidation, got %v", err)
	}
	if _, err := s.CreateField(Field{Category: "descriptive", Key: "subject", Label: "x", DataType: FieldText}, "a"); !errors.Is(err, ErrValidation) {
		t.Errorf("shadowing built-in: want ErrValidation, got %v", err)
	}
	if _, err := s.CreateField(Field{AssetType: "VIDEO", Category: "technical", Key: "rating", Label: "Freigabe", DataType: FieldEnum, EnumValues: []string{"FSK0", "FSK12"}}, "a"); err != nil {
		t.Fatalf("typed field: %v", err)
	}

	video, _ := s.ListFields("VIDEO")
	audio, _ := s.ListFields("AUDIO")
	has := func(fs []Field, key string) bool {
		for _, f := range fs {
			if f.Key == key {
				return true
			}
		}
		return false
	}
	if !has(video, "rating") || has(audio, "rating") {
		t.Errorf("asset-type scope wrong: video has rating=%v audio has rating=%v", has(video, "rating"), has(audio, "rating"))
	}
	if !has(audio, "kostenstelle") || !has(audio, "subject") {
		t.Errorf("global and built-in fields must apply to all types")
	}

	up, err := s.UpdateField(f.ID, Field{Label: "Kostenstelle neu", DataType: FieldInteger, Category: "x", Key: "y"})
	if err != nil {
		t.Fatalf("UpdateField: %v", err)
	}
	if up.Label != "Kostenstelle neu" || up.DataType != FieldText || up.Key != "kostenstelle" {
		t.Errorf("update must change label only, got %+v", up)
	}
	if err := s.DeleteField(f.ID); err != nil {
		t.Fatalf("DeleteField: %v", err)
	}
	if err := s.DeleteField(f.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("second delete: want ErrNotFound, got %v", err)
	}
}

func TestFieldNormalizeRejects(t *testing.T) {
	cases := map[string]Field{
		"bad key":      {Category: "custom", Key: "1abc", Label: "x", DataType: FieldText},
		"no label":     {Category: "custom", Key: "a", DataType: FieldText},
		"bad category": {Category: "zzz", Key: "a", Label: "x", DataType: FieldText},
		"bad type":     {Category: "custom", Key: "a", Label: "x", DataType: "blob"},
		"enum empty":   {Category: "custom", Key: "a", Label: "x", DataType: FieldEnum},
		"bad target":   {Category: "custom", Key: "a", Label: "x", DataType: FieldText, EBUCoreTarget: "nonsense"},
	}
	for name, f := range cases {
		if err := f.Normalize(); !errors.Is(err, ErrValidation) {
			t.Errorf("%s: want ErrValidation, got %v", name, err)
		}
	}
}

func TestValidateMetadata(t *testing.T) {
	fields := []Field{
		{Category: "custom", Key: "n", Label: "N", DataType: FieldInteger, Required: true},
		{Category: "custom", Key: "d", Label: "D", DataType: FieldDate},
		{Category: "custom", Key: "e", Label: "E", DataType: FieldEnum, EnumValues: []string{"a", "b"}},
		{Category: "custom", Key: "t", Label: "T", DataType: FieldText, Multiple: true},
		{Category: "custom", Key: "one", Label: "One", DataType: FieldText},
		{Category: "custom", Key: "b", Label: "B", DataType: FieldBoolean},
	}
	ok := Metadata{Custom: map[string]any{"n": 3.0, "d": "2026-11-02", "e": "a", "t": []any{"x", "y"}, "b": true, "free": 42.0}}
	if p := ValidateMetadata(fields, ok); len(p) != 0 {
		t.Errorf("valid metadata rejected: %v", p)
	}
	bad := Metadata{Custom: map[string]any{"n": 1.5, "d": "02.11.2026", "e": "c", "t": []any{1.0}, "one": []any{"a"}, "b": "ja"}}
	p := ValidateMetadata(fields, bad)
	if len(p) != 6 {
		t.Errorf("want 6 problems, got %d: %v", len(p), p)
	}
	missing := ValidateMetadata(fields, Metadata{})
	if len(missing) != 1 || !strings.Contains(missing[0], "Pflichtfeld") {
		t.Errorf("want one required-field problem, got %v", missing)
	}
}
