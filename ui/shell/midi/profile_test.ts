import { assertEquals } from "jsr:@std/assert";
import { describe, type Profile, ProfileEngine, validateProfile } from "./profile.ts";
import golden from "../../../docs/midi/profile-golden.json" with { type: "json" };

Deno.test("Profil: gemeinsame Prüffälle", () => {
  const eng = new ProfileEngine(golden.profile as Profile, "Mischer");
  for (const c of golden.cases) assertEquals(eng.handle(c.msg), c.actions, JSON.stringify(c.msg));
});

Deno.test("Profil: Toggle merkt sich den Zustand, Loslassen löst nichts aus", () => {
  const eng = new ProfileEngine(golden.profile as Profile, "Mischer");
  const t = (v: number) => eng.handle([0x90, 40, v]);
  assertEquals(t(127).length, 1);
  assertEquals(t(0).length, 0);
  const a = t(127)[0];
  assertEquals(a.kind === "call" && a.args.muted, false);
});

Deno.test("describe: Typ, Kanal, Wert", () => {
  assertEquals(describe([0xb2, 7, 100]), { type: "cc", channel: 3, num: 7, value: 100 });
  assertEquals(describe([0x80, 60, 0]), { type: "note", channel: 1, num: 60, value: 0, down: false });
  assertEquals(describe([0xe5, 0, 64]), { type: "pitchbend", channel: 6, num: 0, value: 8192 });
  assertEquals(describe([0xf8]), null);
});

Deno.test("validateProfile: Fehler lesbar", () => {
  assertEquals(validateProfile(golden.profile), []);
  const bad = { name: "", controls: [{ id: "a", in: { type: "cc", num: 200 }, to: { method: "" } }, { id: "a", in: { type: "x" }, to: {} }] };
  const e = validateProfile(bad);
  assertEquals(e.some((x) => x.includes("name fehlt")), true);
  assertEquals(e.some((x) => x.includes("in.num")), true);
  assertEquals(e.some((x) => x.includes("doppelt")), true);
  assertEquals(e.some((x) => x.includes("to.method")), true);
});
