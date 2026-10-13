import { assertEquals } from "jsr:@std/assert";
import { layoutXy, pointName, stepSelection, type Point, type XyState } from "./xy-panel-logic.ts";
import { type XyIO, xyPanelAdapter } from "./xy-panel.ts";

const pt = (id: string, label: string, media = "video", node = "omp-source"): Point => ({ id, label, nodeLabel: node, mediaType: media, online: true });
const state = (over: Partial<XyState> = {}): XyState => ({
  sources: [pt("s1", "omp-source Sender 1"), pt("s2", "Cam", "video", "omp-cam"), pt("s3", "Ton", "audio", "omp-mic")],
  sinks: [pt("r1", "Viewer Receiver", "video", "omp-viewer"), pt("r2", "Mon", "audio", "omp-mon")],
  routes: {}, selSrc: null, selDst: null, media: "", auto: true, srcOff: 0, dstOff: 0, ...over,
});

Deno.test("Punktname: Node-Präfix und Instanz-ID entfallen", () => {
  assertEquals(pointName(pt("x", "omp-source (3f2a1b9c) Sender 1", "video", "omp-source (3f2a1b9c)")), "Sender 1");
  assertEquals(pointName(pt("x", "Cam")), "Cam");
});

Deno.test("XL 9×4: Quellen links, Steuerspalte Mitte, Ziele rechts; Kategorien-Zeile; Farben, Kompatibilität", () => {
  const l = layoutXy(state({ selSrc: "s1", routes: { r1: "s1", r2: "s3" } }), 9, 4, 0, 0);
  assertEquals(l.keys[0].slice(0, 4).map((k) => k?.label), ["Alle", "source", "cam", "mic"]);
  assertEquals(l.keys[0][0]?.state, "preset"); // „Alle“ gewählt
  assertEquals(l.keys[1].slice(0, 4).map((k) => k?.label), ["source", "cam", "mic", undefined]);
  assertEquals(l.keys[1][0]?.state, "preset");
  assertEquals(l.keys[0].slice(5).map((k) => k?.label), ["Alle", "viewer", "mon", undefined]);
  assertEquals(l.keys[1][5]?.state, "onair"); // r1 hängt an der gewählten Quelle
  assertEquals(l.keys[1][5]?.sub, "source");
  assertEquals(l.keys[1][6]?.dim, true); // Audio-Ziel passt nicht zu Video-Quelle
  assertEquals(l.keys[1][6]?.sub, "mic");
  assertEquals([0, 1, 2, 3].map((r) => l.keys[r][4]?.label), ["TAKE", "Trennen", "AUTO", "Medium"]);
  assertEquals(l.act[1][1], { t: "src", id: "s2" });
  assertEquals(l.act[1][5], { t: "dst", id: "r1" });
  assertEquals(l.pages, 1);
});

Deno.test("Kategorie filtert Quellen; Medienfilter und Versatz (4×1 Seiten-Layout)", () => {
  const l = layoutXy(state({ srcCat: "cam" }), 9, 4, 0, 0);
  assertEquals(l.keys[1][0]?.label, "cam");
  assertEquals(l.keys[1][1], null);
  assertEquals(l.keys[0][1]?.state, "off");
  assertEquals(l.keys[0][2]?.state, "preset");
  const m = layoutXy(state({ media: "audio" }), 4, 1, 0, 0);
  assertEquals(m.keys[0][0]?.label, "Ton");
  assertEquals(m.keys[0][1], null);
  assertEquals(layoutXy(state({ srcOff: 1 }), 4, 1, 0, 0).keys[0][0]?.label, "Cam");
});

Deno.test("„+“ (1×4): Seiten Quellen / Ziele / Steuerung, Dial-Anzeigen", () => {
  const s = state({ selSrc: "s2" });
  const p = (n: number) => layoutXy(s, 4, 1, 4, n);
  assertEquals(p(0).keys[0].map((k) => k?.label ?? null), ["Sender 1", "Cam", "Ton", null]); // Zelle 4 reserviert
  assertEquals(p(1).keys[0][0]?.label, "Viewer Receiver");
  assertEquals(p(2).keys[0][0]?.label, "TAKE");
  assertEquals(p(0).dials!.map((d) => `${d?.label}=${d?.value}`), ["Quelle=Cam", "Ziel=–", "Medium=Alle", "AUTO=an"]);
});

