import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  applyForm, defaultsOf, exportPackage, fieldsFromSchema, formFromManifest, importPackage, nextFreeId, parseManifest,
  renamePackage, schemaFromFields, SCHEMA_URL, slugify, validateFields,
} from "./logic.ts";

Deno.test("slugify löst Umlaute und Sonderzeichen auf", () => {
  assertEquals(slugify("Mein schöner Titel!"), "mein-schoener-titel");
  assertEquals(slugify("  --Ünder  "), "uender");
  assertEquals(slugify("***"), "");
  assertEquals(slugify("a".repeat(100)).length, 63);
});

Deno.test("nextFreeId zählt hoch", () => {
  assertEquals(nextFreeId("Titel", ["a"]), "titel");
  assertEquals(nextFreeId("Titel", ["titel"]), "titel-2");
  assertEquals(nextFreeId("Titel", ["titel", "titel-2"]), "titel-3");
  assertEquals(nextFreeId("!!!", []), "vorlage");
});

const MANIFEST = {
  "$schema": SCHEMA_URL, id: "x", name: "X", version: "1.0.0", main: "x.js", supportsRealTime: true, supportsNonRealTime: false,
  stepCount: 2, author: { name: "A", url: "https://a" }, designWidth: 1920, v_eigen: { a: 1 },
  renderRequirements: [{ resolution: { width: { ideal: 1920 }, height: { ideal: 1080 } }, frameRate: { ideal: 25 }, accessToPublicInternet: { exact: false } }],
};

Deno.test("Formular liest das Manifest und schreibt es verlustfrei zurück", () => {
  const f = formFromManifest(MANIFEST);
  assertEquals([f.name, f.stepCount, f.width, f.height, f.frameRate, f.authorName], ["X", 2, 1920, 1080, 25, "A"]);
  const back = applyForm(MANIFEST, f, "x");
  assertEquals(back, MANIFEST); // nichts verloren: designWidth, v_eigen, accessToPublicInternet, Reihenfolge der Werte
});

Deno.test("Formular: leere optionale Felder verschwinden, Pflichtfelder bleiben", () => {
  const f = { ...formFromManifest(MANIFEST), version: "", description: "", authorName: "", width: 0, height: 0, frameRate: 0 };
  const m = applyForm(MANIFEST, f, "x");
  assertEquals("version" in m, false);
  assertEquals("author" in m, false);
  assertEquals((m.renderRequirements as unknown[]).length, 1); // accessToPublicInternet bleibt
  assertEquals(m.supportsRealTime, true);
  const m2 = applyForm({ ...MANIFEST, renderRequirements: undefined }, f, "x");
  assertEquals("renderRequirements" in m2, false);
});

Deno.test("Schema ↔ Feldliste: Arten, Vorgaben, unbekannte Eigenschaften bleiben", () => {
  const schema = {
    type: "object", required: ["name"], additionalProperties: false,
    properties: {
      name: { type: "string", title: "Name", default: "Gast" },
      info: { type: "string", gddType: "multi-line", title: "Info" },
      n: { type: "number", default: 3, minimum: 0 },
      on: { type: "boolean", default: true },
      c: { type: "string", gddType: "color-rrggbb", pattern: "^#[0-9a-f]{6}$", default: "#ff8c00" },
      side: { type: "string", enum: ["left", "right"], default: "left", enumNames: ["L", "R"] },
    },
  };
  const fields = fieldsFromSchema(schema);
  assertEquals(fields.map((f) => f.kind), ["text", "multiline", "number", "bool", "color", "choice"]);
  assertEquals(fields[0].required, true);
  assertEquals(fields[2].extra, { minimum: 0 });
  assertEquals(fields[5].extra, { enumNames: ["L", "R"] });
  const back = schemaFromFields(fields, schema) as Record<string, unknown>;
  assertEquals(back.additionalProperties, false);
  assertEquals(back.required, ["name"]);
  const p = back.properties as Record<string, Record<string, unknown>>;
  assertEquals(p.n, { type: "number", default: 3, minimum: 0 });
  assertEquals(p.side.enumNames, ["L", "R"]);
  assertEquals(p.c.gddType, "color-rrggbb");
  assertEquals(p.c.pattern, "^#[0-9a-f]{6}$"); // GDD-Muster (Kleinbuchstaben), auch wenn das Eingangsschema "[0-9a-f]" hatte
  assertEquals(defaultsOf(fields), { name: "Gast", n: 3, on: true, c: "#ff8c00", side: "left" });
});

