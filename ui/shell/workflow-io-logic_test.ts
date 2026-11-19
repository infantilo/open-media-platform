import { assertEquals } from "jsr:@std/assert";
import {
  applyExportChoices,
  describeAlertRoute,
  describeBinding,
  type IoExport,
  proposeRoleNames,
  renameRolesInExport,
  validateRoleNames,
} from "./workflow-io-logic.ts";

const exp: IoExport = {
  version: 1,
  name: "Regie 1",
  definition: {
    roles: [{ name: "Regie 1 Mischer", nodeType: "omp-video-mixer-me" }, { name: "Monitor", nodeType: "omp-viewer" }],
    connections: [{ fromRole: "Regie 1 Mischer", toRole: "Monitor" }],
    interface: { outputs: [{ name: "PGM", members: [{ role: "Regie 1 Mischer", port: "Program" }] }] },
  },
  bindings: [{ subject: "operator1", role: "Regie 1 Mischer", verb: "operate" }, { subject: "chef", role: "*", verb: "admin" }],
  alertRules: [{ name: "Ausfall", enabled: true, severities: ["critical"], to: "a@b.de" }],
};

Deno.test("Export-Auswahl beschneidet Bindungen und Alarmregeln", () => {
  assertEquals(applyExportChoices(exp, { bindings: false, alerts: false }).bindings, undefined);
  assertEquals(applyExportChoices(exp, { bindings: false, alerts: false }).alertRules, undefined);
  assertEquals(applyExportChoices(exp, { bindings: true, alerts: false }).bindings?.length, 2);
  assertEquals(applyExportChoices(exp, { bindings: true, alerts: false }).alertRules, undefined);
  assertEquals(applyExportChoices(exp, { bindings: false, alerts: true }).alertRules?.length, 1);
});

Deno.test("Anzeige von Bindung und Alarmregel", () => {
  assertEquals(describeBinding(exp.bindings![0]), "operator1 — Regie 1 Mischer — operate");
  assertEquals(describeBinding(exp.bindings![1]), "chef — ganzer Workflow — admin");
  assertEquals(describeAlertRoute(exp.alertRules![0]), "Ausfall · critical · → a@b.de");
});

Deno.test("Rollennamen: alter Name wird ersetzt, andere bekommen einen Zusatz", () => {
  const m = proposeRoleNames(exp.definition.roles, "Regie 1", "Regie 2", true);
  assertEquals(m["Regie 1 Mischer"], "Regie 2 Mischer");
  assertEquals(m["Monitor"], "Monitor – Regie 2");
});

Deno.test("Ohne Umbenennung bleiben die Namen", () => {
  const m = proposeRoleNames(exp.definition.roles, "Regie 1", "Regie 2", false);
  assertEquals(m["Regie 1 Mischer"], "Regie 1 Mischer");
});

Deno.test("Sonderzeichen im alten Namen brechen die Ersetzung nicht", () => {
  const m = proposeRoleNames([{ name: "A (1) Mischer", nodeType: "x" }], "A (1)", "B", true);
  assertEquals(m["A (1) Mischer"], "B Mischer");
});

Deno.test("Namenprüfung: leer und doppelt werden erkannt", () => {
  assertEquals(validateRoleNames({ a: "x", b: "y" }), null);
  assertEquals(validateRoleNames({ a: "x", b: "x" }), "duplicate");
  assertEquals(validateRoleNames({ a: " ", b: "y" }), "empty");
});

Deno.test("Umbenennen zieht Verbindungen, Schnittstelle und Bindungen mit", () => {
  const m = proposeRoleNames(exp.definition.roles, "Regie 1", "Regie 2", true);
  const out = renameRolesInExport(exp, m);
  assertEquals(out.definition.roles.map((r) => r.name), ["Regie 2 Mischer", "Monitor – Regie 2"]);
  assertEquals(out.definition.connections[0].fromRole, "Regie 2 Mischer");
  assertEquals(out.definition.connections[0].toRole, "Monitor – Regie 2");
  assertEquals(out.definition.interface?.outputs?.[0].members[0].role, "Regie 2 Mischer");
  assertEquals(out.bindings![0].role, "Regie 2 Mischer");
  assertEquals(out.bindings![1].role, "*"); // „ganzer Workflow“ bleibt
});
