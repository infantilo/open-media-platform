import { assertEquals } from "jsr:@std/assert";
import { classify, docPath, type ErrorCode, lookup } from "./errorcodes-logic.ts";
import catalogFixture from "./testdata/errorcodes.json" with { type: "json" };
import samplesFixture from "./testdata/errorcode-samples.json" with { type: "json" };

const E = (code: string, match: string | undefined, severity: ErrorCode["severity"] = "error"): ErrorCode => ({
  code, severity, title: code, cause: "c", steps: ["s"], match, doc: `FEHLERCODES.md#${code.toLowerCase()}`,
});
const list = [
  E("OMP-1001", "db: ping|failed to connect to .?user="),
  E("OMP-2002", "podman run|trying to pull"),
  E("OMP-2004", "signal: (killed|segmentation)|crash loop detected"),
  E("OMP-2001", "node proxy call failed|connect: connection refused"),
  E("OMP-3005", "no such device|v4l2"),
  E("OMP-9000", undefined),
  E("OMP-9001", "([unbalanciert"), // nicht portables Muster darf nichts kaputt machen
];

Deno.test("classify: erstes passendes Muster, Groß-/Kleinschreibung egal", () => {
  assertEquals(classify(list, "Signal: KILLED")?.code, "OMP-2004");
  assertEquals(classify(list, "dial tcp 127.0.0.1:1: connect: connection refused")?.code, "OMP-2001");
  // spezifischer Eintrag vor dem allgemeinen (Reihenfolge des Katalogs)
  assertEquals(classify(list, "db: ping: failed: connect: connection refused")?.code, "OMP-1001");
  assertEquals(classify(list, "podman run x: exit status 125")?.code, "OMP-2002");
  assertEquals(classify(list, "alles gut"), undefined);
});

Deno.test("classify: Code in der Meldung schlägt jedes Muster; unbekannter Code nicht", () => {
  assertEquals(classify(list, "[OMP-3005] connection refused by device")?.code, "OMP-3005");
  assertEquals(classify(list, "[OMP-9999] connect: connection refused")?.code, "OMP-2001");
  assertEquals(classify(list, "[OMP-9000] nur über den Code erreichbar")?.code, "OMP-9000");
});

Deno.test("lookup und docPath", () => {
  assertEquals(lookup(list, "omp-2004")?.code, "OMP-2004");
  assertEquals(lookup(list, undefined), undefined);
  assertEquals(lookup(list, "OMP-0000"), undefined);
  assertEquals(docPath(list[0]), "docs/FEHLERCODES.md#omp-1001");
});

// Gemeinsamer Prüfstand mit Go: derselbe Katalog (aus dem Server erzeugt) und dieselben Beispielmeldungen. Läuft ein Muster im
// Browser anders als in Go (RE2), fällt es hier auf.
Deno.test("Katalog des Servers: jedes Beispiel ergibt im Browser denselben Code wie in Go", () => {
  const catalog = catalogFixture as ErrorCode[];
  const fx = samplesFixture as { samples: { message: string; code: string }[]; harmless: string[] };
  for (const s of catalog) {
    if (s.match) new RegExp(s.match, "i"); // wirft bei einem nicht portablen Muster
  }
  for (const s of fx.samples) assertEquals(classify(catalog, s.message)?.code, s.code, s.message);
  for (const h of fx.harmless) assertEquals(classify(catalog, h), undefined, h);
});