Deno.test("Dial-Auswahl: nächster/vorheriger, an den Enden begrenzt", () => {
  const pts = [pt("a", "A"), pt("b", "B"), pt("c", "C")];
  assertEquals(stepSelection(pts, null, 1), "a");
  assertEquals(stepSelection(pts, null, -1), "c");
  assertEquals(stepSelection(pts, "b", 1), "c");
  assertEquals(stepSelection(pts, "c", 5), "c");
  assertEquals(stepSelection(pts, "a", -1), "a");
  assertEquals(stepSelection([], "a", 1), null);
});

function rig() {
  const calls: string[] = [];
  const io: XyIO = {
    load: () => Promise.resolve({ sources: state().sources, sinks: state().sinks, routes: {} }),
    connect: (f, t) => (calls.push(`POST ${f}->${t}`), Promise.resolve()),
    disconnect: (t) => (calls.push(`DELETE ${t}`), Promise.resolve()),
  };
  const a = xyPanelAdapter(io);
  const ctx = { cols: 9, rows: 4, dials: 0, page: 0 };
  const tick = () => new Promise((r) => setTimeout(r, 10));
  return { a, calls, ctx, tick };
}

Deno.test("Adapter: Quelle + Ziel → Kante (AUTO), Ziel wird freigegeben; inkompatibel nicht", async () => {
  const { a, calls, ctx, tick } = rig();
  await a.refresh!();
  a.getLayout(ctx);
  a.onKey(1, 1, true); await tick(); // Quelle s2 (Video)
  a.getLayout(ctx);
  a.onKey(1, 6, true); await tick(); // Ziel r2 (Audio) → inkompatibel
  assertEquals(calls, []);
  a.getLayout(ctx);
  a.onKey(1, 5, true); await tick(); // Ziel r1 (Video) → schalten
  assertEquals(calls, ["POST s2->r1"]);
});

Deno.test("Adapter: AUTO aus → erst TAKE schaltet; Trennen löscht die Kante des gewählten Ziels", async () => {
  const { a, calls, ctx, tick } = rig();
  await a.refresh!();
  const L = () => a.getLayout(ctx);
  L(); a.onKey(2, 4, true); await tick(); // AUTO aus
  L(); a.onKey(1, 0, true); await tick(); // Quelle s1
  L(); a.onKey(1, 5, true); await tick(); // Ziel r1
  assertEquals(calls, []);
  L(); a.onKey(0, 4, true); await tick(); // TAKE
  assertEquals(calls, ["POST s1->r1"]);
  L(); a.onKey(1, 5, true); await tick(); // Ziel neu wählen
  L(); a.onKey(1, 4, true); await tick(); // Trennen
  assertEquals(calls, ["POST s1->r1", "DELETE r1"]);
});

Deno.test("Adapter „+“: Dial wählt Quelle/Ziel, Dial-Druck auf Ziel = TAKE", async () => {
  const { a, calls, tick } = rig();
  await a.refresh!();
  const ctx = { cols: 4, rows: 1, dials: 4, page: 0 };
  a.getLayout(ctx);
  a.onDial!(0, 1); a.onDial!(1, 1); // erste Quelle, erstes Ziel
  a.onDialPress!(1, true); await tick();
  assertEquals(calls, ["POST s1->r1"]);
});

Deno.test("Adapter: Ziel, das schon an der gewählten Quelle hängt, wird nur gewählt (zum Trennen)", async () => {
  const calls: string[] = [];
  const io: XyIO = {
    load: () => Promise.resolve({ sources: state().sources, sinks: state().sinks, routes: { r1: "s1" } }),
    connect: (f, t) => (calls.push(`POST ${f}->${t}`), Promise.resolve()),
    disconnect: (t) => (calls.push(`DELETE ${t}`), Promise.resolve()),
  };
  const a = xyPanelAdapter(io);
  await a.refresh!();
  const ctx = { cols: 9, rows: 4, dials: 0, page: 0 };
  const tick = () => new Promise((r) => setTimeout(r, 10));
  a.getLayout(ctx); a.onKey(1, 0, true); await tick(); // Quelle s1
  a.getLayout(ctx); a.onKey(1, 5, true); await tick(); // r1 hängt schon an s1 → nur gewählt
  assertEquals(calls, []);
  a.getLayout(ctx); a.onKey(1, 4, true); await tick(); // Trennen
  assertEquals(calls, ["DELETE r1"]);
});

