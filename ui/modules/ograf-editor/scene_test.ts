import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import RUNTIME from "./runtime.js" with { type: "text" };
import { bindText, inStep, keyframesFor } from "./runtime.js";
import {
  addElement, alignGroup, alignToScene, angleFor, boundsOf, distribute, duplicateMany, elementsInRect, ensureParams, resizeRotated, setStepCount, setTiming, timelineEnd, applyScene, duplicateElement, generateMain, hitTest, History, isDesigner, moveElements, newDesignerPackage,
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
  assertEquals(files["mein-titel.js"].includes(JSON.stringify(JSON.parse(files["scene.json"]))), true); // eingebettete Szene = scene.json
  assertEquals(scene.stepCount, 1);
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

Deno.test("resizeRotated: gegenüberliegende Kante bleibt stehen (0°, 90°, 30°)", () => {
  const b = { x: 100, y: 100, w: 200, h: 100 };
  assertEquals(resizeRotated(b, 0, "e", 50, 0), { x: 100, y: 100, w: 250, h: 100 });
  // 90°: Elementsystem ist um 90° gedreht → Zeiger nach unten (dy=+50) vergrößert die Breite („e“)
  const r = resizeRotated(b, 90, "e", 0, 50);
  assertEquals(r.w, 250);
  // linke Kante im Elementsystem = obere Kante im Bild (bei 90°): ihre Weltposition bleibt
  const worldLeft = (box: { x: number; y: number; w: number; h: number }, a: number) => {
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2, rad = (a * Math.PI) / 180;
    return [cx - (box.w / 2) * Math.cos(rad), cy - (box.w / 2) * Math.sin(rad)];
  };
  const [bx, by] = worldLeft(b, 90), [rx, ry] = worldLeft(r, 90);
  assertEquals([Math.round(rx), Math.round(ry)], [Math.round(bx), Math.round(by)]);
  const r30 = resizeRotated(b, 30, "w", -20, 0);
  const [b30x, b30y] = [b.x + b.w / 2 + (b.w / 2) * Math.cos(Math.PI / 6), b.y + b.h / 2 + (b.w / 2) * Math.sin(Math.PI / 6)]; // rechte Kante (bleibt)
  const [r30x, r30y] = [r30.x + r30.w / 2 + (r30.w / 2) * Math.cos(Math.PI / 6), r30.y + r30.h / 2 + (r30.w / 2) * Math.sin(Math.PI / 6)];
  assertEquals([Math.abs(r30x - b30x) < 1.5, Math.abs(r30y - b30y) < 1.5], [true, true]);
});

Deno.test("angleFor: 0° oben, rechts 90°, Einrasten", () => {
  const b = { x: 0, y: 0, w: 100, h: 100 };
  assertEquals(angleFor(b, 50, -100), 0);
  assertEquals(angleFor(b, 200, 50), 90);
  assertEquals(Math.abs(angleFor(b, 50, 300)), 180);
  assertEquals(angleFor(b, 120, -20, true) % 15, 0);
});

Deno.test("Gruppe: Rechteck, Aufziehen, Ausrichten, Verteilen, Duplizieren", () => {
  let s = newScene();
  const mk = (id: string, x: number, y: number, w: number, h: number) => addElement(s, { ...newElement("rect", s), id, x, y, w, h });
  s = mk("a", 0, 0, 100, 100);
  s = mk("b", 300, 50, 50, 50);
  s = mk("c", 900, 10, 100, 200);
  assertEquals(boundsOf(s, ["a", "c"]), { x: 0, y: 0, w: 1000, h: 210 });
  assertEquals(boundsOf(s, []), null);
  assertEquals(elementsInRect(s, { x: 250, y: 40, w: 100, h: 20 }), ["b"]);
  assertEquals(elementsInRect(s, { x: 2000, y: 0, w: 5, h: 5 }), []);
  const al = alignGroup(s, ["a", "b", "c"], "right");
  assertEquals(al.elements.map((e) => e.x + e.w), [1000, 1000, 1000]);
  const vc = alignGroup(s, ["a", "c"], "vcenter");
  assertEquals(vc.elements.map((e) => Math.round(e.y + e.h / 2)), [105, 75, 105]); // b gehört nicht zur Auswahl
  assertEquals(alignGroup(s, ["a"], "left"), s); // ein Element: keine Gruppe
  const d = distribute(s, ["a", "b", "c"], "x");
  assertEquals(d.elements.map((e) => e.x), [0, 475, 900]); // Lücke (1000−250)/2 = 375
  const dup = duplicateMany(s, ["a", "b"]);
  assertEquals([dup.scene.elements.length, dup.ids.length], [5, 2]);
});

Deno.test("parseScene behält gültige Schriften, verwirft unsichere", () => {
  const sc = parseScene(JSON.stringify({ format: SCENE_FORMAT, elements: [], fonts: [{ family: "Meine Schrift", file: "a.woff2" }, { family: 'x";}', file: "b.woff2" }, { family: "ok", file: "../c.woff" }] }))!;
  assertEquals(sc.fonts, [{ family: "Meine Schrift", file: "a.woff2" }]);
});

Deno.test("Schritte: inStep, setStepCount passt Bereiche an, Manifest bekommt stepCount", () => {
  assertEquals([inStep({}, 0), inStep({}, 5), inStep({ from: 1 }, 0), inStep({ from: 1 }, 2), inStep({ from: 0, to: 1 }, 1), inStep({ from: 0, to: 1 }, 2)], [true, true, false, true, true, false]);
  let s = newScene();
  s = addElement(s, { ...newElement("text", s), id: "a", from: 3, to: 4 });
  s = addElement(s, { ...newElement("text", s), id: "b" });
  const s2 = setStepCount(s, 2);
  assertEquals([s2.stepCount, s2.elements[0].from, s2.elements[0].to, s2.elements[1].to], [2, 1, -1, -1]);
  assertEquals(setStepCount(s, 99).stepCount, 20);
  assertEquals(setStepCount(s, 0).stepCount, 1);
  const files = applyScene({ "x.ograf.json": JSON.stringify({ id: "x", main: "x.js", stepCount: 1 }) }, "x", s2, RUNTIME);
  assertEquals(parseManifest(files)!.stepCount, 2);
  assertEquals(parseScene(files["scene.json"])!.stepCount, 2);
});

Deno.test("Zeitleiste: setTiming rundet auf 50 ms, timelineEnd als Maßstab", () => {
  let s = newScene();
  s = addElement(s, { ...newElement("text", s), id: "a", anim: { in: { type: "fade", ms: 300, delay: 100, ease: "ease-out" } } });
  s = setTiming(s, "a", "in", { delay: 123, ms: 780 });
  assertEquals([s.elements[0].anim!.in!.delay, s.elements[0].anim!.in!.ms], [100, 800]);
  s = setTiming(s, "a", "in", { delay: -50, ms: 10 });
  assertEquals([s.elements[0].anim!.in!.delay, s.elements[0].anim!.in!.ms], [0, 50]);
  s = setTiming(s, "a", "out", { ms: 400 }); // war nicht gesetzt: Standardart Überblenden
  assertEquals(s.elements[0].anim!.out!.type, "fade");
  assertEquals(timelineEnd(s, "in"), 1000);
  s = setTiming(s, "a", "in", { delay: 1500, ms: 700 });
  assertEquals(timelineEnd(s, "in"), 2250);
  assertEquals(setTiming(s, "zzz", "in", { ms: 100 }), s);
});
