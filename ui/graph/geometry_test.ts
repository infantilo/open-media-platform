import { assertEquals, assertAlmostEquals } from "jsr:@std/assert@1";
import {
  arrangeByFlow,
  defaultPosition,
  findFreePosition,
  IDENTITY_VIEWPORT,
  MAX_SCALE,
  MIN_SCALE,
  nodeHeight,
  portPosition,
  screenToWorld,
  worldToScreen,
  zoomAt,
} from "./geometry.ts";

Deno.test("screenToWorld/worldToScreen are inverses at identity viewport", () => {
  const p = { x: 42, y: 17 };
  assertEquals(screenToWorld(p, IDENTITY_VIEWPORT), p);
  assertEquals(worldToScreen(p, IDENTITY_VIEWPORT), p);
});

Deno.test("worldToScreen applies pan and scale", () => {
  const viewport = { x: 100, y: 50, scale: 2 };
  assertEquals(worldToScreen({ x: 10, y: 10 }, viewport), { x: 120, y: 70 });
});

Deno.test("screenToWorld inverts worldToScreen for arbitrary viewport", () => {
  const viewport = { x: -30, y: 80, scale: 1.5 };
  const world = { x: 12, y: -7 };
  const screen = worldToScreen(world, viewport);
  const back = screenToWorld(screen, viewport);
  assertAlmostEquals(back.x, world.x);
  assertAlmostEquals(back.y, world.y);
});

Deno.test("zoomAt keeps the world point under the cursor fixed on screen", () => {
  const viewport = { x: 0, y: 0, scale: 1 };
  const cursor = { x: 200, y: 150 };
  const worldBefore = screenToWorld(cursor, viewport);

  const zoomed = zoomAt(viewport, cursor, 2);
  const worldAfter = screenToWorld(cursor, zoomed);

  assertAlmostEquals(worldAfter.x, worldBefore.x);
  assertAlmostEquals(worldAfter.y, worldBefore.y);
  assertEquals(zoomed.scale, 2);
});

Deno.test("zoomAt clamps to MIN_SCALE/MAX_SCALE", () => {
  const viewport = { x: 0, y: 0, scale: 1 };
  const cursor = { x: 0, y: 0 };

  const zoomedOut = zoomAt(viewport, cursor, 0.0001);
  assertEquals(zoomedOut.scale, MIN_SCALE);

  const zoomedIn = zoomAt(viewport, cursor, 1000);
  assertEquals(zoomedIn.scale, MAX_SCALE);
});

Deno.test("nodeHeight grows with the larger port count", () => {
  assertEquals(nodeHeight(0, 0), 24 + 40);
  assertEquals(nodeHeight(1, 1), 24 + 40);
  assertEquals(nodeHeight(5, 1), 24 + 5 * 20);
});

Deno.test("portPosition places inputs on the left, outputs on the right", () => {
  const h = nodeHeight(1, 1);
  const input = portPosition(100, 200, h, 0, 1, "input");
  const output = portPosition(100, 200, h, 0, 1, "output");

  assertEquals(input.x, 100);
  assertEquals(output.x, 100 + 160);
  assertEquals(input.y, output.y);
});

Deno.test("portPosition spreads multiple ports evenly", () => {
  const h = nodeHeight(3, 0);
  const p0 = portPosition(0, 0, h, 0, 3, "input");
  const p1 = portPosition(0, 0, h, 1, 3, "input");
  const p2 = portPosition(0, 0, h, 2, 3, "input");

  const gap1 = p1.y - p0.y;
  const gap2 = p2.y - p1.y;
  assertAlmostEquals(gap1, gap2);
  assertEquals(p0.y < p1.y && p1.y < p2.y, true);
});

Deno.test("defaultPosition arranges nodes on a grid without overlap", () => {
  const positions = Array.from({ length: 6 }, (_, i) => defaultPosition(i));
  const unique = new Set(positions.map((p) => `${p.x},${p.y}`));
  assertEquals(unique.size, positions.length);
});

