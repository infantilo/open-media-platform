import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { domainColor, domainZones, hasNamedDomains, hostChipLabel, hostSummary, instanceDomain, roleDomain, workflowDomainZone } from "./domain-view-logic.ts";

Deno.test("Domain einer Instanz und einer Rolle", () => {
  assertEquals(instanceDomain(undefined), "default");
  assertEquals(instanceDomain({ extraEnv: { OMP_STATE_KEY: "x" } }), "default");
  assertEquals(instanceDomain({ extraEnv: { OMP_MXL_DOMAIN_NAME: "test" } }), "test");
  assertEquals(roleDomain({ domain: "a" }, { domain: "b" }), "a");
  assertEquals(roleDomain({}, { domain: "b" }), "b");
  assertEquals(roleDomain({}, {}), "default");
  assertEquals(roleDomain(undefined, undefined), "default");
});

Deno.test("Workflow-Zone: gemeinsame Domain oder mixed", () => {
  assertEquals(workflowDomainZone([{}, {}], { domain: "x" }), "x");
  assertEquals(workflowDomainZone([{ domain: "a" }, { domain: "a" }], undefined), "a");
  assertEquals(workflowDomainZone([{ domain: "a" }, {}], undefined), "mixed");
  assertEquals(workflowDomainZone([], { domain: "x" }), "x");
  assertEquals(workflowDomainZone(undefined, undefined), "default");
});

Deno.test("Zonen: Standard zuerst, dann Namen, Unbekanntes bleibt sichtbar", () => {
  const known = [{ name: "default", default: true }, { name: "studio", description: "Live" }, { name: "test" }];
  assertEquals(domainZones(known, []).map((z) => z.id), ["default", "studio", "test"]);
  assertEquals(domainZones(known, ["test", "weg", "mixed"]).map((z) => z.id), ["default", "studio", "test", "weg"]);
  const z = domainZones(known, ["weg"]);
  assertEquals(z[1].subtitle, "Live");
  assertEquals(z[3].subtitle, "nicht angelegt");
  assertEquals(domainZones([], []).map((x) => x.id), ["default"]);
});

Deno.test("Farbe: stabil, Standard neutral, verschiedene Namen unterscheiden sich meist", () => {
  assertEquals(domainColor("test"), domainColor("test"));
  assertEquals(domainColor("default"), "#7c8798");
  assertNotEquals(domainColor("studio"), domainColor("test"));
});

Deno.test("hasNamedDomains", () => {
  assertEquals(hasNamedDomains([{ name: "default", default: true }]), false);
  assertEquals(hasNamedDomains([{ name: "default", default: true }, { name: "x" }]), true);
});

Deno.test("Farbe mit Transparenz", () => {
  assertEquals(domainColor("default", 0.1), "rgba(124,135,152,0.1)");
  assertEquals(domainColor("test", 0.1).endsWith("/ 0.1)"), true);
});

Deno.test("Host-Reiter und Zusammenfassung", () => {
  assertEquals(hostChipLabel(undefined, "lokal"), "lokal");
  assertEquals(hostChipLabel("  ", "lokal"), "lokal");
  assertEquals(hostChipLabel("Regie-Host-A", "lokal"), "Regie-Host-A");
  assertEquals(hostChipLabel("Ein-sehr-langer-Hostname-hier", "lokal", 10), "Ein-sehr-…");
  assertEquals(hostSummary(["b", "a", "b", ""]), { count: 2, text: "a, b" });
  assertEquals(hostSummary([]), { count: 0, text: "" });
});

Deno.test("Brücken-Reiter", async () => {
  const { instanceTargetDomain, domainTabText } = await import("./domain-view-logic.ts");
  assertEquals(instanceTargetDomain({ extraEnv: { OMP_MXL_TARGET_DOMAIN_NAME: "b" } }), "b");
  assertEquals(instanceTargetDomain(undefined), "");
  assertEquals(domainTabText("a", "b"), "a → b");
  assertEquals(domainTabText("a", ""), "a");
});
