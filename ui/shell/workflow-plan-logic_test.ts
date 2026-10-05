import { assertEquals } from "jsr:@std/assert";
import { demandText, ghostEntriesForZone, groupByHost, plannedZoneIds, zoneForStoppedWorkflow, type PlanInput, type HostEstimate, hostSeverity, loadText, overallSeverity, type RolePlan, type StartPlan } from "./workflow-plan-logic.ts";

const host = (over: Partial<HostEstimate> = {}): HostEstimate => ({
  hostId: "h1", label: "Host A", online: true, hasMetrics: true, cpuNow: 20, memNow: 30, cpuProjected: 40, memProjected: 40, cpuLimit: 85, memLimit: 90, ...over,
});
const role = (over: Partial<RolePlan> = {}): RolePlan => ({
  role: "A", nodeType: "omp-channel-player", plannedHostId: "h1", plannedHostLabel: "Host A", fixed: false, cpuPercent: 30, ramBytes: 512 * 1024 ** 2, profileKnown: true, ...over,
});

Deno.test("Ampel: ok, knapp, Engpass, offline, ohne Messwerte", () => {
  assertEquals(hostSeverity(host(), false), "ok");
  assertEquals(hostSeverity(host({ cpuProjected: 70 }), false), "warn");
  assertEquals(hostSeverity(host({ over: ["CPU 90 %"] }), false), "bad");
  assertEquals(hostSeverity(host({ online: false }), false), "bad");
  assertEquals(hostSeverity(host({ hasMetrics: false }), false), "unknown");
  // Lokaler Host ohne Agent-Messwerte ist kein Problem.
  assertEquals(hostSeverity(host({ hostId: "", hasMetrics: false }), false), "ok");
  // Läuft der Workflow schon, ist die Prognose kein Warnsignal mehr.
  assertEquals(hostSeverity(host({ over: ["CPU 90 %"], cpuProjected: 90 }), true), "ok");
});

Deno.test("Rollen werden je Host gruppiert, Gesamtzustand ist der schlimmste", () => {
  const plan: StartPlan = {
    workflowId: "w", running: false, warnings: [],
    hosts: [host(), host({ hostId: "", label: "Orchestrator-Host (lokal)", hasMetrics: false }), host({ hostId: "h2", label: "Host B", over: ["CPU 99 %"] })],
    roles: [role(), role({ role: "B" }), role({ role: "M", plannedHostId: "" }), role({ role: "X", plannedHostId: "h2" })],
  };
  const g = groupByHost(plan);
  assertEquals(g.map((x) => x.roles.map((r) => r.role)), [["A", "B"], ["M"], ["X"]]);
  assertEquals(overallSeverity(plan), "bad");
  assertEquals(overallSeverity({ ...plan, hosts: [host()], roles: [role()] }), "ok");
});

Deno.test("Texte: Bedarf bekannt/unbekannt, Auslastung jetzt und mit Workflow", () => {
  assertEquals(demandText(role()), "~30 % CPU · 512 MB");
  assertEquals(demandText(role({ profileKnown: false })), "Bedarf unbekannt");
  assertEquals(demandText(role({ ramBytes: 2.5 * 1024 ** 3 })), "~30 % CPU · 2.5 GB");
  assertEquals(loadText(host(), false), "CPU 20 % · RAM 30 % → CPU 40 % · RAM 40 %");
  assertEquals(loadText(host(), true), "jetzt CPU 20 % · RAM 30 %");
  assertEquals(loadText(host({ hasMetrics: false }), false), "keine Messwerte");
});

const planOf = (roles: [string, string][]): StartPlan => ({
  workflowId: "w", running: false, warnings: [], hosts: [],
  roles: roles.map(([r, h]) => role({ role: r, plannedHostId: h })),
});

Deno.test("Nicht gestartete Workflows: Zone aus Plan, bei mehreren Hosts gemischt", () => {
  const single: PlanInput = { name: "S", hasRuntime: false, plan: planOf([["A", "h1"], ["B", "h1"]]), roles: [] };
  assertEquals(zoneForStoppedWorkflow(single), "h1");
  const local: PlanInput = { name: "L", hasRuntime: false, plan: planOf([["A", ""], ["B", ""]]), roles: [] };
  assertEquals(zoneForStoppedWorkflow(local), "local");
  const multi: PlanInput = { name: "M", hasRuntime: false, plan: planOf([["A", "h1"], ["B", ""], ["C", "h2"]]), roles: [] };
  assertEquals(zoneForStoppedWorkflow(multi), "mixed");
  assertEquals(plannedZoneIds(multi).sort(), ["h1", "h2", "local"]);
  // Ohne Plan zählen nur ausdrücklich festgelegte Hosts der Rollen.
  const noPlan: PlanInput = { name: "N", hasRuntime: false, roles: [{ name: "A", hostId: "h1" }, { name: "B" }] };
  assertEquals(zoneForStoppedWorkflow(noPlan), "mixed");
  assertEquals(zoneForStoppedWorkflow({ name: "E", hasRuntime: false, roles: [] }), "local");
});

Deno.test("Geplant-Einträge je Zone nur für Workflows über mehrere Zonen ohne Runtime", () => {
  const multi: PlanInput = { name: "M", hasRuntime: false, plan: planOf([["A", "h1"], ["B", ""], ["C", "h1"]]), roles: [] };
  const single: PlanInput = { name: "S", hasRuntime: false, plan: planOf([["X", "h1"]]), roles: [] };
  const running: PlanInput = { name: "R", hasRuntime: true, plan: planOf([["Y", "h1"], ["Z", "h2"]]), roles: [] };
  assertEquals(ghostEntriesForZone("h1", [multi, single, running]), [{ workflow: "M", roles: ["A", "C"] }]);
  assertEquals(ghostEntriesForZone("local", [multi, single, running]), [{ workflow: "M", roles: ["B"] }]);
  assertEquals(ghostEntriesForZone("h2", [multi, single, running]), []);
});