Deno.test("Adapter: Kategorie-Taste filtert Quellen, „mehr“ blättert", async () => {
  const { a, ctx, tick } = rig();
  await a.refresh!();
  a.getLayout(ctx); a.onKey(0, 2, true); await tick(); // Kategorie „cam“
  const l = a.getLayout(ctx);
  assertEquals(l.keys[1][0]?.label, "cam");
  assertEquals(l.keys[1][1], null);
  const small = layoutXy(state({ sources: Array.from({ length: 12 }, (_, i) => pt(`n${i}`, `P${i}`)) }), 5, 3, 0, 0);
  assertEquals(small.keys[2][1]?.label, "mehr ▶"); // letzte Punktzelle der linken Seite
});

// ---- Ebenen und Bouquets (Kap. 40.7 Folge) ------------------------------------

import "../../../../nodes/omp-xy-panel/ui/logic.js";
// deno-lint-ignore no-explicit-any
const OL = (globalThis as any).OmpXyLogic;

const np = (id: string, label: string, nodeId: string, nodeLabel: string, media = "video"): Point => ({ id, label, nodeLabel, nodeId, mediaType: media, online: true, tags: [] });
const lvlNodes = [
  { id: "cam", label: "Kamera" },
  { id: "mix", label: "Mischer" },
  { id: "mon", label: "Monitor" },
  { id: "lone", label: "Einzel" },
];
const lvlTree = {
  groups: {
    g1: { id: "g1", label: "Studio", parentId: null, nodeIds: ["cam"], groupIds: ["g2"] },
    g2: { id: "g2", label: "Regie", parentId: "g1", nodeIds: ["mix"], groupIds: [] },
  },
};
const lvlState = (over: Partial<XyState> = {}): XyState => ({
  sources: [np("s1", "Cam 1", "cam", "Kamera"), np("s2", "Mix PGM", "mix", "Mischer"), np("s3", "Einzel", "lone", "Einzel")],
  sinks: [np("r1", "Monitor", "mon", "Monitor"), np("r2", "Mix In", "mix", "Mischer")],
  routes: {}, selSrc: null, selDst: null, media: "", auto: true, srcOff: 0, dstOff: 0,
  srcPath: [], dstPath: [], model: OL.buildModel({ nodes: lvlNodes, groupTree: lvlTree, workflows: [] }), ...over,
});

Deno.test("Ebenen: Home zeigt Alle + Ordner; Ordner begrenzt die Punkte rekursiv", () => {
  const home = layoutXy(lvlState(), 9, 4, 0, 0);
  assertEquals(home.keys[0].slice(0, 3).map((k) => k?.label), ["Alle", "Studio", "Nicht zugewiesen"]);
  assertEquals(home.act[0][1], { t: "folder", side: "src", id: "grp:g1" });
  assertEquals(home.keys[1].slice(0, 4).map((k) => k?.label), ["Kamera", "Mischer", "Einzel", undefined]); // Home = alle (Tastentext = Node-Name bei einem Punkt)
  const inG1 = layoutXy(lvlState({ srcPath: ["grp:g1"] }), 9, 4, 0, 0);
  assertEquals(inG1.keys[0].slice(0, 4).map((k) => k?.label), ["↑ Hoch", "Studio", "Regie", "Kamera"]);
  assertEquals(inG1.keys[0][1]?.state, "preset"); // ganzer Ordner
  assertEquals(inG1.keys[1].slice(0, 3).map((k) => k?.label), ["Kamera", "Mischer", undefined]); // inkl. Untergruppe Regie
  const inG2 = layoutXy(lvlState({ srcPath: ["grp:g1", "grp:g2"] }), 9, 4, 0, 0);
  assertEquals(inG2.keys[1].slice(0, 2).map((k) => k?.label), ["Mischer", undefined]);
  assertEquals(inG2.act[0][0], { t: "up", side: "src" });
});

