import { assertEquals } from "jsr:@std/assert";
import { searchNodes } from "./node-search-logic.ts";
import type { GroupTree } from "./groups.ts";

const tree: GroupTree = {
  groups: {
    a: { id: "a", label: "Regie 1", parentId: null, nodeIds: ["n2"], groupIds: ["b"] },
    b: { id: "b", label: "Kameras", parentId: "a", nodeIds: ["n3"], groupIds: [] },
  },
};
const nodes = [
  { id: "n1", label: "Mischer Haupt" },
  { id: "n2", label: "Kamera links" },
  { id: "n3", label: "Kamera rechts" },
];

Deno.test("leere Suche liefert nichts", () => assertEquals(searchNodes(nodes, tree, "  "), []));
Deno.test("Wörter müssen alle passen, Groß/Klein egal", () => {
  assertEquals(searchNodes(nodes, tree, "KAMERA rechts").map((h) => h.id), ["n3"]);
});
Deno.test("Gruppenpfad und Gruppe werden geliefert", () => {
  const h = searchNodes(nodes, tree, "rechts")[0];
  assertEquals([h.groupId, h.groupPath], ["b", "Regie 1 › Kameras"]);
  assertEquals(searchNodes(nodes, tree, "mischer")[0].groupId, null);
});
Deno.test("Suche über die ID, Präfix-Treffer zuerst", () => {
  assertEquals(searchNodes(nodes, tree, "n1").map((h) => h.id), []); // kurze Wörter suchen nur im Namen
  assertEquals(searchNodes([{ id: "0a1b2c3d-aaaa", label: "Mischer" }], tree, "0a1b2c").map((h) => h.id), ["0a1b2c3d-aaaa"]);
  assertEquals(searchNodes([{ id: "x", label: "Alte Kamera" }, { id: "y", label: "Kamera 2" }], tree, "kamera").map((h) => h.id), ["y", "x"]);
});
