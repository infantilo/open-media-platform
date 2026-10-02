import { assertEquals } from "jsr:@std/assert";
import { effectiveValue, groupOptions, hintFor, inputKind, isDirty, type OptionDef } from "./settings-logic.ts";

const opt = (o: Partial<OptionDef>): OptionDef => ({ key: "OMP_X", label: "X", type: "string", ...o });

Deno.test("groupOptions behält die Reihenfolge der ersten Nennung", () => {
  const g = groupOptions([{ group: "B" }, { group: "A" }, { group: "B" }, {}]);
  assertEquals(g.map(([n, l]) => `${n}:${l.length}`), ["B:2", "A:1", "Allgemein:1"]);
});

Deno.test("hintFor nennt Standard, Bereich und Pfadart", () => {
  assertEquals(hintFor(opt({ type: "int", default: "25", min: 1, max: 60 })), "Standard: 25 · erlaubt: 1 bis 60");
  assertEquals(hintFor(opt({ type: "path", pathKind: "dir", mustExist: true })), "Standard: vom Node bestimmt · Verzeichnis · muss existieren");
  assertEquals(hintFor(opt({ type: "path", pathKind: "file", default: "a.sdp" })), "Standard: a.sdp · Datei");
});

Deno.test("effectiveValue: Instanz vor Typ vor Standard", () => {
  const o = opt({ default: "d", value: "t" });
  assertEquals(effectiveValue(o, "i"), { value: "i", source: "instance" });
  assertEquals(effectiveValue(o, undefined), { value: "t", source: "type" });
  assertEquals(effectiveValue(opt({ default: "d" }), ""), { value: "d", source: "default" });
  assertEquals(effectiveValue(opt({}), undefined), { value: "", source: "node" });
});

Deno.test("inputKind und isDirty", () => {
  assertEquals(inputKind(opt({ type: "port" })), "number");
  assertEquals(inputKind(opt({ type: "enum" })), "select");
  assertEquals(inputKind(opt({ type: "path" })), "text");
  assertEquals(isDirty(" 5 ", "5"), false);
  assertEquals(isDirty("6", "5"), true);
});
