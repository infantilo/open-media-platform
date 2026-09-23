import { assertEquals } from "jsr:@std/assert@1";
import type { DraftDefinition } from "./process-editor-logic.ts";
import {
  ancestorsOf,
  branchLabelsFor,
  flatStringObject,
  formatGoDuration,
  insertionText,
  missingConfig,
  parseGoDuration,
  parseRule,
  ruleToExpression,
  splitSeconds,
  toSeconds,
  triggerKinds,
  variableOptions,
} from "./process-step-config-logic.ts";

const def: DraftDefinition = {
  startStepId: "probe",
  steps: [
    { id: "probe", type: "script", next: ["check"] },
    { id: "check", type: "condition", branches: { true: "ok-path", false: "review" } },
    { id: "review", type: "approval", branches: { approved: "ok-path" } },
    { id: "ok-path", type: "service_call" },
    { id: "unrelated", type: "wait" },
  ],
};

Deno.test("ancestorsOf follows next+branches backwards, in graph order, excluding self and unrelated steps", () => {
  assertEquals(ancestorsOf(def, "ok-path"), ["probe", "check", "review"]);
  assertEquals(ancestorsOf(def, "probe"), []);
  assertEquals(ancestorsOf(def, "unrelated"), []);
});

Deno.test("variableOptions offers trigger input, upstream outputs (bracket syntax for non-identifier ids) and workflow meta", () => {
  const opts = variableOptions(def, "ok-path", [{ path: "assetId", label: "Asset-ID" }]);
  const paths = opts.map((o) => o.path);
  assertEquals(paths.includes("input.assetId"), true);
  assertEquals(paths.includes("outputs.probe.stdout"), true);
  assertEquals(paths.includes("outputs.review.decision"), true);
  assertEquals(paths.includes("workflow.executionId"), true);
  assertEquals(paths.some((p) => p.startsWith("outputs.unrelated")), false);
  const d2: DraftDefinition = { startStepId: "a-b", steps: [{ id: "a-b", type: "script", next: ["c"] }, { id: "c", type: "wait" }] };
  assertEquals(variableOptions(d2, "c", []).some((o) => o.path === 'outputs["a-b"].exitCode'), true);
  assertEquals(insertionText("input.x", "template"), "${input.x}");
  assertEquals(insertionText("input.x", "expression"), "input.x");
});

Deno.test("rule builder round-trips and quotes strings, leaves free expressions alone", () => {
  const e = ruleToExpression({ variable: "outputs.review.decision", op: "==", value: "approved" });
  assertEquals(e, 'outputs.review.decision == "approved"');
  assertEquals(parseRule(e), { variable: "outputs.review.decision", op: "==", value: "approved" });
  assertEquals(ruleToExpression({ variable: "outputs.probe.exitCode", op: ">=", value: "1" }), "outputs.probe.exitCode >= 1");
  assertEquals(parseRule("outputs.probe.exitCode >= 1"), { variable: "outputs.probe.exitCode", op: ">=", value: "1" });
  assertEquals(parseRule('input.title contains "News"'), { variable: "input.title", op: "contains", value: "News" });
  assertEquals(parseRule("a > 1 && b < 2"), null);
  assertEquals(parseRule("len(input.x) > 3"), null);
});

Deno.test("branchLabelsFor returns the labels the step really produces", () => {
  assertEquals(branchLabelsFor({ id: "c", type: "condition" }), ["true", "false"]);
  assertEquals(branchLabelsFor({ id: "c", type: "condition", config: { trueLabel: "ok", falseLabel: "nok" } }), ["ok", "nok"]);
  assertEquals(
    branchLabelsFor({ id: "b", type: "branch", config: { cases: [{ label: "hd" }, { label: "sd" }], defaultLabel: "other" } }),
    ["hd", "sd", "other"],
  );
  assertEquals(branchLabelsFor({ id: "a", type: "approval" }), ["approved", "rejected", "changes_requested"]);
  assertEquals(branchLabelsFor({ id: "w", type: "wait" }), []);
});

Deno.test("durations: seconds split/join and Go duration strings", () => {
  assertEquals(splitSeconds(120), { value: "2", unit: "m" });
  assertEquals(splitSeconds(90), { value: "90", unit: "s" });
  assertEquals(splitSeconds(7200), { value: "2", unit: "h" });
  assertEquals(toSeconds("1,5", "m"), 90);
  assertEquals(toSeconds("", "s"), undefined);
  assertEquals(toSeconds("x", "s"), null);
  assertEquals(parseGoDuration("1m30s"), 90);
  assertEquals(parseGoDuration("500ms"), null);
  assertEquals(formatGoDuration(90), "1m30s");
  assertEquals(formatGoDuration(3600), "1h");
});

Deno.test("flatStringObject only accepts flat string maps", () => {
  assertEquals(flatStringObject({ a: "1" }), [["a", "1"]]);
  assertEquals(flatStringObject(undefined), []);
  assertEquals(flatStringObject({ a: 1 }), null);
  assertEquals(flatStringObject([1]), null);
});

Deno.test("missingConfig mirrors the executors' required fields", () => {
  assertEquals(missingConfig({ id: "s", type: "service_call" }), "Adresse (URL) fehlt");
  assertEquals(missingConfig({ id: "s", type: "service_call", config: { url: "http://x" } }), null);
  assertEquals(missingConfig({ id: "m", type: "media_function", config: { instanceId: "i" } }), "Node/Funktion fehlt");
  assertEquals(missingConfig({ id: "p", type: "parallel" }), null);
});

Deno.test("triggerKinds maps asset events to subjects with a wildcard asset id", () => {
  const kinds = triggerKinds(["ready"], (s) => s.toUpperCase());
  const ready = kinds.find((k) => k.id === "asset.status.ready")!;
  assertEquals(ready.subject, "omp.asset.*.ready");
  assertEquals(ready.label, "Asset wechselt auf „READY“");
  assertEquals(kinds[0].subject, "omp.asset.*.created");
});