Deno.test("Ebenen: ohne Ordner (nur ‚Nicht zugewiesen‘) bleibt die Node-Kategorie-Zeile", () => {
  const s = lvlState({ model: OL.buildModel({ nodes: lvlNodes, groupTree: { groups: {} }, workflows: [] }) });
  const l = layoutXy(s, 9, 4, 0, 0);
  assertEquals(l.keys[0].slice(0, 4).map((k) => k?.label), ["Alle", "Kamera", "Mischer", "Einzel"]);
});

const bq = (id: string, name: string, kind = "routes", extra = {}) => ({ id, name, kind, routes: [], ...extra });

Deno.test("Bouquets: eigene Seiten hinter dem Kreuzschienen-Seite, Seitentaste bleibt frei, Rückgängig oben links", () => {
  const s = lvlState({ bouquets: [bq("b1", "Morgen"), bq("b2", "Abend", "tags")], undoSecs: 42 });
  const p0 = layoutXy(s, 9, 4, 0, 0);
  assertEquals(p0.pages, 2);
  assertEquals(p0.keys[3][8], null); // unten rechts frei für „Seite weiter“
  const p1 = layoutXy(s, 9, 4, 0, 1);
  assertEquals(p1.keys[0][0]?.label, "↶ Zurück");
  assertEquals(p1.keys[0][0]?.sub, "42 s");
  assertEquals(p1.keys[0][1]?.label, "Morgen");
  assertEquals(p1.keys[0][2]?.sub, "per Tags");
  assertEquals(p1.act[0][1], { t: "bq", id: "b1" });
  assertEquals(p1.keys[3][8], null);
  // keine Bouquets → eine Seite wie bisher
  assertEquals(layoutXy(lvlState(), 9, 4, 0, 0).pages, 1);
});

Deno.test("Bouquets: kleine Decks hängen die Bouquet-Seiten an die Seiten der Kreuzschiene an", () => {
  const s = lvlState({ bouquets: [bq("b1", "Morgen")] });
  const l0 = layoutXy(s, 4, 1, 0, 0);
  const total = l0.pages ?? 1;
  const last = layoutXy(s, 4, 1, 0, total - 1);
  assertEquals(last.keys[0][0]?.label, "↶ Zurück");
  assertEquals(last.keys[0][1]?.label, "Morgen");
});

Deno.test("Adapter: Bouquet schaltet, Rückgängig stellt zurück; Bündel braucht ein Ziel", async () => {
  const calls: string[] = [];
  const src = [np("s1", "Cam 1", "cam", "Kamera"), np("s2", "Cam 2", "cam", "Kamera")];
  const snk = [np("r1", "Monitor", "mon", "Monitor"), np("r2", "Mix In", "mix", "Mischer")];
  const routes: Record<string, string> = { r1: "s2" };
  const b1 = OL.routesBouquet("Test", [{ from: src[0], to: snk[0] }, { from: src[0], to: snk[1] }]);
  const bundle = OL.bundleBouquet("Bündel", [src[0]], "order");
  const io: XyIO = {
    load: () => Promise.resolve({ sources: src, sinks: snk, routes: { ...routes }, nodes: lvlNodes, groupTree: { groups: {} }, workflows: [], bouquets: [b1, bundle] }),
    connect: (f, t) => { calls.push(`+${f}>${t}`); routes[t] = f; return Promise.resolve(); },
    disconnect: (t) => { calls.push(`-${t}`); delete routes[t]; return Promise.resolve(); },
  };
  const errs: unknown[] = [];
  const a = xyPanelAdapter(io);
  a.onError = (e) => errs.push(e);
  await a.refresh?.();
  a.getLayout({ cols: 9, rows: 3, dials: 0, page: 1 }); // rows ohne Kopfzeile
  const k = (page: number) => a.getLayout({ cols: 9, rows: 3, dials: 0, page });
  k(1);
  a.onKey(0, 1, true); // Bouquet „Test“
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(calls, ["+s1>r1", "+s1>r2"]);
  const after = k(1);
  assertEquals(after.keys[0][1]?.state, "onair");
  a.onKey(0, 0, true); // Rückgängig
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(calls.slice(2), ["+s2>r1", "-r2"]);
  // Bündel ohne Ziel: Fehlermeldung, nichts geschaltet
  a.onKey(0, 2, true);
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(calls.length, 4);
  assertEquals(String((errs[0] as Error).message).includes("Ziel wählen"), true);
  a.dispose?.();
});
