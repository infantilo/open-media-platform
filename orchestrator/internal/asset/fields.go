package asset

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Datentypen eines registrierten Metadatenfelds.
const (
	FieldText     = "text"
	FieldLongText = "longtext"
	FieldInteger  = "integer"
	FieldNumber   = "number"
	FieldBoolean  = "boolean"
	FieldDate     = "date"     // YYYY-MM-DD
	FieldDateTime = "datetime" // RFC 3339
	FieldEnum     = "enum"     // einer der EnumValues
	FieldURL      = "url"
)

var fieldDataTypes = map[string]bool{
	FieldText: true, FieldLongText: true, FieldInteger: true, FieldNumber: true,
	FieldBoolean: true, FieldDate: true, FieldDateTime: true, FieldEnum: true, FieldURL: true,
}

// MetadataCategories sind die sechs Blöcke von Metadata (B6).
var MetadataCategories = []string{"system", "technical", "descriptive", "editorial", "custom", "ai"}

// EBUCoreTargets sind die Ziele, die der EBUCore-Export versteht
// (EBU Tech 3293 v1.10, ebucore.xsd 1.10.1). Leer = kein festes Ziel; der Wert
// geht dann als typeLabel-Attribut mit (Tech 3293 §3.19).
var EBUCoreTargets = []string{
	"alternativeTitle", "description", "subject", "language", "genre",
	"creator", "contributor", "publisher", "identifier",
}

