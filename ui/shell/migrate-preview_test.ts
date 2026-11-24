import { assertEquals } from "jsr:@std/assert@1";
import { describePreview, transportLabel } from "./migrate-preview-logic.ts";

const tr = (k: string, p?: Record<string, string | number>) => k + (p ? JSON.stringify(p) : "");
const label = (id: string) => (id === "" ? "lokal" : "Host " + id);

Deno.test("keine Brücke: keine Zeilen", () => {
  assertEquals(describePreview({ bridges: [], dissolvedBridges: 0 }, label, tr), []);
});

Deno.test("Brücke mit Rückfall-Transporten", () => {
  const lines = describePreview({
    dissolvedBridges: 0,
    bridges: [{ medium: "video", fromHost: "b", toHost: "a", peers: ["Viewer", "Mischer"], transport: "fabrics", candidates: ["fabrics", "st2110", "srt"] }],
  }, label, tr);
  assertEquals(lines.length, 4);
  assertEquals(lines[0], "mig.intro");
  assertEquals(lines[1], 'mig.bridge{"medium":"mig.video","peers":"Viewer, Mischer","transport":"Fabrics/RDMA","from":"Host b","to":"Host a"}');
  assertEquals(lines[2], 'mig.fallback{"list":"ST 2110, SRT"}');
  assertEquals(lines[3], "mig.note");
});

Deno.test("nur ein Transport: keine Rückfall-Zeile; lokaler Host heißt lokal", () => {
  const lines = describePreview({
    dissolvedBridges: 0,
    bridges: [{ medium: "audio", fromHost: "", toHost: "a", peers: [], transport: "aes67", candidates: ["aes67"] }],
  }, label, tr);
  assertEquals(lines.length, 3);
  assertEquals(lines[1].includes('"from":"lokal"') && lines[1].includes('"peers":"?"'), true);
  assertEquals(transportLabel("unbekannt"), "unbekannt");
});
