import { assertEquals } from "jsr:@std/assert";
import { chainSummary, MAX_STAGES, newStageId, paramText, parseParam, type Stage, type StageType, validateStages } from "./chain-logic.ts";

const types: StageType[] = [{ nodeType: "omp-scaler", label: "Scaler", video: true, audio: false }];
const st = (id: string, where: "pre" | "post" = "pre"): Stage => ({ id, nodeType: "omp-scaler", where });

Deno.test("Parameter: Zahl, Wahrheitswert, JSON, Text", () => {
  assertEquals(parseParam("1280"), 1280);
  assertEquals(parseParam("-2.5"), -2.5);
  assertEquals(parseParam("true"), true);
  assertEquals(parseParam('{"a":1}'), { a: 1 });
  assertEquals(parseParam("{kaputt"), "{kaputt");
  assertEquals(parseParam(" text "), "text");
  assertEquals(paramText({ a: 1 }), '{"a":1}');
  assertEquals(paramText("x"), "x");
});

Deno.test("neue Kennung ist frei und gültig", () => {
  assertEquals(newStageId("omp-scaler", []), "scaler-1");
  assertEquals(newStageId("omp-scaler", ["scaler-1", "scaler-2"]), "scaler-3");
  assertEquals(/^[a-z0-9][a-z0-9-]{0,23}$/.test(newStageId("omp-Sehr Langer_Name!!", [])), true);
});

Deno.test("Prüfung: doppelte Kennung, unbekannter Typ, zu viele", () => {
  assertEquals(validateStages([st("a"), st("b")], types), null);
  assertEquals(validateStages([st("a"), st("a")], types), "id");
  assertEquals(validateStages([st("A B")], types), "id");
  assertEquals(validateStages([{ ...st("a"), nodeType: "omp-x" }], types), "type");
  assertEquals(validateStages(Array.from({ length: MAX_STAGES + 1 }, (_, i) => st(`s${i}`)), types), "tooMany");
});

Deno.test("Zusammenfassung zeigt die Reihenfolge, lässt ausgeschaltete weg, erbt = leer", () => {
  assertEquals(chainSummary([st("a"), { ...st("b", "post"), label: "Filter" }, { ...st("c"), enabled: false }], types, "Normalizer"), "Scaler → Normalizer → Filter");
  assertEquals(chainSummary(null, types, "Normalizer"), "");
  assertEquals(chainSummary([], types, "Normalizer"), "Normalizer");
});
