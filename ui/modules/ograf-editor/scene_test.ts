import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import RUNTIME from "./runtime.js" with { type: "text" };
import { bindText, keyframesFor } from "./runtime.js";
import {
  addElement, alignToScene, ensureParams, applyScene, duplicateElement, generateMain, hitTest, History, isDesigner, moveElements, newDesignerPackage,
  newElement, newScene, parseScene, placeholders, removeElements, reorder, resizeBox, SCENE_FORMAT, snapBox, updateElement, usedAssets, zoneIds,
} from "./scene.ts";
import { parseManifest } from "./logic.ts";

Deno.test("bindText ersetzt Platzhalter, fehlende werden leer", () => {
  assertEquals(bindText("Hallo {{name}}, {{ titel }}!", { name: "Max", titel: 3 }), "Hallo Max, 3!");
  assertEquals(bindText("{{fehlt}}x", {}), "x");
  assertEquals(bindText("kein Platzhalter", undefined), "kein Platzhalter");
  assertEquals(bindText("{{1ungültig}}", { "1ungültig": "a" }), "{{1ungültig}}");
});

Deno.test("keyframesFor: Ein = Aus rückwärts, none = null", () => {
  assertEquals(keyframesFor("none", "in"), null);
  const i = keyframesFor("fromLeft", "in")!;
  const o = keyframesFor("fromLeft", "out")!;
  assertEquals(i[0], o[1]);
  assertEquals(i[1], o[0]);
  assertEquals((keyframesFor("wipe", "in")![0] as Record<string, unknown>).clipPath, "inset(0 100% 0 0)");
  assertEquals((keyframesFor("fade", "in")![1] as Record<string, unknown>).opacity, 1);
});

Deno.test("Elemente anlegen: eindeutige IDs, Mitte, Zonennamen", () => {
  let s = newScene();
  const a = newElement("text", s);
  s = addElement(s, a);
  const b = newElement("text", s);
  assertNotEquals(a.id, b.id);
  assertEquals([a.x + a.w / 2, a.y + a.h / 2], [960, 540]);
  s = addElement(s, newElement("zone", s));
  assertEquals(zoneIds(s), ["window"]);
  assertEquals(newElement("zone", s).zone, "window2");
});

Deno.test("Bearbeiten: verschieben, Größe, Löschen, Duplizieren, Reihenfolge, Ausrichten", () => {
  let s = newScene();
  for (const k of ["rect", "text", "image"] as const) s = addElement(s, newElement(k, s));
  const [r, t, i] = s.elements.map((e) => e.id);
  s = moveElements(s, [r], 10.4, -5);
  assertEquals([s.elements[0].x - newElement("rect", newScene()).x, s.elements[0].y - newElement("rect", newScene()).y], [10, -5]);
  s = updateElement(s, t, { w: 1, opacity: 5 });
  assertEquals([s.elements[1].w, s.elements[1].opacity], [4, 1]); // Mindestgröße, Deckkraft ≤ 1
  s = reorder(s, r, "front");
  assertEquals(s.elements.map((e) => e.id), [t, i, r]);
  s = reorder(s, r, "down");
  assertEquals(s.elements.map((e) => e.id), [t, r, i]);
  const d = duplicateElement(s, t);
  assertEquals(d.scene.elements.length, 4);
  assertEquals(d.scene.elements[1].id, d.id);
  assertEquals(d.scene.elements[1].name, "Text 1 (Kopie)");
  s = removeElements(d.scene, [d.id, i]);
  assertEquals(s.elements.length, 2);
  s = alignToScene(s, t, "right");
  assertEquals(s.elements.find((e) => e.id === t)!.x + s.elements.find((e) => e.id === t)!.w, 1920);
});

Deno.test("Treffer: oberstes Element, gedreht", () => {
  let s = newScene();
  s = addElement(s, { ...newElement("rect", s), id: "a", x: 0, y: 0, w: 200, h: 200 });
  s = addElement(s, { ...newElement("rect", s), id: "b", x: 100, y: 100, w: 200, h: 200 });
  assertEquals(hitTest(s, 150, 150), "b");
  assertEquals(hitTest(s, 50, 50), "a");
  assertEquals(hitTest(s, 900, 900), null);
  s = updateElement(s, "a", { x: 500, y: 500, w: 400, h: 20, rotation: 90 }); // gedreht: hochkant um die Mitte (700,510)
  assertEquals(hitTest(s, 700, 650), "a");
  assertEquals(hitTest(s, 880, 510), null);
});

Deno.test("resizeBox: Griffe, Mindestgröße, Seitenverhältnis", () => {
  const b = { x: 100, y: 100, w: 200, h: 100 };
  assertEquals(resizeBox(b, "e", 50, 0), { x: 100, y: 100, w: 250, h: 100 });
  assertEquals(resizeBox(b, "nw", 20, 10), { x: 120, y: 110, w: 180, h: 90 });
  assertEquals(resizeBox(b, "w", 500, 0).w, 4);
  assertEquals(resizeBox(b, "se", 100, 0, true), { x: 100, y: 100, w: 300, h: 150 });
  assertEquals(resizeBox(b, "nw", -100, 0, true), { x: 0, y: 50, w: 300, h: 150 });
});

