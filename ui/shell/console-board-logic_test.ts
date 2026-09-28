import { assertEquals } from "jsr:@std/assert@1";
import {
  computeDefaultLayout,
  computeTileGridLayout,
  diffEntries,
  DEFAULT_TILE_HEIGHT,
  DEFAULT_TILE_WIDTH,
  MIN_TILE_HEIGHT,
  MIN_TILE_WIDTH,
  reconcileLayouts,
  TILE_GAP,
} from "./console-board-logic.ts";

const a = { nodeRoleId: "role-a", uiBundleUrl: "/api/v1/nodes/node-a-1" };
const b = { nodeRoleId: "role-b", uiBundleUrl: "/api/v1/nodes/node-b-1" };
const c = { nodeRoleId: "role-c", uiBundleUrl: "/api/v1/nodes/node-c-1" };

Deno.test("diffEntries: a brand-new role is queued for mount", () => {
  const diff = diffEntries([a], [a, b]);
  assertEquals(diff.toMount, [b]);
  assertEquals(diff.toRemount, []);
  assertEquals(diff.toUnmount, []);
});

Deno.test("diffEntries: a role no longer present is queued for unmount", () => {
  const diff = diffEntries([a, b], [a]);
  assertEquals(diff.toMount, []);
  assertEquals(diff.toRemount, []);
  assertEquals(diff.toUnmount, ["role-b"]);
});

Deno.test("diffEntries: a restarted process (same role, new node id) triggers a remount, not a full mount/unmount", () => {
  const aRestarted = { nodeRoleId: "role-a", uiBundleUrl: "/api/v1/nodes/node-a-2" };
  const diff = diffEntries([a, b], [aRestarted, b]);
  assertEquals(diff.toMount, []);
  assertEquals(diff.toRemount, [aRestarted]);
  assertEquals(diff.toUnmount, []);
});

Deno.test("diffEntries: entries unchanged in both role and bundle url need no action", () => {
  const diff = diffEntries([a, b], [a, b]);
  assertEquals(diff.toMount, []);
  assertEquals(diff.toRemount, []);
  assertEquals(diff.toUnmount, []);
});

Deno.test("diffEntries: simultaneous add, remove and remount", () => {
  const bRestarted = { nodeRoleId: "role-b", uiBundleUrl: "/api/v1/nodes/node-b-2" };
  const diff = diffEntries([a, b], [bRestarted, c]);
  assertEquals(diff.toMount, [c]);
  assertEquals(diff.toRemount, [bRestarted]);
  assertEquals(diff.toUnmount, ["role-a"]);
});

Deno.test("computeDefaultLayout: lays tiles out left to right within the container width", () => {
  const containerWidth = (DEFAULT_TILE_WIDTH + TILE_GAP) * 3;
  assertEquals(computeDefaultLayout(0, containerWidth), { x: 0, y: 0, width: DEFAULT_TILE_WIDTH, height: DEFAULT_TILE_HEIGHT });
  assertEquals(computeDefaultLayout(1, containerWidth), {
    x: DEFAULT_TILE_WIDTH + TILE_GAP,
    y: 0,
    width: DEFAULT_TILE_WIDTH,
    height: DEFAULT_TILE_HEIGHT,
  });
});

Deno.test("computeDefaultLayout: wraps to a new row once the container width is exhausted", () => {
  const containerWidth = (DEFAULT_TILE_WIDTH + TILE_GAP) * 2 - 1;
  assertEquals(computeDefaultLayout(2, containerWidth), {
    x: 0,
    y: DEFAULT_TILE_HEIGHT + TILE_GAP,
    width: DEFAULT_TILE_WIDTH,
    height: DEFAULT_TILE_HEIGHT,
  });
});

Deno.test("computeDefaultLayout: never produces zero columns, even in a very narrow container", () => {
  assertEquals(computeDefaultLayout(0, 10), { x: 0, y: 0, width: DEFAULT_TILE_WIDTH, height: DEFAULT_TILE_HEIGHT });
});

Deno.test("reconcileLayouts: keeps a stored position for a role that is still present", () => {
  const stored = { "role-a": { x: 500, y: 500, width: 400, height: 400 } };
  const result = reconcileLayouts([a], stored, 1000);
  assertEquals(result["role-a"], stored["role-a"]);
});

Deno.test("reconcileLayouts: assigns a default position to a newly appeared role", () => {
  const stored = { "role-a": { x: 500, y: 500, width: 400, height: 400 } };
  const result = reconcileLayouts([a, b], stored, 1000);
  assertEquals(result["role-a"], stored["role-a"]);
  // b hat keine gespeicherte Position -> Default an Index 1 (nach dem einen
  // bereits platzierten Eintrag), nicht an Index 0 (sonst würde sie sich mit
  // role-a's tatsächlicher Position überlappen, falls die zufällig auch bei
  // Index 0 läge).
  assertEquals(result["role-b"], computeDefaultLayout(1, 1000));
});

Deno.test("reconcileLayouts: drops layouts for roles no longer in entries", () => {
  const stored = {
    "role-a": { x: 0, y: 0, width: 400, height: 400 },
    "role-b": { x: 400, y: 0, width: 400, height: 400 },
  };
  const result = reconcileLayouts([a], stored, 1000);
  assertEquals(Object.keys(result), ["role-a"]);
});

Deno.test("reconcileLayouts: multiple simultaneously new roles get non-overlapping default positions", () => {
  const result = reconcileLayouts([a, b, c], {}, 1000);
  assertEquals(result["role-a"], computeDefaultLayout(0, 1000));
  assertEquals(result["role-b"], computeDefaultLayout(1, 1000));
  assertEquals(result["role-c"], computeDefaultLayout(2, 1000));
});

Deno.test("computeTileGridLayout: empty entries produce no layouts", () => {
  assertEquals(computeTileGridLayout(0, 1000, 800), []);
});

Deno.test("computeTileGridLayout: four tiles form a 2x2 grid filling the container", () => {
  const layouts = computeTileGridLayout(4, 1000, 800);
  assertEquals(layouts.length, 4);
  // 2 Spalten x 2 Zeilen (ceil(sqrt(4))=2) — alle vier Kacheln gleich groß.
  const [tl, tr, bl, br] = layouts;
  assertEquals(tl.width, tr.width);
  assertEquals(tl.height, bl.height);
  assertEquals(tl.x, bl.x); // gleiche Spalte
  assertEquals(tl.y, tr.y); // gleiche Zeile
  assertEquals(br.x > tl.x, true);
  assertEquals(br.y > tl.y, true);
});

Deno.test("computeTileGridLayout: three tiles form a 2-column grid (2 in row 1, 1 in row 2)", () => {
  const layouts = computeTileGridLayout(3, 1000, 800);
  assertEquals(layouts.length, 3);
  assertEquals(layouts[0].y, layouts[1].y);
  assertEquals(layouts[2].y > layouts[0].y, true);
  assertEquals(layouts[2].x, layouts[0].x); // dritte Kachel beginnt neue Zeile in Spalte 0
});

Deno.test("computeTileGridLayout: never shrinks a tile below the minimum size, even for many tiles in a small container", () => {
  const layouts = computeTileGridLayout(20, 400, 300);
  for (const l of layouts) {
    assertEquals(l.width >= MIN_TILE_WIDTH, true);
    assertEquals(l.height >= MIN_TILE_HEIGHT, true);
  }
});
