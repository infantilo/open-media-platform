package nodeoptions

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func f(v float64) *float64 { return &v }

func TestValidateByType(t *testing.T) {
	cases := []struct {
		name string
		o    Option
		in   string
		want string
		bad  bool
	}{
		{"leer = Standard", Option{Label: "x", Type: TypeInt}, "  ", "", false},
		{"int ok", Option{Label: "x", Type: TypeInt, Min: f(1), Max: f(10)}, " 7 ", "7", false},
		{"int zu klein", Option{Label: "x", Type: TypeInt, Min: f(1)}, "0", "", true},
		{"int zu groß", Option{Label: "x", Type: TypeInt, Max: f(10)}, "11", "", true},
		{"int Text", Option{Label: "x", Type: TypeInt}, "abc", "", true},
		{"port ok", Option{Label: "p", Type: TypePort}, "6000", "6000", false},
		{"port 0 (automatisch)", Option{Label: "p", Type: TypePort}, "0", "0", false},
		{"port zu groß", Option{Label: "p", Type: TypePort}, "70000", "", true},
		{"float ok", Option{Label: "x", Type: TypeFloat}, "0.50", "0.5", false},
		{"float NaN", Option{Label: "x", Type: TypeFloat}, "NaN", "", true},
		{"enum ok", Option{Label: "m", Type: TypeEnum, Choices: []Choice{{Value: "tcp"}, {Value: "verbs"}}}, "tcp", "tcp", false},
		{"enum falsch", Option{Label: "m", Type: TypeEnum, Choices: []Choice{{Value: "tcp"}}}, "udp", "", true},
		{"host ok", Option{Label: "h", Type: TypeHost}, "239.1.1.1", "239.1.1.1", false},
		{"host mit Leerzeichen", Option{Label: "h", Type: TypeHost}, "a b", "", true},
		{"host Shell-Zeichen", Option{Label: "h", Type: TypeHost}, "a;rm -rf", "", true},
		{"url ok", Option{Label: "u", Type: TypeURL}, "srt://127.0.0.1:7000", "srt://127.0.0.1:7000", false},
		{"url ohne Schema", Option{Label: "u", Type: TypeURL}, "127.0.0.1:7000", "", true},
		{"Zeilenumbruch", Option{Label: "s", Type: TypeString}, "a\nb", "", true},
	}
	for _, c := range cases {
		got, _, err := Validate(c.o, c.in)
		if (err != nil) != c.bad || got != c.want {
			t.Errorf("%s: got %q err=%v", c.name, got, err)
		}
	}
}

func TestValidatePath(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "a.txt")
	_ = os.WriteFile(file, []byte("x"), 0o644)
	d := Option{Label: "Medien", Type: TypePath, PathKind: PathDir}

	if v, w, err := Validate(d, dir); err != nil || v != dir || w != "" {
		t.Fatalf("vorhandenes Verzeichnis: %q %q %v", v, w, err)
	}
	if _, w, err := Validate(d, filepath.Join(dir, "neu")); err != nil || !strings.Contains(w, "existiert nicht") {
		t.Fatalf("fehlender Pfad ohne MustExist = Warnung: %q %v", w, err)
	}
	strict := d
	strict.MustExist = true
	if _, _, err := Validate(strict, filepath.Join(dir, "neu")); err == nil {
		t.Fatal("MustExist: fehlender Pfad ist ein Fehler")
	}
	if _, _, err := Validate(d, file); err == nil {
		t.Fatal("Datei statt Verzeichnis muss abgelehnt werden")
	}
	if _, _, err := Validate(d, dir+"/../etc"); err == nil {
		t.Fatal("„..“ nicht erlaubt")
	}
	fo := Option{Label: "Datei", Type: TypePath, PathKind: PathFile}
	if _, _, err := Validate(fo, file); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Validate(fo, dir); err == nil {
		t.Fatal("Verzeichnis statt Datei")
	}
	if info := CheckPath(dir, PathDir); !info.Readable || info.Entries != 1 {
		t.Fatalf("%+v", info)
	}
}

func TestValidateSchemaRejectsReservedDuplicatesAndBadTypes(t *testing.T) {
	ok := Option{Key: "OMP_MEDIA_DIR", Label: "Medien", Type: TypePath, PathKind: PathDir}
	if err := ValidateSchema([]Option{ok}); err != nil {
		t.Fatal(err)
	}
	for name, o := range map[string]Option{
		"reserviert":  {Key: "OMP_INSTANCE_ID", Label: "x", Type: TypeString},
		"kein OMP_":   {Key: "PATH", Label: "x", Type: TypeString},
		"ohne Label":  {Key: "OMP_X1", Type: TypeString},
		"Typ":         {Key: "OMP_X1", Label: "x", Type: "magie"},
		"enum leer":   {Key: "OMP_X1", Label: "x", Type: TypeEnum},
		"path ohne k": {Key: "OMP_X1", Label: "x", Type: TypePath},
	} {
		if ValidateSchema([]Option{o}) == nil {
			t.Errorf("%s sollte abgelehnt werden", name)
		}
	}
	if ValidateSchema([]Option{ok, ok}) == nil {
		t.Error("doppelter Schlüssel")
	}
}

// Die ausgelieferte deploy/node-options.json muss gültig sein, nur Typen des Katalogs
// betreffen und für jede Option einen gültigen Standardwert tragen.
func TestShippedNodeOptionsAreValid(t *testing.T) {
	m, err := LoadFile("../../../deploy/node-options.json")
	if err != nil {
		t.Fatal(err)
	}
	cat, err := os.ReadFile("../../../deploy/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	for typ, opts := range m {
		if !strings.Contains(string(cat), `"type": "`+typ+`"`) {
			t.Errorf("Typ %s steht nicht im Katalog", typ)
		}
		for _, o := range opts {
			if o.Default == "" || o.Type == TypePath {
				continue // Standard leer = Node-eigener Standard; Pfade können je Rechner fehlen
			}
			if _, _, err := Validate(o, o.Default); err != nil {
				t.Errorf("%s/%s: Standardwert %q ungültig: %v", typ, o.Key, o.Default, err)
			}
		}
	}
	if len(m) < 20 {
		t.Errorf("auffällig wenige Node-Typen: %d", len(m))
	}
}
