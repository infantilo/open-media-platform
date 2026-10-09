import { assertEquals } from "jsr:@std/assert@1";
import { addTag, explicitTags, inheritedTags, isValidTag, MAX_TAGS, removeTag, sameTags } from "./port-tag-editor-logic.ts";

Deno.test("isValidTag entspricht dem Server-Format", () => {
  for (const ok of ["role.commentator", "audio.51", "a.b.c", "video.camera-1"]) assertEquals(isValidTag(ok), true, ok);
  for (const bad of ["", "commentator", "Role.x", "role.", ".x", "1a.b", "a b.c"]) assertEquals(isValidTag(bad), false, bad);
});

Deno.test("addTag normalisiert, sortiert und meldet Gründe", () => {
  assertEquals(addTag(["video.b"], "  Role.Program "), { ok: true, tags: ["role.program", "video.b"] });
  assertEquals(addTag(["a.b"], "a.b"), { ok: false, reason: "duplicate" });
  assertEquals(addTag([], "kaputt"), { ok: false, reason: "invalid" });
  const full = Array.from({ length: MAX_TAGS }, (_, i) => `x.t${i}`);
  assertEquals(addTag(full, "x.neu"), { ok: false, reason: "limit" });
});

Deno.test("Herkünfte werden getrennt", () => {
  const tags = [
    { tag: "media.audio", origin: "DERIVED" as const },
    { tag: "role.x", origin: "EXPLICIT" as const },
    { tag: "role.x", origin: "DISCOVERED" as const },
    { tag: "audio.y", origin: "DISCOVERED" as const },
  ];
  assertEquals(explicitTags(tags), ["role.x"]);
  assertEquals(inheritedTags(tags).map((t) => t.tag), ["media.audio", "audio.y"]);
  assertEquals(removeTag(["a.b", "c.d"], "a.b"), ["c.d"]);
  assertEquals(sameTags(["b.x", "a.y"], ["a.y", "b.x"]), true);
});
