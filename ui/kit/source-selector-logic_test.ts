import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  applyAccess,
  buildSourceTree,
  filterTree,
  findLeaf,
  parseGroupHint,
  pathToSource,
  type SourceEntry,
  type SourceGroupNode,
  type SourceTreeNode,
  visibleRows,
} from "./source-selector-logic.ts";

const e = (id: string, extra: Partial<SourceEntry> = {}): SourceEntry => ({ id, label: id, ...extra });
const sec = (tree: SourceGroupNode[], id: string) => tree.find((s) => s.id === id);
const leafIds = (nodes: SourceTreeNode[]): string[] =>
  nodes.flatMap((n) => (n.type === "source" ? [n.id] : leafIds(n.children)));

Deno.test("parseGroupHint: gültig, mit Scope, unvollständig", () => {
  assertEquals(parseGroupHint("cam1:video"), { group: "cam1", role: "video" });
  assertEquals(parseGroupHint("cam1:high:global"), { group: "cam1", role: "high", scope: "global" });
  assertEquals(parseGroupHint("nocolon"), null);
  assertEquals(parseGroupHint(":role"), null);
  assertEquals(parseGroupHint("group:"), null);
  assertEquals(parseGroupHint(undefined), null);
  assertEquals(parseGroupHint(""), null);
});

Deno.test("Workflow-Gruppierung: current / other / unassigned", () => {
  const tree = buildSourceTree(
    [
      e("a", { workflowId: "w1", workflowName: "Studio A", nodeId: "n1", nodeName: "Cam" }),
      e("b", { workflowId: "w2", workflowName: "Studio B", nodeId: "n2", nodeName: "Play" }),
      e("c"),
    ],
    { currentWorkflowId: "w1" },
  );
  assertEquals(tree.map((s) => s.id), ["sec:current", "sec:other", "sec:unassigned"]);
  assertEquals(leafIds(sec(tree, "sec:current")!.children), ["a"]);
  assertEquals(leafIds(sec(tree, "sec:other")!.children), ["b"]);
  assertEquals(leafIds(sec(tree, "sec:unassigned")!.children), ["c"]);
  // Nur der aktuelle Workflow ist standardmäßig offen.
  assertEquals(sec(tree, "sec:current")!.defaultOpen, true);
  assertEquals(sec(tree, "sec:other")!.defaultOpen, false);
  const otherWf = sec(tree, "sec:other")!.children[0] as SourceGroupNode;
  assertEquals(otherWf.level, "workflow");
  assertEquals(otherWf.label, "Studio B");
});

Deno.test("ohne currentWorkflowId keine Current-Sektion; erste Sektion offen", () => {
  const tree = buildSourceTree([e("a", { workflowId: "w1" })], {});
  assertEquals(tree.map((s) => s.id), ["sec:other"]);
  assertEquals(tree[0].defaultOpen, true);
});

Deno.test("Natural Group: Video+Audio mit gleichem grouphint werden gruppiert", () => {
  const base = { workflowId: "w1", nodeId: "n1", nodeName: "Camera 1" };
  const tree = buildSourceTree(
    [
      e("aud", { ...base, mediaType: "audio", groupHint: "g1:audio" }),
      e("vid", { ...base, mediaType: "video", groupHint: "g1:video" }),
    ],
    { currentWorkflowId: "w1" },
  );
  const node = sec(tree, "sec:current")!.children[0] as SourceGroupNode;
  assertEquals(node.children.length, 1);
  const ng = node.children[0] as SourceGroupNode;
  assertEquals(ng.level, "natural");
  assertEquals(ng.label, "Camera 1");
  // Video vor Audio, Rollen erhalten, beide einzeln auswählbar.
  assertEquals(leafIds(ng.children), ["vid", "aud"]);
  assertEquals((ng.children[0] as { role?: string }).role, "video");
});

Deno.test("verschiedene Gruppen (Video A / Audio B) werden nicht zusammengefasst", () => {
  const base = { workflowId: "w1", nodeId: "n1", nodeName: "Cam" };
  const tree = buildSourceTree(
    [
      e("vid", { ...base, mediaType: "video", groupHint: "A:video" }),
      e("aud", { ...base, mediaType: "audio", groupHint: "B:audio" }),
    ],
    { currentWorkflowId: "w1" },
  );
  const node = sec(tree, "sec:current")!.children[0] as SourceGroupNode;
  assertEquals(node.children.map((c) => c.type), ["source", "source"]);
});

Deno.test("gleicher Gruppenname auf verschiedenen Nodes wird nicht vermischt", () => {
  const mk = (id: string, node: string, hint: string) =>
    e(id, { workflowId: "w1", nodeId: node, nodeName: node, groupHint: hint, mediaType: "video" });
  const local = buildSourceTree([mk("x", "n1", "g:video"), mk("y", "n2", "g:audio")], { currentWorkflowId: "w1" });
  const nodes = sec(local, "sec:current")!.children as SourceGroupNode[];
  assertEquals(nodes.map((n) => n.children.every((c) => c.type === "source")), [true, true]);
});

Deno.test("unvollständiger/fehlender grouphint und fehlende Metadaten brechen nichts", () => {
  const tree = buildSourceTree(
    [e("a", { groupHint: "kaputt" }), e("b", { nodeId: "n1" }), e("c", { workflowId: "w9" })],
    { currentWorkflowId: "w1" },
  );
  assertEquals(leafIds(tree).sort(), ["a", "b", "c"]);
  assertEquals(buildSourceTree([], {}), []);
});