var fieldKeyRE = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,63}$`)

// Field beschreibt ein Metadatenfeld.
type Field struct {
	ID            string    `json:"id"`
	AssetType     string    `json:"assetType,omitempty"`
	Category      string    `json:"category"`
	Key           string    `json:"key"`
	Label         string    `json:"label"`
	Description   string    `json:"description,omitempty"`
	DataType      string    `json:"dataType"`
	Required      bool      `json:"required,omitempty"`
	Multiple      bool      `json:"multiple,omitempty"`
	EnumValues    []string  `json:"enumValues,omitempty"`
	EBUCoreTarget string    `json:"ebucoreTarget,omitempty"`
	SortOrder     int       `json:"sortOrder,omitempty"`
	Builtin       bool      `json:"builtin,omitempty"`
	CreatedBy     string    `json:"createdBy,omitempty"`
	CreatedAt     time.Time `json:"createdAt,omitzero"`
	UpdatedAt     time.Time `json:"updatedAt,omitzero"`
}

// BuiltinFields sind die mitgelieferten Standardfelder mit EBUCore-Ziel. Sie
// stehen nicht in der Datenbank, sind nicht änderbar und blockieren ihren
// Schlüssel für eigene Felder gleichen Orts.
func BuiltinFields() []Field {
	f := func(cat, key, label, dt, target string, multiple bool) Field {
		return Field{ID: "builtin:" + cat + "." + key, Category: cat, Key: key, Label: label,
			DataType: dt, EBUCoreTarget: target, Multiple: multiple, Builtin: true}
	}
	return []Field{
		f("descriptive", "alternativeTitle", "Alternativtitel", FieldText, "alternativeTitle", true),
		f("descriptive", "subject", "Schlagworte", FieldText, "subject", true),
		f("descriptive", "language", "Sprache (BCP 47)", FieldText, "language", true),
		f("descriptive", "genre", "Genre", FieldText, "genre", true),
		f("descriptive", "creator", "Urheber", FieldText, "creator", true),
		f("descriptive", "contributor", "Mitwirkende", FieldText, "contributor", true),
		f("descriptive", "publisher", "Herausgeber", FieldText, "publisher", true),
		f("editorial", "synopsis", "Inhaltsangabe", FieldLongText, "description", false),
		f("editorial", "externalId", "Externe Kennung", FieldText, "identifier", true),
	}
}

// Normalize prüft und bereinigt eine Felddefinition (Aufrufer-Eingaben →
// ErrValidation).
func (f *Field) Normalize() error {
	f.AssetType = strings.TrimSpace(f.AssetType)
	f.Key = strings.TrimSpace(f.Key)
	f.Label = strings.TrimSpace(f.Label)
	if !fieldKeyRE.MatchString(f.Key) {
		return fmt.Errorf("%w: key must match %s", ErrValidation, fieldKeyRE)
	}
	if f.Label == "" {
		return fmt.Errorf("%w: label is required", ErrValidation)
	}
	okCat := false
	for _, c := range MetadataCategories {
		okCat = okCat || c == f.Category
	}
	if !okCat {
		return fmt.Errorf("%w: category must be one of %v", ErrValidation, MetadataCategories)
	}
	if !fieldDataTypes[f.DataType] {
		return fmt.Errorf("%w: unknown dataType %q", ErrValidation, f.DataType)
	}
	if f.DataType == FieldEnum && len(f.EnumValues) == 0 {
		return fmt.Errorf("%w: enum field needs enumValues", ErrValidation)
	}
	if f.DataType != FieldEnum {
		f.EnumValues = nil
	}
	if f.EBUCoreTarget != "" {
		ok := false
		for _, t := range EBUCoreTargets {
			ok = ok || t == f.EBUCoreTarget
		}
		if !ok {
			return fmt.Errorf("%w: ebucoreTarget must be one of %v", ErrValidation, EBUCoreTargets)
		}
	}
	return nil
}

// ---- Persistenz ------------------------------------------------------------------

const fieldColumns = `id, asset_type, category, key, label, description, datatype, required, multiple, enum_values, ebucore_target, sort_order, created_by, created_at, updated_at`

func scanField(row interface{ Scan(...any) error }) (Field, error) {
	var f Field
	var enum []byte
	if err := row.Scan(&f.ID, &f.AssetType, &f.Category, &f.Key, &f.Label, &f.Description, &f.DataType,
		&f.Required, &f.Multiple, &enum, &f.EBUCoreTarget, &f.SortOrder, &f.CreatedBy, &f.CreatedAt, &f.UpdatedAt); err != nil {
		return Field{}, err
	}
	if len(enum) > 0 {
		_ = json.Unmarshal(enum, &f.EnumValues)
	}
	return f, nil
}

// ListFields liefert die Standardfelder plus die registrierten Felder, die für
// assetType gelten (leer = alle Felder aller Typen). Reihenfolge: SortOrder,
// dann Beschriftung.
func (s *Store) ListFields(assetType string) ([]Field, error) {
	q := `SELECT ` + fieldColumns + ` FROM asset_metadata_fields`
	args := []any{}
	if assetType != "" {
		q += ` WHERE asset_type = '' OR asset_type = $1`
		args = append(args, assetType)
	}
	rows, err := s.db.QueryContext(context.Background(), q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := BuiltinFields()
	for rows.Next() {
		f, err := scanField(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].SortOrder != out[j].SortOrder {
			return out[i].SortOrder < out[j].SortOrder
		}
		return out[i].Label < out[j].Label
	})
	return out, nil
}

// CreateField legt ein Feld an. Ein Schlüssel, der ein Standardfeld
// überdecken würde, wird abgelehnt.
func (s *Store) CreateField(f Field, createdBy string) (Field, error) {
	if err := f.Normalize(); err != nil {
		return Field{}, err
	}
	for _, b := range BuiltinFields() {
		if b.Category == f.Category && b.Key == f.Key {
			return Field{}, fmt.Errorf("%w: %s.%s is a built-in field", ErrValidation, f.Category, f.Key)
		}
	}
	id, err := newID()
	if err != nil {
		return Field{}, err
	}
	enum, _ := json.Marshal(append([]string{}, f.EnumValues...))
	row := s.db.QueryRowContext(context.Background(), `
		INSERT INTO asset_metadata_fields (id, asset_type, category, key, label, description, datatype, required, multiple, enum_values, ebucore_target, sort_order, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
		RETURNING `+fieldColumns,
		id, f.AssetType, f.Category, f.Key, f.Label, f.Description, f.DataType, f.Required, f.Multiple, enum, f.EBUCoreTarget, f.SortOrder, createdBy)
	out, err := scanField(row)
	if err != nil {
		if strings.Contains(err.Error(), "asset_metadata_fields_asset_type_category_key_key") {
			return Field{}, fmt.Errorf("%w: field %s.%s already exists", ErrValidation, f.Category, f.Key)
		}
		return Field{}, err
	}
	return out, nil
}

// UpdateField ändert Beschriftung, Beschreibung, Pflicht, Auswahlliste,
// EBUCore-Ziel und Reihenfolge. Ort (Typ/Kategorie/Schlüssel) und Datentyp
// bleiben fest — dafür ein neues Feld anlegen.
func (s *Store) UpdateField(id string, in Field) (Field, error) {
	cur, err := s.getField(id)
	if err != nil {
		return Field{}, err
	}
	in.AssetType, in.Category, in.Key, in.DataType = cur.AssetType, cur.Category, cur.Key, cur.DataType
	if err := in.Normalize(); err != nil {
		return Field{}, err
	}
	enum, _ := json.Marshal(append([]string{}, in.EnumValues...))
	row := s.db.QueryRowContext(context.Background(), `
		UPDATE asset_metadata_fields SET label=$2, description=$3, required=$4, multiple=$5, enum_values=$6, ebucore_target=$7, sort_order=$8, updated_at=now()
		WHERE id=$1 RETURNING `+fieldColumns,
		id, in.Label, in.Description, in.Required, in.Multiple, enum, in.EBUCoreTarget, in.SortOrder)
	return scanField(row)
}

func (s *Store) getField(id string) (Field, error) {
	f, err := scanField(s.db.QueryRowContext(context.Background(), `SELECT `+fieldColumns+` FROM asset_metadata_fields WHERE id=$1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Field{}, ErrNotFound
	}
	return f, err
}

