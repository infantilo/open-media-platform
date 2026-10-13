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
