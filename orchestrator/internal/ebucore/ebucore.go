// Package ebucore bildet Assets auf EBUCore ab und zurück (EBU Tech 3293 v1.10,
// Schema ebucore.xsd 1.10.1, Namensraum urn:ebu:metadata-schema:ebucore) —
// UMSETZUNG.md Kapitel 78.2, Entwurf docs/ENTWURF-NORMEN-EBUCORE-R103-R143.md.
//
// Der Export erzeugt ein ebuCoreMain-Dokument mit einem coreMetadata-Element. Felder
// mit EBUCore-Ziel (asset.Field.EBUCoreTarget) landen im passenden Standardelement;
// alle übrigen Werte gehen nach dem Muster aus Tech 3293 §3.19 als typeLabel-
// Attribute mit (Beschriftung "<Kategorie>.<Schlüssel>"), technische Werte als
// technicalAttribute* am containerFormat. Dadurch verliert der Rundlauf keine
// dynamischen Felder.
package ebucore

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/infantilo/openmediaplatform/orchestrator/internal/asset"
)

const (
	// Namespace ist der EBUCore-Namensraum (Tech 3293).
	Namespace = "urn:ebu:metadata-schema:ebucore"
	// NamespaceDC ist Dublin Core (dc:title usw.), das EBUCore wiederverwendet.
	NamespaceDC = "http://purl.org/dc/elements/1.1/"
	// Version der EBUCore-Spezifikation, gegen die erzeugt wird.
	Version = "1.10"
	// IdentifierLabel kennzeichnet die OMP-Asset-ID im identifier-Element.
	IdentifierLabel = "OMP"
)

// Export erzeugt das EBUCore-Dokument eines Assets. reps sind die Representations
// der aktuellen Version (dürfen leer sein); fields die für den Asset-Typ geltenden
// Felddefinitionen (asset.Store.ListFields).
func Export(a asset.Asset, reps []asset.Representation, fields []asset.Field, now time.Time) ([]byte, error) {
	var b bytes.Buffer
	w := &writer{b: &b}
	b.WriteString(xml.Header)
	w.open("ebucore:ebuCoreMain", [][2]string{
		{"xmlns:ebucore", Namespace}, {"xmlns:dc", NamespaceDC}, {"version", Version},
		{"writingLibraryName", "OpenMediaPlatform"},
		{"dateLastModified", now.UTC().Format("2006-01-02")}, {"timeLastModified", now.UTC().Format("15:04:05Z")},
		{"documentId", a.ID},
	})
	w.open("ebucore:coreMetadata", nil)

	w.open("ebucore:title", nil)
	w.text("dc:title", a.Title)
	w.close("ebucore:title")
	if a.Description != "" {
		w.open("ebucore:description", nil)
		w.text("dc:description", a.Description)
		w.close("ebucore:description")
	}
	w.open("ebucore:identifier", [][2]string{{"typeLabel", IdentifierLabel}})
	w.text("dc:identifier", a.ID)
	w.close("ebucore:identifier")
	if !a.CreatedAt.IsZero() {
		w.open("ebucore:date", nil)
		w.empty("ebucore:created", [][2]string{{"date", a.CreatedAt.UTC().Format("2006-01-02")}, {"time", a.CreatedAt.UTC().Format("15:04:05Z")}})
		w.close("ebucore:date")
	}
	if a.Type != "" {
		w.open("ebucore:type", nil)
		w.text("dc:type", a.Type)
		w.close("ebucore:type")
	}

	known := map[string]asset.Field{}
	for _, f := range fields {
		known[f.Category+"."+f.Key] = f
	}
	var techAttrs [][3]string // typeLabel, Element, Wert
	for _, cat := range asset.MetadataCategories {
		block := blockOf(a.Metadata, cat)
		keys := make([]string, 0, len(block))
		for k := range block {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			f, registered := known[cat+"."+k]
			for _, v := range values(block[k]) {
				s := render(v)
				if s == "" {
					continue
				}
				switch {
				case registered && f.EBUCoreTarget != "":
					writeTarget(w, f, s)
				case cat == "technical":
					techAttrs = append(techAttrs, [3]string{k, techElement(v), s})
				default:
					w.open("ebucore:description", [][2]string{{"typeLabel", cat + "." + k}})
					w.text("dc:description", s)
					w.close("ebucore:description")
				}
			}
		}
	}

	for _, r := range reps {
		writeFormat(w, r)
	}
	if len(techAttrs) > 0 {
		w.open("ebucore:format", nil)
		w.open("ebucore:containerFormat", nil)
		// Die technicalAttribute*-Elemente haben im Schema eine feste Reihenfolge.
		sort.SliceStable(techAttrs, func(i, j int) bool { return techRank[techAttrs[i][1]] < techRank[techAttrs[j][1]] })
		for _, t := range techAttrs {
			w.text("ebucore:"+t[1], t[2], [2]string{"typeLabel", t[0]})
		}
		w.close("ebucore:containerFormat")
		w.close("ebucore:format")
	}

	w.close("ebucore:coreMetadata")
	w.close("ebucore:ebuCoreMain")
	return b.Bytes(), w.err
}

