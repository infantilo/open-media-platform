import { assertEquals } from "jsr:@std/assert@1";
import {
  breadcrumbPath,
  createGroup,
  dissolveGroup,
  emptyTree,
  flattenMembers,
  type GroupTree,
  promotedPorts,
  setGroupWorkflowId,
  topLevelItems,
} from "./groups.ts";

function sorted(arr: string[]): string[] {
  return [...arr].sort();
}

Deno.test("topLevelItems with empty tree returns all nodes ungrouped", () => {
  const tree = emptyTree();
  const items = topLevelItems(tree, null, ["a", "b", "c"]);
  assertEquals(sorted(items.nodeIds), ["a", "b", "c"]);
  assertEquals(items.groupIds, []);
});

Deno.test("createGroup removes members from top-level and creates the group", () => {
  const tree = emptyTree();
  const grouped = createGroup(tree, "g1", "Regie 1", null, ["a", "b"], []);

  const top = topLevelItems(grouped, null, ["a", "b", "c"]);
  assertEquals(sorted(top.nodeIds), ["c"]);
  assertEquals(top.groupIds, ["g1"]);

  const inside = topLevelItems(grouped, "g1", ["a", "b", "c"]);
  assertEquals(sorted(inside.nodeIds), ["a", "b"]);
});

Deno.test("setGroupWorkflowId attaches the workflow id, leaving other groups untouched", () => {
  let tree = emptyTree();
  tree = createGroup(tree, "g1", "Regie 1", null, ["a", "b"], []);
  tree = createGroup(tree, "g2", "Regie 2", null, ["c"], []);

  const withWorkflow = setGroupWorkflowId(tree, "g1", "wf-123");
  assertEquals(withWorkflow.groups["g1"].workflowId, "wf-123");
  assertEquals(withWorkflow.groups["g2"].workflowId, undefined);
});

Deno.test("setGroupWorkflowId is a no-op for an unknown group", () => {
  const tree = emptyTree();
  const result = setGroupWorkflowId(tree, "does-not-exist", "wf-123");
  assertEquals(result, tree);
});

Deno.test("createGroup can nest an existing group inside a new one", () => {
  let tree = emptyTree();
  tree = createGroup(tree, "inner", "Inner", null, ["a"], []);
  tree = createGroup(tree, "outer", "Outer", null, ["b"], ["inner"]);

  const top = topLevelItems(tree, null, ["a", "b"]);
  assertEquals(top.groupIds, ["outer"]);

  const outerChildren = topLevelItems(tree, "outer", ["a", "b"]);
  assertEquals(outerChildren.nodeIds, ["b"]);
  assertEquals(outerChildren.groupIds, ["inner"]);

  assertEquals(tree.groups["inner"].parentId, "outer");
});

Deno.test("flattenMembers recurses through nested groups", () => {
  let tree = emptyTree();
  tree = createGroup(tree, "inner", "Inner", null, ["a", "b"], []);
  tree = createGroup(tree, "outer", "Outer", null, ["c"], ["inner"]);

  assertEquals(sorted(flattenMembers(tree, "outer")), ["a", "b", "c"]);
  assertEquals(sorted(flattenMembers(tree, "inner")), ["a", "b"]);
  assertEquals(flattenMembers(tree, "does-not-exist"), []);
});

Deno.test("dissolveGroup at top level ungroups its members", () => {
  let tree = emptyTree();
  tree = createGroup(tree, "g1", "Regie 1", null, ["a", "b"], []);
  tree = dissolveGroup(tree, "g1");

  const top = topLevelItems(tree, null, ["a", "b", "c"]);
  assertEquals(sorted(top.nodeIds), ["a", "b", "c"]);
  assertEquals(top.groupIds, []);
});

Deno.test("dissolveGroup nested re-parents children to the grandparent", () => {
  let tree = emptyTree();
  tree = createGroup(tree, "inner", "Inner", null, ["a"], []);
  tree = createGroup(tree, "outer", "Outer", null, ["b"], ["inner"]);
  tree = dissolveGroup(tree, "outer");

  const top = topLevelItems(tree, null, ["a", "b"]);
  assertEquals(sorted(top.nodeIds), ["b"]);
  assertEquals(top.groupIds, ["inner"]);
  assertEquals(tree.groups["inner"].parentId, null);
});