Deno.test("Feld ändern/entfernen wirkt im Schema", () => {
  const fields = fieldsFromSchema({ type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a"] });
  const next = fields.filter((f) => f.key !== "a");
  const s = schemaFromFields(next, { type: "object", required: ["a"], properties: {} }) as Record<string, unknown>;
  assertEquals(Object.keys(s.properties as object), ["b"]);
  assertEquals("required" in s, false);
});

Deno.test("validateFields meldet Fehler", () => {
  const f = fieldsFromSchema({ properties: { a: { type: "string" } } });
  assertEquals(validateFields(f), []);
  const bad = [
    { ...f[0], key: "1x" },
    { ...f[0], key: "a" },
    { ...f[0], key: "a" },
    { ...f[0], key: "c", kind: "choice" as const, choices: [], def: "z" },
    { ...f[0], key: "n", kind: "number" as const, def: "abc" },
    { ...f[0], key: "col", kind: "color" as const, def: "red" },
  ];
  const msgs = validateFields(bad);
  assertEquals(msgs.length, 6);
  assertNotEquals(msgs.find((m) => m.includes("doppelt")), undefined);
});

Deno.test("Export und Import eines Pakets", () => {
  const files = { "x.ograf.json": JSON.stringify(MANIFEST), "x.js": "export default class {}" };
  const text = exportPackage("x", files);
  assertEquals(importPackage(text), { id: "x", files });
  assertEquals("error" in importPackage("{"), true);
  assertEquals("error" in importPackage('{"format":"anders"}'), true);
  assertEquals("error" in importPackage(JSON.stringify({ format: "omp-ograf-package/1", id: "x", files: { a: 1 } })), true);
});

Deno.test("renamePackage zieht Manifest, id und main mit um", () => {
  const files = { "x.ograf.json": JSON.stringify(MANIFEST), "x.js": "js", "style.css": "css" };
  const out = renamePackage(files, "x", "y");
  assertEquals(Object.keys(out).sort(), ["style.css", "y.js", "y.ograf.json"]);
  const m = parseManifest(out)!;
  assertEquals([m.id, m.main], ["y", "y.js"]);
  assertEquals(m.designWidth, 1920); // unbekannte Felder bleiben
});

Deno.test("GDD: Farbwert klein, unbekannte gddType/komplexe Eigenschaften bleiben erhalten", () => {
  const schema = {
    type: "object",
    properties: {
      c: { type: "string", gddType: "color-rrggbb", pattern: "^#[0-9a-f]{6}$", default: "#FF8C00" },
      p: { type: "number", gddType: "percentage", default: 50 },
      d: { type: "integer", gddType: "duration-ms" },
      f: { type: "string", gddType: "file-path/image-path", gddOptions: { extensions: ["png"] } },
      m: { type: "array", gddType: "select-multiple", items: { type: "string", enum: ["a"] }, gddOptions: { labels: { a: "A" } } },
      h: { type: "string", hidden: true, order: 3 },
    },
  };
  const fields = fieldsFromSchema(schema);
  assertEquals(fields.map((f) => f.kind), ["color", "number", "number", "text", "raw", "text"]);
  const back = schemaFromFields(fields, schema) as { properties: Record<string, Record<string, unknown>> };
  assertEquals(back.properties.c.default, "#ff8c00"); // klein geschrieben
  assertEquals(back.properties.p.gddType, "percentage"); // bleibt
  assertEquals(back.properties.f.gddOptions, { extensions: ["png"] });
  assertEquals(back.properties.m, schema.properties.m); // komplex: unverändert
  assertEquals([back.properties.h.hidden, back.properties.h.order], [true, 3]);
  assertEquals(defaultsOf(fields), { c: "#FF8C00", p: 50 }); // raw wird nicht zum Vorgabewert
  assertEquals(validateFields(fields), []);
});

Deno.test("Formular: Vorschaubild wird gesetzt und entfernt", () => {
  const f = { ...formFromManifest(MANIFEST), thumbnail: "vorschau.png" };
  const m = applyForm(MANIFEST, f, "x");
  assertEquals(m.thumbnails, [{ file: "vorschau.png" }]);
  assertEquals(formFromManifest(m).thumbnail, "vorschau.png");
  const m2 = applyForm(m, { ...f, thumbnail: "" }, "x");
  assertEquals("thumbnails" in m2, false);
});
