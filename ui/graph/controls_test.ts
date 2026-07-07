import { assertEquals } from "jsr:@std/assert@1";
import { controlKindFor, enumValues, numberRange, type ParamSpec } from "./controls.ts";

function param(overrides: Partial<ParamSpec>): ParamSpec {
  return { name: "p", type: "number", readonly: false, ...overrides };
}

Deno.test("controlKindFor maps number to slider", () => {
  assertEquals(controlKindFor(param({ type: "number" })), "slider");
});

Deno.test("controlKindFor maps boolean to toggle", () => {
  assertEquals(controlKindFor(param({ type: "boolean" })), "toggle");
});

Deno.test("controlKindFor maps enum to select", () => {
  assertEquals(controlKindFor(param({ type: "enum" })), "select");
});

Deno.test("controlKindFor maps string to text", () => {
  assertEquals(controlKindFor(param({ type: "string" })), "text");
});

Deno.test("controlKindFor maps unknown type to readonly", () => {
  assertEquals(controlKindFor(param({ type: "something-future" })), "readonly");
});

Deno.test("controlKindFor readonly overrides type", () => {
  assertEquals(controlKindFor(param({ type: "number", readonly: true })), "readonly");
  assertEquals(controlKindFor(param({ type: "enum", readonly: true })), "readonly");
});

Deno.test("numberRange extracts min/max", () => {
  const p = param({ type: "number", range: { min: -96, max: 12 } });
  assertEquals(numberRange(p), { min: -96, max: 12 });
});

Deno.test("numberRange returns null when range is an enum range", () => {
  const p = param({ type: "enum", range: { values: ["a", "b"] } });
  assertEquals(numberRange(p), null);
});

Deno.test("numberRange returns null when range is absent", () => {
  assertEquals(numberRange(param({ range: null })), null);
});

Deno.test("enumValues extracts values", () => {
  const p = param({ type: "enum", range: { values: ["a", "b", "c"] } });
  assertEquals(enumValues(p), ["a", "b", "c"]);
});

Deno.test("enumValues returns empty array when range is a number range", () => {
  const p = param({ type: "number", range: { min: 0, max: 1 } });
  assertEquals(enumValues(p), []);
});

Deno.test("enumValues returns empty array when range is absent", () => {
  assertEquals(enumValues(param({ range: null })), []);
});