func writeTarget(w *writer, f asset.Field, s string) {
	switch f.EBUCoreTarget {
	case "alternativeTitle":
		w.open("ebucore:alternativeTitle", [][2]string{{"typeLabel", f.Label}})
		w.text("dc:title", s)
		w.close("ebucore:alternativeTitle")
	case "description":
		w.open("ebucore:description", [][2]string{{"typeLabel", f.Category + "." + f.Key}})
		w.text("dc:description", s)
		w.close("ebucore:description")
	case "subject":
		w.open("ebucore:subject", nil)
		w.text("dc:subject", s)
		w.close("ebucore:subject")
	case "language":
		w.open("ebucore:language", nil)
		w.text("dc:language", s)
		w.close("ebucore:language")
	case "genre":
		w.open("ebucore:type", nil)
		w.empty("ebucore:genre", [][2]string{{"typeDefinition", s}})
		w.close("ebucore:type")
	case "identifier":
		w.open("ebucore:identifier", [][2]string{{"typeLabel", f.Label}})
		w.text("dc:identifier", s)
		w.close("ebucore:identifier")
	case "creator", "contributor", "publisher":
		el := "ebucore:" + f.EBUCoreTarget
		w.open(el, nil)
		if f.EBUCoreTarget == "publisher" {
			w.open("ebucore:organisationDetails", nil)
			w.text("ebucore:organisationName", s)
			w.close("ebucore:organisationDetails")
		} else {
			w.open("ebucore:contactDetails", nil)
			w.text("ebucore:name", s)
			w.close("ebucore:contactDetails")
		}
		w.close(el)
	}
}

func writeFormat(w *writer, r asset.Representation) {
	w.open("ebucore:format", [][2]string{{"formatId", r.ID}, {"formatName", r.Type}})
	if r.SizeBytes != nil {
		w.text("ebucore:fileSize", strconv.FormatInt(*r.SizeBytes, 10), [2]string{"unit", "byte"})
	}
	if r.Storage.URI != "" {
		w.text("ebucore:locator", r.Storage.URI)
	}
	if r.Width != nil || r.Height != nil || r.FrameRate != nil || (r.Codec != "" && r.Width != nil) {
		attrs := [][2]string{}
		if r.Codec != "" {
			attrs = append(attrs, [2]string{"videoFormatName", r.Codec})
		}
		w.open("ebucore:videoFormat", attrs)
		if r.Width != nil {
			w.text("ebucore:width", strconv.Itoa(*r.Width), [2]string{"unit", "pixel"})
		}
		if r.Height != nil {
			w.text("ebucore:height", strconv.Itoa(*r.Height), [2]string{"unit", "pixel"})
		}
		if r.FrameRate != nil && *r.FrameRate > 0 {
			num, den := rational(*r.FrameRate)
			// Inhalt ist laut Schema eine ganze Zahl (gerundete Bildrate); der genaue
			// Wert steckt im Bruch aus den Attributen (Tech 3293 §3.19: 25 = 25000/1000).
			w.text("ebucore:frameRate", strconv.Itoa(int(*r.FrameRate+0.5)),
				[2]string{"factorNumerator", strconv.Itoa(num)}, [2]string{"factorDenominator", strconv.Itoa(den)})
		}
		w.close("ebucore:videoFormat")
	}
	if r.SampleRate != nil || r.Channels != nil {
		w.open("ebucore:audioFormat", nil)
		if r.SampleRate != nil {
			w.text("ebucore:samplingRate", strconv.Itoa(*r.SampleRate))
		}
		if r.Channels != nil {
			w.text("ebucore:channels", strconv.Itoa(*r.Channels))
		}
		w.close("ebucore:audioFormat")
	}
	if r.Container != "" {
		w.open("ebucore:containerFormat", [][2]string{{"containerFormatName", r.Container}})
		w.close("ebucore:containerFormat")
	}
	if r.Checksum != "" {
		w.text("ebucore:technicalAttributeString", r.Checksum, [2]string{"typeLabel", "checksum"})
	}
	if r.Bitrate != nil {
		w.text("ebucore:overallBitRate", strconv.FormatInt(*r.Bitrate, 10), [2]string{"unit", "bit/s"})
	}
	w.close("ebucore:format")
}

