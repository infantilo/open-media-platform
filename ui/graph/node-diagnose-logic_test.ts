import { assertEquals } from "jsr:@std/assert";
import { boxLevel, formatBytes, layoutPipeline, type NdElement, type NdPipeline, queueFill, splitFindings } from "./node-diagnose-logic.ts";

const el = (name: string, factory: string, peers: Record<string, string> = {}, o: Partial<NdElement> = {}): NdElement => ({
  name, factory, state: "Playing",
  pads: Object.entries(peers).map(([pad, peer]) => ({ name: pad, dir: "src" as const, peer, caps: "video/x-raw" })),
  ...o,
});

Deno.test("queueFill: das Größte aus Puffern, Bytes und Zeit; ohne Grenze null", () => {
  assertEquals(queueFill(undefined), null);
  assertEquals(queueFill({ buffers: 5 }), null);
  assertEquals(queueFill({ buffers: 50, maxBuffers: 200 }), 0.25);
  assertEquals(queueFill({ buffers: 50, maxBuffers: 200, bytes: 900, maxBytes: 1000 }), 0.9);
  assertEquals(queueFill({ buffers: 300, maxBuffers: 200 }), 1);
});

Deno.test("layoutPipeline: Spalten von der Quelle zum Ausgang, Reihen bei Verzweigung", () => {
  const p: NdPipeline = {
    name: "main", state: "Playing",
    elements: [
      el("src", "videotestsrc", { src: "q1.sink" }),
      el("q1", "queue", { src: "conv.sink" }, { level: { buffers: 200, maxBuffers: 200 } }),
      el("conv", "videoconvert", { src: "sinkA.sink" }),
      el("sinkA", "appsink"),
      el("tee", "tee", { src_0: "q1.sink", src_1: "sinkB.sink" }),
      el("sinkB", "fakesink"),
    ],
  };
  const l = layoutPipeline(p);
  const rank = Object.fromEntries(l.boxes.map((b) => [b.name, b.rank]));
  assertEquals(rank, { src: 0, tee: 0, q1: 1, sinkB: 1, conv: 2, sinkA: 3 });
  assertEquals(l.ranks, 4);
  assertEquals(l.edges.length, 5);
  assertEquals(l.boxes.find((b) => b.name === "q1")!.fill, 1);
  assertEquals(boxLevel(l.boxes.find((b) => b.name === "q1")!, "Playing"), "warn");
});

Deno.test("layoutPipeline: Bausteine als ein Kasten mit Elementzahl, Innenleben ausgeblendet, Schleifen enden", () => {
  const p: NdPipeline = {
    name: "main", state: "Playing",
    elements: [
      el("dec", "uridecodebin", { src_0: "sink.sink" }),
      el("dec-inner1", "typefind", {}, { parent: "dec" }),
      el("dec-inner2", "demux", {}, { parent: "dec" }),
      el("sink", "fakesink"),
    ],
  };
  const l = layoutPipeline(p);
  assertEquals(l.boxes.map((b) => [b.name, b.children]), [["dec", 2], ["sink", 0]]);
  assertEquals(l.edges.map((e) => `${e.from}>${e.to}`), ["dec>sink"]);

  const loop: NdPipeline = { name: "x", state: "Playing", elements: [el("a", "queue", { src: "b.sink" }), el("b", "queue", { src: "a.sink" })] };
  assertEquals(layoutPipeline(loop).boxes.length, 2); // terminiert
});

Deno.test("boxLevel: Element nicht im Zustand der Pipeline ist rot", () => {
  const box = (state: string, fill: number | null = null) => ({ name: "x", factory: "f", state, rank: 0, row: 0, children: 0, fill });
  assertEquals(boxLevel(box("Paused"), "Playing"), "err");
  assertEquals(boxLevel(box("Paused"), "Paused"), "ok");
  assertEquals(boxLevel(box("Playing", 0.4), "Playing"), "ok");
});

Deno.test("formatBytes und splitFindings", () => {
  assertEquals(formatBytes(512 * 1024), "512 KiB");
  assertEquals(formatBytes(300 << 20), "300 MiB");
  assertEquals(formatBytes(3 * (1 << 30)), "3.0 GiB");
  const s = splitFindings([{ id: "a", group: "g", level: "ok", title: "a" }, { id: "b", group: "g", level: "err", title: "b" }]);
  assertEquals([s.problems.length, s.fine.length], [1, 1]);
});
