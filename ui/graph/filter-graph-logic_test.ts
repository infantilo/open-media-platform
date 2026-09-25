import { assertEquals } from "jsr:@std/assert@1";
import {
  compileFilterGraph,
  escapeFilterOptionValue,
  type FilterGraph,
  filterOptionsToSpec,
  type GraphNode,
  nodePadCounts,
  parseFilterIO,
} from "./filter-graph-logic.ts";

Deno.test("parseFilterIO decodes the four ffmpeg -filters IO shapes", () => {
  assertEquals(parseFilterIO("V->V"), { inputs: { count: 1, dynamic: false }, outputs: { count: 1, dynamic: false } });
  assertEquals(parseFilterIO("AA->A"), { inputs: { count: 2, dynamic: false }, outputs: { count: 1, dynamic: false } });
  assertEquals(parseFilterIO("N->N"), { inputs: { count: 1, dynamic: true }, outputs: { count: 1, dynamic: true } });
  assertEquals(parseFilterIO("|->A"), { inputs: { count: 0, dynamic: false }, outputs: { count: 1, dynamic: false } });
  assertEquals(parseFilterIO("A->N"), { inputs: { count: 1, dynamic: false }, outputs: { count: 1, dynamic: true } });
});

Deno.test("nodePadCounts resolves dynamic (N) pads via the node's own inputCount/outputCount", () => {
  const dynamicFilter: GraphNode = { id: "f", kind: "filter", filterName: "amix", filterIO: "N->A", inputCount: 3 };
  assertEquals(nodePadCounts(dynamicFilter), { inputs: 3, outputs: 1 });

  const fixedFilter: GraphNode = { id: "f2", kind: "filter", filterName: "scale", filterIO: "V->V" };
  assertEquals(nodePadCounts(fixedFilter), { inputs: 1, outputs: 1 });

  assertEquals(nodePadCounts({ id: "i", kind: "input" }), { inputs: 0, outputs: 1 });
  assertEquals(nodePadCounts({ id: "o", kind: "output" }), { inputs: 1, outputs: 0 });
});

Deno.test("escapeFilterOptionValue only quotes values containing ffmpeg's own filter-syntax separators", () => {
  assertEquals(escapeFilterOptionValue("640"), "640");
  assertEquals(escapeFilterOptionValue("bt601"), "bt601");
  assertEquals(escapeFilterOptionValue("a:b"), "'a:b'");
  assertEquals(escapeFilterOptionValue("it's"), "'it'\\''s'");
});

Deno.test("filterOptionsToSpec joins key=value with ':' and skips untouched (empty) options", () => {
  assertEquals(filterOptionsToSpec({ w: "640", h: "480" }), "w=640:h=480");
  assertEquals(filterOptionsToSpec({ w: "640", flags: "" }), "w=640");
  assertEquals(filterOptionsToSpec({}), "");
});

function simpleChain(): FilterGraph {
  return {
    nodes: [
      { id: "in0", kind: "input", label: "0:v" },
      { id: "f0", kind: "filter", filterName: "scale", filterIO: "V->V", options: { w: "640" } },
      { id: "out0", kind: "output", label: "out" },
    ],
    edges: [
      { id: "e0", fromNode: "in0", fromPort: 0, toNode: "f0", toPort: 0 },
      { id: "e1", fromNode: "f0", fromPort: 0, toNode: "out0", toPort: 0 },
    ],
  };
}

Deno.test("compileFilterGraph: simple one-in-one-out chain", () => {
  const r = compileFilterGraph(simpleChain());
  if (!r.ok) throw new Error(r.error);
  assertEquals(r.result.filterComplex, "[0:v]scale=w=640[s0]");
  assertEquals(r.result.outputLabels, ["s0"]);
});

Deno.test("compileFilterGraph: two-input filter (e.g. overlay) reads both sources in port order", () => {
  const graph: FilterGraph = {
    nodes: [
      { id: "in0", kind: "input", label: "0:v" },
      { id: "in1", kind: "input", label: "1:v" },
      { id: "f0", kind: "filter", filterName: "overlay", filterIO: "VV->V" },
      { id: "out0", kind: "output" },
    ],
    edges: [
      { id: "e0", fromNode: "in0", fromPort: 0, toNode: "f0", toPort: 0 },
      { id: "e1", fromNode: "in1", fromPort: 0, toNode: "f0", toPort: 1 },
      { id: "e2", fromNode: "f0", fromPort: 0, toNode: "out0", toPort: 0 },
    ],
  };
  const r = compileFilterGraph(graph);
  if (!r.ok) throw new Error(r.error);
  assertEquals(r.result.filterComplex, "[0:v][1:v]overlay[s0]");
  assertEquals(r.result.outputLabels, ["s0"]);
});

Deno.test("compileFilterGraph: chains two filters, reusing the intermediate label", () => {
  const graph: FilterGraph = {
    nodes: [
      { id: "in0", kind: "input", label: "0:v" },
      { id: "f0", kind: "filter", filterName: "scale", filterIO: "V->V", options: { w: "640" } },
      { id: "f1", kind: "filter", filterName: "hflip", filterIO: "V->V" },
      { id: "out0", kind: "output" },
    ],
    edges: [
      { id: "e0", fromNode: "in0", fromPort: 0, toNode: "f0", toPort: 0 },
      { id: "e1", fromNode: "f0", fromPort: 0, toNode: "f1", toPort: 0 },
      { id: "e2", fromNode: "f1", fromPort: 0, toNode: "out0", toPort: 0 },
    ],
  };
  const r = compileFilterGraph(graph);
  if (!r.ok) throw new Error(r.error);
  assertEquals(r.result.filterComplex, "[0:v]scale=w=640[s0];[s0]hflip[s1]");
  assertEquals(r.result.outputLabels, ["s1"]);
});