Deno.test("breadcrumbPath walks from root to the given group", () => {
  let tree = emptyTree();
  tree = createGroup(tree, "inner", "Inner", null, ["a"], []);
  tree = createGroup(tree, "outer", "Outer", null, [], ["inner"]);

  const path = breadcrumbPath(tree, "inner");
  assertEquals(path.map((g) => g.id), ["outer", "inner"]);
  assertEquals(breadcrumbPath(tree, null), []);
});

function port(nodeId: string, portId: string, side: "input" | "output"): {
  nodeId: string;
  portId: string;
  side: "input" | "output";
  label: string;
  format: string;
} {
  return { nodeId, portId, side, label: portId, format: "" };
}

function groupWithTwoConnectedNodes(): GroupTree {
  // a.out -> b.in (internal edge), a.in and b.out unconnected.
  return createGroup(emptyTree(), "g1", "Group", null, ["a", "b"], []);
}

Deno.test("promotedPorts hides ports whose only edge is fully internal", () => {
  const tree = groupWithTwoConnectedNodes();
  const allPorts = [
    port("a", "a.in", "input"),
    port("a", "a.out", "output"),
    port("b", "b.in", "input"),
    port("b", "b.out", "output"),
  ];
  const edges = [{ fromSender: "a.out", toReceiver: "b.in" }];

  const { inputs, outputs } = promotedPorts(tree, "g1", allPorts, edges);

  assertEquals(sorted(inputs.map((p) => p.portId)), ["a.in"]); // b.in hidden (internal)
  assertEquals(sorted(outputs.map((p) => p.portId)), ["b.out"]); // a.out hidden (internal)
});

Deno.test("promotedPorts promotes ports connected to the outside", () => {
  const tree = createGroup(emptyTree(), "g1", "Group", null, ["a"], []);
  const allPorts = [
    port("a", "a.in", "input"),
    port("a", "a.out", "output"),
    port("outside", "x.out", "output"),
    port("outside", "x.in", "input"),
  ];
  const edges = [
    { fromSender: "x.out", toReceiver: "a.in" },
    { fromSender: "a.out", toReceiver: "x.in" },
  ];

  const { inputs, outputs } = promotedPorts(tree, "g1", allPorts, edges);

  assertEquals(inputs.map((p) => p.portId), ["a.in"]);
  assertEquals(outputs.map((p) => p.portId), ["a.out"]);
});

Deno.test("promotedPorts promotes unconnected ports", () => {
  const tree = createGroup(emptyTree(), "g1", "Group", null, ["a"], []);
  const allPorts = [port("a", "a.in", "input"), port("a", "a.out", "output")];

  const { inputs, outputs } = promotedPorts(tree, "g1", allPorts, []);

  assertEquals(inputs.map((p) => p.portId), ["a.in"]);
  assertEquals(outputs.map((p) => p.portId), ["a.out"]);
});

Deno.test("promotedPorts treats an edge between two nested subgroups as internal to the parent", () => {
  let tree = emptyTree();
  tree = createGroup(tree, "sub1", "Sub 1", null, ["a"], []);
  tree = createGroup(tree, "sub2", "Sub 2", null, ["b"], []);
  tree = createGroup(tree, "parent", "Parent", null, [], ["sub1", "sub2"]);

  const allPorts = [port("a", "a.out", "output"), port("b", "b.in", "input")];
  const edges = [{ fromSender: "a.out", toReceiver: "b.in" }];

  const parentPromotion = promotedPorts(tree, "parent", allPorts, edges);
  assertEquals(parentPromotion.inputs, []);
  assertEquals(parentPromotion.outputs, []);

  // Aus Sicht von sub1 allein ist a.out sehr wohl nach außen offen
  // (b liegt außerhalb von sub1).
  const sub1Promotion = promotedPorts(tree, "sub1", allPorts, edges);
  assertEquals(sub1Promotion.outputs.map((p) => p.portId), ["a.out"]);
});