Deno.test("findFreePosition returns the plain default slot when nothing is occupied", () => {
  const pos = findFreePosition([], 0, 160, 64);
  assertEquals(pos, defaultPosition(0));
});

Deno.test("findFreePosition skips a default slot occupied by a manually moved tile", () => {
  const occupied = [{ x: defaultPosition(0).x, y: defaultPosition(0).y, width: 160, height: 64 }];
  const pos = findFreePosition(occupied, 0, 160, 64);
  const candidate = { x: pos.x, y: pos.y, width: 160, height: 64 };
  const overlaps = candidate.x < occupied[0].x + occupied[0].width + 20 &&
    candidate.x + candidate.width + 20 > occupied[0].x &&
    candidate.y < occupied[0].y + occupied[0].height + 20 &&
    candidate.y + candidate.height + 20 > occupied[0].y;
  assertEquals(overlaps, false);
});

Deno.test("findFreePosition finds a slot even when several consecutive default slots are occupied", () => {
  const occupied = Array.from({ length: 3 }, (_, i) => {
    const p = defaultPosition(i);
    return { x: p.x, y: p.y, width: 160, height: 64 };
  });
  const pos = findFreePosition(occupied, 0, 160, 64);
  const candidate = { x: pos.x, y: pos.y, width: 160, height: 64 };
  for (const rect of occupied) {
    const overlaps = candidate.x < rect.x + rect.width + 20 &&
      candidate.x + candidate.width + 20 > rect.x &&
      candidate.y < rect.y + rect.height + 20 &&
      candidate.y + candidate.height + 20 > rect.y;
    assertEquals(overlaps, false);
  }
});

Deno.test("arrangeByFlow places a source left of a sink it feeds", () => {
  const nodes = [
    { id: "source", width: 160, height: 64 },
    { id: "sink", width: 160, height: 64 },
  ];
  const edges = [{ from: "source", to: "sink" }];
  const positions = arrangeByFlow(nodes, edges);
  assertEquals(positions.source.x < positions.sink.x, true);
});

Deno.test("arrangeByFlow places a node at the deepest layer reachable from any source", () => {
  // a -> b -> d, a -> c, c -> d: d must sit right of BOTH its predecessors'
  // deepest layer, i.e. after b (layer 1), not just after c (layer 0).
  const nodes = ["a", "b", "c", "d"].map((id) => ({ id, width: 160, height: 64 }));
  const edges = [
    { from: "a", to: "b" },
    { from: "a", to: "c" },
    { from: "b", to: "d" },
    { from: "c", to: "d" },
  ];
  const positions = arrangeByFlow(nodes, edges);
  assertEquals(positions.d.x > positions.b.x, true);
  assertEquals(positions.d.x > positions.c.x, true);
});

Deno.test("arrangeByFlow does not overlap nodes within the same column", () => {
  const nodes = [
    { id: "src", width: 160, height: 64 },
    { id: "a", width: 160, height: 64 },
    { id: "b", width: 160, height: 90 },
  ];
  const edges = [{ from: "src", to: "a" }, { from: "src", to: "b" }];
  const positions = arrangeByFlow(nodes, edges);
  assertEquals(positions.a.x, positions.b.x);
  assertEquals(positions.a.y !== positions.b.y, true);
});

Deno.test("arrangeByFlow terminates and places every node even with a cycle", () => {
  const nodes = ["a", "b", "c"].map((id) => ({ id, width: 160, height: 64 }));
  const edges = [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
    { from: "c", to: "a" },
  ];
  const positions = arrangeByFlow(nodes, edges);
  assertEquals(Object.keys(positions).length, 3);
});

Deno.test("arrangeByFlow places disconnected nodes in the source column", () => {
  const nodes = [
    { id: "src", width: 160, height: 64 },
    { id: "sink", width: 160, height: 64 },
    { id: "lonely", width: 160, height: 64 },
  ];
  const edges = [{ from: "src", to: "sink" }];
  const positions = arrangeByFlow(nodes, edges);
  assertEquals(positions.lonely.x, positions.src.x);
});
