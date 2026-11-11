import { assert, assertEquals } from "jsr:@std/assert";
import golden from "../../../docs/midi/keys-golden.json" with { type: "json" };
import { parseMixState } from "./audio-backend.ts";
import { fillTemplate, getPath, type KeysConfig, resolveKeys, setPath, usesChannel, validateKeys } from "./keys.ts";
import { decodeFromSurface, noteByName } from "./mcu.ts";
import { type MixerActions, type NudgeAction, SurfaceLogic } from "./surface-logic.ts";

type Out = Record<string, unknown>;

function rig(sc: { keys?: unknown; channels: unknown[] }) {
  const out: Out[] = [];
  const m: MixerActions = {
    setGain: (id, db) => void out.push({ c: "gain", id, db }),
    setMute: (id, muted) => void out.push({ c: "mute", id, muted }),
    setPfl: (id, enabled) => void out.push({ c: "pfl", id, enabled }),
    setPan: (id, pan) => void out.push({ c: "pan", id, pan }),
    call: (node, method, args) => void out.push({ c: "call", node, method, args }),
    nudge: (a: NudgeAction) => {
      const o: Out = { c: "nudge", node: a.node, method: a.method, args: a.args, arg: a.arg, delta: a.delta, readParam: a.readParam };
      if (a.min !== undefined) o.min = a.min;
      if (a.max !== undefined) o.max = a.max;
      out.push(o);
    },
  };
  const logic = new SurfaceLogic(m, { units: [{ strips: 8, hasMaster: true }], keys: (sc.keys ?? null) as KeysConfig | null });
  logic.setModel(parseMixState({ channels: sc.channels }).channels);
  return { logic, out };
}

for (const sc of golden.scenarios) {
  Deno.test(`Tastenbelegung: ${sc.name}`, () => {
    const { logic, out } = rig(sc as never);
    let now = 1000;
    for (const [i, st] of (sc.steps as Record<string, unknown>[]).entries()) {
      const note = st.key ? noteByName(st.key as string)! : 0;
      const ev = st.do === "press" ? { t: "button" as const, note, name: st.key as string, down: true }
        : st.do === "release" ? { t: "button" as const, note, name: st.key as string, down: false }
        : st.do === "midi" ? decodeFromSurface(st.bytes as number[])
        : { t: "jog" as const, delta: st.delta as number };
      out.length = 0;
      logic.unbound.length = 0;
      logic.onEvent(0, ev, now);
      now += (st.ms as number | undefined) ?? 100;
      logic.flush(now);
      const got = [...out, ...logic.unbound.map((u) => ({ c: "unbound", name: u.name, down: u.down }))];
      assertEquals(got, st.expect, `Schritt ${i + 1} (${st.do} ${st.key ?? st.delta ?? ""})`);
      const state = st.state as Record<string, unknown> | undefined;
      if (!state) continue;
      const v = logic.view(0, now - 50);
      if ("page" in state) assertEquals(logic.page, state.page, `Schritt ${i + 1}: page`);
      if ("jogMode" in state) assertEquals(logic.jogMode, state.jogMode, `Schritt ${i + 1}: jogMode`);
      if ("selected" in state) assertEquals(logic.selected, state.selected, `Schritt ${i + 1}: selected`);
      if ("bank" in state) assertEquals(logic.bank, state.bank, `Schritt ${i + 1}: bank`);
      if ("message" in state) assertEquals(v.message, state.message, `Schritt ${i + 1}: message`);
      for (const [k, want] of Object.entries((state.leds ?? {}) as Record<string, string>)) assertEquals(v.leds.get(noteByName(k)!), want, `Schritt ${i + 1}: LED ${k}`);
    }
  });
}

Deno.test("Hilfen: Pfade, Vorlagen, Zusammenführen", () => {
  const o = { proc: { eqBypass: true }, mute: false };
  assertEquals(getPath(o, "proc.eqBypass"), true);
  assertEquals(getPath(o, "proc.x.y"), undefined);
  setPath(o as Record<string, unknown>, "proc.gateEnabled", true);
  assertEquals((o.proc as Record<string, unknown>).gateEnabled, true);
  assertEquals(fillTemplate({ m: "channel.{ch}.x", a: ["{ch}", 1] }, "z"), { m: "channel.z.x", a: ["z", 1] });
  assert(usesChannel({ action: "call", method: "channel.{ch}.x" }));
  assert(!usesChannel({ action: "call", method: "play" }));
  const r = resolveKeys({ global: { f9: { action: "call", method: "x" } }, jog: [{ kind: "gain" }] });
  assertEquals(Object.keys(r.pages[0].keys).length, 8);
  assert("f9" in r.global && "scrub" in r.global);
  assertEquals(resolveKeys(null).jog.length, 2);
});

Deno.test("validateKeys: lesbare Fehler", () => {
  const known = (n: string) => noteByName(n) !== null;
  assertEquals(validateKeys(null, known), []);
  assertEquals(validateKeys({ pages: [{ name: "x", keys: { f1: { action: "toggle", method: "m", arg: "a" } } }], jog: [{ kind: "gain" }] }, known), []);
  const e = validateKeys({
    pages: [{ name: "", keys: { f99: { action: "call", method: "m" }, f1: { action: "toggle", method: "m" } } }],
    global: { play: { action: "internal", internal: "nix" }, stop: { action: "call" } },
    jog: [{ kind: "nudge", method: "m" }],
  }, known);
  for (const part of ["name fehlt", "f99", "arg fehlt", "internal unbekannt", "method fehlt", "readParam"]) assert(e.some((x) => x.includes(part)), `${part}: ${e.join(" | ")}`);
});
