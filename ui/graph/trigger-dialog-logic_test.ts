import { assertEquals } from "jsr:@std/assert@1";
import type { TriggerKind } from "./process-step-config-logic.ts";
import { applySuggestion, relTime, searchKinds, suggest, valueAt } from "./trigger-dialog-logic.ts";

const K = (label: string, subject: string, group = "alarm"): TriggerKind => ({ id: subject, label, subject, inputFields: [], group });

Deno.test("searchKinds: Wörter UND, Name vor Subject", () => {
  const ks = [K("Host offline", "omp.alarm.host-offline"), K("Aufnahme abgeschlossen", "omp.ingest.*.completed", "ingest"), K("Datei offline", "omp.files.x")];
  assertEquals(searchKinds(ks, "").length, 3);
  assertEquals(searchKinds(ks, "offline").map((k) => k.label), ["Host offline", "Datei offline"]);
  assertEquals(searchKinds(ks, "ingest completed").map((k) => k.label), ["Aufnahme abgeschlossen"]);
  assertEquals(searchKinds(ks, "host-offline")[0].label, "Host offline");
  assertEquals(searchKinds(ks, "zzz"), []);
});

Deno.test("suggest: Felder nach Teilwort, Operatoren nach Operand, Verknüpfung nach Vergleich", () => {
  const fields = ["severity", "message", "detail.code"];
  const a = suggest("input.se", 8, fields, { severity: "critical" });
  assertEquals(a.items[0].label, "input.severity");
  assertEquals(a.items[0].hint, '"critical"');
  assertEquals([a.from, a.to], [0, 8]);
  assertEquals(suggest("", 0, fields).items.length, 4);
  assertEquals(suggest("input.severity ", 15, fields).items[0].label, "==");
  assertEquals(suggest('input.severity == "x" ', 22, fields).items.map((i) => i.label), ["&&", "||"]);
  assertEquals(suggest('input.severity == "x" && ', 25, fields).items.length, 4);
  assertEquals(suggest("input.severity co", 17, fields).items.map((i) => i.label).includes("contains"), true);
});

Deno.test("applySuggestion ersetzt das Teilwort und setzt den Cursor", () => {
  const r = suggest("input.se", 8, ["severity"]);
  assertEquals(applySuggestion("input.se", r, r.items[0]), { text: "input.severity", caret: 14 });
  const r2 = suggest("a == 1 && input.m", 17, ["message"]);
  assertEquals(applySuggestion("a == 1 && input.m", r2, r2.items[0]).text, "a == 1 && input.message");
});

Deno.test("valueAt / relTime", () => {
  assertEquals(valueAt({ a: { b: 3 } }, "a.b"), 3);
  assertEquals(valueAt({ a: 1 }, "a.b"), undefined);
  const now = Date.parse("2026-11-11T12:00:00Z");
  assertEquals(relTime("2026-11-11T11:57:00Z", now, "de"), "vor 3 min");
  assertEquals(relTime("2026-11-11T11:57:00Z", now, "en"), "3 min ago");
  assertEquals(relTime(undefined, now, "de"), "");
});
