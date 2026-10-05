import { assertEquals } from "jsr:@std/assert";
import { demandText, groupByHost, type HostEstimate, hostSeverity, loadText, overallSeverity, type RolePlan, type StartPlan } from "./workflow-plan-logic.ts";

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
