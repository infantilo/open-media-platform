import { assertEquals } from "jsr:@std/assert";
import { hostLabel, isBusy, type DistRow, rowsFor, selectableHosts, summary } from "./catalog-hosts-logic.ts";

const row = (o: Partial<DistRow>): DistRow => ({
  type: "svc", version: "1", hostId: "h1", desired: "present", state: "ok", attempts: 0, updatedAt: "", ...o,
});

Deno.test("rowsFor trennt Typ und Version", () => {
  const rows = [row({}), row({ version: "2" }), row({ type: "other" })];
  assertEquals(rowsFor(rows, "svc", "1").length, 1);
  assertEquals(rowsFor(rows, "svc", undefined).length, 0);
});

Deno.test("isBusy: nur beendete Zustände lassen das Nachladen ruhen", () => {
  assertEquals(isBusy([row({ state: "ok" }), row({ state: "failed", hostId: "h2" })]), false);
  for (const s of ["pending", "installing", "removing", "offline"] as const) assertEquals(isBusy([row({ state: s })]), true, s);
});

Deno.test("selectableHosts blendet Hosts mit Installation aus, Rückzug macht wieder wählbar", () => {
  const hosts = [{ id: "h1", label: "A" }, { id: "h2", label: "B" }];
  assertEquals(selectableHosts(hosts, [row({})]).map((h) => h.id), ["h2"]);
  assertEquals(selectableHosts(hosts, [row({ desired: "absent", state: "removing" })]).map((h) => h.id), ["h1", "h2"]);
});

Deno.test("summary zählt nur Soll „installiert“", () => {
  const s = summary([row({}), row({ hostId: "h2", state: "failed" }), row({ hostId: "h3", desired: "absent", state: "removing" })]);
  assertEquals(s, { ok: 1, total: 2, failed: 1 });
});

Deno.test("hostLabel fällt auf die ID zurück", () => {
  assertEquals(hostLabel([{ id: "h1", label: "Rack 1" }], "h1"), "Rack 1");
  assertEquals(hostLabel([], "h9"), "h9");
});
