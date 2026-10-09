// Tests der reinen Logik des X/Y-Panels (nodes/omp-xy-panel/ui/logic.js).
import { assert, assertEquals } from "jsr:@std/assert@1";
import "../nodes/omp-xy-panel/ui/logic.js";

// deno-lint-ignore no-explicit-any
const L = (globalThis as any).OmpXyLogic;

const nodes = [
  { id: "cam", label: "Kamera" },
  { id: "mix", label: "Mischer" },
  { id: "com", label: "Kommentatorplatz" },
  { id: "lone", label: "Einzelgänger" },
  { id: "panel", label: "X/Y-Panel" },
];
const groupTree = {
  groups: {
    g1: { id: "g1", label: "Studio", parentId: null, nodeIds: ["cam"], groupIds: ["g2"] },
    g2: { id: "g2", label: "Regie", parentId: "g1", nodeIds: ["mix"], groupIds: [] },
  },
};
const workflows = [{ id: "w1", name: "Morgenmagazin", runtime: { komm: { nodeId: "com" }, x: {} } }];

const src = (id: string, nodeId: string, label: string, mediaType: string, tags: string[] = [], online = true) => ({
  senderId: id, nodeId, nodeLabel: nodes.find((n) => n.id === nodeId)!.label, label, mediaType, online,
  tags: tags.map((tag) => ({ tag, origin: "EXPLICIT" })),
});
const snk = (id: string, nodeId: string, label: string, mediaType: string, tags: string[] = []) => ({
  receiverId: id, nodeId, nodeLabel: nodes.find((n) => n.id === nodeId)!.label, label, mediaType, online: true,
  tags: tags.map((tag) => ({ tag, origin: "EXPLICIT" })),
});

const sources = L.normSources([
  src("s-cam-v", "cam", "Video", "video", ["media.video"]),
  src("s-cam-a", "cam", "Ton", "audio", ["media.audio"]),
  src("s-mix-pgm", "mix", "PGM", "video"),
  src("s-lone", "lone", "Test", "video"),
]);

Deno.test("Home zeigt Workflows, Gruppen und Nicht zugewiesen — leere Ordner nicht", () => {
  const model = L.buildModel({ nodes, groupTree, workflows });
  const by = L.groupPointsByNode(sources);
  const home = L.levelContents(model, [], by);
  // Workflow „Morgenmagazin“ (Node com) hat keine Quellen → ausgeblendet
  assertEquals(home.folders.map((f: { id: string }) => f.id), ["grp:g1", "unassigned"]);
  assertEquals(home.folders[0].count, 3); // cam (2) + mix (1) in verschachtelter Gruppe
  assertEquals(home.folders[1].count, 1); // lone
});

Deno.test("Gruppe zeigt Untergruppen und Punkte der eigenen Nodes", () => {
  const model = L.buildModel({ nodes, groupTree, workflows });
  const lvl = L.levelContents(model, ["grp:g1"], L.groupPointsByNode(sources));
  assertEquals(lvl.folders.map((f: { id: string }) => f.id), ["grp:g2"]);
  assertEquals(lvl.nodes.map((n: { id: string }) => n.id), ["cam"]);
  assertEquals(lvl.nodes[0].points.length, 2);
  assertEquals(lvl.crumbs.map((c: { label: string }) => c.label), ["Studio"]);
  const sub = L.levelContents(model, ["grp:g1", "grp:g2"], L.groupPointsByNode(sources));
  assertEquals(sub.nodes.map((n: { id: string }) => n.id), ["mix"]);
});

Deno.test("Workflow übernimmt Untergruppen der verknüpften Gruppe, Gruppe erscheint nicht doppelt", () => {
  const tree = { groups: { ...groupTree.groups, g1: { ...groupTree.groups.g1, workflowId: "w1" } } };
  const model = L.buildModel({ nodes, groupTree: tree, workflows });
  assertEquals(model.rootIds, ["wf:w1", "unassigned"]);
  const lvl = L.levelContents(model, ["wf:w1"], L.groupPointsByNode(sources));
  assertEquals(lvl.folders.map((f: { id: string }) => f.id), ["grp:g2"]);
  assertEquals(lvl.nodes.map((n: { id: string }) => n.id), ["cam"]);
});

Deno.test("Nodes in Workflow oder Gruppe zählen nicht als nicht zugewiesen; unbekannte Node-IDs werden ignoriert", () => {
  const tree = { groups: { g1: { id: "g1", label: "G", parentId: null, nodeIds: ["cam", "gone"], groupIds: [] } } };
  const model = L.buildModel({ nodes, groupTree: tree, workflows });
  assertEquals(model.folders.get("unassigned").nodeIds.sort(), ["lone", "mix", "panel"]);
  assertEquals(model.folders.get("grp:g1").nodeIds, ["cam"]);
});

Deno.test("Filter nach Medientyp und Suchtext (Label, Node, Tag)", () => {
  assertEquals(L.filterPoints(sources, { media: "audio", query: "" }).length, 1);
  assertEquals(L.filterPoints(sources, { media: "", query: "kamera" }).length, 2);
  assertEquals(L.filterPoints(sources, { media: "", query: "media.audio" }).length, 1);
});