// rational liefert eine Bruchdarstellung der Bildrate (23.976 → 24000/1001).
func rational(f float64) (int, int) {
	for _, d := range []int{1, 1001} {
		n := f * float64(d)
		if r := float64(int(n + 0.5)); r-n < 0.002 && n-r < 0.002 {
			return int(n + 0.5), d
		}
	}
	return int(f*1000 + 0.5), 1000
}

var techRank = map[string]int{
	"technicalAttributeString": 0, "technicalAttributeLong": 1, "technicalAttributeBoolean": 2, "technicalAttributeFloat": 3,
}

func techElement(v any) string {
	switch x := v.(type) {
	case bool:
		return "technicalAttributeBoolean"
	case float64:
		if x == float64(int64(x)) {
			return "technicalAttributeLong"
		}
		return "technicalAttributeFloat"
	}
	return "technicalAttributeString"
}

func values(v any) []any {
	if arr, ok := v.([]any); ok {
		return arr
	}
	return []any{v}
}

func render(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(x)
	case bool:
		return strconv.FormatBool(x)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	}
	return fmt.Sprint(v)
}

func blockOf(m asset.Metadata, cat string) map[string]any {
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

// ---- kleiner XML-Schreiber -------------------------------------------------------

type writer struct {
	b   *bytes.Buffer
	err error
}

func (w *writer) open(name string, attrs [][2]string) {
	w.b.WriteString("<" + name)
	w.attrs(attrs)
	w.b.WriteString(">\n")
}
func (w *writer) close(name string) { w.b.WriteString("</" + name + ">\n") }
func (w *writer) empty(name string, attrs [][2]string) {
	w.b.WriteString("<" + name)
	w.attrs(attrs)
	w.b.WriteString("/>\n")
}
func (w *writer) text(name, s string, attrs ...[2]string) {
	w.b.WriteString("<" + name)
	w.attrs(attrs)
	w.b.WriteString(">")
	if err := xml.EscapeText(w.b, []byte(s)); err != nil && w.err == nil {
		w.err = err
	}
	w.b.WriteString("</" + name + ">\n")
}
func (w *writer) attrs(attrs [][2]string) {
	for _, a := range attrs {
		w.b.WriteString(" " + a[0] + `="`)
		if err := xml.EscapeText(w.b, []byte(a[1])); err != nil && w.err == nil {
			w.err = err
		}
		w.b.WriteString(`"`)
	}
}

// ---- Import -----------------------------------------------------------------------

// Imported ist das Ergebnis des Einlesens: neue Werte für Titel/Beschreibung und die
// Metadaten, plus Hinweise (nicht übernommene Elemente).
type Imported struct {
	Title       string         `json:"title,omitempty"`
	Description string         `json:"description,omitempty"`
	Metadata    asset.Metadata `json:"metadata"`
	// Skipped listet Elemente, die EBUCore kennt, OMP aber nicht ablegt
	// (zum Beispiel format: kommt aus den Representations).
	Skipped []string `json:"skipped,omitempty"`
}

type node struct {
	XMLName  xml.Name
	Attrs    []xml.Attr `xml:",any,attr"`
	Children []node     `xml:",any"`
	Text     string     `xml:",chardata"`
}

func (n node) attr(name string) string {
	for _, a := range n.Attrs {
		if a.Name.Local == name {
			return a.Value
		}
	}
	return ""
}

func (n node) child(local string) (node, bool) {
	for _, c := range n.Children {
		if c.XMLName.Local == local {
			return c, true
		}
	}
	return node{}, false
}

func (n node) value() string { return strings.TrimSpace(n.Text) }

// Import liest ein EBUCore-Dokument. fields bestimmen, in welches Feld ein Element
// mit EBUCore-Ziel fällt und welchen Datentyp ein Wert bekommt.
func Import(r io.Reader, fields []asset.Field) (Imported, error) {
	var root node
	if err := xml.NewDecoder(r).Decode(&root); err != nil {
		return Imported{}, fmt.Errorf("%w: not well-formed XML: %v", asset.ErrValidation, err)
	}
	if root.XMLName.Space != Namespace || root.XMLName.Local != "ebuCoreMain" {
		return Imported{}, fmt.Errorf("%w: root element must be {%s}ebuCoreMain", asset.ErrValidation, Namespace)
	}
	core, ok := root.child("coreMetadata")
	if !ok {
		return Imported{}, fmt.Errorf("%w: coreMetadata missing", asset.ErrValidation)
	}

	byTarget := map[string]asset.Field{}
	byKey := map[string]asset.Field{}
	for _, f := range fields {
		byKey[f.Category+"."+f.Key] = f
		if f.EBUCoreTarget != "" {
			if _, dup := byTarget[f.EBUCoreTarget]; !dup {
				byTarget[f.EBUCoreTarget] = f
			}
		}
	}
	out := Imported{Metadata: asset.Metadata{}}
	skipped := map[string]bool{}
	put := func(f asset.Field, raw string) {
		blk := ensure(&out.Metadata, f.Category)
		v := convert(f, raw)
		if cur, ok := blk[f.Key]; ok || f.Multiple {
			blk[f.Key] = append(asAny(cur), v)
			return
		}
		blk[f.Key] = v
	}
	putFree := func(cat, key, raw string) {
		if f, ok := byKey[cat+"."+key]; ok {
			put(f, raw)
			return
		}
		blk := ensure(&out.Metadata, cat)
		blk[key] = raw
	}

	for _, c := range core.Children {
		switch c.XMLName.Local {
		case "title":
			if t, ok := c.child("title"); ok && out.Title == "" {
				out.Title = t.value()
			}
		case "description":
			d, _ := c.child("description")
			label := c.attr("typeLabel")
			switch {
			case label == "":
				if out.Description == "" {
					out.Description = d.value()
				}
			case strings.Contains(label, "."):
				cat, key, _ := strings.Cut(label, ".")
				putFree(cat, key, d.value())
			default:
				if f, ok := byTarget["description"]; ok {
					put(f, d.value())
				} else {
					putFree("custom", label, d.value())
				}
			}
		case "alternativeTitle":
			if t, ok := c.child("title"); ok {
				importTarget(&out, byTarget, "alternativeTitle", t.value(), putFree, put)
			}
		case "subject":
			if t, ok := c.child("subject"); ok {
				importTarget(&out, byTarget, "subject", t.value(), putFree, put)
			}
		case "language":
			if t, ok := c.child("language"); ok {
				importTarget(&out, byTarget, "language", t.value(), putFree, put)
			}
		case "identifier":
			if t, ok := c.child("identifier"); ok && c.attr("typeLabel") != IdentifierLabel {
				importTarget(&out, byTarget, "identifier", t.value(), putFree, put)
			}
		case "type":
			if g, ok := c.child("genre"); ok {
				importTarget(&out, byTarget, "genre", g.attr("typeDefinition"), putFree, put)
			}
		case "creator", "contributor", "publisher":
			name := ""
			if d, ok := c.child("contactDetails"); ok {
				if n, ok := d.child("name"); ok {
					name = n.value()
				}
			}
			if d, ok := c.child("organisationDetails"); ok {
				if n, ok := d.child("organisationName"); ok {
					name = n.value()
				}
			}
			importTarget(&out, byTarget, c.XMLName.Local, name, putFree, put)
		case "format":
			for _, f := range c.Children {
				if f.XMLName.Local != "containerFormat" {
					continue
				}
				for _, t := range f.Children {
					if strings.HasPrefix(t.XMLName.Local, "technicalAttribute") && t.attr("typeLabel") != "" {
						putFree("technical", t.attr("typeLabel"), t.value())
					}
				}
			}
			skipped["format (kommt aus den Representations)"] = true
		case "date":
			skipped["date"] = true
		default:
			skipped[c.XMLName.Local] = true
		}
	}
	for s := range skipped {
		out.Skipped = append(out.Skipped, s)
	}
	sort.Strings(out.Skipped)
	return out, nil
}

func importTarget(out *Imported, byTarget map[string]asset.Field, target, raw string, putFree func(cat, key, raw string), put func(asset.Field, string)) {
	if raw == "" {
		return
	}
	if f, ok := byTarget[target]; ok {
		put(f, raw)
		return
	}
	putFree("custom", target, raw)
}

func ensure(m *asset.Metadata, cat string) map[string]any {
	var p *map[string]any
	switch cat {
	case "system":
		p = &m.System
	case "technical":
		p = &m.Technical
	case "descriptive":
		p = &m.Descriptive
	case "editorial":
		p = &m.Editorial
	case "ai":
		p = &m.AI
	default:
		p = &m.Custom
	}
	if *p == nil {
		*p = map[string]any{}
	}
	return *p
}

func asAny(v any) []any {
	if arr, ok := v.([]any); ok {
		return arr
	}
	if v == nil {
		return nil
	}
	return []any{v}
}

// convert wandelt den Textwert in den Datentyp des Felds. Passt der Wert nicht, bleibt
// er Text (die Validierung beim Speichern meldet es dann).
func convert(f asset.Field, raw string) any {
	switch f.DataType {
	case asset.FieldInteger, asset.FieldNumber:
		if n, err := strconv.ParseFloat(raw, 64); err == nil {
			return n
		}
	case asset.FieldBoolean:
		if b, err := strconv.ParseBool(raw); err == nil {
			return b
		}
	}
	return raw
}
