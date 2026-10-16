import { assertEquals } from "jsr:@std/assert";
import { buildQuery, categoryOfPath, CATEGORIES, DEFAULT_CATEGORIES, describe, outcome, searchTerms } from "./audit-logic.ts";

const res = {
  node: (id: string) => (id === "uuid-1" ? "Kamera 1" : undefined),
  workflow: (id: string) => (id === "w1" ? "Studio" : undefined),
  process: () => undefined,
  instance: () => undefined,
  group: () => undefined,
};
const tr = (k: string) => ({ "aud.m.crosspoint.take": "Take", "aud.cw.setGain": "Pegel" } as Record<string, string>)[k];

Deno.test("describe: Workflow-Start mit aufgelöstem Namen", () => {
  const d = describe({ method: "POST", path: "/api/v1/workflows/w1/start" }, res, tr);
  assertEquals([d.category, d.key, d.params.p0], ["workflows", "aud.a.wfStart", "Studio"]);
});

Deno.test("describe: unbekannte ID wird gekürzt, nicht leer", () => {
  const d = describe({ method: "POST", path: "/api/v1/workflows/0123456789abcdef0123/stop" }, res, tr);
  assertEquals(d.params.p0, "01234567…");
});

Deno.test("describe: Node-Methode mit Klartextnamen und Kanal-Methode", () => {
  const a = describe({ method: "POST", path: "/api/v1/nodes/uuid-1/methods/crosspoint.take" }, res, tr);
  assertEquals([a.category, a.params.p0, a.params.p1], ["operate", "Kamera 1", "Take"]);
  const b = describe({ method: "POST", path: "/api/v1/nodes/uuid-1/methods/channel.ch2.setGain" }, res, tr);
  assertEquals(b.params.p1, "ch2: Pegel");
});

Deno.test("describe: unbekannte Route -> Kategorie über Pfad, kein Schlüssel", () => {
  const d = describe({ method: "POST", path: "/api/v1/process-foo/bar" }, res, tr);
  assertEquals([d.key, d.category], ["", "processes"]);
});

Deno.test("categoryOfPath", () => {
  assertEquals(categoryOfPath("/api/v1/auth/login"), "login");
  assertEquals(categoryOfPath("/api/v1/admin/role-bindings/x"), "rights");
  assertEquals(categoryOfPath("/api/v1/admin/hosts/h/maintenance"), "instances");
  assertEquals(categoryOfPath("/api/v1/nodes/n/params/gain"), "operate");
  assertEquals(categoryOfPath("/api/v1/layouts/default"), "layout");
  assertEquals(categoryOfPath("/api/v1/unbekannt"), "other");
});

Deno.test("outcome", () => {
  assertEquals(outcome(200), { key: "aud.res.ok", ok: true });
  assertEquals(outcome(403), { key: "aud.res.403", ok: false });
  assertEquals(outcome(503), { key: "aud.res.5xx", ok: false });
});

Deno.test("buildQuery: Standardansicht schließt nur Bedienung aus", () => {
  const q = new URLSearchParams(buildQuery({ limit: 50, range: "all", categories: new Set(DEFAULT_CATEGORIES), terms: [] }));
  const ex = (q.get("exclude") ?? "").split("\x1f");
  assertEquals(ex.includes("/api/v1/nodes/%/methods/%"), true);
  assertEquals(ex.length, ["operate", "layout"].flatMap((id) => CATEGORIES.find((c) => c.id === id)!.likes).length);
  assertEquals(q.get("since"), null);
});

Deno.test("buildQuery: alle Kategorien -> kein exclude; Nutzer, Ergebnis, Begriffe", () => {
  const q = new URLSearchParams(buildQuery({ limit: 50, before: 9, user: "anna", result: "failed", range: "24h", categories: new Set(CATEGORIES.map((c) => c.id)), terms: ["Kamera", "uuid-1"] }));
  assertEquals([q.get("exclude"), q.get("user"), q.get("result"), q.get("before"), q.get("terms")], [null, "anna", "failed", "9", "Kamera\x1fuuid-1"]);
  assertEquals(q.has("since"), true);
});

Deno.test("searchTerms: Text plus IDs passender Namen", () => {
  assertEquals(searchTerms(" kam ", [{ id: "uuid-1", name: "Kamera 1" }, { id: "x", name: "Viewer" }]), ["kam", "uuid-1"]);
  assertEquals(searchTerms("  ", []), []);
});
