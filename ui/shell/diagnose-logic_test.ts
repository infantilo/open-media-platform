import { assertEquals } from "jsr:@std/assert";
import { buildLogQuery, explain, relativeTime } from "./diagnose-logic.ts";

Deno.test("explain: bekannte Meldungen mit Parameter", () => {
  assertEquals(explain('node proxy call failed (GET /params/previewUrl): Get "http://x"'), { id: "proxyParam", param: "previewUrl" });
  assertEquals(explain("is05 PatchSenderStaged failed (node may not implement…): 404")?.id, "is05sender");
  assertEquals(explain("etwas ganz anderes"), undefined);
});

Deno.test("relativeTime", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  assertEquals(relativeTime("2026-10-16T11:59:40Z", now), ["dg.ago.now", 0]);
  assertEquals(relativeTime("2026-10-16T11:30:00Z", now), ["dg.ago.min", 30]);
  assertEquals(relativeTime("2026-10-16T09:00:00Z", now), ["dg.ago.h", 3]);
  assertEquals(relativeTime("2026-10-13T12:00:00Z", now), ["dg.ago.d", 3]);
});

Deno.test("buildLogQuery: Stufen nur bei Teilauswahl, Filter gesetzt", () => {
  const all = new URLSearchParams(buildLogQuery({ levels: new Set(["error", "warn", "info"]), range: "all", text: "", nodeId: "", traceId: "", msgKey: "" }));
  assertEquals([all.has("level"), all.has("since")], [false, false]);
  const q = new URLSearchParams(buildLogQuery({ levels: new Set(["warn", "error"]), range: "24h", text: " proxy ", nodeId: "n1", traceId: "t", msgKey: "k", limit: 50, before: 7 }));
  assertEquals([q.get("level"), q.get("q"), q.get("nodeId"), q.get("traceId"), q.get("msgKey"), q.get("limit"), q.get("before"), q.has("since")], ["error,warn", "proxy", "n1", "t", "k", "50", "7", true]);
});
