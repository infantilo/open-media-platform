import { assertEquals } from "jsr:@std/assert@1";
import {
  addBranchConnection,
  addNextConnection,
  addStep,
  type DraftDefinition,
  removeBranchConnection,
  removeNextConnection,
  removeStep,
  renameStepId,
  setCompensationStep,
  setStartStep,
  uniqueStepId,
  updateStepFields,
} from "./process-editor-logic.ts";

function empty(): DraftDefinition {
  return { steps: [], startStepId: "" };
}

Deno.test("uniqueStepId returns the bare type when unused", () => {
  assertEquals(uniqueStepId("wait", new Set()), "wait");
});

Deno.test("uniqueStepId appends an increasing suffix on collision", () => {
  assertEquals(uniqueStepId("wait", new Set(["wait"])), "wait_2");
  assertEquals(uniqueStepId("wait", new Set(["wait", "wait_2"])), "wait_3");
});

Deno.test("addStep appends the step and sets it as start when the definition was empty", () => {
  const def = addStep(empty(), "a", "wait");
  assertEquals(def.steps.length, 1);
  assertEquals(def.startStepId, "a");
});

Deno.test("addStep does not override an existing start step", () => {
  let def = addStep(empty(), "a", "wait");
  def = addStep(def, "b", "task");
  assertEquals(def.startStepId, "a");
  assertEquals(def.steps.length, 2);
});

Deno.test("removeStep drops the step and cleans up next/branches/compensationStepId references", () => {
  let def = addStep(empty(), "a", "condition");
  def = addStep(def, "b", "task");
  def = addStep(def, "c", "compensation");
  def = addNextConnection(def, "a", "b").def;
  def = addBranchConnection(def, "a", "valid", "b").def;
  def = setCompensationStep(def, "b", "c");

  def = removeStep(def, "b");

  assertEquals(def.steps.map((s) => s.id), ["a", "c"]);
  const a = def.steps.find((s) => s.id === "a")!;
  assertEquals(a.next, []);
  assertEquals(a.branches, {});
});

Deno.test("removeStep clears startStepId when the start step itself is removed", () => {
  const def = removeStep(addStep(empty(), "a", "wait"), "a");
  assertEquals(def.startStepId, "");
  assertEquals(def.steps.length, 0);
});

Deno.test("renameStepId updates the id and every next/branches/compensationStepId/startStepId reference", () => {
  let def = addStep(empty(), "a", "condition");
  def = addStep(def, "b", "task");
  def = addNextConnection(def, "a", "b").def;
  def = addBranchConnection(def, "a", "valid", "b").def;
  def = setCompensationStep(def, "a", "b");

  const result = renameStepId(def, "b", "b2");
  assertEquals(result.ok, true);
  const a = result.def.steps.find((s) => s.id === "a")!;
  assertEquals(a.next, ["b2"]);
  assertEquals(a.branches, { valid: "b2" });
  assertEquals(a.compensationStepId, "b2");
  assertEquals(result.def.steps.some((s) => s.id === "b2"), true);
});

Deno.test("renameStepId updates startStepId when the start step is renamed", () => {
  const def = addStep(empty(), "a", "wait");
  const result = renameStepId(def, "a", "start");
  assertEquals(result.ok, true);
  assertEquals(result.def.startStepId, "start");
});

Deno.test("renameStepId rejects an empty or duplicate id", () => {
  let def = addStep(empty(), "a", "wait");
  def = addStep(def, "b", "wait");
  assertEquals(renameStepId(def, "a", "").ok, false);
  assertEquals(renameStepId(def, "a", "b").ok, false);
  assertEquals(renameStepId(def, "a", "a").ok, false);
  assertEquals(renameStepId(def, "unknown", "x").ok, false);
});