Deno.test("Kompatibilität: gleicher Medientyp, unbekannt gilt als kompatibel", () => {
  assert(L.compatible({ mediaType: "video" }, { mediaType: "video" }));
  assert(!L.compatible({ mediaType: "video" }, { mediaType: "audio" }));
  assert(L.compatible({ mediaType: "" }, { mediaType: "audio" }));
});

Deno.test("routeMap: Receiver → Sender", () => {
  assertEquals(L.routeMap([{ fromSender: "a", toReceiver: "r" }]).get("r"), "a");
});

const nodeSrc = L.normSources([
  src("c", "cam", "Kommentar", "audio", ["role.commentator", "media.audio"]),
  src("p", "cam", "Programm", "audio", ["role.program", "media.audio"]),
  src("v", "cam", "Bild", "video", ["media.video"]),
]);
const nodeSnk = L.normSinks([
  snk("r-p", "com", "Zuspiel", "audio", ["role.program"]),
  snk("r-c", "com", "Mikro-Rückweg", "audio", ["role.commentator"]),
  snk("r-v", "com", "Monitor", "video"),
]);

Deno.test("Tag-Paarung verbindet Kommentator mit Kommentator, Programm mit Programm", () => {
  const plan = L.planTagRoutes(nodeSrc, nodeSnk);
  const pairs = plan.routes.map((r: { from: { id: string }; to: { id: string } }) => `${r.from.id}>${r.to.id}`).sort();
  assertEquals(pairs, ["c>r-c", "p>r-p"]);
  assertEquals(plan.unmatched.map((u: { id: string }) => u.id), ["r-v"]); // media.* zählt nicht als Übereinstimmung
});

Deno.test("Rest nach Reihenfolge nur mit Option, nur gleicher Medientyp", () => {
  const plan = L.planTagRoutes(nodeSrc, nodeSnk, { fallbackOrder: true });
  const last = plan.routes.find((r: { reason: string }) => r.reason === "order");
  assertEquals([last.from.id, last.to.id], ["v", "r-v"]);
  assertEquals(plan.unmatched, []);
});

Deno.test("Offline-Quellen werden nie gepaart", () => {
  const off = L.normSources([src("c", "cam", "Kommentar", "audio", ["role.commentator"], false)]);
  const plan = L.planTagRoutes(off, nodeSnk);
  assertEquals(plan.routes.length, 0);
});

Deno.test("Bouquet 'routes' löst Referenzen über Node+Portname auf, auch nach neuen IDs", () => {
  const b = L.routesBouquet("Show", [{ from: nodeSrc[0], to: nodeSnk[1] }]);
  // Neustart: neue IDs, gleiche Namen
  const reSrc = L.normSources([src("NEU", "cam", "Kommentar", "audio")]);
  const reSnk = L.normSinks([snk("NEU-R", "com", "Mikro-Rückweg", "audio")]);
  const res = L.resolveBouquet(b, reSrc, reSnk);
  assertEquals(res.missing, []);
  assertEquals([res.routes[0].from.id, res.routes[0].to.id], ["NEU", "NEU-R"]);
});

Deno.test("Bouquet meldet fehlende Punkte statt still zu überspringen", () => {
  const b = L.routesBouquet("Show", [{ from: nodeSrc[0], to: nodeSnk[1] }]);
  const res = L.resolveBouquet(b, [], nodeSnk);
  assertEquals(res.routes.length, 0);
  assertEquals(res.missing, ["Kamera · Kommentar"]);
});

Deno.test("Bouquet 'tags' wertet erst beim Schalten aus", () => {
  const b = L.tagsBouquet("Kommentator", { id: "cam", label: "Kamera" }, { id: "com", label: "Kommentatorplatz" }, false);
  const res = L.resolveBouquet(b, nodeSrc, nodeSnk);
  assertEquals(res.routes.length, 2);
  assertEquals(res.missing, ["Kommentatorplatz · Monitor"]);
});

Deno.test("parseBouquets verwirft Unbrauchbares", () => {
  assertEquals(L.parseBouquets(null), []);
  assertEquals(L.parseBouquets({ bouquets: [{ id: "x", name: "n", kind: "routes" }, { id: 1 }, null, { id: "y", name: "m", kind: "?" }] }).length, 1);
});

Deno.test("Instanz-Kurz-ID wird in der Anzeige weggelassen, gleichnamige Nodes behalten sie", () => {
  assertEquals(L.stripInstanceId("Source (3f2a1b9c) Sender 1"), "Source Sender 1");
  assertEquals(L.stripInstanceId("Mischer (Regie)"), "Mischer (Regie)");
  const pt = (nodeId: string, nodeLabel: string, label: string) => ({ nodeId, nodeLabel, label });
  const a = pt("a", "Source (3f2a1b9c)", "Source (3f2a1b9c) Sender 1");
  const b = pt("b", "Player (0a1b2c3d)", "Player (0a1b2c3d) Sender 1");
  const c = pt("c", "Player (99887766)", "Player (99887766) Sender 1");
  const names = L.nodeNames([a, b, c]);
  assertEquals(names.get("a"), "Source");
  assertEquals(names.get("b"), "Player (0a1b2c3d)");
  assertEquals(L.shortLabel(a, names.get("a")), "Sender 1");
  assertEquals(L.fullName(a, names.get("a")), "Source Sender 1");
  assertEquals(L.fullName(pt("x", "Kamera", "CAM 1"), "Kamera"), "Kamera · CAM 1");
});