Deno.test("compileFilterGraph: dynamic (N) pad filter with a user-set track count", () => {
  const graph: FilterGraph = {
    nodes: [
      { id: "in0", kind: "input", label: "0:a" },
      { id: "in1", kind: "input", label: "1:a" },
      { id: "in2", kind: "input", label: "2:a" },
      { id: "mix", kind: "filter", filterName: "amix", filterIO: "N->A", inputCount: 3, options: { inputs: "3" } },
      { id: "out0", kind: "output" },
    ],
    edges: [
      { id: "e0", fromNode: "in0", fromPort: 0, toNode: "mix", toPort: 0 },
      { id: "e1", fromNode: "in1", fromPort: 0, toNode: "mix", toPort: 1 },
      { id: "e2", fromNode: "in2", fromPort: 0, toNode: "mix", toPort: 2 },
      { id: "e3", fromNode: "mix", fromPort: 0, toNode: "out0", toPort: 0 },
    ],
  };
  const r = compileFilterGraph(graph);
  if (!r.ok) throw new Error(r.error);
  assertEquals(r.result.filterComplex, "[0:a][1:a][2:a]amix=inputs=3[s0]");
});

Deno.test("compileFilterGraph: multiple outputs each resolve their own upstream label", () => {
  const graph: FilterGraph = {
    nodes: [
      { id: "in0", kind: "input", label: "0:v" },
      { id: "f0", kind: "filter", filterName: "split", filterIO: "V->N", outputCount: 2 },
      { id: "out0", kind: "output" },
      { id: "out1", kind: "output" },
    ],
    edges: [
      { id: "e0", fromNode: "in0", fromPort: 0, toNode: "f0", toPort: 0 },
      { id: "e1", fromNode: "f0", fromPort: 0, toNode: "out0", toPort: 0 },
      { id: "e2", fromNode: "f0", fromPort: 1, toNode: "out1", toPort: 0 },
    ],
  };
  const r = compileFilterGraph(graph);
  if (!r.ok) throw new Error(r.error);
  assertEquals(r.result.filterComplex, "[0:v]split[s0][s1]");
  assertEquals(r.result.outputLabels, ["s0", "s1"]);
});

Deno.test("compileFilterGraph: rejects a graph with no output node", () => {
  const graph: FilterGraph = { nodes: [{ id: "in0", kind: "input", label: "0:v" }], edges: [] };
  const r = compileFilterGraph(graph);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.error, "Mindestens ein Ausgang ist nötig.");
});

Deno.test("compileFilterGraph: reports which unconnected input is missing, by position", () => {
  const graph: FilterGraph = {
    nodes: [
      { id: "in0", kind: "input", label: "0:v" },
      { id: "f0", kind: "filter", filterName: "overlay", filterIO: "VV->V" },
      { id: "out0", kind: "output" },
    ],
    edges: [
      { id: "e0", fromNode: "in0", fromPort: 0, toNode: "f0", toPort: 0 },
      { id: "e1", fromNode: "f0", fromPort: 0, toNode: "out0", toPort: 0 },
    ],
  };
  const r = compileFilterGraph(graph);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.error, 'Eingang 2 von „overlay" ist nicht verbunden.');
});

Deno.test("compileFilterGraph: rejects an unconnected output", () => {
  const graph: FilterGraph = {
    nodes: [{ id: "in0", kind: "input", label: "0:v" }, { id: "out0", kind: "output", label: "final" }],
    edges: [],
  };
  const r = compileFilterGraph(graph);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.error, 'Ausgang „final" ist nicht verbunden.');
});

Deno.test("compileFilterGraph: rejects an input node without a stream label", () => {
  const graph: FilterGraph = {
    nodes: [{ id: "in0", kind: "input", label: "" }, { id: "out0", kind: "output" }],
    edges: [{ id: "e0", fromNode: "in0", fromPort: 0, toNode: "out0", toPort: 0 }],
  };
  const r = compileFilterGraph(graph);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.error, 'Eingang „in0" hat keine Kennung (z. B. 0:v).');
});

Deno.test("compileFilterGraph: detects a cycle instead of looping forever", () => {
  const graph: FilterGraph = {
    nodes: [
      { id: "f0", kind: "filter", filterName: "a", filterIO: "V->V" },
      { id: "f1", kind: "filter", filterName: "b", filterIO: "V->V" },
      { id: "out0", kind: "output" },
    ],
    edges: [
      { id: "e0", fromNode: "f0", fromPort: 0, toNode: "f1", toPort: 0 },
      { id: "e1", fromNode: "f1", fromPort: 0, toNode: "f0", toPort: 0 },
      { id: "e2", fromNode: "f1", fromPort: 0, toNode: "out0", toPort: 0 },
    ],
  };
  const r = compileFilterGraph(graph);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.error, "Der Filter-Graph enthält einen Kreis (eine Verbindung führt zyklisch zurück).");
});