Deno.test("addNextConnection rejects self-loops and exact duplicates", () => {
  let def = addStep(empty(), "a", "wait");
  def = addStep(def, "b", "wait");

  assertEquals(addNextConnection(def, "a", "a").ok, false);

  const first = addNextConnection(def, "a", "b");
  assertEquals(first.ok, true);
  assertEquals(first.def.steps.find((s) => s.id === "a")!.next, ["b"]);

  const dup = addNextConnection(first.def, "a", "b");
  assertEquals(dup.ok, false);
});

Deno.test("removeNextConnection removes exactly the targeted edge", () => {
  let def = addStep(empty(), "a", "wait");
  def = addStep(def, "b", "wait");
  def = addStep(def, "c", "wait");
  def = addNextConnection(def, "a", "b").def;
  def = addNextConnection(def, "a", "c").def;

  def = removeNextConnection(def, "a", "b");
  assertEquals(def.steps.find((s) => s.id === "a")!.next, ["c"]);
});

Deno.test("addBranchConnection rejects empty label and self-loops, allows overwriting the same label", () => {
  let def = addStep(empty(), "a", "condition");
  def = addStep(def, "b", "task");
  def = addStep(def, "c", "task");

  assertEquals(addBranchConnection(def, "a", "", "b").ok, false);
  assertEquals(addBranchConnection(def, "a", "valid", "a").ok, false);

  const first = addBranchConnection(def, "a", "valid", "b");
  assertEquals(first.ok, true);
  assertEquals(first.def.steps.find((s) => s.id === "a")!.branches, { valid: "b" });

  const overwritten = addBranchConnection(first.def, "a", "valid", "c");
  assertEquals(overwritten.ok, true);
  assertEquals(overwritten.def.steps.find((s) => s.id === "a")!.branches, { valid: "c" });
});

Deno.test("removeBranchConnection removes exactly the targeted label", () => {
  let def = addStep(empty(), "a", "condition");
  def = addStep(def, "b", "task");
  def = addBranchConnection(def, "a", "valid", "b").def;
  def = addBranchConnection(def, "a", "invalid", "b").def;

  def = removeBranchConnection(def, "a", "valid");
  assertEquals(def.steps.find((s) => s.id === "a")!.branches, { invalid: "b" });
});

Deno.test("setStartStep only accepts an id that actually exists", () => {
  let def = addStep(empty(), "a", "wait");
  def = addStep(def, "b", "wait");

  const changed = setStartStep(def, "b");
  assertEquals(changed.startStepId, "b");

  const unchanged = setStartStep(def, "does-not-exist");
  assertEquals(unchanged.startStepId, "a");
});

Deno.test("setCompensationStep sets and clears compensationStepId", () => {
  let def = addStep(empty(), "a", "task");
  def = addStep(def, "rollback", "compensation");

  def = setCompensationStep(def, "a", "rollback");
  assertEquals(def.steps.find((s) => s.id === "a")!.compensationStepId, "rollback");

  def = setCompensationStep(def, "a", undefined);
  assertEquals(def.steps.find((s) => s.id === "a")!.compensationStepId, undefined);
});

Deno.test("updateStepFields merges only the given fields, leaving graph edges untouched", () => {
  let def = addStep(empty(), "a", "wait");
  def = addStep(def, "b", "wait");
  def = addNextConnection(def, "a", "b").def;

  def = updateStepFields(def, "a", { name: "Wait a bit", timeoutSeconds: 30 });
  const a = def.steps.find((s) => s.id === "a")!;
  assertEquals(a.name, "Wait a bit");
  assertEquals(a.timeoutSeconds, 30);
  assertEquals(a.next, ["b"]);
});

Deno.test("graph edits preserve pass-through triggers (editing an existing version must not drop them)", () => {
  const triggers = [{ subject: "omp.asset.created" }];
  let def: DraftDefinition = { steps: [{ id: "a", type: "wait" }], startStepId: "a", triggers };
  def = addStep(def, "b", "wait");
  def = renameStepId(def, "b", "c").def;
  def = removeStep(def, "c");
  assertEquals(def.triggers, triggers);
});