// ---- Bündel-Bouquets (Video von X, Audio von Y …) ----------------------------
const bq = (id: string, nodeId: string, label: string, mediaType: string, tags: string[] = [], online = true) =>
  L.normSources([src(id, nodeId, label, mediaType, tags, online)])[0];
const bs = (id: string, nodeId: string, label: string, mediaType: string, tags: string[] = []) =>
  L.normSinks([snk(id, nodeId, label, mediaType, tags)])[0];

const bundleSrc = [
  bq("v1", "cam", "Bild", "video"),
  bq("a1", "mix", "Ton L", "audio", ["lang.de"]),
  bq("a2", "mix", "Ton R", "audio", ["lang.en"]),
  bq("d1", "lone", "Daten", "data"),
];
const monitor = [
  bs("mv", "com", "Video", "video"),
  bs("ma1", "com", "Audio 1", "audio", ["lang.en"]),
  bs("ma2", "com", "Audio 2", "audio", ["lang.de"]),
  bs("md", "com", "Daten", "data"),
];

Deno.test("Bündel 1:1: Video→Video, n-tes Audio→n-tes Audio, Daten→Daten", () => {
  const b = L.bundleBouquet("Paket", bundleSrc, "order");
  const res = L.planBundle(b, bundleSrc, monitor);
  assertEquals(res.missing, []);
  assertEquals(res.routes.map((r: any) => [r.from.id, r.to.id]), [["v1", "mv"], ["a1", "ma1"], ["a2", "ma2"], ["d1", "md"]]);
});

Deno.test("Bündel per Tag: Audio mit Tag X → Audio-Empfänger mit Tag X, unabhängig von der Reihenfolge", () => {
  const b = L.bundleBouquet("Paket", bundleSrc, "tags");
  const res = L.planBundle(b, bundleSrc, monitor);
  const m = Object.fromEntries(res.routes.map((r: any) => [r.from.id, r.to.id]));
  assertEquals(m.a1, "ma2");
  assertEquals(m.a2, "ma1");
  // Video/Daten ohne gemeinsamen Tag bleiben ohne Partner und werden gemeldet.
  assertEquals(res.missing, ["Kamera · Bild", "Einzelgänger · Daten"]);
});

Deno.test("Bündel: fehlende Quelle behält ihren Platz, Audio 2 rutscht nicht auf Audio 1", () => {
  const b = L.bundleBouquet("Paket", bundleSrc, "order");
  const without = bundleSrc.filter((p: any) => p.id !== "a1");
  const res = L.planBundle(b, without, monitor);
  assertEquals(res.routes.map((r: any) => [r.from.id, r.to.id]), [["v1", "mv"], ["a2", "ma2"], ["d1", "md"]]);
  assertEquals(res.missing, ["Mischer · Ton L"]);
});

Deno.test("Bündel: Ziel mit zu wenigen Eingängen und Offline-Quellen werden gemeldet, nicht still übersprungen", () => {
  const b = L.bundleBouquet("Paket", bundleSrc, "order");
  const few = monitor.filter((p: any) => p.id !== "ma2");
  assertEquals(L.planBundle(b, bundleSrc, few).missing, ["Mischer · Ton R"]);
  const off = bundleSrc.map((p: any) => (p.id === "v1" ? { ...p, online: false } : p));
  assertEquals(L.planBundle(b, off, monitor).missing, ["Kamera · Bild (offline)"]);
});

Deno.test("Bündel überlebt neue IDs und wird von parseBouquets akzeptiert", () => {
  const b = L.bundleBouquet("Paket", bundleSrc, "order");
  const reborn = bundleSrc.map((p: any) => ({ ...p, id: p.id + "-neu" }));
  assertEquals(L.planBundle(b, reborn, monitor).routes.length, 4);
  assertEquals(L.parseBouquets({ bouquets: [b, { ...b, id: "x", items: null }] }).length, 1);
});

Deno.test("Gleichnamige Nodes: Punktname behält die Kurz-ID, sonst nicht unterscheidbar", () => {
  const pt = (nodeId: string, nodeLabel: string, label: string) => ({ nodeId, nodeLabel, label });
  const b = pt("b", "Source (0a1b2c3d)", "Source (0a1b2c3d) Sender 1");
  const c = pt("c", "Source (99887766)", "Source (99887766) Sender 1");
  const names = L.nodeNames([b, c]);
  assertEquals(L.fullName(b, names.get("b")), "Source (0a1b2c3d) Sender 1");
  assertEquals(L.fullName(c, names.get("c")), "Source (99887766) Sender 1");
});