Deno.test("snapBox: Fläche und andere Elemente", () => {
  let s = newScene();
  s = addElement(s, { ...newElement("rect", s), id: "o", x: 500, y: 300, w: 100, h: 100 });
  const r = snapBox({ x: 6, y: 103, w: 100, h: 50 }, s, [], 8);
  assertEquals([r.box.x, r.guides.some((g) => g.axis === "x" && g.at === 0)], [0, true]);
  const r2 = snapBox({ x: 400, y: 500, w: 98, h: 50 }, s, ["zzz"], 8); // rechte Kante 498 → 500
  assertEquals(r2.box.x, 402);
  const none = snapBox({ x: 300, y: 700, w: 50, h: 50 }, s, [], 4);
  assertEquals(none.guides, []);
  const own = snapBox({ x: 502, y: 700, w: 50, h: 50 }, s, ["o"], 8); // eigene Kanten zählen nicht
  assertEquals(own.box.x, 502);
});

Deno.test("Platzhalter, Zonen, Bilder", () => {
  let s = newScene();
  s = addElement(s, { ...newElement("text", s), text: "{{a}} und {{b}}", color: "{{c}}" });
  s = addElement(s, { ...newElement("rect", s), fill: "{{c}}", stroke: "{{d}}" });
  s = addElement(s, { ...newElement("image", s), file: "logo.png" });
  s = addElement(s, newElement("zone", s));
  assertEquals(placeholders(s), ["a", "b", "c", "d"]);
  assertEquals(usedAssets(s), ["logo.png"]);
  assertEquals(zoneIds(s), ["window"]);
});

Deno.test("ensureParams ergänzt fehlende Felder, Farbe nach Verwendung", () => {
  let s = newScene();
  s = addElement(s, { ...newElement("text", s), text: "{{a}}", color: "{{c}}" });
  s = addElement(s, { ...newElement("rect", s), fill: "{{r}}" });
  const have = [{ key: "a", title: "A", kind: "text" as const, def: "x", choices: [], required: false, extra: {} }];
  const out = ensureParams(have, s);
  assertEquals(out.map((f) => [f.key, f.kind]), [["a", "text"], ["c", "color"], ["r", "color"]]);
  assertEquals(out[0], have[0]); // vorhandene unverändert
  assertEquals(ensureParams(out, s), out);
});

Deno.test("parseScene prüft und begrenzt", () => {
  const s = addElement(newScene(), newElement("text", newScene()));
  assertEquals(parseScene(JSON.stringify(s))!.elements.length, 1);
  assertEquals(parseScene("{"), null);
  assertEquals(parseScene(JSON.stringify({ format: "x", elements: [] })), null);
  const messy = parseScene(JSON.stringify({ format: SCENE_FORMAT, elements: [{ kind: "bogus" }, { kind: "rect", id: "a", w: -5, opacity: 9 }, { kind: "rect", id: "a" }] }))!;
  assertEquals(messy.elements.map((e) => e.id), ["a", "ax"]);
  assertEquals([messy.elements[0].w, messy.elements[0].opacity], [4, 1]);
});

Deno.test("Designer-Paket: Manifest gültig, main, Szene, Platzhalter ↔ Schema", () => {
  const files = newDesignerPackage("mein-titel", "Mein Titel", RUNTIME);
  assertEquals(isDesigner(files), true);
  assertEquals(Object.keys(files).sort(), ["mein-titel.js", "mein-titel.ograf.json", "scene.json"]);
  const m = parseManifest(files)!;
  assertEquals([m.id, m.main, m.supportsRealTime, m.supportsNonRealTime], ["mein-titel", "mein-titel.js", true, false]);
  const scene = parseScene(files["scene.json"])!;
  const keys = Object.keys((m.schema as { properties: object }).properties);
  for (const p of placeholders(scene)) assertEquals(keys.includes(p), true, `Platzhalter ${p} fehlt im Schema`);
  assertEquals(files["mein-titel.js"].includes("export default createSceneElement("), true);
  assertEquals(files["mein-titel.js"].includes(JSON.stringify(scene)), true);
});

Deno.test("applyScene setzt main im Manifest und ersetzt das Hauptmodul", () => {
  const base = newDesignerPackage("x", "X", RUNTIME);
  const m = JSON.parse(base["x.ograf.json"]);
  m.main = "alt.js";
  const files = applyScene({ ...base, "x.ograf.json": JSON.stringify(m), "alt.js": "alt" }, "x", newScene(), RUNTIME);
  assertEquals(parseManifest(files)!.main, "x.js");
  assertEquals(files["x.js"], generateMain(RUNTIME, newScene()));
  assertEquals(files["alt.js"], "alt"); // andere Dateien bleiben
});

Deno.test("History: undo/redo, Wiederholen-Zweig wird verworfen, Grenze", () => {
  const h = new History(1, 3);
  h.push(2);
  h.push(3);
  assertEquals([h.undo(), h.undo(), h.canUndo, h.canRedo], [2, 1, false, true]);
  assertEquals(h.redo(), 2);
  h.push(9);
  assertEquals([h.canRedo, h.value], [false, 9]);
  for (let i = 0; i < 10; i++) h.push(i);
  let n = 0;
  while (h.canUndo) { h.undo(); n++; }
  assertEquals(n, 3);
});
