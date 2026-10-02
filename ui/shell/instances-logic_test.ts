import { assertEquals } from "jsr:@std/assert";
import { defaultDir, sortInstances, type SortableInstance } from "./instances-logic.ts";

const mk = (id: string, label: string, o: Partial<SortableInstance> = {}): SortableInstance => ({ id, label, pid: 1, ...o });
const ids = (l: SortableInstance[]) => l.map((i) => i.id).join(",");

Deno.test("CPU absteigend, fehlende Messwerte immer am Ende", () => {
  const l = [mk("a", "A", { cpuPercent: 5 }), mk("b", "B"), mk("c", "C", { cpuPercent: 40 })];
  assertEquals(ids(sortInstances(l, "cpu", "desc")), "c,a,b");
  assertEquals(ids(sortInstances(l, "cpu", "asc")), "a,c,b");
});

Deno.test("RAM, PID, Neustarts numerisch", () => {
  const l = [mk("a", "A", { rssBytes: 9, pid: 30, restartCount: 2 }), mk("b", "B", { rssBytes: 100, pid: 5 })];
  assertEquals(ids(sortInstances(l, "ram", "desc")), "b,a");
  assertEquals(ids(sortInstances(l, "pid", "asc")), "b,a");
  assertEquals(ids(sortInstances(l, "restarts", "desc")), "a,b");
});

Deno.test("Label ohne Groß-/Kleinschreibung, Gleichstand stabil über ID", () => {
  const l = [mk("2", "b"), mk("1", "B"), mk("3", "a")];
  assertEquals(ids(sortInstances(l, "label", "asc")), "3,1,2");
});

Deno.test("Status: abgestürzt vor veraltet vor läuft; Host über Anzeigename", () => {
  const l = [mk("ok", "x"), mk("old", "x", { outdated: true }), mk("bad", "x", { crashed: true })];
  assertEquals(ids(sortInstances(l, "status", "asc")), "bad,old,ok");
  const h = [mk("1", "a", { hostId: "h2" }), mk("2", "b"), mk("3", "c", { hostId: "h1" })];
  const names: Record<string, string> = { h1: "Regie-A", h2: "Regie-B" };
  assertEquals(ids(sortInstances(h, "host", "asc", (i) => (i.hostId ? names[i.hostId] : "lokal"))), "2,3,1");
});

Deno.test("Standardrichtung: Last absteigend, Text aufsteigend", () => {
  assertEquals(defaultDir("cpu"), "desc");
  assertEquals(defaultDir("label"), "asc");
});
