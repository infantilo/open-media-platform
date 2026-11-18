import { assertEquals } from "jsr:@std/assert@1";
import { formatName, humanSize, matchesFlow } from "./mxl-flows-panel.ts";

const row = {
  id: "11111111-aaaa", label: "Kamera 1", format: "urn:x-nmos:format:video", active: true, stale: false, sizeBytes: 5,
  writers: [{ pid: 4242, cmd: "omp-source", container: "abc123def456" }], instanceLabel: "Quelle A",
};

Deno.test("formatName / humanSize", () => {
  assertEquals(formatName("urn:x-nmos:format:audio"), "audio");
  assertEquals(formatName(undefined), "–");
  assertEquals(humanSize(10), "1 kB");
  assertEquals(humanSize(3 * (1 << 20)), "3.0 MB");
});

Deno.test("matchesFlow: mehrere Wörter, PID, Container, Node", () => {
  assertEquals(matchesFlow(row, ""), true);
  assertEquals(matchesFlow(row, "kamera video"), true);
  assertEquals(matchesFlow(row, "4242"), true);
  assertEquals(matchesFlow(row, "abc123"), true);
  assertEquals(matchesFlow(row, "quelle"), true);
  assertEquals(matchesFlow(row, "kamera audio"), false);
});