Deno.test("Access: visible=false wird entfernt, selectable=false bleibt sichtbar", () => {
  const entries = [
    e("ok", { workflowId: "w1" }),
    e("locked", { workflowId: "w1", access: { visible: true, selectable: false } }),
    e("hidden", { workflowId: "w1", access: { visible: false, selectable: true } }),
  ];
  const tree = buildSourceTree(entries, { currentWorkflowId: "w1" });
  assertEquals(leafIds(tree).sort(), ["locked", "ok"]);
  assertEquals(findLeaf(tree, "ok")!.selectable, true);
  assertEquals(findLeaf(tree, "locked")!.selectable, false);
  assertEquals(findLeaf(tree, "hidden"), null);
});

Deno.test("Access-Policy wird angewandt, entry.access hat Vorrang", () => {
  const out = applyAccess(
    [e("a"), e("b", { access: { visible: true, selectable: true } })],
    () => ({ selectable: false }),
  );
  assertEquals(out.map((x) => x.access.selectable), [false, true]);
});

Deno.test("Filter accepts=video liefert keine Audio-Quellen (nur per mediaType)", () => {
  const tree = buildSourceTree(
    [
      e("v", { mediaType: "video", label: "Audio Video Mix" }),
      e("a", { mediaType: "audio", label: "Video Ton" }),
      e("u"),
    ],
    { accepts: ["video"] },
  );
  assertEquals(leafIds(tree), ["v"]);
  assertEquals(leafIds(buildSourceTree([e("v", { mediaType: "video" }), e("a", { mediaType: "audio" })], {})).sort(), ["a", "v"]);
});

Deno.test("excludeRoles blendet Lowres-Begleiter aus", () => {
  const tree = buildSourceTree(
    [e("hi", { groupHint: "g:high" }), e("lo", { groupHint: "g:low" })],
    { excludeRoles: ["low"] },
  );
  assertEquals(leafIds(tree), ["hi"]);
});

Deno.test("Abwärtskompatibilität: bestehende Sender-ID wird gefunden und ihr Pfad aufgeklappt", () => {
  const tree = buildSourceTree(
    [e("old-id", { workflowId: "w2", workflowName: "W2", nodeId: "n", nodeName: "N" })],
    { currentWorkflowId: "w1" },
  );
  assertEquals(findLeaf(tree, "old-id")?.id, "old-id");
  assertEquals(pathToSource(tree, "old-id"), ["sec:other", "sec:other/wf:w2", "sec:other/wf:w2/n:n"]);
  assertEquals(findLeaf(tree, "gibt-es-nicht"), null);
  assertEquals(pathToSource(tree, "gibt-es-nicht"), null);
});

Deno.test("Suche: passt auf Label, Node- und Workflow-Namen; entfernt leere Zweige", () => {
  const tree = buildSourceTree(
    [
      e("a", { label: "Program", workflowId: "w1", workflowName: "Studio", nodeId: "n1", nodeName: "Playout" }),
      e("b", { label: "Cam", workflowId: "w1", workflowName: "Studio", nodeId: "n2", nodeName: "Kamera" }),
    ],
    { currentWorkflowId: "w1" },
  );
  assertEquals(leafIds(filterTree(tree, "prog")), ["a"]);
  assertEquals(leafIds(filterTree(tree, "kamera")), ["b"]);
  assertEquals(leafIds(filterTree(tree, "studio")).sort(), ["a", "b"]);
  assertEquals(filterTree(tree, "zzz"), []);
  assertEquals(filterTree(tree, "  "), tree);
});

Deno.test("visibleRows berücksichtigt den Auf-/Zuklapp-Zustand", () => {
  const tree = buildSourceTree(
    [e("a", { workflowId: "w1", nodeId: "n", nodeName: "N" }), e("b", { workflowId: "w2", nodeId: "m", nodeName: "M" })],
    { currentWorkflowId: "w1" },
  );
  const rows = visibleRows(tree, (g) => g.defaultOpen);
  // current (offen) → Node → a ; other (zu)
  assertEquals(rows.map((r) => r.node.type === "group" ? r.node.id : r.node.id), ["sec:current", "sec:current/n:n", "a", "sec:other"]);
  assert(rows.every((r, i) => i === 0 || r.depth >= 0));
});

Deno.test("scope=global fasst Mitglieder verschiedener Nodes einer Gruppe zusammen", () => {
  const mk = (id: string, node: string, mt: "video" | "audio") =>
    e(id, { workflowId: "w1", nodeId: node, nodeName: node, groupHint: "g:x:global", mediaType: mt });
  const tree = buildSourceTree([mk("v", "n1", "video"), mk("a", "n2", "audio")], { currentWorkflowId: "w1" });
  // Beide landen im selben Natural-Group-Knoten (je unter ihrem Node ist nur 1 Mitglied → Blatt).
  assertEquals(leafIds(tree).sort(), ["a", "v"]);
});

Deno.test("nur unassigned: Sektion und Node-Gruppen sind standardmäßig offen", () => {
  const tree = buildSourceTree([e("a", { nodeId: "n", nodeName: "N" })], {});
  const rows = visibleRows(tree, (g) => g.defaultOpen);
  assertEquals(rows.map((r) => r.node.id), ["sec:unassigned", "sec:unassigned/n:n", "a"]);
});

Deno.test("Instanz-Kurz-ID wird in Knotennamen und Blättern weggelassen", () => {
  const tree = buildSourceTree([e("a", { nodeId: "n", nodeName: "Source (3f2a1b9c)", label: "Source (3f2a1b9c) Sender 1" })], {});
  const rows = visibleRows(tree, () => true);
  assertEquals(rows.slice(1).map((r) => r.node.label), ["Source", "Source Sender 1"]);
});