// DeleteField entfernt die Felddefinition. Bereits gespeicherte Werte bleiben
// im Asset erhalten (sie werden zu freien Feldern).
func (s *Store) DeleteField(id string) error {
	res, err := s.db.ExecContext(context.Background(), `DELETE FROM asset_metadata_fields WHERE id=$1`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// ---- Validierung -----------------------------------------------------------------

func (m Metadata) block(cat string) map[string]any {
	switch cat {
	case "system":
		return m.System
	case "technical":
		return m.Technical
	case "descriptive":
		return m.Descriptive
	case "editorial":
		return m.Editorial
	case "custom":
		return m.Custom
	case "ai":
		return m.AI
	}
	return nil
}

// ValidateMetadata prüft die Werte registrierter Felder (Typ, Auswahlliste,
// Pflicht). Schlüssel ohne Registrierung werden nicht geprüft. Liefert alle
// Verstöße, nicht nur den ersten; nil = in Ordnung.
func ValidateMetadata(fields []Field, m Metadata) []string {
	var problems []string
	for _, f := range fields {
		v, present := m.block(f.Category)[f.Key]
		if !present || v == nil || isEmpty(v) {
			if f.Required {
				problems = append(problems, fmt.Sprintf("%s.%s (%s): Pflichtfeld", f.Category, f.Key, f.Label))
			}
			continue
		}
		items := []any{v}
		if arr, ok := v.([]any); ok {
			if !f.Multiple {
				problems = append(problems, fmt.Sprintf("%s.%s (%s): nur ein Wert erlaubt", f.Category, f.Key, f.Label))
				continue
			}
			items = arr
		} else if f.Multiple {
			// Ein Einzelwert ist bei einem Mehrfachfeld zulässig.
			items = []any{v}
		}
		for _, it := range items {
			if msg := checkValue(f, it); msg != "" {
				problems = append(problems, fmt.Sprintf("%s.%s (%s): %s", f.Category, f.Key, f.Label, msg))
				break
			}
		}
	}
	return problems
}

func isEmpty(v any) bool {
	switch x := v.(type) {
	case string:
		return strings.TrimSpace(x) == ""
	case []any:
		return len(x) == 0
	}
	return false
}

func checkValue(f Field, v any) string {
	switch f.DataType {
	case FieldText, FieldLongText:
		if _, ok := v.(string); !ok {
			return "Text erwartet"
		}
	case FieldURL:
		s, ok := v.(string)
		if !ok || !(strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://") || strings.HasPrefix(s, "urn:")) {
			return "URL (http, https oder urn) erwartet"
		}
	case FieldInteger:
		n, ok := v.(float64)
		if !ok || n != math.Trunc(n) {
			return "ganze Zahl erwartet"
		}
	case FieldNumber:
		if _, ok := v.(float64); !ok {
			return "Zahl erwartet"
		}
	case FieldBoolean:
		if _, ok := v.(bool); !ok {
			return "Ja/Nein erwartet"
		}
	case FieldDate:
		s, ok := v.(string)
		if _, err := time.Parse("2006-01-02", s); !ok || err != nil {
			return "Datum JJJJ-MM-TT erwartet"
		}
	case FieldDateTime:
		s, ok := v.(string)
		if _, err := time.Parse(time.RFC3339, s); !ok || err != nil {
			return "Zeitpunkt nach RFC 3339 erwartet"
		}
	case FieldEnum:
		s, ok := v.(string)
		if ok {
			for _, e := range f.EnumValues {
				if e == s {
					return ""
				}
			}
		}
		return "Wert nicht in der Auswahlliste"
	}
	return ""
}
